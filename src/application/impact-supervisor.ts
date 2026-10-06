/**
 * 运行期影响判断监督（COM3-B2b / AC3）—— 默认关闭的 opt-in 接线。
 *
 * 它只做一件事：**执行者那一跳还没结束（`run.wait()` 还没落定）的时候**，把 L3
 * 已确认的变更交给一条限权的 impact coordinator hop，让 L2 把「这条变更对这个
 * 工单意味着什么」判断出来并持久保存。它不投递给执行者、不应用差异、不取消重派，
 * 也不启用任何生产闭环。
 *
 * 为什么要单独一个模块：这段逻辑要挂进**别人的 wait**。留在 orchestrator 里写，
 * 最自然的漂移就是顺手再写一套 `try/finally` 去等运行时 —— 于是同一跳出现两条
 * wait：谁拿到 outcome、谁负责 flush 持久化、谁负责收尾，全都变成两份。所以
 * 轮询、停止、join 全部收在这里；调用方只做三件薄接线：
 *   1. `const waitPromise = run.wait()`（仍然只调一次 wait）；
 *   2. `beginImpactSupervision({ waitPromise, … })`；
 *   3. finally **一开始** `await session.stopAndJoin()`。
 *
 * 纪律（每条都有对应的不存在性）：
 *   - **默认关闭**：省略配置 = 零监督、零 hop，行为与现网一致。生产入口
 *     （main.ts / mission-runner）不接线、不读 env。
 *   - **唯一 hook**：只在 wait 未落定期间问平台；wait 一落定就停止新启动。
 *   - **有界**：最多 maxChecks 次、每次间隔 pollIntervalMs，串行调用。
 *     没有上限的轮询会在执行者跑飞时一起跑飞。
 *   - **只读接缝**：监督自己**不**判断、**不**写状态，只问
 *     `Platform.listPendingChangeRequests`；判断由那张 impact 牌经专属工具写回。
 *   - **附加能力不是主链路**：监督里的任何失败都不许把执行者那一跳变成失败。
 *     失败最多让这条变更继续 pending —— 它本来就是「还没判断」，不是「判断错了」。
 *   - 不 import kernel 写状态，不直接碰 FileStateStore，零第三方依赖。
 */

import type { ChangeRequest } from './change-request.ts';

/** 显式 opt-in 的监督配置。`enabled` 只接受字面 true：false 不是「关掉」而是写错了。 */
export interface ImpactSupervisionSettings {
  readonly enabled: true;
  readonly pollIntervalMs: number;
  readonly maxChecks: number;
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

/**
 * 构造时归一化，坏值当场抛。
 *
 * 为什么不能拖到第一跳：非法的 pollIntervalMs（0 / NaN / 字符串）会让轮询变成
 * 忙等或立刻空转，而那时候执行者已经在跑、Attempt 已经开着 —— 坏配置的表现
 * 是「这一跳莫名其妙慢/多了几条 hop」，没有人会怀疑到构造参数上。
 */
export function impactSupervisionSettings(
  value: unknown,
): ImpactSupervisionSettings | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('impactSupervision must be an object with enabled, pollIntervalMs and maxChecks');
  }
  const record = value as Record<string, unknown>;
  if (record.enabled !== true) {
    throw new Error('impactSupervision.enabled must be the literal true (omit the field to stay off)');
  }
  const pollIntervalMs = positiveSafeInteger(record.pollIntervalMs, 'impactSupervision.pollIntervalMs');
  const maxChecks = positiveSafeInteger(record.maxChecks, 'impactSupervision.maxChecks');
  return Object.freeze({ enabled: true as const, pollIntervalMs, maxChecks });
}

/**
 * 能力齐不齐：不齐就**整段不启动**，而不是退化成普通 coordinator。
 *
 * 每一项都对应一种「看起来支持其实不支持」：
 *   - 牌口没有 startImpactCoordinator → 只能发普通牌，而普通牌没有 changeId 绑定；
 *   - Platform 没装配变更仓储 / fence 事务 → 专属动作全部 CHANGE_IMPACT_UNSUPPORTED；
 *   - 队列仓储没有 claimAvailable → 走不了五维容量，impact 会绕过公平；
 *   - 执行者这一跳没有可信 claim → 监督连「我是哪一代执行」都说不清。
 * 缺任一项就不监督：宁可少做一次判断，也不要一条不受容量与租约约束的 hop。
 */
export interface ImpactCapabilityProbe {
  readonly settingsPresent: boolean;
  readonly issuerSupports: boolean;
  readonly platformSupports: boolean;
  readonly capacityClaimSupported: boolean;
  readonly executorClaimPresent: boolean;
  readonly workItemPresent: boolean;
}

export function impactSupervisionSupported(probe: ImpactCapabilityProbe): boolean {
  return (
    probe.settingsPresent &&
    probe.issuerSupports &&
    probe.platformSupports &&
    probe.capacityClaimSupported &&
    probe.executorClaimPresent &&
    probe.workItemPresent
  );
}

