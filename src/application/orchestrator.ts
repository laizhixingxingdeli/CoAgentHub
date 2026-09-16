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
import type { Platform } from './platform.ts';
import type { RunTokenIssuer } from './token-issuer.ts';
import type { WorkspaceManager } from './workspace.ts';
import { NoLiveOutput } from './live.ts';
import type { LiveOutput } from './live.ts';
import type { WaitReason } from '../kernel/index.ts';

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
  if (view.workItems.some((item) => item.status === 'blocked')) {
    return (
      '有工作项被标成了不成立（状态 blocked）——可能是执行者报的，也可能是 L3 作废的。' +
      '先 coagent_get_mission 看它说了什么：确实还要做就把工单改对再重新派发，' +
      '已经被新工单取代了就别管它，也不要为它另开一个。'
    );
  }
  const submitted = view.workItems.filter((item) => item.status === 'submitted');
  if (submitted.length > 0) {
    // 数量要说出来。只说"有结果交回来了"的话，验完第一个就交还控制权是完全
    // 合理的反应——而每交还一次就是一轮全新的协调者会话，把之前的上下文
    // 重放一遍。实测协调者轮次是整条 Mission 开销的主项（一条走到六轮的，
    // 协调者一个人占 74%），所以这一句必须把"这一轮要做完几件"钉死。
    const ids = submitted.map((item) => item.id).join('、');
    return (
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
  readonly hops: HopRecord[] = [];
  /** profileId → 冷却到期时间戳。S07.4 的 Availability，最小可用形态。 */
  readonly #cooldown = new Map<string, number>();
  /**
   * 基线过期只报一次。
   *
   * 不设这个标志的话，人重跑一次就又被同一条挡回来——而他重跑本身就
   * 表示"我知道了，继续"。报一次、说清楚，之后由人决定。
   */
  #staleAcknowledged = false;
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
  }

  async runMission(missionId: string, options: RunMissionOptions): Promise<MissionRunOutcome> {
    const maxRounds = options.maxRounds ?? 12;

    // 一 Mission 一个隔离工作区。所有 agent 的 cwd 都指到这里，
    // 用户自己的 checkout 从头到尾没被碰过。
    const prepared = await this.#workspace.prepare(missionId, options.projectRoot);
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
      if (view.workItems.some((item) => item.status === 'dispatched') && view.workspaceRef) {
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
            '先让协调者基于新基线重新核对（重开 worktree 或确认改动不受影响）。';
          await this.#platform.setWaitReason(missionId, 'base_revision_stale', detail);
          return { kind: 'waiting', reason: 'base_revision_stale', detail };
        }
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
            const detail = this.#stallDetail(reason, item.id);
            await this.#platform.setWaitReason(missionId, reason, detail);
            return { kind: 'waiting', reason, detail };
          }
        }
        continue;
      }

      // 没有在途工作项 —— 该协调者出场：规划、派发，或验收。
      const hop = await this.#runHop({
        role: 'coordinator',
        missionId,
        cwd,
        pool: this.#coordinator,
        // 句柄来自平台，不是局部变量：进程重启/打回重跑都续得上。
        resumeRef: view.coordinatorResumeRef,
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
        const detail = this.#stallDetail(reason);
        await this.#platform.setWaitReason(missionId, reason, detail);
        return { kind: 'waiting', reason, detail };
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
   * 最后一次失败的原文。
   *
   * 停下来时必须把它带出去：调度器把 runtime 抛的任何异常都归成
   * upstream_failure，如果只报一句"候选都失败了"，一个真正的程序错误
   * 会被伪装成配额问题，而且完全看不见。
   */
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
    if (reason === 'attempt_limit_reached') {
      return `${where}：尝试次数到上限了，不再往下换候选。最近一次失败：${this.#lastFailure()}。` +
        '继续换只会烧配额，不会产生新信息——先看看是不是工单本身有问题。';
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
  }): Promise<{ endedBy: string; resumeRef?: string } | { exhausted: WaitReason } | undefined> {
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
          if (event.kind === 'output') {
            void this.#live.append({ ...base, kind: 'text', text: event.text });
          } else if (event.kind === 'tool.started') {
            void this.#live.append({ ...base, kind: 'tool', text: event.name });
          } else if (event.kind === 'usage') {
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
        outcome = await run.wait();
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
        unsubscribe?.();
        // 收尾必须在 finally：运行时崩了而 attempt 没收尾，这个工作项就
        // 永远开不了下一次尝试。
        await this.#platform.finishAttempt(input.missionId, attemptId, {
          endedBy: outcome?.endedBy ?? 'no_structured_result',
          usage: outcome?.usage,
          failureMessage: outcome?.failureMessage,
          resumeRef: outcome?.resumeRef,
          output: outcome?.output,
          toolCalls: outcome?.toolCalls,
          resolvedProfile: outcome?.resolvedProfile,
        });
        // 最终输出已经落在 Attempt 上了，实时缓冲留着就是同一份数据存两遍。
        await this.#live.finish?.(attemptId).catch(() => undefined);
        this.#tokens.revoke(token);
      }

      this.hops.push({
        role: input.role,
        workItemId: input.workItemId,
        attemptId,
        profile,
        endedBy: outcome.endedBy,
        failureMessage: outcome.failureMessage,
      });

      if (outcome.endedBy === 'platform_unreachable') {
        // **不冷却候选**：问题在平台自己这边。直接停下来喊人——
        // 继续换候选只会把整个池子白白冻掉。
        await this.#platform
          .setWaitReason(input.missionId, 'platform_unreachable')
          .catch(() => undefined);
        return { exhausted: 'platform_unreachable' };
      }

      if (outcome.endedBy === 'upstream_failure') {
        // 这个候选先放一会儿，别下一跳又撞上同一个限流。
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
      return { endedBy: outcome.endedBy, resumeRef: outcome.resumeRef };
    }
    return undefined;
  }
}
