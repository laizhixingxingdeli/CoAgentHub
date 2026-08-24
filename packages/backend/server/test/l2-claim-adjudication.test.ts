import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./app";
import { testDb } from "./db";

/**
 * L2 必须直面提交核实结论(specs/l2-must-read-claim-verification.md)。
 *
 * 校验点复用 routes/group/tasks.ts 的 assertCoordinationCloseIntegrity:
 * 协调任务落 done 时,任一执行子任务的 diffSummary.claimVerification.status
 * 属需表态集合(not_found / outside_window),则 coordination 任务的
 * diffSummary.claimAdjudication[childTaskId] 必须提供 accepted(布尔)与非空
 * reason,否则 400。verified / skipped 无需表态;failed 不触发。
 *
 * 覆盖 spec 验收标准逐条用例 + failed/非协调任务/noExecutionReason 的回归。
 */

type Task = {
  id: string;
  status: string;
  executorParticipantId: string;
  dispatchKind: "requirement" | "fix" | null;
  diffSummary: unknown;
};

type ClaimStatus = "verified" | "not_found" | "outside_window" | "skipped";

describe("L2 必须直面提交核实结论 (claimAdjudication)", () => {
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

  /** 插入一条指向 parentTaskId 的执行子任务,带 claimVerification 核实结论。 */
  async function addChild(
    groupId: string,
    parentTaskId: string,
    executorParticipantId: string,
    claimStatus?: ClaimStatus,
  ) {
    const [child] = await testDb
      .insert(taskTable)
      .values({
        groupId,
        parentTaskId,
        messageId: uuidv4(),
        executorParticipantId,
        status: "queued",
        ...(claimStatus !== undefined
          ? {
              diffSummary: {
                claimVerification: { status: claimStatus, hash: "a5b808b" },
              },
            }
          : {}),
      })
      .returning({ id: taskTable.id });
    return child.id;
  }

  function adjudication(childId: string, accepted: boolean, reason: string) {
    return { claimAdjudication: { [childId]: { accepted, reason } } };
  }

  // ---- 需表态集合:not_found / outside_window ----

  it("not_found 子任务 + 无 claimAdjudication → 400,且点明子任务 id 与核实结论", async () => {
    const coordinator = await register("ca-coord-a");
    const group = await createGroup(coordinator.id, "ca-a");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const childId = await addChild(
      group.id,
      task.id,
      coordinator.id,
      "not_found",
    );
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain(childId);
    expect(body.message).toContain("not_found");
  });

  it("not_found 子任务 + accepted:true + 非空 reason → 放行", async () => {
    const coordinator = await register("ca-coord-b");
    const group = await createGroup(coordinator.id, "ca-b");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const childId = await addChild(
      group.id,
      task.id,
      coordinator.id,
      "not_found",
    );
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: adjudication(
        childId,
        true,
        "执行器复用上一轮已提交的成果,已核对 diff 内容一致",
      ),
    });
    expect(res.status).toBe(200);
  });

  it("not_found 子任务 + reason 为空串/纯空白 → 400", async () => {
    const coordinator = await register("ca-coord-c");
    const group = await createGroup(coordinator.id, "ca-c");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const childId = await addChild(
      group.id,
      task.id,
      coordinator.id,
      "not_found",
    );
    for (const reason of ["", "   ", "\t\n"]) {
      const res = await patchTask(coordinator.id, group.id, task.id, {
        status: "done",
        diffSummary: adjudication(childId, true, reason),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toContain(childId);
      expect(body.message).toContain("reason");
    }
  });

  it("not_found 子任务 + accepted 缺失/非布尔 → 400", async () => {
    const coordinator = await register("ca-coord-d");
    const group = await createGroup(coordinator.id, "ca-d");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const childId = await addChild(
      group.id,
      task.id,
      coordinator.id,
      "not_found",
    );

    // accepted 缺失
    const resMissing = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: {
        claimAdjudication: { [childId]: { reason: "理由" } },
      },
    });
    expect(resMissing.status).toBe(400);

    // accepted 非布尔
    const resNotBool = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: {
        claimAdjudication: { [childId]: { accepted: "yes", reason: "理由" } },
      },
    });
    expect(resNotBool.status).toBe(400);
    const body = (await resNotBool.json()) as { message: string };
    expect(body.message).toContain(childId);
    expect(body.message).toContain("accepted");
  });

  it("outside_window 子任务同样需表态(与 not_found 行为一致)", async () => {
    const coordinator = await register("ca-coord-e");
    const group = await createGroup(coordinator.id, "ca-e");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const childId = await addChild(
      group.id,
      task.id,
      coordinator.id,
      "outside_window",
    );

    // 无表态 → 400,点明 outside_window
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain(childId);
    expect(body.message).toContain("outside_window");

    // 补表态 → 200
    const ok = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: adjudication(
        childId,
        true,
        "提交早于时间窗,但已核对为合法复用",
      ),
    });
    expect(ok.status).toBe(200);
  });

  // ---- 无需表态集合:skipped / verified ----

  it("skipped 子任务无需表态,无 claimAdjudication 也放行", async () => {
    const coordinator = await register("ca-coord-f");
    const group = await createGroup(coordinator.id, "ca-f");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    // R1 放行需要一个子任务;用 verified 子任务充当(不触发需表态)。
    await addChild(group.id, task.id, coordinator.id, "skipped");
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(200);
  });

  it("verified 子任务无需表态,无 claimAdjudication 也放行", async () => {
    const coordinator = await register("ca-coord-g");
    const group = await createGroup(coordinator.id, "ca-g");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    await addChild(group.id, task.id, coordinator.id, "verified");
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(200);
  });

  // ---- 多个需表态子任务 ----

  it("多个需表态子任务只给其一 → 400,点明缺哪个", async () => {
    const coordinator = await register("ca-coord-h");
    const group = await createGroup(coordinator.id, "ca-h");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    const first = await addChild(
      group.id,
      task.id,
      coordinator.id,
      "not_found",
    );
    const second = await addChild(
      group.id,
      task.id,
      coordinator.id,
      "outside_window",
    );
    expect(first).not.toBe(second);

    // 只表态 first,缺 second → 400 点名 second
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: adjudication(first, true, "已核对 first"),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain(second);
    expect(body.message).toContain("outside_window");

    // 两个都表态 → 200
    const ok = await patchTask(coordinator.id, group.id, task.id, {
      status: "done",
      diffSummary: {
        claimAdjudication: {
          [first]: { accepted: true, reason: "已核对 first" },
          [second]: { accepted: false, reason: "不采信 second,重新下发" },
        },
      },
    });
    expect(ok.status).toBe(200);
  });

  // ---- 回归:failed / 非协调任务 / noExecutionReason ----

  it("回归:子任务需表态但 PATCH failed → 本规则不生效", async () => {
    const coordinator = await register("ca-coord-i");
    const group = await createGroup(coordinator.id, "ca-i");
    const msg = await postMessage(coordinator.id, group.id, "协调任务");
    const task = await createTask(
      coordinator.id,
      group.id,
      msg.id,
      coordinator.id,
    );
    await addChild(group.id, task.id, coordinator.id, "not_found");
    const res = await patchTask(coordinator.id, group.id, task.id, {
      status: "failed",
      diffSummary: { error: "诚实的失败上报" },
    });
    expect(res.status).toBe(200);
  });

  it("回归:非协调任务(普通执行任务)落 done 行为完全不变", async () => {
    const coordinator = await register("ca-coord-j");
    const execA = await register("ca-exec-j");
    const group = await createGroup(coordinator.id, "ca-j");
    const msg = await postMessage(coordinator.id, group.id, "执行任务");
    // 执行器无 coordinator 角色 → 非 detached,不受本规则约束。
    const task = await createTask(coordinator.id, group.id, msg.id, execA.id);
    await addChild(group.id, task.id, execA.id, "not_found");
    // 即使子任务需表态且协调者未表态,非协调任务仍放行。
    const res = await patchTask(execA.id, group.id, task.id, {
      status: "done",
    });
    expect(res.status).toBe(200);
  });

  it("无子任务的协调任务(走 noExecutionReason 逃生舱)不受本规则影响", async () => {
    const coordinator = await register("ca-coord-k");
    const group = await createGroup(coordinator.id, "ca-k");
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
});
