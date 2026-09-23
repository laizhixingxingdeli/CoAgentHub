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

import type { AgentRuntime, ExecutionProfile } from './ports.ts';
import type { MissionView, Platform } from './platform.ts';
import { PlatformRuleError } from './platform.ts';
import type { RunTokenIssuer } from './token-issuer.ts';
import type { WorkspaceManager } from './workspace.ts';
import { NoLiveOutput } from './live.ts';
import type { LiveOutput } from './live.ts';
import type { AttemptEndReason, TokenUsage, WaitReason } from '../kernel/index.ts';
import { anyHardAuthoritativeExceeded } from './budget-usage.ts';
import { redactSecrets } from './redact.ts';

export interface RolePool {
  readonly runtime: AgentRuntime;
  /** 有序候选集。只有上游失败才允许往后换。 */
  readonly candidates: readonly ExecutionProfile[];
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
   */
  | { kind: 'waiting'; reason: WaitReason; detail: string }
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
  '工作项、验收记录、升级问答——都在平台上，用 coagent_get_mission 读。' +
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
}): string {
  // 开局那一跳不用说这句：它本来就没有"上一跳"，讲一遍只会让人（和模型）
  // 以为前面发生过什么。
  const opening =
    view.planRevision === 0 &&
    view.workItems.length === 0 &&
    view.escalationLog.length === 0 &&
    !view.finalReview;
  const body = coordinatorBody(view);
  return opening ? body : [FRESH_SESSION_PREFIX, '', body].join('\n');
}

