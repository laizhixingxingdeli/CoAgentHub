import { IllegalTransitionError } from './errors.ts';
import { EMPTY_USAGE } from './payloads.ts';
import type { AttemptSnapshot } from './snapshot.ts';
import type { EvidenceRecord, TokenUsage, UsedProfile } from './payloads.ts';

export type AttemptStatus = 'in_progress' | 'succeeded' | 'failed';
export type AttemptKind = 'coordinator' | 'executor';

/**
 * 一次尝试的结束原因。
 *
 * - `structured_submit`     正常：做了结构化提交
 * - `no_structured_result`  跑完一轮但什么都没提交 —— 算失败，不要挂着等
 * - `upstream_failure`      限流 / 配额 / 连不上 —— 这一类才允许换候选重试
 * - `cancelled`             被取消
 * - `interrupted`           平台自己重启/崩溃时它还在跑 —— 没人能再收尾它，
 *                           启动时统一判死。**算可重试**：它没有交出任何
 *                           技术结论，和「跑完却没提交」是两回事。
 * - `platform_unreachable`  agent 连不上平台自己。**和上游失败必须分开**：
 *                           上游失败是"那个候选暂时不可用"，该冷却它；
 *                           这个是"平台坏了"，冷却任何候选都是误伤——
 *                           换一个照样连不上，而且把好候选白白冻起来。
 */
export type AttemptEndReason =
  | 'structured_submit'
  | 'no_structured_result'
  | 'upstream_failure'
  | 'platform_unreachable'
  | 'cancelled'
  | 'interrupted';

/** Attempt 流转表：只有 in_progress 有出边。 */
const ATTEMPT_TRANSITIONS: Record<AttemptStatus, readonly AttemptStatus[]> = {
  in_progress: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
};

export interface AttemptInit {
  id: string;
  kind: AttemptKind;
  missionId?: string;
  workItemId?: string;
}

/**
 * 一次尝试（协调者或执行者）。
 *
 * 实际生命周期由 `Mission.startCoordinatorAttempt()` / `WorkItem.startAttempt()`
 * 这两个工厂负责；不变量 B 与「同一 WorkItem 只有一个 in_progress executor
 * attempt」都在聚合那一层判定，孤立 new 出来的 Attempt 不参与任何不变量判断。
 *
 * 全部字段为 `#` 私有 + 只读 getter：任何对外赋值都抛 TypeError。
 */
export class Attempt {
  #id: string;
  #kind: AttemptKind;
  #missionId: string | undefined;
  #workItemId: string | undefined;
  #status: AttemptStatus = 'in_progress';
  #heartbeatAt: string | undefined;
  #leaseOwner: string | undefined;
  #failReason: string | undefined;
  #evidence: Readonly<EvidenceRecord>[] = [];
  #usage: TokenUsage = EMPTY_USAGE;
  #endedBy: AttemptEndReason | undefined;
  #resumeRef: string | undefined;
  #output = '';
  #profile: Readonly<UsedProfile> | undefined;
  #outputRef: string | undefined;
  #toolActivity: { name: string; at: string }[] = [];

  constructor(init: AttemptInit) {
    this.#id = init.id;
    this.#kind = init.kind;
    this.#missionId = init.missionId;
    this.#workItemId = init.workItemId;
  }

  get id(): string {
    return this.#id;
  }

  get kind(): AttemptKind {
    return this.#kind;
  }

  get missionId(): string | undefined {
    return this.#missionId;
  }

  get workItemId(): string | undefined {
    return this.#workItemId;
  }

  get status(): AttemptStatus {
    return this.#status;
  }

  get failReason(): string | undefined {
    return this.#failReason;
  }

  succeed(): void {
    this.#goto('succeeded');
  }

  fail(reason?: string): void {
    this.#goto('failed');
    this.#failReason = reason;
  }

  /* --------------------------- 载荷（非状态） --------------------------- */

