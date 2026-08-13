/**
 * Server 内嵌执行器触发链路(阶段2-票1/票2):POST /groups/:id/messages 出现
 * audience=agent 且 audienceRef 命中执行器配置(agent.name === agentName)时,
 * server 直接建 task + spawn CLI 执行器,桥不再需要代为调度。
 *
 * 票2 全局串行队列:模块级 FIFO,同一时刻只允许一个执行器任务在跑,其余排队。
 * 触发链路:消息命中执行器 → 建 task(status=queued)→ 入队;worker 空闲时取
 * 队首 → PATCH task running → spawn → 完成 PATCH done/failed → 泵下一个。
 *
 * 双跑期(桥保持现状并行运行)防重复:
 *  - 建 task 用 message_id 唯一约束幂等(与 POST /tasks 同一逻辑,ON CONFLICT
 *    DO NOTHING + 重读既有行)——桥与 server 谁先建谁拿到 created,另一个
 *    读到既有行。
 *  - 既有 task 且状态 running/done 时跳过 spawn:桥已登记并正在执行/已执行完,
 *    不重复跑。queued 也跳过:是本 server 自己入过队的(桥只会建 running)。
 *    failed/cancelled 视为可重新执行。
 *
 * 重启兜底:server 启动时调用 recoverInterruptedTasks,把 DB 里 status 为
 * queued/running 的任务自动恢复为 failed(附原因 server-restart),不自动重跑
 * (保持简单,队列是内存态,持久化只做失败兜底)。
 *
 * 状态回传保持桥现有 emoji 状态条格式:📋 排队 / 🚀 开始执行 / ✅ 完成 /
 * ❌ 失败 / 🛑 停止,contentType=task_status 由前缀判定,与桥的
 * contentTypeFor 一致。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  agent as agentTable,
  groupMember as groupMemberTable,
  TASK_STATUSES,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import { runA2AExecutor } from "@server/lib/a2a-runner";
import type { DataBase } from "@server/lib/database";
import {
  createCheckpoint,
  type ExecutorRunResult,
  findRepoRoot,
  readTimeoutMs,
  runExecutor,
} from "@server/lib/executor-runner";
import {
  type ExecutorConfig,
  findExecutorByAgentName,
} from "@server/lib/executors";
import { insertGroupMessage } from "@server/lib/group-message";
import { wsHub } from "@server/lib/ws-hub";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

/** 与桥 EXEC_ALLOWED_ROLES 一致:只有 coordinator / human 能发布任务。 */
const EXEC_ALLOWED_ROLES = ["coordinator", "human"] as const;

/** 与桥 contentTypeFor 一致:状态类 emoji 前缀 → task_status。 */
const STATUS_EMOJI_RE = /^[📋🚀✅❌🛑]/u;

const ANSI_RE =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export interface DispatchExecutorInput {
  groupId: string;
  messageId: string;
  senderRoles: string[];
  /** audienceRef = 被 @ 的 agent id(即执行器 agent 身份)。 */
  audienceRef: string;
  body: string;
}

/** 群内分工信息(角色解绑后):成员在本群的角色集 + 分工提示词,拼进任务书。 */
export interface GroupPromptInfo {
  roles: string[];
  prompt: string;
}

/** 队列条目:一次待执行/执行中的运行。 */
interface QueuedRun {
  db: DataBase;
  groupId: string;
  messageId: string;
  taskId: string;
  agentId: string;
  ex: ExecutorConfig;
  body: string;
  summary: string;
  /** 群内分工(角色解绑后);成员在本群无 prompt 时为 null,任务书不含该段。 */
  groupPrompt: GroupPromptInfo | null;
  /** 运行中句柄的 kill(停止指令用);spawn 前为 null。 */
  kill: (() => void) | null;
  /** 停止指令已终止本任务(完成回调不再回传 ❌,改置 cancelled)。 */
  stopped: boolean;
}

/**
 * 全局串行队列(模块级,票2):同一时刻至多一个执行器任务在跑,其余 FIFO
 * 排队。runningRun 非空时 pumpQueue 直接返回,完成后泵下一个。
 */
const runQueue: QueuedRun[] = [];
let runningRun: QueuedRun | null = null;

/** 排队中(未开始)任务数;回滚指令前置校验用。 */
export function queuedExecutorTaskCount(): number {
  return runQueue.length;
}

/**
 * 测试专用:终止运行中任务并清空队列(模块级状态跨测试文件/用例共享,
 * 避免前一个用例残留的 running/queued 影响后续断言)。仅测试调用。
 */
