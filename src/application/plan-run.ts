/**
 * 方案运行（PlanRun）—— 按一份方案（`missions/PLAN-*.json`）无人值守地逐个推进功能点。
 *
 * 与 Mission **并列**，不在 Mission 里：一次方案运行横跨多条 Mission，
 * 每个功能点一条（重跑就再开一条）。它只记方案这一层的事实——哪个功能走到哪、
 * 夜里升级了什么、检视者怎么定的、为什么停——Mission 自己的事仍记在 Mission 上。
 * 注意与 Mission 里协调者写的 `PlanBody`（调查结论与方向）不是一回事。
 *
 * **升级握手。** 夜里失败了要交给检视者定；检视者是一个定时醒来的会话，没法被
 * 推送，只能靠这份记录握手：驱动方开单并等着，检视者醒来读到、写回决定，等不到
 * 截止就算一次未解决。
 *
 * **检视者的权限只有选动作**：隔离重跑 / 跳过 / 重划剩余范围 / 停。动作表里
 * 没有「通过」也没有「合并」——概率判断只能选路，开门的只能是确定性证据
 * （合并后在集成分支上跑出来的验证，见 `Platform.finalizeMissionByMachine`）。
 *
 * 纯规则：时间一律由调用方传入，这里不读时钟、不碰文件。
 */

import { PlatformRuleError } from './platform.ts';

/** 夜间检视者能选的全部动作。**刻意没有「通过」与「合并」。** */
export const REVIEWER_ACTIONS = Object.freeze([
  'rerun_isolated',
  'skip',
  'rescope',
  'stop',
] as const);

export type ReviewerAction = (typeof REVIEWER_ACTIONS)[number];

/**
 * 功能点在本次运行里走到哪。交接面的四个记号对应其中四种：
 * merged ✓ / suspended ⏸ / skipped ⊘ / pending ○。running 只在跑着时出现。
 */
export type PlanFeatureStatus = 'pending' | 'running' | 'merged' | 'suspended' | 'skipped';

export interface PlanStopConditions {
  /** 未解决升级累计到这个数就停（≥，不是 >）。 */
  readonly unresolvedEscalations: number;
  /** 方案级硬墙钟，从开跑算起。 */
  readonly wallClockMs: number;
  /** 一张升级单等决定的最长时间；与检视者定时醒来的间隔对齐。 */
  readonly escalationTimeoutMs: number;
}

export interface PlanFeatureRecord {
  readonly featureId: string;
  readonly status: PlanFeatureStatus;
  /** 为这个功能开过的全部 Mission，按先后。隔离重跑会追加一条。 */
  readonly missionIds: readonly string[];
  /**
   * 非成功项（⏸ / ⊘）**要人定什么**。
   *
   * 只写「哪里错了」不够：早上看的人要的是下一步该拍板的那件事，而不是再去
   * 翻日志还原现场。所以进 ⏸ / ⊘ 的每条路径都必须带上它。
   */
  readonly needsDecision?: string;
}

export type PlanEscalationResolution =
  | {
      readonly kind: 'decided';
      readonly action: ReviewerAction;
      readonly reason: string;
      readonly decidedBy: string;
      readonly decidedAt: string;
      /** 仅 rescope：一并删掉的剩余功能（检视者判定它们依赖这次失败的功能）。 */
      readonly dropFeatures?: readonly string[];
    }
  | { readonly kind: 'expired'; readonly expiredAt: string };

export interface PlanEscalation {
  readonly id: string;
  readonly featureId: string;
  readonly missionId?: string;
  /** 哪里错了：证据的一句话。 */
  readonly failure: string;
  /** 要检视者定什么。 */
  readonly question: string;
  readonly openedAt: string;
  /** openedAt + escalationTimeoutMs。到点（含）之后只能判过期，不能再决定。 */
  readonly deadline: string;
  readonly resolution?: PlanEscalationResolution;
}

