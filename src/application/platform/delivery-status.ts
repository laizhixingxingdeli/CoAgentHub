/**
 * 收件箱里的投递「现在还算不算数」——只读现算，不落盘。
 *
 * 为什么不让 Host 自己判：投递落盘时的状态早就过期了，第二次升级之后第一条
 * 升级的投递还躺在 pending 里，Host 把它当成「还有一问在等我」就会重复作答；
 * 反过来 L3 打回后重新交卷，旧结果的投递也不会自己消失。判定只能按 Mission
 * 当前的聚合状态现算，因此这里**不写、不 ACK、不过滤**：pending 的条数由仓储
 * 说了算，stillOpen 只多给一个提示，而且不读活动日志（判定必须廉价，每次读收件箱
 * 都要能算）。
 */

import type { Mission } from '../../kernel/index.ts';
import type { Delivery } from '../delivery.ts';
import { withDeliveryKey } from '../delivery.ts';
import type { PlatformContext } from './context.ts';
import { PlatformRuleError } from './context.ts';

const ESCALATION_KEY = /^escalated:(\d+)$/;
const RESULT_KEY_PREFIX = 'result:';

/** id 里第一段数字；没有数字的排在所有数字之后（-1）。 */
function idNumber(id: string): number {
  const match = /\d+/.exec(id);
  return match ? Number(match[0]) : -1;
}

/** a 是否比 b 更新（createdAt 降序，同刻按 id 里的数字降序，再按 id 字符串降序）。 */
function isNewer(a: Delivery, b: Delivery): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  const diff = idNumber(a.id) - idNumber(b.id);
  if (diff !== 0) return diff > 0;
  return a.id > b.id;
}

function resultStillOpen(
  mission: Mission,
  delivery: Delivery,
  sameMissionDeliveries: readonly Delivery[],
): boolean {
  // 只有等终审的时候「最新那份结果」才值得看；打回、已合并、取消之后都不等答复。
  if (mission.status !== 'awaiting_review') return false;
  const newest = sameMissionDeliveries
    .filter((row) => withDeliveryKey(row).idempotencyKey.startsWith(RESULT_KEY_PREFIX))
    .reduce<Delivery | undefined>((best, row) => (!best || isNewer(row, best) ? row : best), undefined);
  // 列表里没有 result 投递、或这一条已被更新的结果顶掉：都不再等答复。
  return newest?.id === delivery.id;
}

/**
 * 单条投递现在是否仍待处理。
 *
 * 键先从行上补习（旧行没有键），否则 result:legacy:* 认不出来、升级的第二次
 * 也会被当成第一次。
 */
export function deliveryStillOpen(
  mission: Mission | undefined,
  delivery: Delivery,
  sameMissionDeliveries: readonly Delivery[],
): boolean {
  const key = withDeliveryKey(delivery).idempotencyKey;
  // Mission 找不到（含已归档）：无从判断，宁可说还开着，也别让 Host 以为事情结了。
  if (!mission) return true;
  const escalation = ESCALATION_KEY.exec(key);
  if (escalation) {
    const entry = mission.escalations[Number(escalation[1])];
    // 没有这一条升级：可能是旧数据对不上，按仍开放处理，别吞掉问题。
    if (!entry) return true;
    // 已答复（不看答的是什么）就不再等 L3。
    return !entry.answeredAt;
  }
  if (key.startsWith(RESULT_KEY_PREFIX)) return resultStillOpen(mission, delivery, sameMissionDeliveries);
  return true;
}

/**
 * 给一批 pending 补上 stillOpen。返回值是新对象，既不改入参，也不把补上的
 * 幂等键写进结果——响应里只多这一个字段，存储形状保持不变。
 */
export async function annotateDeliveriesStillOpen(
  ctx: PlatformContext,
  pending: readonly Delivery[],
): Promise<Array<Delivery & { stillOpen: boolean }>> {
  // 同一次调用按 missionId 缓存：收件箱里同一 Mission 常常有好几条，逐条查会很贵。
  const missions = new Map<string, Mission | undefined>();
  const lists = new Map<string, readonly Delivery[]>();
  const load = async (missionId: string): Promise<{ mission: Mission | undefined; list: readonly Delivery[] }> => {
    if (!missions.has(missionId)) {
      try {
        missions.set(missionId, (await ctx.locate(missionId)).mission);
        lists.set(missionId, await ctx.deliveries.listForMission(missionId));
      } catch (error) {
        // 已归档 / 已删除的 Mission 让收件箱整页 500 是不可接受的：记为找不到。
        if (error instanceof PlatformRuleError && error.code === 'UNKNOWN_MISSION') {
          missions.set(missionId, undefined);
          lists.set(missionId, []);
        } else {
          throw error;
        }
      }
    }
    return { mission: missions.get(missionId), list: lists.get(missionId) ?? [] };
  };

  const rows: Array<Delivery & { stillOpen: boolean }> = [];
  for (const delivery of pending) {
    const { mission, list } = await load(delivery.missionId);
    rows.push({ ...delivery, stillOpen: deliveryStillOpen(mission, delivery, list) });
  }
  return rows;
}
