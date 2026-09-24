/**
 * C4：任意写边界崩溃，重开后等于某条命令结束时的样子（设计 §8.1 完成条件）。
 *
 * 做法：一份确定性脚本覆盖平台绝大多数改状态命令（每一步恰好一条平台命令）。参考运行记下每一步
 * 结束时的持久化内容；然后对脚本里的第 k 次记事件（k 取遍全部）各跑两遍：在那一次 append 之前抛错、
 * 以及那一次 append 做完之后抛错（事件已经交给存储了——没包事务的 PG 命令此时事件已进库、快照还没写），
 * 脚本停在抛错的那条命令，重开存储——持久化内容必须恰好等于参考运行里「上一条命令结束时」。
 *
 * 哪条命令忘了包事务，它的中间状态就会被落下来，与任何一个检查点都对不上。
 * 文件版比对整份状态文件；PG 版（真库、独立库）比对快照、事件、投递。
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

import { FixedClock } from '../src/application/in-memory.ts';
import {
  FileActivityLog,
  FileDeliveryRepository,
  FileProjectRepository,
  FileStateStore,
  FileValidationReportRepository,
  PersistentIds,
} from '../src/application/file-store.ts';
import {
  PgActivityLog,
  PgDeliveryRepository,
  PgIds,
  PgProjectRepository,
  PgStateStore,
  PgValidationReportRepository,
} from '../src/application/pg-store.ts';
import type { ActivityLog, CommandTransaction, IdGenerator, ProjectRepository } from '../src/application/ports.ts';
import type { DeliveryRepository } from '../src/application/delivery.ts';
import type { ValidationReportRepository } from '../src/application/validation/report-repository.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { ValidationEngine } from '../src/application/validation/engine.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import { ensureTestDatabase } from './helpers/pg.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};
const origin = { clientType: 'cli', conversationRef: 'me' };
const PLAN = {
  findings: 'foo 返回 0',
  rejectedHypotheses: [] as string[],
  decisions: ['改初始值'],
  direction: '改 src/foo.ts',
  risks: [] as string[],
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
const LW_ORDER = (fail = false): WorkOrder => ({
  ...ORDER,
  validation: { commands: [{ argv: ['node', fail ? '--fail' : '--test'], timeoutMs: 5000 }] },
});
const FACTS = {
  mutationSideEffect: true,
  readOnlyProven: false,
  highAssurance: {
    productionDeployRelease: false,
    externalPaidOp: false,
    destructiveData: false,
    credentialsPermissionsSecurity: false,
    schemaPublicApiPersistenceCompat: false,
    unrecoverableExternalSideEffect: false,
  },
  standardFloor: {
    publicInterface: false,
    buildSystemOrDependency: false,
    multipleDomainModules: false,
    acceptanceNotCheckableUpfront: false,
    rootCauseOrCompetingDesigns: false,
  },
};
const ASSESSMENT = {
  goalUncertainty: 0,
  changeScope: 0,
  operationalRisk: 0,
  verificationDifficulty: 0,
  coordinationNeed: 0,
  recoveryDifficulty: 0,
  reasons: ['a', 'b', 'c', 'd', 'e', 'f'],
  decidedBy: 'coordinator',
  assessedAt: '2026-09-24T00:00:00.000Z',
};

type Ctx = Record<string, string>;
interface Step {
  readonly name: string;
  run(platform: Platform, ctx: Ctx, projects: ProjectRepository): Promise<void>;
}

const result = (summary: string) => ({
  outcome: 'delivered' as const,
  summary,
  acceptanceEvidence: ['e'],
  memoryDelta: [],
  openRisks: [],
});

/** 每一步恰好一条平台命令。 */
const SCRIPT: Step[] = [
  // ---- Standard 主链 ----
  { name: 'createMission M1', run: async (p) => void (await p.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT, origin })) },
  { name: 'startCoordinatorAttempt a1', run: async (p, c) => void (c.a1 = (await p.startCoordinatorAttempt('M1')).attemptId) },
  { name: 'updateFindings', run: async (p, c) => void (await p.updateFindings('M1', c.a1!, '发现一', ['不是 A'])) },
  { name: 'updatePlan', run: async (p, c) => void (await p.updatePlan('M1', c.a1!, PLAN)) },
  { name: 'createWorkItem w1', run: async (p, c) => void (c.w1 = (await p.createWorkItem('M1', c.a1!, { title: 'w1', order: ORDER })).workItemId) },
  { name: 'createWorkItem w2', run: async (p, c) => void (c.w2 = (await p.createWorkItem('M1', c.a1!, { title: 'w2', order: ORDER })).workItemId) },
  { name: 'dispatchWorkItems', run: async (p, c) => void (await p.dispatchWorkItems('M1', c.a1!, [c.w1!, c.w2!])) },
  { name: 'finishAttempt a1', run: async (p, c) => void (await p.finishAttempt('M1', c.a1!, { endedBy: 'structured_submit' })) },
  { name: 'recordWorkspace M1', run: async (p) => void (await p.recordWorkspace('M1', { projectRoot: '/proj', branch: 'mission/M1', baseRevision: 'base' })) },
  { name: 'recordOrchestrationRoundStarted', run: async (p) => void (await p.recordOrchestrationRoundStarted('M1')) },
  { name: 'startExecutorAttempt e1', run: async (p, c) => void (c.e1 = (await p.startExecutorAttempt('M1', c.w1!)).attemptId) },
  { name: 'beatAttempt e1', run: async (p, c) => void (await p.beatAttempt('M1', c.e1!, 'runner-1')) },
  { name: 'recordCommandTrackingEnabled', run: async (p, c) => void (await p.recordCommandTrackingEnabled('M1', c.e1!)) },
  { name: 'recordCommandStarted', run: async (p, c) => void (await p.recordCommandStarted('M1', c.e1!, 'call-1')) },
  { name: 'submitEvidence', run: async (p, c) => void (c.ev1 = (await p.submitEvidence('M1', c.e1!, { kind: 'test', summary: '绿', command: 'node --test', exitCode: 0 })).evidenceId) },
  {
    name: 'submitExecutionResult',
    run: async (p, c) =>
      void (await p.submitExecutionResult('M1', c.e1!, { outcome: 'completed', summary: '改好了', changedFiles: ['src/foo.ts'], evidenceIds: [c.ev1!], notes: '' })),
  },
  { name: 'finishAttempt e1', run: async (p, c) => void (await p.finishAttempt('M1', c.e1!, { endedBy: 'structured_submit' })) },
  { name: 'startExecutorAttempt e2', run: async (p, c) => void (c.e2 = (await p.startExecutorAttempt('M1', c.w2!)).attemptId) },
  { name: 'reportBlocked', run: async (p, c) => void (await p.reportBlocked('M1', c.e2!, { reason: '缺权限', detail: 'd', suggestedNextStep: 's' } as never)) },
  { name: 'finishAttempt e2', run: async (p, c) => void (await p.finishAttempt('M1', c.e2!, { endedBy: 'no_structured_result' })) },
  { name: 'startCoordinatorAttempt a2', run: async (p, c) => void (c.a2 = (await p.startCoordinatorAttempt('M1')).attemptId) },
  {
    name: 'reviewExecutionResult',
    run: async (p, c) =>
      void (await p.reviewExecutionResult('M1', c.a2!, {
        workItemId: c.w1!,
        verdict: 'accept',
        acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '核过' })),
        reasons: ['复跑过'],
        requiredChanges: [],
      } as never)),
  },
  { name: 'retireWorkItem w2', run: async (p, c) => void (await p.retireWorkItem('M1', c.w2!, '不用做了')) },
  { name: 'escalateToL3', run: async (p, c) => void (await p.escalateToL3('M1', c.a2!, { question: '要不要拆？', why: 'w', options: ['拆', '不拆'] })) },
  { name: 'answerEscalation', run: async (p) => void (await p.answerEscalation('M1', '不拆')) },
  { name: 'submitMissionResult', run: async (p, c) => void (await p.submitMissionResult('M1', c.a2!, result('第一版'))) },
  { name: 'finishAttempt a2', run: async (p, c) => void (await p.finishAttempt('M1', c.a2!, { endedBy: 'structured_submit' })) },
  { name: 'finalizeMission send_back', run: async (p) => void (await p.finalizeMission('M1', { verdict: 'send_back', reasons: ['边界不够'] })) },
  { name: 'setWaitReason M1', run: async (p) => void (await p.setWaitReason('M1', 'no_available_agent', '卡在 exec-a')) },
  {
    name: 'recordBudgetThresholdEvents',
    run: async (p) => {
      const { evaluation } = await p.evaluateMissionBudget('M1');
      await p.recordBudgetThresholdEvents('M1', evaluation);
    },
  },
  // ---- 生命周期 ----
  { name: 'createMission M2', run: async (p) => void (await p.createMission({ projectId: 'P', missionId: 'M2', contract: CONTRACT, origin })) },
  { name: 'pauseMission M2', run: async (p) => void (await p.pauseMission('M2')) },
  { name: 'resumeMission M2', run: async (p) => void (await p.resumeMission('M2')) },
  { name: 'reviseContract M2', run: async (p) => void (await p.reviseContract('M2', { ...CONTRACT, intent: '换个说法' })) },
  { name: 'cancelMission M2', run: async (p) => void (await p.cancelMission('M2', '不做了')) },
  { name: 'createMission M6', run: async (p) => void (await p.createMission({ projectId: 'P', missionId: 'M6', contract: CONTRACT, origin })) },
  {
    name: 'abandonMissionForPlan M6',
    run: async (p) => void (await p.abandonMissionForPlan('M6', { planRunId: 'PR-1', escalationId: 'ESC-1', reasons: ['方案放弃'] })),
  },
  // ---- Lightweight：通过 → 交卷 ----
  {
    name: 'createClassifiedMission M3（lightweight，带工单）',
    run: async (p, c) => {
      // 另一个 Project：M1 打回后仍握着 P 的改动名额，同一个 Project 里派发不出去。
      const created = await p.createClassifiedMission({
        projectId: 'P3',
        missionId: 'M3',
        contract: CONTRACT,
        origin,
        facts: FACTS,
        assessment: ASSESSMENT,
        workOrder: LW_ORDER(),
      });
      c.w3 = (created as unknown as { workItemId: string }).workItemId;
    },
  },
  { name: 'dispatchLightweightWorkItem M3', run: async (p, c) => void (await p.dispatchLightweightWorkItem('M3', c.w3!)) },
  { name: 'recordWorkspace M3', run: async (p) => void (await p.recordWorkspace('M3', { projectRoot: '/proj', branch: 'mission/M3', baseRevision: 'base' })) },
  { name: 'startExecutorAttempt e3', run: async (p, c) => void (c.e3 = (await p.startExecutorAttempt('M3', c.w3!)).attemptId) },
  { name: 'submitEvidence e3', run: async (p, c) => void (await p.submitEvidence('M3', c.e3!, { kind: 'test', summary: '绿', command: 'node --test', exitCode: 0 })) },
  {
    name: 'submitExecutionResult e3',
    run: async (p, c) =>
      void (await p.submitExecutionResult('M3', c.e3!, { outcome: 'completed', summary: '改好了', changedFiles: ['src/foo.ts'], evidenceIds: [], notes: '' })),
  },
  { name: 'finishAttempt e3', run: async (p, c) => void (await p.finishAttempt('M3', c.e3!, { endedBy: 'structured_submit' })) },
  { name: 'validateAndAccept M3', run: async (p, c) => void (await p.validateAndAcceptLightweightWorkItem({ missionId: 'M3', workItemId: c.w3!, cwd: '/proj' })) },
  { name: 'submitLightweightMissionForReview M3', run: async (p) => void (await p.submitLightweightMissionForReview('M3')) },
  // ---- Lightweight：验收失败 → 升级 Standard ----
  {
    // 按内核建一条 Lightweight Mission（不是平台命令、不记事件：不会在这一步崩）。
    name: 'seed M5（Project P5）',
    run: async (_p, _c, projects) => {
      const project = await projects.ensure('P5');
      project.createMission({ id: 'M5', contract: CONTRACT, executionMode: 'lightweight', runKind: 'mutation', origin });
      await projects.save(project);
    },
  },
  { name: 'createLightweightWorkItem M5', run: async (p, c) => void (c.w5 = (await p.createLightweightWorkItem('M5', { order: LW_ORDER(true) })).workItemId) },
  { name: 'dispatchLightweightWorkItem M5', run: async (p, c) => void (await p.dispatchLightweightWorkItem('M5', c.w5!)) },
  { name: 'recordWorkspace M5', run: async (p) => void (await p.recordWorkspace('M5', { projectRoot: '/proj', branch: 'mission/M5', baseRevision: 'base' })) },
  { name: 'startExecutorAttempt e5', run: async (p, c) => void (c.e5 = (await p.startExecutorAttempt('M5', c.w5!)).attemptId) },
  { name: 'submitEvidence e5', run: async (p, c) => void (await p.submitEvidence('M5', c.e5!, { kind: 'test', summary: '绿', command: 'node --test', exitCode: 0 })) },
  {
    name: 'submitExecutionResult e5',
    run: async (p, c) =>
      void (await p.submitExecutionResult('M5', c.e5!, { outcome: 'completed', summary: '改好了', changedFiles: ['src/foo.ts'], evidenceIds: [], notes: '' })),
  },
  { name: 'finishAttempt e5', run: async (p, c) => void (await p.finishAttempt('M5', c.e5!, { endedBy: 'structured_submit' })) },
  { name: 'validateAndAccept M5（失败）', run: async (p, c) => void (c.r5 = (await p.validateAndAcceptLightweightWorkItem({ missionId: 'M5', workItemId: c.w5!, cwd: '/proj' })).reportId) },
  { name: 'promoteLightweightAfterValidation M5', run: async (p, c) => void (await p.promoteLightweightAfterValidation('M5', c.r5!)) },
];

