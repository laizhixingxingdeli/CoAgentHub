import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { type RawData, WebSocket } from "ws";
import { wsHub } from "../src/lib/ws-hub";

/**
 * task_status_changed(任务状态实时推送)集成测试:用 fake bin 驱动真实执行器
 * 管线(消息 → maybeDispatchExecutorTask → queued → running → done/failed),
 * 用真实 WS 客户端断言:
 * - 群订阅者按序收到 queued/running/done(或 failed)事件,payload 完整;
 * - 不推送给其他群的订阅者。
 *
 * 环境变量(EXECUTOR_BIN_CODEBUDDY / COAGENTHUB_REPO_ROOT)必须在 import app
 * 之前设置(executors.ts 模块加载时求值),故用顶层 await 动态 import。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-status-bin-"));
const fakeBin = path.join(fakeDir, "fake-codebuddy.sh");
writeFileSync(
  fakeBin,
  [
    "#!/bin/sh",
    // 失败模式:FAKE_ALWAYS_FAIL 时直接 exit 1(失败事件测试用)。
    'if [ -n "$FAKE_ALWAYS_FAIL" ]; then echo "always-fail"; exit 1; fi',
    // 弱验收要求工作树干净 + HEAD 有新提交:真正提交一次(显式身份,CI 无
    // 全局 git config 也能跑)。
    'git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin change"',
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:任务完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeBin, 0o755);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;

// 执行前快照/回滚需要真实 git 仓库;CoAgentHub_REPO_ROOT 覆盖 findRepoRoot。
const repoDir = mkdtempSync(path.join(tmpdir(), "coagenthub-status-repo-"));
execFileSync("git", ["init", "-q"], { cwd: repoDir });
execFileSync("git", ["config", "user.email", "test@coagenthub.local"], {
  cwd: repoDir,
});
execFileSync("git", ["config", "user.name", "coagenthub-test"], {
  cwd: repoDir,
});
writeFileSync(path.join(repoDir, "seed.txt"), "seed\n");
execFileSync("git", ["add", "-A"], { cwd: repoDir });
execFileSync("git", ["commit", "-qm", "seed"], { cwd: repoDir });
process.env.COAGENTHUB_REPO_ROOT = repoDir;

// 顶层 await 动态 import:env 设置先于模块求值。
const { createTestApp } = await import("./app");
const { __resetExecutorQueueForTests } = await import(
  "../src/lib/executor-task"
);

const app = createTestApp();

let server: Server;
let port: number;
const openClients = new Set<WebSocket>();

const wsUrl = (participantId: string) =>
  `ws://127.0.0.1:${port}/api/ws?participantId=${participantId}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(20);
  }
  throw new Error("condition not met in time");
}

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("ws open timeout"));
    }, 2000);
    ws.on("open", () => {
      clearTimeout(timer);
      openClients.add(ws);
      resolve(ws);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 挂一个收集器:把该连接收到的所有帧 JSON 解析后按序追加到数组。 */
