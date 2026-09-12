import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import type { ExecutorConfig } from "@server/lib/executors";
import { eq } from "drizzle-orm";
import {
  clearPersistedExecutorCooldown,
  listPersistedExecutorCooldowns,
} from "./cooldown-store";
import { applyDiffSummaryPatch } from "./diff-summary";
import { requestPump } from "./pump-signal";
import {
  cooldownTimers,
  type ExecutorCooldownSource,
  executorCooldownRecords,
  executorCooldowns,
  formatEta,
  getRateLimitCooldownMs,
} from "./state";

/* ---------------- 额度感知调度(票7) ---------------- */

/**
 * 执行器进入额度冷却:记录冷却结束时间并调度到期泵送(冷却结束后 pumpQueue
 * 自动把等待中的任务派发出去,无需人工干预)。重复进入只重置结束时间与定时器
 * (定时器防堆积)。返回冷却结束时间(epoch ms)。
 *
 * endMs 为绝对到期时刻(冷却动态化):调用方先尝试从失败输出解析恢复时间
 * (parseRateLimitRecoveryMs),解析失败才回退 now + 固定冷却时长。
 *
 * R7:解析出的时刻不在未来或过于接近当前时,回退到固定冷却兜底,避免产出
 * 形同虚设的冷却(如 1ms / 15s)。
 */
export const MIN_EFFECTIVE_COOLDOWN_MS = 60_000;

export function normalizeCooldownEnd(
  endMs: number,
  nowMs = Date.now(),
): number {
  if (endMs <= nowMs + MIN_EFFECTIVE_COOLDOWN_MS) {
    return nowMs + getRateLimitCooldownMs();
  }
  return endMs;
}

export function enterCooldown(
  ex: Pick<ExecutorConfig, "key" | "label">,
  endMs: number,
  sourceOrPersisted:
    | ExecutorCooldownSource
    | { db: DataBase; taskId: string } = "fallback",
  persisted?: { db: DataBase; taskId: string },
): number {
  // Keep the pre-source call shape usable by existing internal/test callers;
  // production call sites pass the source explicitly.
  const source: ExecutorCooldownSource =
    typeof sourceOrPersisted === "string" ? sourceOrPersisted : "fallback";
  const effectivePersisted =
    typeof sourceOrPersisted === "string" ? persisted : sourceOrPersisted;
  const previous = executorCooldownRecords.get(ex.key);
  const isActive = previous !== undefined && previous.endMs > Date.now();
  const discarded =
    source === "fallback" && previous?.source === "parsed" && isActive
      ? endMs
      : undefined;
  const end =
    discarded !== undefined
      ? (previous?.endMs ?? endMs)
      : previous === undefined ||
          previous.endMs <= Date.now() ||
          (source === "parsed" && previous.source === "fallback")
        ? endMs
        : Math.max(previous.endMs, endMs);
  const record = {
    endMs: end,
    source: discarded === undefined ? source : (previous?.source ?? source),
    taskId: effectivePersisted?.taskId ?? previous?.taskId,
  } satisfies import("./state").ExecutorCooldownRecord;
  executorCooldownRecords.set(ex.key, record);
  executorCooldowns.set(ex.key, end);
  if (discarded !== undefined) {
    console.log(
      `[executor] 丢弃 ${ex.key} fallback 冷却 ${endMs},已有 parsed 冷却 ${end}:仍未到期`,
    );
    if (effectivePersisted)
      void appendCooldownAudit(
        effectivePersisted.db,
        effectivePersisted.taskId,
        end,
        source,
        discarded,
      );
  }
  const prev = cooldownTimers.get(ex.key);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(
    () => {
      // 竞态保护:冷却可能已被更新的 enterCooldown 重置/延长;只有本定时器仍是
      // 当前登记项时才清理,避免陈旧回调误删新冷却条目(提前解除冷却)。
      if (cooldownTimers.get(ex.key) !== timer) return;
      cooldownTimers.delete(ex.key);
      executorCooldowns.delete(ex.key);
      executorCooldownRecords.delete(ex.key);
      console.log(`[executor] 执行器 ${ex.key} 额度冷却结束,恢复派发`);
      if (effectivePersisted) {
        void clearPersistedExecutorCooldown(
          effectivePersisted.db,
          effectivePersisted.taskId,
        ).catch((error) => {
          console.warn(
            `[executor] 清理持久化额度冷却失败(${ex.key}): ${error}`,
          );
        });
      }
      requestPump();
    },
    Math.max(1, end - Date.now()),
  );
  cooldownTimers.set(ex.key, timer);
  console.log(
    `[executor] 执行器 ${ex.key} 触发额度冷却,预计 ${formatEta(end)} 恢复`,
  );
  return end;
}