/** 平台装配：activity 包一层，第 crashAt 次 append 抛错。 */
function assemble(parts: {
  store: CommandTransaction;
  projects: ProjectRepository;
  activity: ActivityLog;
  deliveries: DeliveryRepository;
  reports: ValidationReportRepository;
  ids: IdGenerator;
  clock: FixedClock;
  crashAt?: number;
  /** before：那一次 append 之前抛；after：append 做完之后抛。 */
  crashWhen?: 'before' | 'after';
}) {
  let appends = 0;
  const activity: ActivityLog = {
    async append(event) {
      appends += 1;
      const crash = appends === parts.crashAt;
      if (crash && parts.crashWhen !== 'after') throw new Error(`CRASH@${appends} (${event.kind})`);
      await parts.activity.append(event);
      if (crash) throw new Error(`CRASH@${appends} after (${event.kind})`);
    },
    list: (missionId) => parts.activity.list(missionId),
  };
  const platform = new Platform({
    projects: parts.projects,
    deliveries: parts.deliveries,
    activity,
    workspace: new InPlaceWorkspaceManager(),
    clock: parts.clock,
    ids: parts.ids,
    transaction: parts.store,
    validation: {
      engine: new ValidationEngine({
        clock: parts.clock,
        ids: parts.ids,
        commandRunner: {
          run: async (input) => ({
            exitCode: input.argv.includes('--fail') ? 1 : 0,
            timedOut: false,
            durationMs: 1,
            output: 'x',
          }),
        },
        changedPathReader: { listChanged: async () => ['src/foo.ts'] },
      }),
      reports: parts.reports,
    },
  });
  return { platform, appends: () => appends };
}

