import type { ActivityEvent } from './ports.ts';

/**
 * 按 missionId 分桶的事件索引（纯数据结构：不碰文件、不碰时钟）。
 *
 * 为什么要有它：FileActivityLog.list 现在每次都对整个 events 数组 filter 一遍。
 * 50000 事件 × 100 个 Mission 的轮询就是 500 万次扫描，而事件只增不改。
 *
 * 为什么不直接信任传入数组的「尾巴」：事务回滚会把 events 换成开事务时的快照
 * 副本，归档与重载同理——数组对象换了、长度可能和已索引的一样，甚至已索引的
 * 末项被换成别的对象后长度仍相同。只比长度会让索引永久停留在错误内容上，
 * list 返回陈旧结果，而且没有任何报错。所以身份、长度、末项引用三样都要对得上
 * 才敢只处理尾巴，否则整表重建。
 */
export class ActivityIndex {
  #source: readonly ActivityEvent[] = [];
  #count = 0;
  #last: ActivityEvent | undefined = undefined;
  #byMission = new Map<string, ActivityEvent[]>();

  sync(events: readonly ActivityEvent[]): void {
    const canAppendTail =
      events === this.#source &&
      events.length >= this.#count &&
      (this.#count === 0 || events[this.#count - 1] === this.#last);
    if (!canAppendTail) {
      this.#rebuild(events);
      return;
    }
    // 只读第 #count-1 项（上一次的末项，用来确认没被换掉）和新增的尾巴；
    // 旧前缀一个都不重读，否则「只处理尾部」就白写了。
    let last = this.#last;
    for (let i = this.#count; i < events.length; i += 1) {
      const event = events[i]!;
      this.#push(event);
      last = event;
    }
    this.#count = events.length;
    this.#last = last;
  }

  list(missionId: string): ActivityEvent[] {
    const bucket = this.#byMission.get(missionId);
    // 返回新数组：调用方拿到的是拷贝，往里面 push 或改下标都动不到桶。
    return bucket === undefined ? [] : bucket.slice();
  }

  #rebuild(events: readonly ActivityEvent[]): void {
    this.#byMission.clear();
    this.#source = events;
    this.#count = 0;
    this.#last = undefined;
    let last: ActivityEvent | undefined = undefined;
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]!;
      this.#push(event);
      last = event;
    }
    this.#count = events.length;
    this.#last = last;
  }

  /** 只存事件对象引用：拷贝内容会让「引用相同」这条上层断言失去意义。 */
  #push(event: ActivityEvent): void {
    const bucket = this.#byMission.get(event.missionId);
    if (bucket === undefined) {
      this.#byMission.set(event.missionId, [event]);
      return;
    }
    bucket.push(event);
  }
}
