/**
 * W-479 / COM3-B2b AC3：L1 `run.wait()` 期间的同 writer 有界 impact 监督。
 *
 * 本单替代退休 W-478（其替代退休 W-473），保留其留下的半成品实现
 * （impact-supervisor.ts 与 orchestrator.ts / platform.ts / change-impact.ts 的
 * 接线），把验收落在**这两条组合测试**上。生产代码只有测试暴露缺口时才动。
 *
 *  1. 执行者的 wait 还没落定期间，唯一地开出一条限权 impact coordinator hop：
 *     L2 经专属工具把判断持久保存下来；普通 coordinator 占位时第二条变更保留
 *     pending（互斥，不抢占）；执行者 wait 释放后**先 join 在飞 impact、安全收尾
 *     （Attempt 终态 + 牌吊销），再进入普通验收**——全程不出现两名并行协调者。
 *     外加「不监督」对照：不传配置 = 零监督；平台未装配 / 牌口缺
 *     startImpactCoordinator = unsupported，执行者仍能结束。
 *  2. 容量挡住时保留 pending（不无 claim 启动、写 project_busy），释放后可再领；
 *     同一 impact 槽失败后进 retry_wait、恢复重领同一行（不新 cycle、不重复
 *     ChangeImpact）；目标 attempt / 代次已变的变更不下发；租约失效后专属提交
 *     拒写零副作用，失租 helper 只关旧 Attempt、不写判断。
 *
 * 全程 ScriptedRuntime + 临时目录 File 三仓储（与 change-impact-issuer.test.ts
 * 同构：同一 FileStateStore 上 FileChangeRequestRepository / FileChangeImpactRepository /
 * FileQueuedHopRepository + 真实 makeIssuer + createApi）+ 固定时钟。
 * 不启动真实模型、不起常驻服务、不读凭据；生产入口（main.ts / mission-runner /
 * run-mission）不接线，这里只用 Orchestrator 的显式 opt-in 依赖。
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import type { AgentRun, AgentRuntime, ActivityEvent } from '../src/application/ports.ts';
import { FixedClock, SequentialIds } from '../src/application/in-memory.ts';
import {
  FileActivityLog,
  FileDeliveryRepository,
  FileProjectRepository,
  FileQueuedHopRepository,
  FileStateStore,
} from '../src/application/file-store.ts';
import { FileChangeRequestRepository } from '../src/application/change-request-repository.ts';
import { FileChangeImpactRepository } from '../src/application/change-impact-repository.ts';
import type { ChangeRequest } from '../src/application/change-request.ts';
import {
  hopCapacityLimits,
  type HopCapacityLimits,
  type QueuedHop,
} from '../src/application/durable-scheduler.ts';
import { Orchestrator } from '../src/application/orchestrator.ts';
import { Platform, PlatformRuleError, type QueueClaimIdentity } from '../src/application/platform.ts';
import {
  impactSupervisionInstruction,
  impactSupervisionSettings,
  impactSupervisionSupported,
  inertImpactSupervisionSession,
  type ImpactCapabilityProbe,
} from '../src/application/impact-supervisor.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { createApi } from '../src/api/server.ts';
import { makeIssuer } from '../src/main.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

const NOW = '2026-01-01T00:00:00.000Z';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿', 'foo 返回 1'],
  constraints: [],
  nonGoals: [],
  guardrails: ['不得改 Contract'],
};

const ORDER: WorkOrder = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
};

const PLAN = {
  findings: 'foo 一直返回 0',
  rootCause: '初始值写错了',
  rejectedHypotheses: ['不是调用方传错'],
  decisions: ['直接改初始值'],
  direction: '改 src/foo.ts',
  risks: [],
};

/** 与 change-impact-issuer.test.ts 的 IMPACT_BODY 同形：四业务字段，不含身份。 */
const IMPACT_BODY = {
  decision: 'compatible',
  workOrderDiff: '把 step 2 换成 step 2b',
  affectedAcceptance: [1],
  reason: 'step 2b 仍可执行',
};

/* ==================== 通用小工具 ==================== */

const dirs: string[] = [];
const servers: Server[] = [];