/** 跑脚本；crash 模式下停在抛错的那一步，返回它的下标（没崩返回 undefined）。 */
async function runScript(
  platform: Platform,
  projects: ProjectRepository,
  checkpoint?: (index: number) => Promise<void>,
): Promise<number | undefined> {
  const ctx: Ctx = {};
  for (let index = 0; index < SCRIPT.length; index += 1) {
    try {
      await SCRIPT[index]!.run(platform, ctx, projects);
    } catch (error) {
      if (checkpoint) throw new Error(`参考运行第 ${index} 步（${SCRIPT[index]!.name}）失败：${String(error)}`);
      if (!String(error).includes('CRASH@')) throw error;
      return index;
    }
    await checkpoint?.(index);
  }
  return undefined;
}

/* ============================ 文件版 ============================ */

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fileParts(path: string, crashAt?: number, crashWhen: 'before' | 'after' = 'before') {
  const store = new FileStateStore(path);
  const clock = new FixedClock('2026-09-24T00:00:00.000Z');
  const ids = new PersistentIds(store);
  const projects = new FileProjectRepository(store);
  const assembled = assemble({
    store,
    projects,
    activity: new FileActivityLog(store, clock),
    deliveries: new FileDeliveryRepository(store, clock, ids),
    reports: new FileValidationReportRepository(store),
    ids,
    clock,
    crashWhen,
    ...(crashAt !== undefined ? { crashAt } : {}),
  });
  return { ...assembled, projects };
}