function coordinatorBody(view: {
  status: string;
  planRevision: number;
  finalReview?: { verdict: string; reasons: readonly string[] } | undefined;
  escalationLog: { question: string; answer?: string }[];
  workItems: { id: string; status: string }[];
  promotions?: readonly { triggerRule: string }[];
}): string {
  const answered = view.escalationLog.filter((item) => item.answer).at(-1);
  if (view.finalReview?.verdict === 'send_back') {
    const reasons = view.finalReview.reasons.map((reason) => `  - ${reason}`).join('\n');
    // 打回时最常见的浪费：为同一条意见另开新工作项。实测过一次——
    // 一条"注释里少写一句"的意见滚出了三个工作项、七跳、$2.31。
    // 所以这里要明确说「先改已有的」，并把已验收的 id 列出来降低门槛。
    const reusable = view.workItems.filter((item) => item.status === 'accepted');
    return [
      'L3 把这个 Mission 打回了，理由：',
      reasons,
      '',
      '先 coagent_get_mission 看当前状态，按这些理由重新规划。',
      '',
      '**优先修正已有的工作项，不要为同一条意见另开新的。**',
      reusable.length > 0
        ? `已验收的工作项：${reusable.map((item) => item.id).join('、')}。` +
          '要继续改它们就直接重新派发，把「这次要避开什么」写进工单正文。'
        : '',
      '只有当 L3 的意见确实指向一件此前没做过的**独立**工作时，才新建工作项。',
      '重新派发的工单必须与上一版有可见差异——逐字相同的工单不算数。',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (answered?.answer) {
    return [
      'L3 答复了你的升级。',
      `问题：${answered.question}`,
      `答复：${answered.answer}`,
      '',
      '先 coagent_get_mission 看当前状态，按这个答复继续。',
    ].join('\n');
  }
  const blocked = view.workItems.filter((item) => item.status === 'blocked');
  if (blocked.length > 0) {
    // 只提 blocked，**不提 retired**：作废掉的那些已经不用管了，而且现在也
    // 不再拦着交卷。早先两者同一个状态，这句话只好含糊地说"可能是执行者报的、
    // 也可能是 L3 作废的"，然后让协调者自己去猜该不该管。
    return (
      `执行者报了 ${blocked.length} 个工作项不成立（${blocked.map((i) => i.id).join('、')}）。` +
      '先 coagent_get_mission 看它们说了什么，然后二选一：' +
      '**确实还要做**就把工单改对再重新派发；' +
      '**已经不用做了**就 coagent_retire_work_item 作废掉并写清理由。' +
      '别把它晾在那儿——blocked 会一直拦着这条 Mission 交卷。'
    );
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
    return (
      origin +
      `平台唤醒你：${submitted.length} 个工作项交回了结果（${ids}）。` +
      '先 coagent_get_mission 看当前状态，然后**在这一轮里把它们全部验收完**。\n\n' +
      '验完之后如果还有下一批要做的，同样**一次派完**——' +
      'coagent_dispatch_work_item 的 workItemIds 是数组，互不依赖的放在同一次调用里。'
    );
  }
  if (view.planRevision > 0) {
    return '平台唤醒你。先 coagent_get_mission 看当前状态，然后决定下一步。';
  }
  return '开始这个 Mission。先 coagent_get_mission。';
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
  role: 'coordinator' | 'executor';
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
  #workspace: WorkspaceManager;
  #wallClockMs: number;
  readonly hops: HopRecord[] = [];
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
    this.#workspace = deps.workspace;
    this.#wallClockMs = deps.attemptWallClockMs ?? ATTEMPT_WALL_CLOCK_MS;
    this.#staleAcknowledged = deps.acceptStaleBase ?? false;
  }

  async runMission(missionId: string, options: RunMissionOptions): Promise<MissionRunOutcome> {
    const maxRounds = options.maxRounds ?? 12;

    // 一 Mission 一个隔离工作区。所有 agent 的 cwd 都指到这里，
    // 用户自己的 checkout 从头到尾没被碰过。
    // 平台上已经记着分叉基线，就照它来 —— 重跑靠这个和第一次从同一个版本
    // 起步。没有的话（正常的第一次）才用目标分支当前的 HEAD。
    const pinnedBase = (await this.#platform.getMissionView(missionId)).workspaceRef?.baseRevision;
    const prepared = await this.#workspace.prepare(missionId, options.projectRoot, pinnedBase);
    this.workspace = prepared;
    const cwd = prepared.cwd;
    // 落地时要拿分叉基线核对目标有没有动过，所以这里就记回平台。
    await this.#platform.recordWorkspace(missionId, {
      projectRoot: options.projectRoot,
      branch: prepared.branch,
      targetBranch: prepared.targetBranch,
      baseRevision: prepared.baseRevision,
    });

    // 又动起来了：先把上一轮的停机原因清掉。不清的话界面上会一直挂着
    // 旧原因，看起来像还卡在那儿。
    await this.#platform.setWaitReason(missionId, undefined);

    for (let round = 0; round < maxRounds; round += 1) {
      const view = await this.#platform.getMissionView(missionId);

      // 名额被别人占着时**不在这里停**。
      //
      // 一度想在开工前就拦下来，理由是"实测 P2 花掉 $0.70 调查完才被告知名额
      // 被占"。但那个前提是错的：**调查与规划的产出都写回平台了**（plan、
      // 工作项都在），重跑时协调者读得到，接着派发就行，钱没白花。
      //
      // 而在这里停会砍掉一个刻意的设计：**名额只有派发才需要**，调查和规划
      // 是纯读、不冲突，A 在改代码时 B 照样可以往前推。拿"省钱"去换掉流水线
      // 并行，是用一个不存在的问题换掉一个真的特性。用例当场拦住了这次改动。
      //
      // 真正缺的只是"谁挡着我"看不见 —— 那一格补在 MissionView 上（blockedByMission）。

      // 被暂停就不碰。放在循环开头而不是入口：跑到一半被暂停也要停下来。
      if (view.paused) {
        return { kind: 'waiting', reason: 'cancelled_by_user', detail: 'Mission 已被暂停，resume 之后重跑' };
      }

      // 协调者交卷了 —— 调度器这一程到此为止，剩下的归 L3。
      // **不要把 awaiting_review 当成完成**：改动还没落地。
      if (view.status === 'awaiting_review') {
        return view.result?.outcome === 'delivered'
          ? { kind: 'awaiting_l3_review' }
          : { kind: 'blocked', reason: view.result?.summary ?? '协调者交了 blocked' };
      }
      if (view.status === 'completed') return { kind: 'delivered' };
      if (view.status === 'blocked') {
        return { kind: 'blocked', reason: view.finalReview?.reasons.join('；') ?? '已 blocked' };
      }

      // 有未答复的升级 —— 停。协调者已经说过它没权限决定，再叫一次
      // 只会让它再升级一次。等 L3 答复（answerEscalation）之后再跑。
      if (view.openEscalations.length > 0) {
        return {
          kind: 'awaiting_l3',
          question: view.openEscalations[0].question,
        };
      }

      // 真要开始改代码之前，先看分叉基线还是不是目标分支的当前位置（S05.3 / S14.7）。
      //
      // 场景：Mission 排队等了一阵，期间别的改动落到了目标分支上。这时候
      // 照着旧基线干，做出来的东西合不回去（落地那道闸会拦），而**那时候
      // 已经花完钱了**。在派发之前发现，代价小得多。
      //
      // v1 不做语义 staleness 判定——只比版本号，不同就交回协调者让它自己
      // 重新核对。文档明确推迟了自动判断"这次改动受不受影响"。
      //
      // **重跑不适用这一条。** 重跑是把起点钉在源头那次的基线上，为的是两次
      // 可比；它按定义就处在"基线不等于目标分支当前位置"的状态。拿这条闸去拦
      // 它，等于用对的规则打错的场景：一钉基线就永远跑不起来。实测 P1-single
      // 派发后当场被停。
      //
      // 安全性质不受影响：落地那道闸照常核对基线，重跑想合回去仍然会被拦——
      // 而重跑本来也不该合，它是拿来读数的。
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

      // ---- High Assurance fail-closed (preflight; no round fact) ----
      // HA 路径尚未启用：显式 stalled，绝不按 Standard 主链降级执行。
      // 不记 orchestration.round.started、不创建 Attempt、不 dispatch。
      // HA 也不进入 budget 路径（保持 fail-closed 现状）。
      if (view.executionMode === 'high_assurance') {
        return {
          kind: 'stalled',
          reason: 'High Assurance 执行路径尚未启用，拒绝按 Standard 降级执行',
        };
      }

      // ---- Authoritative budget GATE-PRE (BUDGET-001-S5) ----
      // After HA, before orchestration.round.started / any hop.
      // Hard exceeded: LW promote+continue, Standard wait. Soft: events only.
      // Evaluated before heuristic pool/round/30m stalls so budget wins the label.
      {
        const gate = await this.#enforceAuthoritativeBudget(missionId);
        if (gate.kind === 'stop') return gate.outcome;
        if (gate.kind === 'continue') continue;
      }

      // Durable authoritative round-start fact (BUDGET-001-S2).
      // After preflight gates + budget PRE; before Lightweight / pending / Coordinator hop.
      // A successful append counts even if the subsequent hop crashes.
      // Append failure must not proceed with this round (error propagates).
      await this.#platform.recordOrchestrationRoundStarted(missionId);

      // ---- Lightweight Fast Lane ----
      // 公共 pause / awaiting_review / completed / blocked / escalation / stale-base / HA
      // 检查之后、Standard pending/coordinator 逻辑之前分流。
      // 绝不进入下面的「没有 pending → coordinator」路径。
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

      // 有已派发但还没交回结果的工作项，就先把它们跑完。
      //
      // **但只在 executing 阶段跑。** 退回 planning 意味着有人（L3 改了契约、
      // 或者 L2 自己）判定当前这批工单需要重新审视；这时候还去跑它们，
      // 就是明知要重做还先花一遍钱。让协调者先说话。
      const pending =
        view.status === 'executing'
          ? view.workItems.filter((item) => item.status === 'dispatched')
          : [];
      if (pending.length > 0) {
        for (const item of pending) {
          const hop = await this.#runHop({
            role: 'executor',
            missionId,
            workItemId: item.id,
            cwd,
            pool: this.#executor,
            instruction:
              '平台派给你一个工作项。先调用 coagent_get_work_order 读取工单，然后执行。',
          });
          if (!hop || 'exhausted' in hop) {
            const reason: WaitReason = hop?.exhausted ?? 'no_available_agent';
            const detail = hop?.detail ?? this.#stallDetail(reason, item.id);
            await this.#platform.setWaitReason(missionId, reason, detail);
            return { kind: 'waiting', reason, detail };
          }
          // GATE-POST after each successful hop (tokens/commands/wall accumulate here).
          const gate = await this.#enforceAuthoritativeBudget(missionId);
          if (gate.kind === 'stop') return gate.outcome;
          if (gate.kind === 'continue') break;
        }
        continue;
      }

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
        instruction: coordinatorInstruction(view),
      });
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
        return { kind: 'waiting', reason, detail };
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
   * Lightweight Fast Lane 一轮。
   *
   * 只走：唯一 Frozen WorkItem → Executor hop → Validator → submit-for-review。
   * 任何异常路径都 stalled / waiting，**绝不** Coordinator hop / Attempt / Plan。
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
          '平台派给你一个工作项。先调用 coagent_get_work_order 读取工单，然后执行。',
      });
      if (!hop || 'exhausted' in hop) {
        const reason: WaitReason = hop?.exhausted ?? 'no_available_agent';
        const detail = hop?.detail ?? this.#stallDetail(reason, item.id);
        await this.#platform.setWaitReason(missionId, reason, detail);
        return { kind: 'outcome', outcome: { kind: 'waiting', reason, detail } };
      }
      return { kind: 'continue' };
    }

    if (item.status === 'submitted') {
      const validated = await this.#platform.validateAndAcceptLightweightWorkItem({
        missionId,
        workItemId: item.id,
        cwd,
      });
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
      await this.#platform.submitLightweightMissionForReview(missionId);
      return { kind: 'outcome', outcome: { kind: 'awaiting_l3_review' } };
    }

    if (item.status === 'accepted') {
      // crash-recovery seam：validator 已 accept，直接交 L3 门口。
      await this.#platform.submitLightweightMissionForReview(missionId);
      return { kind: 'outcome', outcome: { kind: 'awaiting_l3_review' } };
    }

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

  /** 现在还能用的候选。全在冷却 = 没有可用 agent（S14.4）。 */
  #availableCandidates(pool: RolePool, now: number): ExecutionProfile[] {
    return pool.candidates.filter((profile) => (this.#cooldown.get(profile.profileId) ?? 0) <= now);
  }

  /** 候选的可用性快照，供界面显示"为什么停着"。 */
  candidateAvailability(): { profileId: string; availability: CandidateAvailability; until?: string }[] {
    const now = Date.now();
    const all = [...this.#coordinator.candidates, ...this.#executor.candidates];
    return all.map((profile) => {
      const until = this.#cooldown.get(profile.profileId) ?? 0;
      return until > now
        ? { profileId: profile.profileId, availability: 'cooldown' as const, until: new Date(until).toISOString() }
        : { profileId: profile.profileId, availability: 'available' as const };
    });
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
  }): Promise<
    | { endedBy: string; resumeRef?: string }
    /** detail 有值时用它，别再拼一句泛泛的盖掉。 */
    | { exhausted: WaitReason; detail?: string }
    | undefined
  > {
    const now = Date.now();
    const usable = this.#availableCandidates(input.pool, now);
    if (usable.length === 0) {
      // 全在冷却：这不是"实现错了"，是暂时没人干活。分开报，因为处置不同——
      // 前者要人看，后者等一会儿就好。
      return { exhausted: 'no_available_agent' };
    }

    const limit = input.pool.maxAttempts ?? 3;
    let used = 0;
    for (const profile of usable) {
      if (used >= limit) return { exhausted: 'attempt_limit_reached' };
      used += 1;
      // Attempt 起点。换候选之前要回到这里：下一个候选应该从干净的起点
      // 开始，而不是接手上一个改到一半的代码（S06.3）。
      const startRevision = await this.#workspace.head(input.cwd).catch(() => undefined);

      const { attemptId, token } =
        input.role === 'coordinator'
          ? await this.#tokens.startCoordinator(input.missionId, profile)
          : await this.#tokens.startExecutor(input.missionId, input.workItemId as string, profile);

      let outcome: Awaited<ReturnType<Awaited<ReturnType<AgentRuntime['start']>>['wait']>> | undefined;
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let wallClock: ReturnType<typeof setTimeout> | undefined;
      // 到点掐掉之后，close 事件回来的是一个普通的"进程被杀"失败。
      // 不记这个标志就没法把它和真的上游故障分开，而两者处置完全相反。
      let runaway = false;
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
      try {
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
        }, HEARTBEAT_MS);
        // 立刻先打一次：不打的话头一个间隔内它看起来就是"从没心跳过"，
        // 而没心跳一律算没人管。
        await this.#platform.beatAttempt(input.missionId, attemptId, this.#owner).catch(
          () => undefined,
        );
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
        // Flush durable command facts even when wait() throws after events were received.
        // Preserve the original runtime failure; do not let a secondary write error replace it.
        // If only the write fails, surface that so we never falsely claim authoritative coverage.
        let waitError: unknown;
        try {
          outcome = await run.wait();
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
        clearInterval(heartbeat);
        clearTimeout(wallClock);
        unsubscribe?.();
        // 收尾必须在 finally：运行时崩了而 attempt 没收尾，这个工作项就
        // 永远开不了下一次尝试。
        await this.#platform.finishAttempt(input.missionId, attemptId, {
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
        });
        // 收尾只裁当前 Mission/Attempt 的早期实时输出，保留尾部供事后排障。
        await this.#live.finish?.(input.missionId, attemptId).catch(() => undefined);
        this.#tokens.revoke(token);
      }

      // 和写回平台的那个值保持一致。两处分叉的话，库里记的和这里判的就是
      // 两件事，而排障的人会同时看到两者。
      const endedBy: AttemptEndReason = runaway ? 'killed_wall_clock' : outcome.endedBy;

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
      if (endedBy === 'upstream_failure' || endedBy === 'killed_idle') {
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
        continue; // 换下一个候选
      }
      return { endedBy, resumeRef: outcome.resumeRef };
    }
    return undefined;
  }
}