  get evidence(): readonly Readonly<EvidenceRecord>[] {
    return [...this.#evidence];
  }

  get usage(): TokenUsage {
    return this.#usage;
  }

  /**
   * 这次尝试是怎么结束的。
   *
   * `no_structured_result`（跑完一轮却没做任何结构化提交）与
   * `upstream_failure`（限流/配额/连不上）**必须分开记**：上游失败允许换候选
   * 重试，而「没提交」和「实现错了」不允许——换一个再赌一次会把配额烧光而
   * 不产生任何新信息。这两类混成一个结束码，调度器就没法执行这条规则。
   */
  get endedBy(): AttemptEndReason | undefined {
    return this.#endedBy;
  }

  addEvidence(record: EvidenceRecord): void {
    if (this.#status !== 'in_progress') {
      throw new IllegalTransitionError('Attempt', this.#status, 'addEvidence');
    }
    this.#evidence.push(Object.freeze({ ...record }));
  }

  recordUsage(usage: TokenUsage): void {
    this.#usage = Object.freeze({ ...usage });
  }

  recordEndReason(reason: AttemptEndReason): void {
    this.#endedBy = reason;
  }

  /**
   * 续跑句柄。平台**不解释它的内容**——那是运行时自己的事。
   *
   * 必须落到这里而不是留在调度器的局部变量里：进程一退就没了，
   * 下一轮把协调者叫起来时它会从零开始，看不到自己上一轮做过什么。
   */
  get resumeRef(): string | undefined {
    return this.#resumeRef;
  }

  recordResumeRef(ref: string): void {
    this.#resumeRef = ref;
  }

  /**
   * 这次尝试实际用的运行时配置（S13.3）。
   *
   * **在 Attempt 上冻结**，不是去查"候选池现在是什么"：池子会改，
   * 而排障问的永远是"当时那一跳用的是哪个"。不冻的话，换过配置之后
   * 历史记录就全错了，而且错得看不出来。
   */
  get profile(): Readonly<UsedProfile> | undefined {
    return this.#profile;
  }

  recordProfile(profile: UsedProfile): void {
    this.#profile = Object.freeze({ ...profile });
  }

  /**
   * Attempt 的原始输出（Timeline 第三层，S11.3）。
   *
   * **只留尾部**：一次执行可以吐出几十万字符，全存下来会把状态文件撑爆，
   * 而排障时看的几乎总是最后那一段。这是刻意的有损存储，不是疏漏——
   * 所以超限时在开头标一句，免得有人以为自己看到的是全部。
   */
  get output(): string {
    return this.#output;
  }

/**
   * 这一跳调了哪些工具（Timeline 第二层，S11.3）。
   *
   * 和原始输出分开：输出是给人读的一大段文字，这个是**结构化的动作序列**，
   * 界面可以直接画成时间线。上限之外只留尾部——一次执行可以调上百次工具，
   * 而看的人关心的是最后卡在哪。
   */
  get toolActivity(): readonly { name: string; at: string }[] {
    return [...this.#toolActivity];
  }

  recordToolCall(name: string, at: string, max = 200): void {
    this.#toolActivity.push({ name, at });
    if (this.#toolActivity.length > max) {
      this.#toolActivity = this.#toolActivity.slice(-max);
    }
  }

  /* --------------------------- 租约 --------------------------- */

  /**
   * 最近一次心跳。跑这次尝试的那个进程按固定间隔打一下。
   *
   * 为什么需要：启动收敛原本的判据是"我刚起来，所以没有任何 attempt 还活着"。
   * 单写者下这是对的；多个进程共用一份状态之后就是错的——实测中重启一次
   * **只读**的观测面，就把另一个进程正在跑的 attempt 判死了。
   *
   * 心跳把"还有人在跑"变成状态里一个看得见的事实，于是收敛不再需要靠猜。
   */
  get heartbeatAt(): string | undefined {
    return this.#heartbeatAt;
  }

  /** 谁在跑它。判死之前先说清楚是谁的，报错才有下一步。 */
  get leaseOwner(): string | undefined {
    return this.#leaseOwner;
  }

  /**
   * 打一次心跳。`at` 由调用方给——**kernel 里不读时钟**，
   * 否则这一层就没法在测试里确定性地跑了。
   */
  beat(at: string, owner?: string): void {
    this.#heartbeatAt = at;
    if (owner) this.#leaseOwner = owner;
  }

  /**
   * 这次尝试是不是已经没人管了。
   *
   * 两个时间都从外面传进来，这里只做纯比较。判据：
   *   - 不是 in_progress —— 已经收过尾，谈不上没人管；
   *   - 有心跳：看它离现在多久。超过容忍窗口才算没人管；
   *   - 没有心跳：一律算没人管。这是刻意的——老数据、以及不打心跳的运行时，
   *     行为要和加租约之前完全一致，否则升级之后那些 attempt 会永远
   *     卡在 in_progress，把整条 Mission 焊死。
   */
  isAbandoned(nowIso: string, toleranceMs: number): boolean {
    if (this.#status !== 'in_progress') return false;
    if (!this.#heartbeatAt) return true;
    const last = Date.parse(this.#heartbeatAt);
    const now = Date.parse(nowIso);
    if (Number.isNaN(last) || Number.isNaN(now)) return true;
    return now - last > toleranceMs;
  }

  /**
   * 完整输出被外置到哪。
   *
   * 平台**不解释这个字符串**——它指向哪、怎么取，是存储层的事。
   * kernel 只负责记住"完整的那份在别处"。
   */
  get outputRef(): string | undefined {
    return this.#outputRef;
  }

  recordOutputRef(ref: string): void {
    this.#outputRef = ref;
  }

  appendOutput(chunk: string, maxChars = 16_000): void {
    const next = this.#output + chunk;
    this.#output =
      next.length <= maxChars
        ? next
        : `…（前 ${next.length - maxChars} 字符已截断）
` + next.slice(-maxChars);
  }

  /* --------------------------- 快照 --------------------------- */

  toSnapshot(): AttemptSnapshot {
    return {
      id: this.#id,
      kind: this.#kind,
      missionId: this.#missionId,
      workItemId: this.#workItemId,
      status: this.#status,
      heartbeatAt: this.#heartbeatAt,
      leaseOwner: this.#leaseOwner,
      failReason: this.#failReason,
      evidence: [...this.#evidence],
      usage: this.#usage,
      endedBy: this.#endedBy,
      resumeRef: this.#resumeRef,
      output: this.#output,
      profile: this.#profile,
      outputRef: this.#outputRef,
      toolActivity: [...this.#toolActivity],
    };
  }

  /** 直接装配历史状态，不重放动作、不重新校验流转。 */
  static restore(snapshot: AttemptSnapshot): Attempt {
    const attempt = new Attempt({
      id: snapshot.id,
      kind: snapshot.kind,
      missionId: snapshot.missionId,
      workItemId: snapshot.workItemId,
    });
    attempt.#status = snapshot.status;
    attempt.#heartbeatAt = snapshot.heartbeatAt;
    attempt.#leaseOwner = snapshot.leaseOwner;
    attempt.#failReason = snapshot.failReason;
    attempt.#evidence = (snapshot.evidence ?? []) as Readonly<EvidenceRecord>[];
    attempt.#usage = (snapshot.usage ?? EMPTY_USAGE) as TokenUsage;
    attempt.#endedBy = snapshot.endedBy as AttemptEndReason | undefined;
    attempt.#resumeRef = snapshot.resumeRef;
    attempt.#output = snapshot.output ?? '';
    attempt.#profile = snapshot.profile as Readonly<UsedProfile> | undefined;
    attempt.#outputRef = snapshot.outputRef;
    attempt.#toolActivity = (snapshot.toolActivity ?? []) as { name: string; at: string }[];
    return attempt;
  }

  #goto(to: AttemptStatus): void {
    if (!ATTEMPT_TRANSITIONS[this.#status].includes(to)) {
      throw new IllegalTransitionError('Attempt', this.#status, to);
    }
    this.#status = to;
  }
}
