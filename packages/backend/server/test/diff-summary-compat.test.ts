/**
 * diffSummary 历史 JSON / API / completion / WS 形状回归
 * (spec diffsummary-ownership W3 §4 D1 / D2)。
 *
 * D1 关键约束:「历史形态」= 库里**已经存在**的旧 JSON 形状 ——
 * 必须用 drizzle 直接 insert 旧形状行,不能只用新代码写出的行当历史。
 * 再经生产写路径(PATCH → mergeDiffSummary)写入后,HTTP GET 仍读出原关键键。
 *
 * D2:completion event 信封与 task_status_changed 载荷中 diffSummary
 * 仍为扁平对象,且含场景键。
 */
import { randomUUID } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
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
import { mergeDiffSummary } from "@server/lib/executor-task";
import { wsHub } from "../src/lib/ws-hub";
import { createTestApp } from "./app";
import { testDb } from "./db";

const app = createTestApp();
const appWs = createTestApp();

let server: Server;
let port: number;
const openClients = new Set<WebSocket>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(20);
  }
  throw new Error("condition not met in time");
}

beforeAll(async () => {
  server = createServer(appWs.fetch as unknown as RequestListener);
  wsHub.handleUpgrade(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const ws of openClients) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
  openClients.clear();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  // no queue reset needed — this file never spawns executors
});

afterEach(() => {
  for (const ws of [...openClients]) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    openClients.delete(ws);
  }
});