async function appendCooldownAudit(
  db: DataBase,
  taskId: string,
  endMs: number,
  source: ExecutorCooldownSource,
  discardedEndMs: number,
): Promise<void> {
  const row = await db.query.task.findFirst({
    where: (task, { eq }) => eq(task.id, taskId),
    columns: { diffSummary: true },
  });
  const next = applyDiffSummaryPatch(row?.diffSummary, {
    executorCooldownSource: source,
    executorCooldownEndMs: endMs,
    discardedCooldownEndMs: discardedEndMs,
    cooldownDiscardReason: "已有未到期 parsed 冷却,拒绝 fallback 覆盖",
  });
  await db
    .update(taskTable)
    .set({ diffSummary: next })
    .where(eq(taskTable.id, taskId));
}

/**
 * 服务启动恢复额度冷却:每个 executorKey 采用最新一条未过期的 task 记录,
 * 重建内存判定状态与到期定时器;过期或被更新记录立即清理,不得复活。
 */
export async function restoreExecutorCooldowns(
  db: DataBase,
  nowMs = Date.now(),
): Promise<number> {
  const records = await listPersistedExecutorCooldowns(db);
  const seenKeys = new Set<string>();
  const restoredKeys = new Set<string>();

  for (const record of records) {
    // 最新记录决定该执行器的重启前最终状态。即使最新记录已过期,也不能继续
    // 向后寻找更老但到期更晚的记录,否则会把已结束的旧冷却复活。
    if (seenKeys.has(record.executorKey)) {
      await clearPersistedExecutorCooldown(db, record.taskId);
      continue;
    }
    seenKeys.add(record.executorKey);
    if (record.endMs <= nowMs) {
      await clearPersistedExecutorCooldown(db, record.taskId);
      continue;
    }
    restoredKeys.add(record.executorKey);
    enterCooldown(
      { key: record.executorKey, label: record.executorKey },
      record.endMs,
      record.source ?? "fallback",
      { db, taskId: record.taskId },
    );
  }

  if (restoredKeys.size > 0) {
    console.log(
      `[executor] 启动恢复:${restoredKeys.size} 个执行器仍处于额度冷却`,
    );
  }
  return restoredKeys.size;
}

/**
 * R4(specs/quota-misclassified-from-coordinator-narration.md):手动清除执行器
 * 额度冷却 —— 内存登记 + 到期定时器 + 持久化标记(task.diffSummary 的
 * executorCooldownEndMs/executorCooldownSource)一并清掉;否则重启时会被
 * restoreExecutorCooldowns 复活。清完后泵队列,让被冷却挡住的 queued 任务
 * 立即重试。幂等:本就无冷却时返回 cleared=false,不泵队列。
 *
 * ADR-0009:拿「读到的最新未过期标记」代替「逐条历史记录」判定要不要清;
 * 不成立的情形是有人手工改库回填更老记录 —— 老记录本就应被清除,顺带清掉
 * 无害(下一次真冷却会写入新标记)。
 */
export async function clearExecutorCooldown(
  db: DataBase,
  key: string,
): Promise<{ cleared: boolean; taskIds: string[] }> {
  const hadInMemory =
    executorCooldowns.has(key) || executorCooldownRecords.has(key);
  const timer = cooldownTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    cooldownTimers.delete(key);
  }
  executorCooldowns.delete(key);
  executorCooldownRecords.delete(key);

  // 持久化标记:该执行器最新一条未过期记录即判定状态;清掉它,重启不会复活。
  const taskIds: string[] = [];
  const persisted = await listPersistedExecutorCooldowns(db);
  for (const record of persisted) {
    if (record.executorKey !== key) continue;
    if (record.endMs <= Date.now()) continue;
    await clearPersistedExecutorCooldown(db, record.taskId);
    taskIds.push(record.taskId);
  }

  const cleared = hadInMemory || taskIds.length > 0;
  if (cleared) {
    console.log(
      `[executor] 手动清除执行器 ${key} 的额度冷却(内存=${hadInMemory},持久化任务=${taskIds.length}),立即恢复派发`,
    );
    requestPump();
  }
  return { cleared, taskIds };
}
