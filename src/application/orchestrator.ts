/**
 * 调度器 —— 把"手工按一下跑一跳"变成平台自己会走。
 *
 * 它做的事只有四件：
 *   1. 该跑协调者时跑协调者，该跑执行者时跑执行者
 *   2. 开 attempt、换 run token、**在 finally 里收尾**
 *   3. 上游失败时换候选重试；其它失败不换
 *   4. 到轮次上限就停下来并说清楚停在哪
 *
 * 它**不**判断技术对错——那是 L2 的事；也不判断需求对错——那是 L3 的事。
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentRuntime,
  CandidateCircuitRepository,
  Clock,
  ExecutionProfile,
  IdGenerator,
  QueuedHopCapacityRepository,
  QueuedHopRepository,
  RuntimeOutcome,
} from './ports.ts';
import type {
  MissionView,
  Platform,
  QueueClaimIdentity,
  StandardAutoRedispatchHandoff,
} from './platform.ts';
import { PlatformRuleError } from './platform.ts';
import { CHANGE_IMPACT_UNSUPPORTED } from './platform/change-impact.ts';
import type { RunTokenIssuer } from './token-issuer.ts';
import { InPlaceWorkspaceManager, type WorkspaceManager } from './workspace.ts';
import { NoLiveOutput } from './live.ts';
import type { LiveOutput } from './live.ts';
import type { AttemptEndReason, TokenUsage, WaitReason } from '../kernel/index.ts';
import { anyHardAuthoritativeExceeded } from './budget-usage.ts';
import { redactSecrets } from './redact.ts';
import { classifyCandidateFailure, resolveQuotaResetTime, type CandidateCircuit } from './candidate-circuit.ts';
import { findUsageRow, getRuntimeUsage } from './runtime-catalog.ts';
import { lightweightGateTrigger } from './promotion/lightweight-gate.ts';
import {
  acquireQueuedHop,
  compareHopFairness,
  decideCapacityClaim,
  DEFAULT_HOP_LEASE_MS,
  DurableScheduler,
  hopCapacityLimits,
  hopIdempotencyKey,
  nextLogicalHopCycle,
  parkedQueuedHopWait,
  queuedHopWaitDetail,
  type EligibleHopClaim,
  type HopCapacityLimits,
  type HopRole,
  type QueuedHop,
  type QueuedHopWait,
} from './durable-scheduler.ts';
import {
  beginImpactSupervision,
  impactSupervisionInstruction,
  impactSupervisionSettings,
  impactSupervisionSupported,
  inertImpactSupervisionSession,
  type ImpactHopDisposition,
  type ImpactSupervisionObservation,
  type ImpactSupervisionSession,
  type ImpactSupervisionSettings,
} from './impact-supervisor.ts';
import type { ChangeRequest } from './change-request.ts';

export interface RolePool {
  readonly runtime: AgentRuntime;
  /** 有序候选集。只有上游失败才允许往后换。 */
  readonly candidates: readonly ExecutionProfile[];
  /** 装配层可提供实时配置；每次选下一跳重新读取，已启动的跳保留自己的 profile。 */
  readonly loadCandidates?: () => Promise<readonly ExecutionProfile[]>;
  /**
   * 同一个工作项最多尝试几次（跨候选累计）。
   *
   * S07.5：到上限就交回上游，**不要无限往下换**。候选池有五个的话，
   * 一个前提就错的工单会把五个全烧一遍才停——每一次都产生不了新信息。
   * 默认 3。
   */
  readonly maxAttempts?: number;
  /**
   * 候选被判上游失败之后冷却多久（毫秒）。
   *
   * S07.4：v1 只做 Availability + 顺序 failover，**不做完整的断路器状态机**。
   * 冷却就是最小可用形态：刚被限流的候选先放一会儿，别下一跳又撞上去。
   * 默认 5 分钟。
   */
  readonly cooldownMs?: number;
}

/** 候选的可用性。v1 只有这三种，不做 closed/open/half-open。 */
export type CandidateAvailability = 'available' | 'cooldown';

/** 三类 agent 各自的候选池名字。与 RolePool 一一对应，不含旁路。 */
export type RolePoolName = 'coordinator' | 'executor' | 'independent_reviewer';

/**
 * 冷却快照里的可用性。比 CandidateAvailability 多一档 unknown。
 *
 * unknown 的语义是**不可证明可用**——持久熔断处在 half_open（探针在跑）、
 * 到期值读不出来、或者仓储给了读不懂的行。它**不是**冷却：把 unknown 折算成
 * 一个等待时长，等于把一个「仓储坏了，要人看」的情况伪装成「等一会就好」。
 */
export type RoleCooldownAvailability = 'available' | 'cooldown' | 'unknown';

export interface RoleCooldownCandidate {
  readonly profileId: string;
  readonly availability: RoleCooldownAvailability;
  /** 冷却到期（ISO）。只有 availability === 'cooldown' 时出现。 */
  readonly until?: string;
  /**
   * 从调用方给的 now 起还要等多久（毫秒）。available 是 0。
   *
   * 已过期的 open 会给出 0：调度器把这种行当可用（见 #availableCandidates）。
   * 调用方据此决定等不等，而不是拿 availability 字符串当等待时长。
   */
  readonly retryAfterMs?: number;
}

/**
 * 心跳间隔。
 *
 * 要比收敛的容忍窗口（DEFAULT_LEASE_TOLERANCE_MS，90 秒）小好几倍：
 * 偶尔漏一两拍不能被判死，而真的死了也不该让人等太久。
 */
const HEARTBEAT_MS = 15_000;

/**
 * 一跳最多跑多久（墙钟）。到点**停下来等人**，不是换个候选再赌一次。
 *
 * 和运行时那个静默超时是两条不同的判据，都要有：
 *   - 静默超时问的是「它还在产出吗」——不产出就是卡死了，杀掉没有损失；
 *   - 这一条问的是「它产出了这么久，还在做同一件事吗」——一个一直在动的
 *     agent 永远触发不了前者。实测 W-785 连续产出了 **72 分钟**，做的是一个
 *     后来被契约改版作废的工单，静默超时一次都没响。
 *
 * 为什么是「先问再杀」而不是到点直接砍：曾经有过 20 分钟的硬性总时长上限，
 * 被实测推翻过——执行者连续干 45 分钟读代码、改文件、跑测试是正常工作。
 * 所以这里到点只做三件事：收掉进程、把这一跳标成疑似跑飞、**把整条 Mission
 * 停下来交给人**。不冷却候选、不失败转移——那会把一个需要人判断的情况
 * 伪装成配额问题，然后拿第二个候选再烧一遍同样的 72 分钟。
 *
 * 30 分钟：W1–W4 里最长的一次**正常**执行者跑了 25 分钟，协调者最长 6 分钟。
 */
const ATTEMPT_WALL_CLOCK_MS = 30 * 60 * 1000;

/**
 * 候选额度快照的复用窗口。
 *
 * 60 秒这个量级对着的是「一跳」而不是「一次读取」：一次筛选内本来就去重成一次，
 * 60 秒足够覆盖紧随其后的下一跳，又不至于长到让一个刚恢复的上游一直显示耗尽。
 */
const USAGE_CACHE_TTL_MS = 60_000;

/**
 * 同一工作项「尾部连续 no_structured_result」的封顶次数。
 *
 * 执行者跑完一跳没交结构化结果，平台以前会把同一个候选原样再叫起来（实测一个
 * 候选连跑 12 次，每次只交一条开工证据）。换个候选再赌能产生新信息，这一点和
 * 上游失败一样；但**赌的次数要有界**——封顶之后交回协调者，由它判断工单本身是
 * 不是有问题，而不是继续烧配额。
 *
 * 数的是**跨候选**的尾部连续次数：换了人还是没结果，说明问题多半不在人身上。
 */
const WORK_ITEM_NO_RESULT_LIMIT = 4;

/**
 * 单个候选在同一工作项上连续两次没有结构化结果，就在**这个工作项上**被本地排除。
 *
 * 只作用在这个工作项的下一次执行跳，不写候选熔断、不写冷却——同一个人在别的工作
 * 项上照样能用，而全局熔断的语义（哪类失败才算候选故障）一点都不改。
 */
const CANDIDATE_NO_RESULT_LIMIT = 2;

export interface OrchestratorDeps {
  platform: Platform;
  tokens: RunTokenIssuer;
  baseUrl: string;
  /** 实时输出去处。不配就是不要实时——不影响其余任何行为。 */
  live?: LiveOutput;
  /** 租约持有者标识。缺省用进程号。 */
  owner?: string;
  coordinator: RolePool;
  executor: RolePool;
  /** 独立检视专用池；缺了就停在故障，不得改用协调者候选。 */
  independentReviewer?: RolePool;
  workspace: WorkspaceManager;
  /** 单跳墙钟上限。缺省 ATTEMPT_WALL_CLOCK_MS；测试用它把 30 分钟缩成几毫秒。 */
  attemptWallClockMs?: number;
  /**
   * 人已经知道分叉基线过期了，照跑。
   *
   * 这一条只关掉**派发前的早期预警**；落地那道闸照样核对基线，安全性质
   * 不受影响。见 #staleAcknowledged。
   */
  acceptStaleBase?: boolean;
  candidateCircuits?: CandidateCircuitRepository;
  /**
   * Optional durable hop queue. When omitted, start tokens and runtime.start
   * behave as before. Property name is the production wiring contract.
   */
  queuedHops?: QueuedHopRepository;
  hopClock?: Clock;
  hopLeaseMs?: number;
  hopIds?: IdGenerator;
  /**
   * 五维并发上限。省略则用 durable-scheduler 代码默认值。
   * 必须在构造时归一化：坏值若拖到领取才抛，队列可能已被领取、Agent 已经启动。
   * 与 MissionRunner 同名，生产注入 QueuedHopCapacityRepository 时才按此上限 claimAvailable。
   */
  hopCapacityLimits?: HopCapacityLimits;
  /**
   * 可换候选失败后，同一次 runMission 最多睡多久等队列退避到期再重领同一槽。
   * 缺省 0：立刻 waiting，保持 D7。生产 CLI 传 120000，让首次 1s 退避不必结束运行。
   */
  inRunBackoffWaitMs?: number;
  /**
   * 运行期影响判断监督（AC3）：**默认关闭的 opt-in**。
   *
   * 省略这个字段就是生产默认：零监督、零 hop，行为与现网一致。给了它也不代表
   * 能监督 —— 牌口要有 startImpactCoordinator、Platform 要装配变更仓储、队列
   * 仓储要有 claimAvailable，缺任一项按 unsupported 处理（不退化成普通
   * coordinator 牌，也不拿无 claim 的启动去碰运气）。
   *
   * 坏值在构造时抛，和 inRunBackoffWaitMs 同风格：pollIntervalMs=0 会变成忙等，
   * 而那时候执行者已经在跑，症状是「这一跳多了几条莫名其妙的 hop」。
   */
  impactSupervision?: {
    readonly enabled: true;
    readonly pollIntervalMs: number;
    readonly maxChecks: number;
  };
  usageReader?: () => Promise<{ readonly available: boolean; readonly [key: string]: unknown } | readonly unknown[]>;
  now?: () => Date;
}

/** 运行内退避等待上限：非负安全整数，缺省 0。非法值必须在构造时抛，不能拖到第一跳失败。 */
export function inRunBackoffWaitMs(value: unknown = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('inRunBackoffWaitMs must be a non-negative safe integer');
  }
  return value;
}

export interface RunMissionOptions {
  /** 项目仓库根目录。调度器据此为本 Mission 开一个隔离的工作区。 */
  projectRoot: string;
  /** 轮次上限。到顶就停，避免打转烧配额。 */
  maxRounds?: number;
}

export type MissionRunOutcome =
  | { kind: 'delivered' }
  /** 协调者交卷了，等 L3 最终检视。**改动还没落地。** */
  | { kind: 'awaiting_l3_review' }
  | { kind: 'blocked'; reason: string }
  /** 协调者把问题交给 L3 了。**这不是失败**，是等人——结果已在收件箱。 */
  | { kind: 'awaiting_l3'; question: string }
  /**
   * 暂时进行不下去，但**不是失败**：候选在冷却、尝试到上限之类。
   * 和 stalled 分开，因为处置不同——这个等一会儿重跑就行。
   *
   * `candidateRole` 只在**确由该角色的候选拿不出人**造成 no_available_agent
   * 时才带。
   *
   * 为什么不能拿 reason 自己当判据：`no_available_agent` 这个字符串同时盖着
   * 几件不同的事故——冻结范围检查点失败也用它。方案驱动（#27 的等待探针）
   * 若只看 reason 就去等候选冷却，会把「检查点失败、要人来看」写成
   * 「等一会儿就好」，于是没人来看。
   *
   * 为什么带了角色也**不等于**全在冷却：角色只说「这一跳缺的是谁的人」，
   * 候选可能只是 unknown（探针在跑、仓储读不懂）。到底等不等，得再拿
   * roleCooldownSnapshot 按这个角色算一遍。
   */
  | { kind: 'waiting'; reason: WaitReason; detail: string; candidateRole?: RolePoolName }
  | { kind: 'stalled'; reason: string };

/**
 * 每一跳协调者开头都要说的那句。
 *
 * 自从不再续跑会话（见 runMission 里那段注释），每一跳都是**全新的进程、
 * 空白的上下文**。不明说的话，模型会按"我刚才在做什么"的惯性往下接——
 * 而它并没有"刚才"。把这件事讲在最前面，它才会先去读平台上的状态，
 * 而不是凭一段不存在的记忆开工。
 */
const FRESH_SESSION_PREFIX =
  '（这是一次全新的会话：你**不记得**上一跳做过什么。' +
  '这条 Mission 的全部状态——调查发现、根因、排除过的假设、决策、方向、' +
  '工作项、验收记录、升级问答——都在平台上，而这一跳要用的已经在开跑简报里。' +
  '只有简报缺了你要用的内容时，才按正文写的三种情况按需查询——' +
  '其中包括用 coagent_get_mission 取全量工作项索引。' +
  '你自己上一跳写回平台的东西仍然算数，没写回去的已经没了。）';

/**
 * 唤醒协调者时说什么。
 *
 * 不同的唤醒原因要说不同的话：被 L3 打回和执行者交回结果是两件事，
 * 用同一句话叫醒它，它就得自己去猜发生了什么。
 */
function coordinatorInstruction(view: {
  status: string;
  planRevision: number;
  finalReview?: { verdict: string; reasons: readonly string[] } | undefined;
  escalationLog: { question: string; answer?: string }[];
  workItems: { id: string; status: string }[];
  promotions?: readonly { triggerRule: string }[];
  conflictFiles?: readonly string[];
  waitDetail?: string;
}): string {
  // 开局那一跳不用说这句：它本来就没有"上一跳"，讲一遍只会让人（和模型）
  // 以为前面发生过什么。
  const opening =
    view.planRevision === 0 &&
    view.workItems.length === 0 &&
    view.escalationLog.length === 0 &&
    !view.finalReview;
  const body = [
    // 同一工作项无结果到顶 / 排除后没人：平台把这一跳的**唯一**原因写在这里。
    // 不写的话，协调者只知道工作项卡住了（或收尾被拒后仍停在 dispatched）、
    // 以及一句泛泛的「按简报决定下一步」——它会以为是普通的空闲轮回，而不是
    // 这次执行被拦住。
    view.waitDetail ? `**执行者已经被挡住：** ${view.waitDetail}` : '',
    coordinatorBody(view),
  ]
    .filter(Boolean)
    .join('\n\n');
  const freshBody = opening ? body : [FRESH_SESSION_PREFIX, '', body].join('\n');
  if (!view.conflictFiles?.length) return freshBody;
  return [
    '**阻断：Mission Git index 存在未合并路径。请先创建工作项修复冲突，保留双方改动，不要丢弃任一方。**',
    ...view.conflictFiles.map((file) => `- ${file}`),
    '',
    freshBody,
  ].join('\n');
}

/**
 * 机器接续这一跳时对执行者说什么。
 *
 * 上一轮为什么被退回、上轮说明是什么，本来会被这一跳从头忘掉——执行者于是可能
 * 把同一个错再犯一遍。平台把它持久化在事件流里，这里只负责把它说清楚，并且
 * 重申「冻结工单才是权威」：摘要是人话，不是可以拿来改目标的依据。
 */
function executorContinuationInstruction(handoff: StandardAutoRedispatchHandoff): string {
  const why =
    handoff.reason === 'partial'
      ? `你上一轮提交的是半成品（这是第 ${handoff.count} 次接着做）`
      : `你上一轮交付的冻结命令验证没通过（这是第 ${handoff.count} 次退回重做）`;
  return [
    `${why}，平台把同一个工作项退回给你。接着做，不要从头再来。`,
    '工单已在开跑简报的「你的工单」一节里，直接照它执行；只有简报里没有工单正文时才调用 coagent_get_work_order。',
    '冻结工单才是权威，下面的说明只是补充。',
    `上一轮说明：${handoff.summary}`,
  ].join('\n');
}