/** 一跳 impact 的处置。监督据此决定是继续问、等着，还是不再下发。 */
export type ImpactHopDisposition =
  /** 这一跳确实跑完了（判断有没有落回仓储由仓储说了算，这里不自述）。 */
  | { readonly kind: 'ran' }
  /** 容量或退避占着：变更保留 pending，下一拍再试。**不无 claim 启动**。 */
  | { readonly kind: 'pending'; readonly detail: string }
  /** 目标（契约/工单）变了：这一代不用再下发。 */
  | { readonly kind: 'stale'; readonly detail: string }
  /** 别的停机原因（候选耗尽 / 暂停 / 平台不可达）：保留 pending，等下一拍。 */
  | { readonly kind: 'blocked'; readonly detail: string };

/** 一次监督动作的可追溯记录（给排障看，不参与任何判断）。 */
export interface ImpactSupervisionObservation {
  readonly kind:
    | 'started'
    | 'dispatched'
    | 'pending'
    | 'stale'
    | 'blocked'
    | 'hop-refused'
    | 'list-refused'
    | 'settled'
    | 'unsupported';
  readonly changeId?: string;
  readonly detail: string;
}

/** 等待原因只能用已有的那几种（kernel WaitReason），这里不发明新词。 */
export type ImpactWaitReason = 'project_busy' | 'target_changed';

export interface ImpactSupervisionRequest {
  /** 执行者那一跳的 wait：只调用一次，由调用方 await。 */
  readonly waitPromise: Promise<unknown>;
  readonly settings: ImpactSupervisionSettings;
  readonly missionId: string;
  readonly workItemId: string;
  readonly executorAttemptId: string;
  /** 执行者这一跳的可信队列领取身份。 */
  readonly executorClaimGeneration: number;
  readonly supported: boolean;
  /** 只读接缝：本代执行还没判断过的已确认变更。 */
  readonly listPending: () => Promise<readonly ChangeRequest[]>;
  /** 下发一跳 impact（串行、由调用方实现真正的 hop 逻辑）。 */
  readonly runImpactHop: (change: ChangeRequest) => Promise<ImpactHopDisposition>;
  /** 保留 pending 时写等待原因；只用已有 WaitReason（detail 留在观察记录里）。 */
  readonly setWaitReason: (reason: ImpactWaitReason | undefined, detail?: string) => Promise<void>;
  readonly observe: (entry: ImpactSupervisionObservation) => void;
}

export interface ImpactSupervisionSession {
  /** 这一跳是否真的起了监督轮询。 */
  readonly started: boolean;
  /**
   * 停轮询 + join 在飞的 impact hop。
   *
   * **必须在调用方的 finally 一开始就 await**：执行者已进入终态流程后还不收尾，
   * 留下的就是一条没有主人的 in_progress impact coordinator。join 不 abort ——
   * 在飞的 wait 会跑完它自己那一跳，这里只等它结束。
   */
  stopAndJoin(): Promise<void>;
}