/**
 * 为什么停。首行要写出来：用户拿它校准阈值。
 *
 * - `unresolved_escalations`：未解决升级累计到阈值；
 * - `wall_clock`：方案级硬墙钟到点；
 * - `reviewer_stop`：检视者选了「停」；
 * - `finished`：功能点都走完了（不等于全合了）；
 * - `unsafe`：集成分支处在不能再往上叠东西的状态（如回滚失败、分支被切走）；
 * - `crashed`：驱动方自己出了未预料的错。
 */
export type PlanStopReason =
  | 'unresolved_escalations'
  | 'wall_clock'
  | 'reviewer_stop'
  | 'finished'
  | 'unsafe'
  | 'crashed';

export interface PlanRunStop {
  readonly at: string;
  readonly reason: PlanStopReason;
  readonly detail: string;
}

export interface PlanRunInit {
  readonly id: string;
  readonly planId: string;
  readonly projectId: string;
  readonly integrationBranch: string;
  /** 本次运行指定的检视者。只有它的决定作数。 */
  readonly reviewer: string;
  readonly stopConditions: PlanStopConditions;
  /** 方案里的功能点，按执行顺序。 */
  readonly featureIds: readonly string[];
  readonly startedAt: string;
}

/** 落盘形状。纯数据，能直接 JSON 化；存到哪是存储层的事。 */
export interface PlanRunSnapshot {
  readonly version: 1;
  readonly id: string;
  readonly planId: string;
  readonly projectId: string;
  readonly integrationBranch: string;
  readonly reviewer: string;
  readonly stopConditions: PlanStopConditions;
  readonly startedAt: string;
  readonly features: readonly PlanFeatureRecord[];
  readonly escalations: readonly PlanEscalation[];
  readonly stopped?: PlanRunStop;
}

const FEATURE_STATUSES: readonly PlanFeatureStatus[] = [
  'pending',
  'running',
  'merged',
  'suspended',
  'skipped',
];

const STOP_REASONS: readonly PlanStopReason[] = [
  'unresolved_escalations',
  'wall_clock',
  'reviewer_stop',
  'finished',
  'unsafe',
  'crashed',
];

function formatHours(ms: number): string {
  return (ms / 3_600_000).toFixed(1).replace(/\.0$/, '');
}

export function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** 方案文件与方案运行记录共用同一把尺子：两处各写一份，收紧一边另一边就会放过。 */
export function isStopConditions(value: unknown): value is PlanStopConditions {
  if (value === null || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  return (
    isPositiveInt(raw.unresolvedEscalations) &&
    isPositiveInt(raw.wallClockMs) &&
    isPositiveInt(raw.escalationTimeoutMs)
  );
}

/** 从落盘数据里挑出认识的字段；任何一处读不懂就整条拒绝（返回 undefined）。 */
function readFeature(value: unknown): PlanFeatureRecord | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (!isText(raw.featureId)) return undefined;
  if (!(FEATURE_STATUSES as readonly unknown[]).includes(raw.status)) return undefined;
  if (!isStringList(raw.missionIds)) return undefined;
  if (raw.needsDecision !== undefined && typeof raw.needsDecision !== 'string') return undefined;
  return freezeFeature({
    featureId: raw.featureId,
    status: raw.status as PlanFeatureStatus,
    missionIds: raw.missionIds,
    needsDecision: raw.needsDecision as string | undefined,
  });
}

function readResolution(value: unknown): PlanEscalationResolution | undefined | false {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'expired') {
    return isInstant(raw.expiredAt) ? Object.freeze({ kind: 'expired', expiredAt: raw.expiredAt }) : false;
  }
  if (raw.kind !== 'decided') return false;
  if (!(REVIEWER_ACTIONS as readonly unknown[]).includes(raw.action)) return false;
  if (typeof raw.reason !== 'string' || !isText(raw.decidedBy) || !isInstant(raw.decidedAt)) return false;
  if (raw.dropFeatures !== undefined && !isStringList(raw.dropFeatures)) return false;
  return Object.freeze({
    kind: 'decided',
    action: raw.action as ReviewerAction,
    reason: raw.reason,
    decidedBy: raw.decidedBy,
    decidedAt: raw.decidedAt,
    ...(raw.dropFeatures !== undefined ? { dropFeatures: Object.freeze([...raw.dropFeatures]) } : {}),
  });
}

