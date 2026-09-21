import { IllegalTransitionError, InvariantViolationError } from './errors.ts';
import { Attempt } from './attempt.ts';
import { freezeDeep, freezePayload } from './payloads.ts';
import type { AttemptSnapshot, WorkItemSnapshot } from './snapshot.ts';
import type {
  BlockedRecord,
  ExecutionResultBody,
  ReviewAuthority,
  ReviewRecord,
  WorkOrder,
  WorkOrderValidationCommand,
  WorkOrderValidationSpec,
} from './payloads.ts';

export type WorkItemStatus =
  | 'created'
  | 'dispatched'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'blocked'
  /**
   * 被上游主动作废：这张工单**不再需要做了**。
   *
   * 和 blocked 分开，因为两者对 Mission 的含义相反：
   *   - blocked = "这张工单本身不成立，**需要有人去改它**" —— Mission 交不了卷；
   *   - retired = "它已经不算数了，**不用管了**" —— 不该拦着 Mission 交卷。
   *
   * 早先两者都落在 blocked 上，于是"被取代的工作项"会把整条 Mission 焊死：
   * 交卷闸要求全部 accepted，而作废掉的那张永远到不了 accepted。实测 W3
   * 只能改用 outcome=blocked 交卷绕过去——那等于对外宣称任务失败了。
   */
  | 'retired';

/**
 * WorkItem 流转表。
 *
 * 注意 accepted 只能从 submitted 进来，而 submitted 只能由 `submit()` 产生
 * （不变量 A）。本模型没有「失败的 WorkItem」状态：Attempt 失败只是这一次
 * 尝试没成，WorkItem 停在 dispatched 可再试。
 */
const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  // created -> blocked：**还没派发也能作废**。
  //
  // 早先只有 dispatched 能进 blocked，于是"契约改了、这张工单已经不算数了"
  // 这件事，非得等它被派出去之后才能表达——而那时候执行者已经在跑了。
  // 作废的判据是"这张工单还成不成立"，跟它派没派发无关。
  // 每一个状态都能进 retired。**作废的判据是"这张工单还成不成立"，
  // 与它此刻走到哪一步无关** —— 这条判断早先只兑现了一半（created -> blocked），
  // 结果 rejected 的工单作废不掉：打回之后被新工单取代的那张，既不能再验收
  // （没有新结果）、也不能作废，把整条 Mission 卡死。实测 W5 撞上过。
  created: ['dispatched', 'blocked', 'retired'],
  dispatched: ['submitted', 'blocked', 'retired'],
  submitted: ['accepted', 'rejected', 'retired'],
  // accepted -> dispatched：**L3 打回时重新打开**。
  //
  // 早先 accepted 是终态，于是协调者被打回后只能为同一条意见另开新工作项——
  // 实测一次滚出三个工作项、七跳、$2.31。L3 说"这份交付不行"时，
  // 组成它的那些验收本来就是暂时的。
  //
  // 不变量 A 不受影响：**到达** accepted 的路依然只有 review('accept') 一条。
  // **accepted 不能进 retired。** 那件事做过、也被验收过了，作废等于抹掉
  // 这段记录。契约改了导致它变得多余，诚实的说法是"它在契约 r1 下被验收过"，
  // 不是"它从来不用做"。
  accepted: ['dispatched'],
  rejected: ['dispatched', 'retired'],
  // 上游把工单修好之后可以重新派发。blocked 不是终态——它是"这张工单
  // 本身不成立，需要有人改它"。
  blocked: ['dispatched', 'retired'],
  // retired 也不是终态：契约再改回来、或者 L3 判断它其实还要做，
  // 直接重新派发即可，不用另开一张丢掉历史的新工单。
  retired: ['dispatched'],
};

export interface WorkItemInit {
  id: string;
  missionId: string;
  title: string;
  /** 工单正文。缺省表示只有标题（老测试走这条路）。 */
  order?: WorkOrder;
  /**
   * 拆出这个工作项时，规划是第几版（S05.2）。
   *
   * **必须冻在工作项上。** 规划会随证据变化；改到 r3 之后，没人能说出 r1 时
   * 拆的那个工单当初依据的是什么——读到的永远是当前那版。L3 检视时问
   * "这个工作项凭什么这么拆"，答案会是错的，而且看不出错。
   */
  planRevision?: number;
}

export type ReviewVerdict = 'accept' | 'reject';

/**
 * 一个工作项。只能由 `Mission.createWorkItem()` 创建，初始状态 `created`。
 */
