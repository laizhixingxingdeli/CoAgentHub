/**
 * Delivery Inbox —— 结果回到发起方的持久投递。
 *
 * 为什么不是「把结果打印出来就完了」：发起 Mission 的那个会话可能已经关了。
 * 结果必须**留在收件箱里等**，Host 恢复后自己来取。Mission 结果不能丢。
 *
 * v1 刻意做得很薄：pending → acknowledged，没有租约、没有死信、没有重投计数。
 * 这些是被真实故障逼出来的东西，还没遇到就不建。
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
  readonly summary: string;
  readonly createdAt: string;
  readonly status: 'pending' | 'acknowledged';
  readonly acknowledgedAt?: string;
}

export interface DeliveryRepository {
  create(input: Omit<Delivery, 'id' | 'createdAt' | 'status' | 'acknowledgedAt'>): Promise<Delivery>;
  /** 收件箱：某个收件人还没确认的。不传 recipient 就是全部。 */
  pending(recipient?: string): Promise<readonly Delivery[]>;
  acknowledge(deliveryId: string): Promise<Delivery | undefined>;
  get(deliveryId: string): Promise<Delivery | undefined>;
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
    // 同一个 Mission 的同一种结局只投一次：协调者重复交卷不该在收件箱里
    // 堆两条。但升级和交卷是两件事，各投各的。
    const existing = [...this.#rows.values()].find(
      (row) => row.missionId === input.missionId && row.outcome === input.outcome,
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
}
