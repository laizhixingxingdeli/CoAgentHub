import { participant as participantTable } from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import { eq } from "drizzle-orm";
import type { DataBase } from "./database";

/**
 * 身份不存在与无权限的区分(specs/unknown-participant-is-not-forbidden.md)。
 *
 * 未知 participant 的 404 消息统一在这里生成,点明 id 与修复动作;去重告警
 * 也在这里维护(同一死 id 10 分钟内失败超过 20 次 → 只 warn 一次)。只改
 * 「错误的表达」,不改任何权限判定。
 */

/** 未知 participant 的 404 消息:含 id 与「重新注册并更新 COAGENTHUB_PARTICIPANT_ID」。 */
export function unknownParticipantMessage(id: string): string {
  return `参与方 ${id} 不存在(可能是数据库重建前的旧 id)。请重新注册并更新 COAGENTHUB_PARTICIPANT_ID。`;
}

/**
 * 去重告警窗口:同一不存在的 participant 在 10 分钟内失败超过 20 次时输出
 * 一条 warn(不是每次都输出)。只打日志,不做封禁、不做限流。
 */
const WARN_WINDOW_MS = 10 * 60 * 1000;
const WARN_THRESHOLD = 20;

/** id → 该 id 在窗口内的失败时间戳(升序)。 */
const failureTimes = new Map<string, number[]>();
/** id → 当前窗口是否已输出过 warn(去重标记)。 */
const warnedInWindow = new Map<string, boolean>();

/**
 * 记录一次「未知 participant」失败。若同一 id 在 10 分钟窗口内失败次数超过
 * 阈值且本窗口尚未 warn,则输出一条 warn;窗口滑过阈值以下后允许下一窗口
 * 再次 warn(旧时间戳被剪掉,count 回落到阈值内即重置去重标记)。
 */
export function recordUnknownParticipantFailure(id: string): void {
  const now = Date.now();
  const recent = (failureTimes.get(id) ?? []).filter(
    (t) => now - t < WARN_WINDOW_MS,
  );
  recent.push(now);
  failureTimes.set(id, recent);

  if (recent.length > WARN_THRESHOLD && !warnedInWindow.get(id)) {
    warnedInWindow.set(id, true);
    console.warn(`[participant] ${unknownParticipantMessage(id)}`);
  } else if (recent.length <= WARN_THRESHOLD) {
    // 窗口滑过阈值以下 → 允许下一窗口再次告警。
    warnedInWindow.set(id, false);
  }
}

/** 测试专用:清空去重告警状态。 */
export function resetUnknownParticipantWarnState(): void {
  failureTimes.clear();
  warnedInWindow.clear();
}

/**
 * 记录一次失败并抛出 404(带 id 与修复建议)。用于路由在「路径 participant
 * 不存在」时统一收口,避免各处手写消息与去重记录。
 */
export function throwParticipantNotFound(id: string): never {
  recordUnknownParticipantFailure(id);
  throw new BizError(BizCodeEnum.ParticipantNotFound, unknownParticipantMessage(id));
}

/**
 * 断言路径 participant 存在;不存在 → 404 + 记录去重告警。存在但调用者 id
 * 不符的 403 判定留在各路由(措辞逐字不变,回归必测)。
 */
export async function assertPathParticipantExists(
  db: DataBase,
  id: string,
): Promise<void> {
  const [row] = await db
    .select({ id: participantTable.id })
    .from(participantTable)
    .where(eq(participantTable.id, id))
    .limit(1);
  if (!row) {
    recordUnknownParticipantFailure(id);
    throw new BizError(BizCodeEnum.ParticipantNotFound, unknownParticipantMessage(id));
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 群消息路由:声明的 sender 身份必须存在。缺失/非法 header 回落 Local User
 * (宽容,与中间件一致),不在此报 404;仅「明确声称了一个不存在的 id」才
 * 返回 404 点明身份问题,而不是回落 Local User 后误报 403「不是本群成员」。
 */
export async function assertClaimedSenderExists(
  db: DataBase,
  claimedId: string | undefined,
): Promise<void> {
  if (!claimedId || !UUID_RE.test(claimedId)) return;
  const [row] = await db
    .select({ id: participantTable.id })
    .from(participantTable)
    .where(eq(participantTable.id, claimedId))
    .limit(1);
  if (!row) {
    recordUnknownParticipantFailure(claimedId);
    throw new BizError(BizCodeEnum.ParticipantNotFound, unknownParticipantMessage(claimedId));
  }
}