/**
 * 盘上的持久化内容，去掉每次都不同的字段（messageId 是 UUID；answeredAt 取的是墙钟）。
 * 发号计数单独比（见 idCounters）：发号是即时落盘的单调计数，事务回滚不收回——跳号无害。
 */
function fileSnapshot(path: string): string {
  if (!existsSync(path)) return 'EMPTY';
  const state = JSON.parse(readFileSync(path, 'utf8')) as { events: { messageId?: string }[]; idCounters?: unknown };
  for (const event of state.events) delete event.messageId;
  delete state.idCounters;
  return JSON.stringify(state, (key, value) => (key === 'answeredAt' ? 'T' : value));
}

function idCounters(path: string): Record<string, number> {
  if (!existsSync(path)) return {};
  return (JSON.parse(readFileSync(path, 'utf8')) as { idCounters?: Record<string, number> }).idCounters ?? {};
}

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-c4-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

describe('崩溃注入 · 文件版：第 k 次记事件时崩，重开后恰好等于上一条命令结束时', () => {
  test('脚本里的每一次记事件', async () => {
    const referencePath = tempPath();
    const reference = fileParts(referencePath);
    const checkpoints: string[] = [];
    const counters: Record<string, number>[] = [];
    await runScript(reference.platform, reference.projects, async () => {
      checkpoints.push(fileSnapshot(referencePath));
      counters.push(idCounters(referencePath));
    });
    const totalAppends = reference.appends();
    assert.ok(totalAppends > 40, `脚本应当覆盖足够多的事件：${totalAppends}`);

    const covered = new Set<string>();
    for (let k = 1; k <= totalAppends; k += 1) for (const when of ['before', 'after'] as const) {
      const path = tempPath();
      const run = fileParts(path, k, when);
      const crashedAt = await runScript(run.platform, run.projects);
      assert.notEqual(crashedAt, undefined, `k=${k}（${when}）应当崩在某一步`);
      const expected = crashedAt === 0 ? 'EMPTY' : checkpoints[crashedAt! - 1];
      assert.equal(
        fileSnapshot(path),
        expected,
        `k=${k}（${when}）崩在第 ${crashedAt} 步（${SCRIPT[crashedAt!]!.name}）：重开后应等于上一步结束时`,
      );
      // 发号计数只会多不会少：崩掉的命令发出去的号不收回（跳号），但绝不能比上一步还小（会重发）。
      const before = crashedAt === 0 ? {} : counters[crashedAt! - 1]!;
      for (const [prefix, value] of Object.entries(before)) {
        assert.ok((idCounters(path)[prefix] ?? 0) >= value, `k=${k} 发号计数 ${prefix} 倒退`);
      }
      covered.add(SCRIPT[crashedAt!]!.name);
    }
    // 每一条记过事件的命令都被崩过至少一次。
    assert.ok(covered.size >= 40, `被崩过的命令：${covered.size}`);
  });
});