export class WorkItem {
  #id: string;
  #missionId: string;
  #title: string;
  #status: WorkItemStatus = 'created';
  #attempts: Attempt[] = [];
  #executorSeq = 0;
  #result: unknown;
  #submitted = false;
  /** 实际提交 executionResult 的 Executor Attempt id；未传就是 undefined。 */
  #submittedAttemptId: string | undefined;
  #order: Readonly<WorkOrder> | undefined;
  #reviews: Readonly<ReviewRecord>[] = [];
  #blocked: Readonly<BlockedRecord> | undefined;
  #retired: Readonly<{ reason: string }> | undefined;
  #planRevision: number | undefined;

  constructor(init: WorkItemInit) {
    this.#id = init.id;
    this.#missionId = init.missionId;
    this.#title = init.title;
    this.#planRevision = init.planRevision;
    if (init.order) {
      this.#order = freezeWorkOrder(init.order, 'strict');
    }
  }

  /** 拆出它时规划是第几版（S05.2）。冻住，之后规划怎么改都不动。 */
  get planRevision(): number | undefined {
    return this.#planRevision;
  }

  get id(): string {
    return this.#id;
  }

  get missionId(): string {
    return this.#missionId;
  }

  get title(): string {
    return this.#title;
  }

  get status(): WorkItemStatus {
    return this.#status;
  }

