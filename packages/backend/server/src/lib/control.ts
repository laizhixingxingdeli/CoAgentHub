/**
 * 群控制指令(阶段2-票2):「停止 / stop」终止运行中任务的进程组;「回滚
 * <taskId>」git reset --hard 到执行前快照(refs/coagenthub-cp/<taskId>,
 * task.checkpoint_ref 由执行前快照写入)。指令识别放 server(executor-task
 * 之外独立成文件);双跑期桥的同类指令仍会响应,票3 退役桥后只剩 server。
 *
 * 门槛与桥一致:发送者须持 coordinator / human 角色;控制门只检查群内角色
 * (spec R3 / ADR-0008 第三条后,不再按「发送者命中执行器配置」跳过)。
 * 停止携带 taskId(「停止 <taskId>」)时仅终止该任务(当其 running);回滚
 * taskId 缺省时回滚该群最近一次带快照的任务。
 */

import {
  participant as participantTable,
  type Task,
} from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import {
  checkpointRef,
  findRepoRoot,
  resetToCheckpoint,
} from "@server/lib/executor-runner";
import {
  cancelQueuedTasks,
  cancelRunningTasks,
  currentRunningTask,
  mergeDiffSummary,
  postStatus,
  queuedExecutorTaskCount,
  writeTaskStatus,
} from "@server/lib/executor-task";
import { type ExecutorConfig, effectiveExecutors } from "@server/lib/executors";
import { inArray } from "drizzle-orm";

/** 控制门角色门槛(与下发门 DISPATCH_ALLOWED_ROLES 同值但语义分开):
 *  coordinator / human / reviewer 能发停止/回滚指令——human 禁言后,紧急
 *  停止只能由 reviewer 代发,因此两表相同却独立维护。 */
const CONTROL_ALLOWED_ROLES = ["coordinator", "human", "reviewer"] as const;

/** 「停止 [taskId]」/「stop [taskId]」;taskId 可缺省(终止当前运行任务)。 */
const STOP_RE = /^(?:停止|取消|停一下|stop)(?:\s+(\S+))?/i;
/** 「回滚 [taskId]」;taskId 可缺省(回滚最近一次快照)。 */
const ROLLBACK_RE = /^回滚\s*(\S+)?/;

/**
 * 「正文是否为停止/回滚控制指令」的唯一判定(派发入口与控制通道共用):命中
 * 同一 STOP_RE/ROLLBACK_RE 语义,不复制第二份正则(messages 派发入口用它
 * 避免给控制通道已处理的消息重复建任务)。ADR-0009:该判据以语法匹配代替
 * 「消息是否属于控制通道」;正文恰好以停止开头但语义并非停止任务(如「停止
 * 讨论,开始实现 X」)时不成立——既有歧义,明确保持按控制指令处理。
 */
export function isControlCommand(body: string): boolean {
  return ROLLBACK_RE.test(body) || STOP_RE.test(body);
}

/**
 * 「audience=participant 定向到该 participant 时,它在本群是否执行器任务目标」
 * 的唯一判定(messages 派发入口与控制通道共用)。
 *
 * ADR-0009 判据指名事实:
 *  ① 这个判据拿「本群成员角色 = executor(且 participant 绑定执行器 key)」
 *     代替什么?—— 代替「participant 是否绑定执行器 key」(仅看全局 key 绑定)
 *     作为「该 participant 是否 participant 定向执行器的任务目标」的判据。
 *  ② 那个代替在什么条件下不成立?—— 当一个 coordinator participant 为可被
 *     平台拉起而同时绑定执行器 key 时:它在本群的唯一角色是 coordinator,
 *     不应被当作执行器任务目标;仅看 key 绑定会把控制指令误分类成任务。
 *
 * 取本群角色而非 key 绑定,是因为 groupMember.roles 是「该 participant 在本
 * 群」的分工事实,而 executorKey 是跨群的全局身份——任务目标分类应以前者
 * 为准,同一事实不再有两套判定出处(派发入口与控制通道都用它)。
 *
 * 角色为 coordinator 时(即使绑 key),participant 定向它的是控制指令/协调
 * 消息,归控制通道,不是执行器任务;角色为 executor 时保持既有语义(视为任
 * 务)。绑定执行器 key 是派发的必要条件,故与角色合取(未绑 key 的 executor
 * 行既派不出任务也不应被分类为执行器任务目标)。
 */
