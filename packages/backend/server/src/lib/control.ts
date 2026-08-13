/**
 * 群控制指令(阶段2-票2):「停止 / stop」终止运行中任务的进程组;「回滚
 * <taskId>」git reset --hard 到执行前快照(refs/coagenthub-cp/<taskId>,
 * task.checkpoint_ref 由执行前快照写入)。指令识别放 server(executor-task
 * 之外独立成文件);双跑期桥的同类指令仍会响应,票3 退役桥后只剩 server。
 *
 * 门槛与桥一致:发送者须持 coordinator / human 角色;执行器 participant 自身发
 * 的回传不触发(防回环,发送者命中执行器配置即跳过)。停止携带 taskId
 * (「停止 <taskId>」)时仅终止该任务(当其 running);回滚 taskId 缺省时
 * 回滚该群最近一次带快照的任务。
 */

import {
  type Task,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import {
  checkpointRef,
  findRepoRoot,
  resetToCheckpoint,
} from "@server/lib/executor-runner";
import {
  currentRunningTask,
  postStatus,
  queuedExecutorTaskCount,
  stopRunningTask,
} from "@server/lib/executor-task";
import {
  type ExecutorConfig,
  effectiveExecutors,
  findExecutorByParticipantName,
} from "@server/lib/executors";
import { and, eq } from "drizzle-orm";

/** 与桥 EXEC_ALLOWED_ROLES 一致:只有 coordinator / human 能发控制指令。 */
const EXEC_ALLOWED_ROLES = ["coordinator", "human"] as const;

/** 「停止 [taskId]」/「stop [taskId]」;taskId 可缺省(终止当前运行任务)。 */
const STOP_RE = /^(?:停止|取消|停一下|stop)(?:\s+(\S+))?/i;
/** 「回滚 [taskId]」;taskId 可缺省(回滚最近一次快照)。 */
const ROLLBACK_RE = /^回滚\s*(\S+)?/;

export interface ControlCommandInput {
  groupId: string;
  senderId: string;
  senderRoles: string[];
  /** 消息 audience(与路由同值);定向到执行器 participant 的消息是任务,跳过。 */
  audience: "broadcast" | "role" | "participant";
  audienceRef: string | null;
  body: string;
}

/**
 * 触发入口(路由 fire-and-forget 调用,不 await):命中停止/回滚指令则执行
 * 并回传群;不命中/无权限/执行器自身消息则静默返回。
 */
export async function maybeHandleControlCommand(
  db: DataBase,
  input: ControlCommandInput,
): Promise<void> {
  const { groupId, senderId, senderRoles, audience, audienceRef, body } = input;

  // 与发布任务同角色门槛:非 coordinator/human 不执行。
  if (
    !senderRoles.some((r) =>
      (EXEC_ALLOWED_ROLES as readonly string[]).includes(r),
    )
  ) {
    console.log(
      `[control] 跳过:发送者角色 [${senderRoles.join(",")}] 无权限发控制指令`,
    );
    return;
  }

  // 防回环:执行器 participant 自己发的回传不触发(其名字命中执行器配置)。
  const sender = await db.query.participant.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.id, senderId),
  });
  if (sender && (await findExecutorByParticipantName(db, sender.name))) {
    console.log(`[control] 跳过:发送者是执行器 participant(防回环)`);
    return;
  }

  // 定向到执行器 participant 的消息是任务,不是控制指令(与桥 !ex 路由一致);
  // 定向到 hermes(规划 participant)的消息是讨论,同样不识别(与桥 !hermes 一致)。
  if (audience === "participant" && audienceRef) {
    const target = await db.query.participant.findFirst({
      where: (t, { eq: eqFn }) => eqFn(t.id, audienceRef!),
    });
    if (target && (await findExecutorByParticipantName(db, target.name))) {
      console.log(`[control] 跳过:定向到执行器 participant(视为任务)`);
      return;
    }
    if (target && target.type === "hermes") {
      console.log(`[control] 跳过:定向到 hermes 规划 participant(视为讨论)`);
      return;
    }
  }

  const rollback = body.match(ROLLBACK_RE);
  if (rollback) {
    await handleRollback(db, groupId, rollback[1] ?? null);
    return;
  }
  const stop = body.match(STOP_RE);
  if (stop) {
    await handleStop(db, groupId, stop[1] ?? undefined);
  }
}