export function __resetExecutorQueueForTests(): void {
  if (runningRun) {
    runningRun.stopped = true;
    runningRun.kill?.();
  }
  runningRun = null;
  runQueue.length = 0;
}

/**
 * 重启兜底(server 启动时调用):把 DB 里 status=queued/running 且属于本
 * server 的任务(executor_key 非空)恢复为 failed(附原因 server-restart),
 * 不自动重跑。返回受影响行数。
 *
 * 只回收本 server 直接 spawn 的任务:双跑期桥也会建 running 任务(executor_key
 * 为空),若一并置 failed,同消息再次投递会被当作 failed 重新执行 → 与桥并行
 * 双跑。executor_key 非空 = server 自己登记的任务,重启后确认是孤儿。
 */
export async function recoverInterruptedTasks(db: DataBase): Promise<number> {
  const rows = await db
    .update(taskTable)
    .set({ status: "failed", diffSummary: { error: "server-restart" } })
    .where(
      and(
        inArray(taskTable.status, ["queued", "running"]),
        isNotNull(taskTable.executorKey),
      ),
    )
    .returning({ id: taskTable.id });
  if (rows.length > 0) {
    console.log(
      `[executor] 重启兜底:${rows.length} 个 queued/running 任务置为 failed (server-restart)`,
    );
  }
  return rows.length;
}

/** 当前运行中的任务(停止指令用);无则 null。 */
export function currentRunningTask(): {
  taskId: string;
  agentId: string;
  ex: ExecutorConfig;
  kill: () => void;
} | null {
  return runningRun && runningRun.kill
    ? {
        taskId: runningRun.taskId,
        agentId: runningRun.agentId,
        ex: runningRun.ex,
        kill: runningRun.kill,
      }
    : null;
}

/**
 * 停止指定任务:taskId 缺省时取消全部排队 + 终止当前运行任务;携带 taskId
 * 时仅终止该任务(排队中则移出队列置 cancelled,运行中则 kill 进程组)。
 * 返回所有被停止的任务信息(未命中 → 空数组)。
 *
 * 运行中任务即使 kill 句柄尚未就绪(spawn 前窗口)也会标记 stopped,
 * pumpQueue 会在 spawn 前中止,不会出现「停止指令已执行但任务照跑」。
 */
export function stopRunningTask(taskId?: string): Array<{
  taskId: string;
  agentId: string;
  ex: ExecutorConfig;
}> {
  const stopped: Array<{
    taskId: string;
    agentId: string;
    ex: ExecutorConfig;
  }> = [];

  // 排队中的任务:taskId 缺省 → 全部取消(与桥 handleCancel 一致);指定 →
  // 仅取消匹配项。排队任务未 spawn,直接移出队列 + 置 cancelled。
  const remaining: QueuedRun[] = [];
  for (const q of runQueue) {
    if (taskId && q.taskId !== taskId) {
      remaining.push(q);
      continue;
    }
    stopped.push({ taskId: q.taskId, agentId: q.agentId, ex: q.ex });
    void markTaskCancelled(q.db, q.taskId, q.groupId);
  }
  runQueue.length = 0;
  runQueue.push(...remaining);

  // 运行中任务:taskId 缺省 → 当前运行;指定 → 仅当其 running 才终止。
  if (runningRun && (!taskId || runningRun.taskId === taskId)) {
    runningRun.stopped = true;
    runningRun.kill?.();
    stopped.push({
      taskId: runningRun.taskId,
      agentId: runningRun.agentId,
      ex: runningRun.ex,
    });
  }
  return stopped;
}

/** 直接落库置 cancelled(停止指令取消排队/已运行任务用)。 */
function markTaskCancelled(
  db: DataBase,
  taskId: string,
  groupId: string,
): Promise<unknown> {
  return db
    .update(taskTable)
    .set({ status: "cancelled", diffSummary: { error: "stopped" } })
    .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)));
}

/**
 * 触发入口(路由 fire-and-forget 调用,不 await):命中执行器配置则
 * 幂等建 task + 入队;不命中/无权限/桥已执行则静默返回。
 */