function attachCollector(ws: WebSocket): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  ws.on("message", (data: RawData) => {
    frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  return frames;
}

async function registerParticipant(body: Record<string, unknown>) {
  const res = await app.request("/api/participants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // 名字唯一(0013):同名已注册时服务端返回 409,复用现有 participant(测试内多次 setupGroup)。
  if (res.status === 409) {
    const list = (await (await app.request("/api/participants")).json()) as {
      id: string;
      name: string;
    }[];
    const existing = list.find((p) => p.name === body.name);
    if (existing) return { id: existing.id };
  }
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

async function createGroup(participantId: string, title: string) {
  const res = await app.request("/api/groups", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": participantId,
    },
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

async function addMember(
  participantId: string,
  groupId: string,
  memberParticipantId: string,
  roles: string[],
) {
  const res = await app.request(`/api/groups/${groupId}/members`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": participantId,
    },
    body: JSON.stringify({ participantId: memberParticipantId, roles }),
  });
  expect(res.status).toBe(200);
}

/** 发一条定向消息给执行器 participant(触发 server 自动建 task + spawn)。 */
async function postDirectedTaskMessage(
  participantId: string,
  groupId: string,
  executorParticipantId: string,
  spec?: { specRef: string; specHash: string },
) {
  const res = await app.request(`/api/groups/${groupId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": participantId,
    },
    body: JSON.stringify({
      body: "WS 状态推送集成测试",
      audience: "participant",
      audienceRef: executorParticipantId,
      ...spec,
    }),
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  server = createServer(app.fetch as unknown as RequestListener);
  wsHub.handleUpgrade(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

beforeEach(() => {
  __resetExecutorQueueForTests();
  delete process.env.FAKE_ALWAYS_FAIL;
});

afterEach(() => {
  wsHub.closeAll();
  for (const ws of openClients) ws.terminate();
  openClients.clear();
});

afterAll(async () => {
  wsHub.closeAll();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(fakeDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

describe("task_status_changed(任务状态实时推送)", () => {
  /** coordinator + CodeBuddy 执行器成员就绪。 */
  async function setupGroup(title: string) {
    const coordinator = await registerParticipant({
      name: `coord-${title}`,
    });
    const codebuddy = await registerParticipant({
      name: "CodeBuddy 执行器", // executors.ts 的 agentName,触发匹配靠它
    });
    const group = await createGroup(coordinator.id, title);
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  it("任务创建→开始→完成:群订阅者按序收到 queued/running/done,payload 完整", async () => {
    const { coordinator, codebuddy, group } = await setupGroup("状态推送群 A");
    const coordinatorWs = await connectWs(wsUrl(coordinator.id));
    const frames = attachCollector(coordinatorWs);

    await postDirectedTaskMessage(coordinator.id, group.id, codebuddy.id);

    // 等 done 事件到达(spawn + git commit 需要时间)。
    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "task_status_changed" &&
          f.groupId === group.id &&
          f.status === "done",
      ),
    );

    const statusEvents = frames.filter(
      (f) => f.type === "task_status_changed" && f.groupId === group.id,
    );
    const seen = statusEvents.map((f) => f.status);
    // queued / running / done 各至少出现一次,且按序:先入队,再 running,最后 done。
    expect(seen).toContain("queued");
    expect(seen).toContain("running");
    expect(seen).toContain("done");
    expect(seen.indexOf("queued")).toBeLessThan(seen.indexOf("running"));
    expect(seen.indexOf("running")).toBeLessThan(seen.indexOf("done"));

    // 事件帧:groupId/taskId/status 必在;task 载荷字段齐全。
    const doneEvent = statusEvents.find((f) => f.status === "done");
    expect(doneEvent).toBeDefined();
    expect(typeof doneEvent?.taskId).toBe("string");
    const task = doneEvent?.task as Record<string, unknown> | undefined;
    expect(task).toBeDefined();
    expect(typeof task?.id).toBe("string");
    expect(task?.id).toBe(doneEvent?.taskId);
    expect(task?.status).toBe("done");
    expect(task?.executorParticipantId).toBe(codebuddy.id);
    expect(task?.executorKey).toBe("codebuddy");
    expect(typeof task?.brief).toBe("string");
    expect(typeof task?.diffSummary).toBe("object");
    expect(typeof task?.createdAt).toBe("string");
    expect(new Date(task?.createdAt as string).getTime()).not.toBeNaN();
    expect(typeof task?.updatedAt).toBe("string");
    expect(typeof task?.retryCount).toBe("number");
  }, 15_000);

  it("带 specRef/specHash 的任务:task_status_changed 事件载荷透传两字段", async () => {
    const { coordinator, codebuddy, group } = await setupGroup("Spec 推送群");
    const coordinatorWs = await connectWs(wsUrl(coordinator.id));
    const frames = attachCollector(coordinatorWs);
    const spec = { specRef: "specs/login-v2.md", specHash: "abc123def456" };

    await postDirectedTaskMessage(
      coordinator.id,
      group.id,
      codebuddy.id,
      spec,
    );

    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "task_status_changed" &&
          f.groupId === group.id &&
          f.status === "done",
      ),
    );

    // 事件 task 载荷含 specRef/specHash(验收标准:WS task_status_changed 透传)。
    const doneEvent = frames.find(
      (f) =>
        f.type === "task_status_changed" &&
        f.groupId === group.id &&
        f.status === "done",
    );
    const task = doneEvent?.task as Record<string, unknown> | undefined;
    expect(task?.specRef).toBe(spec.specRef);
    expect(task?.specHash).toBe(spec.specHash);
  }, 15_000);

  it("任务失败:群订阅者收到 failed 事件", async () => {
    process.env.FAKE_ALWAYS_FAIL = "1";
    const { coordinator, codebuddy, group } =
      await setupGroup("状态推送失败群");
    const coordinatorWs = await connectWs(wsUrl(coordinator.id));
    const frames = attachCollector(coordinatorWs);

    await postDirectedTaskMessage(coordinator.id, group.id, codebuddy.id);

    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "task_status_changed" &&
          f.groupId === group.id &&
          f.status === "failed",
      ),
    );

    const failedEvent = frames.find(
      (f) =>
        f.type === "task_status_changed" &&
        f.groupId === group.id &&
        f.status === "failed",
    );
    expect(failedEvent).toBeDefined();
    expect(typeof failedEvent?.taskId).toBe("string");
    const task = failedEvent?.task as Record<string, unknown> | undefined;
    expect(task).toBeDefined();
    expect(task?.status).toBe("failed");
    expect((task?.diffSummary as Record<string, unknown> | null)?.error).toBe(
      "exit 1",
    );
  }, 15_000);

  it("群隔离:其他群的订阅者收不到本群任务的事件", async () => {
    const { coordinator, codebuddy, group } = await setupGroup("状态推送群 C");
    // 另一个群:成员只属于该群,不是本群成员。
    const otherCoordinator = await registerParticipant({
      name: "coord-other",
    });
    const otherMember = await registerParticipant({
      name: "other-member",
    });
    const otherGroup = await createGroup(otherCoordinator.id, "无关群 D");
    await addMember(otherCoordinator.id, otherGroup.id, otherMember.id, [
      "executor",
    ]);

    const coordinatorWs = await connectWs(wsUrl(coordinator.id));
    const otherWs = await connectWs(wsUrl(otherMember.id));
    const otherFrames = attachCollector(otherWs);

    await postDirectedTaskMessage(coordinator.id, group.id, codebuddy.id);

    // 本群成员收到 done;等它到达后给其他群订阅者留出推送窗口。
    const coordinatorFrames = attachCollector(coordinatorWs);
    await waitFor(() =>
      coordinatorFrames.some(
        (f) =>
          f.type === "task_status_changed" &&
          f.groupId === group.id &&
          f.status === "done",
      ),
    );
    await sleep(300);

    // 其他群成员:完全没有收到任何 task_status_changed 帧。
    expect(otherFrames.filter((f) => f.type === "task_status_changed")).toEqual(
      [],
    );
  }, 15_000);
});
