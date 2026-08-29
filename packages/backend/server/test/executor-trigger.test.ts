import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  participant as participantTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { afterAll, describe, expect, it, vi } from "vitest";
import { testDb } from "./db";

/**
 * 阶段2-票1:server 内嵌执行器触发链路。
 *
 * 用 fake bin 做集成测试(票面允许):把 EXECUTOR_BIN_CODEBUDDY 指到一个
 * 临时 shell 脚本(打印「汇报」+ commit hash 后 exit 0),再向 CodeBuddy
 * 执行器 participant 发定向消息 → 断言 server 自动建 task(executor_key=codebuddy)、
 * spawn 完成后 status=done + diffSummary,且群里出现 ✅ 状态回传(不再有
 * 🚀 开始执行,该平台代发状态消息已移除)。
 *
 * 票2 起 server 在 spawn 前打 git 快照(refs/coagenthub-cp/<taskId>),必须把
 * COAGENTHUB_REPO_ROOT 指到一个临时 git 仓库,避免在真实仓库上跑 git add/commit。
 *
 * A2A 用例:win-hermes 是 kind=a2a 的远端执行器,不发 ticket/spawn,直接经
 * A2A gateway 调用。COAGENTHUB_WIN_A2A_URL 指向不可达地址即可——fetch 被 mock,
 * 验证 token 从 env 读、URL 可配。
 *
 * 注意:executors.ts 的 EXECUTORS 在模块加载时求值(读 env),所以 env 必须
 * 在 import app 之前设置 —— 本文件用顶层 await 动态 import。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-exec-bin-"));
const fakeBin = path.join(fakeDir, "fake-codebuddy.sh");
writeFileSync(
  fakeBin,
  [
    "#!/bin/sh",
    // 捕获任务书内容供断言($3 = {ticket} 路径);TICKET_CAPTURE 未设时不动作。
    'if [ -n "$TICKET_CAPTURE" ]; then cp "$3" "$TICKET_CAPTURE"; fi',
    // 弱验收要求工作树干净 + HEAD 有新提交:真正提交一次(显式身份,CI 无全局
    // git config 也能跑)。
    'git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin change"',
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:建文件完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeBin, 0o755);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;

// A2A 用例:token 必须从 env 读(不硬编码);URL 用 env 覆盖为不可达地址,
// fetch 会被 mock,不真正联网。
process.env.COAGENTHUB_WIN_A2A_TOKEN = "test-a2a-token";
process.env.COAGENTHUB_WIN_A2A_URL = "http://127.0.0.1:9911/";

// 票2:执行前快照需要真实 git 仓库,CoAgentHub_REPO_ROOT 覆盖 findRepoRoot。
const repoDir = mkdtempSync(path.join(tmpdir(), "coagenthub-exec-repo-"));
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

describe("server 内嵌执行器触发链路(票1)", () => {
  const app = createTestApp();

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
      if (existing) {
        await bindExecutorKey(existing.id, body.name);
        return { id: existing.id };
      }
    }
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    await bindExecutorKey(id, body.name);
    return { id };
  }

  async function bindExecutorKey(id: string, name: unknown) {
    const keyByName: Record<string, string> = {
      "CodeBuddy": "codebuddy",
      "Win Hermes": "win-hermes",
    };
    const executorKey = typeof name === "string" ? keyByName[name] : undefined;
    if (executorKey) {
      await testDb
        .update(participantTable)
        .set({ executorKey })
        .where(eq(participantTable.id, id));
    }
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

  async function postMessage(
    participantId: string,
    groupId: string,
    body: Record<string, unknown>,
  ) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      id: string;
      groupId: string;
      senderId: string;
    };
  }

  async function listTasks(participantId: string, groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/tasks`, {
      headers: { "X-Participant-Id": participantId },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{
      id: string;
      messageId: string;
      executorParticipantId: string;
      executorKey: string | null;
      parentTaskId: string | null;
      status: string;
      diffSummary: unknown;
      a2aContextId: string | null;
      supersedesTaskId: string | null;
    }>;
  }

  async function listMessages(participantId: string, groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      headers: { "X-Participant-Id": participantId },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{
      id: string;
      senderId: string;
      body: string;
      contentType: string;
    }>;
  }

  /** 轮询任务直到终态(异步 spawn 完成),超时抛错。票2 起任务会先经过
   *  queued 状态,所以等终态(done/failed/cancelled),不等「非 running」。 */
  async function waitForTask(
    participantId: string,
    groupId: string,
    messageId: string,
    timeoutMs = 10_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tasks = await listTasks(participantId, groupId);
      const t = tasks.find((x) => x.messageId === messageId);
      if (t && ["done", "failed", "cancelled"].includes(t.status)) return t;
      if (Date.now() > deadline) {
        throw new Error(`task 未在 ${timeoutMs}ms 内达到终态`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** 群主的 coordinator + CodeBuddy 成员就绪。 */
  async function setupGroup() {
    const coordinator = await registerParticipant({
      name: "coord-exec",
    });
    let codebuddy = await testDb
      .select({ id: participantTable.id })
      .from(participantTable)
      .where(eq(participantTable.executorKey, "codebuddy"))
      .then(([participant]) => participant);
    if (!codebuddy) {
      codebuddy = await registerParticipant({
        name: "CodeBuddy",
      });
      await testDb
        .update(participantTable)
        .set({ executorKey: "codebuddy" })
        .where(eq(participantTable.id, codebuddy.id));
    }
    const group = await createGroup(coordinator.id, "执行器触发测试");
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  afterAll(() => {
    rmSync(fakeDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("改名后定向消息仍按稳定绑定路由到执行器配置", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();

    const rename = await app.request(`/api/participants/${codebuddy.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "CodeBuddy" }),
    });
    expect(rename.status).toBe(200);

    const msg = await postMessage(coordinator.id, group.id, {
      body: "建一个文件 hello.txt",
      audience: "participant",
      audienceRef: codebuddy.id,
    });

    // server 侧异步 spawn;轮询等 done。
    const task = await waitForTask(coordinator.id, group.id, msg.id);
    expect(task.executorParticipantId).toBe(codebuddy.id);
    expect(task.executorKey).toBe("codebuddy");
    expect(task.status).toBe("done");
    const diff = task.diffSummary as Record<string, unknown> | null;
    expect(diff).not.toBeNull();
    expect(diff!.hash).toBe("0123456789ab"); // fake bin 打印的 commit hash
    // 结构化段落解析(票7):「汇报:」段只取段值,不再带关键词前缀。
    expect(String(diff!.summary)).toContain("建文件完成");

    // 状态回传:不再有 🚀 开始执行(平台代发已移除),✅ 完成仍在,以执行器
    // 身份、contentType=task_status。
    const messages = await listMessages(coordinator.id, group.id);
    const statusMsgs = messages.filter((m) => m.contentType === "task_status");
    expect(statusMsgs.some((m) => m.body.startsWith("🚀"))).toBe(false);
    expect(statusMsgs.some((m) => m.body.startsWith("✅"))).toBe(true);
    expect(statusMsgs.every((m) => m.senderId === codebuddy.id)).toBe(true);
  });

  it("消息自动派发接受 supersedesTaskId 并落库(换执行器重发)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    // 先直建一条被替代的任务(仅登记行,不触发 spawn)。
    const prev = await app.request(`/api/groups/${group.id}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify({
        messageId: uuidv4(),
        executorParticipantId: codebuddy.id,
      }),
    });
    expect(prev.status).toBe(200);
    const prevTask = (await prev.json()) as { id: string };

    // 同一张票换执行器重发:定向消息携带 supersedesTaskId 指向被替代的任务。
    const msg = await postMessage(coordinator.id, group.id, {
      body: "换执行器重发同一张票",
      audience: "participant",
      audienceRef: codebuddy.id,
      supersedesTaskId: prevTask.id,
    });
    const task = await waitForTask(coordinator.id, group.id, msg.id);
    expect(task.supersedesTaskId).toBe(prevTask.id);
  });

  it("消息携带指向跨群任务的 supersedesTaskId → 400 且不写消息", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    // 另一个群里建一条任务作为「跨群」被替代目标。
    const otherGroup = await createGroup(coordinator.id, "跨群消息任务");
    await addMember(coordinator.id, otherGroup.id, codebuddy.id, ["executor"]);
    const other = await app.request(`/api/groups/${otherGroup.id}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify({
        messageId: uuidv4(),
        executorParticipantId: codebuddy.id,
      }),
    });
    expect(other.status).toBe(200);
    const otherTask = (await other.json()) as { id: string };

    const res = await app.request(`/api/groups/${group.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify({
        body: "跨群替代",
        audience: "participant",
        audienceRef: codebuddy.id,
        supersedesTaskId: otherTask.id,
      }),
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { message: string };
    expect(err.message).toContain("supersedesTaskId");

    // 校验在消息插入前 → 群内不留下消息行。
    const messages = await listMessages(coordinator.id, group.id);
    expect(messages.some((m) => m.body === "跨群替代")).toBe(false);
  });

  it("定向到非执行器 participant 的消息不建 task", async () => {
    const coordinator = await registerParticipant({
      name: "coord-plain",
    });
    const ordinary = await registerParticipant({
      name: "ordinary-participant",
    });
    const group = await createGroup(coordinator.id, "非执行器触发");
    await addMember(coordinator.id, group.id, ordinary.id, ["observer"]);

    await postMessage(coordinator.id, group.id, {
      body: "给普通 participant 的消息",
      audience: "participant",
      audienceRef: ordinary.id,
    });
    // 等一小段,确认没有 task 被创建(spawn 是异步的,给足时间)。
    await new Promise((r) => setTimeout(r, 300));
    const tasks = await listTasks(coordinator.id, group.id);
    expect(tasks).toHaveLength(0);
  });

  it("非协调者定向消息给执行器 → 403,且不产生群消息和任务", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    const observer = await registerParticipant({ name: "exec-observer" });
    await addMember(coordinator.id, group.id, observer.id, ["observer"]);

    const res = await app.request(`/api/groups/${group.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": observer.id,
      },
      body: JSON.stringify({
        body: "非协调者发任务",
        audience: "participant",
        audienceRef: codebuddy.id,
      }),
    });
    // 写入前校验(票:403 替代静默成功):状态码 + 明确错误信息。
    expect(res.status).toBe(403);
    const err = (await res.json()) as { code: string; message: string };
    expect(err.message).toContain("无权限发布任务");

    // 消息未被写入,任务未创建(spawn 是异步的,给足时间确认)。
    const messages = await listMessages(observer.id, group.id);
    expect(messages.some((m) => m.body === "非协调者发任务")).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    const tasks = await listTasks(observer.id, group.id);
    expect(tasks).toHaveLength(0);
  });

  it("非协调者定向消息给普通 participant → 仍成功(不触发 403)", async () => {
    const { coordinator, group } = await setupGroup();
    const ordinary = await registerParticipant({ name: "ordinary-member" });
    await addMember(coordinator.id, group.id, ordinary.id, ["observer"]);
    const observer = await registerParticipant({ name: "plain-observer" });
    await addMember(coordinator.id, group.id, observer.id, ["observer"]);

    const res = await app.request(`/api/groups/${group.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": observer.id,
      },
      body: JSON.stringify({
        body: "普通定向消息",
        audience: "participant",
        audienceRef: ordinary.id,
      }),
    });
    expect(res.status).toBe(200);
    const msg = (await res.json()) as { id: string };
    const messages = await listMessages(observer.id, group.id);
    expect(
      messages.some((m) => m.id === msg.id && m.body === "普通定向消息"),
    ).toBe(true);
    // 目标非执行器,不建任务(普通定向行为不变)。
    await new Promise((r) => setTimeout(r, 300));
    const tasks = await listTasks(observer.id, group.id);
    expect(tasks).toHaveLength(0);
  });

  it("同一消息重复触发不重复 spawn(已 done 则跳过)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    const msg = await postMessage(coordinator.id, group.id, {
      body: "重复触发测试",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    await waitForTask(coordinator.id, group.id, msg.id);

    const before = await listMessages(coordinator.id, group.id);
    const doneMsgsBefore = before.filter(
      (m) => m.contentType === "task_status" && m.body.startsWith("✅"),
    ).length;

    // 模拟桥/重复投递:再次以同一消息触发(直接调内部入口)。
    const { maybeDispatchExecutorTask } = await import(
      "@server/lib/executor-task"
    );
    const { testDb } = await import("./db");
    await maybeDispatchExecutorTask(
      testDb as unknown as Parameters<typeof maybeDispatchExecutorTask>[0],
      {
        groupId: group.id,
        messageId: msg.id,
        senderRoles: ["coordinator"],
        audienceRef: codebuddy.id,
        body: "重复触发测试",
        // Part A:直接调内部入口时下发者字段按测试语义提供(与消息路由一致)。
        dispatcherParticipantId: coordinator.id,
        dispatcherSessionId: null,
        // 规范驱动下发:直调入口按测试语义补可选字段(与消息路由一致,均为 null)。
        specRef: null,
        specHash: null,
        dispatchKind: null,
        // 替代关系(R2):直调入口按测试语义补可选字段(null = 无替代)。
        supersedesTaskId: null,
        // callback 路由信息(Part B):直调入口按测试语义补可选字段(null = 无 callback)。
        callbackRef: null,
      },
    );
    await new Promise((r) => setTimeout(r, 300));

    const after = await listMessages(coordinator.id, group.id);
    const doneMsgsAfter = after.filter(
      (m) => m.contentType === "task_status" && m.body.startsWith("✅"),
    ).length;
    expect(doneMsgsAfter).toBe(doneMsgsBefore); // 未重复执行
  });

  it("带 prompt 的成员定向调度 → 任务书含「本群分工」段", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    // 角色解绑后:给执行器成员配群内分工提示词(POST upsert 带上 prompt)。
    const addRes = await app.request(`/api/groups/${group.id}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinator.id,
      },
      body: JSON.stringify({
        participantId: codebuddy.id,
        roles: ["executor"],
        prompt: "负责代码执行与测试跑通",
      }),
    });
    expect(addRes.status).toBe(200);

    const capture = path.join(fakeDir, "ticket-with-prompt.md");
    process.env.TICKET_CAPTURE = capture;
    try {
      const msg = await postMessage(coordinator.id, group.id, {
        body: "建一个文件 hello.txt",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const task = await waitForTask(coordinator.id, group.id, msg.id);
      expect(task.status).toBe("done");
      // 任务书写入发生在 spawn 前,fake bin 已把全文拷到 capture。
      const ticket = readFileSync(capture, "utf8");
      expect(ticket).toContain(
        "本群分工:角色=[executor];提示词=负责代码执行与测试跑通",
      );
      // 固定模板(票7):执行器/任务内容段携带标签与 body 原文。
      expect(ticket).toContain("执行器: codebuddy");
      expect(ticket).toContain("## 任务内容");
      expect(ticket).toContain("建一个文件 hello.txt");
      expect(ticket).toContain(
        "## 执行上下文 (用于直接调用 CoAgentHub HTTP API)",
      );
      // participantId 是接收者自己的 id(非发送者),带认证说明。
      expect(ticket).toContain(`- participantId: ${codebuddy.id}`);
      expect(ticket).toContain(`- groupId: ${group.id}`);
      expect(ticket).toContain(`- taskId: ${task.id}`);
      expect(ticket).toContain("- apiBase: http://localhost:");
      expect(ticket).toContain(
        `- 认证:全信模型,请求带 HTTP 头 X-Participant-Id: ${codebuddy.id}`,
      );
      // 普通任务(非 detached)不应出现 detached 回写说明。
      expect(ticket).not.toContain("这是 detached 任务");
    } finally {
      delete process.env.TICKET_CAPTURE;
    }
  });

  it("不带 prompt 的成员定向调度 → 任务书与解绑前完全一致(零回归)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();

    const capture = path.join(fakeDir, "ticket-no-prompt.md");
    process.env.TICKET_CAPTURE = capture;
    try {
      const msg = await postMessage(coordinator.id, group.id, {
        body: "建一个文件 hello.txt",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const task = await waitForTask(coordinator.id, group.id, msg.id);
      expect(task.status).toBe("done");
      const ticket = readFileSync(capture, "utf8");
      // 无「本群分工」段;任务书为固定模板(票7):发布时间是动态 ISO,逐行断言
      // 各固定段,不整份等值比较。
      expect(ticket).not.toContain("本群分工");
      expect(ticket).toContain("# CoAgentHub 任务");
      expect(ticket).toContain("执行器: codebuddy");
      expect(ticket).toContain(`项目: ${repoDir}`);
      expect(ticket).toMatch(/发布时间: \d{4}-\d{2}-\d{2}T/);
      expect(ticket).toContain("## 任务内容");
      expect(ticket).toContain("建一个文件 hello.txt");
      expect(ticket).toContain("## 汇报格式要求(stdout 请按此输出)");
      expect(ticket).toContain("提交: <commit hash>");
      expect(ticket).toContain("测试: <测试结果摘要>");
      expect(ticket).toContain("汇报: <做了什么,3-5 句>");
      expect(ticket).toContain('遗留: <未完成事项,无则写"无">');
      expect(ticket).not.toContain("不要在执行窗口内停掉后端");
      expect(ticket).toContain(
        "默认约束(除非消息里明确说明):不动 schema/迁移/scripts/ 下其他脚本、不删数据;测试全绿后提交,commit message 按功能写。",
      );
    } finally {
      delete process.env.TICKET_CAPTURE;
    }
  });

  it("目标角色为 coordinator 且无 prompt → 任务书按协调者流程并包含回写契约", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    await addMember(coordinator.id, group.id, codebuddy.id, ["coordinator"]);

    const capture = path.join(fakeDir, "ticket-coordinator.md");
    process.env.TICKET_CAPTURE = capture;
    try {
      const msg = await postMessage(coordinator.id, group.id, {
        body: "协调任务模板测试",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const deadline = Date.now() + 10_000;
      let task: Awaited<ReturnType<typeof listTasks>>[number] | undefined;
      while (Date.now() <= deadline) {
        task = (await listTasks(coordinator.id, group.id)).find(
          (candidate) => candidate.messageId === msg.id,
        );
        if (task?.status === "running" && existsSync(capture)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(task?.status).toBe("running");
      if (!task) throw new Error("协调者任务未创建");
      const ticket = readFileSync(capture, "utf8");
      expect(ticket).toContain("coagenthub-coordinator");
      expect(ticket).toContain("GET /api/skills/coordinator");
      expect(ticket).not.toContain("coagenthub-executor");
      expect(ticket).toContain("PATCH 自身这条 detached 任务为终态");
      expect(ticket).toContain(
        "`diffSummary` 必须带 `review_request` 结构化载荷",
      );
      expect(ticket).toContain("不要在执行窗口内停掉后端");
      expect(ticket).toContain("结案被拒且运行时陈旧时");
      expect(ticket).toContain("实现已提交 <hash>,因旧构建守卫拒绝回写");
      expect(ticket).not.toContain("必须重启");

      const patchRes = await app.request(
        `/api/groups/${group.id}/tasks/${task.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": codebuddy.id,
          },
          body: JSON.stringify({
            status: "done",
            diffSummary: {
              review_request: {
                type: "review_request",
                layer: 3,
                taskId: task.id,
                specRef: "specs/test.md",
                specHash: "test-hash",
                diffSummary: "模板测试",
              },
              // 本测试协调任务经内嵌执行器直接完成,无 L1 子任务 → R1 逃生舱。
              noExecutionReason:
                "测试用协调任务,通过内嵌执行器直接完成,无 L1 子任务",
            },
          }),
        },
      );
      expect(patchRes.status).toBe(200);
    } finally {
      delete process.env.TICKET_CAPTURE;
    }
  }, 30_000);

  it("目标角色既不含 coordinator 也不含 executor → executor 兜底并提示角色不匹配", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    await addMember(coordinator.id, group.id, codebuddy.id, ["observer"]);

    const capture = path.join(fakeDir, "ticket-role-fallback.md");
    process.env.TICKET_CAPTURE = capture;
    try {
      const msg = await postMessage(coordinator.id, group.id, {
        body: "角色兜底模板测试",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const task = await waitForTask(coordinator.id, group.id, msg.id);
      expect(task.status).toBe("done");
      const ticket = readFileSync(capture, "utf8");
      expect(ticket).toContain("coagenthub-executor");
      expect(ticket).toContain("角色不含 coordinator 或 executor");
      expect(ticket.indexOf("角色不含 coordinator 或 executor")).toBeLessThan(
        ticket.indexOf("## 汇报格式要求"),
      );
    } finally {
      delete process.env.TICKET_CAPTURE;
    }
  }, 30_000);

  it("发送者有 running 任务时自动建立 parentTaskId", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();
    const parentMessageId = "00000000-0000-7000-8000-000000000901";
    const [parent] = await testDb
      .insert(taskTable)
      .values({
        groupId: group.id,
        messageId: parentMessageId,
        executorParticipantId: coordinator.id,
        status: "running",
      })
      .returning({ id: taskTable.id });
    const msg = await postMessage(coordinator.id, group.id, {
      body: "带父任务的执行",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const child = await waitForTask(coordinator.id, group.id, msg.id);
    expect(child.parentTaskId).toBe(parent.id);

    const topLevel = await postMessage(coordinator.id, group.id, {
      body: "顶层执行",
      audience: "participant",
      audienceRef: codebuddy.id,
    });
    const top = await waitForTask(coordinator.id, group.id, topLevel.id);
    // Multiple running rows are deterministic: the most recently updated
    // parent is selected, and normal scheduler policy keeps this at one.
    expect(top.parentTaskId).toBe(parent.id);
  });

  it("带 specRef/specHash 的定向消息 → task 行落库 + 任务书含「关联规范」段 + 详情透传", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();

    const capture = path.join(fakeDir, "ticket-with-spec.md");
    process.env.TICKET_CAPTURE = capture;
    const specRef = "specs/login-v2.md";
    const specHash = "abcdef012345";
    const previousApiBase = process.env.COAGENTHUB_API_BASE;
    process.env.COAGENTHUB_API_BASE = "http://hub.example/api/";
    try {
      const msg = await postMessage(coordinator.id, group.id, {
        body: "登录改造",
        audience: "participant",
        audienceRef: codebuddy.id,
        specRef,
        specHash,
      });
      const task = await waitForTask(coordinator.id, group.id, msg.id);
      expect(task.status).toBe("done");
      // 验收:task 行写入 specRef/specHash(详情/WS 事件透传的数据源)。
      const detail = (await (
        await app.request(`/api/groups/${group.id}/tasks/${task.id}`, {
          headers: { "X-Participant-Id": coordinator.id },
        })
      ).json()) as Record<string, unknown>;
      expect(detail.specRef).toBe(specRef);
      expect(detail.specHash).toBe(specHash);

      // 验收:任务书在「任务内容」之前含「关联规范」段(含文档路径 + 版本哈希
      // + 严格遵循指令)。
      const ticket = readFileSync(capture, "utf8");
      const specIdx = ticket.indexOf("## 📜 关联规范 (Spec Reference)");
      const contentIdx = ticket.indexOf("## 任务内容");
      expect(specIdx).toBeGreaterThan(-1);
      expect(contentIdx).toBeGreaterThan(-1);
      expect(specIdx).toBeLessThan(contentIdx); // Spec 优先于任务内容
      expect(ticket).toContain(`- **文档路径**: ${specRef}`);
      expect(ticket).toContain(`- **版本哈希**: ${specHash}`);
      expect(ticket).toContain(
        "请严格遵循上述文档中的定义进行开发。如有冲突，以 Spec 为准。",
      );
      expect(ticket).toContain("- apiBase: http://hub.example/api");
    } finally {
      if (previousApiBase === undefined) delete process.env.COAGENTHUB_API_BASE;
      else process.env.COAGENTHUB_API_BASE = previousApiBase;
      delete process.env.TICKET_CAPTURE;
    }
  });

  it("ReplyMode: detached 的任务书含额外回写说明(PATCH 方法 + 不回写后果)", async () => {
    const { coordinator, codebuddy, group } = await setupGroup();

    const capture = path.join(fakeDir, "ticket-detached.md");
    process.env.TICKET_CAPTURE = capture;
    try {
      const msg = await postMessage(coordinator.id, group.id, {
        body: "CLI detached 任务\n## ReplyMode: detached",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      // detached 任务 spawn 后保持 running(不解析 stdout,等执行器 PATCH 回写)。
      // 任务书在 spawn 前已写入,但 fake bin 的拷贝发生在 spawn 之后——轮询等
      // capture 文件就绪再读,避免与 running 状态之间存在拷贝竞态。
      const deadline = Date.now() + 10_000;
      let taskId: string | null = null;
      for (;;) {
        const tasks = await listTasks(coordinator.id, group.id);
        const t = tasks.find((x) => x.messageId === msg.id);
        if (t && t.status === "running") {
          taskId = t.id;
          break;
        }
        if (Date.now() > deadline) {
          throw new Error("detached 任务未在 10s 内进入 running");
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(taskId).not.toBeNull();
      const captureDeadline = Date.now() + 10_000;
      for (;;) {
        if (existsSync(capture)) break;
        if (Date.now() > captureDeadline) {
          throw new Error("任务书 capture 未在 10s 内写入");
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      const ticket = readFileSync(capture, "utf8");
      // 上下文段照常出现(detached 也是普通上下文 + 额外说明)。
      expect(ticket).toContain(
        "## 执行上下文 (用于直接调用 CoAgentHub HTTP API)",
      );
      // R3:写明回写终态的方法(完整 URL 含 groupId/taskId 与 status/diffSummary)。
      expect(ticket).toContain("这是 detached 任务。完成后必须 PATCH");
      expect(ticket).toContain(
        `/groups/${group.id}/tasks/${taskId}，带 status 与 diffSummary 回写终态。`,
      );
      // R3:写明不回写的后果(detachedTimeoutMinutes 兜底超时)。
      expect(ticket).toContain(
        "不回写会使任务保持 running，直到 detachedTimeoutMinutes(默认 1440 分钟)兜底超时，检视者会一直等不到结果。",
      );

      // 收尾:按任务书指引 PATCH 回写终态,避免遗留 running 任务。
      const patch = await app.request(
        `/api/groups/${group.id}/tasks/${taskId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": codebuddy.id,
          },
          body: JSON.stringify({
            status: "done",
            diffSummary: {
              summary: "PATCH 回写完成",
              // 本测试 detached 任务经内嵌执行器直接完成,无 L1 子任务 → R1 逃生舱。
              noExecutionReason:
                "测试用 detached 任务,通过内嵌执行器直接完成,无 L1 子任务",
            },
          }),
        },
      );
      expect(patch.status).toBe(200);
    } finally {
      delete process.env.TICKET_CAPTURE;
    }
  });

  it("a2a 执行器(win-hermes):定向消息 → task → gateway 调用 → 完成回传", async () => {
    // mock 全局 fetch:捕获调用并返回「TASK_STATE_COMPLETED + 回复文本」。
    const fetchMock = vi.fn(async (input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        method: string;
        params: { message: { parts: Array<{ kind: string; text: string }> } };
      };
      expect(body.method).toBe("message/send");
      expect(body.params.message.parts[0]).toMatchObject({
        kind: "text",
        text: "回复 ACAT-WIN-OK",
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "1.0",
          id: "1",
          result: {
            message: {
              role: "participant",
              parts: [{ kind: "text", text: "ACAT-WIN-OK" }],
            },
            state: { state: "completed" },
          },
        }),
        text: async () => "",
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const coordinator = await registerParticipant({
        name: "coord-a2a",
      });
      const winHermes = await registerParticipant({
        name: "Win Hermes", // executors.ts 的 agentName
      });
      const group = await createGroup(coordinator.id, "a2a 触发测试");
      await addMember(coordinator.id, group.id, winHermes.id, ["executor"]);

      const msg = await postMessage(coordinator.id, group.id, {
        body: "回复 ACAT-WIN-OK",
        audience: "participant",
        audienceRef: winHermes.id,
      });

      const task = await waitForTask(coordinator.id, group.id, msg.id);
      expect(task.executorParticipantId).toBe(winHermes.id);
      expect(task.executorKey).toBe("win-hermes");
      expect(task.status).toBe("done");

      // gateway 调用:URL 用 COAGENTHUB_WIN_A2A_URL,Authorization 用 env token。
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [callUrl, callInit] = fetchMock.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(callUrl).toBe("http://127.0.0.1:9911/");
      expect((callInit.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-a2a-token",
      );

      // 完成回传:不再有 🚀 开始执行,✅(含远端回复文本)仍在,以 win-hermes 身份。
      const messages = await listMessages(coordinator.id, group.id);
      const statusMsgs = messages.filter(
        (m) => m.contentType === "task_status",
      );
      expect(statusMsgs.some((m) => m.body.startsWith("🚀"))).toBe(false);
      const doneMsg = statusMsgs.find((m) => m.body.startsWith("✅"));
      expect(doneMsg).toBeDefined();
      expect(doneMsg!.body).toContain("ACAT-WIN-OK");
      expect(statusMsgs.every((m) => m.senderId === winHermes.id)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a2a 上下文延续:首次任务返回 contextId 落库,第二次任务调用携带", async () => {
    // 假 gateway:第一次调用返回 contextId=ctx-1;第二次调用断言 params 携带
    // ctx-1(上一任务返回的),再返回新 contextId=ctx-2。
    const calls: Array<{ params: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (_input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        params: Record<string, unknown>;
      };
      calls.push(body);
      const isSecond = calls.length === 2;
      const result: Record<string, unknown> = {
        message: {
          role: "participant",
          parts: [{ kind: "text", text: "ACAT-WIN-OK" }],
        },
        state: { state: "completed" },
        contextId: isSecond ? "ctx-2" : "ctx-1",
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "1.0", id: "1", result }),
        text: async () => "",
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const coordinator = await registerParticipant({
        name: "coord-a2a-ctx",
      });
      const winHermes = await registerParticipant({
        name: "Win Hermes", // executors.ts 的 agentName
      });
      const group = await createGroup(coordinator.id, "a2a 上下文延续");
      await addMember(coordinator.id, group.id, winHermes.id, ["executor"]);

      // 第一次任务:不带 contextId(无历史),gateway 返回 ctx-1 → 落库。
      const msg1 = await postMessage(coordinator.id, group.id, {
        body: "任务一:记住上下文",
        audience: "participant",
        audienceRef: winHermes.id,
      });
      const task1 = await waitForTask(coordinator.id, group.id, msg1.id);
      expect(task1.status).toBe("done");
      expect(task1.a2aContextId).toBe("ctx-1");
      expect(calls[0]?.params.contextId).toBeUndefined();

      // 第二次任务:调用携带上一任务的 ctx-1;gateway 返回 ctx-2 → 落库。
      const msg2 = await postMessage(coordinator.id, group.id, {
        body: "任务二:继续上下文",
        audience: "participant",
        audienceRef: winHermes.id,
      });
      const task2 = await waitForTask(coordinator.id, group.id, msg2.id);
      expect(task2.status).toBe("done");
      expect(calls).toHaveLength(2);
      expect(calls[1]?.params.contextId).toBe("ctx-1");
      expect(task2.a2aContextId).toBe("ctx-2");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a2a 上下文按群隔离:同执行器不同群互不串", async () => {
    // win-hermes(memory=per-group)同时加入两个群;群 A 返回 ctx-a,群 B 的
    // 首次任务不应携带 ctx-a(按群隔离),群 A 的下一次任务仍携带 ctx-a。
    const calls: Array<{ params: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (_input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        params: {
          message: { parts: Array<{ kind: string; text: string }> };
        };
      };
      calls.push(body);
      const result: Record<string, unknown> = {
        message: {
          role: "participant",
          parts: [{ kind: "text", text: "ACAT-WIN-OK" }],
        },
        state: { state: "completed" },
        contextId: body.params.message.parts[0].text.includes("群B")
          ? "ctx-b"
          : "ctx-a",
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "1.0", id: "1", result }),
        text: async () => "",
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const coordinator = await registerParticipant({
        name: "coord-a2a-iso",
      });
      const winHermes = await registerParticipant({
        name: "Win Hermes",
      });
      const groupA = await createGroup(coordinator.id, "a2a 群A");
      const groupB = await createGroup(coordinator.id, "a2a 群B");
      await addMember(coordinator.id, groupA.id, winHermes.id, ["executor"]);
      await addMember(coordinator.id, groupB.id, winHermes.id, ["executor"]);

      // 群 A 任务一:无历史 → 不带 contextId,返回 ctx-a → 落库。
      const a1 = await postMessage(coordinator.id, groupA.id, {
        body: "群A任务一",
        audience: "participant",
        audienceRef: winHermes.id,
      });
      const taskA1 = await waitForTask(coordinator.id, groupA.id, a1.id);
      expect(taskA1.status).toBe("done");
      expect(taskA1.a2aContextId).toBe("ctx-a");
      expect(calls[0]?.params.contextId).toBeUndefined();

      // 群 B 任务一:虽同执行器,但群 A 的 ctx-a 不应串过来 → 无 contextId。
      const b1 = await postMessage(coordinator.id, groupB.id, {
        body: "群B任务一",
        audience: "participant",
        audienceRef: winHermes.id,
      });
      const taskB1 = await waitForTask(coordinator.id, groupB.id, b1.id);
      expect(taskB1.status).toBe("done");
      expect(taskB1.a2aContextId).toBe("ctx-b");
      expect(calls).toHaveLength(2);
      expect(calls[1]?.params.contextId).toBeUndefined();

      // 群 A 任务二:本群延续,携带 ctx-a。
      const a2 = await postMessage(coordinator.id, groupA.id, {
        body: "群A任务二",
        audience: "participant",
        audienceRef: winHermes.id,
      });
      const taskA2 = await waitForTask(coordinator.id, groupA.id, a2.id);
      expect(taskA2.status).toBe("done");
      expect(calls).toHaveLength(3);
      expect(calls[2]?.params.contextId).toBe("ctx-a");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a2a 无 memory 标记的执行器:从不携带/回写 contextId", async () => {
    // 通过 API 新增一个 kind=a2a、不带 memory 的普通执行器,连续两次任务
    // 都不应携带 contextId,返回的 contextId 也不落库(任务书自包含)。
    const createRes = await app.request("/api/executors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentName: "Plain A2A",
        kind: "a2a",
        url: "http://127.0.0.1:9911/",
        bin: "plain-a2a",
      }),
    });
    expect(createRes.status).toBe(200);

    const calls: Array<{ params: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (_input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        params: Record<string, unknown>;
      };
      calls.push(body);
      const result: Record<string, unknown> = {
        message: {
          role: "participant",
          parts: [{ kind: "text", text: "ACAT-WIN-OK" }],
        },
        state: { state: "completed" },
        contextId: "ctx-plain",
      };
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "1.0", id: "1", result }),
        text: async () => "",
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const coordinator = await registerParticipant({
        name: "coord-a2a-plain",
      });
      const plain = await registerParticipant({
        name: "Plain A2A",
      });
      const group = await createGroup(coordinator.id, "a2a 普通执行器");
      await addMember(coordinator.id, group.id, plain.id, ["executor"]);

      const m1 = await postMessage(coordinator.id, group.id, {
        body: "任务一",
        audience: "participant",
        audienceRef: plain.id,
      });
      const task1 = await waitForTask(coordinator.id, group.id, m1.id);
      expect(task1.status).toBe("done");
      expect(task1.a2aContextId).toBeNull(); // gateway 返回了 ctx,但无 memory 不回写
      expect(calls[0]?.params.contextId).toBeUndefined();

      // 第二次任务:上一任务已有 a2aContextId?没有 —— 但即使 gateway 返回过,
      // 未落库,所以查不到;且无 memory 标记不查。断言第二次也不带。
      const m2 = await postMessage(coordinator.id, group.id, {
        body: "任务二",
        audience: "participant",
        audienceRef: plain.id,
      });
      const task2 = await waitForTask(coordinator.id, group.id, m2.id);
      expect(task2.status).toBe("done");
      expect(task2.a2aContextId).toBeNull();
      expect(calls).toHaveLength(2);
      expect(calls[1]?.params.contextId).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
