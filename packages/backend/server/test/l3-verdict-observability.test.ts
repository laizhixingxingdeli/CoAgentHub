import { randomUUID } from "node:crypto";
import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { __setL3ResponseMinutesForTests } from "@server/lib/executor-task";
import {
  remindOverdueL3Requests,
  resetL3OverdueReminderStateForTests,
} from "@server/lib/l3-overdue-reminder";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "./app";
import { testDb } from "./db";

const reminderDb = testDb as unknown as DataBase;

/**
 * L3 裁决的可观测与校验(R1-R6,specs/l3-verdict-observability.md):
 *
 * - R1/R2 在 routes/group/messages.ts:载荷校验不再依赖调用方声明 contentType,
 *   按消息体形状探测四类已知协作载荷;review_result 的 taskId 必须指向本群
 *   真实任务。
 * - R3 在 routes/group/tasks.ts 详情 GET:协调任务 done + 带 review_request 时
 *   派生 l3 字段(answered/verdict/awaitingSince/overdue)。
 * - R4 阈值经 scripts/dispatch-policy.json 配置,缺省 120 分钟。
 */

describe("L3 裁决的可观测与校验 (R1-R6)", () => {
  const app = createTestApp();

  afterEach(() => {
    __setL3ResponseMinutesForTests(120);
    resetL3OverdueReminderStateForTests();
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

  /** 发群消息;messageBody 为消息文本(载荷 JSON 时即 payload 字符串)。 */
  async function postMessageRaw(
    actorId: string,
    groupId: string,
    messageBody: string,
    contentType?: string,
    extra: Record<string, unknown> = {},
  ) {
    return app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": actorId,
      },
      body: JSON.stringify(
        contentType === undefined
          ? { body: messageBody, ...extra }
          : { body: messageBody, contentType, ...extra },
      ),
    });
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
    return (await res.json()) as {
      id: string;
      status: string;
      dispatchKind: "requirement" | "fix" | null;
    };
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

  async function getTaskDetail(groupId: string, taskId: string) {
    const res = await app.request(`/api/groups/${groupId}/tasks/${taskId}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  async function makeTaskOverdue(taskId: string) {
    __setL3ResponseMinutesForTests(1);
    // 测试库跨用例保留历史行:先按生产启动语义登记既有逾期请求,避免它们
    // 干扰当前用例只针对 taskId 的断言。
    await remindOverdueL3Requests(reminderDb, new Date(), {
      suppressExistingOverdue: true,
    });
    const twoMinutesAgo = new Date(Date.now() - 2 * 60_000);
    await testDb
      .update(taskTable)
      .set({
        updatedAt: twoMinutesAgo,
        dispatchAudit: {
          dispatcherParticipantId: "00000000-0000-4000-8000-000000000000",
          targetParticipantId: "00000000-0000-4000-8000-000000000000",
          targetParticipantName: "test",
          selfDispatch: true,
          candidates: [],
          selectionReason: null,
          coordinationActivity: {
            startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            endedAt: twoMinutesAgo.toISOString(),
            childTaskCount: 1,
            childTaskTargets: [],
            messageCount: 0,
          },
        },
      })
      .where(eq(taskTable.id, taskId));
  }

  async function l3ReminderMessages(groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/messages`);
    expect(res.status).toBe(200);
    const messages = (await res.json()) as { body: string }[];
    return messages.filter((message) =>
      message.body.includes("L3 逾期提醒（平台自动）"),
    );
  }

  /** 直接插入一条已完成的执行子任务,使协调任务可以合法落 done。 */
  async function addChild(
    groupId: string,
    parentTaskId: string,
    executorParticipantId: string,
  ) {
    await testDb.insert(taskTable).values({
      groupId,
      parentTaskId,
      messageId: uuidv4(),
      executorParticipantId,
      status: "done",
    });
  }

  function reviewRequest(taskId: string) {
    return {
      review_request: {
        type: "review_request",
        layer: 3,
        taskId,
        specRef: "specs/l3-verdict-observability.md",
        specHash: "24541d3d",
        diffSummary: "测试交接载荷",
      },
    };
  }

  function reviewResult(taskId: string, verdict: "pass" | "findings") {
    return {
      type: "review_result",
      layer: 3,
      taskId,
      verdict,
      findings: [],
    };
  }

  function markdownReviewResult(
    taskId: string,
    verdict: "pass" | "findings",
  ): string {
    return [
      `## L3 裁决：${verdict}`,
      "",
      "检视说明正文",
      "",
      "```json",
      JSON.stringify(reviewResult(taskId, verdict)),
      "```",
    ].join("\n");
  }

  /** 搭建一个可落 done 的协调任务(三方在场 + 子任务 + review_request)。 */
  async function setupDoneCoordinationTask() {
    const coordinator = await register(`l3-coord-${randomUUID()}`);
    const reviewer = await register(`l3-reviewer-${randomUUID()}`);
    const execA = await register(`l3-exec-${randomUUID()}`);
    const group = await createGroup(coordinator.id, `l3-${randomUUID()}`);
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessageRaw(coordinator.id, group.id, "协调任务");
    expect(msg.status).toBe(200);
    const messageId = ((await msg.json()) as { id: string }).id;
    const task = await createTask(
      coordinator.id,
      group.id,
      messageId,
      coordinator.id,
      "requirement",
    );
    await addChild(group.id, task.id, execA.id);
    const patched = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: reviewRequest(task.id),
    });
    expect(patched.status).toBe(200);
    return { coordinator, reviewer, execA, group, task };
  }

  /* ---------------- R1:载荷校验不再依赖 contentType ---------------- */

  it("R1:不设 contentType 发送形状错误的 review_result → 400(本票核心,此前静默放行)", async () => {
    const coordinator = await register(`l3-r1-bad-${randomUUID()}`);
    const group = await createGroup(
      coordinator.id,
      `l3-r1-bad-${randomUUID()}`,
    );
    // verdict 非法 → 形状不合;不传 contentType 字段,仅凭 body 形状触发校验。
    const res = await postMessageRaw(
      coordinator.id,
      group.id,
      JSON.stringify({ type: "review_result", layer: 3, verdict: "bogus" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("协作载荷形状无效");
  });

  it("R1:不设 contentType 发送形状正确的四种载荷 → 放行", async () => {
    const coordinator = await register(`l3-r1-ok-${randomUUID()}`);
    const group = await createGroup(coordinator.id, `l3-r1-ok-${randomUUID()}`);
    // review_result 的 R2 需要本群存在任务,先建一条普通执行任务供其引用。
    const msg = await postMessageRaw(coordinator.id, group.id, "执行任务");
    const messageId = ((await msg.json()) as { id: string }).id;
    const task = await createTask(
      coordinator.id,
      group.id,
      messageId,
      coordinator.id,
    );
    const payloads = [
      {
        type: "spec_published",
        specRef: "specs/x.md",
        specHash: "abc123",
        summary: "s",
      },
      {
        type: "spec_amended",
        specRef: "specs/x.md",
        specHash: "abc123",
        reason: "r",
      },
      {
        type: "review_request",
        layer: 3,
        taskId: "any-task-id",
        specRef: "specs/x.md",
        specHash: "abc123",
        diffSummary: "d",
      },
      reviewResult(task.id, "pass"),
    ];
    for (const payload of payloads) {
      const res = await postMessageRaw(
        coordinator.id,
        group.id,
        JSON.stringify(payload),
      );
      expect(res.status).toBe(200);
    }
  });

  it("R1:普通自由文本 / 任务书 markdown / 伪 JSON 文本 → 行为完全不变(回归)", async () => {
    const coordinator = await register(`l3-r1-free-${randomUUID()}`);
    const group = await createGroup(
      coordinator.id,
      `l3-r1-free-${randomUUID()}`,
    );
    for (const body of [
      "普通自由文本消息",
      "# 任务书\n\n实现登录页,验收标准:……",
      "{ 这不是合法 JSON,但以花括号开头",
      "[1, 2, 3]",
    ]) {
      const res = await postMessageRaw(coordinator.id, group.id, body);
      expect(res.status).toBe(200);
    }
  });

  it("R1:type 为未知值的 JSON 消息 → 放行,不校验", async () => {
    const coordinator = await register(`l3-r1-unknown-${randomUUID()}`);
    const group = await createGroup(
      coordinator.id,
      `l3-r1-unknown-${randomUUID()}`,
    );
    const res = await postMessageRaw(
      coordinator.id,
      group.id,
      JSON.stringify({ type: "some_other_convention", anything: true }),
    );
    expect(res.status).toBe(200);
  });

  it("R1:保留 contentType=application/json 时的既有校验路径(仍校验)", async () => {
    const coordinator = await register(`l3-r1-ct-${randomUUID()}`);
    const group = await createGroup(coordinator.id, `l3-r1-ct-${randomUUID()}`);
    const bad = await postMessageRaw(
      coordinator.id,
      group.id,
      JSON.stringify({ type: "review_result", layer: 3, verdict: "bogus" }),
      "application/json",
    );
    expect(bad.status).toBe(400);
    const ok = await postMessageRaw(
      coordinator.id,
      group.id,
      JSON.stringify({
        type: "spec_published",
        specRef: "s",
        specHash: "h",
        summary: "x",
      }),
      "application/json",
    );
    expect(ok.status).toBe(200);
  });

  /* ---------------- R2:review_result 的 taskId 必须在本群 ---------------- */

  it("R2:review_result 的 taskId 不在本群 → 400,信息点明原因", async () => {
    const coordinator = await register(`l3-r2-missing-${randomUUID()}`);
    const group = await createGroup(
      coordinator.id,
      `l3-r2-missing-${randomUUID()}`,
    );
    const res = await postMessageRaw(
      coordinator.id,
      group.id,
      JSON.stringify(reviewResult(uuidv4(), "pass")),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("review_result 引用的 taskId 在本群不存在");
  });

  it("R2:taskId 非 UUID 字符串 → 400(不触发 DB uuid 比较 500)", async () => {
    const coordinator = await register(`l3-r2-notuuid-${randomUUID()}`);
    const group = await createGroup(
      coordinator.id,
      `l3-r2-notuuid-${randomUUID()}`,
    );
    const res = await postMessageRaw(
      coordinator.id,
      group.id,
      JSON.stringify(reviewResult("not-a-uuid", "pass")),
    );
    expect(res.status).toBe(400);
  });

  it("R2:taskId 存在但该任务无 review_request → 放行(R2 的例外)", async () => {
    const coordinator = await register(`l3-r2-norr-${randomUUID()}`);
    const group = await createGroup(
      coordinator.id,
      `l3-r2-norr-${randomUUID()}`,
    );
    const msg = await postMessageRaw(coordinator.id, group.id, "执行任务");
    const messageId = ((await msg.json()) as { id: string }).id;
    const task = await createTask(
      coordinator.id,
      group.id,
      messageId,
      coordinator.id,
    );
    // 该任务无 review_request(普通执行任务),检视者主动出具意见应放行。
    const res = await postMessageRaw(
      coordinator.id,
      group.id,
      JSON.stringify(reviewResult(task.id, "findings")),
      undefined,
      {
        audience: "participant",
        audienceRef: coordinator.id,
        specRef: "specs/l3-verdict-observability.md",
        specHash: "24541d3d",
      },
    );
    expect(res.status).toBe(200);
  });

  /* ---------------- R3:任务详情派生 l3 字段 ---------------- */

  it("R3:协调任务 done + 带 review_request + 无 review_result → l3.answered=false", async () => {
    const { group, task } = await setupDoneCoordinationTask();
    const detail = await getTaskDetail(group.id, task.id);
    expect(detail.l3).toEqual({
      answered: false,
      verdict: null,
      awaitingSince: expect.any(String),
      overdue: false,
    });
  });

  it("R3:超过 l3ResponseMinutes 仍未应答 → l3.overdue=true", async () => {
    const { group, task } = await setupDoneCoordinationTask();
    // 把落 done 时刻(coordinatorActivity.endedAt / updatedAt)回拨到 2 分钟前,
    // 阈值压到 1 分钟 → now - awaitingSince > 阈值 且未应答。dispatchAudit 为
    // 完整 DispatchTargetAudit 形状(测试只关心 coordinationActivity)。
    const twoMinutesAgo = new Date(Date.now() - 2 * 60_000);
    await testDb
      .update(taskTable)
      .set({
        updatedAt: twoMinutesAgo,
        dispatchAudit: {
          dispatcherParticipantId: "00000000-0000-4000-8000-000000000000",
          targetParticipantId: "00000000-0000-4000-8000-000000000000",
          targetParticipantName: "test",
          selfDispatch: true,
          candidates: [],
          selectionReason: null,
          coordinationActivity: {
            startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            endedAt: twoMinutesAgo.toISOString(),
            childTaskCount: 1,
            childTaskTargets: [],
            messageCount: 0,
          },
        },
      })
      .where(eq(taskTable.id, task.id));
    __setL3ResponseMinutesForTests(1);
    const detail = await getTaskDetail(group.id, task.id);
    const l3 = detail.l3 as {
      answered: boolean;
      verdict: string | null;
      overdue: boolean;
    };
    expect(l3.answered).toBe(false);
    expect(l3.overdue).toBe(true);
  });

  /* -------- l3-overdue-should-actually-remind R1-R4 -------- */

  it("逾期请求 → 平台群消息含 specRef、等待时长与群内 reviewer,且不改任务状态", async () => {
    const { reviewer, group, task } = await setupDoneCoordinationTask();
    await makeTaskOverdue(task.id);

    expect(await remindOverdueL3Requests(reminderDb)).toBe(1);
    const reminders = await l3ReminderMessages(group.id);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.body).toContain("specs/l3-verdict-observability.md");
    expect(reminders[0]?.body).toContain("已等待 2 分钟");
    expect(reminders[0]?.body).toContain("应裁决方=");
    expect(reminders[0]?.body).toContain(reviewer.id);
    expect((await getTaskDetail(group.id, task.id)).status).toBe("done");
  });

  it("同一条逾期请求重复扫描只提醒一次", async () => {
    const { group, task } = await setupDoneCoordinationTask();
    await makeTaskOverdue(task.id);

    expect(await remindOverdueL3Requests(reminderDb)).toBe(1);
    expect(await remindOverdueL3Requests(reminderDb)).toBe(0);
    expect(await l3ReminderMessages(group.id)).toHaveLength(1);
  });

  it("未逾期请求不提醒", async () => {
    const { group } = await setupDoneCoordinationTask();

    expect(await remindOverdueL3Requests(reminderDb)).toBe(0);
    expect(await l3ReminderMessages(group.id)).toHaveLength(0);
  });

  it("已被裁决的逾期请求不提醒", async () => {
    const { reviewer, group, task } = await setupDoneCoordinationTask();
    await makeTaskOverdue(task.id);
    const result = await postMessageRaw(
      reviewer.id,
      group.id,
      JSON.stringify(reviewResult(task.id, "pass")),
    );
    expect(result.status).toBe(200);

    expect(await remindOverdueL3Requests(reminderDb)).toBe(0);
    expect(await l3ReminderMessages(group.id)).toHaveLength(0);
  });

  it("旧请求被裁决后,同一 spec 的新逾期请求允许再次提醒", async () => {
    const {
      coordinator,
      reviewer,
      execA,
      group,
      task: firstTask,
    } = await setupDoneCoordinationTask();
    await makeTaskOverdue(firstTask.id);
    expect(await remindOverdueL3Requests(reminderDb)).toBe(1);

    const result = await postMessageRaw(
      reviewer.id,
      group.id,
      JSON.stringify(reviewResult(firstTask.id, "pass")),
    );
    expect(result.status).toBe(200);
    expect(await remindOverdueL3Requests(reminderDb)).toBe(0);

    const message = await postMessageRaw(
      coordinator.id,
      group.id,
      "同一 spec 的新协调任务",
    );
    const secondTask = await createTask(
      coordinator.id,
      group.id,
      ((await message.json()) as { id: string }).id,
      coordinator.id,
      "requirement",
    );
    await addChild(group.id, secondTask.id, execA.id);
    const patched = await patchTask(coordinator.id, group.id, secondTask.id, {
      status: "done",
      diffSummary: reviewRequest(secondTask.id),
    });
    expect(patched.status).toBe(200);
    await makeTaskOverdue(secondTask.id);

    expect(await remindOverdueL3Requests(reminderDb)).toBe(1);
    expect(await l3ReminderMessages(group.id)).toHaveLength(2);
  });

  it("R3:已有 review_result → l3.answered=true 且 verdict 正确", async () => {
    const { reviewer, group, task } = await setupDoneCoordinationTask();
    const res = await postMessageRaw(
      reviewer.id,
      group.id,
      JSON.stringify(reviewResult(task.id, "pass")),
    );
    expect(res.status).toBe(200);
    const detail = await getTaskDetail(group.id, task.id);
    const l3 = detail.l3 as { answered: boolean; verdict: string };
    expect(l3.answered).toBe(true);
    expect(l3.verdict).toBe("pass");
  });

  it("R3:verdict=findings 的 review_result 也能被识别", async () => {
    const { reviewer, coordinator, group, task } =
      await setupDoneCoordinationTask();
    const res = await postMessageRaw(
      reviewer.id,
      group.id,
      JSON.stringify(reviewResult(task.id, "findings")),
      undefined,
      {
        audience: "participant",
        audienceRef: coordinator.id,
        specRef: "specs/l3-verdict-observability.md",
        specHash: "24541d3d",
      },
    );
    expect(res.status).toBe(200);
    const detail = await getTaskDetail(group.id, task.id);
    expect((detail.l3 as { verdict: string }).verdict).toBe("findings");
  });

  it("R3:verdict=findings 的广播形式 → 400 且指向正确派发方式", async () => {
    const { reviewer, group, task } = await setupDoneCoordinationTask();
    const res = await postMessageRaw(
      reviewer.id,
      group.id,
      JSON.stringify(reviewResult(task.id, "findings")),
      undefined,
      {
        specRef: "specs/l3-verdict-observability.md",
        specHash: "24541d3d",
      },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(
      "定向到 coordinator",
    );
  });

  it("R3:markdown 包裹的 findings 广播 → 400", async () => {
    const { reviewer, group, task } = await setupDoneCoordinationTask();
    const res = await postMessageRaw(
      reviewer.id,
      group.id,
      markdownReviewResult(task.id, "findings"),
      undefined,
      {
        specRef: "specs/l3-verdict-observability.md",
        specHash: "24541d3d",
      },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(
      "定向到 coordinator",
    );
  });

  it("R3:markdown 包裹的 pass → 200 且 l3 应答", async () => {
    const { reviewer, group, task } = await setupDoneCoordinationTask();
    const res = await postMessageRaw(
      reviewer.id,
      group.id,
      markdownReviewResult(task.id, "pass"),
    );
    expect(res.status).toBe(200);
    const detail = await getTaskDetail(group.id, task.id);
    expect(detail.l3).toMatchObject({ answered: true, verdict: "pass" });
  });

  it("R3:不满足触发条件的任务详情不含 l3 字段(普通任务 done)", async () => {
    const coordinator = await register(`l3-r3-plain-${randomUUID()}`);
    // 执行人必须是普通 executor(非 coordinator),否则 isDetachedTask 判定为
    // 协调任务,触发 L1 完整性校验。
    const executor = await register(`l3-r3-plain-exec-${randomUUID()}`);
    const group = await createGroup(
      coordinator.id,
      `l3-r3-plain-${randomUUID()}`,
    );
    await addMember(coordinator.id, group.id, executor.id, ["executor"]);
    const msg = await postMessageRaw(coordinator.id, group.id, "执行任务");
    const messageId = ((await msg.json()) as { id: string }).id;
    const task = await createTask(
      coordinator.id,
      group.id,
      messageId,
      executor.id,
    );
    const patched = await patchTask(executor.id, group.id, task.id, {
      status: "done",
    });
    expect(patched.status).toBe(200);
    const detail = await getTaskDetail(group.id, task.id);
    expect(detail).not.toHaveProperty("l3");
    // 其余载荷保持既有字段(逐字不变的回归锚点)。
    expect(detail.status).toBe("done");
    expect(detail.id).toBe(task.id);
    expect(detail.groupId).toBe(group.id);
  });

  it("R3:不满足触发条件的任务详情不含 l3 字段(协调任务未落 done)", async () => {
    const coordinator = await register(`l3-r3-queued-${randomUUID()}`);
    const reviewer = await register(`l3-r3-queued-rv-${randomUUID()}`);
    const group = await createGroup(
      coordinator.id,
      `l3-r3-queued-${randomUUID()}`,
    );
    await addMember(coordinator.id, group.id, reviewer.id, ["reviewer"]);
    const msg = await postMessageRaw(coordinator.id, group.id, "协调任务");
    const messageId = ((await msg.json()) as { id: string }).id;
    const task = await createTask(
      coordinator.id,
      group.id,
      messageId,
      coordinator.id,
      "requirement",
    );
    const detail = await getTaskDetail(group.id, task.id);
    expect(detail.status).toBe("queued");
    expect(detail).not.toHaveProperty("l3");
  });

  it("R3:协调任务 done 但无 review_request → 不含 l3 字段", async () => {
    const coordinator = await register(`l3-r3-norr-${randomUUID()}`);
    const execA = await register(`l3-r3-norr-exec-${randomUUID()}`);
    const group = await createGroup(
      coordinator.id,
      `l3-r3-norr-${randomUUID()}`,
    );
    await addMember(coordinator.id, group.id, execA.id, ["executor"]);
    const msg = await postMessageRaw(coordinator.id, group.id, "协调任务");
    const messageId = ((await msg.json()) as { id: string }).id;
    const task = await createTask(
      coordinator.id,
      group.id,
      messageId,
      coordinator.id,
    );
    await addChild(group.id, task.id, execA.id);
    // 两方在场(无 reviewer)→ shouldWalkL3=false,不带 review_request 也可 done。
    const patched = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: { noExecutionReason: "无需执行器" },
    });
    expect(patched.status).toBe(200);
    const detail = await getTaskDetail(group.id, task.id);
    expect(detail.status).toBe("done");
    expect(detail).not.toHaveProperty("l3");
  });

  it("R3:协调任务 done + 带 review_request,review_result 指向别的任务 → 不算 answered", async () => {
    const { reviewer, coordinator, group, task } =
      await setupDoneCoordinationTask();
    // 另一条普通任务(与协调任务同群)。
    const msg = await postMessageRaw(coordinator.id, group.id, "别的任务");
    const messageId = ((await msg.json()) as { id: string }).id;
    const otherTask = await createTask(
      coordinator.id,
      group.id,
      messageId,
      coordinator.id,
    );
    const res = await postMessageRaw(
      reviewer.id,
      group.id,
      JSON.stringify(reviewResult(otherTask.id, "pass")),
    );
    expect(res.status).toBe(200);
    const detail = await getTaskDetail(group.id, task.id);
    const l3 = detail.l3 as { answered: boolean; verdict: string | null };
    expect(l3.answered).toBe(false);
    expect(l3.verdict).toBe(null);
  });

  /* -------- 修复票:reviewResultPayload 可选字段(strict 保留) -------- */

  it("补丁:review_result 携带可选 specRef/specHash/note → 200", async () => {
    const coordinator = await register(`l3-fix-fields-${randomUUID()}`);
    const group = await createGroup(
      coordinator.id,
      `l3-fix-fields-${randomUUID()}`,
    );
    const msg = await postMessageRaw(coordinator.id, group.id, "执行任务");
    const messageId = ((await msg.json()) as { id: string }).id;
    const task = await createTask(
      coordinator.id,
      group.id,
      messageId,
      coordinator.id,
    );
    const res = await postMessageRaw(
      coordinator.id,
      group.id,
      JSON.stringify({
        ...reviewResult(task.id, "pass"),
        specRef: "specs/l3-verdict-observability.md",
        specHash: "24541d3d",
        note: "补充说明",
      }),
    );
    expect(res.status).toBe(200);
  });

  it("补丁:review_result 携带未知字段 noteX → 仍 400(strict 保留)", async () => {
    const coordinator = await register(`l3-fix-strict-${randomUUID()}`);
    const group = await createGroup(
      coordinator.id,
      `l3-fix-strict-${randomUUID()}`,
    );
    const res = await postMessageRaw(
      coordinator.id,
      group.id,
      JSON.stringify({ ...reviewResult(uuidv4(), "pass"), noteX: "x" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("协作载荷形状无效");
  });

  it("补丁:仅五个原字段(不带可选字段)仍 200", async () => {
    const coordinator = await register(`l3-fix-five-${randomUUID()}`);
    const group = await createGroup(
      coordinator.id,
      `l3-fix-five-${randomUUID()}`,
    );
    const msg = await postMessageRaw(coordinator.id, group.id, "执行任务");
    const messageId = ((await msg.json()) as { id: string }).id;
    const task = await createTask(
      coordinator.id,
      group.id,
      messageId,
      coordinator.id,
    );
    const res = await postMessageRaw(
      coordinator.id,
      group.id,
      JSON.stringify(reviewResult(task.id, "findings")),
      undefined,
      {
        audience: "participant",
        audienceRef: coordinator.id,
        specRef: "specs/l3-verdict-observability.md",
        specHash: "24541d3d",
      },
    );
    expect(res.status).toBe(200);
  });

  it("补丁:reviewRequestPayload 与其它载荷校验回归不变", async () => {
    const coordinator = await register(`l3-fix-regress-${randomUUID()}`);
    const group = await createGroup(
      coordinator.id,
      `l3-fix-regress-${randomUUID()}`,
    );
    // review_request 携带未知字段仍 400(strict 未放宽)。
    const rrBad = await postMessageRaw(
      coordinator.id,
      group.id,
      JSON.stringify({
        type: "review_request",
        layer: 3,
        taskId: "task-1",
        specRef: "specs/x.md",
        specHash: "abc1234",
        diffSummary: "d",
        noteX: "x",
      }),
    );
    expect(rrBad.status).toBe(400);
    // 形状正确的 review_request 仍放行。
    const rrOk = await postMessageRaw(
      coordinator.id,
      group.id,
      JSON.stringify({
        type: "review_request",
        layer: 3,
        taskId: "task-1",
        specRef: "specs/x.md",
        specHash: "abc1234",
        diffSummary: "d",
      }),
    );
    expect(rrOk.status).toBe(200);
  });
});