function readEscalation(value: unknown, featureIds: ReadonlySet<string>): PlanEscalation | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (!isText(raw.id) || typeof raw.featureId !== 'string' || !featureIds.has(raw.featureId)) {
    return undefined;
  }
  if (raw.missionId !== undefined && typeof raw.missionId !== 'string') return undefined;
  if (typeof raw.failure !== 'string' || typeof raw.question !== 'string') return undefined;
  if (!isInstant(raw.openedAt) || !isInstant(raw.deadline)) return undefined;
  const resolution = readResolution(raw.resolution);
  if (resolution === false) return undefined;
  return Object.freeze({
    id: raw.id,
    featureId: raw.featureId,
    ...(raw.missionId !== undefined ? { missionId: raw.missionId as string } : {}),
    failure: raw.failure,
    question: raw.question,
    openedAt: raw.openedAt,
    deadline: raw.deadline,
    ...(resolution ? { resolution } : {}),
  });
}

function readStop(value: unknown): PlanRunStop | undefined | false {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  if (!isInstant(raw.at) || typeof raw.detail !== 'string') return false;
  if (!(STOP_REASONS as readonly unknown[]).includes(raw.reason)) return false;
  return Object.freeze({ at: raw.at, reason: raw.reason as PlanStopReason, detail: raw.detail });
}

/** 冻结一条功能记录；needsDecision 没有就不写这个键，免得快照里挂着 undefined。 */
function freezeFeature(feature: {
  featureId: string;
  status: PlanFeatureStatus;
  missionIds: readonly string[];
  needsDecision?: string;
}): PlanFeatureRecord {
  return Object.freeze({
    featureId: feature.featureId,
    status: feature.status,
    missionIds: Object.freeze([...feature.missionIds]),
    ...(feature.needsDecision !== undefined ? { needsDecision: feature.needsDecision } : {}),
  });
}

export class PlanRun {
  #id: string;
  #planId: string;
  #projectId: string;
  #integrationBranch: string;
  #reviewer: string;
  #stopConditions: PlanStopConditions;
  #startedAt: string;
  #features: PlanFeatureRecord[];
  #escalations: PlanEscalation[] = [];
  #stopped: PlanRunStop | undefined;