/* ---------------- 停止 ---------------- */

/** 「停止 [taskId]」:kill 运行中任务的进程组 + 取消排队任务,回传 🛑。 */
async function handleStop(
  db: DataBase,
  groupId: string,
  taskId: string | undefined,
): Promise<void> {
  const stopped = stopRunningTask(taskId);
  if (stopped.length > 0) {
    const first = stopped[0];
    const label =
      stopped.length > 1
        ? `${first.taskId} 等 ${stopped.length} 个任务`
        : first.taskId;
    await postStatus(
      db,
      groupId,
      first.participantId,
      first.ex,
      `🛑 已停止 ${label}`,
    );
    return;
  }
  const fallback = await firstExecutorParticipant(db);
  if (!fallback) return;
  await postStatus(
    db,
    groupId,
    fallback.participantId,
    fallback.ex,
    taskId
      ? `⛔ 任务 ${taskId} 未在运行/排队(无法停止)`
      : "⛔ 当前没有执行中或排队的任务",
  );
}

/* ---------------- 回滚 ---------------- */

/** 「回滚 [taskId]」:git reset --hard 到执行前快照,回滚后 PATCH task failed。 */
async function handleRollback(
  db: DataBase,
  groupId: string,
  taskId: string | null,
): Promise<void> {
  const fallback = await firstExecutorParticipant(db);
  const reply = async (body: string) => {
    if (!fallback) {
      console.warn(
        `[control] 回传失败:无可用执行器 participant(${body.slice(0, 40)})`,
      );
      return;
    }
    await postStatus(db, groupId, fallback.participantId, fallback.ex, body);
  };

  // reset --hard 会破坏进行中的写入:有任务执行/排队时禁止回滚(与桥一致)。
  if (currentRunningTask() || queuedExecutorTaskCount() > 0) {
    await reply("⛔ 有任务执行中或排队中,请先「停止」再回滚");
    return;
  }

  // 定位快照 ref:taskId → task.checkpoint_ref;缺省 → 该群最近一次带快照任务。
  let task: Task | undefined;
  if (taskId) {
    task = await db.query.task.findFirst({
      where: (t, { and: andFn, eq: eqFn, or }) =>
        andFn(
          eqFn(t.groupId, groupId),
          or(eqFn(t.id, taskId), eqFn(t.messageId, taskId)),
        ),
    });
  } else {
    task = await db.query.task.findFirst({
      where: (t, { and: andFn, eq: eqFn, isNotNull }) =>
        andFn(eqFn(t.groupId, groupId), isNotNull(t.checkpointRef)),
      orderBy: (t, { desc: descFn }) => [descFn(t.createdAt)],
    });
  }
  let ref = task?.checkpointRef ?? null;
  if (!ref && taskId) {
    // 兼容:server 未登记 checkpoint_ref 时回退命名约定(refs/coagenthub-cp/<taskId>)。
    ref = checkpointRef(taskId);
  }
  if (!ref) {
    await reply("⛔ 没有可回滚的快照(尚无任务执行过)");
    return;
  }

  const res = resetToCheckpoint(ref, findRepoRoot());
  if (!res.ok) {
    await reply(`❌ 回滚失败: ${res.message}`);
    return;
  }
  // 回滚后 PATCH task failed(快照对应的任务视为未完成)。
  if (task) {
    await db
      .update(taskTable)
      .set({ status: "failed", diffSummary: { error: "rollback" } })
      .where(and(eq(taskTable.id, task.id), eq(taskTable.groupId, groupId)));
  }
  await reply(`✅ 已回滚到快照 ${res.message}`);
}

/* ---------------- 工具 ---------------- */

/** 取第一个在执行器配置中且有 participant 行的执行器(控制指令回传身份)。 */
async function firstExecutorParticipant(
  db: DataBase,
): Promise<{ participantId: string; ex: ExecutorConfig } | null> {
  for (const ex of await effectiveExecutors(db)) {
    const participant = await db.query.participant.findFirst({
      where: (t, { eq: eqFn }) => eqFn(t.name, ex.agentName),
    });
    if (participant) return { participantId: participant.id, ex };
  }
  return null;
}
