import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";
import { testDb } from "./db";

/**
 * 协调任务落终态的完整性校验(R1-R5,specs/coordination-close-integrity.md)。
 *
 * 校验点在 routes/group/tasks.ts 的 PATCH 终态处,仅对「协调任务 + 目标状态 done」
 * 生效;通过复用 lib/detached-task-liveness 的 isDetachedTask() 判定协调任务。
 * 覆盖 spec 验收标准逐条用例 + 普通任务/failed 的回归 + 形状校验不变。
 */

type Task = {
  id: string;
  status: string;
  executorParticipantId: string;
  dispatchKind: "requirement" | "fix" | null;
  diffSummary: unknown;
};

describe("协调任务落终态完整性校验 (R1-R5)", () => {
  const app = createTestApp();

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

  async function postMessage(actorId: string, groupId: string, body: string) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": actorId,
      },
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  async function createTask(
    coordinatorId: string,
    groupId: string,
    messageId: string,
    executorParticipantId: string,
    dispatchKind?: "requirement" | "fix",
  ) {
    const res = await app.request(`/api/groups/${groupId}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinatorId,
      },
      body: JSON.stringify({
        messageId,
        executorParticipantId,
        ...(dispatchKind !== undefined ? { dispatchKind } : {}),
      }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Task;
  }

  async function patchTask(
    participantId: string,
    groupId: string,
    taskId: string,
    body: Record<string, unknown>,
  ) {
    return app.request(`/api/groups/${groupId}/tasks/${taskId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify(body),
    });
  }

  /** 直接插一条指向 parentTaskId 的执行子任务,使 R1 放行。默认终态(done):
   *  close-requires-terminal-children R1 后,协调任务落 done 要求全部子任务已终态,
   *  非终态子任务会被守卫 400 拦截;需要非终态子任务时显式传 status。 */
  async function addChild(
    groupId: string,
    parentTaskId: string,
    executorParticipantId: string,
    status: "queued" | "running" | "done" | "failed" | "cancelled" = "done",
  ) {
    const childId = uuidv4();
    await testDb.insert(taskTable).values({
      id: childId,
      groupId,
      parentTaskId,
      messageId: uuidv4(),
      executorParticipantId,
      status,
    });
    return childId;
  }

  async function addChildWithWindow(
    groupId: string,
    parentTaskId: string,
    executorParticipantId: string,
    startedAt: string,
    status: "running" | "done" = "done",
    updatedAt?: Date,
  ) {
    const childId = uuidv4();
    await testDb.insert(taskTable).values({
      id: childId,
      groupId,
      parentTaskId,
      messageId: uuidv4(),
      executorParticipantId,
      status,
      attempts: [{ n: 1, startedAt, status }],
      ...(updatedAt ? { updatedAt } : {}),
    });
    return childId;
  }

  function createGitRepo() {
    const repoDir = mkdtempSync(path.join(tmpdir(), "coagenthub-close-git-"));
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@coagenthub.local"], {
      cwd: repoDir,
    });
    execFileSync("git", ["config", "user.name", "coagenthub-test"], {
      cwd: repoDir,
    });
    const oldDate = new Date(Date.now() - 60_000).toISOString();
    execFileSync("git", ["commit", "--allow-empty", "-qm", "seed"], {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: oldDate,
        GIT_COMMITTER_DATE: oldDate,
      },
    });
    return repoDir;
  }

  function commitWithDate(repoDir: string, message: string, date: string) {
    execFileSync("git", ["commit", "--allow-empty", "-qm", message], {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    });
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
  }

  function commitDate(repoDir: string) {
    return execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
  }

  async function setTaskWindow(taskId: string, startedAt: string) {
    await testDb
      .update(taskTable)
      .set({
        attempts: [{ n: 1, startedAt, status: "running" }],
      })
      .where(eq(taskTable.id, taskId));
  }

  async function withRepo<T>(repoDir: string, callback: () => Promise<T>) {
    const previous = process.env.COAGENTHUB_REPO_ROOT;
    process.env.COAGENTHUB_REPO_ROOT = repoDir;
    try {
      return await callback();
    } finally {
      if (previous === undefined) delete process.env.COAGENTHUB_REPO_ROOT;
      else process.env.COAGENTHUB_REPO_ROOT = previous;
      rmSync(repoDir, { recursive: true, force: true });
    }
  }

  function reviewRequest(taskId: string) {
    return {
      review_request: {
        type: "review_request",
        layer: 3,
        taskId,
        specRef: "specs/coordination-close-integrity.md",
        specHash: "449e4a1e",
        diffSummary: "测试交接载荷",
      },
    };
  }

  it("R1:协调任务零子任务 PATCH done → 400,且点明 L1 层未发生", async () => {
    const coordinator = await register("ci-coord-1");
    const group = await createGroup(coordinator.id, "ci-1");
    // 两方(无 reviewer)隔离 R2;detached 经 coordinator 角色判定。
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("L1 层未发生");
  });

  it("R1:带非空 noExecutionReason → 放行", async () => {
    const coordinator = await register("ci-coord-2");
    const group = await createGroup(coordinator.id, "ci-2");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: {
        noExecutionReason: "该需求判定无需改动,无需下发执行器",
      },
    });
    expect(res.status).toBe(200);
  });

  it("escape hatch:窗口内有提交 + 有理由 → 400,且包含哈希与窗口起点", async () => {
    const coordinator = await register("ci-coord-commit-window");
    const group = await createGroup(coordinator.id, "ci-commit-window");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const repoDir = createGitRepo();
    await withRepo(repoDir, async () => {
      // git 的 %cI 精度为秒,把窗口起点放在当前秒之前,避免刚创建的
      // 提交因毫秒精度比较被误判为 outside_window。
      const windowStartedAt = new Date(
        Math.floor(Date.now() / 1000) * 1000 - 1000,
      ).toISOString();
      await setTaskWindow(task.id, windowStartedAt);
      execFileSync("git", ["commit", "--allow-empty", "-qm", "window"], {
        cwd: repoDir,
      });
      const hash = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
        encoding: "utf8",
      }).trim();

      const res = await patchTask(coordinator.id, group.id, task.id, {
        status: "done",
        diffSummary: { noExecutionReason: "无需下发执行器" },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toContain(hash);
      expect(body.message).toContain(windowStartedAt);
    });
  });

  it("escape hatch:窗口内无提交 + 有理由 → 200", async () => {
    const coordinator = await register("ci-coord-no-commit-window");
    const group = await createGroup(coordinator.id, "ci-no-commit-window");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const repoDir = createGitRepo();
    await withRepo(repoDir, async () => {
      const windowStartedAt = new Date(
        Math.floor(Date.now() / 1000) * 1000 - 1000,
      ).toISOString();
      await setTaskWindow(task.id, windowStartedAt);

      const res = await patchTask(coordinator.id, group.id, task.id, {
        status: "done",
        diffSummary: { noExecutionReason: "确认无需改动" },
      });
      expect(res.status).toBe(200);
    });
  });

  it("escape hatch:非 git 目录 → 放行,不抛错", async () => {
    const coordinator = await register("ci-coord-no-git-window");
    const group = await createGroup(coordinator.id, "ci-no-git-window");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const nonGitDir = mkdtempSync(path.join(tmpdir(), "coagenthub-no-git-"));
    await withRepo(nonGitDir, async () => {
      const windowStartedAt = new Date(
        Math.floor(Date.now() / 1000) * 1000 - 1000,
      ).toISOString();
      await setTaskWindow(task.id, windowStartedAt);

      const res = await patchTask(coordinator.id, group.id, task.id, {
        status: "done",
        diffSummary: { noExecutionReason: "环境检查票,无需执行器" },
      });
      expect(res.status).toBe(200);
    });
  });

  it("R1:提交早于全部执行子任务窗口 → 400,列出提交时间与窗口", async () => {
    const coordinator = await register("ci-coord-child-window-before");
    const executor = await register("ci-exec-child-window-before");
    const group = await createGroup(coordinator.id, "ci-child-window-before");
    await addMember(coordinator.id, group.id, executor.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const repoDir = createGitRepo();
    await withRepo(repoDir, async () => {
      const commitDateValue = new Date(
        Math.floor((Date.now() - 30_000) / 1000) * 1000,
      ).toISOString();
      const parentStartedAt = new Date(
        Date.parse(commitDateValue) - 30_000,
      ).toISOString();
      await setTaskWindow(task.id, parentStartedAt);
      const hash = commitWithDate(repoDir, "before-child", commitDateValue);
      const actualCommitAt = commitDate(repoDir);
      const childStartedAt = new Date(
        Date.parse(actualCommitAt) + 10_000,
      ).toISOString();
      await addChildWithWindow(group.id, task.id, executor.id, childStartedAt);

      const res = await patchTask(coordinator.id, group.id, task.id, {
        status: "done",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toContain(hash);
      expect(body.message).toContain(actualCommitAt);
      expect(body.message).toContain(childStartedAt);
    });
  });

  it("R1:提交落在终态执行子任务窗口内 → 200", async () => {
    const coordinator = await register("ci-coord-child-window-running");
    const executor = await register("ci-exec-child-window-running");
    const group = await createGroup(coordinator.id, "ci-child-window-running");
    await addMember(coordinator.id, group.id, executor.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const repoDir = createGitRepo();
    await withRepo(repoDir, async () => {
      const commitDateValue = new Date(
        Math.floor((Date.now() - 10_000) / 1000) * 1000,
      ).toISOString();
      await setTaskWindow(
        task.id,
        new Date(Date.parse(commitDateValue) - 30_000).toISOString(),
      );
      const hash = commitWithDate(repoDir, "inside-child", commitDateValue);
      const actualCommitAt = commitDate(repoDir);
      await addChildWithWindow(
        group.id,
        task.id,
        executor.id,
        new Date(Date.parse(actualCommitAt) - 5_000).toISOString(),
      );

      const res = await patchTask(coordinator.id, group.id, task.id, {
        status: "done",
      });
      expect(res.status).toBe(200);
      expect(hash).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  it("R1:多个提交中只列出无法归属的提交", async () => {
    const coordinator = await register("ci-coord-child-window-multiple");
    const executor = await register("ci-exec-child-window-multiple");
    const group = await createGroup(coordinator.id, "ci-child-window-multiple");
    await addMember(coordinator.id, group.id, executor.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const repoDir = createGitRepo();
    await withRepo(repoDir, async () => {
      const base = Math.floor(Date.now() / 1000) * 1000;
      await setTaskWindow(task.id, new Date(base - 60_000).toISOString());
      const beforeHash = commitWithDate(
        repoDir,
        "before-child",
        new Date(base - 30_000).toISOString(),
      );
      const insideHash = commitWithDate(
        repoDir,
        "inside-child",
        new Date(base - 10_000).toISOString(),
      );
      await addChildWithWindow(
        group.id,
        task.id,
        executor.id,
        new Date(base - 20_000).toISOString(),
      );

      const res = await patchTask(coordinator.id, group.id, task.id, {
        status: "done",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toContain(beforeHash);
      expect(body.message).not.toContain(insideHash);
    });
  });

  it("R2b:合法 alreadySatisfied 指向真实既有提交 → 200 且可跳过归属", async () => {
    const coordinator = await register("ci-coord-already-satisfied");
    const group = await createGroup(coordinator.id, "ci-already-satisfied");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const repoDir = createGitRepo();
    await withRepo(repoDir, async () => {
      const commitDateValue = new Date(
        Math.floor((Date.now() - 10_000) / 1000) * 1000,
      ).toISOString();
      await setTaskWindow(
        task.id,
        new Date(Date.parse(commitDateValue) - 30_000).toISOString(),
      );
      const existingHash = commitWithDate(
        repoDir,
        "already-satisfied",
        commitDateValue,
      );
      const res = await patchTask(coordinator.id, group.id, task.id, {
        status: "done",
        diffSummary: {
          alreadySatisfied: {
            commits: [existingHash],
            verification: "上一轮实现已存在,相关测试已通过",
          },
        },
      });
      expect(res.status).toBe(200);
    });
  });

  it("R2b:缺 verification 的 alreadySatisfied → 400 且点明 claim 不合法", async () => {
    const coordinator = await register("ci-coord-already-invalid-zero-child");
    const group = await createGroup(
      coordinator.id,
      "ci-already-invalid-zero-child",
    );
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const repoDir = createGitRepo();
    await withRepo(repoDir, async () => {
      const commitDateValue = new Date(
        Math.floor((Date.now() - 10_000) / 1000) * 1000,
      ).toISOString();
      await setTaskWindow(
        task.id,
        new Date(Date.parse(commitDateValue) - 30_000).toISOString(),
      );
      const hash = commitWithDate(
        repoDir,
        "invalid-already-satisfied",
        commitDateValue,
      );
      const res = await patchTask(coordinator.id, group.id, task.id, {
        status: "done",
        diffSummary: { alreadySatisfied: { commits: [hash] } },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toContain("alreadySatisfied");
      expect(body.message).not.toContain("noExecutionReason");
    });
  });

  it("R2b:alreadySatisfied 不存在的提交 → 400 点明该 hash", async () => {
    const coordinator = await register("ci-coord-already-missing");
    const group = await createGroup(coordinator.id, "ci-already-missing");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const repoDir = createGitRepo();
    await withRepo(repoDir, async () => {
      const missingHash = "0123456789abcdef0123456789abcdef01234567";
      const res = await patchTask(coordinator.id, group.id, task.id, {
        status: "done",
        diffSummary: {
          alreadySatisfied: {
            commits: [missingHash],
            verification: "已验证",
          },
        },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toContain(missingHash);
    });
  });

  it("R2b:缺 verification 不跳过归属校验", async () => {
    const coordinator = await register("ci-coord-already-no-verification");
    const executor = await register("ci-exec-already-no-verification");
    const group = await createGroup(
      coordinator.id,
      "ci-already-no-verification",
    );
    await addMember(coordinator.id, group.id, executor.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const repoDir = createGitRepo();
    await withRepo(repoDir, async () => {
      const commitDateValue = new Date(
        Math.floor((Date.now() - 10_000) / 1000) * 1000,
      ).toISOString();
      await setTaskWindow(
        task.id,
        new Date(Date.parse(commitDateValue) - 30_000).toISOString(),
      );
      const hash = commitWithDate(
        repoDir,
        "missing-verification",
        commitDateValue,
      );
      const actualCommitAt = commitDate(repoDir);
      await addChildWithWindow(
        group.id,
        task.id,
        executor.id,
        new Date(Date.parse(actualCommitAt) + 10_000).toISOString(),
      );
      const res = await patchTask(coordinator.id, group.id, task.id, {
        status: "done",
        diffSummary: { alreadySatisfied: { commits: [hash] } },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toContain(hash);
    });
  });

  it("R1:noExecutionReason 空串/纯空白 → 仍 400", async () => {
    const coordinator = await register("ci-coord-3");
    const group = await createGroup(coordinator.id, "ci-3");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    for (const reason of ["", "   ", "\t\n"]) {
      const res = await patchTask(coordinator.id, group.id, task.id, {
        status: "done",
        diffSummary: { noExecutionReason: reason },
      });
      expect(res.status).toBe(400);
    }
  });

  it("R2:三方在场 + dispatchKind 非 fix + 无 review_request → 400", async () => {
    const coordinator = await register("ci-coord-4");
    const reviewer = await register("ci-reviewer-4");
    const execA = await register("ci-exec-4");
    const group = await createGroup(coordinator.id, "ci-4");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
      "requirement",
    );
    await addChild(group.id, task.id, execA.id); // R1 放行
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("review_request");
  });

  it("R2:三方在场 + dispatchKind='fix' + 无 review_request → 放行", async () => {
    const coordinator = await register("ci-coord-5");
    const reviewer = await register("ci-reviewer-5");
    const execA = await register("ci-exec-5");
    const group = await createGroup(coordinator.id, "ci-5");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
      "fix",
    );
    await addChild(group.id, task.id, execA.id);
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(200);
  });

  it("R2:两方在场(无 reviewer)+ 无 review_request → 放行", async () => {
    const coordinator = await register("ci-coord-6");
    const execA = await register("ci-exec-6");
    const group = await createGroup(coordinator.id, "ci-6");
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
      "requirement",
    );
    await addChild(group.id, task.id, execA.id);
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(200);
  });

  it("R2:dispatchKind 为 null + 三方在场 + 无 review_request → 400(保守)", async () => {
    const coordinator = await register("ci-coord-7");
    const reviewer = await register("ci-reviewer-7");
    const execA = await register("ci-exec-7");
    const group = await createGroup(coordinator.id, "ci-7");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    ); // 无 dispatchKind → null,按 requirement 处理
    await addChild(group.id, task.id, execA.id);
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(400);
  });

  it("R3:PATCH failed 时两条规则均不生效", async () => {
    const coordinator = await register("ci-coord-8");
    const reviewer = await register("ci-reviewer-8");
    const execA = await register("ci-exec-8");
    const group = await createGroup(coordinator.id, "ci-8");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    // 零子任务 + 三方 + null dispatchKind:若是 done 会被 R1/R2 双拒。
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "failed",
      diffSummary: { error: "诚实的失败上报" },
    });
    expect(res.status).toBe(200);
  });

  it("R3:PATCH cancelled 时两条规则均不生效", async () => {
    const coordinator = await register("ci-coord-cancelled");
    const reviewer = await register("ci-reviewer-cancelled");
    const execA = await register("ci-exec-cancelled");
    const group = await createGroup(coordinator.id, "ci-cancelled");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    // 零子任务 + 三方 + null dispatchKind:若是 done 会被 R1/R2 双拒。
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "cancelled",
      diffSummary: { error: "协调者取消" },
    });
    expect(res.status).toBe(200);
  });

  it("R5:非协调任务(普通执行任务)PATCH done 行为完全不变", async () => {
    const coordinator = await register("ci-coord-9");
    const reviewer = await register("ci-reviewer-9");
    const execA = await register("ci-exec-9");
    const group = await createGroup(coordinator.id, "ci-9");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "执行任务");
    // executor 为 execA(无 coordinator 角色)→ 非 detached,不受 R1/R2 约束。
    const task = await createTask(coordinator.id, group.id, msg.id, execA.id);
    const res = await patchTask(execA.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(200);
  });

  it("复用 isDetachedTask():brief 含 ## ReplyMode: detached 即判定协调任务", async () => {
    const coordinator = await register("ci-coord-10");
    const execA = await register("ci-exec-10");
    const group = await createGroup(coordinator.id, "ci-10");
    // executor 非 coordinator,靠 brief 标记被 isDetachedTask 判定为协调任务。
    const msg = await postMessage(
      coordinator.id,
      group.id,
      "## ReplyMode: detached\n普通正文",
    );
    const task = await createTask(coordinator.id, group.id, msg.id, execA.id);
    // 零子任务 done → R1 经 isDetachedTask 的 brief 分支命中 → 400。
    const res = await patchTask(execA.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("L1 层未发生");
  });

  it("R5:既有 review_request 形状校验不变(缺字段 → 400 形状错误)", async () => {
    const coordinator = await register("ci-coord-11");
    const execA = await register("ci-exec-11");
    const group = await createGroup(coordinator.id, "ci-11");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    await addChild(group.id, task.id, execA.id);
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: { review_request: { type: "review_request" } },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("形状无效");
  });

  it("完整放行:三方在场 + requirement + 有子任务 + 合法 review_request → 200", async () => {
    const coordinator = await register("ci-coord-12");
    const reviewer = await register("ci-reviewer-12");
    const execA = await register("ci-exec-12");
    const group = await createGroup(coordinator.id, "ci-12");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
      "requirement",
    );
    await addChild(group.id, task.id, execA.id);
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: reviewRequest(task.id),
    });
    expect(res.status).toBe(200);
  });

  it("review_request 以顶层 {type:'review_request'} 形式也可放行", async () => {
    const coordinator = await register("ci-coord-13");
    const reviewer = await register("ci-reviewer-13");
    const execA = await register("ci-exec-13");
    const group = await createGroup(coordinator.id, "ci-13");
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
      "requirement",
    );
    await addChild(group.id, task.id, execA.id);
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: {
        type: "review_request",
        layer: 3,
        taskId: task.id,
        specRef: "specs/coordination-close-integrity.md",
        specHash: "449e4a1e",
        diffSummary: "测试交接载荷",
      },
    });
    expect(res.status).toBe(200);
  });

  it("R1:有非终态执行子任务(running)+ done → 400,错误含子任务 id 与状态", async () => {
    const coordinator = await register("ci-coord-running-child");
    const executor = await register("ci-exec-running-child");
    const group = await createGroup(coordinator.id, "ci-running-child");
    await addMember(coordinator.id, group.id, executor.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const childId = await addChildWithWindow(
      group.id,
      task.id,
      executor.id,
      new Date().toISOString(),
      "running",
    );
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain(childId);
    expect(body.message).toContain("running");
  });

  it("R1:有非终态执行子任务(queued)+ done → 400,queued 非终态", async () => {
    const coordinator = await register("ci-coord-queued-child");
    const executor = await register("ci-exec-queued-child");
    const group = await createGroup(coordinator.id, "ci-queued-child");
    await addMember(coordinator.id, group.id, executor.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const childId = await addChild(group.id, task.id, executor.id, "queued");
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain(childId);
    expect(body.message).toContain("queued");
  });

  it("R1:全部执行子任务终态(done/failed)+ done → 200(回归)", async () => {
    const coordinator = await register("ci-coord-all-terminal");
    const executor = await register("ci-exec-all-terminal");
    const group = await createGroup(coordinator.id, "ci-all-terminal");
    await addMember(coordinator.id, group.id, executor.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    await addChild(group.id, task.id, executor.id, "done");
    await addChild(group.id, task.id, executor.id, "failed");
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(200);
  });

  it("R1:有非终态执行子任务 + failed → 200(不触发)", async () => {
    const coordinator = await register("ci-coord-failed-child");
    const executor = await register("ci-exec-failed-child");
    const group = await createGroup(coordinator.id, "ci-failed-child");
    await addMember(coordinator.id, group.id, executor.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    await addChildWithWindow(
      group.id,
      task.id,
      executor.id,
      new Date().toISOString(),
      "running",
    );
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "failed",
      diffSummary: { error: "诚实的失败上报" },
    });
    expect(res.status).toBe(200);
  });

  it("R1:多个子任务其一非终态 → 400,只列出非终态的那个", async () => {
    const coordinator = await register("ci-coord-multi-child");
    const executor = await register("ci-exec-multi-child");
    const group = await createGroup(coordinator.id, "ci-multi-child");
    await addMember(coordinator.id, group.id, executor.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const doneId = await addChild(group.id, task.id, executor.id, "done");
    const runningId = await addChildWithWindow(
      group.id,
      task.id,
      executor.id,
      new Date().toISOString(),
      "running",
    );
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain(runningId);
    expect(body.message).not.toContain(doneId);
  });
});
