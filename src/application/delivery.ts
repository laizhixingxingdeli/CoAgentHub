/**
 * Delivery Inbox —— 结果回到发起方的持久投递。
 *
 * 为什么不是「把结果打印出来就完了」：发起 Mission 的那个会话可能已经关了。
 * 结果必须**留在收件箱里等**，Host 恢复后自己来取。Mission 结果不能丢。
 *
 * v1 刻意做得很薄：pending → acknowledged，没有租约、没有死信、没有重投计数。
 * 这些是被真实故障逼出来的东西，还没遇到就不建。
 *
 * **去重按业务幂等键，不按结局。** 早先是「同一 Mission 的同一种结局只投一次」：
 * 第二次升级（前一次已答复）和 L3 打回后的重新交卷都被当成重复吞掉，收件箱里
 * 永远看不到——而「进收件箱才叫升级」。键只由持久化状态决定，崩溃后重建同一条
 * 投递也不会多出一条（设计 §8.1–8.2）。
 */

import type { Clock, IdGenerator } from './ports.ts';

export interface Delivery {
  readonly id: string;
  readonly missionId: string;
  readonly projectId: string;
  /** 投给谁。取自 Mission 的 OriginChannel。 */
  readonly recipient: string;
  /**
   * escalated 也是一种投递：升级给 L3 的问题必须能被 L3 取到，
   * 否则"升级"只是在平台里写了一行字，没人知道。
   */
  readonly outcome: 'delivered' | 'blocked' | 'escalated';
  /**
   * 业务幂等键：同一 Mission 内同一个键只有一条投递。
   * 升级 `escalated:<该 Mission 的第几次升级>`；交卷 `result:<提交它的协调者 attempt | Lightweight 的验收报告>`。
   */
  readonly idempotencyKey: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly status: 'pending' | 'acknowledged';
  readonly acknowledgedAt?: string;
}

/** 升级的投递键：该 Mission 的第几次升级（从 0 数，与 mission.escalations 的下标一致）。 */
export function escalationDeliveryKey(index: number): string {
  return `escalated:${index}`;
}

/** 交卷的投递键：提交它的那一次（Standard 取协调者 attempt，Lightweight 取验收报告）。 */
export function resultDeliveryKey(submissionRef: string): string {
  return `result:${submissionRef}`;
}

/**
 * 加键之前的旧投递补什么键。旧规则下每个 Mission 每种结局至多一行，所以：
 * 升级那行只可能是第一次升级（escalated:0）；交卷那行按结局给一个不会和新键撞的名字。
 */
export function legacyDeliveryKey(outcome: Delivery['outcome']): string {
  return outcome === 'escalated' ? escalationDeliveryKey(0) : `result:legacy:${outcome}`;
}

/** 缺键的旧行补上键（返回副本，不改原对象）。 */
export function withDeliveryKey(row: Delivery): Delivery {
  return typeof row.idempotencyKey === 'string' && row.idempotencyKey !== ''
    ? row
    : { ...row, idempotencyKey: legacyDeliveryKey(row.outcome) };
}

export interface DeliveryRepository {
  create(input: Omit<Delivery, 'id' | 'createdAt' | 'status' | 'acknowledgedAt'>): Promise<Delivery>;
  /** 收件箱：某个收件人还没确认的。不传 recipient 就是全部。 */
  pending(recipient?: string): Promise<readonly Delivery[]>;
  acknowledge(deliveryId: string): Promise<Delivery | undefined>;
  get(deliveryId: string): Promise<Delivery | undefined>;
  /**
   * 按 Mission 枚举全部投递（含 acknowledged）。
   * 补建必须看见已确认行，否则会把已经投过的再投一次。
   * pending / acknowledge 语义不变。
   */
  listForMission(missionId: string): Promise<readonly Delivery[]>;
}

export class InMemoryDeliveryRepository implements DeliveryRepository {
  #rows = new Map<string, Delivery>();
  #clock: Clock;
  #ids: IdGenerator;

  constructor(clock: Clock, ids: IdGenerator) {
    this.#clock = clock;
    this.#ids = ids;
  }

  async create(
    input: Omit<Delivery, 'id' | 'createdAt' | 'status' | 'acknowledgedAt'>,
  ): Promise<Delivery> {
    // 同一个业务键只投一次：重建同一次升级 / 同一次交卷的投递拿回原来那条。
    const existing = [...this.#rows.values()].find(
      (row) => row.missionId === input.missionId && row.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return existing;

    const delivery: Delivery = Object.freeze({
      ...input,
      id: this.#ids.next('D'),
      createdAt: this.#clock.now().toISOString(),
      status: 'pending' as const,
    });
    this.#rows.set(delivery.id, delivery);
    return delivery;
  }

  async pending(recipient?: string): Promise<readonly Delivery[]> {
    return [...this.#rows.values()].filter(
      (row) => row.status === 'pending' && (!recipient || row.recipient === recipient),
    );
  }

  async acknowledge(deliveryId: string): Promise<Delivery | undefined> {
    const row = this.#rows.get(deliveryId);
    if (!row) return undefined;
    // 重复确认是幂等的，不报错：Host 重发 ack 比丢 ack 常见得多。
    if (row.status === 'acknowledged') return row;
    const next: Delivery = Object.freeze({
      ...row,
      status: 'acknowledged' as const,
      acknowledgedAt: this.#clock.now().toISOString(),
    });
    this.#rows.set(deliveryId, next);
    return next;
  }

  async get(deliveryId: string): Promise<Delivery | undefined> {
    return this.#rows.get(deliveryId);
  }

  async listForMission(missionId: string): Promise<readonly Delivery[]> {
    return [...this.#rows.values()].filter((row) => row.missionId === missionId);
  }
}
