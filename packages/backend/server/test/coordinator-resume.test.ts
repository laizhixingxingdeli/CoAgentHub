import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  executorConfig as executorConfigTable,
  groupMember as groupMemberTable,
  groupMessageClosure as groupMessageClosureTable,
  groupMessage as groupMessageTable,
  groups as groupsTable,
  participant as participantTable,
  taskCompletionEvent as taskCompletionEventTable,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DataBase } from "../src/lib/database";
import { seedBuiltinExecutorConfigs, testDb } from "./db";
import { resolveFakeExecutor, withFakeExecutorArgs } from "./fake-executor-bin";

/**
 * 子任务终态时把协调者重新拉起(specs/wake-the-coordinator-on-child-completion.md
 * R1-R6):
 * - R1:子任务终态 + 父协调任务非终态 + 父进程已退出 → 创建续跑任务;
 * - brief 含父任务 id / 终态子任务 id+状态+diffSummary / specRef+specHash /
 *   全部子任务 id 与状态;
 * - R2:父进程仍存活 → 不创建(回归,必测);
 * - R3:已有非终态续跑任务 → 不重复创建(必测);
 * - R4:续跑任务自身终态 → 不触发新的续跑(防环,必测);
 * - 父任务已终态 → 不创建;
 * - R6:协调者退出后父任务保持 running,不被判失败(回归,必测);
 * - R5:协调者任务书含「派发后可退出」那行(必测);
 * - 端到端:下发需求票 → 协调者派子任务后退出 → 子任务完成 → 协调者被重新拉起
 *   → PATCH 父任务结案(本票唯一真验收信号)。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-resume-bin-"));
const fakeScript = path.join(fakeDir, "fake-executor.sh");
writeFileSync(
  fakeScript,
  [
    "#!/bin/sh",
    'if [ -n "$FAKE_TICKET_COPY" ]; then cp "$3" "$FAKE_TICKET_COPY"; fi',
    // 瞬时限流(分级应判 transient):短相对恢复提示 + 提供方限流行形状。
    'if [ -n "$FAKE_TRANSIENT_QUOTA" ]; then echo "[rate-limited] try again in 5 seconds"; exit 1; fi',
    // 额度耗尽(分级应判 exhausted):绝对恢复时刻。
    'if [ -n "$FAKE_EXHAUSTED_QUOTA" ]; then echo "usage limit reached — resets around 23:59"; exit 1; fi',
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:修改完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeScript, 0o755);
const { bin: fakeBin, argsPrefix: fakeArgsPrefix } =
  resolveFakeExecutor(fakeScript);
process.env.EXECUTOR_BIN_EXECUTOR = fakeBin;
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;

// 顶层 await 动态 import:env 设置先于模块求值。
const { createTestApp } = await import("./app");
const {
  __resetExecutorQueueForTests,
  consumePendingCompletionEvents,
  enqueueTaskRun,
  hasExemptingChildTask,
  hasPendingResumeEvent,
  maybeCreateCoordinatorResumeTask,
} = await import("../src/lib/executor-task");
const { __setTransientQuotaForTests, isInCooldown } = await import(
  "../src/lib/executor-task/state"
);
const { enterCooldown } = await import("../src/lib/executor-task/queue");
const { findExecutorByKey } = await import("@server/lib/executors");
const { buildSupersededEchoSection, buildDiffSummaryEcho } = await import(
  "../src/lib/executor-task/coordinator-resume"
);

const runtimeDb = testDb as unknown as DataBase;

/** 生成一个已退出进程的 pid(process.kill(pid,0) → ESRCH = 已退出)。 */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    timeout: 5_000,
  });
  return child.pid;
}

async function insertParticipant(name: string) {
  const [row] = await testDb
    .insert(participantTable)
    .values({ name, tokenHash: "", executorKey: null })
    .returning();
  return row;
}

async function insertGroup(createdBy: string) {
  const [row] = await testDb
    .insert(groupsTable)
    .values({ title: `resume-g-${crypto.randomUUID().slice(0, 8)}`, createdBy })
    .returning();
  return row;
}

async function insertMember(
  groupId: string,
  participantId: string,
  roles: string[],
) {
  await testDb
    .insert(groupMemberTable)
    .values({ groupId, participantId, roles });
}

async function insertTask(opts: {
  groupId: string;
  executorParticipantId: string;
  status?: "queued" | "running" | "done" | "failed" | "cancelled";
  parentTaskId?: string | null;
  dispatcherParticipantId?: string | null;
  executorPid?: number | null;
  specRef?: string | null;
  specHash?: string | null;
  diffSummary?: unknown;
  supersedesTaskId?: string | null;
  brief?: string | null;
}) {
  const [row] = await testDb
    .insert(taskTable)
    .values({
      groupId: opts.groupId,
      messageId: crypto.randomUUID(),
      executorParticipantId: opts.executorParticipantId,
      executorKey: "executor",
      status: opts.status ?? "queued",
      parentTaskId: opts.parentTaskId ?? null,
      dispatcherParticipantId: opts.dispatcherParticipantId ?? null,
      executorPid: opts.executorPid ?? null,
      specRef: opts.specRef ?? null,
      specHash: opts.specHash ?? null,
      diffSummary: opts.diffSummary ?? null,
      supersedesTaskId: opts.supersedesTaskId ?? null,
      brief: opts.brief ?? null,
    })
    .returning();
  return row;
}

/** 标准场景:协调者(父, running, 进程已退出) + 执行器(子, done)。 */
async function seedParentChild(opts: {
  parentStatus?: "queued" | "running" | "done" | "failed" | "cancelled";
  parentPid?: number | null;
  childStatus?: "queued" | "running" | "done" | "failed" | "cancelled";
  childDiffSummary?: unknown;
  parentSpecRef?: string | null;
  parentSpecHash?: string | null;
  parentDispatchKind?: "requirement" | "fix" | null;
}) {
  const coordinator = await insertParticipant(`coord-${crypto.randomUUID()}`);
  const executor = await insertParticipant(`exec-${crypto.randomUUID()}`);
  const group = await insertGroup(coordinator.id);
  await insertMember(group.id, coordinator.id, ["coordinator"]);
  await insertMember(group.id, executor.id, ["executor"]);
  const parent = await insertTask({
    groupId: group.id,
    executorParticipantId: coordinator.id,
    status: opts.parentStatus ?? "running",
    executorPid: opts.parentPid ?? deadPid(),
    specRef:
      opts.parentSpecRef ?? "specs/wake-the-coordinator-on-child-completion.md",
    specHash: opts.parentSpecHash ?? "698657844210f681252848fc5974dd1123a6264c",
    diffSummary: opts.parentDispatchKind !== undefined ? {} : null,
  });
  const child = await insertTask({
    groupId: group.id,
    executorParticipantId: executor.id,
    status: opts.childStatus ?? "done",
    parentTaskId: parent.id,
    dispatcherParticipantId: coordinator.id,
    diffSummary: opts.childDiffSummary ?? { summary: "子任务完成" },
  });
  return { coordinator, executor, group, parent, child };
}

async function findTask(id: string) {
  const rows = await testDb
    .select()
    .from(taskTable)
    .where(eq(taskTable.id, id));
  return rows[0];
}

async function resumeTasksFor(parentId: string) {
  const rows = await testDb
    .select()
    .from(taskTable)
    .where(and(eq(taskTable.parentTaskId, parentId)));
  return rows.filter((row) => {
    const summary = row.diffSummary;
    return (
      typeof summary === "object" &&
      summary !== null &&
      !Array.isArray(summary) &&
      typeof (summary as Record<string, unknown>).platform === "object"
    );
  });
}

async function countPendingEvents(): Promise<number> {
  const rows = await testDb
    .select({ id: taskCompletionEventTable.id })
    .from(taskCompletionEventTable)
    .where(eq(taskCompletionEventTable.state, "pending"));
  return rows.length;
}

async function insertPendingCompletionEvent(
  child: typeof taskTable.$inferSelect,
  dispatcherParticipantId: string,
) {
  await testDb.insert(taskCompletionEventTable).values({
    taskId: child.id,
    groupId: child.groupId,
    dispatcherParticipantId,
    state: "pending",
  });
}

