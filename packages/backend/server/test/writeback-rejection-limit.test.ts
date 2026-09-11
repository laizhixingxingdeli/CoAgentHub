import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __resetWritebackRejectionsForTests,
  __setWritebackRejectionLimitForTests,
  clearWritebackRejections,
  formatWritebackRejectionTripError,
  getWritebackRejectionCount,
  getWritebackRejectionLimit,
  recordWritebackRejection,
} from "../src/lib/writeback-rejection";
import { createTestApp } from "./app";
import { seedBuiltinExecutorConfigs, testDb } from "./db";

/**
 * 回写被拒熔断(连续计数 → 触顶判 failed;成功清零)。
 * 守卫判定规则不动,只验证计数与终态落库。
 */

type Task = {
  id: string;
  status: string;
  executorParticipantId: string;
  diffSummary: unknown;
};

beforeAll(async () => {
  await seedBuiltinExecutorConfigs();
});

beforeEach(() => {
  __resetWritebackRejectionsForTests();
});

afterEach(() => {
  __resetWritebackRejectionsForTests();
});

describe("writeback-rejection 计数模块", () => {
  it("按任务连续累加,clear 后归零", () => {
    __setWritebackRejectionLimitForTests(5);
    expect(getWritebackRejectionLimit()).toBe(5);

    const a = recordWritebackRejection("t-a", "reason-1");
    expect(a.count).toBe(1);
    expect(a.lastMessage).toBe("reason-1");
    const a2 = recordWritebackRejection("t-a", "reason-2");
    expect(a2.count).toBe(2);
    expect(a2.lastMessage).toBe("reason-2");

    // 另一任务独立计数
    expect(recordWritebackRejection("t-b", "other").count).toBe(1);

    clearWritebackRejections("t-a");
    expect(getWritebackRejectionCount("t-a")).toBe(0);
    expect(recordWritebackRejection("t-a", "again").count).toBe(1);
    expect(getWritebackRejectionCount("t-b")).toBe(1);
  });

  it("触顶文案含次数与最后一次原文", () => {
    const text = formatWritebackRejectionTripError(
      3,
      3,
      "缺少 review_request",
    );
    expect(text).toContain("3");
    expect(text).toContain("缺少 review_request");
    expect(text).toContain("failed");
  });
});

describe("回写被拒熔断(结案 PATCH)", () => {
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

  function reviewRequest(taskId: string) {
    return {
      review_request: {
        type: "review_request",
        layer: 3,
        taskId,
        specRef: "specs/writeback-rejection-limit.md",
        specHash: "deadbeef",
        diffSummary: "测试交接载荷",
      },
    };
  }

  /** 三方在场 + 缺 review_request → 稳定触发同一结案拒绝文案。 */
  async function setupRejectableCoordinationTask(suffix: string) {
    const coordinator = await register(`wbr-coord-${suffix}`);
    const reviewer = await register(`wbr-reviewer-${suffix}`);
    const execA = await register(`wbr-exec-${suffix}`);
    const group = await createGroup(coordinator.id, `wbr-${suffix}`);
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

  it("连续被拒到阈值 → 任务转 failed,diffSummary 含次数与最后一次原文", async () => {
    __setWritebackRejectionLimitForTests(2);
    const { coordinator, group, task } =
      await setupRejectableCoordinationTask("trip");

    const lastRejectMessage =
      "本协调任务应走 L3 三方检视,但 diffSummary 缺少 review_request 交接载荷(群内 reviewer 与 coordinator 同时在场)。";

    const first = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(first.status).toBe(400);
    expect(getWritebackRejectionCount(task.id)).toBe(1);

    // 触顶前仍非终态
    const mid = await testDb.query.task.findFirst({
      where: eq(taskTable.id, task.id),
    });
    expect(mid?.status).not.toBe("failed");
    expect(mid?.status).not.toBe("done");

    const second = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(second.status).toBe(400);
    const body = (await second.json()) as { message: string };
    expect(body.message).toContain("review_request");

    const row = await testDb.query.task.findFirst({
      where: eq(taskTable.id, task.id),
    });
    expect(row?.status).toBe("failed");
    const summary = row?.diffSummary as Record<string, unknown>;
    expect(typeof summary.error).toBe("string");
    expect(summary.error as string).toContain("2");
    expect(summary.error as string).toContain(lastRejectMessage);
    const platform = summary.platform as Record<string, unknown> | undefined;
    const trip = platform?.writebackRejectionTrip as
      | { count: number; lastMessage: string }
      | undefined;
    expect(trip?.count).toBe(2);
    expect(trip?.lastMessage).toContain("review_request");
    // 触顶后计数已清,避免重复 force-fail
    expect(getWritebackRejectionCount(task.id)).toBe(0);
  });

  it("被拒 N-1 次 → 成功一次 → 再被拒,不应立即触顶(验证清零)", async () => {
    // limit=2:若清零失效,成功后再被拒一次会立刻触顶(count 残 1+1=2)。
    __setWritebackRejectionLimitForTests(2);
    const { coordinator, group, task } =
      await setupRejectableCoordinationTask("reset");

    // N-1 = 1 次被拒
    const rejected = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(rejected.status).toBe(400);
    expect(getWritebackRejectionCount(task.id)).toBe(1);

    // 一次成功回写 → 计数清零,任务 done
    const ok = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: reviewRequest(task.id),
    });
    expect(ok.status).toBe(200);
    expect(getWritebackRejectionCount(task.id)).toBe(0);

    // 把任务拨回非终态,模拟「成功后再次尝试结案又被拒」
    // (生产上同任务不会从 done 回 running;此处只为验证计数清零语义)。
    await testDb
      .update(taskTable)
      .set({ status: "running", diffSummary: null })
      .where(eq(taskTable.id, task.id));

    const again = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(again.status).toBe(400);
    // 清零有效 → 这是新 streak 的第 1 次,未触顶
    expect(getWritebackRejectionCount(task.id)).toBe(1);
    const row = await testDb.query.task.findFirst({
      where: eq(taskTable.id, task.id),
    });
    expect(row?.status).not.toBe("failed");
    expect(row?.status).toBe("running");
  });
});