  /** 只读副本：外部 push/splice 影响不到聚合内部。 */
  get attempts(): readonly Attempt[] {
    return [...this.#attempts];
  }

  /** `submit()` 带来的产物，未提交时为 undefined。 */
  get result(): unknown {
    return this.#result;
  }

  get hasResult(): boolean {
    return this.#submitted;
  }

  /**
   * 实际提交 executionResult 的 Executor Attempt id。
   * 直接 kernel submit 未传、或老快照缺字段时为 undefined——不从 attempts 猜。
   */
  get submittedAttemptId(): string | undefined {
    return this.#submittedAttemptId;
  }

  /** `created` / `rejected` / `blocked` / `accepted`（被 L3 打回后重开）都可以再派发。 */
  dispatch(): void {
    this.#goto('dispatched');
  }

  /**
   * 开一次执行者尝试。仅允许在 `dispatched` 上调用；
   * 已有 in_progress attempt 时抛 CONCURRENT_EXECUTOR_ATTEMPT（不变量 B 的
   * WorkItem 侧对应物）。调用后 WorkItem 状态不变——开尝试不是流转。
   */
  startAttempt(): Attempt {
    if (this.#status !== 'dispatched') {
      throw new IllegalTransitionError('WorkItem', this.#status, 'startAttempt');
    }
    if (this.#hasInProgressAttempt()) {
      throw new InvariantViolationError(
        'CONCURRENT_EXECUTOR_ATTEMPT',
        `WorkItem ${this.#id} already has an in_progress attempt`,
      );
    }
    this.#executorSeq += 1;
    // id 必须在 **Mission 内**唯一，不只是在本 WorkItem 内。
    // 早先是裸 `exec-${n}`，于是两个工作项各有一个 exec-1；平台按
    // (missionId, attemptId) 查 attempt 时只会找到第一个，第二个工作项的
    // 工具调用就被悄悄记到了第一个工作项的尝试上。
    // 分隔符用 `.` 不用 `/`：attempt id 要进 URL 路径，带斜杠会把路由切碎。
    const attempt = new Attempt({
      id: `${this.#id}.exec-${this.#executorSeq}`,
      kind: 'executor',
      missionId: this.#missionId,
      workItemId: this.#id,
    });
    this.#attempts.push(attempt);
    return attempt;
  }

  /**
   * 执行者交付产物。仅 `dispatched` -> `submitted`。
   * 这里绝不进入 accepted（不变量 A），也不要求 Attempt 已经 succeed——
   * 交付判定与尝试判定是解耦的两件事。
   *
   * `submittedAttemptId` 是只读 provenance：记录**谁**交的这份结果。
   * kernel 不验证 attempt 角色/归属（不认识调用上下文），由 Platform 保证；
   * 未传就是 undefined，禁止从 attempts 反推。
   */
  submit(result?: unknown, submittedAttemptId?: string): void {
    this.#goto('submitted');
    this.#result = result;
    this.#submitted = true;
    this.#submittedAttemptId = submittedAttemptId;
  }

  /** 验收。仅 `submitted` -> `accepted` / `rejected`；在 dispatched 上调用必须抛错。 */
  review(verdict: ReviewVerdict, record?: Omit<ReviewRecord, 'verdict'>): void {
    if (verdict !== 'accept' && verdict !== 'reject') {
      throw new IllegalTransitionError('WorkItem', this.#status, String(verdict));
    }
    // 先规范化 record，再流转：校验失败不得污染 status / reviews。
    const frozenRecord = record ? freezeReviewRecord(record, verdict) : undefined;
    this.#goto(verdict === 'accept' ? 'accepted' : 'rejected');
    if (frozenRecord) {
      this.#reviews.push(frozenRecord);
    }
  }

  /* --------------------------- 载荷（非状态） --------------------------- */

  get order(): Readonly<WorkOrder> | undefined {
    return this.#order;
  }

  /** 每次验收留一条；被打回重做的工作项会有多条。 */
  get reviews(): readonly Readonly<ReviewRecord>[] {
    return [...this.#reviews];
  }

  get blocked(): Readonly<BlockedRecord> | undefined {
    return this.#blocked;
  }

  /** 已提交时返回结构化执行结果。 */
  get executionResult(): Readonly<ExecutionResultBody> | undefined {
    return this.#submitted
      ? (this.#result as Readonly<ExecutionResultBody> | undefined)
      : undefined;
  }

  /**
   * 执行者报告工单不成立。
   *
   * **这是一次真流转**：`dispatched -> blocked`。早先的版本只记载荷、
   * 让工作项留在 dispatched，结果调度器看到它还"在途"，立刻又派一个执行者
   * 去做同一张不成立的工单——换个人做不会产生任何新信息，只会把候选池烧完。
   * 离开 dispatched，控制权才回得到上游。
   */
  recordBlocked(record: BlockedRecord): void {
    this.#goto('blocked');
    this.#blocked = freezePayload({ ...record });
  }

  /** 为什么被作废。没被作废过就是 undefined。 */
  get retired(): Readonly<{ reason: string }> | undefined {
    return this.#retired;
  }

  /**
   * 上游作废这张工单：它不再需要做了。
   *
   * 和 recordBlocked 走不同的状态，因为对 Mission 的含义相反——blocked 要
   * 拦住交卷（有东西没做完），retired 不该拦（那件事已经不用做了）。
   *
   * 理由是必填的：下一轮读到它的人得知道它被什么取代了，否则只会以为还要做。
   */
  retire(reason: string): void {
    this.#goto('retired');
    this.#retired = freezePayload({ reason });
  }

  /* --------------------------- 快照 --------------------------- */

  toSnapshot(): WorkItemSnapshot {
    return {
      id: this.#id,
      missionId: this.#missionId,
      title: this.#title,
      status: this.#status,
      order: this.#order,
      planRevision: this.#planRevision,
      result: this.#result,
      submitted: this.#submitted,
      submittedAttemptId: this.#submittedAttemptId,
      reviews: [...this.#reviews],
      blocked: this.#blocked,
      retired: this.#retired,
      attempts: this.#attempts.map((attempt) => attempt.toSnapshot()),
      executorSeq: this.#executorSeq,
    };
  }

  /** 直接装配历史状态，不重放动作、不重新校验流转。 */
  static restore(snapshot: WorkItemSnapshot): WorkItem {
    const item = new WorkItem({
      id: snapshot.id,
      missionId: snapshot.missionId,
      title: snapshot.title,
    });
    item.#status = snapshot.status as WorkItemStatus;
    // restore 对 validation 宽松：malformed 只丢 validation，其余 order 原样；不抛。
    item.#order =
      snapshot.order == null
        ? undefined
        : freezeWorkOrder(snapshot.order as WorkOrder, 'restore');
    item.#planRevision = snapshot.planRevision;
    item.#result = snapshot.result;
    item.#submitted = snapshot.submitted;
    // 老快照缺字段 → undefined。禁止从 attempts 猜 last attempt。
    item.#submittedAttemptId = snapshot.submittedAttemptId;
    // reviews 历史原样冻结；不在 restore 上 fail-closed 重校验（避免老快照崩）。
    item.#reviews = (snapshot.reviews ?? []).map((r) =>
      freezeDeep(copyReviewRecordShape(r as ReviewRecord)),
    );
    item.#blocked = snapshot.blocked as Readonly<BlockedRecord> | undefined;
    item.#retired = snapshot.retired as Readonly<{ reason: string }> | undefined;
    item.#attempts = (snapshot.attempts ?? []).map((a: AttemptSnapshot) => Attempt.restore(a));
    item.#executorSeq = snapshot.executorSeq ?? 0;
    return item;
  }

  #hasInProgressAttempt(): boolean {
    return this.#attempts.some((attempt) => attempt.status === 'in_progress');
  }

  #goto(to: WorkItemStatus): void {
    if (!WORK_ITEM_TRANSITIONS[this.#status].includes(to)) {
      throw new IllegalTransitionError('WorkItem', this.#status, to);
    }
    this.#status = to;
  }
}

/* -------------------- WorkOrder.validation / ReviewRecord 规范化 -------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(raw).every((k) => allowed.includes(k));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** finite positive integer（>0）；拒绝 0/负/NaN/Infinity/小数/boxed。 */
function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

/** finite nonnegative integer（含 0）。 */
function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function invalidWorkOrderValidation(detail: string): never {
  throw new InvariantViolationError(
    'INVALID_WORK_ORDER_VALIDATION',
    `WorkOrder.validation invalid: ${detail}`,
  );
}

function invalidReviewRecord(detail: string): never {
  throw new InvariantViolationError(
    'INVALID_REVIEW_RECORD',
    `ReviewRecord invalid: ${detail}`,
  );
}

/**
 * 规范化 WorkOrder.validation。
 * - strict（新建）：非法/未知 key/cwd → 抛 INVALID_WORK_ORDER_VALIDATION
 * - restore：非法 → undefined（丢弃 validation，不崩历史恢复）
 */
function normalizeValidationSpec(
  value: unknown,
  mode: 'strict' | 'restore',
): Readonly<WorkOrderValidationSpec> | undefined {
  if (value === undefined) return undefined;

  const fail = (detail: string): undefined => {
    if (mode === 'strict') invalidWorkOrderValidation(detail);
    return undefined;
  };

  if (!isPlainObject(value)) return fail('must be a plain object');
  if (!onlyKeys(value, ['commands'])) return fail('only key commands is allowed');
  if (!Object.prototype.hasOwnProperty.call(value, 'commands')) {
    return fail('commands is required');
  }
  if (!Array.isArray(value.commands)) return fail('commands must be an array');

  const commands: WorkOrderValidationCommand[] = [];
  for (let i = 0; i < value.commands.length; i += 1) {
    const cmd = value.commands[i];
    if (!isPlainObject(cmd)) return fail(`commands[${i}] must be a plain object`);
    if (!onlyKeys(cmd, ['argv', 'timeoutMs'])) {
      return fail(`commands[${i}] only keys argv,timeoutMs are allowed`);
    }
    if (!Array.isArray(cmd.argv)) return fail(`commands[${i}].argv must be a string array`);
    if (cmd.argv.length === 0) return fail(`commands[${i}].argv must be non-empty`);
    if (!cmd.argv.every((a) => isNonEmptyString(a))) {
      return fail(`commands[${i}].argv entries must be non-empty strings`);
    }
    const timeoutMs = asPositiveInt(cmd.timeoutMs);
    if (timeoutMs === undefined) {
      return fail(`commands[${i}].timeoutMs must be a finite positive integer`);
    }
    commands.push({
      argv: [...cmd.argv],
      timeoutMs,
    });
  }

  return freezeDeep({ commands } satisfies WorkOrderValidationSpec);
}

/**
 * 重建 WorkOrder：其余字段浅拷贝 + freezePayload；validation 单独规范化。
 * restore 模式下 validation 非法则省略，其余 order 保留。
 */
function freezeWorkOrder(
  order: WorkOrder,
  mode: 'strict' | 'restore',
): Readonly<WorkOrder> {
  const raw = order as WorkOrder & Record<string, unknown>;
  const hasValidation = Object.prototype.hasOwnProperty.call(raw, 'validation');
  const validation = hasValidation
    ? normalizeValidationSpec(raw.validation, mode)
    : undefined;

  // 不整表重写 schema：展开原 order，再按规范化结果覆盖/删除 validation。
  const copy: Record<string, unknown> = { ...raw };
  if (validation !== undefined) {
    copy.validation = validation;
  } else {
    delete copy.validation;
  }
  return freezePayload(copy as unknown as WorkOrder);
}

function copyAuthority(authority: ReviewAuthority): ReviewAuthority {
  if (authority.kind === 'validator') {
    return {
      kind: 'validator',
      reportId: authority.reportId,
      policyRevision: authority.policyRevision,
    };
  }
  return {
    kind: 'coordinator',
    attemptId: authority.attemptId,
  };
}

/** restore 用：尽量原样拷贝，不 fail-closed。 */
function copyReviewRecordShape(record: ReviewRecord): ReviewRecord {
  const out: {
    attemptId?: string;
    submittedAttemptId?: string;
    authority?: ReviewAuthority;
    verdict: 'accept' | 'reject';
    reasons: string[];
    requiredChanges: string[];
  } = {
    verdict: record.verdict,
    reasons: Array.isArray(record.reasons) ? [...record.reasons] : [],
    requiredChanges: Array.isArray(record.requiredChanges)
      ? [...record.requiredChanges]
      : [],
  };
  if (record.attemptId !== undefined) out.attemptId = record.attemptId;
  if (record.submittedAttemptId !== undefined) {
    out.submittedAttemptId = record.submittedAttemptId;
  }
  if (record.authority !== undefined && isPlainObject(record.authority)) {
    const a = record.authority as ReviewAuthority & Record<string, unknown>;
    if (a.kind === 'validator') {
      out.authority = {
        kind: 'validator',
        reportId: String(a.reportId ?? ''),
        policyRevision: typeof a.policyRevision === 'number' ? a.policyRevision : 0,
      };
    } else if (a.kind === 'coordinator') {
      out.authority = {
        kind: 'coordinator',
        attemptId: String(a.attemptId ?? ''),
      };
    }
  }
  return out;
}

/**
 * 写入路径的 ReviewRecord 规范化：复制数组与 authority，deep freeze。
 * - attemptId 可缺，但仅当 authority.kind==='validator' 且 submittedAttemptId 非空。
 * - authority.kind==='validator' 时 submittedAttemptId 必有；reportId 非空；
 *   policyRevision 为 finite nonnegative integer。
 * - 不查 Attempt 是否属于当前 item（Platform 后续做 trusted linkage）。
 */
function freezeReviewRecord(
  record: Omit<ReviewRecord, 'verdict'>,
  verdict: ReviewVerdict,
): Readonly<ReviewRecord> {
  if (!Array.isArray(record.reasons) || !record.reasons.every((r) => typeof r === 'string')) {
    invalidReviewRecord('reasons must be a string array');
  }
  if (
    !Array.isArray(record.requiredChanges) ||
    !record.requiredChanges.every((r) => typeof r === 'string')
  ) {
    invalidReviewRecord('requiredChanges must be a string array');
  }

  const attemptId = record.attemptId;
  const submittedAttemptId = record.submittedAttemptId;
  const authority = record.authority;

  if (authority !== undefined) {
    if (!isPlainObject(authority)) invalidReviewRecord('authority must be a plain object');
    if (authority.kind === 'validator') {
      if (!isNonEmptyString(authority.reportId)) {
        invalidReviewRecord('validator authority.reportId must be a non-empty string');
      }
      const rev = asNonNegativeInt(authority.policyRevision);
      if (rev === undefined) {
        invalidReviewRecord(
          'validator authority.policyRevision must be a finite nonnegative integer',
        );
      }
      if (!isNonEmptyString(submittedAttemptId)) {
        invalidReviewRecord(
          'validator review requires non-empty submittedAttemptId',
        );
      }
    } else if (authority.kind === 'coordinator') {
      if (!isNonEmptyString(authority.attemptId)) {
        invalidReviewRecord('coordinator authority.attemptId must be a non-empty string');
      }
    } else {
      invalidReviewRecord('authority.kind must be coordinator or validator');
    }
  }

  // attemptId 缺失：只允许诚实的 validator review。
  if (attemptId === undefined || attemptId === '') {
    if (authority?.kind !== 'validator' || !isNonEmptyString(submittedAttemptId)) {
      invalidReviewRecord(
        'missing attemptId only allowed with validator authority and submittedAttemptId',
      );
    }
  } else if (typeof attemptId !== 'string') {
    invalidReviewRecord('attemptId must be a string when provided');
  }

  if (
    submittedAttemptId !== undefined &&
    submittedAttemptId !== '' &&
    typeof submittedAttemptId !== 'string'
  ) {
    invalidReviewRecord('submittedAttemptId must be a string when provided');
  }

  const out: {
    attemptId?: string;
    submittedAttemptId?: string;
    authority?: ReviewAuthority;
    verdict: ReviewVerdict;
    reasons: string[];
    requiredChanges: string[];
  } = {
    verdict,
    reasons: [...record.reasons],
    requiredChanges: [...record.requiredChanges],
  };

  if (isNonEmptyString(attemptId)) out.attemptId = attemptId;
  if (isNonEmptyString(submittedAttemptId)) out.submittedAttemptId = submittedAttemptId;
  if (authority !== undefined) out.authority = copyAuthority(authority as ReviewAuthority);

  return freezeDeep(out);
}