export async function maybeDispatchExecutorTask(
  db: DataBase,
  input: DispatchExecutorInput,
): Promise<void> {
  const { groupId, messageId, senderRoles, audienceRef, body } = input;

  // 与桥相同的角色门槛:非 coordinator/human 不执行(桥侧也会拒绝)。
  if (
    !senderRoles.some((r) =>
      (EXEC_ALLOWED_ROLES as readonly string[]).includes(r),
    )
  ) {
    console.log(
      `[executor] 跳过:发送者角色 [${senderRoles.join(",")}] 无权限发布任务`,
    );
    return;
  }

  // audienceRef → agent → executor 配置(按 name 匹配,与桥注册的 agent 名一致)。
  const agent = await db.query.agent.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.id, audienceRef),
  });
  if (!agent) {
    console.log(`[executor] 跳过:audienceRef ${audienceRef} 无对应 agent`);
    return;
  }
  const ex = await findExecutorByAgentName(db, agent.name);
  if (!ex) {
    console.log(`[executor] 跳过:agent ${agent.name} 不在执行器配置中`);
    return;
  }

  // 角色解绑后:查目标成员在本群的分工(roles + prompt);prompt 非空才拼进任务书。
  const membership = await db.query.groupMember.findFirst({
    where: (t, { and: andFn, eq: eqFn }) =>
      andFn(eqFn(t.groupId, groupId), eqFn(t.agentId, agent.id)),
  });
  const groupPrompt: GroupPromptInfo | null =
    membership && membership.prompt
      ? { roles: membership.roles, prompt: membership.prompt }
      : null;

  await dispatchTask(db, {
    groupId,
    messageId,
    agentId: agent.id,
    ex,
    body,
    groupPrompt,
  });
}

/** 幂等建 task(复用 POST /tasks 的 message_id 唯一逻辑)后入队。 */
async function dispatchTask(
  db: DataBase,
  opts: {
    groupId: string;
    messageId: string;
    agentId: string;
    ex: ExecutorConfig;
    body: string;
    groupPrompt: GroupPromptInfo | null;
  },
): Promise<void> {
  const { groupId, messageId, agentId, ex, body, groupPrompt } = opts;

  const [created] = await db
    .insert(taskTable)
    .values({
      groupId,
      messageId,
      executorAgentId: agentId,
      executorKey: ex.key,
      status: "queued",
    })
    .onConflictDoNothing({ target: taskTable.messageId })
    .returning();

  const task = created ?? (await findTaskByMessage(db, messageId));
  if (!task) {
    console.error(`[executor] task 登记失败(messageId=${messageId})`);
    return;
  }
  if (!created) {
    // 桥(或本 server 先前一次触发)已登记该消息:running/done 跳过(避免
    // 双跑);queued 是本 server 自己入过队的,同样跳过;failed/cancelled
    // 视为可重新执行。
    if (
      task.status === "running" ||
      task.status === "done" ||
      task.status === "queued"
    ) {
      console.log(
        `[executor] 跳过 spawn:task ${task.id} 已存在且状态 ${task.status}(桥可能已在执行)`,
      );
      return;
    }
    console.log(`[executor] 既有 task ${task.id} 状态 ${task.status},重新执行`);
  }

  const summary = summaryOf(body);
  const ahead = (runningRun ? 1 : 0) + runQueue.length;
  if (ahead > 0) {
    // 只有真正排队才回传 📋(与桥一致)。
    await postStatus(
      db,
      groupId,
      agentId,
      ex,
      `📋 [${ex.label}] 任务已排队(前面还有 ${ahead} 个): ${summary}`,
    );
  }

  runQueue.push({
    db,
    groupId,
    messageId,
    taskId: task.id,
    agentId,
    ex,
    body,
    summary,
    groupPrompt,
    kill: null,
    stopped: false,
  });
  void pumpQueue();
}