/** 没启用 / 能力缺位时用这一份：stopAndJoin 是 no-op，调用方无需分支。 */
export const inertImpactSupervisionSession: ImpactSupervisionSession = Object.freeze({
  started: false,
  stopAndJoin: async () => undefined,
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 这条变更还是不是「当前这一代执行」的目标。
 *
 * 平台的只读接缝已经按 (workItem, attempt, generation) 过滤过；这里再对一次是
 * 因为轮询与下发之间隔着一次 hop —— 那一瞬间换代的话，拿旧目标去开新 Attempt
 * 就等于给已经不存在的执行出结论。
 */
function stillCurrentTarget(request: ImpactSupervisionRequest, change: ChangeRequest): boolean {
  return (
    change.missionId === request.missionId &&
    change.workItemId === request.workItemId &&
    change.attemptId === request.executorAttemptId &&
    change.claimGeneration === request.executorClaimGeneration
  );
}

/**
 * 挂上监督。
 *
 * 返回的 session 一定可以安全 `stopAndJoin()`：unsupported 时它是 no-op，
 * 启动后出错时它只等循环退出，不抛。
 */
export function beginImpactSupervision(request: ImpactSupervisionRequest): ImpactSupervisionSession {
  // 先把 wait 的落点记下来。这一行同时是给 waitPromise 挂的一个 rejection 处理器：
  // 监督拿着的是**同一份** promise（不是第二次 wait()），不挂处理器就会出现
  // 「调用方已经在 await，但监督那条链上没人处理拒绝」的 unhandledRejection。
  // 调用方自己的 await 照样看得到原错误 —— 这里只把它当「已经结束了」。
  let settled = false;
  void request.waitPromise.then(
    () => { settled = true; },
    () => { settled = true; },
  );

  if (!request.supported) {
    request.observe({ kind: 'unsupported', detail: '当前装配不支持影响判断监督，本跳不启动。' });
    return inertImpactSupervisionSession;
  }

  let stopped = false;
  let wake: (() => void) | undefined;
  const stop = (): void => {
    stopped = true;
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  /** 可被 stop 立刻打断的间隔等待：join 不该陪着轮询干等一整拍。 */
  const nap = async (ms: number): Promise<boolean> => {
    if (settled || stopped) return false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    return !settled && !stopped;
  };

  const loop = (async (): Promise<void> => {
    request.observe({ kind: 'started', detail: `监督轮询启动（最多 ${request.settings.maxChecks} 次）。` });
    // 只清除**监督自己写过**的等待原因：主流程写的（预算、候选冷却）不由这里接管。
    // 不清的话，一次容量挡住的影响判断会在执行者交卷后还挂着 project_busy，
    // 而 runMission 认的就是这个字符串 —— 于是「验收完了」被写成「同项目挤着」。
    let waitReasonWritten = false;
    for (let check = 0; check < request.settings.maxChecks; check += 1) {
      if (settled || stopped) break;
      if (!(await nap(request.settings.pollIntervalMs))) break;
      // wait 已落定 / 已被 stop：绝不再开新的 impact。
      if (settled || stopped) break;
      let pending: readonly ChangeRequest[];
      try {
        pending = await request.listPending();
      } catch (error) {
        // 读不动就停：这条接缝本身就是按执行者租约围栏的，它拒了说明这一代的
        // 领取身份已经不算数，继续问只会反复撞拒绝。
        request.observe({ kind: 'list-refused', detail: errorMessage(error) });
        return;
      }
      if (settled || stopped) break;
      if (pending.length === 0) continue;
      // 至多处理一条变更：一次只开一条限权判断，第二条等下一拍。
      const change = pending.find((row) => stillCurrentTarget(request, row));
      if (!change) {
        request.observe({ kind: 'stale', detail: '返回的变更已不是当前目标，不下发。' });
        continue;
      }
      let disposition: ImpactHopDisposition;
      try {
        disposition = await request.runImpactHop(change);
      } catch (error) {
        // 监督不许把执行者那一跳弄失败：这一跳没开成就当 pending。
        request.observe({ kind: 'hop-refused', changeId: change.changeId, detail: errorMessage(error) });
        continue;
      }
      if (disposition.kind === 'pending') {
        await request.setWaitReason('project_busy', disposition.detail).catch(() => undefined);
        waitReasonWritten = true;
        request.observe({ kind: 'pending', changeId: change.changeId, detail: disposition.detail });
        continue;
      }
      if (disposition.kind === 'blocked') {
        request.observe({ kind: 'blocked', changeId: change.changeId, detail: disposition.detail });
        continue;
      }
      if (disposition.kind === 'stale') {
        await request.setWaitReason('target_changed', disposition.detail).catch(() => undefined);
        waitReasonWritten = true;
        request.observe({ kind: 'stale', changeId: change.changeId, detail: disposition.detail });
        continue;
      }
      if (waitReasonWritten) {
        waitReasonWritten = false;
        await request.setWaitReason(undefined, '影响判断已能继续，清掉监督写下的等待原因。').catch(() => undefined);
      }
      request.observe({ kind: 'dispatched', changeId: change.changeId, detail: 'impact hop 已结束。' });
    }
    if (!settled && !stopped) {
      request.observe({ kind: 'blocked', detail: `已到 maxChecks=${request.settings.maxChecks} 上限，停止轮询。` });
    }
  })();

  // 循环自己不该抛（里面全有 catch），这里再兜一层：监督不是主链路。
  void loop.catch(() => undefined);

  return {
    started: true,
    stopAndJoin: async () => {
      stop();
      await loop;
    },
  };
}

/**
 * 监督用的唤醒语：一条 impact hop 该做什么。
 *
 * 身份不进文本：changeId / 目标工单 / 代次都由那张牌钉死，平台从仓储读回。
 * 写在提示里只会让 agent「照抄一句自我声明」，而自我声明不是权限。
 */
export function impactSupervisionInstruction(change: ChangeRequest): string {
  return [
    '平台在执行者还没交回结果的时候，检测到一条 L3 已确认的变更，需要你判断它对这个工作项的影响。',
    '',
    `本次要判断的变更 id：${change.changeId}`,
    '',
    '你**只**做影响判断，不做别的：',
    '1. 先 coagent_get_change_request 读这条已确认变更（请求体留空，身份来自你这张牌）。',
    '2. 再 coagent_submit_change_impact 提交四个业务字段：decision / workOrderDiff / affectedAcceptance / reason。',
    '',
    '不得改冻结工单、不得重派或取消执行者、不得声称改动已应用或已验证。',
    '判断只被持久保存；执行应用是另一条链路的事。',
  ].join('\n');
}