after(async () => {
  for (const server of servers) await closeServer(server);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function closeServer(server: Server): Promise<void> {
  const at = servers.indexOf(server);
  if (at >= 0) servers.splice(at, 1);
  await new Promise<void>((resolve, reject) => {
    server.close((error) =>
      error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
        ? reject(error)
        : resolve(),
    );
  });
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`等不到：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function endedFor(events: readonly ActivityEvent[], attemptId: string): boolean {
  return events.some((event) => event.kind === 'attempt.ended' && event.attemptId === attemptId);
}

function impactStartedEvents(events: readonly ActivityEvent[]): ActivityEvent[] {
  return events.filter(
    (event) =>
      event.kind === 'attempt.started' &&
      (event.data as Record<string, unknown> | undefined)?.purpose === 'impact',
  );
}

function queueRow(
  id: string,
  overrides: Partial<QueuedHop> & Pick<QueuedHop, 'role'>,
): QueuedHop {
  return {
    projectId: 'P',
    missionId: 'M',
    workItemId: '-',
    priority: 0,
    availableAt: NOW,
    attemptCount: 0,
    maxAttempts: 3,
    idempotencyKey: `manual-${id}`,
    status: 'queued',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
    id,
  };
}

function changeRequest(
  changeId: string,
  missionId: string,
  target: { attemptId: string; claimGeneration: number },
): ChangeRequest {
  return {
    changeId,
    missionId,
    reviewer: 'L3',
    reason: 'L3 确认要改',
    confirmedChange: '改 < 为 <=',
    workItemId: 'W-1',
    attemptId: target.attemptId,
    baseSnapshotHash: `hash-${changeId}`,
    createdAt: NOW,
    sourceContractRevision: 1,
    claimGeneration: target.claimGeneration,
  };
}

async function postJson(
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> & { error?: string } }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { 'x-coagent-run': token }),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/* ==================== 同构 File 装配（与 issuer 测试一致） ==================== */

interface Assembly {
  dir: string;
  statePath: string;
  store: FileStateStore;
  clock: FixedClock;
  activity: FileActivityLog;
  hops: FileQueuedHopRepository;
  requests: FileChangeRequestRepository;
  impacts: FileChangeImpactRepository;
  platform: Platform;
  registry: RunTokenRegistry;
  issuer: ReturnType<typeof makeIssuer>;
  baseUrl: string;
  server: Server;
  close(): Promise<void>;
}

async function assemble(opts: { assembleChangeImpact?: boolean } = {}): Promise<Assembly> {
  const assembleChangeImpact = opts.assembleChangeImpact ?? true;
  const dir = mkdtempSync(join(tmpdir(), 'orch-impact-'));
  dirs.push(dir);
  const statePath = join(dir, 'state.json');
  const store = new FileStateStore(statePath);
  const clock = new FixedClock(NOW);
  const ids = new SequentialIds();
  const activity = new FileActivityLog(store, clock);
  const deliveries = new FileDeliveryRepository(store, clock, ids);
  const hops = new FileQueuedHopRepository(store);
  const requests = new FileChangeRequestRepository(store);
  const impacts = new FileChangeImpactRepository(store);
  const platform = new Platform({
    projects: new FileProjectRepository(store),
    deliveries,
    workspace: new InPlaceWorkspaceManager(),
    activity,
    clock,
    ids,
    transaction: store,
    queuedHops: hops,
    ...(assembleChangeImpact ? { changeRequests: requests, changeImpacts: impacts } : {}),
  });
  const registry = new RunTokenRegistry();
  const issuer = makeIssuer(platform, registry);
  const server = createApi({ platform, tokens: registry, deliveries });
  await listenLoopback(server, 0);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);
  return {
    dir,
    statePath,
    store,
    clock,
    activity,
    hops,
    requests,
    impacts,
    platform,
    registry,
    issuer,
    baseUrl,
    server,
    close: async () => {
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
      const at = dirs.indexOf(dir);
      if (at >= 0) dirs.splice(at, 1);
    },
  };
}

/* ==================== 脚本（键语义与 ScriptedRuntime 一致） ==================== */

const PLAN_STEPS: ScriptTable['x'] = {
  steps: [
    { tool: 'coagent_get_mission', body: {} },
    { tool: 'coagent_update_plan', body: PLAN },
    { tool: 'coagent_create_work_item', body: { title: '修 foo', ...ORDER } },
    { tool: 'coagent_submit_contract_check', body: { verdict: 'ok', summary: '测试契约已核对' } },
    {
      tool: 'coagent_dispatch_work_item',
      body: (previous) => ({ workItemIds: [previous.workItemId] }),
    },
  ],
};

const REVIEW_STEPS: ScriptTable['x'] = {
  steps: [
    { tool: 'coagent_get_mission', body: {} },
    {
      tool:
        'coagent_review_execution_result',
      body: {
        workItemId: 'W-1',
        verdict: 'accept',
        acceptanceResults: ORDER.acceptance.map((criterion) => ({
          criterion,
          status: 'pass' as const,
          evidence: '测试替身：逐条核过',
        })),
        reasons: ['自己复跑过 node --test，退出码 0'],
        requiredChanges: [],
      },
    },
    {
      tool: 'coagent_submit_mission_result',
      body: {
        outcome: 'delivered',
        summary: '改好了并验证过',
        acceptanceEvidence: ['node --test 退出码 0'],
        memoryDelta: [],
        openRisks: [],
      },
    },
  ],
};

const EXEC_STEPS: ScriptTable['x'] = {
  steps: [
    { tool: 'coagent_get_work_order', body: {} },
    {
      tool: 'coagent_submit_evidence',
      body: { kind: 'test', summary: 'node --test 全绿', command: 'node --test', exitCode: 0 },
    },
    {
      tool: 'coagent_submit_execution_result',
      body: (previous) => ({
        outcome: 'completed',
        summary: '改了初始值',
        changedFiles: ['src/foo.ts'],
        evidenceIds: [previous.evidenceId],
        notes: '无',
      }),
    },
  ],
};

/** impact 跳：读绑定请求（身份来自牌），再提交四个业务字段。 */
const IMPACT_STEPS: ScriptTable['x'] = {
  steps: [
    { tool: 'coagent_get_change_request', body: {} },
    { tool: 'coagent_submit_change_impact', body: IMPACT_BODY },
  ],
};

function coordinatorScripts(failureOnFirstImpact = false): ScriptTable {
  const table: ScriptTable = {
    'coordinator:-:0': PLAN_STEPS,
    'coordinator:-:1': REVIEW_STEPS,
    'coordinator:W-1:0': IMPACT_STEPS,
    'coordinator:W-1:1': IMPACT_STEPS,
  };
  if (failureOnFirstImpact) table['coordinator:W-1:0'] = { upstreamFailure: 'impact 第一跳上游抽风（夹具）' };
  return table;
}

const EXECUTOR_SCRIPT: ScriptTable = { 'executor:W-1': EXEC_STEPS };

/* ==================== 带门闩的运行时包装 ==================== */

interface ExecutorCtl {
  attemptId: string;
  token: string;
  gate: Deferred;
  waitCalls: number;
  waitReturned: boolean;
}

/**
 * 执行者 wait 的可释放门闩：start() 照常跑脚本（HTTP 步骤真的落平台），
 * wait() 先等测试侧 Promise，再转 inner.wait()。
 * 不用 hangs+abort——那会变成 killed，走不到普通验收。
 */
function gatedExecutor(inner: ScriptedRuntime, ctl: ExecutorCtl): AgentRuntime {
  return {
    kind: inner.kind,
    start: async (spec) => {
      const run = await inner.start(spec);
      if (spec.role !== 'executor') return run;
      ctl.attemptId = spec.attemptId;
      ctl.token = spec.endpoint.token;
      return {
        resumeRef: run.resumeRef,
        on: (handler) => run.on(handler),
        abort: (reason) => run.abort(reason),
        wait: () => {
          ctl.waitCalls += 1;
          return ctl.gate.promise
            .then(() => run.wait())
            .then((outcome) => {
              ctl.waitReturned = true;
              return outcome;
            });
        },
      };
    },
  };
}

function plainGatedExecutor(inner: ScriptedRuntime): { runtime: AgentRuntime; ctl: ExecutorCtl } {
  const ctl: ExecutorCtl = {
    attemptId: '',
    token: '',
    gate: deferred(),
    waitCalls: 0,
    waitReturned: false,
  };
  return { runtime: gatedExecutor(inner, ctl), ctl };
}

interface ImpactStartRecord {
  attemptId: string;
  token: string;
  workItemId: string | undefined;
  changeId: string | undefined;
  claimId: string | undefined;
}

interface ReviewSnapshot {
  /** 普通验收开跑时：最后一条 impact Attempt 是否已终态。 */
  lastImpactEnded: boolean;
  /** 普通验收开跑时：最后一条 impact 牌是否已吊销。 */
  lastImpactTokenLive: boolean;
  /** 普通验收开跑时：执行者 Attempt 是否已终态。 */
  executorEnded: boolean;
}

interface CoordinatorCtl {
  impacts: ImpactStartRecord[];
  /** 在飞的 impact hop 数（wait 未落定的）。 */
  inFlight: number;
  /** 第二跳 impact 的 hold 门闩（组合 1 用它证明 join 顺序）。 */
  holdSecondGate: Deferred;
  reviewSnapshot: ReviewSnapshot | undefined;
  normalStarts: number;
}

function watchingCoordinator(
  inner: ScriptedRuntime,
  assembly: Assembly,
  ctl: CoordinatorCtl,
  missionId: string,
  executorCtl: ExecutorCtl,
  opts: { holdSecondImpact: boolean; snapshotAtReview: boolean },
): AgentRuntime {
  return {
    kind: inner.kind,
    start: async (spec) => {
      const run = await inner.start(spec);
      if (spec.role === 'coordinator' && spec.workItemId !== undefined) {
        const index = ctl.impacts.length;
        const frozen = assembly.registry.resolve(spec.endpoint.token);
        ctl.impacts.push({
          attemptId: spec.attemptId,
          token: spec.endpoint.token,
          workItemId: spec.workItemId,
          changeId: frozen?.changeId,
          claimId: frozen?.claim?.id,
        });
        ctl.inFlight += 1;
        const hold = opts.holdSecondImpact && index === 1;
        return {
          resumeRef: run.resumeRef,
          on: (handler) => run.on(handler),
          abort: (reason) => run.abort(reason),
          wait: async () => {
            const outcome = await run.wait();
            if (hold) await ctl.holdSecondGate.promise;
            ctl.inFlight -= 1;
            return outcome;
          },
        };
      }
      if (spec.role === 'coordinator') {
        const normalIndex = ctl.normalStarts;
        ctl.normalStarts += 1;
        if (opts.snapshotAtReview && normalIndex === 1) {
          // 普通验收开跑的那一刻：收尾必须已经全部落定。
          const events = await assembly.activity.list(missionId);
          const lastImpact = ctl.impacts[ctl.impacts.length - 1];
          ctl.reviewSnapshot = {
            lastImpactEnded: lastImpact !== undefined && endedFor(events, lastImpact.attemptId),
            lastImpactTokenLive:
              lastImpact !== undefined && assembly.registry.resolve(lastImpact.token) !== undefined,
            executorEnded: endedFor(events, executorCtl.attemptId),
          };
        }
        return run;
      }
      return run;
    },
  };
}

function newCoordinatorCtl(): CoordinatorCtl {
  return {
    impacts: [],
    inFlight: 0,
    holdSecondGate: deferred(),
    reviewSnapshot: undefined,
    normalStarts: 0,
  };
}

/** 从队列现读当前执行者活领取的代次；不写死假代次。 */
async function liveExecutorGeneration(
  hops: FileQueuedHopRepository,
  missionId: string,
): Promise<number> {
  const rows = await hops.list();
  const row = rows.find(
    (item) => item.role === 'executor' && item.missionId === missionId && item.status === 'claimed',
  );
  assert.ok(row, '执行者 hop 必须已被领取');
  assert.ok(row.claimGeneration !== undefined, '执行者 hop 必须带领取代次');
  return row.claimGeneration;
}

async function impactRowsOf(assembly: Assembly): Promise<QueuedHop[]> {
  return (await assembly.hops.list()).filter((row) => row.purpose === 'impact');
}

function impactOrchestrator(
  assembly: Assembly,
  coordinator: AgentRuntime,
  executor: AgentRuntime,
  extra: {
    impactSupervision?: unknown;
    tokens?: unknown;
    hopCapacityLimits?: HopCapacityLimits;
    coordinatorCooldownMs?: number;
  } = {},
): Orchestrator {
  return new Orchestrator({
    platform: assembly.platform,
    tokens: (extra.tokens ?? assembly.issuer) as never,
    baseUrl: assembly.baseUrl,
    workspace: new InPlaceWorkspaceManager(),
    coordinator: {
      runtime: coordinator,
      candidates: [{ endpoint: 'local', profileId: 'coordinator-a' }],
      cooldownMs: extra.coordinatorCooldownMs,
    },
    executor: {
      runtime: executor,
      candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
    },
    queuedHops: assembly.hops,
    hopClock: assembly.clock,
    hopCapacityLimits: extra.hopCapacityLimits,
    impactSupervision: extra.impactSupervision as never,
    owner: 'impact-runner',
  });
}

/* ==================== 组合 1 ==================== */

test('组合 1：执行者 wait 未落定期间唯一开 impact 判断、普通占用互斥、先 join 再收尾再普通验收；不监督对照零影响', async () => {
  const mission = 'M-impact';

  /* ---------- 主流程 ---------- */
  const s = await assemble();
  await s.platform.createMission({ projectId: 'P-impact', missionId: mission, contract: CONTRACT });
  const executorInner = new ScriptedRuntime(EXECUTOR_SCRIPT);
  const coordinatorInner = new ScriptedRuntime(coordinatorScripts());
  const exec = { attemptId: '', token: '', gate: deferred(), waitCalls: 0, waitReturned: false };
  const coordCtl = newCoordinatorCtl();
  const orch = impactOrchestrator(
    s,
    watchingCoordinator(coordinatorInner, s, coordCtl, mission, exec, {
      holdSecondImpact: true,
      snapshotAtReview: true,
    }),
    gatedExecutor(executorInner, exec),
    { impactSupervision: { enabled: true, pollIntervalMs: 20, maxChecks: 300 } },
  );
  const runPromise = orch.runMission(mission, { projectRoot: s.dir, maxRounds: 6 });

  await waitFor(() => exec.attemptId !== '', '执行者 hop 启动');
  const executorGen = await liveExecutorGeneration(s.hops, mission);
  const orderBefore = (await s.platform.getMissionView(mission)).workItems[0]?.order;
  assert.ok(orderBefore, '冻结工单应可见');

  // 执行者 wait 未落定期间追加已确认 ChangeRequest —— 监督应开唯一 impact hop。
  await s.requests.append(changeRequest('CR-1', mission, { attemptId: exec.attemptId, claimGeneration: executorGen }));
  await waitFor(
    () => orch.impactObservations.some((o) => o.kind === 'dispatched' && o.changeId === 'CR-1'),
    '监督下发 CR-1 的 impact hop',
  );

  // 牌是限权牌：purpose / changeId / 目标工作项由发牌钉死。
  const first = coordCtl.impacts[0]!;
  assert.equal(first.workItemId, 'W-1');
  assert.equal(first.changeId, 'CR-1');
  assert.ok(first.claimId, 'impact 牌必须带队列领取身份');

  // HTTP 专属工具确实把判断持久下来了（一条，绑定 impact Attempt）。
  const decided1 = await s.impacts.listByMission(mission);
  assert.equal(decided1.length, 1);
  assert.equal(decided1[0]!.changeId, 'CR-1');
  assert.equal(decided1[0]!.coordinatorAttemptId, first.attemptId);
  assert.equal(decided1[0]!.attemptId, exec.attemptId, '判断绑定的是当前执行 Attempt');
  assert.equal(decided1[0]!.claimGeneration, executorGen);
  const transcript = coordinatorInner.transcript.filter((row) => row.key.startsWith('coordinator:W-1:'));
  assert.deepEqual(
    transcript.map((row) => [row.tool, row.status]),
    [
      ['coagent_get_change_request', 200],
      ['coagent_submit_change_impact', 200],
    ],
    'impact 跳应走真实 HTTP 且两步都成功',
  );
  assert.ok(
    coordinatorInner.instructions.some((text) => text.includes('CR-1') && text.includes('coagent_submit_change_impact')),
    '唤醒语要点名这条变更和专属提交工具',
  );

  // —— 互斥：人为占用普通 coordinator in_progress 时，第二条变更保留 pending ——
  const occupier = await s.platform.startCoordinatorAttempt(mission);
  await s.requests.append(
    changeRequest('CR-2', mission, { attemptId: exec.attemptId, claimGeneration: executorGen }),
  );
  await sleep(150); // ≥5 个 poll（20ms 间隔）
  assert.equal(
    orch.impactObservations.filter((o) => o.changeId === 'CR-2').length,
    0,
    '普通 coordinator 占位期间不得对 CR-2 下发任何东西',
  );
  assert.equal(orch.impactObservations.filter((o) => o.kind === 'dispatched').length, 1, '占位期间唯一 dispatched 仍是 CR-1');
  assert.equal((await impactRowsOf(s)).filter((row) => row.changeId === 'CR-2').length, 0, 'CR-2 不得入队开跳');
  assert.equal((await s.impacts.listByMission(mission)).length, 1, 'CR-2 保留 pending，无判断落库');
  const viewDuringMutex = await s.platform.getMissionView(mission);
  assert.equal(viewDuringMutex.waitReason, undefined, '静默互斥不该写假等待原因');

  // 释放占位 → 下一条 poll 应下发 CR-2 的 impact hop（它会被门闩留在在飞状态）。
  await s.platform.finishAttempt(mission, occupier.attemptId, { endedBy: 'structured_submit' });
  await waitFor(() => coordCtl.impacts.length === 2, 'CR-2 的 impact hop 启动');
  const second = coordCtl.impacts[1]!;
  assert.equal(second.changeId, 'CR-2', '第二条判断绑另一条变更');
  assert.notEqual(second.attemptId, first.attemptId);

  // —— 释放执行者 wait：join 在飞 impact 必须**先于**执行者自己的收尾 ——
  exec.gate.resolve();
  await waitFor(() => exec.waitReturned, '执行者 wait 落定');
  const midEvents = await s.activity.list(mission);
  assert.ok(!endedFor(midEvents, second.attemptId), 'CR-2 impact hop 在飞：未收尾前不得结束它');
  assert.ok(!endedFor(midEvents, exec.attemptId), 'join 未完成前执行者 Attempt 必须还开着');
  assert.ok(s.registry.resolve(second.token) !== undefined, '在飞 impact 的牌此刻仍有效');
  const cr2Row = (await impactRowsOf(s)).find((row) => row.changeId === 'CR-2');
  assert.equal(cr2Row?.status, 'claimed', 'impact 跳必须由真实 claim 启动');

  coordCtl.holdSecondGate.resolve();
  const outcome = await runPromise;
  assert.equal(outcome.kind, 'awaiting_l3_review', '执行者交卷后应进入普通验收并交卷');

  // join 顺序的直接证据：普通验收开跑那一刻，impact 已终态、牌已吊销、执行者已收尾。
  const snapshot = coordCtl.reviewSnapshot;
  assert.ok(snapshot, '普通验收跳应被观测');
  assert.equal(snapshot!.executorEnded, true, 'finally 里 join 之后才 finishAttempt');
  assert.equal(snapshot!.lastImpactEnded, true, '在飞 impact 先跑完并收尾');
  assert.equal(snapshot!.lastImpactTokenLive, false, 'finally 必吊销 impact 牌');

  // wait 语义：执行者只被 wait 一次；全程无第二份 wait。
  assert.equal(exec.waitCalls, 1, 'run.wait() 只准调一次');

  // 监督观察：只有 started + 两条 dispatched，没有假原因 / 拒读 / 抛死。
  const kinds = orch.impactObservations.map((o) => o.kind);
  assert.equal(kinds.filter((k) => k === 'started').length, 1);
  assert.equal(kinds.filter((k) => k === 'dispatched').length, 2);
  assert.equal(orch.impactObservations.filter((o) => o.kind === 'dispatched' && o.changeId === 'CR-1').length, 1, '已决定不重复下发');
  for (const absent of ['pending', 'stale', 'blocked', 'hop-refused', 'list-refused', 'unsupported']) {
    assert.ok(!kinds.includes(absent as never), `不该出现 ${absent} 观察`);
  }

  // 队列：两条变更各自一个独立槽，都已完成；不共用普通 coordinator 槽。
  const impactRows = (await impactRowsOf(s)).sort((a, b) => a.changeId!.localeCompare(b.changeId!));
  assert.deepEqual(impactRows.map((row) => [row.changeId, row.status]), [
    ['CR-1', 'completed'],
    ['CR-2', 'completed'],
  ]);

  // 冻结工单不变；判断不冒充动作。
  const view = await s.platform.getMissionView(mission);
  assert.deepEqual(JSON.parse(JSON.stringify(view.workItems[0]?.order)), JSON.parse(JSON.stringify(orderBefore)), 'impact 判断不得改动冻结工单');
  const events = await s.activity.list(mission);
  assert.equal(events.filter((e) => e.kind === 'change.impact_decided').length, 2, '每条决定一个事件');
  for (const event of events) {
    assert.doesNotMatch(event.kind, /applied|consumed|verified/, '事件里不得出现「已应用/已消费/已验证」');
  }
  const disk = JSON.parse(readFileSync(s.statePath, 'utf8')) as { changeImpacts: Record<string, unknown>[] };
  assert.equal(disk.changeImpacts.length, 2);
  for (const record of disk.changeImpacts) {
    for (const banned of ['applied', 'consumed', 'verified', 'diff']) {
      assert.equal(banned in record, false, `判断记录不得携带「${banned}」`);
    }
    assert.equal(record.decision, 'compatible');
  }
  // 牌都收干净了。
  assert.equal(s.registry.resolve(exec.token), undefined, '执行者牌在 finally 里吊销');
  assert.equal(s.registry.resolve(first.token), undefined);
  assert.equal(s.registry.resolve(second.token), undefined);
  // 执行者跳与两条 impact 跳都记进了 hop 账。
  assert.equal(orch.hops.filter((h) => h.role === 'coordinator' && h.workItemId === 'W-1').length, 2);
  assert.equal(orch.hops.filter((h) => h.role === 'executor').length, 1);
  await s.close();

  /* ---------- 对照 A：同 fixture 不传 impactSupervision = 零监督 ---------- */
  {
    const s2 = await assemble();
    await s2.platform.createMission({ projectId: 'P-impact2', missionId: mission, contract: CONTRACT });
    const coordinatorInner2 = new ScriptedRuntime(coordinatorScripts());
    const gated = plainGatedExecutor(new ScriptedRuntime(EXECUTOR_SCRIPT));
    const orch2 = impactOrchestrator(s2, coordinatorInner2, gated.runtime, {});
    const runP2 = orch2.runMission(mission, { projectRoot: s2.dir, maxRounds: 6 });
    await waitFor(() => gated.ctl.attemptId !== '', '对照 A 执行者启动');
    const gen2 = await liveExecutorGeneration(s2.hops, mission);
    await s2.requests.append(
      changeRequest('CR-x', mission, { attemptId: gated.ctl.attemptId, claimGeneration: gen2 }),
    );
    await sleep(150);
    gated.ctl.gate.resolve();
    const outcome2 = await runP2;
    assert.equal(outcome2.kind, 'awaiting_l3_review', '默认关闭时行为与现网一致');
    assert.equal(orch2.impactObservations.length, 0, '零监督观察');
    assert.equal((await impactRowsOf(s2)).length, 0, '零 impact 槽');
    assert.equal(impactStartedEvents(await s2.activity.list(mission)).length, 0, '零 impact Attempt');
    assert.equal((await s2.impacts.listByMission(mission)).length, 0, '变更保留 pending，无人判断');
    assert.equal(gated.ctl.waitCalls, 1);
    await s2.close();
  }

  /* ---------- 对照 B：enabled 但 Platform 未装配 changeRequests/changeImpacts ---------- */
  {
    const s3 = await assemble({ assembleChangeImpact: false });
    assert.equal(s3.platform.supportsChangeImpact(), false);
    await s3.platform.createMission({ projectId: 'P-impact3', missionId: mission, contract: CONTRACT });
    const coordinatorInner3 = new ScriptedRuntime(coordinatorScripts());
    const gated3 = plainGatedExecutor(new ScriptedRuntime(EXECUTOR_SCRIPT));
    const orch3 = impactOrchestrator(s3, coordinatorInner3, gated3.runtime, {
      impactSupervision: { enabled: true, pollIntervalMs: 20, maxChecks: 100 },
    });
    const runP3 = orch3.runMission(mission, { projectRoot: s3.dir, maxRounds: 6 });
    await waitFor(() => gated3.ctl.attemptId !== '', '对照 B 执行者启动');
    await waitFor(
      () => orch3.impactObservations.some((o) => o.kind === 'unsupported'),
      'unsupported 观察',
    );
    gated3.ctl.gate.resolve();
    const outcome3 = await runP3;
    assert.equal(outcome3.kind, 'awaiting_l3_review', '未装配整段不启动，执行者仍能结束');
    assert.equal(orch3.impactObservations.filter((o) => o.kind === 'unsupported').length, 1);
    assert.equal(orch3.impactObservations.filter((o) => o.kind === 'dispatched').length, 0, '不回退成任何跳');
    assert.equal((await impactRowsOf(s3)).length, 0);
    assert.equal(impactStartedEvents(await s3.activity.list(mission)).length, 0);
    // 规划+执行+验收三条，零 impact（impactStartedEvents===0 已在上行断言，没有借道发出来的牌）。
    assert.equal(
      (await s3.activity.list(mission)).filter((e) => e.kind === 'attempt.started').length,
      3,
    );
    await s3.close();
  }

  /* ---------- 对照 C：牌口缺 startImpactCoordinator ---------- */
  {
    const s4 = await assemble();
    await s4.platform.createMission({ projectId: 'P-impact4', missionId: mission, contract: CONTRACT });
    const fullIssuer = s4.issuer;
    const strippedIssuer = {
      startCoordinator: fullIssuer.startCoordinator.bind(fullIssuer),
      startExecutor: fullIssuer.startExecutor.bind(fullIssuer),
      revoke: fullIssuer.revoke.bind(fullIssuer),
    };
    const coordinatorInner4 = new ScriptedRuntime(coordinatorScripts());
    const gated4 = plainGatedExecutor(new ScriptedRuntime(EXECUTOR_SCRIPT));
    const orch4 = impactOrchestrator(s4, coordinatorInner4, gated4.runtime, {
      impactSupervision: { enabled: true, pollIntervalMs: 20, maxChecks: 100 },
      tokens: strippedIssuer,
    });
    const runP4 = orch4.runMission(mission, { projectRoot: s4.dir, maxRounds: 6 });
    await waitFor(() => gated4.ctl.attemptId !== '', '对照 C 执行者启动');
    const gen4 = await liveExecutorGeneration(s4.hops, mission);
    await s4.requests.append(
      changeRequest('CR-y', mission, { attemptId: gated4.ctl.attemptId, claimGeneration: gen4 }),
    );
    await waitFor(
      () => orch4.impactObservations.some((o) => o.kind === 'unsupported'),
      '缺牌口也要有 unsupported 观察',
    );
    gated4.ctl.gate.resolve();
    const outcome4 = await runP4;
    assert.equal(outcome4.kind, 'awaiting_l3_review', '缺 startImpactCoordinator 不抛死执行者 hop');
    assert.equal(orch4.impactObservations.filter((o) => o.kind === 'dispatched').length, 0);
    assert.equal((await impactRowsOf(s4)).length, 0, '缺牌口不得退化成普通 coordinator 槽');
    await s4.close();
  }
});

/* ==================== 组合 2 ==================== */

test('组合 2：容量保留 pending、失败 retry_wait 同槽恢复、旧目标不下发、租约失效只可信收尾；构造期非法值当场抛', async () => {
  /* ---------- 先跑纯接缝：默认关闭 / 非法值构造抛 / 能力探测 / 唤醒语 ---------- */
  assert.equal(impactSupervisionSettings(undefined), undefined, '省略配置 = 关闭');
  assert.throws(() => impactSupervisionSettings(null), /object/);
  assert.throws(() => impactSupervisionSettings('x'), /object/);
  assert.throws(
    () => impactSupervisionSettings({ enabled: false, pollIntervalMs: 20, maxChecks: 8 }),
    /literal true/,
  );
  assert.throws(
    () => impactSupervisionSettings({ enabled: true, pollIntervalMs: 0, maxChecks: 8 }),
    /positive safe integer/,
  );
  assert.throws(
    () => impactSupervisionSettings({ enabled: true, pollIntervalMs: 20, maxChecks: 1.5 }),
    /positive safe integer/,
  );
  assert.throws(
    () => impactSupervisionSettings({ enabled: true, pollIntervalMs: 20 }),
    /positive safe integer/,
  );
  const settingsBase = {
    platform: {} as Platform,
    tokens: {
      startCoordinator: async () => ({ attemptId: 'a', token: 't' }),
      startExecutor: async () => ({ attemptId: 'a', token: 't' }),
      revoke() {},
    },
    baseUrl: 'http://127.0.0.1:9',
    workspace: new InPlaceWorkspaceManager(),
    coordinator: { runtime: new ScriptedRuntime({}), candidates: [{ endpoint: 'local' as const, profileId: 'c' }] },
    executor: { runtime: new ScriptedRuntime({}), candidates: [{ endpoint: 'local' as const, profileId: 'e' }] },
  };
  assert.doesNotThrow(() => new Orchestrator({ ...settingsBase }));
  assert.doesNotThrow(
    () =>
      new Orchestrator({
        ...settingsBase,
        impactSupervision: { enabled: true, pollIntervalMs: 20, maxChecks: 8 },
      }),
  );
  assert.throws(
    () =>
      new Orchestrator({
        ...settingsBase,
        impactSupervision: { enabled: false, pollIntervalMs: 20, maxChecks: 8 } as never,
      }),
    /literal true/,
  );

  const okProbe: ImpactCapabilityProbe = {
    settingsPresent: true,
    issuerSupports: true,
    platformSupports: true,
    capacityClaimSupported: true,
    executorClaimPresent: true,
    workItemPresent: true,
  };
  assert.equal(impactSupervisionSupported(okProbe), true);
  for (const leg of [
    'settingsPresent',
    'issuerSupports',
    'platformSupports',
    'capacityClaimSupported',
    'executorClaimPresent',
    'workItemPresent',
  ] as const) {
    assert.equal(
      impactSupervisionSupported({ ...okProbe, [leg]: false }),
      false,
      `缺 ${leg} 必须按 unsupported 处理`,
    );
  }
  assert.equal(inertImpactSupervisionSession.started, false);
  const instruction = impactSupervisionInstruction(
    changeRequest('CR-instr', 'M-x', { attemptId: 'a-1', claimGeneration: 1 }),
  );
  assert.match(instruction, /CR-instr/);
  assert.match(instruction, /coagent_get_change_request/);
  assert.match(instruction, /coagent_submit_change_impact/);

  /* ---------- 编排器组合：容量 pending → 释放 → 首跳失败 → 同槽恢复 ---------- */
  const mission = 'M-cap';
  const s = await assemble();
  await s.platform.createMission({ projectId: 'P-cap', missionId: mission, contract: CONTRACT });
  const executorInner = new ScriptedRuntime(EXECUTOR_SCRIPT);
  const coordinatorInner = new ScriptedRuntime(coordinatorScripts(true));
  const exec = { attemptId: '', token: '', gate: deferred(), waitCalls: 0, waitReturned: false };
  const coordCtl = newCoordinatorCtl();
  const orch = impactOrchestrator(
    s,
    watchingCoordinator(coordinatorInner, s, coordCtl, mission, exec, {
      holdSecondImpact: false,
      snapshotAtReview: false,
    }),
    gatedExecutor(executorInner, exec),
    {
      impactSupervision: { enabled: true, pollIntervalMs: 20, maxChecks: 400 },
      hopCapacityLimits: hopCapacityLimits({ global: 8, project: 8, role: 8, runtime: 8, profile: 1 }),
      coordinatorCooldownMs: 0,
    },
  );
  const runPromise = orch.runMission(mission, { projectRoot: s.dir, maxRounds: 6 });
  await waitFor(() => exec.attemptId !== '', '执行者 hop 启动');
  const executorGen = await liveExecutorGeneration(s.hops, mission);

  // 占满 coordinator-a 的 profile 名额（别的 Mission/Project，不挡执行者自己）。
  await s.hops.enqueue(
    queueRow('H-occ', {
      projectId: 'P-other',
      missionId: 'M-other',
      role: 'coordinator',
      runtimeKind: 'scripted',
      profileId: 'coordinator-a',
    }),
  );
  const occClaimed = await s.hops.claim(
    'H-occ',
    'holder',
    NOW,
    new Date(Date.parse(NOW) + 30 * 60 * 1000).toISOString(),
  );
  assert.ok(occClaimed, '占位行应能领取');

  // 旧目标的变更：attempt 已换 / 代次已变 —— 不得下发。
  await s.requests.append(
    changeRequest('CR-old-attempt', mission, { attemptId: 'attempt-of-a-dead-run', claimGeneration: executorGen }),
  );
  await s.requests.append(
    changeRequest('CR-old-gen', mission, { attemptId: exec.attemptId, claimGeneration: executorGen + 42 }),
  );
  // 当前这一代的目标。
  await s.requests.append(
    changeRequest('CR-1', mission, { attemptId: exec.attemptId, claimGeneration: executorGen }),
  );

  // —— 容量挡住：保留 pending、写 project_busy、**不无 claim 启动** ——
  await waitFor(
    () => orch.impactObservations.some((o) => o.kind === 'pending'),
    '容量挡住时的 pending 观察',
  );
  const viewDuringCapacity = await s.platform.getMissionView(mission);
  assert.equal(viewDuringCapacity.waitReason, 'project_busy', '容量等待只准用既有 WaitReason');
  const pendingRows = await impactRowsOf(s);
  assert.equal(pendingRows.length, 1, 'CR-1 只有一个逻辑槽；旧目标的变更不入队');
  assert.equal(pendingRows[0]!.changeId, 'CR-1');
  assert.equal(pendingRows[0]!.status, 'queued', '被容量挡住时不得带 claim 启动');
  assert.equal(pendingRows[0]!.owner, undefined);
  assert.equal(impactStartedEvents(await s.activity.list(mission)).length, 0, '没领到 claim 就不开 Attempt');
  assert.equal((await s.impacts.listByMission(mission)).length, 0);

  // —— 释放占位 → 下一拍领到 claim 并启动第一跳（脚本上游失败）——
  await s.hops.complete('H-occ', 'holder', occClaimed?.claimGeneration ?? 1, NOW);
  await waitFor(() => coordCtl.impacts.length === 1, '第一跳 impact 领取并启动');
  // 失败进 retry_wait：同一行、attemptCount 1、带 lastFailure。
  let failedRow: QueuedHop | undefined;
  const failStarted = Date.now();
  for (;;) {
    failedRow = (await impactRowsOf(s)).find((row) => row.status === 'retry_wait');
    if (failedRow) break;
    if (Date.now() - failStarted > 15_000) throw new Error('等不到 impact 槽进 retry_wait');
    await sleep(5);
  }
  assert.equal(failedRow!.attemptCount, 1);
  assert.equal(failedRow!.lastFailure?.attemptId, coordCtl.impacts[0]!.attemptId);
  assert.equal((await s.impacts.listByMission(mission)).length, 0, '失败的那跳没交出判断');

  // 退避没到：监督继续 pending —— 时钟推进后才重领**同一行**。
  const pendingCountBefore = orch.impactObservations.filter((o) => o.kind === 'pending').length;
  assert.ok(pendingCountBefore >= 2, '退避期间保留 pending');
  s.clock.advance(1_500);
  await waitFor(
    () => orch.impactObservations.some((o) => o.kind === 'dispatched' && o.changeId === 'CR-1'),
    'retry_wait 之后同槽恢复并交出判断',
  );
  const viewAfterDecided = await s.platform.getMissionView(mission);
  assert.equal(viewAfterDecided.waitReason, undefined, '恢复后清掉的只能是监督自己写的原因');
  assert.equal(coordCtl.impacts.length, 2, '恢复 = 同一槽第二次尝试，不是另开一个逻辑 hop');
  assert.equal((await impactRowsOf(s)).length, 1, '不新 cycle：CR-1 始终只有一行');
  const recovered = (await impactRowsOf(s))[0]!;
  assert.ok(recovered.idempotencyKey.includes(':n0'), '行仍属 cycle 0');
  assert.equal(recovered.claimGeneration, 2, '重领换代');
  assert.equal(recovered.lastFailure?.attemptId, coordCtl.impacts[0]!.attemptId, '第一次失败留在原行上');
  const decided = await s.impacts.listByMission(mission);
  assert.equal(decided.length, 1, '已决定不重复：两次尝试只有一条 ChangeImpact');
  assert.equal(decided[0]!.coordinatorAttemptId, coordCtl.impacts[1]!.attemptId);
  assert.equal(decided[0]!.attemptId, exec.attemptId);
  assert.equal(decided[0]!.claimGeneration, executorGen);
  assert.equal(
    orch.impactObservations.filter((o) => o.changeId === 'CR-old-attempt' || o.changeId === 'CR-old-gen').length,
    0,
    '目标 attempt/代次已变的变更连出现在观察里都不该有',
  );

  // 交回执行者：正常收尾、验收、交卷。
  exec.gate.resolve();
  const outcome = await runPromise;
  assert.equal(outcome.kind, 'awaiting_l3_review');
  assert.equal(exec.waitCalls, 1, '同一跳只 wait 一次（retry 在监督侧，不动执行者的 wait）');
  const doneRow = (await impactRowsOf(s))[0]!;
  assert.equal(doneRow.status, 'completed');
  assert.equal(
    orch.hops.filter((h) => h.role === 'coordinator' && h.workItemId === 'W-1').length,
    2,
    '账上有两跳：失败的一跳与恢复的一跳',
  );
  await s.close();

  /* ---------- 租约失效：专属提交拒写零副作用；失租 helper 只关旧 Attempt ---------- */
  const s2 = await assemble();
  const lostMission = 'M-lost';
  await s2.platform.createMission({ projectId: 'P-lost', missionId: lostMission, contract: CONTRACT });
  const coord = await s2.platform.startCoordinatorAttempt(lostMission);
  await s2.platform.updatePlan(lostMission, coord.attemptId, PLAN);
  await s2.platform.submitContractCheck(lostMission, coord.attemptId, {
    verdict: 'ok',
    summary: '四条都核过',
  });
  const { workItemId } = await s2.platform.createWorkItem(lostMission, coord.attemptId, {
    title: 'W1',
    order: ORDER,
  });
  await s2.platform.dispatchWorkItems(lostMission, coord.attemptId, [workItemId]);
  const claim = async (
    id: string,
    role: 'executor' | 'coordinator',
    leaseMs: number,
    extra?: Partial<QueuedHop>,
  ): Promise<QueueClaimIdentity> => {
    await s2.hops.enqueue(queueRow(id, { missionId: lostMission, workItemId, role, ...extra }));
    const taken = await s2.hops.claim(
      id,
      `owner-${id}`,
      s2.clock.now().toISOString(),
      new Date(s2.clock.now().getTime() + leaseMs).toISOString(),
    );
    assert.ok(taken, `${id} 应能领到`);
    return { id, owner: `owner-${id}`, claimGeneration: taken.claimGeneration ?? 1 };
  };
  const executorClaim = await claim('H-lost-exec', 'executor', 60_000);
  const execAttempt = await s2.platform.startExecutorAttempt(
    lostMission,
    workItemId,
    undefined,
    executorClaim,
  );
  await s2.platform.finishAttempt(lostMission, coord.attemptId, { endedBy: 'structured_submit' });
  // 第二条普通 coordinator 也开着：失租收尾只准关 impact Attempt，不许碰它。
  const plainRunning = await s2.platform.startCoordinatorAttempt(lostMission);
  await s2.requests.append(
    changeRequest('CR-lost', lostMission, {
      attemptId: execAttempt.attemptId,
      claimGeneration: executorClaim.claimGeneration,
    }),
  );
  const impactClaim = await claim('H-lost-impact', 'coordinator', 60_000, {
    purpose: 'impact',
    changeId: 'CR-lost',
  });
  const issued = await s2.issuer.startImpactCoordinator(lostMission, 'CR-lost', undefined, impactClaim);

  // 推进时钟让 impact（与目标执行者）租约失效。
  s2.clock.advance(120_000);
  const bytesBefore = readFileSync(s2.statePath, 'utf8');
  const rejectedPost = await postJson(
    s2.baseUrl,
    '/api/agent/coagent_submit_change_impact',
    { ...IMPACT_BODY },
    issued.token,
  );
  assert.equal(rejectedPost.status, 409, JSON.stringify(rejectedPost.json));
  assert.equal(rejectedPost.json.error, 'CLAIM_FENCE_REJECTED');
  const rejectedGet = await postJson(s2.baseUrl, '/api/agent/coagent_get_change_request', {}, issued.token);
  assert.equal(rejectedGet.status, 409);
  assert.equal(rejectedGet.json.error, 'CLAIM_FENCE_REJECTED');
  assert.equal(readFileSync(s2.statePath, 'utf8'), bytesBefore, '失租后的专属读写必须零副作用');
  await assert.rejects(
    () =>
      s2.platform.finishAttempt(
        lostMission,
        issued.attemptId,
        { endedBy: 'upstream_failure', failureMessage: '失租' },
        impactClaim,
      ),
    (error: unknown) => error instanceof PlatformRuleError && error.code === 'CLAIM_FENCE_REJECTED',
    '带旧 claim 的正常收尾必须被围栏拒 —— 这正是编排器走 helper 的触发条件',
  );
  // 可信失租收尾：身份全部从 started 事件读回，只关这一条 impact Attempt。
  await s2.platform.finishLostImpactAttempt(lostMission, issued.attemptId, {
    endedBy: 'upstream_failure',
    failureMessage: '租约失效的可信收尾',
  });
  const lostEvents = await s2.activity.list(lostMission);
  assert.equal(
    lostEvents.filter((e) => e.kind === 'attempt.ended' && e.attemptId === issued.attemptId).length,
    1,
  );
  assert.ok(!endedFor(lostEvents, execAttempt.attemptId), '执行者 Attempt 不受影响');
  assert.ok(
    !endedFor(lostEvents, plainRunning.attemptId),
    'helper 只关点名的旧 impact Attempt，不关别的在跑 coordinator',
  );
  assert.equal((await s2.impacts.listByMission(lostMission)).length, 0, '失租收尾不写 ChangeImpact');
  assert.equal((await s2.requests.get('CR-lost'))?.changeId, 'CR-lost', '请求事实原样保留');
  // 重复收尾幂等：不再多一条 ended 事件。
  await s2.platform.finishLostImpactAttempt(lostMission, issued.attemptId, {
    endedBy: 'upstream_failure',
  });
  assert.equal(
    (await s2.activity.list(lostMission)).filter(
      (e) => e.kind === 'attempt.ended' && e.attemptId === issued.attemptId,
    ).length,
    1,
  );
  // 没带 impact 关联的 Attempt 不许走这条路径。
  await assert.rejects(
    () => s2.platform.finishLostImpactAttempt(lostMission, plainRunning.attemptId, { endedBy: 'upstream_failure' }),
    (error: unknown) => error instanceof PlatformRuleError && error.code === 'WRONG_ROLE',
  );
  // 旧执行者租约下的只读接缝同样被拒 —— 监督据此停轮询而不是继续撞。
  await assert.rejects(
    () =>
      s2.platform.listPendingChangeRequests(
        lostMission,
        workItemId,
        execAttempt.attemptId,
        executorClaim,
      ),
    (error: unknown) => error instanceof PlatformRuleError && error.code === 'CLAIM_FENCE_REJECTED',
  );
  s2.issuer.revoke(issued.token);
  assert.equal(s2.registry.resolve(issued.token), undefined, 'finally 必吊销：迟到调用必须被拒');
  await s2.close();
});