/** 取队首运行:queued → running → spawn → done/failed → 泵下一个。 */
async function pumpQueue(): Promise<void> {
  if (runningRun) return;
  const run = runQueue.shift();
  if (!run) return;
  runningRun = run;
  const { db, groupId, taskId, agentId, ex, body, summary, groupPrompt } = run;

  try {
    // 停止指令可能在 spawn 前到达(kill 句柄尚未就绪):标记 stopped 后
    // 在此中止,不再 spawn,直接置 cancelled。
    if (run.stopped) {
      console.log(`[executor] 任务已在 spawn 前被停止: ${taskId}`);
      await markTaskCancelled(db, taskId, groupId);
      return;
    }

    // queued → running(尽力而为;失败不阻塞执行,终态仍会回写)。
    try {
      await db
        .update(taskTable)
        .set({ status: "running" })
        .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)));
    } catch (e) {
      console.warn(`[executor] 置 running 失败(${taskId}): ${e}`);
    }

    // 🚀 开始执行(与桥的 emoji 状态条一致)。
    await postStatus(
      db,
      groupId,
      agentId,
      ex,
      `🚀 [${ex.label}] 开始执行:${summary}`,
    );

    const repoRoot = findRepoRoot();
    // 按 kind 分流:cli 写 ticket + 打本地 git 快照后 spawn;a2a 不发 ticket、
    // 不打快照(远端设备执行,本地快照无意义),body 直接当 prompt 发 gateway。
    // 二者都走同一 handle 形状,后续 done/failed/超时回传逻辑共用。
    const isA2a = ex.kind === "a2a";
    let handle: { promise: Promise<ExecutorRunResult>; kill: () => void };
    if (isA2a) {
      const a2aUrl = ex.a2a?.url ?? "";
      console.log(
        `[executor] a2a 调用: ${a2aUrl} (agent=${ex.agentName}, task=${taskId})`,
      );
      handle = {
        promise: runA2AExecutor({
          url: a2aUrl,
          token: ex.a2a?.token ?? "",
          prompt: body,
          timeoutMs: readTimeoutMs(),
        }),
        // 远端调用无本地进程可杀:停止指令靠完成后 run.stopped 检查置 cancelled。
        kill: () => {},
      };
    } else {
      const ticketPath = `/tmp/coagenthub-ticket-${Date.now()}.md`;
      try {
        writeFileSync(
          ticketPath,
          buildTicket(body, ex.label, repoRoot, groupPrompt),
        );
      } catch (e) {
        await failTask(db, taskId, `任务书写入失败: ${e}`);
        await postStatus(
          db,
          groupId,
          agentId,
          ex,
          `❌ [${ex.label}] 任务失败: 任务书写入失败 (${e})`,
        );
        return;
      }

      // 执行前 git 快照(回滚指令用;与桥 createCheckpoint 一致):失败则中止
      // 任务,不做无回滚保护的执行。快照 ref 写回 task.checkpoint_ref。
      try {
        const cp = createCheckpoint(taskId, repoRoot);
        await db
          .update(taskTable)
          .set({ checkpointRef: cp.ref })
          .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[executor] 执行前快照失败(${taskId}): ${msg}`);
        await failTask(db, taskId, `执行前快照失败: ${msg}`);
        await postStatus(
          db,
          groupId,
          agentId,
          ex,
          `❌ [${ex.label}] 任务失败: 执行前快照失败 (${msg})`,
        );
        return;
      }

      // hermes 之类的 agent 需要提示词文本而不是文件路径:{ticketContent}
      // 把刚写好的任务书全文内联进参数。
      const ticketContent = readFileSync(ticketPath, "utf8");
      const args = ex.args.map((a) =>
        a
          .replaceAll("{ticket}", ticketPath)
          .replaceAll("{ticketContent}", ticketContent),
      );
      console.log(
        `[executor] server 侧 spawn: ${ex.bin} ${args.join(" ")} (cwd=${repoRoot}, task=${taskId})`,
      );
      handle = runExecutor({
        bin: ex.bin,
        args,
        cwd: repoRoot,
        onOutput: (chunk) => {
          // 流式日志:便于后续回传群(本轮先落 server 日志)。
          process.stdout.write(chunk);
        },
      });
    }
    run.kill = handle.kill;

    try {
      const result = await handle.promise;
      // 停止指令已 kill 进程组:完成回调置 cancelled,不再回传 ❌/✅(停止
      // 指令自己已回传 🛑)。
      if (run.stopped) {
        console.log(`[executor] 任务已停止: ${taskId}`);
        await db
          .update(taskTable)
          .set({ status: "cancelled", diffSummary: { error: "stopped" } })
          .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)));
        return;
      }
      if (result.timedOut) {
        console.error(`[executor] 任务超时: ${taskId}`);
        await failTask(db, taskId, "执行超时");
        await postStatus(
          db,
          groupId,
          agentId,
          ex,
          `❌ [${ex.label}] 任务失败 (超时)`,
        );
        return;
      }
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      if (result.code === 0) {
        const hash = findCommitHash(output);
        // a2a 执行器(远端 agent)的回复就是最终交付内容,直接作为 summary,
        // 不过 extractSummary 的关键词截取(汇报/做了什么/commit 段)。
        const summaryText = isA2a
          ? (result.stdout ?? "").trim()
          : extractSummary(output);
        const diffSummary: Record<string, unknown> = { summary: summaryText };
        if (hash) diffSummary.hash = hash;
        await db
          .update(taskTable)
          .set({ status: "done", diffSummary })
          .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)));
        console.log(
          `[executor] 任务完成: ${taskId}${hash ? ` hash=${hash}` : ""}`,
        );
        const body = `✅ [${ex.label}] 任务完成${hash ? ` (commit ${hash})` : ""}\n${summaryText}`;
        await postStatus(db, groupId, agentId, ex, body.slice(0, 2000));
      } else {
        const tail = lastLinesOf(output, 20).slice(0, 1500);
        console.error(`[executor] 任务失败 exit=${result.code}: ${taskId}`);
        await failTask(db, taskId, `exit ${result.code}`);
        await postStatus(
          db,
          groupId,
          agentId,
          ex,
          `❌ [${ex.label}] 任务失败 (exit ${result.code})\n${tail}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[executor] 执行器启动失败: ${msg}`);
      await failTask(db, taskId, msg);
      await postStatus(
        db,
        groupId,
        agentId,
        ex,
        `❌ [${ex.label}] 任务失败: 无法启动 ${ex.bin} (${msg})`,
      );
    }
  } finally {
    runningRun = null;
    void pumpQueue();
  }
}

async function findTaskByMessage(db: DataBase, messageId: string) {
  return db.query.task.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.messageId, messageId),
  });
}

/** 直接落库置 failed(server 是状态源;PATCH 端点是给外部执行器客户端的)。 */
async function failTask(
  db: DataBase,
  taskId: string,
  reason: string,
): Promise<void> {
  await db
    .update(taskTable)
    .set({ status: "failed", diffSummary: { error: reason } })
    .where(eq(taskTable.id, taskId));
}

/** 以执行器 agent 身份回传群消息(broadcast + 前缀判定 contentType)。 */
export async function postStatus(
  db: DataBase,
  groupId: string,
  senderId: string,
  ex: ExecutorConfig,
  body: string,
): Promise<void> {
  try {
    const full = await insertGroupMessage(db, {
      groupId,
      senderId,
      parentId: null,
      audience: "broadcast",
      audienceRef: null,
      body,
      contentType: STATUS_EMOJI_RE.test(body) ? "task_status" : "text/plain",
      fileRef: null,
    });
    // 与 POST /messages 一致的火力外扇出:WS,让群里实时可见。
    void wsHub.broadcastGroupMessage(full);
  } catch (e) {
    console.warn(`[executor] 状态回传失败(${ex.label}):`, e);
  }
}

/** 与桥 buildTicket 一致的执行器任务书格式。 */
function buildTicket(
  body: string,
  label: string,
  repoRoot: string,
  groupPrompt: GroupPromptInfo | null = null,
): string {
  const lines = [
    `# CoAgentHub 任务(网页 @executor 发布)`,
    ``,
    `你是 ${label}。任务:${body}`,
  ];
  // 角色解绑后:成员在本群有分工提示词时,任务书插入「本群分工」段(先角色后
  // 提示词原文);无 prompt 时整段不输出,任务书与解绑前完全一致。
  if (groupPrompt && groupPrompt.prompt.trim().length > 0) {
    lines.push(
      `本群分工:角色=[${groupPrompt.roles.join(",")}];提示词=${groupPrompt.prompt}`,
    );
  }
  lines.push(
    `仓库:${repoRoot}(分支 main)`,
    `默认约束(除非消息里明确说明):不动 schema/迁移/scripts/ 下其他脚本、不删数据;测试全绿后提交,commit message 按功能写。`,
    `汇报:中文,做了什么/测试结果/commit hash。`,
  );
  return lines.join("\n");
}