beforeEach(async () => {
  __resetExecutorQueueForTests();
  await testDb.delete(taskCompletionEventTable);
  await testDb.delete(groupMessageClosureTable);
  await testDb.delete(groupMessageTable);
  await testDb.delete(taskTable);
  await testDb.delete(groupMemberTable);
  await testDb.delete(groupsTable);
  await testDb.delete(participantTable);
});

afterAll(() => {
  rmSync(fakeDir, { recursive: true, force: true });
});

beforeAll(async () => {
  await seedBuiltinExecutorConfigs();
  // win32: EXECUTOR_BIN 只覆盖 bin;把脚本路径拼进 args 最前面,原占位参数顺序不变。
  if (fakeArgsPrefix.length > 0) {
    for (const key of ["executor", "codebuddy"] as const) {
      const [row] = await testDb
        .select()
        .from(executorConfigTable)
        .where(eq(executorConfigTable.key, key));
      if (!row) continue;
      await testDb
        .update(executorConfigTable)
        .set({ args: withFakeExecutorArgs(fakeArgsPrefix, row.args ?? []) })
        .where(eq(executorConfigTable.key, key));
    }
  }
});

describe.sequential("协调者续跑完整验收", () => {
  describe.sequential("maybeCreateCoordinatorResumeTask (R1-R4 / 父终态 / R6)", () => {
    it("R1:子任务 done + 父协调任务 running + 父进程已退出 → 创建续跑任务", async () => {
      const { coordinator, group, parent, child } = await seedParentChild({});
      const result = await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      expect(result).toEqual({ kind: "created" });

      const resumes = await resumeTasksFor(parent.id);
      expect(resumes.length).toBe(1);
      const resume = resumes[0];
      expect(resume.parentTaskId).toBe(parent.id);
      expect(resume.executorParticipantId).toBe(coordinator.id);
      expect(resume.groupId).toBe(group.id);
      expect(["queued", "running"]).toContain(resume.status);
      // R4 平台标记:diffSummary.platform.resumeOf = 父任务 id。
      expect(
        (resume.diffSummary as Record<string, unknown>).platform,
      ).toMatchObject({ resumeOf: parent.id });
    });

    it("R1:brief 含父任务 id / 终态子任务 id+状态+diffSummary / specRef+specHash / 全部子任务", async () => {
      const { parent, child } = await seedParentChild({});
      // 再加一个未终态子任务,验证「全部子任务」列出所有。
      const executor2 = await insertParticipant(`exec2-${crypto.randomUUID()}`);
      const sibling = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: executor2.id,
        status: "running",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
      });

      await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      const resumes = await resumeTasksFor(parent.id);
      const brief = resumes[0].brief ?? "";
      expect(brief).toContain(parent.id);
      expect(brief).toContain(child.id);
      expect(brief).toContain(child.status);
      expect(brief).toContain("子任务完成");
      expect(brief).toContain(parent.specRef ?? "");
      expect(brief).toContain(parent.specHash ?? "");
      expect(brief).toContain(sibling.id);
      expect(brief).toContain(sibling.status);
      // 重试上下文:首次尝试(无 supersedesTaskId 链)必须如实标注第 1 次尝试。
      expect(brief).toContain("第 1 次尝试");
    });

    it("R1:brief 含重试上下文 —— 沿 supersedesTaskId 链给出第几次尝试,并强制重发任务书两段式", async () => {
      const { parent } = await seedParentChild({});
      const executor2 = await insertParticipant(`exec-${crypto.randomUUID()}`);
      // 第一次尝试:失败(留下证据)。
      const attempt1 = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: executor2.id,
        status: "failed",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        diffSummary: { error: "测试失败,用例 xxx 红" },
      });
      // 第二次尝试:L2 重发,替代 attempt1 后完成。
      const attempt2 = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: executor2.id,
        status: "done",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        supersedesTaskId: attempt1.id,
        diffSummary: { summary: "子任务完成" },
      });

      await maybeCreateCoordinatorResumeTask(runtimeDb, attempt2);
      const resumes = await resumeTasksFor(parent.id);
      const brief = resumes[0].brief ?? "";
      // 沿 supersedesTaskId 链回溯:第 2 次尝试,链上列出 attempt1。
      expect(brief).toContain("第 2 次尝试");
      expect(brief).toContain(attempt1.id);
      // 重发协议强制注入每轮必读的续跑任务书:两段式 + 可见差异 + 三次上限。
      expect(brief).toContain("上次失败的判定");
      expect(brief).toContain("本次要避开什么");
      expect(brief).toContain("逐字相同");
      expect(brief).toContain("三次");
    });

    it("R2:父进程仍存活 → 不创建续跑任务(回归,必测)", async () => {
      const { parent, child } = await seedParentChild({
        parentPid: process.pid, // 本测试进程存活
      });
      const result = await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      // 暂时 skip(父进程存活,条件可能变化)→ 带诊断原因但保持 temporary。
      expect(result).toEqual({
        kind: "skipped",
        permanence: "temporary",
        reason: expect.stringContaining("仍存活"),
      });
      expect(await resumeTasksFor(parent.id)).toHaveLength(0);
    });

    it("R3:已有非终态续跑任务 → 不重复创建(必测)", async () => {
      const { parent, child } = await seedParentChild({});
      // 先创建一条续跑任务(queued)。
      await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      expect(await resumeTasksFor(parent.id)).toHaveLength(1);
      // 再消费一次 → R3 命中,不重复创建(带诊断原因的暂时 skip)。
      const result = await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      expect(result).toEqual({
        kind: "skipped",
        permanence: "temporary",
        reason: expect.stringContaining("非终态续跑"),
      });
      expect(await resumeTasksFor(parent.id)).toHaveLength(1);
    });

    it("R4:续跑任务自身终态 → 不触发新的续跑(防环,必测)", async () => {
      const { parent } = await seedParentChild({});
      // 构造一条「续跑任务」:parentTaskId = 父任务 + 平台标记 resumeOf。
      const resume = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: parent.executorParticipantId,
        status: "done",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        diffSummary: { platform: { resumeOf: parent.id } },
      });
      const result = await maybeCreateCoordinatorResumeTask(runtimeDb, resume);
      // 永久 skip(R4 防环)→ reason 非 null。
      expect(result).toEqual({
        kind: "skipped",
        permanence: "permanent",
        reason: expect.stringContaining("R4"),
      });
      expect(await resumeTasksFor(parent.id)).toHaveLength(1); // 只有这条 resume 本身
    });

    it("父任务已终态 → 不创建续跑任务(永久 skip,reason 非 null)", async () => {
      const { parent, child } = await seedParentChild({ parentStatus: "done" });
      const result = await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      expect(result).toEqual({
        kind: "skipped",
        permanence: "permanent",
        reason: expect.stringContaining("终态"),
      });
      expect(await resumeTasksFor(parent.id)).toHaveLength(0);
    });

    it("父任务执行方不是协调者 → 不创建续跑任务", async () => {
      const { parent, child } = await seedParentChild({});
      // 把父任务执行方改成非 coordinator 角色成员(executor 本人)。
      await testDb
        .update(taskTable)
        .set({ executorParticipantId: child.executorParticipantId })
        .where(eq(taskTable.id, parent.id));
      const result = await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      // 暂时 skip:群成员角色运行期可变(该成员可恢复 coordinator),保留 pending
      // 下轮重试(specs/completion-events-never-reach-terminal-state.md §3.2)。
      expect(result).toEqual({
        kind: "skipped",
        permanence: "temporary",
        reason: expect.stringContaining("不是协调者"),
      });
      expect(await resumeTasksFor(parent.id)).toHaveLength(0);
    });

    it("R6:协调者退出后父任务保持 running,不被判失败(回归,必测)", async () => {
      const { parent, child } = await seedParentChild({});
      await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      const after = await findTask(parent.id);
      expect(after.status).toBe("running");
      expect(after.status).not.toBe("failed");
    });

    it("续跑任务 diffSummary.platform 同时记录 resumeForChild = 触发续跑的子任务 id", async () => {
      const { parent, child } = await seedParentChild({});
      await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      const resumes = await resumeTasksFor(parent.id);
      expect(resumes.length).toBe(1);
      const platform = (resumes[0].diffSummary as Record<string, unknown>)
        .platform as Record<string, unknown>;
      expect(platform.resumeForChild).toBe(child.id);
    });

    it("续跑任务书回显被替代任务的验收标准与红线原文", async () => {
      const { parent, executor } = await seedParentChild({});
      // 构造被替代任务(第一次尝试),其 brief 含验收标准与红线。
      const attempt1 = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: executor.id,
        status: "failed",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        brief: [
          "## Acceptance",
          "1. 必须实现功能 A",
          "2. 测试全绿",
          "",
          "## 红线",
          "- 不得改 schema",
        ].join("\n"),
      });
      // 第二次尝试,替代 attempt1。
      const attempt2 = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: executor.id,
        status: "done",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        supersedesTaskId: attempt1.id,
        diffSummary: { summary: "完成" },
      });

      await maybeCreateCoordinatorResumeTask(runtimeDb, attempt2);
      const resumes = await resumeTasksFor(parent.id);
      const brief = resumes[0].brief ?? "";
      expect(brief).toContain("被替代任务验收标准与红线");
      expect(brief).toContain(attempt1.id);
      expect(brief).toContain("必须实现功能 A");
      expect(brief).toContain("不得改 schema");
    });

    it("续跑任务书缺失验收标准/红线时显式说明无法取得,不得伪造", async () => {
      const { parent, executor } = await seedParentChild({});
      const attempt1 = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: executor.id,
        status: "failed",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        brief: "无章节正文",
      });
      const attempt2 = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: executor.id,
        status: "done",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        supersedesTaskId: attempt1.id,
      });

      await maybeCreateCoordinatorResumeTask(runtimeDb, attempt2);
      const resumes = await resumeTasksFor(parent.id);
      const brief = resumes[0].brief ?? "";
      expect(brief).toContain("无法取得该任务书的验收标准原文");
      expect(brief).toContain("无法取得该任务书的红线原文");
    });

    it("首次尝试(无 supersedesTaskId)的续跑任务书不含被替代任务章节", async () => {
      const { parent, child } = await seedParentChild({});
      await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      const resumes = await resumeTasksFor(parent.id);
      const brief = resumes[0].brief ?? "";
      expect(brief).not.toContain("被替代任务验收标准与红线");
    });

    it("回显明确标注来源任务 id 与哪一次尝试", async () => {
      const { parent, executor } = await seedParentChild({});
      const attempt1 = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: executor.id,
        status: "failed",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        brief: [
          "## Acceptance",
          "1. 必须实现功能 A",
          "",
          "## 红线",
          "- 不得改 schema",
        ].join("\n"),
      });
      const attempt2 = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: executor.id,
        status: "done",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        supersedesTaskId: attempt1.id,
        diffSummary: { summary: "完成" },
      });

      await maybeCreateCoordinatorResumeTask(runtimeDb, attempt2);
      const resumes = await resumeTasksFor(parent.id);
      const brief = resumes[0].brief ?? "";
      expect(brief).toContain(`来源任务 id: ${attempt1.id}`);
      expect(brief).toContain("哪一次尝试: 第 1 次尝试");
    });

    it("被替代任务不存在时明确写无上次任务书可回显", () => {
      const result = buildSupersededEchoSection(undefined, true, 1);
      const text = result.join("\n");
      expect(text).toContain("被替代任务验收标准与红线");
      expect(text).toContain("无上次任务书可回显");
    });

    it("被替代任务 brief 为空时明确写无上次任务书可回显", async () => {
      const { parent, executor } = await seedParentChild({});
      const attempt1 = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: executor.id,
        status: "failed",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        brief: null,
      });
      const attempt2 = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: executor.id,
        status: "done",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        supersedesTaskId: attempt1.id,
        diffSummary: { summary: "完成" },
      });

      await maybeCreateCoordinatorResumeTask(runtimeDb, attempt2);
      const resumes = await resumeTasksFor(parent.id);
      const brief = resumes[0].brief ?? "";
      expect(brief).toContain("被替代任务验收标准与红线");
      expect(brief).toContain("无上次任务书可回显");
    });

    it("被替代任务 brief 超长时有界截断并标注截断位置", async () => {
      const { parent, executor } = await seedParentChild({});
      const longContent = "A".repeat(5000);
      const attempt1 = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: executor.id,
        status: "failed",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        brief: [
          "## Acceptance",
          longContent,
          "",
          "## 红线",
          "- 不得改 schema",
        ].join("\n"),
      });
      const attempt2 = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: executor.id,
        status: "done",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        supersedesTaskId: attempt1.id,
        diffSummary: { summary: "完成" },
      });

      await maybeCreateCoordinatorResumeTask(runtimeDb, attempt2);
      const resumes = await resumeTasksFor(parent.id);
      const brief = resumes[0].brief ?? "";
      expect(brief).toContain("被替代任务验收标准与红线");
      expect(brief).toContain("【截断】");
      expect(brief).toContain("原文共");
      expect(brief).toContain("保留前");
      expect(brief).not.toContain(longContent);
    });

    it("既有续跑任务书其余内容逐字不变", async () => {
      const { parent, executor } = await seedParentChild({});
      const attempt1 = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: executor.id,
        status: "failed",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        brief: "## Acceptance\n1. 功能A\n\n## 红线\n- 不得改 schema",
      });
      const attempt2 = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: executor.id,
        status: "done",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        supersedesTaskId: attempt1.id,
        diffSummary: { summary: "完成" },
      });

      await maybeCreateCoordinatorResumeTask(runtimeDb, attempt2);
      const resumes = await resumeTasksFor(parent.id);
      const brief = resumes[0].brief ?? "";

      // 重试上下文逐字不变
      expect(brief).toContain("## 重试上下文");
      expect(brief).toContain("第 2 次尝试");
      expect(brief).toContain("上次失败的判定");
      expect(brief).toContain("本次要避开什么");
      expect(brief).toContain("逐字相同");
      expect(brief).toContain("三次");

      // 子任务状态与 L2 指令逐字不变
      expect(brief).toContain("## 全部子任务");
      expect(brief).toContain("## 操作");
      expect(brief).toContain("PATCH 父任务为 done");
    });
  });

  describe.sequential("R2 交互回归:瞬时限流退避不得夺走 queued 子任务的父协调者豁免(specs/transient-ratelimit-escalated-to-long-cooldown 验收 3)", () => {
    // 本组用例自带临时 git 仓库:本文件其它用例的 fire-and-forget spawn 会在
    // setup.ts 的共享临时仓库里做 git add/commit,被测试重置 SIGKILL 后可能
    // 留下 index.lock,使本组 spawn 的「执行前快照」失败(本文件既有 flake,
    // 与本票改动无关 —— 端到端用例同样偶发)。隔离后本组不受其影响。
    const ownRepo = mkdtempSync(path.join(tmpdir(), "coagenthub-resume-repo-"));
    const originalRepoRoot = process.env.COAGENTHUB_REPO_ROOT;
    beforeAll(() => {
      spawnSync("git", ["init", "-q"], { cwd: ownRepo });
      spawnSync(
        "git",
        [
          "-c",
          "user.name=coagenthub-test",
          "-c",
          "user.email=coagenthub-test@example.com",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "init",
        ],
        { cwd: ownRepo },
      );
      process.env.COAGENTHUB_REPO_ROOT = ownRepo;
    });
    afterAll(() => {
      if (originalRepoRoot === undefined) {
        delete process.env.COAGENTHUB_REPO_ROOT;
      } else {
        process.env.COAGENTHUB_REPO_ROOT = originalRepoRoot;
      }
      rmSync(ownRepo, { recursive: true, force: true });
    });

    /** 父协调者(running,pid 已消失)+ 子任务(queued,执行器 key = executor)。 */
    async function seedParentWithQueuedChild() {
      const coordinator = await insertParticipant(
        `coord-${crypto.randomUUID()}`,
      );
      const executor = await insertParticipant(`exec-${crypto.randomUUID()}`);
      const group = await insertGroup(coordinator.id);
      await insertMember(group.id, coordinator.id, ["coordinator"]);
      await insertMember(group.id, executor.id, ["executor"]);
      const parent = await insertTask({
        groupId: group.id,
        executorParticipantId: coordinator.id,
        status: "running",
        executorPid: deadPid(),
      });
      const child = await insertTask({
        groupId: group.id,
        executorParticipantId: executor.id,
        status: "queued",
        parentTaskId: parent.id,
        dispatcherParticipantId: coordinator.id,
      });
      return { coordinator, executor, group, parent, child };
    }

    /** 轮询子任务直到谓词成立(瞬时限流处置是 fire-and-forget)。 */
    async function waitForChild(
      childId: string,
      predicate: (t: {
        status: string;
        attempts: unknown[] | null | undefined;
      }) => boolean,
      timeoutMs = 20_000,
    ) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const row = await findTask(childId);
        if (row && predicate(row)) return row;
        if (Date.now() > deadline) {
          throw new Error(
            `子任务 ${childId} 在 ${timeoutMs}ms 内未满足断言(当前状态=${
              row?.status ?? "无"
            }, diffSummary=${JSON.stringify(row?.diffSummary ?? null)})`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    /** 等瞬时限流的 ⏳ 回传落库:回传与落库异步,否则用例结束时回传会撞上
     *  beforeEach 的清表(next test 拿到一堆「状态回传失败」噪音)。 */
    async function waitForStatusMessage(
      groupId: string,
      prefix: string,
      timeoutMs = 10_000,
    ) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const rows = await testDb
          .select({ body: groupMessageTable.body })
          .from(groupMessageTable)
          .where(eq(groupMessageTable.groupId, groupId));
        const hit = rows.find((r) => r.body.startsWith(prefix));
        if (hit) return hit.body;
        if (Date.now() > deadline) {
          throw new Error(`群里未出现 ${prefix} 开头的回传`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    it("子任务因瞬时限流退避而 queued → 执行器不在冷却 → 父协调者仍获豁免", async () => {
      const { executor, group, parent, child } =
        await seedParentWithQueuedChild();
      __setTransientQuotaForTests(2_000, 3);
      process.env.FAKE_TRANSIENT_QUOTA = "1";
      const ex = await findExecutorByKey(runtimeDb, "executor");
      if (!ex) throw new Error("executor 执行器配置缺失(seed 未生效)");

      try {
        await enqueueTaskRun(runtimeDb, child, {
          groupId: group.id,
          messageId: crypto.randomUUID(),
          participantId: executor.id,
          ex,
          body: "瞬时限流退避任务",
          groupPrompt: null,
          specRef: null,
          specHash: null,
        });
        const settled = await waitForChild(
          child.id,
          (t) => (t.attempts?.length ?? 0) >= 1 && t.status === "queued",
        );

        // 本 spec 的核心:瞬时限流走 per-run 退避,不写 executorCooldowns。
        expect(isInCooldown({ key: "executor" })).toBe(false);
        // 于是 queued 子任务的执行器仍判为可派发 → 父协调者不被孤儿收敛判死。
        expect(await hasExemptingChildTask(runtimeDb, parent.id)).toBe(true);
        const diff = settled.diffSummary as Record<string, unknown> | null;
        expect(diff?.quotaKind).toBe("transient");
        expect(String(diff?.waiting ?? "")).toContain("瞬时限流");
        // ⏳ 回传说明退避后自动重试(不是 ❌ 失败回传)。
        const backoffMsg = await waitForStatusMessage(group.id, "⏳");
        expect(backoffMsg).toContain("瞬时限流");
        expect(backoffMsg).toContain("保持排队");
      } finally {
        delete process.env.FAKE_TRANSIENT_QUOTA;
      }
    }, 30_000);

    it("对比:同一 queued 子任务在其执行器处于额度冷却时 → 不豁免(上一条的判据就是 isInCooldown)", async () => {
      const { parent } = await seedParentWithQueuedChild();
      // 只动一个变量:把执行器置入冷却 —— 这正是瞬时限流必须避免的副作用
      // (spec §2.1:短冷却 + 任务回 queued 会杀掉整条协调链)。
      enterCooldown(
        { key: "executor", label: "executor" },
        Date.now() + 60_000,
      );
      expect(isInCooldown({ key: "executor" })).toBe(true);
      expect(await hasExemptingChildTask(runtimeDb, parent.id)).toBe(false);
    }, 30_000);
  });

  describe.sequential("子任务 diffSummary 回显有界(specs/resume-brief-echoes-unbounded-diffsummary.md)", () => {
    /** spec R1 建议的上限,与 MAX_RESUME_DS_ECHO_LENGTH 对齐。 */
    const ECHO_LIMIT = 2000;
    /** 省略提示的固定文案开销上界(省略字符数 + 明细 API 路径)。 */
    const NOTICE_OVERHEAD = 200;
    /** 纯函数用例用的占位 task id(不落库)。 */
    const childEchoTaskId = "task-echo-1";

    /** L2 检视真正要的信息:执行器五段汇报,全部在输出末尾。 */
    const TAIL_REPORT = [
      "提交: 0123456789abcdef0123456789abcdef01234567",
      "测试: 12 passed / 0 failed",
      "Token: 123456",
      "汇报: 已限制 diffSummary 回显体积",
      "遗留: 无",
    ].join("\n");

    /** 构造 spec §1 实测规模(111K)的 outputTail:过程输出在前,汇报在末尾。 */
    function bigOutputTail(total = 111_106): string {
      const filler = "#".repeat(Math.max(0, total - TAIL_REPORT.length - 1));
      return `${filler}\n${TAIL_REPORT}`;
    }

    /** 从任务书正文取出 `- diffSummary: ` 后的 JSON 并解析回对象。 */
    function echoFromBrief(brief: string): Record<string, unknown> {
      const line = brief
        .split("\n")
        .find((l) => l.startsWith("- diffSummary: "));
      expect(line).toBeDefined();
      return JSON.parse(
        (line as string).slice("- diffSummary: ".length),
      ) as Record<string, unknown>;
    }

    it("超长 outputTail 保尾截断:末尾逐字保留、其余键原样、回显体积有界", async () => {
      const outputTail = bigOutputTail();
      const { parent, child } = await seedParentChild({
        childDiffSummary: {
          summary: "子任务完成",
          outputTail,
          tests: ["a"],
        },
      });

      await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      const brief = (await resumeTasksFor(parent.id))[0].brief ?? "";

      // 回显体积有界:111K outputTail 不再整体进任务书。
      expect(brief.length).toBeLessThan(6_000);

      const echo = echoFromBrief(brief);
      const tail = echo.outputTail;
      expect(typeof tail).toBe("string");
      expect((tail as string).length).toBeLessThanOrEqual(
        ECHO_LIMIT + NOTICE_OVERHEAD,
      );
      // 保尾:末尾 N 字符逐字保留(防 slice(0,N) 的唯一闸门)。
      expect((tail as string).endsWith(TAIL_REPORT)).toBe(true);
      // R1:其余键原样保留(summary / tests 等 L2 依据)。
      expect(echo.summary).toBe("子任务完成");
      expect(echo.tests).toEqual(["a"]);
    });

    it("保尾方向必测:输出末尾的五段汇报在回显中可见(提交/测试/Token/汇报/遗留)", async () => {
      const { parent, child } = await seedParentChild({
        childDiffSummary: { outputTail: bigOutputTail() },
      });

      await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      const brief = (await resumeTasksFor(parent.id))[0].brief ?? "";
      const tail = echoFromBrief(brief).outputTail as string;

      expect(tail).toContain("提交: 0123456789abcdef0123456789abcdef01234567");
      expect(tail).toContain("测试: 12 passed / 0 failed");
      expect(tail).toContain("Token: 123456");
      expect(tail).toContain("汇报: 已限制 diffSummary 回显体积");
      expect(tail).toContain("遗留: 无");
    });

    it("截断提示含准确省略字符数与明细 API 取回路径(禁止静默截断)", async () => {
      const outputTail = bigOutputTail();
      const { parent, child } = await seedParentChild({
        childDiffSummary: { outputTail },
      });

      await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      const brief = (await resumeTasksFor(parent.id))[0].brief ?? "";
      const tail = echoFromBrief(brief).outputTail as string;

      expect(tail).toContain(`前 ${outputTail.length - ECHO_LIMIT} 字符省略`);
      expect(tail).toContain(
        `GET /api/groups/${parent.groupId}/tasks/${child.id}/output?detail=1`,
      );
    });

    it("未超上限的 outputTail 逐字不变(小任务零行为变化)", async () => {
      const diffSummary = {
        summary: "子任务完成",
        outputTail: "line-1\nline-2\nline-3",
        tests: ["a", "b"],
      };
      // 与旧版 JSON.stringify 完全一致。
      expect(
        buildDiffSummaryEcho({
          id: childEchoTaskId,
          groupId: "g-echo",
          diffSummary,
        }),
      ).toBe(JSON.stringify(diffSummary));

      const { parent, child } = await seedParentChild({
        childDiffSummary: diffSummary,
      });
      // jsonb 不保留键序,期望值取库内实际读回的对象来比。
      const stored = await findTask(child.id);
      const expected = JSON.stringify(stored.diffSummary);
      expect(buildDiffSummaryEcho(stored)).toBe(expected);

      await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      const brief = (await resumeTasksFor(parent.id))[0].brief ?? "";
      // 任务书正文里出现的仍是完整 JSON,不含省略提示。
      expect(brief).toContain(`- diffSummary: ${expected}`);
      expect(brief).not.toContain("字符省略");
    });

    it("outputTail 缺失 / 非字符串 / diffSummary 为 null 时不报错,行为与旧版一致", () => {
      // diffSummary 为 null → 「无」。
      expect(
        buildDiffSummaryEcho({
          id: childEchoTaskId,
          groupId: "g-echo",
          diffSummary: null,
        }),
      ).toBe("无");
      // outputTail 非字符串 → 不截断,原样 stringify。
      const nonString = { summary: "x", outputTail: 12345 };
      expect(
        buildDiffSummaryEcho({
          id: childEchoTaskId,
          groupId: "g-echo",
          diffSummary: nonString,
        }),
      ).toBe(JSON.stringify(nonString));
      // outputTail 缺失 → 不截断,原样 stringify。
      const missing = { summary: "x" };
      expect(
        buildDiffSummaryEcho({
          id: childEchoTaskId,
          groupId: "g-echo",
          diffSummary: missing,
        }),
      ).toBe(JSON.stringify(missing));
    });

    it("只改任务书文本:DB 中 diff_summary 本体(含完整 outputTail)不受影响", async () => {
      const outputTail = bigOutputTail();
      const { parent, child } = await seedParentChild({
        childDiffSummary: { summary: "子任务完成", outputTail },
      });

      await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      // 任务书已生成(回显被截断)。
      expect((await resumeTasksFor(parent.id))[0].brief).toContain("字符省略");

      const after = await findTask(child.id);
      const stored = after.diffSummary as Record<string, unknown>;
      expect(stored.outputTail).toBe(outputTail);
      expect(stored.summary).toBe("子任务完成");
    });
  });

  describe.sequential("consumePendingCompletionEvents (事件消费 → 续跑任务)", () => {
    it("子任务终态事件被消费 → 创建续跑任务并把事件置 delivered", async () => {
      const { coordinator, parent, child } = await seedParentChild({});
      await insertPendingCompletionEvent(child, coordinator.id);
      const created = await consumePendingCompletionEvents(runtimeDb);
      expect(created).toBe(1);
      expect(await resumeTasksFor(parent.id)).toHaveLength(1);
      expect(await countPendingEvents()).toBe(0);
    });

    it("重复消费不重复创建(事件已 delivered + R3 双保险)", async () => {
      const { coordinator, parent, child } = await seedParentChild({});
      await insertPendingCompletionEvent(child, coordinator.id);
      expect(await consumePendingCompletionEvents(runtimeDb)).toBe(1);
      expect(await consumePendingCompletionEvents(runtimeDb)).toBe(0);
      expect(await resumeTasksFor(parent.id)).toHaveLength(1);
    });
  });

  describe.sequential("完成事件状态机缺口(specs/completion-events-never-reach-terminal-state.md R1/R2)", () => {
    async function eventFor(taskId: string) {
      const rows = await testDb
        .select()
        .from(taskCompletionEventTable)
        .where(eq(taskCompletionEventTable.taskId, taskId));
      return rows[0];
    }

    it("永久 skip 1:事件属续跑任务自身(R4)→ 事件置 dead 且 lastError 写明 R4 防环", async () => {
      const { parent } = await seedParentChild({});
      const resume = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: parent.executorParticipantId,
        status: "done",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        diffSummary: { platform: { resumeOf: parent.id } },
      });
      await insertPendingCompletionEvent(resume, parent.executorParticipantId);
      expect(await consumePendingCompletionEvents(runtimeDb)).toBe(0);
      const event = await eventFor(resume.id);
      expect(event?.state).toBe("dead");
      expect(event?.lastError).toContain("R4");
      // 没有产生第二条续跑(防环)。
      expect(await resumeTasksFor(parent.id)).toHaveLength(1);
    });

    // 本用例原先断言「无父任务 → 事件置 dead」,那正是
    // specs/resume-consumer-kills-reviewer-inbox-events.md 记录的缺陷:顶层
    // 任务(检视者派给协调者的 detached 任务)的完成事件属于收件人的 inbox,
    // 被本消费者在 5 秒内判死后,检视者的 L3 请求既列不出也认领不了。
    // 按新契约重写:本消费者不再触碰这类事件。
    it("无父任务的顶层事件不归本消费者处置 → 保持 pending,不判 dead", async () => {
      const { group, coordinator } = await seedParentChild({});
      // 顶层任务(无 parentTaskId)首次终态同样产生 pending 完成事件;
      // 本场景只为它落事件(不触碰 child 的事件)。
      const orphan = await insertTask({
        groupId: group.id,
        executorParticipantId: coordinator.id,
        status: "done",
      });
      await insertPendingCompletionEvent(orphan, coordinator.id);
      expect(await consumePendingCompletionEvents(runtimeDb)).toBe(0);
      const deads = await testDb
        .select()
        .from(taskCompletionEventTable)
        .where(eq(taskCompletionEventTable.state, "dead"));
      expect(deads).toHaveLength(0);
      const event = await eventFor(orphan.id);
      expect(event?.state).toBe("pending");
      expect(event?.lastError).toBeNull();
      expect(event?.attempts).toBe(0);
    });

    it("顶层事件多轮扫描后仍可被收件人 claim → ack 到 delivered", async () => {
      const { group, coordinator } = await seedParentChild({});
      const top = await insertTask({
        groupId: group.id,
        executorParticipantId: coordinator.id,
        status: "done",
      });
      // 收件人 = 协调者本人(顶层任务的完成事件默认回落下发者)。
      await testDb.insert(taskCompletionEventTable).values({
        taskId: top.id,
        groupId: top.groupId,
        dispatcherParticipantId: coordinator.id,
        recipientParticipantId: coordinator.id,
        state: "pending",
      });

      for (let i = 0; i < 3; i++) {
        expect(await consumePendingCompletionEvents(runtimeDb)).toBe(0);
      }
      expect((await eventFor(top.id))?.state).toBe("pending");

      const app = createTestApp();
      const eventId = (await eventFor(top.id))?.id as string;
      const base = `/api/participants/${coordinator.id}/task-completion-events`;
      const claimRes = await app.request(`${base}/${eventId}/claim`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": coordinator.id,
        },
        body: JSON.stringify({ consumerId: "reviewer-test", leaseMs: 60_000 }),
      });
      expect(claimRes.status).toBe(200);
      const { leaseToken } = (await claimRes.json()) as { leaseToken: string };

      const ackRes = await app.request(`${base}/${eventId}/ack`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": coordinator.id,
        },
        body: JSON.stringify({ leaseToken }),
      });
      expect(ackRes.status).toBe(200);
      // 读落库的最终记录,不停在响应码。
      expect((await eventFor(top.id))?.state).toBe("delivered");
    });

    it("永久 skip 3:父任务记录查不到 → 函数级判定为永久 skip(reason 非 null)", async () => {
      // parent_task_id 有自引用 FK,数据库层造不出悬空父;该分支按函数级
      // 契约验证(消费循环里事件任务本身必存在,父缺失即永久无续跑对象)。
      const { parent, child } = await seedParentChild({});
      const childRow = await findTask(child.id);
      expect(childRow).toBeTruthy();
      const orphaned = {
        ...childRow,
        parentTaskId: crypto.randomUUID(),
      } as typeof taskTable.$inferSelect;
      const result = await maybeCreateCoordinatorResumeTask(
        runtimeDb,
        orphaned,
      );
      expect(result).toEqual({
        kind: "skipped",
        permanence: "permanent",
        reason: expect.stringContaining("不存在"),
      });
      expect(await resumeTasksFor(parent.id)).toHaveLength(0);
    });

    it("永久 skip 4:父任务已终态 → 事件置 dead 且 lastError 写明父任务终态", async () => {
      const ctx = await seedParentChild({ parentStatus: "done" });
      await insertPendingCompletionEvent(ctx.child, ctx.coordinator.id);
      expect(await consumePendingCompletionEvents(runtimeDb)).toBe(0);
      const event = await eventFor(ctx.child.id);
      expect(event?.state).toBe("dead");
      expect(event?.lastError).toContain("终态");
    });

    it("暂时 skip 1:父协调进程仍存活 → 事件保持 pending(回归)", async () => {
      const ctx = await seedParentChild({ parentPid: process.pid });
      await insertPendingCompletionEvent(ctx.child, ctx.coordinator.id);
      expect(await consumePendingCompletionEvents(runtimeDb)).toBe(0);
      const event = await eventFor(ctx.child.id);
      expect(event?.state).toBe("pending");
      expect(event?.lastError).toBeNull();
      expect(await resumeTasksFor(ctx.parent.id)).toHaveLength(0);
    });

    it("暂时 skip 2:已存在非终态续跑(R3)→ 事件保持 pending(回归)", async () => {
      const { parent, child } = await seedParentChild({});
      // 先创建一条续跑任务(queued,非终态)。
      await maybeCreateCoordinatorResumeTask(runtimeDb, child);
      expect(await resumeTasksFor(parent.id)).toHaveLength(1);
      await insertPendingCompletionEvent(child, parent.executorParticipantId);
      expect(await consumePendingCompletionEvents(runtimeDb)).toBe(0);
      const event = await eventFor(child.id);
      expect(event?.state).toBe("pending");
      expect(event?.lastError).toBeNull();
      // 未重复创建。
      expect(await resumeTasksFor(parent.id)).toHaveLength(1);
    });

    it("暂时 skip 3:父执行方当前不是协调者 → 事件保持 pending(回归,§3.2)", async () => {
      const ctx = await seedParentChild({});
      // 把父任务执行方改成非 coordinator 角色成员(executor 本人);角色运行期
      // 可变,恢复 coordinator 后该事件下轮重试 —— 保守保留 pending。
      await testDb
        .update(taskTable)
        .set({ executorParticipantId: ctx.child.executorParticipantId })
        .where(eq(taskTable.id, ctx.parent.id));
      await insertPendingCompletionEvent(ctx.child, ctx.coordinator.id);
      expect(await consumePendingCompletionEvents(runtimeDb)).toBe(0);
      const event = await eventFor(ctx.child.id);
      expect(event?.state).toBe("pending");
      expect(event?.lastError).toBeNull();
      expect(await resumeTasksFor(ctx.parent.id)).toHaveLength(0);
    });

    it("正常路径:成功创建续跑 → 事件仍置 delivered(回归)", async () => {
      const { coordinator, child } = await seedParentChild({});
      await insertPendingCompletionEvent(child, coordinator.id);
      expect(await consumePendingCompletionEvents(runtimeDb)).toBe(1);
      const event = await eventFor(child.id);
      expect(event?.state).toBe("delivered");
      expect(event?.lastError).toBeNull();
    });

    it("一轮消费后:续跑域的永久类置 dead,暂时类与顶层事件保持 pending", async () => {
      // 混合四个场景:
      //  a) 续跑任务自身事件(R4,永久 → dead)
      //  b) 顶层无父任务事件(不归本消费者处置 → 保持 pending,
      //     见 specs/resume-consumer-kills-reviewer-inbox-events.md)
      //  c) 父已终态(永久 → dead)
      //  d) 父进程存活(暂时 → 保持 pending)
      const a = await seedParentChild({});
      const resumeA = await insertTask({
        groupId: a.parent.groupId,
        executorParticipantId: a.parent.executorParticipantId,
        status: "done",
        parentTaskId: a.parent.id,
        dispatcherParticipantId: a.parent.executorParticipantId,
        diffSummary: { platform: { resumeOf: a.parent.id } },
      });
      await insertPendingCompletionEvent(
        resumeA,
        a.parent.executorParticipantId,
      );

      const b = await seedParentChild({});
      const orphan = await insertTask({
        groupId: b.group.id,
        executorParticipantId: b.coordinator.id,
        status: "done",
      });
      await insertPendingCompletionEvent(orphan, b.coordinator.id);

      const c = await seedParentChild({ parentStatus: "done" });
      await insertPendingCompletionEvent(c.child, c.coordinator.id);

      const d = await seedParentChild({ parentPid: process.pid });
      await insertPendingCompletionEvent(d.child, d.coordinator.id);

      expect(await countPendingEvents()).toBe(4);
      expect(await consumePendingCompletionEvents(runtimeDb)).toBe(0);
      expect(await countPendingEvents()).toBe(2); // b(顶层)+ d(暂时)
      const deads = await testDb
        .select()
        .from(taskCompletionEventTable)
        .where(eq(taskCompletionEventTable.state, "dead"));
      expect(deads).toHaveLength(2);
      expect(deads.map((e) => e.taskId).sort()).toEqual(
        [resumeA.id, c.child.id].sort(),
      );
      for (const dead of deads) {
        expect(dead.lastError).toBeTruthy();
      }
      const pending = await testDb
        .select()
        .from(taskCompletionEventTable)
        .where(eq(taskCompletionEventTable.state, "pending"));
      expect(pending.map((e) => e.taskId).sort()).toEqual(
        [orphan.id, d.child.id].sort(),
      );
    });

    it("永久置 dead 不干扰 hasPendingResumeEvent 豁免(specs §3.3 第一点)", async () => {
      // 父任务下仅有「续跑任务自身」的事件:置 dead 前后豁免判定必须一致
      // (判定本就把续跑任务自身事件排除,dead 只是让这一排除显式化)。
      const { parent } = await seedParentChild({});
      const resume = await insertTask({
        groupId: parent.groupId,
        executorParticipantId: parent.executorParticipantId,
        status: "done",
        parentTaskId: parent.id,
        dispatcherParticipantId: parent.executorParticipantId,
        diffSummary: { platform: { resumeOf: parent.id } },
      });
      await insertPendingCompletionEvent(resume, parent.executorParticipantId);
      expect(await hasPendingResumeEvent(runtimeDb, parent.id)).toBe(false);
      // 消费 → 事件置 dead。
      expect(await consumePendingCompletionEvents(runtimeDb)).toBe(0);
      expect((await eventFor(resume.id))?.state).toBe("dead");
      expect(await hasPendingResumeEvent(runtimeDb, parent.id)).toBe(false);
    });
  });

  describe.sequential("R5:协调者任务书强制「派发成功后立即退出本轮、不得轮询子任务终态」(必测)", () => {
    it("协调者任务书强制退出本轮且明确禁止轮询子任务终态", async () => {
      // 这里直接锁定 coordinator 分支的任务书模板源码,避免该纯模板验收
      // 启动真实 CLI,与端到端测试共享临时 git 仓库造成竞态。
      const source = readFileSync(
        path.resolve(import.meta.dirname, "../src/lib/executor-task/queue.ts"),
        "utf8",
      );
      expect(source).toContain("### 派发成功后立即退出本轮（强制）");
      expect(source).toContain(
        "严禁在派发成功后用 `coagenthub_get_task` 轮询自身任务或子任务状态来等待其终态",
      );
      expect(source).toContain("coagenthub-coordinator` skill");
    }, 30_000);
  });

  describe.sequential("端到端:协调者派子任务后退出 → 子任务完成 → 协调者被重新拉起 → 结案", () => {
    const app = createTestApp();

    async function registerParticipant(name: string) {
      const res = await app.request("/api/participants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.status === 409) {
        const list = (await (
          await app.request("/api/participants")
        ).json()) as {
          id: string;
          name: string;
        }[];
        const existing = list.find((p) => p.name === name);
        if (existing) return { id: existing.id };
      }
      expect(res.status).toBe(200);
      return (await res.json()) as { id: string };
    }

    async function bindExecutorKey(id: string, key: string) {
      await testDb
        .update(participantTable)
        .set({ executorKey: null })
        .where(eq(participantTable.executorKey, key));
      await testDb
        .update(participantTable)
        .set({ executorKey: key })
        .where(eq(participantTable.id, id));
    }

    async function createGroup(creatorId: string, title: string) {
      const res = await app.request("/api/groups", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": creatorId,
        },
        body: JSON.stringify({ title }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { id: string };
    }

    async function addMember(
      actorId: string,
      groupId: string,
      participantId: string,
      roles: string[],
    ) {
      const res = await app.request(`/api/groups/${groupId}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": actorId,
        },
        body: JSON.stringify({ participantId, roles }),
      });
      expect(res.status).toBe(200);
    }

    async function postMessage(
      senderId: string,
      groupId: string,
      body: Record<string, unknown>,
    ) {
      const res = await app.request(`/api/groups/${groupId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Participant-Id": senderId,
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { id: string };
    }

    async function listTasks(groupId: string) {
      const res = await app.request(`/api/groups/${groupId}/tasks`);
      expect(res.status).toBe(200);
      return (await res.json()) as Array<{
        id: string;
        messageId: string;
        status: string;
        supersedesTaskId: string | null;
      }>;
    }

    async function waitForTask(
      groupId: string,
      messageId: string,
      status: string,
      timeoutMs = 15_000,
    ) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const tasks = await listTasks(groupId);
        const hit = tasks.find((t) => t.messageId === messageId);
        if (hit && hit.status === status) return hit;
        if (Date.now() > deadline) {
          throw new Error(
            `task(${messageId}) 未在 ${timeoutMs}ms 内达到 ${status}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    async function waitForResumeTask(
      parentId: string,
      status: string,
      timeoutMs = 15_000,
    ) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const rows = await testDb
          .select()
          .from(taskTable)
          .where(and(eq(taskTable.parentTaskId, parentId)));
        const hit = rows.find((r) => r.id !== parentId && r.status === status);
        if (hit) return hit;
        if (Date.now() > deadline) {
          throw new Error(
            `续跑任务(parent=${parentId}) 未在 ${timeoutMs}ms 内达到 ${status}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    it("下发需求票 → 协调者派子任务后退出 → 子任务完成 → 协调者被重新拉起 → PATCH 父任务结案", async () => {
      const coordinator = await registerParticipant(
        `coord-e2e-${crypto.randomUUID()}`,
      );
      const executor = await registerParticipant(
        `exec-e2e-${crypto.randomUUID()}`,
      );
      await bindExecutorKey(coordinator.id, "codebuddy");
      await bindExecutorKey(executor.id, "executor");
      const group = await createGroup(coordinator.id, "端到端续跑");
      await addMember(coordinator.id, group.id, executor.id, ["executor"]);

      // 1) 协调者给自己派发一张「需求票」→ 父协调任务(coordinator 角色 → detached)。
      const parentMsg = await postMessage(coordinator.id, group.id, {
        body: "需求票:实现 X",
        audience: "participant",
        audienceRef: coordinator.id,
      });
      const parentTask = await waitForTask(group.id, parentMsg.id, "running");
      // 协调者进程(假 bin)已退出 → 父任务 detached 保持 running(不判失败)。
      const parentRow = await findTask(parentTask.id);
      expect(parentRow.status).toBe("running");
      // 模拟协调者退出:把 executorPid 指向一个已退出进程(真实场景假 bin 已退出)。
      const dead = deadPid();
      await testDb
        .update(taskTable)
        .set({ executorPid: dead })
        .where(eq(taskTable.id, parentTask.id));

      // 2) 协调者派发子任务给执行器。
      const childMsg = await postMessage(coordinator.id, group.id, {
        body: "执行 X",
        audience: "participant",
        audienceRef: executor.id,
      });
      const childTask = await waitForTask(group.id, childMsg.id, "done");

      // 3) 平台消费完成事件 → 创建续跑任务并被现有队列拉起(协调者被重新拉起)。
      const created = await consumePendingCompletionEvents(runtimeDb);
      expect(created).toBe(1);
      const resume = await waitForResumeTask(parentTask.id, "running");
      expect(resume.executorParticipantId).toBe(coordinator.id);
      expect(resume.brief).toContain(parentTask.id);
      expect(resume.brief).toContain(childTask.id);

      // 4) 协调者在续跑任务中 PATCH 父任务结案。
      const patchRes = await app.request(
        `/api/groups/${group.id}/tasks/${parentTask.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinator.id,
          },
          body: JSON.stringify({
            status: "done",
            diffSummary: {
              summary: "L2 通过",
              claimAdjudication: {
                [childTask.id]: {
                  accepted: true,
                  reason:
                    "fake executor 仅验证续跑链路并回报结果;不产生真实提交。",
                },
              },
            },
          }),
        },
      );
      const patchBody = await patchRes.text();
      expect(patchRes.status, patchBody).toBe(200);
      const closed = await findTask(parentTask.id);
      expect(closed.status).toBe("done");
    }, 60_000);

    it("L2 重发路径:协调者未传 supersedesTaskId 时平台根据续跑上下文自动补齐", async () => {
      const coordinator = await registerParticipant(
        `coord-auto-${crypto.randomUUID()}`,
      );
      const executor = await registerParticipant(
        `exec-auto-${crypto.randomUUID()}`,
      );
      await bindExecutorKey(coordinator.id, "codebuddy");
      await bindExecutorKey(executor.id, "executor");
      const group = await createGroup(coordinator.id, "自动补链测试");
      await addMember(coordinator.id, group.id, executor.id, ["executor"]);

      // 1) 协调者父任务 running。
      const parentMsg = await postMessage(coordinator.id, group.id, {
        body: "需求票:实现 Y",
        audience: "participant",
        audienceRef: coordinator.id,
      });
      const parentTask = await waitForTask(group.id, parentMsg.id, "running");
      const dead = deadPid();
      await testDb
        .update(taskTable)
        .set({ executorPid: dead })
        .where(eq(taskTable.id, parentTask.id));

      // 2) 子任务失败 → 平台创建续跑任务。
      const childMsg = await postMessage(coordinator.id, group.id, {
        body: "执行 Y",
        audience: "participant",
        audienceRef: executor.id,
      });
      const childTask = await waitForTask(group.id, childMsg.id, "done");
      expect(await consumePendingCompletionEvents(runtimeDb)).toBe(1);

      // 3) 协调者发重试消息,未带 supersedesTaskId → 平台自动补齐。
      const retryMsg = await postMessage(coordinator.id, group.id, {
        body: "重试执行 Y",
        audience: "participant",
        audienceRef: executor.id,
      });
      const retryTask = await waitForTask(group.id, retryMsg.id, "done");
      expect(retryTask.supersedesTaskId).toBe(childTask.id);
    }, 60_000);

    it("L2 重发路径:显式传 supersedesTaskId 时保持兼容,不被覆盖", async () => {
      const coordinator = await registerParticipant(
        `coord-explicit-${crypto.randomUUID()}`,
      );
      const executor = await registerParticipant(
        `exec-explicit-${crypto.randomUUID()}`,
      );
      await bindExecutorKey(coordinator.id, "codebuddy");
      await bindExecutorKey(executor.id, "executor");
      const group = await createGroup(coordinator.id, "显式传值测试");
      await addMember(coordinator.id, group.id, executor.id, ["executor"]);

      const parentMsg = await postMessage(coordinator.id, group.id, {
        body: "需求票:实现 Z",
        audience: "participant",
        audienceRef: coordinator.id,
      });
      const parentTask = await waitForTask(group.id, parentMsg.id, "running");
      await testDb
        .update(taskTable)
        .set({ executorPid: deadPid() })
        .where(eq(taskTable.id, parentTask.id));

      const childMsg = await postMessage(coordinator.id, group.id, {
        body: "执行 Z",
        audience: "participant",
        audienceRef: executor.id,
      });
      const childTask = await waitForTask(group.id, childMsg.id, "done");
      expect(await consumePendingCompletionEvents(runtimeDb)).toBe(1);

      // 显式传一个不同的(但有效的)task id 作为 supersedesTaskId。
      const dummyTask = await insertTask({
        groupId: group.id,
        executorParticipantId: executor.id,
        status: "failed",
        parentTaskId: parentTask.id,
        dispatcherParticipantId: coordinator.id,
      });
      const retryMsg = await postMessage(coordinator.id, group.id, {
        body: "重试执行 Z",
        audience: "participant",
        audienceRef: executor.id,
        supersedesTaskId: dummyTask.id,
      });
      const retryTask = await waitForTask(group.id, retryMsg.id, "done");
      expect(retryTask.supersedesTaskId).toBe(dummyTask.id);
      expect(retryTask.supersedesTaskId).not.toBe(childTask.id);
    }, 60_000);

    it("首次派发(无续跑上下文)不自动补 supersedesTaskId", async () => {
      const coordinator = await registerParticipant(
        `coord-first-${crypto.randomUUID()}`,
      );
      const executor = await registerParticipant(
        `exec-first-${crypto.randomUUID()}`,
      );
      await bindExecutorKey(coordinator.id, "codebuddy");
      await bindExecutorKey(executor.id, "executor");
      const group = await createGroup(coordinator.id, "首次派发测试");
      await addMember(coordinator.id, group.id, executor.id, ["executor"]);

      // 父任务 running,但无子任务终态 → 无续跑上下文。
      const parentMsg = await postMessage(coordinator.id, group.id, {
        body: "需求票:首次派发",
        audience: "participant",
        audienceRef: coordinator.id,
      });
      const parentTask = await waitForTask(group.id, parentMsg.id, "running");
      await testDb
        .update(taskTable)
        .set({ executorPid: deadPid() })
        .where(eq(taskTable.id, parentTask.id));

      const childMsg = await postMessage(coordinator.id, group.id, {
        body: "首次执行",
        audience: "participant",
        audienceRef: executor.id,
      });
      const _childTask = await waitForTask(group.id, childMsg.id, "done");
      // 不消费完成事件,因此无续跑任务;再次派发应视为首次,不补链。
      const secondMsg = await postMessage(coordinator.id, group.id, {
        body: "第二次执行(非重试)",
        audience: "participant",
        audienceRef: executor.id,
      });
      const secondTask = await waitForTask(group.id, secondMsg.id, "done");
      expect(secondTask.supersedesTaskId).toBeNull();
    }, 60_000);

    it("协调者自派(目标=自己)不自动补 supersedesTaskId", async () => {
      const coordinator = await registerParticipant(
        `coord-self-${crypto.randomUUID()}`,
      );
      await bindExecutorKey(coordinator.id, "codebuddy");
      const group = await createGroup(coordinator.id, "自派测试");

      // 协调者给自己发消息 → 自派,不补链。
      const selfMsg = await postMessage(coordinator.id, group.id, {
        body: "协调者自派",
        audience: "participant",
        audienceRef: coordinator.id,
      });
      const selfTask = await waitForTask(group.id, selfMsg.id, "running");
      expect(selfTask.supersedesTaskId).toBeNull();
    }, 60_000);

    it("同 messageId 重复 POST 且省略 supersedesTaskId 时,自动推断后仍幂等返回同一任务(回归)", async () => {
      const coordinator = await registerParticipant(
        `coord-dup-${crypto.randomUUID()}`,
      );
      const executor = await registerParticipant(
        `exec-dup-${crypto.randomUUID()}`,
      );
      await bindExecutorKey(coordinator.id, "codebuddy");
      await bindExecutorKey(executor.id, "executor");
      const group = await createGroup(coordinator.id, "重复 POST 幂等测试");
      await addMember(coordinator.id, group.id, executor.id, ["executor"]);

      // 1) 父任务 running,进程已退出。
      const parentMsg = await postMessage(coordinator.id, group.id, {
        body: "需求票:实现 Dup",
        audience: "participant",
        audienceRef: coordinator.id,
      });
      const parentTask = await waitForTask(group.id, parentMsg.id, "running");
      await testDb
        .update(taskTable)
        .set({ executorPid: deadPid() })
        .where(eq(taskTable.id, parentTask.id));

      // 2) 子任务完成 → 平台创建续跑任务(写入 resumeForChild)。
      const childMsg = await postMessage(coordinator.id, group.id, {
        body: "执行 Dup",
        audience: "participant",
        audienceRef: executor.id,
      });
      const childTask = await waitForTask(group.id, childMsg.id, "done");
      expect(await consumePendingCompletionEvents(runtimeDb)).toBe(1);

      // 3) 协调者直接 POST /tasks(非消息路径),省略 supersedesTaskId。
      // 直接插入消息行(不走消息派发路径,避免消息端自动建 task 抢占 messageId)。
      const [retryMsg] = await testDb
        .insert(groupMessageTable)
        .values({
          groupId: group.id,
          senderId: coordinator.id,
          body: "重试执行 Dup(POST 路径)",
          audience: "participant",
          audienceRef: executor.id,
        })
        .returning();

      const postTask = (messageId: string) =>
        app.request(`/api/groups/${group.id}/tasks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Participant-Id": coordinator.id,
          },
          body: JSON.stringify({
            messageId,
            executorParticipantId: executor.id,
          }),
        });

      // 首次 POST:自动推断 supersedesTaskId = childTask.id。
      const res1 = await postTask(retryMsg.id);
      expect(res1.status).toBe(200);
      const task1 = (await res1.json()) as {
        id: string;
        supersedesTaskId: string | null;
      };
      expect(task1.supersedesTaskId).toBe(childTask.id);

      // 重复 POST:必须幂等返回同一任务,不得 409。
      const res2 = await postTask(retryMsg.id);
      expect(res2.status).toBe(200);
      const task2 = (await res2.json()) as {
        id: string;
        supersedesTaskId: string | null;
      };
      expect(task2.id).toBe(task1.id);
      expect(task2.supersedesTaskId).toBe(childTask.id);
    }, 60_000);

    it("跨父任务隔离:inferSupersedesTaskId 只取最新父任务的续跑上下文,不串链", async () => {
      const coordinator = await registerParticipant(
        `coord-cross-${crypto.randomUUID()}`,
      );
      const executor = await registerParticipant(
        `exec-cross-${crypto.randomUUID()}`,
      );
      await bindExecutorKey(coordinator.id, "codebuddy");
      await bindExecutorKey(executor.id, "executor");
      const group = await createGroup(coordinator.id, "跨父任务隔离测试");
      await addMember(coordinator.id, group.id, executor.id, ["executor"]);

      // 父任务 A:running,进程已退出。
      const parentA = await insertTask({
        groupId: group.id,
        executorParticipantId: coordinator.id,
        status: "running",
        executorPid: deadPid(),
      });
      // 子任务 A1 完成。
      const childA1 = await insertTask({
        groupId: group.id,
        executorParticipantId: executor.id,
        status: "done",
        parentTaskId: parentA.id,
        dispatcherParticipantId: coordinator.id,
      });
      // 为 A 创建续跑任务( resumeForChild = childA1 )。
      await insertTask({
        groupId: group.id,
        executorParticipantId: coordinator.id,
        status: "queued",
        parentTaskId: parentA.id,
        dispatcherParticipantId: coordinator.id,
        diffSummary: {
          platform: { resumeOf: parentA.id, resumeForChild: childA1.id },
        },
      });

      // 父任务 B:running,进程已退出,且更新时刻更新(成为"最新"父任务)。
      const parentB = await insertTask({
        groupId: group.id,
        executorParticipantId: coordinator.id,
        status: "running",
        executorPid: deadPid(),
      });
      // 让 B 的 updatedAt 更新,确保它是"最新"的 running 父任务。
      await testDb
        .update(taskTable)
        .set({ updatedAt: new Date() })
        .where(eq(taskTable.id, parentB.id));
      // 子任务 B1 完成。
      const childB1 = await insertTask({
        groupId: group.id,
        executorParticipantId: executor.id,
        status: "done",
        parentTaskId: parentB.id,
        dispatcherParticipantId: coordinator.id,
      });
      // 为 B 创建续跑任务( resumeForChild = childB1 )。
      await insertTask({
        groupId: group.id,
        executorParticipantId: coordinator.id,
        status: "queued",
        parentTaskId: parentB.id,
        dispatcherParticipantId: coordinator.id,
        diffSummary: {
          platform: { resumeOf: parentB.id, resumeForChild: childB1.id },
        },
      });

      // inferSupersedesTaskId 应返回 B1(最新父任务 B 的续跑上下文),而不是 A1。
      const { inferSupersedesTaskId: infer } = await import(
        "../src/lib/executor-task"
      );
      const inferred = await infer(
        runtimeDb,
        group.id,
        coordinator.id,
        executor.id,
      );
      expect(inferred).toBe(childB1.id);
      expect(inferred).not.toBe(childA1.id);
    }, 30_000);
  });
});