  private constructor(init: PlanRunInit) {
    this.#id = init.id;
    this.#planId = init.planId;
    this.#projectId = init.projectId;
    this.#integrationBranch = init.integrationBranch;
    this.#reviewer = init.reviewer;
    this.#stopConditions = Object.freeze({ ...init.stopConditions });
    this.#startedAt = init.startedAt;
    this.#features = init.featureIds.map((featureId) =>
      freezeFeature({ featureId, status: 'pending', missionIds: [] }),
    );
  }

  static start(init: PlanRunInit): PlanRun {
    const invalid = (detail: string) => new PlatformRuleError('PLAN_RUN_INVALID', detail);
    for (const key of ['id', 'planId', 'projectId', 'integrationBranch', 'reviewer'] as const) {
      if (!isText(init[key])) throw invalid(`${key} 必须是非空字符串。`);
    }
    // 0 / 缺省 / 小数都等于没有这道闸——夜里没人看着，缺一道闸就是一路跑到天亮。
    if (!isStopConditions(init.stopConditions)) {
      throw invalid('stopConditions 的 unresolvedEscalations / wallClockMs / escalationTimeoutMs 必须都是正整数。');
    }
    if (!isInstant(init.startedAt)) throw invalid('startedAt 不是时间。');
    if (!Array.isArray(init.featureIds) || init.featureIds.length === 0) {
      throw invalid('方案里至少要有一个功能点。');
    }
    if (!init.featureIds.every(isText) || new Set(init.featureIds).size !== init.featureIds.length) {
      throw invalid('功能点 id 必须非空且不重名。');
    }
    return new PlanRun(init);
  }

  /**
   * 从落盘数据还原。**读不懂就拒绝**，不静默重置也不猜：
   * 这份记录决定夜里还跑不跑、检视者的决定作不作数，猜错比停下来更糟。
   *
   * 直接装配，不重放动作：历史是既成事实，不拿今天的规则重审一遍。
   */
  static restore(snapshot: unknown): PlanRun {
    const corrupt = (detail: string) => new PlatformRuleError('PLAN_RUN_CORRUPT', `方案运行记录读不懂：${detail}`);
    if (snapshot === null || typeof snapshot !== 'object') throw corrupt('不是对象。');
    const raw = snapshot as Record<string, unknown>;
    if (raw.version !== 1) throw corrupt(`版本 ${String(raw.version)} 不认识。`);
    for (const key of ['id', 'planId', 'projectId', 'integrationBranch', 'reviewer'] as const) {
      if (!isText(raw[key])) throw corrupt(`${key} 缺失。`);
    }
    if (!isStopConditions(raw.stopConditions)) throw corrupt('stopConditions 不合法。');
    if (!isInstant(raw.startedAt)) throw corrupt('startedAt 不是时间。');
    if (!Array.isArray(raw.features) || raw.features.length === 0) throw corrupt('features 缺失。');
    const features = raw.features.map(readFeature);
    if (features.some((f) => f === undefined)) throw corrupt('有功能记录读不懂。');
    const featureIds = new Set(features.map((f) => f!.featureId));
    if (featureIds.size !== features.length) throw corrupt('功能点重名。');
    if (!Array.isArray(raw.escalations)) throw corrupt('escalations 缺失。');
    const escalations = raw.escalations.map((e) => readEscalation(e, featureIds));
    if (escalations.some((e) => e === undefined)) throw corrupt('有升级单读不懂。');
    const stopped = readStop(raw.stopped);
    if (stopped === false) throw corrupt('stopped 读不懂。');

    const run = new PlanRun({
      id: raw.id as string,
      planId: raw.planId as string,
      projectId: raw.projectId as string,
      integrationBranch: raw.integrationBranch as string,
      reviewer: raw.reviewer as string,
      stopConditions: raw.stopConditions,
      featureIds: [],
      startedAt: raw.startedAt as string,
    });
    run.#features = features as PlanFeatureRecord[];
    run.#escalations = escalations as PlanEscalation[];
    run.#stopped = stopped;
    return run;
  }

  toSnapshot(): PlanRunSnapshot {
    return {
      version: 1,
      id: this.#id,
      planId: this.#planId,
      projectId: this.#projectId,
      integrationBranch: this.#integrationBranch,
      reviewer: this.#reviewer,
      stopConditions: { ...this.#stopConditions },
      startedAt: this.#startedAt,
      features: this.#features.map((f) => freezeFeature(f)),
      escalations: [...this.#escalations],
      ...(this.#stopped ? { stopped: this.#stopped } : {}),
    };
  }

  get id(): string {
    return this.#id;
  }

  get planId(): string {
    return this.#planId;
  }

  get projectId(): string {
    return this.#projectId;
  }

  get integrationBranch(): string {
    return this.#integrationBranch;
  }

  get reviewer(): string {
    return this.#reviewer;
  }

  get stopConditions(): PlanStopConditions {
    return this.#stopConditions;
  }

  get startedAt(): string {
    return this.#startedAt;
  }

  get features(): readonly PlanFeatureRecord[] {
    return [...this.#features];
  }

  get escalations(): readonly PlanEscalation[] {
    return [...this.#escalations];
  }

  /** 正开着等决定的那张升级单。同一时刻最多一张。 */
  get currentEscalation(): PlanEscalation | undefined {
    return this.#escalations.find((e) => e.resolution === undefined);
  }

  feature(featureId: string): PlanFeatureRecord | undefined {
    return this.#features.find((f) => f.featureId === featureId);
  }

  /** 截止前没等到决定的升级单数。停止条件之一。 */
  get unresolvedCount(): number {
    return this.#escalations.filter((e) => e.resolution?.kind === 'expired').length;
  }

  /** 停了就是停了：终态，之后什么都不再收。 */
  get stopped(): PlanRunStop | undefined {
    return this.#stopped;
  }

  /**
   * 开跑一个功能（隔离重跑也走这里，Mission 记录累加）。
   *
   * 同一时刻只跑一个：项目只有一个改动名额，并行开跑只会让后一个卡在
   * project_busy 上空等，而方案层看起来两个都在跑。
   */
  startFeature(featureId: string, missionId: string): void {
    this.#assertRunning();
    const feature = this.#requireFeature(featureId);
    const busy = this.#features.find((f) => f.status === 'running');
    if (busy) {
      throw new PlatformRuleError(
        'PLAN_FEATURE_BUSY',
        `${busy.featureId} 还在跑，同一时刻只跑一个功能。`,
      );
    }
    if (feature.status !== 'pending') {
      throw new PlatformRuleError(
        'PLAN_FEATURE_NOT_PENDING',
        `${featureId} 现在是 ${feature.status}，只有待跑的功能能开跑。`,
      );
    }
    this.#setFeature(featureId, {
      status: 'running',
      missionIds: [...feature.missionIds, missionId],
    });
  }

  /** 机器 L3 在集成分支上验过、合进去了。 */
  markMerged(featureId: string): void {
    this.#assertRunning();
    this.#requireFeature(featureId);
    this.#assertNoOpenEscalation(featureId);
    this.#requireStatus(featureId, 'running');
    this.#setFeature(featureId, { status: 'merged', needsDecision: undefined });
  }

  /**
   * 不经升级直接挂起交给人——比如分类判成 high_assurance：那条路永远要人放行，
   * 问检视者也没用，它没有放行权。
   */
  suspendFeature(featureId: string, needsDecision: string): void {
    this.#assertRunning();
    const feature = this.#requireFeature(featureId);
    if (typeof needsDecision !== 'string' || needsDecision.trim() === '') {
      throw new PlatformRuleError('NEEDS_DECISION_REQUIRED', '挂起必须写明要人定什么。');
    }
    this.#assertNoOpenEscalation(featureId);
    if (feature.status !== 'pending' && feature.status !== 'running') {
      throw new PlatformRuleError(
        'PLAN_FEATURE_SETTLED',
        `${featureId} 已经是 ${feature.status}，不能再挂起。`,
      );
    }
    this.#setFeature(featureId, { status: 'suspended', needsDecision });
  }

  /** 功能点都走完了（不等于全合了）。 */
  finish(at: string): void {
    this.#assertRunning();
    const left = this.#features.filter((f) => f.status === 'pending' || f.status === 'running');
    if (left.length > 0) {
      throw new PlatformRuleError(
        'PLAN_RUN_NOT_FINISHED',
        `还有 ${left.map((f) => f.featureId).join('、')} 没走完。`,
      );
    }
    this.#stop('finished', '功能点都走完了。', at);
  }

  /**
   * 驱动方主动停：集成分支不能再往上叠东西了（`unsafe`），或者驱动方自己出了
   * 未预料的错（`crashed`）。跑着的功能挂起，原因原样交给人。
   */
  halt(reason: 'unsafe' | 'crashed', detail: string, at: string): void {
    this.#assertRunning();
    const open = this.currentEscalation;
    for (const feature of this.#features) {
      if (feature.status !== 'running') continue;
      this.#setFeature(feature.featureId, {
        status: 'suspended',
        needsDecision:
          `方案被迫停下：${detail}。要你定：` +
          (open?.featureId === feature.featureId ? open.question : '先处理这个原因，再决定它续跑还是重跑。'),
      });
    }
    this.#stop(reason, detail, at);
  }

  openEscalation(
    input: { featureId: string; missionId?: string; failure: string; question: string },
    at: string,
  ): PlanEscalation {
    this.#assertRunning();
    this.#requireFeature(input.featureId);
    // 同一时刻只开一张：驱动方就在等这一张，第二张不会有人等。
    const open = this.currentEscalation;
    if (open) {
      throw new PlatformRuleError(
        'ESCALATION_ALREADY_OPEN',
        `升级单 ${open.id}（${open.featureId}）还开着，先了结它。`,
      );
    }
    this.#requireStatus(input.featureId, 'running');
    const escalation: PlanEscalation = Object.freeze({
      id: `E-${this.#escalations.length + 1}`,
      featureId: input.featureId,
      ...(input.missionId !== undefined ? { missionId: input.missionId } : {}),
      failure: input.failure,
      question: input.question,
      openedAt: at,
      deadline: new Date(Date.parse(at) + this.#stopConditions.escalationTimeoutMs).toISOString(),
    });
    this.#escalations.push(escalation);
    return escalation;
  }

  /**
   * 检视者写回决定。四个动作的效果：
   *
   * - `skip`：当前功能 ⊘；
   * - `rescope`：当前功能 ⊘，并删掉点名的**还没轮到**的功能（⊘，写明依赖谁）。
   *   只能删、不能加也不能改写：检视者收窄今晚的范围，不重新定义工作；
   * - `stop`：方案停下，当前功能 ⏸ 交给人；
   * - `rerun_isolated`：当前功能退回待跑，驱动方另开一条 Mission 重来。
   *
   * 失败那条 Mission 怎么收（放名额、留分支）是驱动方的事，这里只记方案层的事实。
   */
  decide(
    escalationId: string,
    input: { action: unknown; reason: string; decidedBy: string; dropFeatures?: unknown },
    at: string,
  ): PlanEscalation {
    this.#assertRunning();
    const { index, escalation } = this.#requireOpenEscalation(escalationId);
    // 截止含本身：到点那一刻驱动方可能已经判了过期、往下走了。收下一个迟到的
    // 决定，记录上就会出现「定了跳过」而现实是「已挂起」两种说法。
    if (Date.parse(at) >= Date.parse(escalation.deadline)) {
      throw new PlatformRuleError(
        'ESCALATION_DEADLINE_PASSED',
        `升级单 ${escalationId} 已于 ${escalation.deadline} 截止，决定未生效。`,
      );
    }
    if (input.decidedBy !== this.#reviewer) {
      throw new PlatformRuleError(
        'NOT_DESIGNATED_REVIEWER',
        `本次运行指定的检视者是 ${this.#reviewer}，不是 ${String(input.decidedBy)}。`,
      );
    }
    if (!(REVIEWER_ACTIONS as readonly unknown[]).includes(input.action)) {
      throw new PlatformRuleError(
        'REVIEWER_ACTION_FORBIDDEN',
        `检视者只能选 ${REVIEWER_ACTIONS.join(' / ')}，收到 ${String(input.action)}。` +
          '没有「通过」也没有「合并」：放行只凭合并后的集成验证。',
      );
    }
    if (typeof input.reason !== 'string' || input.reason.trim() === '') {
      throw new PlatformRuleError('DECISION_REASON_REQUIRED', '决定必须写理由。');
    }
    const action = input.action as ReviewerAction;
    const dropFeatures = this.#dropTargets(action, input.dropFeatures);
    const decided: PlanEscalation = Object.freeze({
      ...escalation,
      resolution: Object.freeze({
        kind: 'decided' as const,
        action,
        reason: input.reason,
        decidedBy: input.decidedBy,
        decidedAt: at,
        ...(dropFeatures ? { dropFeatures: Object.freeze([...dropFeatures]) } : {}),
      }),
    });
    this.#escalations[index] = decided;

    const failed = escalation.featureId;
    if (action === 'skip' || action === 'rescope') {
      this.#setFeature(failed, {
        status: 'skipped',
        needsDecision: `检视者跳过了它（${input.reason}）。要你定：重排进下一轮，还是就此放弃？`,
      });
      for (const featureId of dropFeatures ?? []) {
        this.#setFeature(featureId, {
          status: 'skipped',
          needsDecision:
            `检视者判定它依赖 ${failed}（${input.reason}），今晚没跑。` +
            `要你定：${failed} 处理好之后是否重排它？`,
        });
      }
    } else if (action === 'stop') {
      this.#setFeature(failed, {
        status: 'suspended',
        needsDecision: `检视者叫停了方案（${input.reason}）。要你定：${escalation.question}`,
      });
      this.#stop('reviewer_stop', `检视者叫停：${input.reason}`, at);
    } else {
      this.#setFeature(failed, { status: 'pending', needsDecision: undefined });
    }
    return decided;
  }

  /** 按方案顺序第一个还没轮到的功能。隔离重跑的功能退回这里，所以下一个还是它。 */
  nextPending(): PlanFeatureRecord | undefined {
    return this.#features.find((f) => f.status === 'pending');
  }

  /**
   * 停止条件的墙钟那一半——先到者停，停了不改原因。未解决那一半不在这里：
   * `expire` 记下第 N 次的同一次写里就停了，不留「数到了却还没停」的窗口。
   *
   * 墙钟到点时还在跑的功能挂起交给人：它停在哪、要不要续跑，只有人能定。
   */
  checkStop(now: string): PlanRunStop | undefined {
    if (this.#stopped) return this.#stopped;
    const wallClockMs = this.#stopConditions.wallClockMs;
    if (Date.parse(now) - Date.parse(this.#startedAt) < wallClockMs) return undefined;
    const open = this.currentEscalation;
    for (const feature of this.#features) {
      if (feature.status !== 'running') continue;
      this.#setFeature(feature.featureId, {
        status: 'suspended',
        needsDecision:
          open?.featureId === feature.featureId
            ? `墙钟到点时这张升级单还没人定。要你定：${open.question}`
            : `墙钟到点时它还在跑（Mission ${feature.missionIds.at(-1) ?? '?'}）。` +
              '要你定：看它停在哪，续跑、重跑还是放弃。',
      });
    }
    this.#stop('wall_clock', `方案级墙钟 ${formatHours(wallClockMs)} 小时到了。`, now);
    return this.#stopped;
  }

  #dropTargets(action: ReviewerAction, raw: unknown): readonly string[] | undefined {
    if (action !== 'rescope') {
      // 夹带的名单不能悄悄忽略：检视者以为删掉了，实际今晚照跑。
      if (raw !== undefined) {
        throw new PlatformRuleError(
          'RESCOPE_TARGET_INVALID',
          `只有「重划剩余范围」能带删除名单，${action} 不能。`,
        );
      }
      return undefined;
    }
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new PlatformRuleError('RESCOPE_TARGET_INVALID', '重划剩余范围必须点名要删的功能。');
    }
    const unique = new Set<unknown>(raw);
    if (unique.size !== raw.length) {
      throw new PlatformRuleError('RESCOPE_TARGET_INVALID', '删除名单里有重复的功能。');
    }
    for (const featureId of raw) {
      const feature = typeof featureId === 'string' ? this.feature(featureId) : undefined;
      if (!feature || feature.status !== 'pending') {
        throw new PlatformRuleError(
          'RESCOPE_TARGET_INVALID',
          `${String(featureId)} 不是还没轮到的功能：重划只能删剩余的，不能动已经走完或正在跑的。`,
        );
      }
    }
    return raw as string[];
  }

  /**
   * 截止前没等到决定：记一次未解决，功能挂起交给人。
   *
   * 挂起而不是原地再等：一个等不到决定的失败要是把整晚钉住，后面的功能一个都
   * 跑不了——而它们多半和这个失败无关。代价由阈值兜着：等不到的累计到上限就停。
   */
  expire(escalationId: string, at: string): PlanEscalation {
    this.#assertRunning();
    const { index, escalation } = this.#requireOpenEscalation(escalationId);
    if (Date.parse(at) < Date.parse(escalation.deadline)) {
      throw new PlatformRuleError(
        'ESCALATION_NOT_DUE',
        `升级单 ${escalationId} 要到 ${escalation.deadline} 才截止，检视者还在它的窗口里。`,
      );
    }
    const expired: PlanEscalation = Object.freeze({
      ...escalation,
      resolution: Object.freeze({ kind: 'expired' as const, expiredAt: at }),
    });
    this.#escalations[index] = expired;
    this.#setFeature(escalation.featureId, {
      status: 'suspended',
      needsDecision: `检视者没在截止前定。要你定：${escalation.question}（当时的失败：${escalation.failure}）`,
    });
    const limit = this.#stopConditions.unresolvedEscalations;
    if (this.unresolvedCount >= limit) {
      this.#stop(
        'unresolved_escalations',
        `未解决升级累计 ${this.unresolvedCount} 次，到了上限 ${limit}。`,
        at,
      );
    }
    return expired;
  }

  #stop(reason: PlanStopReason, detail: string, at: string): void {
    this.#stopped = Object.freeze({ at, reason, detail });
  }

  #assertRunning(): void {
    if (this.#stopped) {
      throw new PlatformRuleError(
        'PLAN_RUN_STOPPED',
        `方案运行 ${this.#id} 已于 ${this.#stopped.at} 停止（${this.#stopped.reason}）：${this.#stopped.detail}`,
      );
    }
  }

  #requireOpenEscalation(escalationId: string): { index: number; escalation: PlanEscalation } {
    const index = this.#escalations.findIndex((e) => e.id === escalationId);
    if (index < 0) {
      throw new PlatformRuleError('UNKNOWN_ESCALATION', `没有升级单 ${escalationId}。`);
    }
    const escalation = this.#escalations[index];
    if (escalation.resolution) {
      throw new PlatformRuleError(
        'ESCALATION_ALREADY_RESOLVED',
        `升级单 ${escalationId} 已经${escalation.resolution.kind === 'decided' ? '定过了' : '判过期了'}。`,
      );
    }
    return { index, escalation };
  }

  #assertNoOpenEscalation(featureId: string): void {
    const open = this.currentEscalation;
    if (open?.featureId === featureId) {
      throw new PlatformRuleError(
        'ESCALATION_ALREADY_OPEN',
        `${featureId} 还有升级单 ${open.id} 等着决定，先了结它。`,
      );
    }
  }

  #requireStatus(featureId: string, status: 'running'): void {
    const feature = this.#requireFeature(featureId);
    if (feature.status !== status) {
      throw new PlatformRuleError(
        'PLAN_FEATURE_NOT_RUNNING',
        `${featureId} 现在是 ${feature.status}，不在跑。`,
      );
    }
  }

  #requireFeature(featureId: string): PlanFeatureRecord {
    const feature = this.feature(featureId);
    if (!feature) {
      throw new PlatformRuleError('UNKNOWN_PLAN_FEATURE', `方案里没有功能点 ${featureId}。`);
    }
    return feature;
  }

  /** patch 里显式给 `needsDecision: undefined` 表示清掉它（合入 / 退回待跑）。 */
  #setFeature(featureId: string, patch: Partial<Omit<PlanFeatureRecord, 'featureId'>>): void {
    const index = this.#features.findIndex((f) => f.featureId === featureId);
    this.#features[index] = freezeFeature({ ...this.#features[index], ...patch });
  }
}