function coordinatorBody(view: {
  status: string;
  planRevision: number;
  finalReview?: { verdict: string; reasons: readonly string[] } | undefined;
  escalationLog: { question: string; answer?: string }[];
  workItems: { id: string; status: string }[];
  promotions?: readonly { triggerRule: string }[];
}): string {
  // 本跳简报优先。
  //
  // 开跑简报（/api/run/brief）已经带着契约、规划、工作项索引与上一跳增量——
  // 每一跳都先 coagent_get_mission 等于把同一份状态再买一遍。协调者轮次是整条
  // Mission 开销的主项（一条走到六轮的，协调者一个人占 74%），所以默认不查。
  const briefFirst =
    '这一跳要用的状态已经在开跑简报里（契约、规划、工作项索引、上一跳增量）。' +
    '直接照它开工，不要先 coagent_get_mission 再取一遍。';
  // 「按需查询」必须点名哪个缺口用哪个工具。不点名的话它会退化成「每次都查
  // mission」——而全量索引正是这几份里最贵的那一份，等于什么都没省。
  const queryWhenNeeded =
    '只有在这三种情况下才查：' +
    '(1) 简报缺你要用的必要详情——缺某张工单的正文 / 证据 / 评审用 coagent_get_work_item，' +
    '缺验收标准原文用 coagent_get_contract，确实需要全量工作项索引才用 coagent_get_mission；' +
    '(2) 发现并发变化——简报是这一跳开始时拍的，之后有人改过就不作数；' +
    '(3) 平台拒绝了你的调用，要按错误提示补信息。';
  // 派发前的交接。执行者没有协调者的权限：让它自己去翻它拿不到的契约，结果
  // 只能是 report_blocked，或者凭猜测补一条——两种情况都白花一整跳。
  const acceptanceHandoff =
    '**派发前交接**：工单要求引用上层 Contract 的验收标准时，必须在 requiredBehaviour ' +
    '或 contextRefs 里给出相关验收的原文（或完整的对应表）。执行者无需、也不应自行寻找' +
    '它无权限取得的契约；只带与这张工单相关的条目，不要把整份契约背景重复搬进工单。';
  // 共用段落每个分支都带：交接提示漏掉一个分支，从那个分支派出去的工单就缺验收
  // 原文，而补那一跳的代价远大于多说这三段。
  const shared = [briefFirst, queryWhenNeeded, '', acceptanceHandoff];
  const answered = view.escalationLog.filter((item) => item.answer).at(-1);
  if (view.finalReview?.verdict === 'send_back') {
    const reasons = view.finalReview.reasons.map((reason) => `  - ${reason}`).join('\n');
    // 补修顺序由平台说了算，不由「优先改原项」这句口号说了算：accepted 与 dispatched
    // 都不可修订（协调者 Node 实验里两个状态的 revise 都是 ILLEGAL_TRANSITION）。
    // 所以先把工作项分成可修订与已验收两类，各给一条走得通的顺序——照一句做不到的
    // 指令撞两次 409，实测就是三个工作项、七跳、$2.31。
    const revisable = view.workItems.filter(
      (item) => item.status === 'created' || item.status === 'rejected' || item.status === 'blocked',
    );
    // 已验收的历史留着：那件事做过、也被验过，抹掉它等于改写记录。补修是另开一张
    // 引用它的工单，不是把它改掉。
    const accepted = view.workItems.filter((item) => item.status === 'accepted');
    const list = (items: readonly { id: string }[]): string =>
      items.map((item) => item.id).join('、') || '无';
    return [
      'L3 把这个 Mission 打回了，理由：',
      reasons,
      '',
      `**可修订的**（${list(revisable)}，状态 created / rejected / blocked）：` +
        '先 coagent_revise_work_order 把工单改对，再派发。派发之后同样改不了，顺序不能反。',
      `**已验收的**（${list(accepted)}）：accepted 不能修订。` +
        '保留它已验收过的历史，另建一张补修工单——正文里引用原工作项 id 与 L3 指出的差距——再派发那张新的。',
      '一条差距一张补修单：为同一条意见另开多张，实测滚出三个工作项、七跳、$2.31。',
      '重新派发或新建的工单必须与上一版有可见差异——逐字相同的工单不算数。',
      '',
      ...shared,
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (answered?.answer) {
    return [
      'L3 答复了你的升级。',
      `问题：${answered.question}`,
      `答复：${answered.answer}`,
      '按这个答复继续。',
      '',
      ...shared,
    ].join('\n');
  }
  const blocked = view.workItems.filter((item) => item.status === 'blocked');
  if (blocked.length > 0) {
    // 只提 blocked，**不提 retired**：作废掉的那些已经不用管了，而且现在也
    // 不再拦着交卷。早先两者同一个状态，这句话只好含糊地说"可能是执行者报的、
    // 也可能是 L3 作废的"，然后让协调者自己去猜该不该管。
    return [
      `执行者报了 ${blocked.length} 个工作项不成立（${blocked.map((i) => i.id).join('、')}）。`,
      // 执行者的 blocked 报告本来就是「相关事实 / 缺什么决定 / 建议怎么办」三段，
      // 协调者的处置要把这三段并起来说——只回一句「不成立」，下一次还是同一个人
      // 在同一处卡住。
      '它的报告里已经带着相关事实、缺什么决定、建议怎么办；缺原记录就用 coagent_get_work_item 取详情，' +
        '判断之后二选一：',
      '**确实还要做**就先 coagent_revise_work_order 把工单改对（blocked 可修订），再派发；',
      '**已经不用做了**就 coagent_retire_work_item 作废，理由里把相关事实、缺的决定、建议一次写清。',
      '别把它晾在那儿——blocked 会一直拦着这条 Mission 交卷。',
      '',
      ...shared,
    ].join('\n');
  }
  const submitted = view.workItems.filter((item) => item.status === 'submitted');
  if (submitted.length > 0) {
    // 数量要说出来。只说"有结果交回来了"的话，验完第一个就交还控制权是完全
    // 合理的反应——而每交还一次就是一轮全新的协调者会话，把之前的上下文
    // 重放一遍。实测协调者轮次是整条 Mission 开销的主项（一条走到六轮的，
    // 协调者一个人占 74%），所以这一句必须把"这一轮要做完几件"钉死。
    const ids = submitted.map((item) => item.id).join('、');
    // 从 Lightweight 升级上来的：协调者此前没参与过，不说的话它不知道机器验收已经判过一轮、为什么没放行。
    const promoted = view.promotions?.at(-1);
    const origin = promoted
      ? `这条 Mission 是从 Lightweight 升级上来的，原因：${promoted.triggerRule}\n\n`
      : '';
    return [
      origin +
        `平台唤醒你：${submitted.length} 个工作项交回了结果（${ids}）。` +
        '**在这一轮里把它们全部验收完**——每交还一次控制权就是一轮全新的协调者会话。',
      // 逐项验收与打回都用现有字段：acceptanceResults 逐条给结论；reject 的
      // requiredChanges 写清验收项 / 实际 / 预期 / 怎么复验——只给一句「没过」，
      // 执行者只能猜差在哪，下一轮多半原样交回来。
      '验收用 coagent_review_execution_result：accept 要逐条给 acceptanceResults；' +
        '打回用 requiredChanges，每条写清**验收项 / 实际 / 预期 / 怎么复验**，不要另造字段。',
      '验完之后如果还有下一批要做的，同样**一次派完**——' +
        'coagent_dispatch_work_item 的 workItemIds 是数组，互不依赖的放在同一次调用里。',
      '',
      ...shared,
    ].join('\n');
  }
  if (view.planRevision > 0) {
    return ['平台唤醒你。按简报决定下一步。', '', ...shared].join('\n');
  }
  return ['开始这个 Mission。', '', ...shared].join('\n');
}

/**
 * 结果行里的用量和实时通道里最后一次报告，取可信的那个。
 *
 * 结果行是权威的——它是 agent 自己算完的总账。但进程被杀时根本没有结果行，
 * 运行时补的是一个全零的 UNKNOWN，直接记下去就等于宣称这一跳没花钱。
 * 实测一跳跑了 8 分 50 秒、实时通道里报了几十次用量，账上是 0。
 */
function usableUsage(
  reported: TokenUsage | undefined,
  streamed: TokenUsage | undefined,
): TokenUsage | undefined {
  const trustworthy = reported && reported.quality !== 'unknown' && reported.total > 0;
  if (trustworthy || !streamed) return reported;
  // 降一级：这是"最后一次报告"，不是"跑完的总账"——后面可能还有几次调用
  // 没来得及报。标成 estimated，别让它冒充精确数。
  return { ...streamed, quality: 'estimated' };
}

/** 一跳的记录，给 Timeline 和排障用。 */
export interface HopRecord {
  role: 'coordinator' | 'executor' | 'independent_reviewer';
  workItemId?: string;
  attemptId: string;
  profile: ExecutionProfile;
  endedBy: string;
  failureMessage?: string;
}

export class Orchestrator {
  #platform: Platform;
  #tokens: RunTokenIssuer;
  #baseUrl: string;
  #live: LiveOutput;
  /** 租约持有者。判死之前能说清楚「本来是谁在跑」。 */
  #owner: string;
  #coordinator: RolePool;
  #executor: RolePool;
  #independentReviewer: RolePool | undefined;
  #workspace: WorkspaceManager;
  #wallClockMs: number;
  #candidateCircuits: CandidateCircuitRepository | undefined;
  #usageReader: () => Promise<{ readonly available: boolean; readonly [key: string]: unknown } | readonly unknown[]>;
  /**
   * 候选额度读取的**实例级**短期缓存。
   *
   * 为什么必须有：一次筛选要先给 N 个候选逐个问「你还有额度吗」，N 次问的其实是
   * 同一份快照；一条 Mission 有几跳（规划、执行、验收），每跳都重新拉一遍，于是
   * 一次运行把同一个上游打十几次。去限流的是我们自己的读，不是候选。
   *
   * 为什么是实例字段而不是模块级：模块级会在同一进程里串到别的 Mission / 别的
   * 测试替身上——一份读错的行会让**别人**的候选被误判成耗尽，而症状隔着一整条
   * Mission 才出现。实例级随编排器生灭，范围恰好是「这一次运行」。
   *
   * 失败与不可用**不写缓存**：写进去等于把一次抖动锁成 60 秒的「没额度」，而
   * 60 秒恰好是一次退避重试的窗口。不缓存，下一跳就能自己恢复。
   */
  #usageCache: { rows: readonly unknown[]; expiresAt: number } | undefined;
  #now: () => Date;
  #queuedHops: QueuedHopRepository | undefined;
  #hopScheduler: DurableScheduler | undefined;
  #hopClock: Clock;
  #hopLeaseMs: number;
  #hopLimits: HopCapacityLimits;
  #inRunBackoffWaitMs: number;
  /** 运行期影响判断监督配置；undefined = 关闭（生产默认）。 */
  #impactSupervision: ImpactSupervisionSettings | undefined;
  /** hopClock 上的本次 runMission 墙钟截止；越过则不再睡退避。 */
  #missionDeadlineAt: number | undefined;
  readonly hops: HopRecord[] = [];
  /**
   * 监督动作的可追溯记录（只在 opt-in 启用时会有内容）。
   *
   * 为什么只记不判：这段日志回答的是「这一代执行期间到底有没有开过判断跳、
   * 为什么没开」，而排障者需要能看出它**没有**拿这些动作冒充验收或应用。
   */
  readonly impactObservations: ImpactSupervisionObservation[] = [];
  /** profileId → 冷却到期时间戳。S07.4 的 Availability，最小可用形态。 */
  readonly #cooldown = new Map<string, number>();
  /**
   * 基线过期已经被人认过了 —— 由调用方在**下一次运行**时显式传进来。
   *
   * 这里曾经是一个进程内的布尔量，注释写着"报一次，之后重跑就放行"。
   * **它从来没有兑现过那句话**：CLI 是一次运行一个进程，新进程把它重置回
   * false，于是同一条 Mission 每跑一次都被同一句话挡回去，永远走不下去。
   * 没有任何测试会红——挡回去看起来就像"它确实过期了"。
   *
   * 改成显式入参之后，"我知道了，继续"这件事有了一个真实的载体：人看到警告，
   * 加上 --accept-stale-base 再跑。不是隐式状态，也不会自己失忆。
   */
  #staleAcknowledged: boolean;
  /** 本次运行实际用的工作区，跑完打给调用方看。 */
  workspace: { cwd: string; branch: string; baseRevision: string } | undefined;

  constructor(deps: OrchestratorDeps) {
    this.#platform = deps.platform;
    this.#tokens = deps.tokens;
    this.#baseUrl = deps.baseUrl;
    this.#live = deps.live ?? new NoLiveOutput();
    this.#owner = deps.owner ?? `pid-${process.pid}`;
    this.#coordinator = deps.coordinator;
    this.#executor = deps.executor;
    this.#independentReviewer = deps.independentReviewer;
    this.#workspace = deps.workspace;
    this.#wallClockMs = deps.attemptWallClockMs ?? ATTEMPT_WALL_CLOCK_MS;
    this.#candidateCircuits = deps.candidateCircuits;
    this.#usageReader = deps.usageReader ?? getRuntimeUsage;
    this.#usageCache = undefined;
    this.#now = deps.now ?? (() => new Date());
    this.#staleAcknowledged = deps.acceptStaleBase ?? false;
    this.#queuedHops = deps.queuedHops;
    this.#hopClock = deps.hopClock ?? { now: () => new Date() };
    this.#hopLeaseMs = deps.hopLeaseMs ?? DEFAULT_HOP_LEASE_MS;
    // 坏上限在第一跳领取前就必须拒绝。默认走代码上限，避免漏配变成「不限」。
    this.#hopLimits = hopCapacityLimits(deps.hopCapacityLimits);
    this.#inRunBackoffWaitMs = inRunBackoffWaitMs(deps.inRunBackoffWaitMs);
    this.#impactSupervision = impactSupervisionSettings(deps.impactSupervision);
    this.#hopScheduler = deps.queuedHops
      ? new DurableScheduler(
          deps.queuedHops,
          this.#hopClock,
          deps.hopIds ?? { next: (prefix) => `${prefix}-${randomUUID()}` },
          this.#hopLimits,
        )
      : undefined;
  }

  async runMission(missionId: string, options: RunMissionOptions): Promise<MissionRunOutcome> {
    const maxRounds = options.maxRounds ?? 12;
    // 用 hopClock：队列 availableAt 也按它算。混用 Date.now 会让固定时钟测试误睡、或把已到期当成未到期。
    this.#missionDeadlineAt = this.#hopClock.now().getTime() + this.#wallClockMs;

    // 一 Mission 一个隔离工作区，用户自己的 checkout 从头到尾没被碰过。已记着分叉基线就照它来 ——
    // 重跑靠这个和第一次同版起步；这份视图还回答“进来时停在哪”，下面清等待要用。
    const initialView = await this.#platform.getMissionView(missionId);
    const pinnedBase = initialView.workspaceRef?.baseRevision;
    const prepared = await this.#workspace.prepare(missionId, options.projectRoot, pinnedBase);
    this.workspace = prepared;
    const cwd = prepared.cwd;
    // 落地时要拿分叉基线核对目标有没有动过，所以记回平台。
    await this.#platform.recordWorkspace(missionId, {
      projectRoot: options.projectRoot,
      branch: prepared.branch,
      targetBranch: prepared.targetBranch,
      baseRevision: prepared.baseRevision,
    });

    // 又动起来了：清掉上一轮停机原因，不然界面上一直挂着旧原因。票级那两条例外 —— 只能由增额 / 批准
    // 检查点解除，重跑不构成批准，清掉就是把门禁原因丢了。
    if (
      initialView.waitReason !== 'mission_cost_cap_reached' &&
      initialView.waitReason !== 'work_item_checkpoint'
    ) {
      await this.#platform.setWaitReason(missionId, undefined);
    }

    for (let round = 0; round < maxRounds; round += 1) {
      const view = await this.#platform.getMissionView(missionId);

      // 名额被别人占着时**不在这里停**：调查与规划的产出都写回平台了，重跑读得到，钱没白花；且**名额
      // 只有派发才需要**，A 改代码时 B 照样能往前推。缺的只是"谁挡着我"看不见，那一格补在
      // MissionView 的 blockedByMission。

      // 被暂停就不碰。放在循环开头而不是入口：跑到一半被暂停也要停下来。
      if (view.paused) {
        const detail = 'Mission 已被暂停，resume 之后重跑';
        await this.#platform.setWaitReason(missionId, 'cancelled_by_user', detail);
        return { kind: 'waiting', reason: 'cancelled_by_user', detail };
      }

      // 协调者交卷了 —— 改动还没落地。HA 在这里接确定性验证与独立检视，仍停在 awaiting_review；不得当成
      // completed，也不得改用协调者自审。
      if (view.status === 'awaiting_review') {
        if (
          view.executionMode === 'high_assurance' &&
          view.result?.outcome === 'delivered'
        ) {
          return await this.#runHaIndependentReview(missionId, cwd);
        }
        return view.result?.outcome === 'delivered'
          ? { kind: 'awaiting_l3_review' }
          : { kind: 'blocked', reason: view.result?.summary ?? '协调者交了 blocked' };
      }
      if (view.status === 'completed') return { kind: 'delivered' };
      if (view.status === 'blocked') {
        const detail = view.finalReview?.reasons.join('；') ?? '已 blocked';
        await this.#platform.setWaitReason(missionId, 'cancelled_by_user', detail);
        return { kind: 'blocked', reason: detail };
      }

      // 票级门禁（费用到 cap / 工作项到未批准检查点）：**任何 agent hop 之前**都要过，且必须在 openEscalations
      // 之前 —— 升级可答复时同样要求值，否则重跑一进来就 awaiting_l3 返回，门禁白写、等待原因也丢。模块已写好
      // waitReason 并投好升级，这里只决定回什么。
      const ticketGate = await this.#enforceMissionTicketGate(missionId);
      if (ticketGate) return ticketGate;

      // 有未答复的升级 —— 停。协调者已经说过它没权限决定，再叫一次只会让它再升级一次；等 L3
      // 答复（answerEscalation）之后再跑。
      if (view.openEscalations.length > 0) {
        return { kind: 'awaiting_l3', question: view.openEscalations[0].question };
      }

      // 真要开始改代码之前，先看分叉基线还是不是目标分支的当前位置（S05.3 / S14.7）：排队期间别
      // 的改动落到目标分支上，照旧基线干出来的东西合不回去（落地闸会拦），而**那时候已经花完钱
      // 了**。v1 不做语义 staleness 判定——只比版本号。重跑不适用：它按定义就处在"基线不等于目标
      // 分支当前位置"，拿这条闸去拦等于一钉基线就跑不起来（实测 P1-single 派发后当场被停）。落地
      // 闸照常核基线，不受影响。
      const isRerun = Boolean(view.origin?.rerunOf);
      if (
        !isRerun &&
        view.workItems.some((item) => item.status === 'dispatched') &&
        view.workspaceRef
      ) {
        const targetNow = await this.#workspace
          .targetHead(options.projectRoot)
          .catch(() => undefined);
        if (
          targetNow &&
          targetNow !== 'unknown' &&
          targetNow !== view.workspaceRef.baseRevision &&
          !this.#staleAcknowledged
        ) {
          this.#staleAcknowledged = true;
          const detail =
            `分叉基线是 ${view.workspaceRef.baseRevision.slice(0, 8)}，目标分支现在是 ` +
            `${targetNow.slice(0, 8)}。照旧基线干出来的东西合不回去——` +
            '先让协调者基于新基线重新核对（重开 worktree，或把目标分支并进 Mission 分支）。' +
            '确认过改动不受影响、要照跑的话，重跑时加 --accept-stale-base。';
          await this.#platform.setWaitReason(missionId, 'base_revision_stale', detail);
          return { kind: 'waiting', reason: 'base_revision_stale', detail };
        }
      }

      // HA 走 Standard 式 Contract→协调者→执行者→L2；独立检视在 awaiting_review 分支。

      // ---- Authoritative budget GATE-PRE (BUDGET-001-S5) ----
      // After HA, before orchestration.round.started / any hop.
      // Hard exceeded: LW promote+continue, Standard wait. Soft: events only.
      // Evaluated before heuristic pool/round/30m stalls so budget wins the label.
      {
        const gate = await this.#enforceAuthoritativeBudget(missionId);
        if (gate.kind === 'stop') return gate.outcome;
        if (gate.kind === 'continue') continue;
      }

      // Durable authoritative round-start fact (BUDGET-001-S2): 在 preflight 诸闸与 budget PRE 之后、
      // Lightweight / pending / Coordinator hop 之前。记上就计入一轮（后续 hop 崩了也算），记不上就
      // 不许往下走（错误直接抛出）。
      await this.#platform.recordOrchestrationRoundStarted(missionId);

      // ---- Lightweight Fast Lane ----
      // 在公共 pause / awaiting_review / completed / blocked / escalation / stale-base / HA 检查之后、
      // Standard pending/coordinator 之前分流，绝不落到「没有 pending → coordinator」。
      if (view.executionMode === 'lightweight') {
        const lightweight = await this.#runLightweightRound(missionId, view, cwd);
        if (lightweight.kind === 'continue') {
          const gate = await this.#enforceAuthoritativeBudget(missionId);
          if (gate.kind === 'stop') return gate.outcome;
          if (gate.kind === 'continue') continue;
          continue;
        }
        return lightweight.outcome;
      }

      // 每轮都读 Git index 当前事实；事件可能已过期，不能作为冲突是否仍存在的依据。查询失败直接
      // 抛出，避免把未知状态误当作无冲突而启动执行者。
      const conflictFiles = await this.#workspace.getMissionConflictFiles?.(
        missionId,
        options.projectRoot,
      );
      const activeConflicts = conflictFiles?.length ? conflictFiles : undefined;
      const oldDispatchedIds = await this.#platform.recordConflictDispatchBarrier(
        missionId,
        conflictFiles ?? [],
      );

      // 有已派发但还没交回结果的工作项，就先把它们跑完 —— **只在 executing 阶段**：退回 planning
      // 意味着这批工单要重新审视，这时候还跑就是明知要重做还先花一遍钱。
      const pending =
        view.status === 'executing'
          ? view.workItems.filter(
              (item) =>
                item.status === 'dispatched' &&
                (!activeConflicts || !oldDispatchedIds.includes(item.id)),
            )
          : [];
      // 交回协调者的等待原因（只在本轮尾部用）：同一工作项的无结果已经到顶、或
      // 局部排除后已无可用候选。**不新造 waitReason**，复用 attempt_limit_reached。
      // 之所以要一个局部标志而不是直接 return：这一批里还有别的 pending，先让它们
      // 各自跑完；最后再让 Standard pending 分支落入既有协调者段。
      let noResultHandoff: string | undefined;
      // 同一个原因要传给协调者那一跳：它只能看见工作项还是 dispatched，不知道
      // 平台刚把这张工单挡住了。用独立的变量而不是复用 noResultHandoff，是因为
      // 后者会在跨轮次时残留，而这一跳的原因必须只属于这一轮。
      let noResultWaitDetail: string | undefined;
      if (pending.length > 0) {
        for (const item of pending) {
          // 同轮第二个执行者也要过这道闸：第一个花到 cap 之后，同一轮剩下的工单不能照跑。
          const perItemGate = await this.#enforceMissionTicketGate(missionId);
          if (perItemGate) return perItemGate;
          // 冻结工单带了 validation.commands 才需要机器验证，也才需要基线：给没命令的项记
          // 基线等于凭空多一批事件，而 W-321 的入口对空命令本来就是 no-op。
          const needsStandardValidation = (item.order?.validation?.commands?.length ?? 0) > 0;
          // **同一工作项的无结果不许无界重跑首候选。**
          //
          // 判据只能从持久 Attempt 历史推导：this.hops 是本进程的内存记录，重启或
          // 换个进程接手就空了，而这条上限必须跨进程成立——否则每次重跑都把计数
          // 清零，等于没有上限（实测一个候选在同一张工单上连跑了 12 次）。
          const rotation = await this.#noResultRotation(missionId, item.attemptIds);
          if (rotation.consecutive >= WORK_ITEM_NO_RESULT_LIMIT) {
            noResultHandoff = this.#noResultHandoffDetail({
              workItemId: item.id,
              consecutive: rotation.consecutive,
              profileIds: rotation.profileIds,
              excludedProfileIds: rotation.excludedProfileIds,
              exhausted: false,
            });
            // COM12 B（W-524）：这不是「等候选冷却」，是**平台自己放弃重跑**，且
            // 最后一次尝试已经收尾。先把停着的 dispatched 可信收成 blocked，
            // 协调者才能修订同一张单再派；转换被拒/失败不改下面的交回语义。
            await this.#blockStalledNoResultLimit(missionId, item, rotation.consecutive);
            // 不开下一次执行跳：再赌一轮既换不回新信息，又正好是这条规则要挡的事。
            continue;
          }
          const excludedProfileIds =
            rotation.excludedProfileIds.length > 0 ? rotation.excludedProfileIds : undefined;
          // 这一跳是不是「接着上一轮做」：退回原因和上轮说明持久化在事件里，断线重启也读得
          // 回来；读到了就写进唤醒语，并把 partial 的续跑句柄原样交给运行时。
          const handoff = await this.#platform.getStandardAutoRedispatchHandoff(
            missionId,
            item.id,
          );
          const hop = await this.#runHop({
            role: 'executor',
            missionId,
            workItemId: item.id,
            cwd,
            pool: this.#executor,
            instruction: handoff
              ? executorContinuationInstruction(handoff)
              : '平台派给你一个工作项：工单已在开跑简报的「你的工单」一节里，直接照它执行；只有简报里没有工单正文时才调用 coagent_get_work_order。',
            ...(handoff?.resumeRef !== undefined ? { resumeRef: handoff.resumeRef } : {}),
            ...(excludedProfileIds ? { excludedProfileIds } : {}),
            ...(needsStandardValidation
              ? {
                  // 基线要在执行者真起来之前落盘：那时候 cwd 的 HEAD 才是这条工单的
                  // 起点。重启续跑（交卷之后、报告之前进程被杀）就是靠它才能补验；
                  // 放到交卷之后记，diff 会把自己刚提交的改动算成没改。
                  onExecutorStart: async () => {
                    // 读不到可信 HEAD 就不记：宁可没有基线（验证入口 fail-closed），也不要假基线。
                    const head = await this.#workspace.head(cwd).catch(() => undefined);
                    if (!head) return;
                    await this.#platform.recordStandardValidationBaseline({
                      missionId,
                      workItemId: item.id,
                      head,
                    });
                  },
                }
              : {}),
          });
          if (hop && 'alreadyCompleted' in hop) continue;
          if (hop && 'retrySameSlot' in hop) {
            // 退避已等到：把领取交给下一轮。同一跳里换 Q 会绕过 maxRounds。
            break;
          }
          if (!hop || 'exhausted' in hop) {
            // 局部排除把候选滤空之后**不许**当成「候选在冷却」：人其实是有的，
            // 只是在这个工作项上被挡了。差别不是措辞——前者等一等就好，后者要
            // 协调者去看这张工单本身是不是有问题。同一工作项四个候选全试过也一样。
            if (hop && hop.exhausted === 'no_available_agent' && excludedProfileIds?.length) {
              noResultHandoff = this.#noResultHandoffDetail({
                workItemId: item.id,
                consecutive: rotation.consecutive,
                profileIds: rotation.profileIds,
                excludedProfileIds,
                exhausted: true,
              });
              // COM12 B（W-524）：候选排除耗尽（人还有、只是在这张单上被挡）
              // 同样属于「平台放弃重跑」。执行者已经不在，先收成 blocked 再交。
              await this.#blockStalledNoResultLimit(missionId, item, rotation.consecutive);
              continue;
            }
            const reason: WaitReason = hop?.exhausted ?? 'no_available_agent';
            const detail = hop?.detail ?? this.#stallDetail(reason, item.id);
            await this.#platform.setWaitReason(missionId, reason, detail);
            return this.#waitingOutcome(reason, detail, hop?.candidateRole);
          }
          if ('persistentUnknown' in hop && hop.persistentUnknown) {
            const detail = '持久候选熔断记录为 unknown；停止本次 runMission，避免后续轮次绕过保守轮换';
            await this.#platform.setWaitReason(missionId, 'no_available_agent', detail);
            return { kind: 'waiting', reason: 'no_available_agent', detail };
          }
          // 交卷了：趁协调者还没被叫起来，先把冻结命令跑一遍存成报告。报告只是给协调者
          // 的证据，不是验收——跑绿了也不 reject/retry，机器不替它评审。
          // **partial 不跑**：冻结命令是给「做完了」的交付当验收材料的，拿半成品去跑等于
          // 把「还没做完」判成「做法不对」，退回一次本来就要接着做的交付。
          if (needsStandardValidation && !(await this.#standardSubmitIsPartial(missionId, item.id))) {
            await this.#validateStandardIfSubmitted(missionId, item.id, cwd);
          }
          // POST_EXECUTION shadow（J2）：交卷之后、协调者评审之前。非权威，出错只进事件；
          // 没交卷（这一跳没 structured submit）时平台自己会跳过。
          await this.#platform.runPostExecutionShadow(missionId, item.id);
          // GATE-POST after each successful hop (tokens/commands/wall accumulate here).
          const gate = await this.#enforceAuthoritativeBudget(missionId);
          if (gate.kind === 'stop') return gate.outcome;
          if (gate.kind === 'continue') break;

          // 机器接续：partial、或验证没过，平台直接把工单退回执行者（最多两次）。续派成功
          // 就不用叫协调者——下一轮 pending 会把这条工单重新领起来；绿报告 / 缺报告 /
          // blocked / 触顶都返回 false，原样交给 L2。
          await this.#autoRedispatchStandard(missionId, item.id);
        }
        // 有工单交回协调者时不 continue：掉进下面的协调者段，让它在简报里
        // 看到次数与候选。两个交回分支在设置 handoff 之前已经调过平台收尾
        // （W-524）：能证明无活执行者就把 dispatched 收成 blocked，收尾被拒时
        // 维持 dispatched——平台收尾只写状态，不替它判工单是否成立。
        if (!noResultHandoff) continue;
        noResultWaitDetail = noResultHandoff;
        await this.#platform.setWaitReason(missionId, 'attempt_limit_reached', noResultHandoff);
      }

      // 补验：重启续跑、或上一轮验完没落盘时，工作项已 submitted 但还没有报告。放在协调
      // 者 hop 之前——它这一跳读的就是这份报告。W-321 幂等：同一次 submitted attempt 已有
      // 报告不会重跑命令，只把那份原样返回。
      let redispatchedOnRecovery = false;
      for (const item of view.workItems) {
        if (item.status !== 'submitted') continue;
        // 只在**有命令且不是 partial** 时才补验。**不能因为 commands 为空就提前 continue**：
        // 无命令的 partial 若在 pending 自动接续前停机，恢复后这里漏掉续派就会错误叫醒 L2。
        if ((item.order?.validation?.commands?.length ?? 0) > 0) {
          // partial 依旧不跑冻结命令：理由同 pending 那边，重启不改变它是半成品。
          if (!(await this.#standardSubmitIsPartial(missionId, item.id))) {
            await this.#validateStandardIfSubmitted(missionId, item.id, cwd);
          }
        }
        // 补上报告、或没有命令可补，之后走**同一判断**：机器能判的退回，不该因为「重启
        // 过」就多叫一次协调者。幂等——同一次提交已续派过 / 已触顶 / 平台判定无可续派依据
        // （绿报告、缺报告、blocked、非 partial），这里都是 no-op，原样交给 L2。
        if (await this.#autoRedispatchStandard(missionId, item.id)) redispatchedOnRecovery = true;
      }
      // 有工单已经回到执行者手里：下一轮 pending 接住它，这一轮不叫协调者。
      if (redispatchedOnRecovery) continue;

      // 没有在途工作项 —— 该协调者出场：规划、派发，或验收。
      //
      // **不续跑上一跳的会话。** 这里曾经传 view.coordinatorResumeRef，
      // 让每一跳接着上一跳的对话往下说。听起来是省事，实测是整条 Mission
      // 最大的一笔开销：两跳之间隔着一次执行者运行（实测 13~40 分钟），
      // 提示缓存早凉了，于是重放的整段历史按**全价**重新计费。W3 的协调者
      // 输入逐跳涨 72k→356k→469k→591k→738k→933k，六跳下来它一个人吃掉了
      // 74% 的 token、$16。轮次是平方项。
      //
      // 换掉它不丢信息：协调者需要的东西平台本来就以结构化形式存着——
      // plan 的 findings / rootCause / rejectedHypotheses / decisions /
      // direction、工作项、验收记录、升级问答，而且提示词里那句
      // 「会话可能被压缩或换人接手，只有写回平台的才算数」说的正是这件事。
      // resume 链是同一份状态的第二份拷贝，而且是会无限长的那一份。
      //
      // resumeRef 仍然照常记在 Attempt 上（finishAttempt 那边），排障时
      // 还能按它找到当时那个会话——只是不再拿它开下一跳。
      const hop = await this.#runHop({
        role: 'coordinator',
        missionId,
        cwd,
        pool: this.#coordinator,
        instruction: coordinatorInstruction({
          ...view,
          conflictFiles: activeConflicts,
          // 这一轮刚写下的交回原因。view 是循环开头拍的，看不见它；而 runMission
          // 开头已经把上一次的旧原因清掉了，所以在这里现读只会读到陈货。
          ...(noResultWaitDetail ? { waitDetail: noResultWaitDetail } : {}),
        }),
      });
      if (hop && 'alreadyCompleted' in hop) continue;
      if (hop && 'retrySameSlot' in hop) continue;
      // **先看停机原因，再判失败。**
      //
      // 派发撞上"同项目有别的 Mission 在改代码"时，工具会回 409，运行时
      // 多半把它当成一次失败的 attempt。如果先判失败，这条就会被记成
      // 上游失败、候选被冷却——而真相只是"在排队"。两者处置完全不同。
      const afterHop = await this.#platform.getMissionView(missionId);
      if (afterHop.waitReason === 'project_busy') {
        return {
          kind: 'waiting',
          reason: 'project_busy',
          detail: '同一 Project 有别的 Mission 正占着改动名额。它落地或放弃之后再跑这条。',
        };
      }

      if (!hop || 'exhausted' in hop) {
        const reason: WaitReason = hop?.exhausted ?? 'no_available_agent';
        const detail = hop?.detail ?? this.#stallDetail(reason);
        await this.#platform.setWaitReason(missionId, reason, detail);
        return this.#waitingOutcome(reason, detail, hop?.candidateRole);
      }

      // GATE-POST after coordinator hop.
      {
        const gate = await this.#enforceAuthoritativeBudget(missionId);
        if (gate.kind === 'stop') return gate.outcome;
        if (gate.kind === 'continue') continue;
      }

      // 跑完一轮却什么都没提交：算失败，**不换模型再赌一次**——那只会
      // 烧配额且不产生新信息。连着两次就停下来交给人。
      if (hop.endedBy === 'no_structured_result') {
        const previous = this.hops.at(-2);
        if (previous?.endedBy === 'no_structured_result') {
          return { kind: 'stalled', reason: '协调者连续两轮没有做任何结构化提交' };
        }
      }
    }

    return { kind: 'stalled', reason: `到达轮次上限 ${maxRounds}` };
  }

  /**
   * HA：确定性验证 → 独立检视。始终停在 awaiting_review。
   * 缺候选 / 历史 profile 不全 / 冲突 / 适配器失败记可见原因，不改用协调者。
   */
  async #runHaIndependentReview(missionId: string, cwd: string): Promise<MissionRunOutcome> {
    const pass = await this.#platform.effectiveIndependentReviewPass(missionId);
    if (pass) {
      await this.#platform.setWaitReason(
        missionId,
        'waiting_l3',
        'HA 独立检视已通过，待授权放行',
      );
      return { kind: 'awaiting_l3_review' };
    }

    let validation;
    try {
      validation = await this.#platform.runHaDeterministicValidation(missionId, cwd);
    } catch (error) {
      const detail =
        error instanceof PlatformRuleError
          ? error.message
          : `HA 确定性验证失败：${error instanceof Error ? error.message : String(error)}`;
      await this.#platform.setWaitReason(missionId, 'waiting_l3', `HA 确定性验证：${detail}`);
      return { kind: 'waiting', reason: 'waiting_l3', detail };
    }
    if (!validation.passed) {
      const view = await this.#platform.getMissionView(missionId);
      const detail = view.waitDetail ?? `HA 确定性验证未通过（报告 ${validation.reportId}）`;
      return { kind: 'waiting', reason: 'waiting_l3', detail };
    }

    const pool = this.#independentReviewer;
    const candidates = pool ? await this.#poolCandidates(pool) : [];
    const startReviewer = this.#tokens.startIndependentReviewer;
    if (!startReviewer || !pool) {
      // 缺发牌口时先建 Attempt 会留下无 token 的 in_progress，下次开审被 concurrent_attempt 挡住。
      const detail = 'HA 独立检视故障：没有独立检视发牌口或候选池。';
      await this.#platform.setWaitReason(missionId, 'waiting_l3', `HA 独立检视故障：${detail}`);
      return { kind: 'waiting', reason: 'waiting_l3', detail };
    }

    // 容量路径必须先选定候选身份再占租约、再开 token。把整池交给 startReviewer
    // 可能挑 B，而租约仍是 A —— 独立检视就会拿 A 的名额启动 B。
    let reviewerCandidates = candidates;
    let queued:
      | { kind: 'bypass' }
      | { kind: 'claimed'; hop: QueuedHop }
      | { kind: 'completed'; hop: QueuedHop }
      | { kind: 'waiting'; reason: WaitReason; detail: string; wait?: QueuedHopWait } = { kind: 'bypass' };
    if (this.#supportsCapacityClaim() && candidates.length > 0) {
      let capacityWait: Extract<typeof queued, { kind: 'waiting' }> | undefined;
      let selected: (typeof candidates)[number] | undefined;
      for (const candidate of candidates) {
        const attempt = await this.#acquireHopForStart({
          role: 'independent_reviewer',
          missionId,
          maxAttempts: pool.maxAttempts ?? 3,
          candidate: { runtimeKind: pool.runtime.kind, profileId: candidate.profileId },
        });
        if (attempt.kind === 'waiting') {
          if (attempt.wait === 'capacity') {
            capacityWait = attempt;
            continue;
          }
          await this.#platform.setWaitReason(missionId, attempt.reason, attempt.detail);
          return { kind: 'waiting', reason: attempt.reason, detail: attempt.detail };
        }
        if (attempt.kind === 'completed') {
          await this.#platform.setWaitReason(missionId, 'waiting_l3', 'HA 独立检视队列项已完成，仍待放行');
          return { kind: 'awaiting_l3_review' };
        }
        queued = attempt;
        selected = candidate;
        break;
      }
      if (!selected) {
        if (capacityWait) {
          await this.#platform.setWaitReason(missionId, capacityWait.reason, capacityWait.detail);
          return { kind: 'waiting', reason: capacityWait.reason, detail: capacityWait.detail };
        }
        const detail = 'HA 独立检视故障：没有独立检视候选。';
        await this.#platform.setWaitReason(missionId, 'waiting_l3', `HA 独立检视故障：${detail}`);
        return { kind: 'waiting', reason: 'waiting_l3', detail };
      }
      reviewerCandidates = [selected];
    } else {
      queued = await this.#acquireHopForStart({
        role: 'independent_reviewer',
        missionId,
        maxAttempts: pool.maxAttempts ?? 3,
      });
      if (queued.kind === 'waiting') {
        await this.#platform.setWaitReason(missionId, queued.reason, queued.detail);
        return { kind: 'waiting', reason: queued.reason, detail: queued.detail };
      }
      if (queued.kind === 'completed') {
        await this.#platform.setWaitReason(missionId, 'waiting_l3', 'HA 独立检视队列项已完成，仍待放行');
        return { kind: 'awaiting_l3_review' };
      }
    }

    const claim = queued.kind === 'claimed' ? this.#trustedQueueClaim(queued.hop) : undefined;
    let started: { attemptId: string; token: string; profileId: string };
    try {
      started = await startReviewer(missionId, reviewerCandidates, claim);
    } catch (error) {
      const detail =
        error instanceof PlatformRuleError
          ? error.message
          : `HA 独立检视故障：${error instanceof Error ? error.message : String(error)}`;
      await this.#platform.setWaitReason(missionId, 'waiting_l3', `HA 独立检视故障：${detail}`);
      return { kind: 'waiting', reason: 'waiting_l3', detail };
    }

    if (
      queued.kind === 'claimed' &&
      queued.hop.profileId !== undefined &&
      started.profileId !== queued.hop.profileId
    ) {
      const detail =
        `HA 独立检视候选 ${started.profileId} 与队列租约 ${queued.hop.profileId} 不一致，不启动 Agent`;
      await this.#platform.setWaitReason(missionId, 'waiting_l3', `HA 独立检视故障：${detail}`);
      return { kind: 'waiting', reason: 'waiting_l3', detail };
    }

    const profile =
      reviewerCandidates.find((row) => row.profileId === started.profileId) ?? {
        endpoint: 'local',
        profileId: started.profileId,
      };
    await this.#platform.setWaitReason(missionId, 'waiting_l3', 'HA 独立检视进行中');

    const { attemptId, token } = started;
    let outcome: RuntimeOutcome | undefined;
    let unsubscribe: (() => void) | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let hopRan = false;
    let hopLeaseLost = false;
    try {
      const run = await pool!.runtime.start({
        role: 'independent_reviewer',
        attemptId,
        missionId,
        cwd,
        profile,
        instruction:
          '你是独立检视者，不是协调者或执行者。先 coagent_get_mission_review_bundle 读证据包，再 coagent_submit_independent_review 提交 pass 或 send_back。不得自述身份，不得终审合并。',
        tools: [],
        endpoint: { baseUrl: this.#baseUrl, token },
      });
      hopRan = true;
      unsubscribe = run.on((event) => {
        if (event.kind === 'output') {
          void this.#live.append({
            missionId,
            attemptId,
            kind: 'text',
            text: redactSecrets(event.text),
          });
        }
      });
      heartbeat = setInterval(() => {
        void this.#platform.beatAttempt(missionId, attemptId, this.#owner).catch(() => undefined);
        void this.#renewHopLease(queued.kind === 'claimed' ? queued.hop : undefined, () => {
          hopLeaseLost = true;
        });
      }, HEARTBEAT_MS);
      await this.#platform.beatAttempt(missionId, attemptId, this.#owner).catch(() => undefined);
      await this.#renewHopLease(queued.kind === 'claimed' ? queued.hop : undefined, () => {
        hopLeaseLost = true;
      });
      outcome = await run.wait();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unreachable = /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|EPIPE/i.test(
        message,
      );
      outcome = {
        endedBy: unreachable ? 'platform_unreachable' : 'upstream_failure',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, quality: 'unknown' },
        failureMessage: message,
      };
    } finally {
      clearInterval(heartbeat);
      unsubscribe?.();
      try {
        try {
          await this.#platform.finishAttempt(missionId, attemptId, {
            endedBy: outcome?.endedBy ?? 'no_structured_result',
            usage: outcome?.usage,
            failureMessage: outcome?.failureMessage,
            // 有 outcome 才透传；adapter 未校验，平台 finishAttempt 再收口。
            ...(outcome?.contextMetrics !== undefined
              ? { contextMetrics: outcome.contextMetrics }
              : {}),
          }, claim);
        } catch {
          // 收尾失败不能跳过吊销：迟到的工具调用必须被拒绝。
        }
        try {
          await this.#live.finish?.(missionId, attemptId);
        } catch {
          // live.finish 失败同样不得跳过吊销。
        }
      } finally {
        this.#tokens.revoke(token);
      }
    }

    this.hops.push({
      role: 'independent_reviewer',
      attemptId,
      profile,
      endedBy: outcome.endedBy,
      failureMessage: outcome.failureMessage,
    });

    if (outcome.endedBy === 'platform_unreachable' || outcome.endedBy === 'upstream_failure') {
      const reason: WaitReason =
        outcome.endedBy === 'platform_unreachable' ? 'platform_unreachable' : 'no_available_agent';
      const detail = `HA 独立检视故障：${outcome.failureMessage ?? outcome.endedBy}`;
      await this.#platform.setWaitReason(missionId, reason, detail);
      return { kind: 'waiting', reason, detail };
    }

    if (hopRan && !hopLeaseLost && queued.kind === 'claimed') {
      await this.#completeHopLease(queued.hop);
    }

    const after = await this.#platform.effectiveIndependentReviewPass(missionId);
    await this.#platform.setWaitReason(
      missionId,
      'waiting_l3',
      after ? 'HA 独立检视已通过，待授权放行' : 'HA 独立检视已记录，仍待放行',
    );
    return { kind: 'awaiting_l3_review' };
  }

  /**
   * Lightweight Fast Lane 一轮。
   *
   * 只走：唯一 Frozen WorkItem → Executor hop → Validator → **协调者 L2** → submit-for-review。
   * 机器验收只判「命令绿不绿」，判不了「是不是工单要的东西」；accept 之后才交 L3 门口，
   * reject 就在这一跳转 Standard（同一 attempt 接着 update_plan / create / dispatch）。
   * 执行者提问（blocked + 非空 needsFromUpstream）走**已有 Mission** 的升级通道，
   * 停在 awaiting_l3；答复后同一张工单再派执行者。Lightweight 没有协调者可问，
   * 也不能因此 promote 到 Standard。提问、等待、规模/失败晋升之外，绝不主动发工单。
   */
  async #runLightweightRound(
    missionId: string,
    view: MissionView,
    cwd: string,
  ): Promise<
    | { kind: 'continue' }
    | { kind: 'outcome'; outcome: MissionRunOutcome }
  > {
    if (view.runKind !== 'mutation') {
      return {
        kind: 'outcome',
        outcome: {
          kind: 'stalled',
          reason: `Lightweight 要求 runKind=mutation，当前是 ${view.runKind}`,
        },
      };
    }

    if (view.workItems.length === 0) {
      return {
        kind: 'outcome',
        outcome: {
          kind: 'stalled',
          reason:
            'Lightweight Mission 缺少 Frozen WorkOrder；须先由 trusted routing 创建唯一 WorkItem',
        },
      };
    }
    if (view.workItems.length > 1) {
      return {
        kind: 'outcome',
        outcome: {
          kind: 'stalled',
          reason: `Lightweight Mission 恰好只能有一个 WorkItem，当前 ${view.workItems.length} 个`,
        },
      };
    }

    const item = view.workItems[0]!;

    if (item.status === 'created') {
      try {
        await this.#platform.dispatchLightweightWorkItem(missionId, item.id);
      } catch (error) {
        if (error instanceof PlatformRuleError && error.code === 'PROJECT_BUSY') {
          return {
            kind: 'outcome',
            outcome: {
              kind: 'waiting',
              reason: 'project_busy',
              detail:
                error.message ||
                '同一 Project 有别的 Mission 正占着改动名额。它落地或放弃之后再跑这条。',
            },
          };
        }
        throw error;
      }
      return { kind: 'continue' };
    }

    if (item.status === 'dispatched') {
      const hop = await this.#runHop({
        role: 'executor',
        missionId,
        workItemId: item.id,
        cwd,
        pool: this.#executor,
        instruction:
          '平台派给你一个工作项：工单已在开跑简报的「你的工单」一节里，直接照它执行；只有简报里没有工单正文时才调用 coagent_get_work_order。',
      });
      if (hop && 'alreadyCompleted' in hop) return { kind: 'continue' };
      if (hop && 'retrySameSlot' in hop) return { kind: 'continue' };
      if (!hop || 'exhausted' in hop) {
        const reason: WaitReason = hop?.exhausted ?? 'no_available_agent';
        const detail = hop?.detail ?? this.#stallDetail(reason, item.id);
        await this.#platform.setWaitReason(missionId, reason, detail);
        return {
          kind: 'outcome',
          outcome: this.#waitingOutcome(reason, detail, hop?.candidateRole),
        };
      }
      // reportBlocked 把非空提问记成 Mission 升级。不在这里读一次视图的话，
      // 下一轮主循环才会看到 openEscalations——中间那一轮只是空转。
      // 空白需求没有升级，必须用原来的 stalled 原文停下：若 continue 再走一遍，
      // 意思一样，但不能误 promote / 叫协调者。
      const afterHop = await this.#platform.getMissionView(missionId);
      if (afterHop.openEscalations.length > 0) {
        return {
          kind: 'outcome',
          outcome: {
            kind: 'awaiting_l3',
            question: afterHop.openEscalations[0]!.question,
          },
        };
      }
      const afterItem =
        afterHop.workItems.find((row) => row.id === item.id) ?? afterHop.workItems[0];
      if (afterItem?.status === 'blocked') {
        return {
          kind: 'outcome',
          outcome: {
            kind: 'stalled',
            reason:
              `Lightweight WorkItem ${afterItem.id} 状态是 ${afterItem.status}，无法继续；` +
              '绝不回退 Coordinator',
          },
        };
      }
      return { kind: 'continue' };
    }

    if (item.status === 'submitted') {
      // 视图里这一格有投影 = 这次提交已经验过了（可能就在崩掉之前那一瞬）。
      // 有它就不重跑命令：机器验收要几分钟，重跑一遍只为得到同一份报告；而且
      // 报告是 append-only 事实，重跑会再落一份，L2 那边「凭哪份报告」就分叉了。
      const current = await this.#currentLightweightValidation(missionId, item);
      const validated =
        current ??
        (await this.#platform.validateAndAcceptLightweightWorkItem({
          missionId,
          workItemId: item.id,
          cwd,
        }));
      // 只有这一跳真的跑了命令（没有可恢复的旧报告）且过了才问：旧报告恢复时上一次
      // 交卷那轮已经问过，再问一遍就是同一份产物两份 shadow。
      if (!current && validated.passed) {
        // POST_EXECUTION shadow（J2）：确定性验收过了才问（含因规模被扣下的）；硬失败不问——
        // 设计 §9.1：Jev 无权推翻确定性结果，问了也不该用。
        await this.#platform.runPostExecutionShadow(missionId, item.id);
      }
      // 机器过了、改动也在轻量规模内 —— 验收结论归协调者（用户 09-30 定）：
      // 机器只判「命令绿不绿」，判不了「是不是工单要的东西」。交给标准候选池做 L2，
      // 打回就在这同一跳转 Standard，不另起一轮。
      if (validated.passed && !validated.held && !validated.gate) {
        return await this.#runLightweightL2Hop(missionId);
      }
      if (validated.status !== 'accepted') {
        // 验收没过，或改动超出轻量规模被扣下：升级给协调者，而不是停下等人。
        // E1 实测停过一次——执行者改对了、一条配置判失败，Mission 在 stalled 里等了 870 秒。
        // 凭据是平台存下的那份报告；升级失败才停，并把两件事都说出来。
        try {
          await this.#platform.promoteLightweightAfterValidation(missionId, validated.reportId);
        } catch (error) {
          const what = validated.passed ? '通过但改动超出轻量规模' : '未通过';
          return {
            kind: 'outcome',
            outcome: {
              kind: 'stalled',
              reason:
                `ValidationReport ${validated.reportId} ${what}，升级到 Standard 也失败了：` +
                (error instanceof Error ? error.message : String(error)),
            },
          };
        }
        await this.#platform.setWaitReason(missionId, undefined);
        return { kind: 'continue' };
      }
      return await this.#submitIfL2Accepted(missionId);
    }

    if (item.status === 'accepted') {
      // crash-recovery seam：真实 L2 已 accept，直接交 L3 门口。
      return await this.#submitIfL2Accepted(missionId);
    }

    // blocked 且没有未答升级才会落到这里（空白需求，或提问已答过却没重派）。
    // 有未答升级时主循环开头已 awaiting_l3。这句 stalled 原文不能改：空白路径靠字节等价钉住。
    return {
      kind: 'outcome',
      outcome: {
        kind: 'stalled',
        reason:
          `Lightweight WorkItem ${item.id} 状态是 ${item.status}，无法继续；` +
          '绝不回退 Coordinator',
      },
    };
  }

  /**
   * 这次提交**已有**的那份机器验收结果；没有就 undefined（那才要跑命令）。
   *
   * 凭视图里的投影报告 id 取 durable 完整报告再逐项核对——投影是给人看的简版，
   * 判「凭哪份报告做 L2」要用原文。核对不过（报告丢了、改了 mission/workItem/attempt）
   * 就当没有，走正常验收：宁可重跑一遍命令，也不能拿一份对不上的报告去叫协调者。
   */
  async #currentLightweightValidation(
    missionId: string,
    item: { id: string; validationReport?: { reportId: string; passed: boolean } },
  ): Promise<{ reportId: string; passed: boolean; status: string; held?: boolean; gate?: string } | undefined> {
    const reportId = item.validationReport?.reportId;
    // MissionView 没投影 submittedAttemptId（views.ts 只投影报告简版），所以当前提交 id
    // 只能回到事件里取：该工单最后一次 execution_result.submitted 的 attemptId 就是它。
    // 拿视图里别的东西当它，会把「凭哪份报告」绑到一个根本不存在的 attempt 上。
    const submittedAttemptId = await this.#currentSubmittedAttemptId(missionId, item.id);
    if (!reportId || !submittedAttemptId) return undefined;
    const report = await this.#platform.getValidationReport(missionId, reportId);
    if (!report) return undefined;
    if (
      report.missionId !== missionId ||
      report.workItemId !== item.id ||
      report.attemptId !== submittedAttemptId
    ) {
      return undefined;
    }
    // 视图投影时已经跑过 shadow（或压根没过、不该问）：这里只恢复状态，不再问一遍。
    return {
      reportId: report.id,
      passed: report.passed,
      status: 'submitted',
      ...(lightweightGateTrigger(report) ? { held: true, gate: lightweightGateTrigger(report)!.code } : {}),
    };
  }

  /**
   * 该工单**当前**这次提交的 attemptId：最后一次 execution_result.submitted 的 attemptId。
   *
   * 正序扫、后写盖前写，留下最新那条。没有它就返回 undefined —— 那时没有「这次提交」可言，
   * 任何凭报告的判断都不成立。
   */
  async #currentSubmittedAttemptId(missionId: string, workItemId: string): Promise<string | undefined> {
    const events = await this.#platform.getActivity(missionId);
    let found: string | undefined;
    for (const event of events) {
      if (event.kind !== 'execution_result.submitted') continue;
      if (event.workItemId !== workItemId) continue;
      if (typeof event.attemptId !== 'string' || event.attemptId.length === 0) continue;
      found = event.attemptId;
    }
    return found;
  }

  /**
   * 快车道的 L2 一跳：标准候选池的协调者凭那份机器报告下验收结论。
   *
   * 和 Standard 那一跳同一套处置（alreadyCompleted / retrySameSlot / exhausted /
   * project_busy / 预算），**不续旧会话**——理由同 Standard 的 coordinator hop。
   * 打回时 reviewExecutionResult 自己已经晋升并记过 AC1，这里不再碰：重复晋升
   * 会把「打回了一次」记成两次，AC1 的连续失败也被多算一次。
   */
  async #runLightweightL2Hop(missionId: string): Promise<
    { kind: 'continue' } | { kind: 'outcome'; outcome: MissionRunOutcome }
  > {
    const view = await this.#platform.getMissionView(missionId);
    const hop = await this.#runHop({
      role: 'coordinator',
      missionId,
      cwd: this.workspace?.cwd ?? '',
      pool: this.#coordinator,
      instruction: coordinatorInstruction(view),
    });
    if (hop && 'alreadyCompleted' in hop) return { kind: 'continue' };
    if (hop && 'retrySameSlot' in hop) return { kind: 'continue' };
    const afterHop = await this.#platform.getMissionView(missionId);
    if (afterHop.waitReason === 'project_busy') {
      return {
        kind: 'outcome',
        outcome: {
          kind: 'waiting',
          reason: 'project_busy',
          detail: '同一 Project 有别的 Mission 正占着改动名额。它落地或放弃之后再跑这条。',
        },
      };
    }
    if (!hop || 'exhausted' in hop) {
      const reason: WaitReason = hop?.exhausted ?? 'no_available_agent';
      const detail = hop?.detail ?? this.#stallDetail(reason);
      await this.#platform.setWaitReason(missionId, reason, detail);
      return {
        kind: 'outcome',
        outcome: this.#waitingOutcome(reason, detail, hop?.candidateRole),
      };
    }
    // Standard 那一跳在 coordinator 之后就过一次预算闸（#enforceAuthoritativeBudget）。快车道
    // 这跳同样烧了一轮，成功 hop 之后也要过：漏掉它，超预算的 Mission 会在这一跳绕过门禁，
    // 直接走到下面的交卷。必须排在 submitIfL2Accepted 之前——交卷之后再来闸就晚了。
    {
      const budget = await this.#enforceAuthoritativeBudget(missionId);
      if (budget.kind === 'stop') return { kind: 'outcome', outcome: budget.outcome };
      if (budget.kind === 'continue') return { kind: 'continue' };
    }
    // 下没下结论都先看一眼：协调者可能交了 review 却没用终态工具收尾，
    // 那也是一份真实结论，漏掉它就要多空转一轮。
    const settled = await this.#submitIfL2Accepted(missionId);
    if (settled.kind === 'outcome') return settled;
    // 没有评审结论：既不是打回也不是放行，留在 submitted。沿用 Standard 的空转
    // 处置——连着两次什么都没提交就停下来交给人，不再赌一轮。
    // 不在这里晋升：晋升是「有结论且结论是打回」的产物，拿空转当打回会让
    // 协调者下一轮看到一条没有理由的 requiredChanges。
    if (hop.endedBy === 'no_structured_result' && this.hops.at(-2)?.endedBy === 'no_structured_result') {
      return {
        kind: 'outcome',
        outcome: { kind: 'stalled', reason: '协调者连续两轮没有做任何结构化提交' },
      };
    }
    return { kind: 'continue' };
  }

  /**
   * L2 判了 accept 才交卷；没有协调者结论（还在 submitted）就原样等下一轮。
   *
   * 交卷前必须重读一次：L2 可能把车道改成 standard，也可能压根没下结论——
   * 拿旧视图的 accepted 去 submit，会在错误的前提下写一份 result。
   */
  async #submitIfL2Accepted(missionId: string): Promise<
    { kind: 'continue' } | { kind: 'outcome'; outcome: MissionRunOutcome }
  > {
    const after = await this.#platform.getMissionView(missionId);
    if (after.executionMode !== 'lightweight') return { kind: 'continue' };
    const itemNow = after.workItems[0];
    if (!itemNow || itemNow.status !== 'accepted') return { kind: 'continue' };
    await this.#platform.submitLightweightMissionForReview(missionId);
    return { kind: 'outcome', outcome: { kind: 'awaiting_l3_review' } };
  }

  /**
   * 最后一次失败的原文。
   *
   * 停下来时必须把它带出去：调度器把 runtime 抛的任何异常都归成
   * upstream_failure，如果只报一句"候选都失败了"，一个真正的程序错误
   * 会被伪装成配额问题，而且完全看不见。
   */
  /**
   * 这一跳有没有往平台交过东西（证据 / 执行结果）。
   *
   * 墙钟到点时用它区分两种看起来一样的情况：**在干活但慢**，和**在打转**。
   * 单看时间分不出来——实测一跳跑满 30 分钟被当成打转掐掉，而它已经全绿了。
   * 交过东西就是有进展，给一次延长；一次都没交的，30 分钟确实该有人来看。
   *
   * 读不到就当没有：这一路失败不该把一个正常的运行拖死，而"读不到"本身
   * 也说明平台这边不正常，停下来让人看是对的。
   */
  async #hasSubmittedSomething(missionId: string, attemptId: string): Promise<boolean> {
    try {
      const detail = await this.#platform.getAttemptDetail(missionId, attemptId);
      return detail.evidence.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 现在还能用的候选。全在冷却 = 没有可用 agent（S14.4）。
   *
   * `excludedProfileIds` 是**只对这个工作项**生效的局部排除（Standard 执行者按
   * 工作项轮换「连续两次没交结构化结果」的候选）。它在原配置的有序循环之前滤掉：
   * 不改候选顺序，不动候选健康查询——剩下的候选照旧逐个查自己的熔断/冷却，
   * 所以全局熔断、冷却和候选健康记录一个字节都不受影响。其它调用不传，默认无排除。
   */
  async #availableCandidates(
    pool: RolePool,
    now: number,
    excludedProfileIds?: readonly string[],
  ): Promise<ExecutionProfile[]> {
    const excluded = excludedProfileIds?.length ? new Set(excludedProfileIds) : undefined;
    const candidates = (await this.#poolCandidates(pool)).filter(
      (profile) => !excluded?.has(profile.profileId),
    );
    if (!this.#candidateCircuits) {
      return candidates.filter((profile) => (this.#cooldown.get(profile.profileId) ?? 0) <= now);
    }
    // 额度读取器要建在循环**外面**：这一次筛选里 N 个候选问的是同一份快照，
    // 闭包内的局部 Promise 把它们去重成一次读取（含失败结果，失败也不重试）。
    const readUsage = this.#usageRowsReader();
    const available: ExecutionProfile[] = [];
    for (const profile of candidates) {
      const circuit = await this.#candidateCircuits.get(profile.profileId);
      if (circuit.state === 'closed') {
        const resetAt = await this.#usageResetAt(profile, readUsage, now);
        if (resetAt) {
          await this.#candidateCircuits.open({ profileId: profile.profileId, failureClass: 'quota', openUntil: resetAt });
          continue;
        }
        available.push(profile);
      } else if (circuit.state === 'open' && circuit.openUntil !== null && Date.parse(circuit.openUntil) <= now) {
        if (circuit.failureClass === 'quota') {
          const usage = await this.#quotaUsage(profile, readUsage, now);
          if (usage.kind !== 'available') continue;
        }
        available.push(profile);
      }
    }
    return available;
  }

  async #poolCandidates(pool: RolePool): Promise<readonly ExecutionProfile[]> {
    return pool.loadCandidates ? pool.loadCandidates() : pool.candidates;
  }

  /**
   * 返回「这次筛选读一次额度行」的读取器。
   *
   * 两层去重，各管一件事：
   *   - **本次筛选**：闭包里的局部 Promise 把 N 个候选合成一次调用。读失败的结果
   *     同样被这一份 Promise 共享——失败重试会把 N 次读放大成 2N 次，而下游
   *     本来就是「读不到就当未知」。
   *   - **跨跳**：实例缓存 60 秒，让同一条 Mission 的下一跳直接复用。
   *     只有**成功拿到行**才写缓存；失败或 unavailable 不写，否则一次抖动会被
   *     锁成 60 秒的「没额度」，而 60 秒恰好是一次退避重试的窗口。
   */
  #usageRowsReader(): () => Promise<readonly unknown[] | undefined> {
    let pending: Promise<readonly unknown[] | undefined> | undefined;
    return async () => {
      const cached = this.#usageCache;
      if (cached && cached.expiresAt > this.#now().getTime()) return cached.rows;
      pending ??= this.#readUsageRows();
      return pending;
    };
  }

  /** 归一化后的一次读取。形状不认识（false / 非数组 providers / 抛异常）都是 undefined。 */
  async #readUsageRows(): Promise<readonly unknown[] | undefined> {
    let rows: readonly unknown[] | undefined;
    try {
      const usage = await this.#usageReader();
      if (Array.isArray(usage)) {
        rows = usage;
      } else if (usage.available === true && Array.isArray(usage.providers)) {
        rows = usage.providers as readonly unknown[];
      }
    } catch {
      rows = undefined;
    }
    if (rows) this.#usageCache = { rows, expiresAt: this.#now().getTime() + USAGE_CACHE_TTL_MS };
    return rows;
  }

  async #usageResetAt(
    profile: ExecutionProfile,
    readUsage: () => Promise<readonly unknown[] | undefined>,
    now: number,
  ): Promise<string | undefined> {
    const usage = await this.#quotaUsage(profile, readUsage, now);
    return usage.kind === 'exhausted' ? usage.resetAt : undefined;
  }

  async #quotaUsage(
    profile: ExecutionProfile,
    readUsage: () => Promise<readonly unknown[] | undefined>,
    now: number,
  ): Promise<
    { kind: 'exhausted'; resetAt: string } | { kind: 'available' | 'unknown' }
  > {
    const providerFact = profile.facts?.find((fact) => fact.key === 'provider');
    if (!providerFact) return { kind: 'unknown' };
    const rows = await readUsage();
    if (!rows) return { kind: 'unknown' };
    const model = profile.facts?.find((fact) => fact.key === 'model')?.value;
    // 匹配规则由 runtime-catalog 的纯函数统一：provider + modelPrefix（最长前缀，
    // 无前缀兜底），status 非 ok 的行不算。模型 fact 也要带上，否则同一 provider
    // 下的多个上游会共用第一行 —— 界面上写着还有 80%，编排器却已经把候选拉黑。
    const row = findUsageRow(rows, providerFact.value, model) as Record<string, unknown> | undefined;
    if (!row) return { kind: 'unknown' };
    const exhausted = row.remainingPercent === 0 || (typeof row.usedPercent === 'number' && row.usedPercent >= 100);
    if (exhausted) {
      const reset = typeof row.resetAt === 'string' ? Date.parse(row.resetAt) : Number.NaN;
      if (Number.isFinite(reset) && reset > now) return { kind: 'exhausted', resetAt: new Date(reset).toISOString() };
    }
    if ((typeof row.remainingPercent === 'number' && row.remainingPercent > 0) ||
        (typeof row.usedPercent === 'number' && row.usedPercent < 100)) return { kind: 'available' };
    return { kind: 'unknown' };
  }

  /** 候选的可用性快照，供界面显示"为什么停着"。 */
  candidateAvailability(): { profileId: string; availability: CandidateAvailability; until?: string }[] {
    const now = Date.now();
    const all = [
      ...this.#coordinator.candidates,
      ...this.#executor.candidates,
      ...(this.#independentReviewer?.candidates ?? []),
    ];
    return all.map((profile) => {
      const until = this.#cooldown.get(profile.profileId) ?? 0;
      return until > now
        ? { profileId: profile.profileId, availability: 'cooldown' as const, until: new Date(until).toISOString() }
        : { profileId: profile.profileId, availability: 'available' as const };
    });
  }

  /**
   * 某一角色候选池的冷却快照：每个候选现在能不能用、最早什么时候能用。
   *
   * 为什么要有：候选全在短冷却时，方案驱动该在**运行内等**，而不是开升级单。
   * 判据只能来自权威候选池——注入了 candidateCircuits 就按它读，否则读本进程
   * 的 #cooldown。拿日志文案猜会把「可用」误判成「冷却」，然后把一次本可以
   * 自愈的等待写成人工单。
   *
   * 三条不许违反的口径：
   *   - **严格按 role 选池**。混进别的角色的候选，会让「协调者全冷却」看起来
   *     像「执行者也全冷却」，方案驱动就会去等一个根本不用等的角色。
   *   - **unknown 不是 cooldown**。half_open 的探针在跑、到期值非法、仓储读到
   *     解释不了的行，都只能说「不可证明可用」，不能编一个冷却时长出来。
   *   - **没有候选就是空数组**。池没装配（例如没有独立检视）不等于「全在冷却」。
   */
  async roleCooldownSnapshot(
    role: RolePoolName,
    now: number = Date.now(),
  ): Promise<RoleCooldownCandidate[]> {
    const pool =
      role === 'coordinator'
        ? this.#coordinator
        : role === 'executor'
          ? this.#executor
          : this.#independentReviewer;
    if (!pool) return [];
    const snapshot: RoleCooldownCandidate[] = [];
    for (const profile of await this.#poolCandidates(pool)) {
      snapshot.push(await this.#candidateCooldown(profile.profileId, now));
    }
    return snapshot;
  }

  /**
   * 单个候选的冷却状态。判据必须与 #availableCandidates 同源：两处各写一套
   * 的话，「谁在冷却」会同时有两个答案，而排障的人会同时看到两者。
   */
  async #candidateCooldown(profileId: string, now: number): Promise<RoleCooldownCandidate> {
    if (!this.#candidateCircuits) {
      const until = this.#cooldown.get(profileId) ?? 0;
      return until > now
        ? {
            profileId,
            availability: 'cooldown' as const,
            until: new Date(until).toISOString(),
            retryAfterMs: until - now,
          }
        : { profileId, availability: 'available' as const, retryAfterMs: 0 };
    }
    let circuit: CandidateCircuit | undefined;
    try {
      circuit = await this.#candidateCircuits.get(profileId);
    } catch {
      // 读不出来（状态文件损坏、IO 失败）只能说这一个候选不可证明可用。
      // 既不能编一个冷却时长（等于把「仓储坏了要人看」写成「等一会就好」），
      // 也不能让整张快照抛出去——别的候选的可用性与它无关。
      return { profileId, availability: 'unknown' as const };
    }
    if (circuit?.state === 'closed') {
      return { profileId, availability: 'available' as const, retryAfterMs: 0 };
    }
    if (circuit?.state === 'open') {
      const until = Date.parse(circuit.openUntil);
      if (!Number.isFinite(until)) return { profileId, availability: 'unknown' as const };
      return {
        profileId,
        availability: 'cooldown' as const,
        until: new Date(until).toISOString(),
        retryAfterMs: Math.max(0, until - now),
      };
    }
    // half_open（探针已被领取）或读不到/读不懂的行：不可证明可用。
    return { profileId, availability: 'unknown' as const };
  }

  /**
   * 票级门禁（费用到 cap / 工作项到未批准检查点）：**任何 agent hop 之前**都要过。
   * undefined = 没被拦住。被拦住时平台侧已写好 waitReason 并投好升级：这里**不再写 waitReason**
   * （会把模块的原因覆盖掉），也**不重投升级**（L3 会收到两条一样的提问）。重新取视图是因为升级
   * 可能这趟刚投、也可能早就在等答复：有未答复的升级就回 awaiting_l3（可答复，重跑前先答），否则
   * 才是纯等待。
   */
  async #enforceMissionTicketGate(missionId: string): Promise<MissionRunOutcome | undefined> {
    const gate = await this.#platform.enforceMissionTicketGates(missionId);
    if (!gate.stopped) return undefined;
    // reason 由模块按门禁类型保证存在；没有就回 blocked，不拿说不清原因的 waiting 让方案驱动继续等。
    if (!gate.reason) return { kind: 'blocked', reason: gate.detail ?? '票级门禁阻止了本次执行' };
    const after = await this.#platform.getMissionView(missionId);
    const open = after.openEscalations[0];
    if (open) return { kind: 'awaiting_l3', question: open.question };
    return { kind: 'waiting', reason: gate.reason, detail: gate.detail ?? gate.reason };
  }

  /**
   * BUDGET-001-S5 authoritative budget gate (PRE/POST).
   *
   * - no executionBudget → no-op (heuristics unchanged)
   * - emit durable 70/90/100 once per dim/threshold
   * - hard exceeded + lightweight → Platform self-checked promote, continue
   * - hard exceeded + standard (or promote fail) → waiting/execution_budget_exceeded
   * - soft exceeded → events only, keep going
   * - unknown dimensions never gate
   */
  async #enforceAuthoritativeBudget(
    missionId: string,
  ): Promise<
    | { kind: 'ok' }
    | { kind: 'continue' }
    | { kind: 'stop'; outcome: MissionRunOutcome }
  > {
    const { budgetPresent, evaluation } =
      await this.#platform.evaluateMissionBudget(missionId);
    if (!budgetPresent) return { kind: 'ok' };

    await this.#platform.recordBudgetThresholdEvents(missionId, evaluation);

    if (!anyHardAuthoritativeExceeded(evaluation)) {
      return { kind: 'ok' };
    }

    const view = await this.#platform.getMissionView(missionId);
    if (view.executionMode === 'lightweight') {
      try {
        await this.#platform.promoteLightweightForBudgetExceeded(missionId);
        // Successful promotion: clear any prior wait and let Standard take over.
        await this.#platform.setWaitReason(missionId, undefined);
        return { kind: 'continue' };
      } catch {
        // Fall through to Standard-style wait (promotion failed / not eligible).
      }
    }

    const detail = this.#platform.formatExecutionBudgetExceededDetail(evaluation);
    await this.#platform.setWaitReason(missionId, 'execution_budget_exceeded', detail);
    return {
      kind: 'stop',
      outcome: { kind: 'waiting', reason: 'execution_budget_exceeded', detail },
    };
  }

  /**
   * 组装 waiting 结果。
   *
   * candidateRole 有值才把字段放进去，**不放 `undefined`**：消费方（方案
   * 驱动的等待探针）判「这次缺不缺候选」用的是 `'candidateRole' in outcome`，
   * 恒存在的字段会让那个判断永远为真，等于把非候选故障也当成缺候选。
   */
  #waitingOutcome(
    reason: WaitReason,
    detail: string,
    candidateRole?: RolePoolName,
  ): MissionRunOutcome {
    return candidateRole
      ? { kind: 'waiting', reason, detail, candidateRole }
      : { kind: 'waiting', reason, detail };
  }

  /**
   * 同一工作项的「无结构化结果」轮换依据。
   *
   * 从**持久 Attempt 历史**推导，不读 this.hops：内存记录在重启/换进程后就空了，
   * 而这条上限必须跨进程成立——否则每次重跑都把计数清零，等于没有上限。
   *
   * 两件事一起算：
   *   - `consecutive`：尾部连续 no_structured_result 次数（跨候选）。到顶就把整张
   *     工单交回协调者。
   *   - `excludedProfileIds`：某个候选在自己最近两次 Attempt 上都没交结构化结果。
   *     **只对这一张工单的这一跳生效**——不写候选熔断、不写冷却；那个人在别的工作
   *     项上照旧能用，而后来的一次成功也不解除排除（规格：其他候选尝试不解除排除）。
   *
   * 读不到某一次 Attempt 时按「未知」处理，不数进尾部连续：宁可少挡一次，也不能
   * 把「读不到」当成「无结果」——后者会导致一次满员封顶，而它并不成立。
   */
  async #noResultRotation(
    missionId: string,
    attemptIds: readonly string[],
  ): Promise<{ consecutive: number; profileIds: string[]; excludedProfileIds: string[] }> {
    const byProfile = new Map<string, string[]>();
    const timeline: { endedBy: string | undefined; profileId: string | undefined }[] = [];
    for (const attemptId of attemptIds) {
      const detail = await this.#platform
        .getAttemptDetail(missionId, attemptId)
        .catch(() => undefined);
      const endedBy = detail?.endedBy;
      const profileId = detail?.profile?.profileId;
      timeline.push({ endedBy, profileId });
      if (profileId) {
        const seen = byProfile.get(profileId) ?? [];
        seen.push(endedBy ?? 'unknown');
        byProfile.set(profileId, seen);
      }
    }
    let consecutive = 0;
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      if (timeline[i]!.endedBy !== 'no_structured_result') break;
      consecutive += 1;
    }
    const profileIds: string[] = [];
    for (let i = timeline.length - consecutive; i < timeline.length; i += 1) {
      const id = timeline[i]!.profileId;
      if (id && !profileIds.includes(id)) profileIds.push(id);
    }
    const excludedProfileIds: string[] = [];
    for (const [profileId, endedBys] of byProfile) {
      const last = endedBys.slice(-CANDIDATE_NO_RESULT_LIMIT);
      if (
        last.length === CANDIDATE_NO_RESULT_LIMIT &&
        last.every((endedBy) => endedBy === 'no_structured_result')
      ) {
        excludedProfileIds.push(profileId);
      }
    }
    return { consecutive, profileIds, excludedProfileIds };
  }

  /**
   * 工作项交回协调者时写进等待通路的那句话。
   *
   * 必须带上：工作项 id、连续次数、涉及候选，以及是「到顶」还是「排除后没人」——
   * 协调者从简报里最多只看得见这一个工作项的当前状态（平台收尾后可能是 blocked，
   * 收尾被拒时还是 dispatched），缺哪一项它都得自己去猜。
   */
  #noResultHandoffDetail(input: {
    workItemId: string;
    consecutive: number;
    profileIds: readonly string[];
    excludedProfileIds: readonly string[];
    exhausted: boolean;
  }): string {
    const profiles = input.profileIds.length > 0 ? input.profileIds.join('、') : '（无记录）';
    const excluded = input.excludedProfileIds.length > 0 ? input.excludedProfileIds.join('、') : '无';
    const why = input.exhausted
      ? `按工作项排除后已没有可用执行者候选（被排除：${excluded}）`
      : `同一工作项连续 ${input.consecutive} 次没有结构化结果，到达上限 ${WORK_ITEM_NO_RESULT_LIMIT}`;
    return (
      `工作项 ${input.workItemId}：${why}。` +
      `连续次数 ${input.consecutive}，涉及候选 ${profiles}，上限 ${WORK_ITEM_NO_RESULT_LIMIT}。` +
      '平台不再自动重跑——同一张工单换个候选再赌不产生新信息。工单仍是 dispatched，' +
      '交给你处置：确认工单本身有问题就 coagent_revise_work_order 改对再派发，' +
      '不用做了就 coagent_retire_work_item 作废。'
    );
  }

  /**
   * COM12 B（W-524）：平台自己放弃重跑的两个交回边界（同一工作项无结果到顶、
   * 局部排除后没有候选）共用这条收尾。
   *
   * 最后一次执行跳已经 finishAttempt 收掉、令牌吊销，平台能证明没有活执行者
   * 了；把仍 dispatched 的工作项收成 blocked，协调者才能修订同一张单再派，
   * 不必作废重建。预期尝试与工单修订号取自本轮视图，平台会与当前事实核对：
   * 快照过期、还有 in_progress 或不是 Standard 时**无副作用拒绝**。
   *
   * 这条路径上没有持有任何一跳的队列租约（执行者早被收掉），所以不传 claim；
   * 平台靠快照核对与 in_progress 检查挡住迟到写入。收尾是尽力而为：被拒或
   * 写失败都不改「交回协调者」的语义，工作项维持现状。
   */
  async #blockStalledNoResultLimit(
    missionId: string,
    item: MissionView['workItems'][number],
    consecutive: number,
  ): Promise<void> {
    const expectedAttemptId = item.attemptIds.at(-1);
    if (expectedAttemptId === undefined) return;
    try {
      await this.#platform.blockStalledWorkItem({
        missionId,
        workItemId: item.id,
        source: 'no_result_limit',
        expectedAttemptId,
        orderRevision: item.order?.orderRevision ?? 'r1',
        consecutive,
      });
    } catch {
      // 平台收尾失败/被拒时保持原样：协调者照旧收到次数与候选，仍能修订或作废。
    }
  }

  /**
   * COM12 B（W-524）：墙钟强杀后的可信收尾。
   *
   * 调用点必须在 run.abort 已杀整棵进程树、await run.wait() 已观察退出、finally
   * 已 finishAttempt 并吊销令牌**之后**——只有那时才证明得了没有活执行者。预期
   * 尝试就是刚被掐断的 attemptId；minutes 按原详情口径（延长过一次就翻倍）。
   * 修订号读当前视图：拿旧修订号去写会被平台无副作用拒绝，等于这次收尾白跑。
   * 仍然持有这一跳的队列 claim，原样传给平台做租约围栏核对；租约已丢掉也一样
   * 无副作用拒绝，不会替别人收尾。
   */
  async #blockStalledOnRunaway(
    missionId: string,
    workItemId: string,
    attemptId: string,
    minutes: number,
    claim: QueueClaimIdentity | undefined,
  ): Promise<void> {
    try {
      const view = await this.#platform.getMissionView(missionId);
      const item = view.workItems.find((row) => row.id === workItemId);
      if (!item) return;
      await this.#platform.blockStalledWorkItem(
        {
          missionId,
          workItemId,
          source: 'runaway',
          expectedAttemptId: attemptId,
          orderRevision: item.order?.orderRevision ?? 'r1',
          minutes,
        },
        claim,
      );
    } catch {
      // 收尾失败不改变 runaway 的停机语义：照旧 return exhausted:'runaway_suspected'。
    }
  }

  /** 把停机原因翻译成人能直接照做的一句话。 */
  #stallDetail(reason: WaitReason, workItemId?: string): string {
    const where = workItemId ? `工作项 ${workItemId}` : '协调者';
    if (reason === 'no_available_agent') {
      const cooling = this.candidateAvailability().filter((c) => c.availability === 'cooldown');
      return `${where}：候选全在冷却（${cooling.map((c) => c.profileId).join(', ')}）。` +
        `最近一次失败：${this.#lastFailure()}。等冷却过了重跑即可。`;
    }
    if (reason === 'platform_unreachable') {
      return `${where}：连不上平台自己（${this.#lastFailure()}）。` +
        '这是平台侧故障，不是候选的问题——先确认平台还活着，再重跑。';
    }
    if (reason === 'runaway_suspected') {
      // 这一条的 detail 在掐掉它的那一刻就写进平台了（带着跑了多久、
      // 改动还在哪）。这里再拼一句泛泛的话只会把那句具体的盖掉。
      return `${where}：跑太久，已停下来等人看。`;
    }
    if (reason === 'attempt_limit_reached') {
      return `${where}：尝试次数到上限了，不再往下换候选。最近一次失败：${this.#lastFailure()}。` +
        '继续换只会烧配额，不会产生新信息——先看看是不是工单本身有问题。';
    }
    if (reason === 'execution_budget_exceeded') {
      return `${where}：权威执行预算硬上限已耗尽。`;
    }
    return `${where}：${this.#lastFailure()}`;
  }

  #lastFailure(): string {
    return (
      [...this.hops].reverse().find((hop) => hop.failureMessage)?.failureMessage ?? '（无错误信息）'
    );
  }

  /**
   * Standard：工作项确实处于 submitted 就跑冻结命令并存报告；其它状态什么都不做。
   *
   * 出错一律吞掉。报告是给协调者的**证据**，不是它能不能被叫起来的前提：缺
   * validation 依赖、缺基线（历史工单）、刚跑完又被改成别的状态，这些都只意味着
   * “这一次没有报告”，协调者照样该醒过来自己看。把异常放出去只会让一跳失败、
   * 把整条 Mission 卡在一个平台自己没准备好的地方。
   */
  async #validateStandardIfSubmitted(
    missionId: string,
    workItemId: string,
    cwd: string,
  ): Promise<void> {
    try {
      // 重新读一次：这一跳跑完执行者之后，工作项状态已经变了，入参里的 view 是旧的。
      const live = await this.#platform.getMissionView(missionId);
      const item = live.workItems.find((row) => row.id === workItemId);
      if (item?.status !== 'submitted') return;
      await this.#platform.validateStandardWorkItem({ missionId, workItemId, cwd });
    } catch {
      // 见上：没有报告也要让协调者接手，不替它评审。
    }
  }

  /**
   * 这一次交卷是不是 partial（半成品）。
   *
   * 只拿它决定要不要跑冻结命令：命令是「做完了」的验收材料。工作项不在、或者状态
   * 已经不是 submitted，一律按 false 处理——那两种情况下后面的验证/交接判断本来
   * 就会各归各位，不会因为这里猜错而少做什么。
   */
  async #standardSubmitIsPartial(missionId: string, workItemId: string): Promise<boolean> {
    const view = await this.#platform.getMissionView(missionId);
    const item = view.workItems.find((row) => row.id === workItemId);
    return item?.status === 'submitted' && item.executionResult?.outcome === 'partial';
  }

  /**
   * 机器接续：partial / 验证没过时，让平台把工单退回执行者（最多两次）。
   *
   * 返回是否真的续派了——调用方据此决定这一轮要不要走到协调者。所有跳过的理由
   * （缺报告、报告跑绿、同一次提交已续派过、触顶）都是「交给 L2」：机器能判的只有
   * 「还能再试」，判不了的绝不替 L2 拿主意。
   */
  async #autoRedispatchStandard(missionId: string, workItemId: string): Promise<boolean> {
    try {
      const result = await this.#platform.autoRedispatchStandardWorkItem({ missionId, workItemId });
      return result.redispatched;
    } catch {
      // 接续本身出错时按「没有续派」处理，落回原来的 L2 路径。少退一轮只是多花一次
      // 协调者的钱；让异常穿出去，这一跳会失败，而工单明明还停在 submitted 等人看。
      return false;
    }
  }

  /**
   * 跑一跳。按候选顺序重试，**只有上游失败才往后换**。
   * 返回 undefined 表示候选耗尽。
   */
  async #runHop(input: {
    role: 'coordinator' | 'executor';
    missionId: string;
    workItemId?: string;
    cwd: string;
    pool: RolePool;
    instruction: string;
    resumeRef?: string;
    /**
     * 只对这一跳生效的候选排除（Standard 执行者的工作项内轮换）。
     * 不写熔断、不写冷却，也不进候选配置——下一跳/别的工作项照旧能用这些候选。
     */
    excludedProfileIds?: readonly string[];
    /**
     * 执行者真要起来之前调一次（协调者、快车道都不传）。
     *
     * 验证基线必须落在这一刻，不能由调用方在 #runHop 之前自己记：候选耗尽、
     * 队列项已完成这两条出口执行者根本没跑，在它们之前记下的基线是假的——等
     * 这条工单以后交卷，补验会拿交卷之后的 HEAD 当起点，diff 算成空，而报告
     * 看起来和正常的一模一样。
     */
    onExecutorStart?: () => Promise<void>;
    /**
     * 影响判断专属跳（只由监督下发）。
     *
     * 两者必须同时给。少了它们，一次影响判断会去占普通 coordinator 槽：
     * 同一个工作项的「验收」和「判断一条变更」是两个逻辑 hop，共用一个槽就等于
     * 互相顶掉（而幂等键完全相同会让第二条直接复用第一条的行）。给了 purpose+changeId
     * 就走 hopIdempotencyKey 的 impact 前缀，每条变更自己的槽。
     */
    purpose?: 'impact';
    changeId?: string;
  }): Promise<
    | { endedBy: string; resumeRef?: string; persistentUnknown?: boolean }
    /**
     * detail 有值时用它，别再拼一句泛泛的盖掉。
     *
     * candidateRole 只在「候选拿不出人」那两条出口上带：进了 usable 就说明
     * 缺的不是候选，后面所有的失败出口都不是候选不可用（检查点失败最典型，
     * 它也返回 no_available_agent）。
     */
    | { exhausted: WaitReason; detail?: string; candidateRole?: RolePoolName }
    | { alreadyCompleted: true }
    /** 已等到退避；由 runMission 下一轮重新领取，以便 maxRounds 能拦住 Q。 */
    | { retrySameSlot: true }
    | undefined
  > {
    const parked = await this.#queuedHopPark({
      role: input.role,
      missionId: input.missionId,
      workItemId: input.workItemId,
      purpose: input.purpose,
      changeId: input.changeId,
    });
    if (parked) return parked;
    // impact 跳的硬前提：牌口与平台能力都在，否则宁可不开这一跳。
    // **绝不回退成普通 startCoordinator 发 impact 牌**：那张牌没有 changeId 绑定，
    // 拿它去调专属动作只会得到「平台坏了」的错误。
    if (input.purpose === 'impact') this.#requireImpactCapability();

    const now = this.#now().getTime();
    const usable = await this.#availableCandidates(input.pool, now, input.excludedProfileIds);
    if (usable.length === 0) {
      // 全在冷却：这不是"实现错了"，是暂时没人干活。分开报，因为处置不同——
      // 前者要人看，后者等一会儿就好。死信/退避已经在上面认过，不会被这条盖掉。
      //
      // 带上角色：这一跳没跑起来的原因**只有**候选不可用一个，调用方不用再猜。
      return { exhausted: 'no_available_agent', candidateRole: input.role };
    }

    // 租约必须钉在即将启动的候选上。先领再选会让 failover 把 B 跑在 A 的 runtime/profile 名额下。
    let claimedHop: QueuedHop | undefined;
    let hopRan = false;
    let hopLeaseLost = false;
    let capacityBlocked: { reason: WaitReason; detail: string } | undefined;

    const limit = input.pool.maxAttempts ?? 3;
    let used = 0;
    // 只调一次：同一跳换候选之前工作区已回滚到 startRevision，HEAD 没有变。
    let startHook = input.onExecutorStart;
    for (const profile of usable) {
      // Attempt 起点。换候选之前要回到这里：下一个候选应该从干净的起点
      // 开始，而不是接手上一个改到一半的代码（S06.3）。
      const startRevision = await this.#workspace.head(input.cwd).catch(() => undefined);
      let claimedProbe = false;
      if (this.#candidateCircuits) {
        const circuit = await this.#candidateCircuits.get(profile.profileId);
        if (circuit.state === 'open') {
          claimedProbe = await this.#candidateCircuits.tryClaimProbe({
            profileId: profile.profileId, now: this.#now().toISOString(),
          });
          if (!claimedProbe) continue;
        } else if (circuit.state === 'half_open') {
          continue;
        }
      }
      if (used >= limit) {
        if (claimedProbe) {
          const circuit = await this.#candidateCircuits!.get(profile.profileId);
          if (circuit.state === 'half_open') await this.#candidateCircuits!.resolveProbe({
            profileId: profile.profileId, succeeded: false, failureClass: circuit.failureClass, openUntil: circuit.openUntil,
          });
        }
        return { exhausted: 'attempt_limit_reached' };
      }
      const identity = { runtimeKind: input.pool.runtime.kind, profileId: profile.profileId };
      if (claimedHop && this.#leaseIdentityMismatch(claimedHop, identity)) {
        // 仍握着 A 的租约时不得启动 B；未跑完的 hop 不能 complete，只能跳过。
        continue;
      }
      if (!claimedHop) {
        const queued = await this.#acquireHopForStart({
          role: input.role,
          missionId: input.missionId,
          workItemId: input.workItemId,
          maxAttempts: limit,
          candidate: identity,
          purpose: input.purpose,
          changeId: input.changeId,
        });
        if (queued.kind === 'waiting') {
          if (queued.wait === 'capacity') {
            capacityBlocked = { reason: queued.reason, detail: queued.detail };
            if (claimedProbe) {
              const circuit = await this.#candidateCircuits!.get(profile.profileId);
              if (circuit.state === 'half_open') await this.#candidateCircuits!.resolveProbe({
                profileId: profile.profileId, succeeded: false, failureClass: circuit.failureClass, openUntil: circuit.openUntil,
              });
            }
            continue;
          }
          return { exhausted: queued.reason, detail: queued.detail };
        }
        if (queued.kind === 'completed') return { alreadyCompleted: true };
        claimedHop = queued.kind === 'claimed' ? queued.hop : undefined;
      }
      used += 1;

      // 候选已经拿到、退避也已经等到：执行者这一步是真的要跑了。
      if (startHook) {
        const hook = startHook;
        startHook = undefined;
        await hook();
      }

      const claim = this.#trustedQueueClaim(claimedHop);
      // impact 跳仍走 coordinator pool（同一个并发上限与同一套候选健康），但**发的是
      // 限权牌**：changeId 由牌铤死，只能读/写那一条变更。
      const { attemptId, token } =
        input.role === 'coordinator'
          ? input.purpose === 'impact'
            ? await this.#tokens.startImpactCoordinator!(
                input.missionId,
                input.changeId as string,
                profile,
                claim,
              )
            : await this.#tokens.startCoordinator(input.missionId, profile, claim)
          : await this.#tokens.startExecutor(input.missionId, input.workItemId as string, profile, claim);

      let outcome: Awaited<ReturnType<Awaited<ReturnType<AgentRuntime['start']>>['wait']>> | undefined;
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let wallClock: ReturnType<typeof setTimeout> | undefined;
      // 到点掐掉之后，close 事件回来的是一个普通的"进程被杀"失败。
      // 不记这个标志就没法把它和真的上游故障分开，而两者处置完全相反。
      let runaway = false;
      let thrownRuntimeException = false;
      let thrownRuleError = false;
      /**
       * 边跑边收到的最后一次累计用量。
       *
       * 被杀掉的进程来不及回传结果行，于是 outcome.usage 是全零的 UNKNOWN。
       * 实测一跳跑了 8 分 50 秒、在实时通道里报了几十次用量，最后却记成
       * `input=0 output=0` —— 那笔钱真的花了，只是账上没有，整条 Mission 的
       * 用量因此被标成 estimated。**花掉的 token 不能因为进程是被杀的就不算。**
       */
      let streamedUsage: TokenUsage | undefined;
      /** 墙钟延长只给一次。一直不交东西的，第二次到点就停。 */
      let extendedOnce = false;
      // BUDGET-001-S4: per-hop command-tracking ingest (projection only; no gate).
      // Hub never classifies by tool name — only adapter activityClass after v1 cover.
      let sawToolStarted = false;
      let commandTracking: 'none' | 'enabled' | 'invalid' = 'none';
      const seenCommandCallIds = new Set<string>();
      // BUDGET-001-S4: per-hop SERIAL durable append queue.
      // Array-of-started-promises lets PG INSERT completion reorder vs runtime events.
      // Chain so each record* begins only after the prior queued append settles successfully.
      // Runtime callback stays non-blocking: enqueue sync, never await inside on().
      let commandDurableTail: Promise<void> = Promise.resolve();
      /** True only after runtime.command_tracking.enabled append completed for this attempt. */
      let enabledPersisted = false;
      const enqueueCommandDurable = (write: () => Promise<void>): void => {
        // Keep rejection on the tail for flushCommandDurable; detach a void catch so a
        // mid-hop write failure before await does not surface as unhandledRejection.
        const next = commandDurableTail.then(write);
        void next.catch(() => undefined);
        commandDurableTail = next;
      };
      const flushCommandDurable = async (): Promise<void> => {
        try {
          await commandDurableTail;
        } catch (writeError) {
          // Fail closed: if authoritative enabled landed but a later started/invalid
          // write failed, best-effort invalid so projection cannot stay "known" short.
          // Do not re-enter the rejected chain — call Platform directly.
          // enabled itself failing needs no recovery (attempt.started without enabled ⇒ unknown).
          if (enabledPersisted) {
            try {
              await this.#platform.recordCommandTrackingInvalid(input.missionId, attemptId);
            } catch {
              // Recovery failed — keep original write failure; do not pretend coverage.
            }
          }
          throw writeError;
        }
      };
      let impactSession: ImpactSupervisionSession = inertImpactSupervisionSession;
      try {
        // Attempt 已开：start 抛错也算消耗了这一跳。不置位的话 failover 会握着 A
        // 未 complete 的租约仍可供恢复夹具接管。
        hopRan = true;
        const run = await input.pool.runtime.start({
          role: input.role,
          attemptId,
          missionId: input.missionId,
          workItemId: input.workItemId,
          cwd: input.cwd,
          profile,
          instruction: input.instruction,
          tools: [],
          resumeRef: input.resumeRef,
          endpoint: { baseUrl: this.#baseUrl, token },
        });
        // 一边跑一边往实时通道里送。不送的话，界面在这一跳的两三分钟里是死的——
        // 人分不出它在干活还是卡住了，而这正是最想知道的时候。
        unsubscribe = run.on((event) => {
          const base = { missionId: input.missionId, attemptId };
          if (event.kind === 'runtime.capabilities') {
            // Valid v1 before any tool.started enables tracking; duplicate is idempotent;
            // capability after a tool never enables this attempt.
            if (
              event.commandActivityClassification === 'v1' &&
              commandTracking === 'none' &&
              !sawToolStarted
            ) {
              commandTracking = 'enabled';
              enqueueCommandDurable(async () => {
                await this.#platform.recordCommandTrackingEnabled(input.missionId, attemptId);
                enabledPersisted = true;
              });
            }
            return;
          }
          if (event.kind === 'output') {
            // 流式文本是一小段一小段来的：一个 key 被切在两段之间时逐段脱敏抓不到，这里只能尽力。
            // 大段带出凭据的是工具输出，那条路经 API 以证据形式进来，在入口整段脱敏。
            void this.#live.append({ ...base, kind: 'text', text: redactSecrets(event.text) });
          } else if (event.kind === 'tool.started') {
            // Mark before classification — order is the contract.
            sawToolStarted = true;
            void this.#live.append({
              ...base,
              kind: 'tool',
              // 带上具体在干什么。挂住之后这一行是唯一能指认"卡在哪条命令上"
              // 的东西；适配层没给 detail 时退回只有工具名，行为和以前一样。
              text: event.detail ? `${event.name} · ${redactSecrets(event.detail)}` : event.name,
            });
            if (commandTracking === 'enabled') {
              const activityClass = event.activityClass;
              if (activityClass !== 'command' && activityClass !== 'other') {
                // Enabled cover + unclassified start must not yield a short count.
                commandTracking = 'invalid';
                enqueueCommandDurable(() =>
                  this.#platform.recordCommandTrackingInvalid(input.missionId, attemptId),
                );
              } else if (activityClass === 'command') {
                const callId = event.callId;
                if (typeof callId !== 'string' || callId.length === 0) {
                  commandTracking = 'invalid';
                  enqueueCommandDurable(() =>
                    this.#platform.recordCommandTrackingInvalid(input.missionId, attemptId),
                  );
                } else if (!seenCommandCallIds.has(callId)) {
                  seenCommandCallIds.add(callId);
                  enqueueCommandDurable(() =>
                    this.#platform.recordCommandStarted(input.missionId, attemptId, callId),
                  );
                }
              }
              // activityClass === 'other' → no command-start fact
            }
          } else if (event.kind === 'tool.completed') {
            // COM5 T2：工具结束是无条件事实，不看 activityClass，也不进命令计数。
            // 与 command.started 共用同一条串行落盘队列：两条事实的相对顺序就是
            // 「开始 → 结束」，并行写会让他们在存储层乱序，工具耗时正负翻转。
            enqueueCommandDurable(() =>
              this.#platform.recordToolCompleted(input.missionId, attemptId, {
                callId: event.callId,
                name: event.name,
              }),
            );
          } else if (event.kind === 'usage') {
            streamedUsage = event.usage;
            void this.#live.append({ ...base, kind: 'usage', usage: event.usage });
          }
        });
        // 续租：跑着的时候每隔一段时间打一下心跳，别的进程才看得见
        // "这条还有人在管"。没有它，另一个进程的启动收敛会把这次尝试
        // 判死——实测发生过，一条跑到一半的 Mission 当场坏掉。
        heartbeat = setInterval(() => {
          void this.#platform.beatAttempt(input.missionId, attemptId, this.#owner).catch(
            () => undefined,
          );
          void this.#renewHopLease(claimedHop, () => {
            hopLeaseLost = true;
          });
        }, HEARTBEAT_MS);
        // 立刻先打一次：不打的话头一个间隔内它看起来就是"从没心跳过"，
        // 而没心跳一律算没人管。
        await this.#platform.beatAttempt(input.missionId, attemptId, this.#owner).catch(
          () => undefined,
        );
        await this.#renewHopLease(claimedHop, () => {
          hopLeaseLost = true;
        });
        // 墙钟闸。abort 会连子孙进程一起收（Windows 上 shell:true 的子进程
        // 只 kill 父的话，真正在跑的那个孙子还握着管道，close 永远不来）。
        //
        // **到点先看它有没有在交东西。** 首次真实触发就是一次误杀：一跳跑满
        // 30 分钟被掐，而它其实早已 452/452 全绿，正在改注释和函数名。光看
        // 墙钟分不出"打转"和"做完了在收尾"，能分出来的是**平台可见的进展**——
        // 那一跳 112 次本地工具调用、零次平台交互，是真的什么都没交。
        // 在交的就给一次延长；再到点还没完就停，那时候确实该有人来看了。
        const armWallClock = () => {
          wallClock = setTimeout(() => {
            void (async () => {
              if (!extendedOnce && (await this.#hasSubmittedSomething(input.missionId, attemptId))) {
                extendedOnce = true;
                armWallClock();
                return;
              }
              runaway = true;
              void run.abort?.();
            })();
          }, this.#wallClockMs);
        };
        armWallClock();
        // 唯一 hook 点：执行者的 wait 还没落定期间，可以开一条限权 impact hop 把
        // L3 已确认变更的影响判断持久下来。监督只拿着 **同一份** waitPromise（绝不
        // 去调第二次 run.wait()），它自己不能决定何时结束、也不能关掉任何 Attempt。
        //
        // wait 仍然只调一次：2076 那条 `await run.wait()` 换成 `await waitPromise`，
        // 下面的 flushCommandDurable 包装原样保留（运行时抛错后也不能丢已收到的
        // 命令持久事实）。
        const waitPromise = run.wait();
        impactSession = this.#beginImpactSupervision({
          role: input.role,
          purpose: input.purpose,
          waitPromise,
          missionId: input.missionId,
          workItemId: input.workItemId,
          executorAttemptId: attemptId,
          executorClaim: claim,
          cwd: input.cwd,
        });
        // Flush durable command facts even when wait() throws after events were received.
        // Preserve the original runtime failure; do not let a secondary write error replace it.
        // If only the write fails, surface that so we never falsely claim authoritative coverage.
        let waitError: unknown;
        try {
          outcome = await waitPromise;
        } catch (error) {
          waitError = error;
        } finally {
          try {
            await flushCommandDurable();
          } catch (writeError) {
            if (waitError === undefined) waitError = writeError;
          }
        }
        if (waitError !== undefined) throw waitError;
      } catch (error) {
        thrownRuntimeException = true;
        thrownRuleError = error instanceof PlatformRuleError;
        // 区分"平台自己连不上"与"那个候选不可用"。归错类的代价是：
        // 平台一抖，好端端的候选被冻进冷却，而换一个照样连不上。
        const message = error instanceof Error ? error.message : String(error);
        const unreachable = /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|EPIPE/i.test(
          message,
        );
        outcome = {
          endedBy: unreachable ? 'platform_unreachable' : 'upstream_failure',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, quality: 'unknown' },
          failureMessage: message,
        };
      } finally {
        // **先 join 监督，再收尾执行者自己。**
        //
        // 这里的顺序不是风格问题：执行者已进入终态流程后还留着 in_progress 的 impact
        // coordinator，它就既占着「唯一 coordinator」名额（后面的普通验收开不出
        // Attempt），又在没人看着的时候往仓储里写判断。stopAndJoin 只停新启动：
        // 已在飞的那一跳会跑完它自己的一跳，这里等它结束，**不 abort**。
        await impactSession.stopAndJoin();
        clearInterval(heartbeat);
        clearTimeout(wallClock);
        unsubscribe?.();
        // 收尾必须在 finally：运行时崩了而 attempt 没收尾，这个工作项就
        // 永远开不了下一次尝试。
        const attemptFinish: Parameters<Platform['finishAttempt']>[2] = {
          // 被墙钟掐掉的记成 killed_wall_clock，不是 upstream_failure。
          // 运行时那边只看得到"进程被杀"，分不出是谁掐的——**只有这里知道**。
          // 不在这儿改正，事后要分辨就只能去 failureMessage 里做字符串匹配。
          endedBy: runaway ? 'killed_wall_clock' : (outcome?.endedBy ?? 'no_structured_result'),
          // 结果行里没带用量（进程被杀、崩了），就用边跑边收到的最后一次。
          // 它的 quality 降一级标成 estimated：那是"最后一次报告"而不是
          // "跑完的总账"，中间可能还有几次调用没来得及报。降级但不丢——
          // **写 0 是在说这一跳没花钱，而它花了。**
          usage: usableUsage(outcome?.usage, streamedUsage),
          failureMessage: outcome?.failureMessage,
          resumeRef: outcome?.resumeRef,
          output: outcome?.output,
          toolCalls: outcome?.toolCalls,
          resolvedProfile: outcome?.resolvedProfile,
          // 墙钟强杀或根本没有 outcome 时不得把采集摘要标成 complete。
          // wait() 竞态里可能仍带回一份自称完整的摘要，这里必须丢掉。
          ...(!runaway && outcome?.contextMetrics !== undefined
            ? { contextMetrics: outcome.contextMetrics }
            : {}),
        };
        if (input.purpose === 'impact') {
          // impact 跳失租时 finishAttempt 会被围栏拒掉：走可信收尾关掉旧 Attempt，
          // 且 **finally 必吊销牌** —— 迟到的工具调用必须被拒。
          await this.#finishImpactHopWithLostFenceRecovery({
            missionId: input.missionId,
            attemptId,
            token,
            claim,
            outcome: attemptFinish,
          });
        } else {
          await this.#platform.finishAttempt(input.missionId, attemptId, attemptFinish, claim);
        }
        // 收尾只裁当前 Mission/Attempt 的早期实时输出，保留尾部供事后排障。
        await this.#live.finish?.(input.missionId, attemptId).catch(() => undefined);
        this.#tokens.revoke(token);
      }

      if (
        input.role === 'executor' &&
        outcome.endedBy === 'structured_submit' &&
        !runaway
      ) {
        try {
          if (this.#workspace.checkpoint) {
            const view = await this.#platform.getMissionView(input.missionId);
            const item = view.workItems.find((candidate) => candidate.id === input.workItemId);
            const allowedScope = item?.order?.allowedScope;
            if (!input.workItemId || !Array.isArray(allowedScope) || allowedScope.length === 0) {
              throw new Error(`缺少工作项 ${input.workItemId ?? '(未指定)'} 的冻结 allowedScope，无法检查点`);
            }
            await this.#workspace.checkpoint(input.cwd, input.missionId, input.workItemId, allowedScope);
          } else if (!(this.#workspace instanceof InPlaceWorkspaceManager)) {
            throw new Error('WorkspaceManager 未实现 checkpoint，无法验证已交回成果');
          }
        } catch (error) {
          const detail = `执行者已交回成果，但冻结范围检查点失败：${error instanceof Error ? error.message : String(error)}。改动保留在工作区，已停止后续执行。`;
          await this.#platform.setWaitReason(input.missionId, 'no_available_agent', detail).catch(() => undefined);
          this.hops.push({ role: input.role, workItemId: input.workItemId, attemptId, profile, endedBy: outcome.endedBy, failureMessage: detail });
          return { exhausted: 'no_available_agent', detail };
        }
      }

      // 和写回平台的那个值保持一致。两处分叉的话，库里记的和这里判的就是
      // 两件事，而排障的人会同时看到两者。
      const endedBy: AttemptEndReason = runaway ? 'killed_wall_clock' : outcome.endedBy;
      const message = outcome.failureMessage ?? '';
      const classification = classifyCandidateFailure(endedBy, message, thrownRuntimeException);
      const failureClass = classification?.failureClass ?? 'unknown';
      const durableCandidateFailure =
        endedBy === 'upstream_failure' || endedBy === 'killed_idle' ||
        classification?.failureClass === 'local_adapter_error';
      if (this.#candidateCircuits) {
        const openUntil = failureClass === 'quota'
          ? resolveQuotaResetTime({ message, now: this.#now().toISOString() })
          : new Date(this.#now().getTime() + (input.pool.cooldownMs ?? 5 * 60 * 1000)).toISOString();
        if (endedBy === 'platform_unreachable') {
          // A platform outage is not a candidate outcome; keep a claimed probe from
          // remaining stuck without changing the existing circuit row.
          if (claimedProbe) {
            const original = await this.#candidateCircuits.get(profile.profileId);
            if (original.state === 'half_open') await this.#candidateCircuits.resolveProbe({
              profileId: profile.profileId, succeeded: false, failureClass: original.failureClass, openUntil: original.openUntil,
            });
          }
        } else if (claimedProbe) {
          if (durableCandidateFailure) await this.#candidateCircuits.resolveProbe({ profileId: profile.profileId, succeeded: false, failureClass, openUntil });
          else if (endedBy === 'structured_submit') await this.#candidateCircuits.resolveProbe({ profileId: profile.profileId, succeeded: true });
          else {
            // Non-candidate execution failures do not prove the probe healthy.
            const original = await this.#candidateCircuits.get(profile.profileId);
            if (original.state === 'half_open') await this.#candidateCircuits.resolveProbe({
              profileId: profile.profileId, succeeded: false, failureClass: original.failureClass, openUntil: original.openUntil,
            });
          }
        } else if (durableCandidateFailure) {
          await this.#candidateCircuits.open({ profileId: profile.profileId, failureClass, openUntil });
        }
      }

      this.hops.push({
        role: input.role,
        workItemId: input.workItemId,
        attemptId,
        profile,
        endedBy,
        failureMessage: outcome.failureMessage,
      });

      // 墙钟到点 —— **在判上游失败之前拦下来**。
      //
      // 被掐掉的进程回来的是一次普通的 "进程被杀" 失败，落进下面那个分支就会：
      // 冷却这个候选、回滚工作区、换下一个候选再跑一遍。三件事全是错的——
      // 候选没问题，回滚会把它这 30 分钟做的东西全擦掉（而那正是人要看的），
      // 换个候选只会把同样的 30 分钟再烧一遍。
      //
      // 所以这里什么都不做，只把话说清楚然后停。实时输出的尾巴已经在库里了。
      if (runaway) {
        const minutes = Math.round(this.#wallClockMs / 60_000);
        const where = input.workItemId ? `工作项 ${input.workItemId}` : '协调者';
        // COM12 B（W-524）：到这里 finally 已经跑完——run.abort 杀了整棵进程树、
        // await run.wait() 已观察退出、被掐断的 Attempt 已 finishAttempt 收尾并
        // 吊销令牌，平台才证明得了「没有活执行者」。把仍 dispatched 的工作项可信
        // 收成 blocked（source runaway），协调者才能修订同一张单再派，不必作废重建。
        // 只有执行者跳有工作项；收尾被拒/失败不改下面的 runaway 停机语义。调用仍
        // 在持有这一跳队列 claim 期间，迟到的收尾会被围栏拒掉。
        if (input.role === 'executor' && input.workItemId !== undefined) {
          await this.#blockStalledOnRunaway(
            input.missionId,
            input.workItemId,
            attemptId,
            extendedOnce ? minutes * 2 : minutes,
            claim,
          );
        }
        return {
          exhausted: 'runaway_suspected',
          // detail 跟着返回，不在这里写平台：调用方那边紧接着就会用
          // #stallDetail 拼一句泛泛的话覆盖掉它，而这一句里的"跑了多久、
          // 改动还在哪、哪个尝试"才是人接下来要用的。
          detail:
            `${where} 这一跳连续跑了 ${extendedOnce ? minutes * 2 : minutes} 分钟还没提交结果，` +
            '已经停下来等人看。它一直在产出，所以静默超时不会响——' +
            (extendedOnce
              ? '它中途交过证据（所以已经延长过一次），但始终没交出执行结果。'
              : '而且**一次平台交互都没有**：没提交过任何证据。这通常意味着工单太大，' +
                '或者它在等一条永远不会返回的命令。') +
            `改动留在工作区里没有回滚，实时输出的尾部也还在（尝试 ${attemptId}），` +
            '看完再决定是继续、拆小工单、还是作废。',
        };
      }

      if (endedBy === 'platform_unreachable') {
        // **不冷却候选**：问题在平台自己这边。直接停下来喊人——
        // 继续换候选只会把整个池子白白冻掉。
        await this.#platform
          .setWaitReason(input.missionId, 'platform_unreachable')
          .catch(() => undefined);
        return { exhausted: 'platform_unreachable' };
      }

      // upstream_failure 与 killed_idle **处置相同、记录不同**。
      //
      // 处置相同：两者都该回滚（状态不明）、都该换个候选试试。实测这样确实
      // 产生了新信息——W5 里 ds41 静默卡死、换到 qwen 才暴露出它的模型已经
      // 没了，两条路都走一遍才把真相凑齐。
      //
      // 记录不同：一个是"那个候选挂了"，一个是"我们自己按静默超时掐的"。
      // 混在一起的话，"这个配置有多容易卡住"这个问题就只能去
      // failureMessage 里做字符串匹配——而那是一句给人读的话，随时会改。
      const shouldFailover = this.#candidateCircuits
        ? classification?.failover === true
        : endedBy === 'upstream_failure' || endedBy === 'killed_idle' || endedBy === 'quota' || endedBy === 'auth' || endedBy === 'upstream_5xx';
      const reportableFailure = thrownRuleError || shouldFailover || durableCandidateFailure;
      if (
        reportableFailure &&
        claimedHop &&
        hopRan &&
        !hopLeaseLost &&
        this.#hopScheduler &&
        claimedHop.claimGeneration !== undefined
      ) {
        // 有界重试钉在同一逻辑槽上。complete 会放开 idempotency key，下一跳
        // 另开一行就把 attemptCount 清零；同轮换候选也会占着容量去启动 B。
        if (shouldFailover) {
          this.#cooldown.set(
            profile.profileId,
            Date.now() + (input.pool.cooldownMs ?? 5 * 60 * 1000),
          );
          if (input.role === 'executor' && startRevision) {
            await this.#workspace.rollback(input.cwd, startRevision).catch(() => undefined);
          }
        }
        const reported = await this.#reportClaimedHopFailure({
          hop: claimedHop,
          attemptId,
          classification: thrownRuleError ? 'rule' : failureClass,
          disposition: thrownRuleError ? 'do_not_retry' : 'retry_then_dead_letter',
          retryable: !thrownRuleError,
        });
        if (reported.status === 'dead_letter') {
          return {
            exhausted: 'attempt_limit_reached',
            detail: queuedHopWaitDetail({ kind: 'waiting', hop: reported, wait: 'dead_letter' }),
          };
        }
        if (await this.#waitInRunForRetry(reported, shouldFailover)) {
          // 失败已记账且等到了 availableAt。交回下一轮走 #acquireHopForStart，
          // 才会换到 Q。这里 continue 下一候选会在同一轮启动 Q，maxRounds=1
          // 也拦不住；complete 再入队则会把 attemptCount 清零。
          return { retrySameSlot: true };
        }
        return {
          exhausted: 'project_busy',
          detail: queuedHopWaitDetail({ kind: 'waiting', hop: reported, wait: 'available_at' }),
        };
      }
      if (shouldFailover) {
        // 这个候选先放一会儿，别下一跳又撞上同一个限流 / 同一次卡死。
        this.#cooldown.set(
          profile.profileId,
          Date.now() + (input.pool.cooldownMs ?? 5 * 60 * 1000),
        );
        // 只在执行者这一侧回滚：协调者不改代码，回滚它没有意义，
        // 反而会把执行者刚交付的成果一起擦掉。
        if (input.role === 'executor' && startRevision) {
          await this.#workspace.rollback(input.cwd, startRevision).catch(() => undefined);
        }
        // 容量路径必须先释放 A 的持久租约再领 B。不 complete 的话下一跳会带着 A 的
        // runtime/profile 占位去启动 B，五维上限就被绕开。未真正跑过的 hop 不能
        // complete（恢复夹具要靠它接管），只能跳过后续身份不同的候选。
        if (this.#supportsCapacityClaim() && hopRan && !hopLeaseLost) {
          await this.#completeHopLease(claimedHop);
          claimedHop = undefined;
          hopRan = false;
          hopLeaseLost = false;
        }
        continue; // 换下一个候选
      }
      if (hopRan && !hopLeaseLost) await this.#completeHopLease(claimedHop);
      return {
        endedBy,
        resumeRef: outcome.resumeRef,
        persistentUnknown: Boolean(this.#candidateCircuits && failureClass === 'unknown' && durableCandidateFailure),
      };
    }
    if (capacityBlocked && used === 0) {
      // 队列容量挡住的**不是候选不可用**：人其实是有的，只是名额被占着。
      // 这层 reason 和候选冷却分得开，绝不能给它贴角色。
      return { exhausted: capacityBlocked.reason, detail: capacityBlocked.detail };
    }
    // 候选在，但一个都没跑成（都失败了、都在 half_open、或者全被身份/容量跳过）：
    // 结果和"池子里没人"一样——这个角色的候选这一跳用不上，所以同样带上角色。
    // 之前这里返回 undefined、由调用方兜成 no_available_agent，那条路上没人
    // 知道缺的是哪个角色，方案驱动只能干等。
    return { exhausted: 'no_available_agent', candidateRole: input.role };
  }

  /**
   * 影响判断监督的**能力探测**（不试、不括、不回退）。
   *
   * 三项缺任何一项都算 unsupported：
   *   - 牌口没有 `startImpactCoordinator` → 只能发普通牌，而普通牌没有 changeId 绑定；
   *   - Platform.supportsChangeImpact() !== true → 专属读写全会被 CHANGE_IMPACT_UNSUPPORTED 拒掉；
   *   - 队列仓储没有 `claimAvailable` → 走不了五维容量/公平，impact 会绕过上限。
   * 不退化成普通 startCoordinator：那张牌过不了专属动作的校核，调用方只会把
   * 「这里没装配」误读成「平台坏了」。
   */
  #impactCapacityReady(): boolean {
    return (
      typeof this.#tokens.startImpactCoordinator === 'function' &&
      this.#platform.supportsChangeImpact() === true &&
      this.#supportsCapacityClaim()
    );
  }

  /** impact 跳的硬前提。不成立就**不开这一跳**，而不是拿普通牌去发 impact 牌。 */
  #requireImpactCapability(): void {
    if (!this.#impactCapacityReady()) {
      throw new PlatformRuleError(
        CHANGE_IMPACT_UNSUPPORTED,
        '当前装配不支持影响判断专属跳（缺限权发牌口 / 变更仓储 / 容量领取），不启动 impact hop。',
      );
    }
  }

  /**
   * 唯一 hook：把监督挂到执行者那一跳的 waitPromise 上。
   *
   * 默认关闭；不启用 / 不是执行者普通跳 / 本身就是 impact 跳（不许套第二层）时，
   * 直接拿到一个 no-op session，调用方那边无需分支。
   */
  #beginImpactSupervision(input: {
    role: 'coordinator' | 'executor';
    purpose?: 'impact';
    waitPromise: Promise<unknown>;
    missionId: string;
    workItemId: string | undefined;
    executorAttemptId: string;
    executorClaim: QueueClaimIdentity | undefined;
    cwd: string;
  }): ImpactSupervisionSession {
    const settings = this.#impactSupervision;
    if (settings === undefined || input.role !== 'executor' || input.purpose !== undefined) {
      return inertImpactSupervisionSession;
    }
    const workItemId = input.workItemId;
    const executorClaim = input.executorClaim;
    const supported = impactSupervisionSupported({
      settingsPresent: true,
      issuerSupports: typeof this.#tokens.startImpactCoordinator === 'function',
      platformSupports: this.#platform.supportsChangeImpact() === true,
      capacityClaimSupported: this.#supportsCapacityClaim(),
      executorClaimPresent: executorClaim !== undefined,
      workItemPresent: workItemId !== undefined,
    });
    return beginImpactSupervision({
      waitPromise: input.waitPromise,
      settings,
      missionId: input.missionId,
      workItemId: workItemId ?? '-',
      executorAttemptId: input.executorAttemptId,
      executorClaimGeneration: executorClaim?.claimGeneration ?? -1,
      supported,
      // 只读接缝：失败（包括围栏拒）交给监督自己处置，这里不吞也不重试。
      listPending: () =>
        this.#platform.listPendingChangeRequests(
          input.missionId,
          workItemId ?? '-',
          input.executorAttemptId,
          executorClaim,
        ),
      runImpactHop: (change) =>
        this.#dispatchImpactHop({
          missionId: input.missionId,
          cwd: input.cwd,
          change,
        }),
      // 等待原因只用已有的那两种（project_busy / target_changed），不新增英文原因。
      setWaitReason: (reason, detail) =>
        this.#platform.setWaitReason(input.missionId, reason, detail),
      observe: (entry) => {
        this.impactObservations.push(entry);
      },
    });
  }

  /**
   * 下发一跳 impact：走现有 #runHop，因此心跳 / 墙钟 / 候选健康 / 熔断 /
   * 队列领取 / finally 收牌全部复用原路径，本跳不写第二套。
   *
   * 预算：下发前过一次既有 PRE 闸。硬上限已耗尽时不开新的判断 hop——
   * 那只会多花一笔钱而什何也决定不了（这不是 abort，执行者那一跳照旧跑完）。
   */
  async #dispatchImpactHop(input: {
    missionId: string;
    cwd: string;
    change: ChangeRequest;
  }): Promise<ImpactHopDisposition> {
    const gate = await this.#enforceAuthoritativeBudget(input.missionId);
    if (gate.kind === 'stop') {
      return {
        kind: 'blocked',
        detail: `既有预算闸已拦下本次运行（${gate.outcome.reason}），影响判断保留 pending。`,
      };
    }
    const hop = await this.#runHop({
      role: 'coordinator',
      missionId: input.missionId,
      // 目标工作项来自仓储里的那条变更，不是调用方自述。
      workItemId: input.change.workItemId,
      cwd: input.cwd,
      pool: this.#coordinator,
      instruction: impactSupervisionInstruction(input.change),
      purpose: 'impact',
      changeId: input.change.changeId,
    });
    if (!hop) return { kind: 'blocked', detail: '协调者候选耗尽，本轮不开影响判断。' };
    if ('endedBy' in hop || 'alreadyCompleted' in hop) return { kind: 'ran' };
    if ('retrySameSlot' in hop) {
      return { kind: 'pending', detail: '同一 impact 槽已等到退避，下一拍重领。' };
    }
    const detail = hop.detail ?? this.#stallDetail(hop.exhausted, input.change.workItemId);
    if (hop.exhausted === 'target_changed') return { kind: 'stale', detail };
    // 容量 / 退避 / 暂停 / 缺候选：都是「现在不能开」而不是「判断失败了」。
    // **保留 pending，不抢、不无 claim 启动。**
    if (
      hop.exhausted === 'project_busy' ||
      hop.exhausted === 'cancelled_by_user' ||
      hop.exhausted === 'no_available_agent' ||
      hop.exhausted === 'attempt_limit_reached'
    ) {
      return { kind: 'pending', detail };
    }
    return { kind: 'blocked', detail };
  }

  /**
   * impact hop 的收尾：围栏拒写时走**可信失租收尾**，且收不了也得把牌掉。
   *
   * 为什么不能直接把 finishAttempt 的错冒出去：执行者已经终态了，而这条 impact
   * Attempt 会永远停在 in_progress；也不能“当成已收尾”默默过去：用量与结束原因
   * 得落账。只拿 CLAIM_FENCE_REJECTED 走 helper（其余错误照旧抛 —— 把真故障
   * 归成失租，等于把一个需要人看的问题写成等一等就好）。
   *
   * `revoke` 在 helper 自己的 finally 里：迟到的工具调用必须被拒。
   * 外层 finally 后面那句重复 revoke 是幂等的（同一张牌删两次）。
   */
  async #finishImpactHopWithLostFenceRecovery(input: {
    missionId: string;
    attemptId: string;
    token: string;
    claim: QueueClaimIdentity | undefined;
    outcome: Parameters<Platform['finishAttempt']>[2];
  }): Promise<void> {
    try {
      try {
        await this.#platform.finishAttempt(
          input.missionId,
          input.attemptId,
          input.outcome,
          input.claim,
        );
      } catch (error) {
        if (!(error instanceof PlatformRuleError) || error.code !== 'CLAIM_FENCE_REJECTED') {
          throw error;
        }
        // 只关这条旧 impact Attempt：不关新开的 coordinator，也不写 ChangeImpact。
        await this.#platform.finishLostImpactAttempt(
          input.missionId,
          input.attemptId,
          input.outcome,
        );
      }
    } finally {
      this.#tokens.revoke(input.token);
    }
  }

  /**
   * Queue gate used by both coordinator/executor hops and HA independent review.
   * No-op when queuedHops was not injected, so existing fixtures keep their behaviour.
   */
  async #acquireHopForStart(input: {
    role: HopRole;
    missionId: string;
    workItemId?: string;
    maxAttempts: number;
    candidate?: { runtimeKind: string; profileId: string };
    purpose?: 'impact';
    changeId?: string;
  }): Promise<
    | { kind: 'bypass' }
    | { kind: 'claimed'; hop: QueuedHop }
    | { kind: 'completed'; hop: QueuedHop }
    | { kind: 'waiting'; reason: WaitReason; detail: string; wait?: QueuedHopWait }
  > {
    if (!this.#hopScheduler || !this.#queuedHops) return { kind: 'bypass' };
    const view = await this.#platform.getMissionView(input.missionId);
    if (view.paused) {
      return {
        kind: 'waiting',
        reason: 'cancelled_by_user',
        detail: 'Mission 已被暂停，旧队列项不启动 Agent；resume 之后重跑',
      };
    }
    if (view.status === 'completed' || view.status === 'blocked') {
      return {
        kind: 'waiting',
        reason: 'cancelled_by_user',
        detail: `Mission 已终态 ${view.status}，旧队列项不启动 Agent`,
      };
    }
    const workItemId = input.workItemId ?? '-';
    const attemptCycle = nextLogicalHopCycle(await this.#queuedHops.list(), {
      missionId: input.missionId,
      role: input.role,
      workItemId,
      contractRevision: view.contractRevision,
      purpose: input.purpose,
      changeId: input.changeId,
    });
    const idempotencyKey = hopIdempotencyKey({
      missionId: input.missionId,
      role: input.role,
      workItemId,
      contractRevision: view.contractRevision,
      attemptCycle,
      purpose: input.purpose,
      changeId: input.changeId,
    });
    const nowIso = this.#hopClock.now().toISOString();
    const enqueueInput = {
      projectId: view.projectId,
      missionId: input.missionId,
      workItemId,
      role: input.role,
      priority: input.role === 'coordinator' ? 0 : input.role === 'executor' ? 10 : 20,
      availableAt: nowIso,
      attemptCount: 0,
      maxAttempts: Math.max(input.maxAttempts, 1),
      idempotencyKey,
      // 一条变更一个独立槽：不传这两样就会生成普通 coordinator key，于是影响判断
      // 抢占验收跳的逻辑槽（两边其实是两件不同的事）。只给 impact 路径带上。
      ...(input.purpose === 'impact' && input.changeId !== undefined
        ? { purpose: input.purpose, changeId: input.changeId }
        : {}),
    };
    const acquired = this.#supportsCapacityClaim()
      ? await this.#claimEnqueuedHopWithCapacity(enqueueInput, nowIso, input.candidate)
      : await acquireQueuedHop({
          scheduler: this.#hopScheduler,
          repository: this.#queuedHops,
          owner: this.#owner,
          leaseMs: this.#hopLeaseMs,
          nowIso,
          input: enqueueInput,
        });
    if (acquired.kind === 'waiting') {
      return {
        kind: 'waiting',
        reason: acquired.wait === 'dead_letter' ? 'attempt_limit_reached' : 'project_busy',
        detail: queuedHopWaitDetail(acquired),
        wait: acquired.wait,
      };
    }
    if (acquired.kind === 'completed') return acquired;
    const live = await this.#platform.getMissionView(input.missionId);
    if (live.paused) {
      return {
        kind: 'waiting',
        reason: 'cancelled_by_user',
        detail: 'Mission 已被暂停，旧队列项不启动 Agent；resume 之后重跑',
      };
    }
    if (live.status === 'completed' || live.status === 'blocked') {
      return {
        kind: 'waiting',
        reason: 'cancelled_by_user',
        detail: `Mission 已终态 ${live.status}，旧队列项不启动 Agent`,
      };
    }
    if (live.contractRevision !== view.contractRevision) {
      return {
        kind: 'waiting',
        reason: 'target_changed',
        detail:
          `契约已从 r${view.contractRevision} 变到 r${live.contractRevision}，旧队列项不启动 Agent`,
      };
    }
    return acquired;
  }

  #supportsCapacityClaim(): boolean {
    return typeof (this.#queuedHops as QueuedHopCapacityRepository | undefined)?.claimAvailable === 'function';
  }

  /** 未盖身份的旧行不算错配——D3 简易仓储没有 runtime/profile。 */
  #leaseIdentityMismatch(
    hop: QueuedHop,
    identity: { runtimeKind: string; profileId: string },
  ): boolean {
    if (hop.runtimeKind === undefined && hop.profileId === undefined) return false;
    return hop.runtimeKind !== identity.runtimeKind || hop.profileId !== identity.profileId;
  }

  /**
   * 生产容量领取：enqueue 之后只把本 Mission 当前逻辑 Hop + 即将启动的候选交给
   * claimAvailable。不得退回单 id claim，否则会 silently 绕过五维上限。
   */
  async #claimEnqueuedHopWithCapacity(
    input: {
      projectId: string;
      missionId: string;
      workItemId: string;
      role: HopRole;
      priority: number;
      availableAt: string;
      attemptCount: number;
      maxAttempts: number;
      idempotencyKey: string;
    },
    nowIso: string,
    candidate: { runtimeKind: string; profileId: string } | undefined,
  ): Promise<
    | { kind: 'claimed'; hop: QueuedHop }
    | { kind: 'completed'; hop: QueuedHop }
    | { kind: 'waiting'; hop: QueuedHop; wait: QueuedHopWait }
  > {
    // enqueue 前邻接快照：用来区分「本次插入新行」与「幂等命中旧行」。
    // 放在 enqueue 紧前面，早取会和别的 runner 的入队之间出错。
    const preEnqueueKeyed = new Set(
      (await this.#queuedHops!.list()).map((row) => row.idempotencyKey),
    );
    const hop = await this.#hopScheduler!.enqueue(input);
    // COM5 T3：入队事件只在**本次真的插入了新行**时发。幂等命中旧行不补事件——
    // 补一条等于把「这次没人入队」讲成「入队了」，而这正是排障要分辨的那件事。
    if (!preEnqueueKeyed.has(input.idempotencyKey)) {
      await this.#platform.recordHopEnqueued(input.missionId, hop);
    }
    // 认领事件只认 queued/retry_wait → claimed 那一次迁移。续租会改 updatedAt，
    // 过期接管的 claimed 行是重新认领而不是首次认领，都不发这条。
    const claimablePrior = hop.status === 'queued' || hop.status === 'retry_wait';
    if (hop.status === 'completed') return { kind: 'completed', hop };
    const parked = parkedQueuedHopWait(hop, nowIso);
    if (parked) return parked;
    if (!candidate) {
      // 没有候选身份就领取会留下未标记租约，后续启动谁都算占着它。
      return { kind: 'waiting', hop, wait: 'capacity' };
    }
    const rows = await this.#queuedHops!.list();
    // 公平预检看全队列：未占用时更优者能跑则等待，避免后到 runner 插队。
    // claimAvailable 的 eligible 只能是本 hop——把别人放进去，list 与领取之间
    // 占用一变就会原子领走外 hop。那既不能 complete（丢别人的工作），也不能
    // 启动（错 Mission），只会留下 stranded 租约。
    const fairnessEligible = this.#capacityEligible(rows, hop, candidate);
    for (const row of rows) {
      if (row.id === hop.id || row.status !== 'queued') continue;
      if (row.runtimeKind !== undefined && row.profileId !== undefined) continue;
      if (compareHopFairness(row, hop) < 0) {
        return { kind: 'waiting', hop, wait: 'lease' };
      }
    }
    const snapshot = decideCapacityClaim(rows, nowIso, this.#hopLimits, fairnessEligible);
    if (snapshot.kind === 'select' && snapshot.hop.id !== hop.id) {
      // 更优 hop 能跑：等待，不得领走别人，也不得自己插队。
      return { kind: 'waiting', hop, wait: 'lease' };
    }
    if (snapshot.kind === 'waiting' && snapshot.hop.id !== hop.id && snapshot.wait !== 'capacity') {
      return snapshot;
    }
    if (snapshot.kind === 'waiting' && snapshot.hop.id === hop.id) return snapshot;
    const ownEligible: EligibleHopClaim[] = [
      { hopId: hop.id, runtimeKind: candidate.runtimeKind, profileId: candidate.profileId },
    ];
    const result = await this.#hopScheduler!.claimAvailable(this.#owner, this.#hopLeaseMs, ownEligible);
    if (result.kind === 'claimed' && result.hop.id !== hop.id) {
      // 仓储不得把非 eligible 行领走。若仍发生，不得 complete（会丢掉别人的工作）。
      return { kind: 'waiting', hop, wait: 'lease' };
    }
    if (result.kind === 'claimed') {
      // claimedAt 取**本次认领返回行**的 updatedAt：随后 renew 会把它覆盖，
      // 所以事件必须在这里、用返回行写下来，事后再读行就永远拿不到认领时点。
      if (claimablePrior) await this.#platform.recordHopClaimed(input.missionId, result.hop);
      return result;
    }
    if (result.kind === 'waiting') return result;
    const latest = (await this.#queuedHops!.get(hop.id)) ?? hop;
    if (latest.status === 'completed') return { kind: 'completed', hop: latest };
    const parkedLatest = parkedQueuedHopWait(latest, nowIso);
    if (parkedLatest) return parkedLatest;
    return { kind: 'waiting', hop: latest, wait: 'lease' };
  }

  /**
   * 公平预检用的领取集合：已有身份的未完成行 + 本 hop 即将启动的候选。
   * 只用于 decideCapacityClaim 快照，不交给 claimAvailable。
   * 不把它们放进预检的话，容量仍空时后到 runner 会以为自己是队头。
   */
  #capacityEligible(
    rows: readonly QueuedHop[],
    hop: QueuedHop,
    candidate: { runtimeKind: string; profileId: string },
  ): EligibleHopClaim[] {
    const eligible: EligibleHopClaim[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.status === 'completed' || seen.has(row.id)) continue;
      if (row.id === hop.id) {
        eligible.push({
          hopId: hop.id,
          runtimeKind: candidate.runtimeKind,
          profileId: candidate.profileId,
        });
        seen.add(row.id);
        continue;
      }
      if (row.status !== 'queued' || row.runtimeKind === undefined || row.profileId === undefined) {
        continue;
      }
      eligible.push({
        hopId: row.id,
        runtimeKind: row.runtimeKind,
        profileId: row.profileId,
      });
      seen.add(row.id);
    }
    if (!seen.has(hop.id)) {
      eligible.push({
        hopId: hop.id,
        runtimeKind: candidate.runtimeKind,
        profileId: candidate.profileId,
      });
    }
    return eligible;
  }

  async #renewHopLease(hop: QueuedHop | undefined, onLost: () => void): Promise<void> {
    if (!hop || !this.#hopScheduler || hop.claimGeneration === undefined) return;
    try {
      await this.#hopScheduler.renew(hop.id, this.#owner, hop.claimGeneration, this.#hopLeaseMs);
    } catch {
      const latest = await this.#queuedHops?.get(hop.id);
      const now = this.#hopClock.now().toISOString();
      // Same-millisecond renew is a no-op, not a lost lease. Only treat it as lost when
      // we no longer hold a live claim — otherwise we would refuse to complete a hop
      // that did run, and a later runner could start it again.
      if (
        !latest ||
        latest.status !== 'claimed' ||
        latest.owner !== this.#owner ||
        latest.claimGeneration !== hop.claimGeneration ||
        (latest.leaseUntil !== undefined && Date.parse(latest.leaseUntil) <= Date.parse(now))
      ) {
        onLost();
      }
    }
  }

  /**
   * 重入时先认本逻辑槽的死信/退避。若先看候选可用性，熔断冷却会把
   * attempt_limit_reached 伪装成 no_available_agent，人会空等而不是去看死信。
   */
  async #queuedHopPark(input: {
    role: HopRole;
    missionId: string;
    workItemId?: string;
    purpose?: 'impact';
    changeId?: string;
  }): Promise<{ exhausted: WaitReason; detail: string } | undefined> {
    if (!this.#queuedHops) return undefined;
    const view = await this.#platform.getMissionView(input.missionId);
    const workItemId = input.workItemId ?? '-';
    const rows = await this.#queuedHops.list();
    const attemptCycle = nextLogicalHopCycle(rows, {
      missionId: input.missionId,
      role: input.role,
      workItemId,
      contractRevision: view.contractRevision,
      purpose: input.purpose,
      changeId: input.changeId,
    });
    const existing = rows.find(
      (row) =>
        row.idempotencyKey ===
        hopIdempotencyKey({
          missionId: input.missionId,
          role: input.role,
          workItemId,
          contractRevision: view.contractRevision,
          attemptCycle,
          purpose: input.purpose,
          changeId: input.changeId,
        }),
    );
    if (!existing) return undefined;
    const parked = parkedQueuedHopWait(existing, this.#hopClock.now().toISOString());
    if (!parked) return undefined;
    return {
      exhausted: parked.wait === 'dead_letter' ? 'attempt_limit_reached' : 'project_busy',
      detail: queuedHopWaitDetail(parked),
    };
  }

  /**
   * 可换候选的 retry_wait 在上限内等到 availableAt，好让同一次运行重领同一槽。
   * unknown / 规则错误 / 超上限 / 越过墙钟都不睡——那些必须把 waiting 交回去。
   * 时钟若在 sleep 后仍停着（固定 now），立刻放弃：假装等到了会在领取时再失败一次。
   */
  async #waitInRunForRetry(hop: QueuedHop, swappable: boolean): Promise<boolean> {
    if (!swappable || hop.status !== 'retry_wait' || this.#inRunBackoffWaitMs <= 0) return false;
    const available = Date.parse(hop.availableAt);
    if (!Number.isFinite(available)) return false;
    const before = this.#hopClock.now().getTime();
    const waitMs = available - before;
    if (waitMs > this.#inRunBackoffWaitMs) return false;
    if (this.#missionDeadlineAt !== undefined && available > this.#missionDeadlineAt) return false;
    if (waitMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, waitMs);
      });
    }
    const after = this.#hopClock.now().getTime();
    if (waitMs > 0 && after <= before) return false;
    if (after < available) {
      const remain = available - after;
      if (remain > this.#inRunBackoffWaitMs) return false;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, remain);
      });
      if (this.#hopClock.now().getTime() <= after) return false;
    }
    return this.#hopClock.now().getTime() >= available;
  }

  async #reportClaimedHopFailure(input: {
    hop: QueuedHop;
    attemptId: string;
    classification: string;
    disposition: string;
    retryable: boolean;
  }): Promise<QueuedHop> {
    // 报告失败不得 catch 后假装成功：仓储缺方法或围栏拒写都必须冒出来，
    // 否则会走回 complete / 换槽，把同一失败再计一次或把 hop 放掉。
    const reported = await this.#hopScheduler!.reportFailure({
      id: input.hop.id,
      claimGeneration: input.hop.claimGeneration!,
      attemptId: input.attemptId,
      failedAt: this.#hopClock.now().toISOString(),
      classification: input.classification,
      disposition: input.disposition,
      retryable: input.retryable,
    });
    // 只有真的进了退避才写 backoff：dead_letter 不发（它不是等待），
    // 幂等重放返回同一行也不补第二条。
    if (reported.status === 'retry_wait') {
      await this.#platform.recordHopBackoff(input.hop.missionId, reported);
    }
    // 原样返回仓储结果：错误不吞，状态也不改写成别的。
    return reported;
  }

  /**
   * 只从已领取 hop 抄 id/owner/代次。把 now 塞进 claim 等于把租约时钟交给 Runner，
   * 失租的迟到收尾就能把时间拨回去继续写。
   */
  #trustedQueueClaim(hop: QueuedHop | undefined): QueueClaimIdentity | undefined {
    if (hop === undefined || hop.owner === undefined || hop.claimGeneration === undefined) {
      return undefined;
    }
    return { id: hop.id, owner: hop.owner, claimGeneration: hop.claimGeneration };
  }

  async #completeHopLease(hop: QueuedHop | undefined): Promise<void> {
    if (!hop || !this.#hopScheduler || hop.claimGeneration === undefined) return;
    try {
      await this.#hopScheduler.complete(hop.id, this.#owner, hop.claimGeneration);
    } catch {
      // complete rejected (wrong generation / expired lease): leave uncompleted.
    }
  }
}
