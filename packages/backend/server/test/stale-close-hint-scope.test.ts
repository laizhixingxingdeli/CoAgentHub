import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import {
  findRepoRoot,
  pathsReferToSameDir,
} from "@server/lib/executor-runner";
import {
  configureSourceScanRoots,
  resetSourceScanCache,
} from "@server/lib/runtime-status";
import { v4 as uuidv4 } from "uuid";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __resetWritebackRejectionsForTests,
  __setWritebackRejectionLimitForTests,
} from "../src/lib/writeback-rejection";
import { createTestApp } from "./app";
import { seedBuiltinExecutorConfigs, testDb } from "./db";

/**
 * 结案拒绝里的「陈旧构建」提示只在群绑定路径 = 平台自身仓库时追加。
 * 其它项目即使 runtime.stale 也必须与 stale:false 文案逐字一致。
 */

const STALE_HINT_MARKER = "注意:当前运行时为陈旧构建";

beforeAll(async () => {
  await seedBuiltinExecutorConfigs();
});

beforeEach(() => {
  __resetWritebackRejectionsForTests();
  __setWritebackRejectionLimitForTests(99);
});

afterEach(() => {
  __resetWritebackRejectionsForTests();
  configureSourceScanRoots(null);
  resetSourceScanCache();
});

describe("pathsReferToSameDir", () => {
  it("尾斜杠与分隔符差异仍相等,前缀相似路径不相等", () => {
    const root = findRepoRoot();
    expect(pathsReferToSameDir(root, root)).toBe(true);
    expect(pathsReferToSameDir(root, root + path.sep)).toBe(true);
    expect(pathsReferToSameDir(root, root + path.sep + path.sep)).toBe(true);

    // 禁止 includes: repo 不得误配 repo-other
    const sibling = root + "-other";
    expect(pathsReferToSameDir(root, sibling)).toBe(false);
    expect(pathsReferToSameDir(root + path.sep, sibling)).toBe(false);
  });

  it("混用分隔符与 . 段规范化后相等", () => {
    const root = findRepoRoot();
    const withDot = path.join(root, "packages", "..");
    expect(pathsReferToSameDir(root, withDot)).toBe(true);
  });
});

describe("结案拒绝陈旧提示按项目范围追加", () => {
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

  async function createGroup(
    coordinatorId: string,
    title: string,
    projectPath?: string | null,
  ) {
    const body: { title: string; projectPath?: string | null } = { title };
    if (projectPath !== undefined) body.projectPath = projectPath;
    const res = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinatorId,
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; projectPath: string | null };
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
        dispatchKind: "requirement",
      }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; executorParticipantId: string };
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

  async function addChild(
    groupId: string,
    parentTaskId: string,
    executorParticipantId: string,
  ) {
    const childId = uuidv4();
    await testDb.insert(taskTable).values({
      id: childId,
      groupId,
      parentTaskId,
      messageId: uuidv4(),
      executorParticipantId,
      status: "done",
    });
    return childId;
  }

  /** 三方在场 + 缺 review_request → 稳定触发同一结案拒绝文案。 */
  async function setupRejectable(
    suffix: string,
    projectPath?: string | null,
  ) {
    const coordinator = await register(`sch-coord-${suffix}`);
    const reviewer = await register(`sch-reviewer-${suffix}`);
    const execA = await register(`sch-exec-${suffix}`);
    const group = await createGroup(
      coordinator.id,
      `sch-${suffix}`,
      projectPath,
    );
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    await addChild(group.id, task.id, execA.id);
    return { coordinator, group, task };
  }

  async function withStaleRuntime<T>(callback: () => Promise<T>) {
    const scanDir = mkdtempSync(path.join(tmpdir(), "coagenthub-sch-stale-"));
    const marker = path.join(scanDir, "newer-source.ts");
    writeFileSync(marker, "export {};\n");
    const future = new Date(Date.now() + 60_000);
    utimesSync(marker, future, future);
    configureSourceScanRoots([scanDir]);
    resetSourceScanCache();
    try {
      return await callback();
    } finally {
      configureSourceScanRoots(null);
      resetSourceScanCache();
      rmSync(scanDir, { recursive: true, force: true });
    }
  }

  async function withFreshRuntime<T>(callback: () => Promise<T>) {
    configureSourceScanRoots([]);
    resetSourceScanCache();
    try {
      return await callback();
    } finally {
      configureSourceScanRoots(null);
      resetSourceScanCache();
    }
  }

  async function rejectMessage(
    coordinatorId: string,
    groupId: string,
    taskId: string,
  ): Promise<string> {
    const res = await patchTask(coordinatorId, groupId, taskId, {
      status: "done",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(typeof body.message).toBe("string");
    return body.message;
  }

  it("群绑定 = 平台仓库 + stale → 追加陈旧提示", async () => {
    const platformRoot = findRepoRoot();
    const { coordinator, group, task } = await setupRejectable(
      "platform-stale",
      platformRoot,
    );

    await withStaleRuntime(async () => {
      const msg = await rejectMessage(coordinator.id, group.id, task.id);
      expect(msg).toContain(STALE_HINT_MARKER);
      expect(msg).toContain("staleReason:");
      expect(msg).toContain("请在发起方重启后重试回写");
    });
  });

  it("群绑定 = 其它项目 + stale → 不追加,与 fresh 文案逐字一致", async () => {
    const otherDir = mkdtempSync(path.join(tmpdir(), "coagenthub-sch-other-"));
    try {
      const { coordinator, group, task } = await setupRejectable(
        "other-stale",
        otherDir,
      );

      let freshMsg = "";
      await withFreshRuntime(async () => {
        freshMsg = await rejectMessage(coordinator.id, group.id, task.id);
      });
      expect(freshMsg).not.toContain(STALE_HINT_MARKER);

      // 新任务再测 stale(同一任务第一次拒绝后仍可再拒,但文案应相同)
      const again = await setupRejectable("other-stale-2", otherDir);
      await withStaleRuntime(async () => {
        const staleMsg = await rejectMessage(
          again.coordinator.id,
          again.group.id,
          again.task.id,
        );
        expect(staleMsg).toBe(freshMsg);
        expect(staleMsg).not.toContain(STALE_HINT_MARKER);
      });
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("群未绑定 projectPath + stale → 不追加", async () => {
    const { coordinator, group, task } = await setupRejectable("unbound-stale");
    await withStaleRuntime(async () => {
      const msg = await rejectMessage(coordinator.id, group.id, task.id);
      expect(msg).not.toContain(STALE_HINT_MARKER);
    });
  });

  it("stale:false 时平台项目也不追加(行为逐字不变)", async () => {
    const platformRoot = findRepoRoot();
    const { coordinator, group, task } = await setupRejectable(
      "platform-fresh",
      platformRoot,
    );
    await withFreshRuntime(async () => {
      const msg = await rejectMessage(coordinator.id, group.id, task.id);
      expect(msg).not.toContain(STALE_HINT_MARKER);
      expect(msg).toContain("review_request");
    });
  });
});
