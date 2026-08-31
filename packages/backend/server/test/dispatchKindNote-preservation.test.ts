import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  participant as participantTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  __resetExecutorQueueForTests,
  preserveDispatchKindNote,
} from "@server/lib/executor-task";
import { markTaskCancelled } from "../src/lib/executor-task/notify";
import type { DataBase } from "../src/lib/database";
import { createTestApp } from "./app";
import { seedBuiltinExecutorConfigs, testDb } from "./db";

// PGlite 与 node-postgres 的 drizzle 实例驱动类型不兼容(与
// executor-report-quota / detached-token-backfill 同款 cast);
// markTaskCancelled 只走共享的 query/update API。
const runtimeDb = testDb as unknown as DataBase;

/**
 * dispatchKindNote 跨生命周期保留(L3 medium finding 收敛):
 * R2 缺省留痕的保留规则曾在 queue.ts(私有函数)/ notify.ts(内联)/
 * routes/group/tasks.ts(内联)存在三份副本,本票收敛为 types.ts 的共享
 * helper。本文件提供:
 *
 * 1. helper 契约单测(不可解析 existing 安全处理 / 已有 note 保留 / 新值
 *    显式含该键时以新值为准);
 * 2. 三条生命周期路径的定向回归:tasks.ts PATCH 结案、notify.ts
 *    markTaskCancelled 取消落库、queue.ts 完成回填(fake bin 真实跑到
 *    done),防止任一副本再次内联分叉或行为漂移。
 *
 * 既有 spec(findings-ticket-hardcoded-to-fix-bypasses-l3)的 R1-R4 与五条
 * 验收行为由 findings-dispatchKind-regression.test.ts 逐字覆盖,本文件不改
 * 任何行为,只钉住「保留规则单点 + 三条路径同源」。
 */

const NOTE = "dispatchKind 由 findings 缺省推定为 fix,未由检视者显式指定";