export async function isExecutorTaskTarget(
  db: DataBase,
  participantId: string,
  groupId: string,
): Promise<boolean> {
  const target = await db.query.participant.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.id, participantId),
  });
  if (!target?.executorKey) return false;
  const membership = await db.query.groupMember.findFirst({
    where: (t, { and: andFn, eq: eqFn }) =>
      andFn(eqFn(t.participantId, participantId), eqFn(t.groupId, groupId)),
  });
  return membership?.roles.includes("executor") ?? false;
}

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
  const { groupId, senderRoles, audience, audienceRef, body } = input;

  // 控制门角色门槛:非 coordinator/human/reviewer 不执行。
  if (
    !senderRoles.some((r) =>
      (CONTROL_ALLOWED_ROLES as readonly string[]).includes(r),
    )
  ) {
    console.log(
      `[control] 跳过:发送者角色 [${senderRoles.join(",")}] 无权限发控制指令`,
    );
    return;
  }

  // 防回环:不再按「发送者命中执行器配置」跳过(spec R3 / ADR-0008 第三条——
  // 下发权只由群内角色裁定);发送者是否执行器 participant 与其是否可发控制
  // 指令无关,控制门只检查上面的 CONTROL_ALLOWED_ROLES 角色门槛。

  // 定向到执行器任务目标的消息是任务,不是控制指令(与桥 !ex 路由一致);
  // 定向到其他非执行器 participant 的消息按普通指令识别。目标分类用唯一判
  // 定 isExecutorTaskTarget(本群角色 = executor):coordinator participant
  // 即使绑定执行器 key 也不算执行器任务目标,控制指令照常执行(与派发入口
  // 共用同一事实,不另写判定)。
  if (
    audience === "participant" &&
    audienceRef &&
    (await isExecutorTaskTarget(db, audienceRef, groupId))
  ) {
    console.log(`[control] 跳过:定向到执行器任务目标(视为任务)`);
    return;
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

/**
 * 「停止 [taskId]」:取消本群排队中或运行中的任务(taskId 缺省 = 本群当前任务),
 * 回传 🛑。运行中任务先终止进程组并复用 cancelled 状态路径。
 */
async function handleStop(
  db: DataBase,
  groupId: string,
  taskId: string | undefined,
): Promise<void> {
  const stopped = cancelQueuedTasks(groupId, taskId);
  const runningStopped = await cancelRunningTasks(db, groupId, taskId);
  const allStopped = [...stopped, ...runningStopped];
  if (allStopped.length > 0) {
    const first = allStopped[0];
    const label =
      allStopped.length > 1
        ? `${first.taskId} 等 ${allStopped.length} 个任务`
        : first.taskId;
    await postStatus(
      db,
      groupId,
      first.participantId,
      first.ex,
      `🛑 已取消 ${label}`,
    );
    return;
  }
  const fallback = await firstExecutorParticipant(db);
  if (!fallback) return;
  if (taskId) {
    await postStatus(
      db,
      groupId,
      fallback.participantId,
      fallback.ex,
      `⛔ 当前没有排队中的任务 ${taskId}`,
    );
    return;
  }
  await postStatus(
    db,
    groupId,
    fallback.participantId,
    fallback.ex,
    "⛔ 当前没有排队中的任务",
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

  // reset --hard 会破坏进行中的写入:本群有任务执行/排队时禁止回滚(与桥一致,
  // 按群隔离——A 群执行中不影响 B 群回滚)。
  if (currentRunningTask(groupId) || queuedExecutorTaskCount(groupId) > 0) {
    await reply("⛔ 有任务执行中或排队中,请等待完成后再回滚(本群判定)");
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

  const res = await resetToCheckpoint(ref, findRepoRoot());
  if (!res.ok) {
    await reply(`❌ 回滚失败: ${res.message}`);
    return;
  }
  // 回滚后 PATCH task failed(快照对应的任务视为未完成)。
  // 经 mergeDiffSummary 以 terminal 所有者写 error,保留 platform.* / audit 等
  // 他有键(spec diffsummary-ownership W2:禁止整袋只写 error)。
  if (task) {
    const next = mergeDiffSummary(
      task.diffSummary,
      { error: "rollback" },
      "terminal",
    );
    // 原路径不 notify、where 含 groupId;纯收敛对齐。
    // ⚠️ 合法跨终态:回滚指令故意把已 done 的任务改判为 failed
    // (「快照对应的任务视为未完成」)。S1 终态守卫不适用于此路径。
    await writeTaskStatus(db, {
      taskId: task.id,
      groupId,
      status: "failed",
      diffSummary: next,
      notify: false,
    });
  }
  await reply(`✅ 已回滚到快照 ${res.message}`);
}

/* ---------------- 工具 ---------------- */

/** 取第一个在执行器配置中且有 participant 行的执行器(控制指令回传身份)。 */
async function firstExecutorParticipant(
  db: DataBase,
): Promise<{ participantId: string; ex: ExecutorConfig } | null> {
  const executors = await effectiveExecutors(db);
  const participants = await db
    .select({ id: participantTable.id, name: participantTable.name })
    .from(participantTable)
    .where(
      inArray(
        participantTable.name,
        executors.map((ex) => ex.agentName),
      ),
    );
  const byName = new Map(participants.map((p) => [p.name, p]));
  for (const ex of executors) {
    const participant = byName.get(ex.agentName);
    if (participant) return { participantId: participant.id, ex };
  }
  return null;
}