/* ============================ PG 版（真库、独立库） ============================ */

describe('崩溃注入 · PG：第 k 次记事件时崩，新开 store 读库恰好等于上一条命令结束时', () => {
  let dsn: string | undefined;
  const stores: PgStateStore[] = [];
  before(async () => {
    dsn = await ensureTestDatabase('command_checkpoints');
    if (!dsn) return;
    // 新库还没有表：开一次 store 让它建表。
    const store = await PgStateStore.open({ connectionString: dsn });
    await store.close();
  });
  after(async () => {
    for (const store of stores) await store.close().catch(() => undefined);
  });

  async function sql<T extends Record<string, unknown>>(text: string): Promise<T[]> {
    const client = new pg.Client({ connectionString: dsn! });
    await client.connect();
    try {
      return (await client.query<T>(text)).rows;
    } finally {
      await client.end();
    }
  }

  async function reset(): Promise<void> {
    await sql('TRUNCATE projects, activity, deliveries, id_counters, query_runs, validation_reports');
  }

  async function pgParts(crashAt?: number, crashWhen: 'before' | 'after' = 'before') {
    const store = await PgStateStore.open({ connectionString: dsn! });
    stores.push(store);
    const clock = new FixedClock('2026-09-24T00:00:00.000Z');
    const ids = new PgIds(store);
    await ids.reserve(['M', 'W', 'D', 'E', 'VR', 'promo']);
    const projects = new PgProjectRepository(store);
    const assembled = assemble({
      store,
      projects,
      activity: new PgActivityLog(store, clock),
      deliveries: new PgDeliveryRepository(store, clock, ids),
      reports: new PgValidationReportRepository(store),
      ids,
      clock,
      crashWhen,
      ...(crashAt !== undefined ? { crashAt } : {}),
    });
    return { ...assembled, projects, store };
  }

  /**
   * 库里的持久化内容：快照、事件（去掉 message_id）、投递。验收报告不比——PG 事务的范围只到快照、
   * 事件、投递，报告是即时写的 append-only 事实（C3 规格），崩在机器验收里会多一份孤儿报告。
   */
  async function pgSnapshot(): Promise<string> {
    const projects = await sql('SELECT project_id, snapshot FROM projects ORDER BY project_id');
    const activity = await sql(
      `SELECT project_id, mission_id, work_item_id, attempt_id, kind, data, at, protocol_version,
              correlation_id, causation_id, contract_revision, plan_revision
         FROM activity ORDER BY seq`,
    );
    const deliveries = await sql(
      `SELECT delivery_id, mission_id, project_id, outcome, idempotency_key, recipient, summary,
              status, created_at, acknowledged_at
         FROM deliveries ORDER BY delivery_id`,
    );
    return JSON.stringify({ projects, activity, deliveries }, (key, value) => (key === 'answeredAt' ? 'T' : value));
  }

  test('脚本里的每一次记事件', async (t) => {
    if (!dsn) {
      t.skip('没有可用的 Postgres');
      return;
    }
    await reset();
    const reference = await pgParts();
    const checkpoints: string[] = [];
    // 参考运行里不额外 persist：检查点只能是命令自己提交下去的东西，否则没包事务的命令会被它掩盖。
    await runScript(reference.platform, reference.projects, async () => {
      checkpoints.push(await pgSnapshot());
    });
    const totalAppends = reference.appends();
    await reference.store.close();
    stores.splice(stores.indexOf(reference.store), 1);
    const empty = JSON.stringify({ projects: [], activity: [], deliveries: [] });

    for (let k = 1; k <= totalAppends; k += 1) for (const when of ['before', 'after'] as const) {
      await reset();
      const run = await pgParts(k, when);
      const crashedAt = await runScript(run.platform, run.projects);
      assert.notEqual(crashedAt, undefined, `k=${k}（${when}）应当崩在某一步`);
      await run.store.close();
      stores.splice(stores.indexOf(run.store), 1);
      const expected = crashedAt === 0 ? empty : checkpoints[crashedAt! - 1];
      assert.equal(
        await pgSnapshot(),
        expected,
        `k=${k}（${when}）崩在第 ${crashedAt} 步（${SCRIPT[crashedAt!]!.name}）：库里应等于上一步结束时`,
      );
    }
  });
});