// fake bin:结构化四段汇报(票7 协议)后 exit 0,走 queue.ts 真实完成回填
// 路径(覆盖 diffSummary 写 outputTail/claimVerification/tokenUsage)。
const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-dkn-bin-"));
const fakeBin = path.join(fakeDir, "fake-dkn-codebuddy.sh");
writeFileSync(
  fakeBin,
  [
    "#!/bin/sh",
    // sleep 留出测试写 diffSummary 留痕的窗口(完成回填读旧值在前)。
    "sleep 1.5",
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报: 完成 dispatchKindNote 保留验证"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeBin, 0o755);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;
// executor key(内置 AtomCode)无专用提取器,若任务落到它身上会 spawn 真实
// bin;本文件只用 codebuddy 成员,此覆盖是兜底(防其它用例残留干扰)。
process.env.EXECUTOR_BIN_EXECUTOR = fakeBin;

afterAll(() => {
  rmSync(fakeDir, { recursive: true, force: true });
});

beforeEach(() => {
  // 清理内存队列(模块级状态跨用例共享);只影响 e2e 用例,直写 DB 的用例
  // 不受影响。
  __resetExecutorQueueForTests();
});

beforeAll(async () => {
  await seedBuiltinExecutorConfigs();
});

describe("共享 helper preserveDispatchKindNote(R2 保留规则单点)", () => {
  it("existing 不可解析为 record(null/数组/标量)→ 安全不写、返回入参引用", () => {
    for (const existing of [null, undefined, ["note"], "corrupted", 42]) {
      const next = { error: "x" };
      expect(preserveDispatchKindNote(existing, next)).toBe(next);
      expect(Object.hasOwn(next, "dispatchKindNote")).toBe(false);
    }
  });

  it("existing 无 note → 不写、返回入参引用", () => {
    const next = { error: "x" };
    expect(preserveDispatchKindNote({ tokenUsage: { a: 1 } }, next)).toBe(
      next,
    );
    expect(Object.hasOwn(next, "dispatchKindNote")).toBe(false);
  });

  it("existing 有 note 且 next 缺该键 → 保留旧值", () => {
    const out = preserveDispatchKindNote({ dispatchKindNote: NOTE }, {
      error: "x",
    });
    expect(out.dispatchKindNote).toBe(NOTE);
  });

  it("next 显式含该键(不同值或 null)→ 以新值为准,不覆盖", () => {
    expect(
      preserveDispatchKindNote(
        { dispatchKindNote: NOTE },
        { dispatchKindNote: "新值" },
      ).dispatchKindNote,
    ).toBe("新值");
    expect(
      preserveDispatchKindNote(
        { dispatchKindNote: NOTE },
        { dispatchKindNote: null },
      ).dispatchKindNote,
    ).toBeNull();
  });

  it("existing 的 note 为空串(falsy,等同无留痕)→ 不写", () => {
    const next = { error: "x" };
    preserveDispatchKindNote({ dispatchKindNote: "" }, next);
    expect(Object.hasOwn(next, "dispatchKindNote")).toBe(false);
  });
});

// ---------- 三条生命周期路径的公共基建 ----------

async function register(name: string) {
  const app = createTestApp();
  const res = await app.request("/api/participants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res.status === 409) {
    const list = (
      await (await app.request("/api/participants")).json()
    ) as { id: string; name: string }[];
    const existing = list.find((p) => p.name === name);
    if (existing) return { id: existing.id };
  }
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

async function createGroup(ownerId: string, title: string) {
  const res = await app.request(`/api/groups`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Participant-Id": ownerId },
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

async function addMember(
  callerId: string,
  groupId: string,
  memberId: string,
  roles: string[],
) {
  const res = await app.request(`/api/groups/${groupId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Participant-Id": callerId },
    body: JSON.stringify({ participantId: memberId, roles }),
  });
  expect(res.status).toBe(200);
}

async function bindExecutor(participantId: string, key: string) {
  // 先清同 key 的其它绑定再绑本 participant:防「解析第一个匹配者」时
  // 串到其它用例的 participant(与 detached-token-backfill 同款)。
  await testDb
    .update(participantTable)
    .set({ executorKey: null })
    .where(eq(participantTable.executorKey, key));
  await testDb
    .update(participantTable)
    .set({ executorKey: key })
    .where(eq(participantTable.id, participantId));
}

async function insertTask(
  groupId: string,
  executorParticipantId: string,
  diffSummary: Record<string, unknown> | string | null,
) {
  const [row] = await testDb
    .insert(taskTable)
    .values({
      groupId,
      messageId: crypto.randomUUID(),
      executorParticipantId,
      status: "queued",
      diffSummary,
    })
    .returning({ id: taskTable.id });
  return row.id;
}

async function getTask(taskId: string) {
  const [row] = await testDb
    .select()
    .from(taskTable)
    .where(eq(taskTable.id, taskId));
  return row;
}

// 顶层 createTestApp:路由与 PGlite 共享同一模块级 testDb,各 describe 复用。
const app = createTestApp();

describe("路径一:PATCH /tasks(routes/group/tasks.ts)保留与显式覆盖", () => {
  it("新 diffSummary 不含 note → 保留既有;显式携带 → 以新值为准", async () => {
    const owner = await register(`dkn-patch-owner-${Date.now()}`);
    const executor = await register(`dkn-patch-exec-${Date.now()}`);
    const group = await createGroup(owner.id, "dkn-patch");
    const taskId = await insertTask(group.id, executor.id, {
      dispatchKindNote: NOTE,
    });

    // 覆盖式 diffSummary(不含 note)→ 既有 note 不得丢失
    const patch1 = await app.request(
      `/api/groups/${group.id}/tasks/${taskId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": executor.id,
        },
        body: JSON.stringify({ diffSummary: { summary: "覆盖写入" } }),
      },
    );
    expect(patch1.status).toBe(200);
    let row = await getTask(taskId);
    expect(row.diffSummary).toMatchObject({ summary: "覆盖写入" });
    expect(
      (row.diffSummary as Record<string, unknown>).dispatchKindNote,
    ).toBe(NOTE);

    // 显式携带该键 → 以新值为准(保留规则的唯一出口)
    const patch2 = await app.request(
      `/api/groups/${group.id}/tasks/${taskId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": executor.id,
        },
        body: JSON.stringify({
          diffSummary: { dispatchKindNote: "显式指定值" },
        }),
      },
    );
    expect(patch2.status).toBe(200);
    row = await getTask(taskId);
    expect(
      (row.diffSummary as Record<string, unknown>).dispatchKindNote,
    ).toBe("显式指定值");
  });
});

describe("路径二:markTaskCancelled(executor-task/notify.ts)取消落库保留", () => {
  it("取消时保留既有 note,与 error=stopped 共存", async () => {
    const owner = await register(`dkn-cancel-owner-${Date.now()}`);
    const executor = await register(`dkn-cancel-exec-${Date.now()}`);
    const group = await createGroup(owner.id, "dkn-cancel");
    const taskId = await insertTask(group.id, executor.id, {
      dispatchKindNote: NOTE,
      other: 1,
    });

    await markTaskCancelled(runtimeDb, taskId, group.id);

    const row = await getTask(taskId);
    expect(row.status).toBe("cancelled");
    expect(row.diffSummary).toMatchObject({
      error: "stopped",
      dispatchKindNote: NOTE,
    });
  });

  it("既有 diffSummary 不可解析为 record(字符串)→ 安全处理,不写 note、不抛错", async () => {
    const owner = await register(`dkn-cancel2-owner-${Date.now()}`);
    const executor = await register(`dkn-cancel2-exec-${Date.now()}`);
    const group = await createGroup(owner.id, "dkn-cancel2");
    const taskId = await insertTask(group.id, executor.id, "损坏的旧数据");

    await expect(markTaskCancelled(runtimeDb, taskId, group.id)).resolves.toBeDefined();

    const row = await getTask(taskId);
    expect(row.status).toBe("cancelled");
    expect(row.diffSummary).toMatchObject({ error: "stopped" });
    expect(
      Object.hasOwn(row.diffSummary as Record<string, unknown>, "dispatchKindNote"),
    ).toBe(false);
  });
});

describe("路径三:queue.ts 完成回填(fake bin 真实跑到 done)保留", () => {
  it(
    "完成回填覆盖 diffSummary 后仍保留既有 dispatchKindNote",
    async () => {
      const coordinator = await register(`dkn-coord-${Date.now()}`);
      const executorMember = await register(`dkn-exec-${Date.now()}`);
      // executor 成员(非 coordinator 角色)→ 非 detached,真实 spawn fake
      // bin 跑完完成回填路径;bin 为 codebuddy 配置(EXECUTOR_BIN_CODEBUDDY
      // 覆盖为 fake bin,sleep 留出写留痕窗口)。
      await bindExecutor(executorMember.id, "codebuddy");
      const group = await createGroup(coordinator.id, "dkn-e2e");
      await addMember(coordinator.id, group.id, executorMember.id, [
        "executor",
      ]);

      const res = await app.request(`/api/groups/${group.id}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": coordinator.id,
        },
        body: JSON.stringify({
          body: "dkn-completion-task",
          audience: "participant",
          audienceRef: executorMember.id,
        }),
      });
      expect(res.status).toBe(200);
      const msg = (await res.json()) as { id: string };
      const task = await waitForTask(msg.id);

      // 在终态回填前写入 R2 缺省留痕(findings 缺省 fix 任务创建时即带;
      // 留痕来源对本路径无意义,保留规则只认既有值):完成路径整体重写
      // diffSummary(summary/outputTail/tokenUsage/claimVerification),
      // 留痕必须在覆盖后仍在。
      await testDb
        .update(taskTable)
        .set({ diffSummary: { dispatchKindNote: NOTE } })
        .where(eq(taskTable.id, task.id));

      const done = await waitForStatus(task.id, "done", 30_000);
      expect(done.diffSummary).toMatchObject({
        summary: "完成 dispatchKindNote 保留验证",
      });
      expect(
        (done.diffSummary as Record<string, unknown>).dispatchKindNote,
      ).toBe(NOTE);
    },
    30_000,
  );
});

async function waitForTask(messageId: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await testDb
      .select()
      .from(taskTable)
      .where(eq(taskTable.messageId, messageId));
    if (row) return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`task for message ${messageId} not found`);
}

async function waitForStatus(
  taskId: string,
  status: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await testDb
      .select()
      .from(taskTable)
      .where(eq(taskTable.id, taskId));
    if (row && row.status === status) return row;
    if (Date.now() > deadline) {
      throw new Error(
        `task ${taskId} 未在 ${timeoutMs}ms 内达到 ${status}(当前=${row?.status ?? "无"})`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