async function register(name: string) {
  const res = await app.request("/api/participants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res.status === 409) {
    const list = (await (await app.request("/api/participants")).json()) as {
      id: string;
      name: string;
    }[];
    const existing = list.find((p) => p.name === name);
    if (existing) return { id: existing.id };
  }
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

async function createGroup(coordinatorId: string, title: string) {
  const res = await app.request("/api/groups", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": coordinatorId,
    },
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

/**
 * 直接落库——绕过一切 merge / apply 入口,保证行内 JSON 就是「历史形状」。
 */
async function insertHistoricalTask(
  groupId: string,
  executorParticipantId: string,
  historicalDiffSummary: Record<string, unknown>,
  extra: Partial<typeof taskTable.$inferInsert> = {},
) {
  const [row] = await testDb
    .insert(taskTable)
    .values({
      groupId,
      messageId: randomUUID(),
      executorParticipantId,
      status: "queued",
      // 关键:原样写入,不经 mergeDiffSummary
      diffSummary: historicalDiffSummary,
      ...extra,
    })
    .returning({ id: taskTable.id, diffSummary: taskTable.diffSummary });
  return row;
}

async function getTaskHttp(
  groupId: string,
  taskId: string,
  actorId: string,
) {
  const res = await app.request(`/api/groups/${groupId}/tasks/${taskId}`, {
    headers: { "X-Participant-Id": actorId },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    id: string;
    status: string;
    diffSummary: Record<string, unknown> | null;
  };
}

async function patchDone(
  groupId: string,
  taskId: string,
  executorId: string,
  patch: Record<string, unknown>,
) {
  const res = await app.request(`/api/groups/${groupId}/tasks/${taskId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Participant-Id": executorId,
    },
    body: JSON.stringify({
      status: "done",
      diffSummary: patch,
    }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as {
    status: string;
    diffSummary: Record<string, unknown>;
  };
}

async function inboxList(participantId: string) {
  const res = await app.request(
    `/api/participants/${participantId}/task-completion-events`,
    { headers: { "X-Participant-Id": participantId } },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    events: Array<{
      eventId: string;
      schemaVersion: number;
      type: string;
      task: {
        taskId: string;
        status: string | null;
        diffSummary: unknown;
      };
    }>;
  };
}

async function waitForPendingEvent(participantId: string, taskId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { events } = await inboxList(participantId);
    const hit = events.find((e) => e.task?.taskId === taskId);
    if (hit) return hit;
    await sleep(50);
  }
  throw new Error(`no completion event for task ${taskId}`);
}

function connectWs(participantId: string): Promise<WebSocket> {
  const url = `ws://127.0.0.1:${port}/api/ws?participantId=${participantId}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("ws open timeout"));
    }, 5_000);
    ws.once("open", () => {
      clearTimeout(timer);
      openClients.add(ws);
      resolve(ws);
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function attachCollector(ws: WebSocket) {
  const frames: Array<Record<string, unknown>> = [];
  ws.on("message", (data: RawData) => {
    try {
      const parsed = JSON.parse(String(data)) as Record<string, unknown>;
      frames.push(parsed);
    } catch {
      /* ignore non-json */
    }
  });
  return frames;
}

/** §3.6 五种历史形态夹具 —— 形状字面量,不经 merge 构造。 */
const HISTORICAL_SHAPES = {
  /** 1. 顶层 type:"review_request"(旧) */
  topLevelReviewRequest: {
    type: "review_request",
    layer: 3,
    taskId: "hist-top-level-rr",
    specRef: "specs/legacy-review.md",
    specHash: "legacyhash0001",
    diffSummary: "旧顶层 review_request 形态",
  },
  /** 2. 嵌套 review_request(现) */
  nestedReviewRequest: {
    review_request: {
      type: "review_request",
      layer: 2,
      taskId: "hist-nested-rr",
      specRef: "specs/nested-review.md",
      specHash: "nestedhash0002",
      diffSummary: "嵌套 review_request 形态",
    },
    hash: "nested-result-hash",
  },
  /** 3. 无 platform 键的旧行 */
  noPlatform: {
    summary: "old-no-platform",
    hash: "no-platform-hash",
    error: "prior-fail",
  },
  /** 4. 仅有 tokenUsage / tokenUsageReason */
  tokenOnly: {
    tokenUsage: { input: 42, output: 7 },
    tokenUsageReason: "historical-token-only-row",
  },
  /** 5. 含 dispatchKindNote / rollbackSkipped */
  auditKeys: {
    dispatchKindNote: "dispatchKind 由 findings 缺省推定为 fix",
    rollbackSkipped: {
      reason: "checkpoint 之后存在外来提交",
      headAtSkip: "deadbeef",
      checkpoint: "refs/coagenthub-cp/hist",
    },
    summary: "audit-hist",
  },
} as const;

describe("W3 D1: 五种历史形态经 merge 再写入后 HTTP GET 仍读出原关键键", () => {
  it("1. 顶层 type:review_request 旧形态 — 直接 insert 后 PATCH,GET 仍见 type/specRef", async () => {
    const owner = await register(`d1-1-owner-${Date.now()}`);
    const executor = await register(`d1-1-exec-${Date.now()}`);
    const group = await createGroup(owner.id, "d1-1-top-rr");

    // 真造历史行:drizzle 直写旧形状,不经 merge
    const hist = { ...HISTORICAL_SHAPES.topLevelReviewRequest };
    const row = await insertHistoricalTask(group.id, executor.id, hist);

    // 落库瞬间的形状就是旧形状(防测试自己用新代码造「假历史」)
    const [raw] = await testDb
      .select({ diffSummary: taskTable.diffSummary })
      .from(taskTable)
      .where(eq(taskTable.id, row.id));
    expect(raw.diffSummary).toEqual(hist);
    expect(
      (raw.diffSummary as Record<string, unknown>).review_request,
    ).toBeUndefined();
    expect((raw.diffSummary as Record<string, unknown>).type).toBe(
      "review_request",
    );

    // 经生产写路径(内部 mergeDiffSummary)再写入
    await patchDone(group.id, row.id, executor.id, {
      summary: "w3-d1-1-after-merge",
    });

    const json = await getTaskHttp(group.id, row.id, owner.id);
    expect(json.status).toBe("done");
    expect(json.diffSummary).toMatchObject({
      type: "review_request",
      layer: 3,
      taskId: "hist-top-level-rr",
      specRef: "specs/legacy-review.md",
      specHash: "legacyhash0001",
      summary: "w3-d1-1-after-merge",
    });
    // 仍是扁平对象,不是 owners 嵌套
    expect(json.diffSummary).not.toHaveProperty("result");
    expect(json.diffSummary).not.toHaveProperty("review");
  });

  it("2. 嵌套 review_request 形态 — GET 仍见 review_request 与 hash", async () => {
    const owner = await register(`d1-2-owner-${Date.now()}`);
    const executor = await register(`d1-2-exec-${Date.now()}`);
    const group = await createGroup(owner.id, "d1-2-nested-rr");

    const hist = {
      review_request: { ...HISTORICAL_SHAPES.nestedReviewRequest.review_request },
      hash: HISTORICAL_SHAPES.nestedReviewRequest.hash,
    };
    const row = await insertHistoricalTask(group.id, executor.id, hist);
    const [raw] = await testDb
      .select({ diffSummary: taskTable.diffSummary })
      .from(taskTable)
      .where(eq(taskTable.id, row.id));
    expect(raw.diffSummary).toEqual(hist);

    await patchDone(group.id, row.id, executor.id, {
      summary: "w3-d1-2-after-merge",
    });

    const json = await getTaskHttp(group.id, row.id, owner.id);
    expect(json.diffSummary?.hash).toBe("nested-result-hash");
    expect(json.diffSummary?.review_request).toMatchObject({
      type: "review_request",
      specRef: "specs/nested-review.md",
      specHash: "nestedhash0002",
    });
    expect(json.diffSummary?.summary).toBe("w3-d1-2-after-merge");
  });

  it("3. 无 platform 键的旧行 — merge 写入后仍无强制 platform,原键仍在", async () => {
    const owner = await register(`d1-3-owner-${Date.now()}`);
    const executor = await register(`d1-3-exec-${Date.now()}`);
    const group = await createGroup(owner.id, "d1-3-no-platform");

    const hist = { ...HISTORICAL_SHAPES.noPlatform };
    const row = await insertHistoricalTask(group.id, executor.id, hist);
    const [raw] = await testDb
      .select({ diffSummary: taskTable.diffSummary })
      .from(taskTable)
      .where(eq(taskTable.id, row.id));
    expect(raw.diffSummary).toEqual(hist);
    expect(
      Object.hasOwn(raw.diffSummary as object, "platform"),
    ).toBe(false);

    // result 写入不得抹掉既有 error(属 terminal);error 保留
    await patchDone(group.id, row.id, executor.id, {
      summary: "w3-d1-3-after-merge",
      hash: "new-hash-should-overwrite-own",
    });

    const json = await getTaskHttp(group.id, row.id, owner.id);
    expect(json.diffSummary?.summary).toBe("w3-d1-3-after-merge");
    expect(json.diffSummary?.hash).toBe("new-hash-should-overwrite-own");
    // terminal 键未被 result 路径抹掉
    expect(json.diffSummary?.error).toBe("prior-fail");
    // 未写 relation 时不应凭空长出 platform(或若存在也不得挡原键)
    // 关键:旧行关键键可读
    expect(json.diffSummary).toMatchObject({
      summary: "w3-d1-3-after-merge",
      error: "prior-fail",
    });
  });

  it("4. 仅有 tokenUsage/tokenUsageReason 的行 — GET 仍见两键", async () => {
    const owner = await register(`d1-4-owner-${Date.now()}`);
    const executor = await register(`d1-4-exec-${Date.now()}`);
    const group = await createGroup(owner.id, "d1-4-token-only");

    const hist = { ...HISTORICAL_SHAPES.tokenOnly };
    const row = await insertHistoricalTask(group.id, executor.id, hist);
    const [raw] = await testDb
      .select({ diffSummary: taskTable.diffSummary })
      .from(taskTable)
      .where(eq(taskTable.id, row.id));
    expect(raw.diffSummary).toEqual(hist);

    await patchDone(group.id, row.id, executor.id, {
      summary: "w3-d1-4-after-merge",
    });

    const json = await getTaskHttp(group.id, row.id, owner.id);
    expect(json.diffSummary?.tokenUsage).toEqual({ input: 42, output: 7 });
    expect(json.diffSummary?.tokenUsageReason).toBe(
      "historical-token-only-row",
    );
    expect(json.diffSummary?.summary).toBe("w3-d1-4-after-merge");
  });

  it("5. 含 dispatchKindNote/rollbackSkipped 的行 — GET 仍见两审计键", async () => {
    const owner = await register(`d1-5-owner-${Date.now()}`);
    const executor = await register(`d1-5-exec-${Date.now()}`);
    const group = await createGroup(owner.id, "d1-5-audit");

    const hist = {
      dispatchKindNote: HISTORICAL_SHAPES.auditKeys.dispatchKindNote,
      rollbackSkipped: {
        ...HISTORICAL_SHAPES.auditKeys.rollbackSkipped,
      },
      summary: HISTORICAL_SHAPES.auditKeys.summary,
    };
    const row = await insertHistoricalTask(group.id, executor.id, hist);
    const [raw] = await testDb
      .select({ diffSummary: taskTable.diffSummary })
      .from(taskTable)
      .where(eq(taskTable.id, row.id));
    expect(raw.diffSummary).toEqual(hist);

    await patchDone(group.id, row.id, executor.id, {
      summary: "w3-d1-5-after-merge",
      hash: "audit-hash",
    });

    const json = await getTaskHttp(group.id, row.id, owner.id);
    expect(json.diffSummary?.dispatchKindNote).toBe(
      "dispatchKind 由 findings 缺省推定为 fix",
    );
    expect(json.diffSummary?.rollbackSkipped).toEqual({
      reason: "checkpoint 之后存在外来提交",
      headAtSkip: "deadbeef",
      checkpoint: "refs/coagenthub-cp/hist",
    });
    expect(json.diffSummary?.summary).toBe("w3-d1-5-after-merge");
    expect(json.diffSummary?.hash).toBe("audit-hash");
  });

  it("纯函数侧:历史五种形状经 mergeDiffSummary 不丢关键键(夹具自洽)", () => {
    // 补充:不经 HTTP 的纯函数夹具,与 HTTP 路径双保险
    const cases: Array<{
      name: string;
      existing: Record<string, unknown>;
      assert: (next: Record<string, unknown>) => void;
    }> = [
      {
        name: "top-level review_request",
        existing: { ...HISTORICAL_SHAPES.topLevelReviewRequest },
        assert: (next) => {
          expect(next.type).toBe("review_request");
          expect(next.specRef).toBe("specs/legacy-review.md");
        },
      },
      {
        name: "nested review_request",
        existing: {
          review_request: {
            ...HISTORICAL_SHAPES.nestedReviewRequest.review_request,
          },
          hash: "h",
        },
        assert: (next) => {
          expect(next.review_request).toMatchObject({
            type: "review_request",
          });
          expect(next.hash).toBe("h");
        },
      },
      {
        name: "no platform",
        existing: { ...HISTORICAL_SHAPES.noPlatform },
        assert: (next) => {
          expect(next.hash).toBe("no-platform-hash");
          expect(next.error).toBe("prior-fail");
          expect(Object.hasOwn(next, "platform")).toBe(false);
        },
      },
      {
        name: "token only",
        existing: { ...HISTORICAL_SHAPES.tokenOnly },
        assert: (next) => {
          expect(next.tokenUsage).toEqual({ input: 42, output: 7 });
          expect(next.tokenUsageReason).toBe("historical-token-only-row");
        },
      },
      {
        name: "audit keys",
        existing: {
          dispatchKindNote: HISTORICAL_SHAPES.auditKeys.dispatchKindNote,
          rollbackSkipped: {
            ...HISTORICAL_SHAPES.auditKeys.rollbackSkipped,
          },
        },
        assert: (next) => {
          expect(next.dispatchKindNote).toBe(
            HISTORICAL_SHAPES.auditKeys.dispatchKindNote,
          );
          expect(next.rollbackSkipped).toEqual(
            HISTORICAL_SHAPES.auditKeys.rollbackSkipped,
          );
        },
      },
    ];

    for (const c of cases) {
      const next = mergeDiffSummary(c.existing, { summary: "x" }, "result");
      expect(next.summary, c.name).toBe("x");
      c.assert(next);
    }
  });
});

describe("W3 D2: completion event 与 task_status_changed 的 diffSummary 仍为含场景键的对象", () => {
  it("completion event 信封:历史 token+audit+resumeOf 经 PATCH done 后仍在信封 diffSummary", async () => {
    const owner = await register(`d2-ce-owner-${Date.now()}`);
    const executor = await register(`d2-ce-exec-${Date.now()}`);
    const group = await createGroup(owner.id, "d2-ce");
    const resumeOf = randomUUID();

    // 真历史混合行:直接 insert,含 metrics/audit/relation 关键键
    const historical = {
      tokenUsage: { input: 9, output: 3 },
      tokenUsageReason: "d2-hist",
      dispatchKindNote: "d2-note",
      rollbackSkipped: { reason: "d2-skip", headAtSkip: "aa", checkpoint: "cp" },
      platform: { resumeOf },
      hash: "d2-hist-hash",
      review_request: {
        type: "review_request",
        layer: 3,
        taskId: "will-be-overwritten-by-id",
        specRef: "specs/d2.md",
        specHash: "d2hash",
        diffSummary: "d2 hist rr",
      },
    };
    const row = await insertHistoricalTask(group.id, executor.id, historical, {
      dispatcherParticipantId: owner.id,
      dispatcherSessionId: "d2-ce-session",
      callbackRef: { platform: "codex" },
    });

    // 确认 insert 未经过 merge(platform.resumeOf 原样)
    const [raw] = await testDb
      .select({ diffSummary: taskTable.diffSummary })
      .from(taskTable)
      .where(eq(taskTable.id, row.id));
    expect(raw.diffSummary).toEqual(historical);

    await patchDone(group.id, row.id, executor.id, {
      summary: "d2-ce-done",
    });

    const ev = await waitForPendingEvent(owner.id, row.id);
    expect(ev.schemaVersion).toBe(1);
    expect(ev.type).toBe("coagenthub.task.completed");
    expect(ev.task.status).toBe("done");

    // diffSummary 仍为对象(不是 string / owners 嵌套)
    expect(ev.task.diffSummary).not.toBeNull();
    expect(typeof ev.task.diffSummary).toBe("object");
    expect(Array.isArray(ev.task.diffSummary)).toBe(false);

    const ds = ev.task.diffSummary as Record<string, unknown>;
    expect(ds).not.toHaveProperty("result");
    expect(ds).not.toHaveProperty("scheduling");
    expect(ds.summary).toBe("d2-ce-done");
    expect(ds.hash).toBe("d2-hist-hash");
    expect(ds.tokenUsage).toEqual({ input: 9, output: 3 });
    expect(ds.tokenUsageReason).toBe("d2-hist");
    expect(ds.dispatchKindNote).toBe("d2-note");
    expect(ds.rollbackSkipped).toEqual({
      reason: "d2-skip",
      headAtSkip: "aa",
      checkpoint: "cp",
    });
    expect(ds.platform).toMatchObject({ resumeOf });
    expect(ds.review_request).toMatchObject({
      type: "review_request",
      specRef: "specs/d2.md",
    });
  });

  it("task_status_changed WS 载荷:历史键经 PATCH 后仍在扁平 diffSummary", async () => {
    // WS 必须挂在 appWs 对应的 server 上;写路径也走 appWs,保证同进程 hub。
    const owner = await register(`d2-ws-owner-${Date.now()}`);
    const executor = await register(`d2-ws-exec-${Date.now()}`);

    // 用 appWs 建群,使 notify 推到本文件的 hub/server
    const createRes = await appWs.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": owner.id,
      },
      body: JSON.stringify({ title: "d2-ws" }),
    });
    expect(createRes.status).toBe(200);
    const group = (await createRes.json()) as { id: string };

    const resumeOf = randomUUID();
    const historical = {
      hash: "d2-ws-hash",
      error: "old-ws-error",
      platform: { resumeOf },
      dispatchKindNote: "ws-note",
      tokenUsage: { input: 1, output: 2 },
    };
    const [row] = await testDb
      .insert(taskTable)
      .values({
        groupId: group.id,
        messageId: randomUUID(),
        executorParticipantId: executor.id,
        status: "queued",
        diffSummary: historical,
      })
      .returning({ id: taskTable.id });

    const ws = await connectWs(owner.id);
    const frames = attachCollector(ws);

    const patchRes = await appWs.request(
      `/api/groups/${group.id}/tasks/${row.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": executor.id,
        },
        body: JSON.stringify({
          status: "done",
          diffSummary: { summary: "d2-ws-done" },
        }),
      },
    );
    expect(patchRes.status).toBe(200);

    await waitFor(() =>
      frames.some(
        (f) =>
          f.type === "task_status_changed" &&
          f.groupId === group.id &&
          f.status === "done",
      ),
    );

    const doneFrame = frames.find(
      (f) =>
        f.type === "task_status_changed" &&
        f.groupId === group.id &&
        f.status === "done",
    );
    expect(doneFrame).toBeDefined();
    const task = doneFrame?.task as Record<string, unknown> | undefined;
    expect(task).toBeDefined();
    expect(typeof task?.diffSummary).toBe("object");
    expect(task?.diffSummary).not.toBeNull();

    const ds = task?.diffSummary as Record<string, unknown>;
    expect(Array.isArray(ds)).toBe(false);
    expect(ds).not.toHaveProperty("result");
    expect(ds.summary).toBe("d2-ws-done");
    expect(ds.hash).toBe("d2-ws-hash");
    expect(ds.error).toBe("old-ws-error");
    expect(ds.dispatchKindNote).toBe("ws-note");
    expect(ds.tokenUsage).toEqual({ input: 1, output: 2 });
    expect(ds.platform).toMatchObject({ resumeOf });
  });
});