/* ============================ 机器验收：authority 对不上时报告照旧保留 ============================ */

describe('机器验收在事务里：authority 对不上，拒绝在提交之后——报告与 validation.reported 都落盘', () => {
  test('文件版：重开状态文件，报告与事件都在，工作项仍是 submitted、没有 accept', async () => {
    const path = tempPath();
    const store = new FileStateStore(path);
    const clock = new FixedClock('2026-09-24T00:00:00.000Z');
    const ids = new PersistentIds(store);
    const projects = new FileProjectRepository(store);
    const platform = new Platform({
      projects,
      deliveries: new FileDeliveryRepository(store, clock, ids),
      activity: new FileActivityLog(store, clock),
      workspace: new InPlaceWorkspaceManager(),
      clock,
      ids,
      transaction: store,
      validation: {
        // 报告说的是另一条 Mission：linkage 对不上。
        engine: {
          validate: async (input) => ({
            report: {
              id: 'VR-mm',
              policyRevision: 'p',
              missionId: 'OTHER',
              workItemId: input.workItemId,
              attemptId: input.attemptId,
              startedAt: 't0',
              endedAt: 't1',
              passed: true,
              checks: [],
            },
            authority: { kind: 'validator', reportId: 'VR-mm', policyRevision: 'p' },
          }),
        } as never,
        reports: new FileValidationReportRepository(store),
      },
    });
    const project = await projects.ensure('P');
    project.createMission({ id: 'M', contract: CONTRACT, executionMode: 'lightweight', runKind: 'mutation', origin });
    await projects.save(project);
    const { workItemId } = await platform.createLightweightWorkItem('M', { order: LW_ORDER() });
    await platform.dispatchLightweightWorkItem('M', workItemId);
    await platform.recordWorkspace('M', { projectRoot: '/proj', branch: 'mission/M', baseRevision: 'base' });
    const { attemptId } = await platform.startExecutorAttempt('M', workItemId);
    await platform.submitEvidence('M', attemptId, { kind: 'test', summary: '绿', command: 'node --test', exitCode: 0 });
    await platform.submitExecutionResult('M', attemptId, {
      outcome: 'completed',
      summary: '改好了',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '',
    });
    await platform.finishAttempt('M', attemptId, { endedBy: 'structured_submit' });

    await assert.rejects(
      platform.validateAndAcceptLightweightWorkItem({ missionId: 'M', workItemId, cwd: '/proj' }),
      (error: unknown) => (error as { code?: string }).code === 'VALIDATION_AUTHORITY_MISMATCH',
    );

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as {
      validationReports: { id: string }[];
      events: { kind: string }[];
    };
    assert.deepEqual(onDisk.validationReports.map((r) => r.id), ['VR-mm'], '报告落盘');
    assert.ok(onDisk.events.some((e) => e.kind === 'validation.reported'), 'validation.reported 落盘');
    assert.ok(!onDisk.events.some((e) => e.kind === 'review.recorded'), '没有 accept');
    const reopened = new FileProjectRepository(new FileStateStore(path));
    const item = (await reopened.get('P'))!.missions.find((m) => m.id === 'M')!.workItems[0]!;
    assert.equal(item.status, 'submitted');
  });
});