function summaryOf(body: string): string {
  return body.replace(/\s+/g, " ").slice(0, 40);
}

function lastLinesOf(text: string, lines: number): string {
  const clean = (text ?? "").replace(ANSI_RE, "").trim();
  const arr = clean.split("\n").filter((l) => l.trim());
  return arr.slice(-lines).join("\n");
}

/** 从输出取 commit hash(40 位 hex 或 "commit/hash: xxx" 短格式)。 */
function findCommitHash(text: string): string | null {
  const clean = (text ?? "").replace(ANSI_RE, "");
  const full = clean.match(/[0-9a-f]{40}/);
  if (full) return full[0].slice(0, 12);
  const short = clean.match(/(?:commit|hash)\s*[:：]?\s*([0-9a-f]{7,12})/i);
  return short ? short[1] : null;
}

/** 与桥 extractSummary 一致:取「汇报/做了什么/测试结果/commit」段或末尾 15 行。 */
function extractSummary(text: string): string {
  const clean = (text ?? "").replace(ANSI_RE, "");
  const lines = clean.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/汇报|做了什么|测试结果|commit/.test(lines[i])) {
      start = i;
      break;
    }
  }
  const slice = start >= 0 ? lines.slice(start) : lines.slice(-15);
  let out = slice.join("\n").trim();
  if (out.length > 2000) out = out.slice(0, 2000) + "\n…(截断)";
  return out;
}
