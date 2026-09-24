/**
 * C2：文件版单事务命令（设计 §8.1）。
 *
 * 守住：
 *   - 事务里的写不单独落盘，提交时一次原子写
 *   - 事务里抛错 / 提交写失败：内存与盘上都回到事务之前；之后别处的写不带半截改动
 *   - 事务外的写不混进开着的事务：异步写等它结束，同步落盘推迟到它结束，都不会被它的回滚抹掉
 *   - 交卷（Standard / Lightweight）与升级：每个写边界注入崩溃，重开状态文件后全有或全无；
 *     重放命令后恰好一条终态事件、一条投递
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FixedClock } from '../src/application/in-memory.ts';
import {
  FileActivityLog,
  FileDeliveryRepository,
  FileProjectRepository,
  FileStateStore,
  FileValidationReportRepository,
  PersistentIds,
} from '../src/application/file-store.ts';
import type { DeliveryRepository } from '../src/application/delivery.ts';
import type { ActivityEvent, ActivityLog } from '../src/application/ports.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { ValidationEngine } from '../src/application/validation/engine.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-c2-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

function onDisk(path: string): { events: ActivityEvent[]; deliveries: { missionId: string; idempotencyKey: string }[]; idCounters: Record<string, number> } {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/* ============================ A. 存储层 ============================ */

describe('FileStateStore.run：一次原子写，失败整体回滚', () => {
  test('事务里的写不单独落盘；提交后一次写下全部', async () => {
    const path = tempState();
    const store = new FileStateStore(path);
    const clock = new FixedClock();
    const projects = new FileProjectRepository(store);
    const activity = new FileActivityLog(store, clock);
    await projects.ensure('P'); // 事务外：立刻落盘
    const before = readFileSync(path, 'utf8');

    await store.run(async () => {
      const project = await projects.get('P');
      project!.createMission({ id: 'M', contract: CONTRACT });
      await projects.save(project!);
      await activity.append({ projectId: 'P', missionId: 'M', kind: 'mission.created', data: {} });
      new PersistentIds(store).next('W');
      assert.equal(readFileSync(path, 'utf8'), before, '事务里一个字节都不落盘');
    });

    const after = onDisk(path);
    assert.deepEqual(after.events.map((e) => e.kind), ['mission.created']);
    assert.equal(after.idCounters.W, 1);
    const reopened = new FileProjectRepository(new FileStateStore(path));
    assert.ok((await reopened.get('P'))?.missions.some((m) => m.id === 'M'));
  });

  test('事务里抛错：内存与盘上都回到之前；之后别处的写不带半截改动', async () => {
    const path = tempState();
    const store = new FileStateStore(path);
    const clock = new FixedClock();
    const projects = new FileProjectRepository(store);
    const activity = new FileActivityLog(store, clock);
    const deliveries = new FileDeliveryRepository(store, clock, new PersistentIds(store));
    const project = await projects.ensure('P');
    project.createMission({ id: 'M', contract: CONTRACT });
    await projects.save(project);
    const diskBefore = readFileSync(path, 'utf8');
    const memoryBefore = JSON.stringify(project.toSnapshot());

    await assert.rejects(
      store.run(async () => {
        const live = (await projects.get('P'))!;
        live.createMission({ id: 'M-half', contract: CONTRACT });
        await activity.append({ projectId: 'P', missionId: 'M-half', kind: 'mission.created', data: {} });
        await deliveries.create({
          missionId: 'M-half',
          projectId: 'P',
          recipient: 'me',
          outcome: 'delivered',
          idempotencyKey: 'result:x',
          summary: 's',
        });
        throw new Error('命令半路失败');
      }),
      /命令半路失败/,
    );

    assert.equal(readFileSync(path, 'utf8'), diskBefore, '盘上还是事务之前的文件');
    assert.equal(JSON.stringify((await projects.get('P'))!.toSnapshot()), memoryBefore, '活对象回到事务之前');
    assert.deepEqual(await activity.list('M-half'), []);
    assert.deepEqual(await deliveries.pending('me'), []);

    // 之后别处的一次写：只带自己的改动。
    await activity.append({ projectId: 'P', missionId: 'M', kind: 'note', data: {} });
    const reopened = new FileStateStore(path);
    assert.equal((await new FileProjectRepository(reopened).get('P'))!.missions.length, 1);
    assert.deepEqual(onDisk(path).events.map((e) => `${e.missionId}:${e.kind}`), ['M:note']);
    assert.deepEqual(onDisk(path).deliveries, []);
  });

  test('提交写失败（临时文件写不下去）：盘上不变、内存回滚；障碍去掉后照常写', async () => {
    const path = tempState();
    const store = new FileStateStore(path);
    const clock = new FixedClock();
    const projects = new FileProjectRepository(store);
    const activity = new FileActivityLog(store, clock);
    await projects.ensure('P');
    const diskBefore = readFileSync(path, 'utf8');

    mkdirSync(`${path}.tmp`); // 临时文件的位置被一个目录占着：提交那一次写必然失败
    try {
      await assert.rejects(
        store.run(async () => {
          const live = (await projects.get('P'))!;
          live.createMission({ id: 'M', contract: CONTRACT });
          await activity.append({ projectId: 'P', missionId: 'M', kind: 'mission.created', data: {} });
        }),
      );
      assert.equal(readFileSync(path, 'utf8'), diskBefore);
      assert.equal((await projects.get('P'))!.missions.length, 0, '提交失败也要回滚内存');
      assert.deepEqual(await activity.list('M'), []);
    } finally {
      rmSync(`${path}.tmp`, { recursive: true, force: true });
    }

    await activity.append({ projectId: 'P', missionId: 'M2', kind: 'note', data: {} });
    assert.deepEqual(onDisk(path).events.map((e) => e.missionId), ['M2']);
  });

  test('嵌套：内层并进外层，一起提交', async () => {
    const path = tempState();
    const store = new FileStateStore(path);
    const activity = new FileActivityLog(store, new FixedClock());
    await store.run(async () => {
      await activity.append({ projectId: 'P', missionId: 'M', kind: 'outer', data: {} });
      await store.run(async () => {
        await activity.append({ projectId: 'P', missionId: 'M', kind: 'inner', data: {} });
      });
      assert.equal(existsSync(path), false, '内层结束时也还没落盘');
    });
    assert.deepEqual(onDisk(path).events.map((e) => e.kind), ['outer', 'inner']);
  });

  test('事务串行：后一个等前一个结束', async () => {
    const store = new FileStateStore(tempState());
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = store.run(async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
    });
    const second = store.run(async () => {
      order.push('second:start');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(order, ['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
  });

  test('事务外的异步写等事务结束，且不会被它的回滚抹掉', async () => {
    const path = tempState();
    const store = new FileStateStore(path);
    const activity = new FileActivityLog(store, new FixedClock());
    let releaseTx!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTx = resolve;
    });
    const tx = store.run(async () => {
      await activity.append({ projectId: 'P', missionId: 'M', kind: 'inside', data: {} });
      await gate;
      throw new Error('回滚');
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    let outsideDone = false;
    const outside = activity.append({ projectId: 'P', missionId: 'M', kind: 'outside', data: {} }).then(() => {
      outsideDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(outsideDone, false, '事务开着时，事务外的写在等');
    releaseTx();
    await assert.rejects(tx, /回滚/);
    await outside;
    assert.deepEqual((await activity.list('M')).map((e) => e.kind), ['outside']);
    assert.deepEqual(onDisk(path).events.map((e) => e.kind), ['outside']);
  });

  test('每一种事务外的写都等事务结束、都熬过它的回滚（项目 / 投递 / 事件 / 查询 / 验收报告 / 候选池）', async () => {
    const path = tempState();
    const store = new FileStateStore(path);
    const clock = new FixedClock();
    const ids = new PersistentIds(store);
    const projects = new FileProjectRepository(store);
    const activity = new FileActivityLog(store, clock);
    const deliveries = new FileDeliveryRepository(store, clock, ids);
    const { FileQueryRunRepository, FileAgentPoolRepository } = await import('../src/application/file-store.ts');
    const queryRuns = new FileQueryRunRepository(store);
    const reports = new FileValidationReportRepository(store);
    const pool = new FileAgentPoolRepository(store);
    const existing = await deliveries.create({
      missionId: 'M-ack',
      projectId: 'P',
      recipient: 'me',
      outcome: 'delivered',
      idempotencyKey: 'result:a',
      summary: 's',
    });
    const saved = await projects.ensure('P-saved');

    let releaseTx!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTx = resolve;
    });
    const tx = store.run(async () => {
      await activity.append({ projectId: 'P', missionId: 'M-tx', kind: 'inside', data: {} });
      await gate;
      throw new Error('回滚');
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // 事务开着时别处改了一个活对象再 save：save 要等事务结束再放回去，否则回滚会把这次改动一起抹掉。
    saved.createMission({ id: 'M-saved', contract: CONTRACT });
    const outside = Promise.all([
      projects.save(saved),
      projects.ensure('P-outside'),
      activity.append({ projectId: 'P', missionId: 'M-out', kind: 'outside', data: {} }),
      deliveries.create({ missionId: 'M-out', projectId: 'P', recipient: 'me', outcome: 'escalated', idempotencyKey: 'escalated:0', summary: 'q' }),
      deliveries.acknowledge(existing.id),
      queryRuns.save({
        id: 'Q-1',
        projectId: 'P',
        source: 'test',
        prompt: 'p',
        cwd: '/',
        startedAt: '2026-01-01T00:00:00.000Z',
        status: 'running',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, quality: 'unknown' },
      }),
      reports.save({
        id: 'VR-1',
        policyRevision: 'p',
        missionId: 'M-out',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:01.000Z',
        passed: true,
        checks: [],
      } as never),
      pool.add({ role: 'executor', profileId: 'exec-x', endpoint: 'local' }),
    ]);
    releaseTx();
    await assert.rejects(tx, /回滚/);
    await outside;

    const reopened = new FileStateStore(path);
    const raw = reopened.raw();
    assert.ok(reopened.projectsMap().has('P-outside'), 'ensure');
    assert.ok(reopened.projectsMap().get('P-saved')?.missions.some((m) => m.id === 'M-saved'), 'save');
    assert.deepEqual(raw.events.map((e) => e.kind), ['outside'], 'append（事务里那条随回滚没了）');
    assert.deepEqual(raw.deliveries.map((d) => `${d.missionId}:${d.status}`).sort(), ['M-ack:acknowledged', 'M-out:pending'], 'create / acknowledge');
    assert.deepEqual(raw.queryRuns.map((q) => q.id), ['Q-1'], 'query run save');
    assert.deepEqual(raw.validationReports.map((r) => r.id), ['VR-1'], 'report save');
    assert.deepEqual(raw.agentPool.map((row) => row.profileId), ['exec-x'], 'agent pool add');
  });

  test('事务开着时别处的同步落盘（发号）推迟到事务结束；事务回滚了它也照样落盘，号不回收', async () => {
    const path = tempState();
    const store = new FileStateStore(path);
    const ids = new PersistentIds(store);
    let releaseTx!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTx = resolve;
    });
    const tx = store.run(async () => {
      await gate;
      throw new Error('回滚');
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(ids.next('X'), 'X-1');
    assert.equal(existsSync(path), false, '事务开着：推迟，不写');
    releaseTx();
    await assert.rejects(tx);
    assert.equal(onDisk(path).idCounters.X, 1, '回滚之后把推迟的那次写补上');
    assert.equal(ids.next('X'), 'X-2', '发出去的号不回收');
  });

  test('事务开着时不重读状态文件：别的进程改了文件也不会换掉事务正在改的活对象', async () => {
    const path = tempState();
    const store = new FileStateStore(path);
    const projects = new FileProjectRepository(store);
    await projects.ensure('P');
    await store.run(async () => {
      const live = (await projects.get('P'))!;
      live.createMission({ id: 'M', contract: CONTRACT });
      // 模拟别的进程改了文件（mtime 变了）。
      const other = onDisk(path) as unknown as Record<string, unknown>;
      writeFileSync(path, JSON.stringify({ ...other, projects: [] }));
      const again = await projects.get('P');
      assert.ok(again?.missions.some((m) => m.id === 'M'), '事务里读到的还是事务自己的活对象');
    });
  });

  test('命令事务进行中不能归档', async () => {
    const store = new FileStateStore(tempState());
    await store.run(async () => {
      assert.throws(() => store.archiveMission('P', 'M'), /命令事务进行中/);
    });
  });
});

/* ============================ B. 平台命令的崩溃注入 ============================ */

type Crash =
  | { readonly kind: 'none' }
  | { readonly kind: 'beforeEvent'; readonly event: string }
  | { readonly kind: 'beforeDelivery' }
  | { readonly kind: 'commitWrite' };

/** 文件版装一套平台；activity / deliveries 包一层，在指定写边界「崩溃」（抛错）。 */
function filePlatform(path: string, crash: Crash = { kind: 'none' }) {
  const store = new FileStateStore(path);
  const clock = new FixedClock();
  const ids = new PersistentIds(store);
  const realActivity = new FileActivityLog(store, clock);
  const realDeliveries = new FileDeliveryRepository(store, clock, ids);
  let armed = false;
  const activity: ActivityLog = {
    async append(event) {
      if (armed && crash.kind === 'beforeEvent' && crash.event === event.kind) throw new Error(`CRASH before ${event.kind}`);
      return realActivity.append(event);
    },
    list: (missionId) => realActivity.list(missionId),
  };
  const deliveries: DeliveryRepository = {
    async create(input) {
      if (armed && crash.kind === 'beforeDelivery') throw new Error('CRASH before delivery');
      return realDeliveries.create(input);
    },
    pending: (recipient) => realDeliveries.pending(recipient),
    acknowledge: (id) => realDeliveries.acknowledge(id),
    get: (id) => realDeliveries.get(id),
  };
  const projects = new FileProjectRepository(store);
  const platform = new Platform({
    projects,
    deliveries,
    activity,
    workspace: new InPlaceWorkspaceManager(),
    clock,
    ids,
    transaction: store,
    validation: {
      engine: new ValidationEngine({
        clock,
        ids,
        commandRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' }) },
        changedPathReader: { listChanged: async () => ['src/foo.ts'] },
      }),
      reports: new FileValidationReportRepository(store),
    },
  });
  return {
    platform,
    projects,
    activity: realActivity,
    deliveries: realDeliveries,
    /** 只在要测的那条命令上崩：之前的准备步骤照常落盘。 */
    arm() {
      armed = true;
      if (crash.kind === 'commitWrite') mkdirSync(`${path}.tmp`);
    },
    disarm() {
      armed = false;
      rmSync(`${path}.tmp`, { recursive: true, force: true });
    },
  };
}

interface Scenario {
  readonly name: string;
  readonly missionId: string;
  /** 准备到命令之前（照常落盘）；返回命令本身，可重放。 */
  prepare(platform: Platform, projects: FileProjectRepository): Promise<(platform: Platform) => Promise<unknown>>;
  readonly terminalEvent: string;
  readonly deliveryKey: (ctx: { attemptId?: string; reportId?: string }) => RegExp;
  readonly crashes: readonly Crash[];
}

const origin = { clientType: 'cli', conversationRef: 'me' };

const standardSubmit: Scenario = {
  name: 'Standard 交卷',
  missionId: 'M',
  async prepare(platform) {
    await platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT, origin });
    const { attemptId } = await platform.startCoordinatorAttempt('M');
    const body = { outcome: 'delivered' as const, summary: '改好了', acceptanceEvidence: ['e'], memoryDelta: [], openRisks: [] };
    return (p) => p.submitMissionResult('M', attemptId, body);
  },
  terminalEvent: 'mission_result.submitted',
  deliveryKey: () => /^result:/,
  crashes: [
    { kind: 'beforeEvent', event: 'mission_result.submitted' },
    { kind: 'beforeDelivery' },
    { kind: 'beforeEvent', event: 'delivery.created' },
    { kind: 'commitWrite' },
  ],
};

const escalation: Scenario = {
  name: '升级',
  missionId: 'M',
  async prepare(platform) {
    await platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT, origin });
    const { attemptId } = await platform.startCoordinatorAttempt('M');
    return (p) => p.escalateToL3('M', attemptId, { question: '要不要拆？', why: '两种设计', options: ['拆', '不拆'] });
  },
  terminalEvent: 'escalated',
  deliveryKey: () => /^escalated:0$/,
  crashes: [
    { kind: 'beforeEvent', event: 'escalated' },
    { kind: 'beforeDelivery' },
    { kind: 'beforeEvent', event: 'delivery.created' },
    { kind: 'commitWrite' },
  ],
};

const lightweightSubmit: Scenario = {
  name: 'Lightweight 交卷',
  missionId: 'M-lw',
  async prepare(platform, projects) {
    // 直接按内核建一条 Lightweight Mission（与 orchestrator-lightweight 的测试同一种做法）。
    const project = await projects.ensure('P');
    project.createMission({ id: 'M-lw', contract: CONTRACT, executionMode: 'lightweight', runKind: 'mutation', origin });
    await projects.save(project);
    const order: WorkOrder = {
      objective: '改 foo',
      allowedScope: ['src/foo.ts'],
      requiredBehaviour: 'foo 返回 1',
      constraints: [],
      acceptance: ['foo() === 1'],
      verification: ['node --test'],
      doNot: [],
      contextRefs: [],
      validation: { commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }] },
    };
    const { workItemId } = await platform.createLightweightWorkItem('M-lw', { order });
    await platform.dispatchLightweightWorkItem('M-lw', workItemId);
    await platform.recordWorkspace('M-lw', { projectRoot: '/proj', branch: 'mission/M-lw', baseRevision: 'base' });
    const { attemptId } = await platform.startExecutorAttempt('M-lw', workItemId);
    await platform.submitEvidence('M-lw', attemptId, { kind: 'test', summary: '绿', command: 'node --test', exitCode: 0 });
    await platform.submitExecutionResult('M-lw', attemptId, {
      outcome: 'completed',
      summary: '改好了',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '',
    });
    await platform.finishAttempt('M-lw', attemptId, { endedBy: 'structured_submit' });
    const validated = await platform.validateAndAcceptLightweightWorkItem({ missionId: 'M-lw', workItemId, cwd: '/proj' });
    assert.equal(validated.status, 'accepted');
    return (p) => p.submitLightweightMissionForReview('M-lw');
  },
  terminalEvent: 'mission_result.submitted',
  deliveryKey: () => /^result:VR-/,
  crashes: [
    { kind: 'beforeEvent', event: 'mission_result.submitted' },
    { kind: 'beforeDelivery' },
    { kind: 'beforeEvent', event: 'delivery.created' },
    { kind: 'commitWrite' },
  ],
};

function crashLabel(crash: Crash): string {
  if (crash.kind === 'beforeEvent') return `记 ${crash.event} 之前`;
  if (crash.kind === 'beforeDelivery') return '建投递之前';
  if (crash.kind === 'commitWrite') return '提交那一次写';
  return '不崩';
}

async function persisted(path: string, missionId: string) {
  const { platform, activity, deliveries } = filePlatform(path);
  const view = await platform.getMissionView(missionId);
  const kinds = (await activity.list(missionId)).map((e) => e.kind);
  const rows = (await deliveries.pending('me')).filter((d) => d.missionId === missionId);
  return { platform, view, kinds, rows };
}

for (const scenario of [standardSubmit, escalation, lightweightSubmit]) {
  describe(`崩溃注入：${scenario.name}`, () => {
    for (const crash of scenario.crashes) {
      test(`${crashLabel(crash)}崩溃 → 重开后全无；同进程后续写不带半截；重放后恰好一条终态事件、一条投递`, async () => {
        const path = tempState();
        const first = filePlatform(path, crash);
        const command = await scenario.prepare(first.platform, first.projects);
        const statusBefore = (await first.platform.getMissionView(scenario.missionId)).status;

        first.arm();
        await assert.rejects(command(first.platform));
        first.disarm();
        // 崩溃之后、进程退出之前，同一进程里别处又写了一次：不能把半截改动带下去。
        await first.platform.createMission({ projectId: 'P', missionId: 'M-other', contract: CONTRACT, origin });

        const afterCrash = await persisted(path, scenario.missionId);
        assert.equal(afterCrash.view.status, statusBefore, '状态回到命令之前');
        assert.ok(!afterCrash.kinds.includes(scenario.terminalEvent), `不留 ${scenario.terminalEvent}：${afterCrash.kinds.join(',')}`);
        assert.ok(!afterCrash.kinds.includes('delivery.created'));
        assert.deepEqual(afterCrash.rows, [], '不留投递');

        // 重启后重放同一条命令。
        await command(afterCrash.platform);
        const replayed = await persisted(path, scenario.missionId);
        assert.equal(replayed.view.status, scenario === escalation ? statusBefore : 'awaiting_review');
        assert.equal(replayed.kinds.filter((k) => k === scenario.terminalEvent).length, 1, '恰好一条终态事件');
        assert.equal(replayed.kinds.filter((k) => k === 'delivery.created').length, 1);
        assert.equal(replayed.rows.length, 1, '恰好一条投递');
        assert.match(replayed.rows[0]!.idempotencyKey, scenario.deliveryKey({}));
      });
    }

    test('不崩：一次写下状态、终态事件、投递', async () => {
      const path = tempState();
      const { platform, projects } = filePlatform(path);
      const command = await scenario.prepare(platform, projects);
      await command(platform);
      const done = await persisted(path, scenario.missionId);
      assert.equal(done.kinds.filter((k) => k === scenario.terminalEvent).length, 1);
      assert.equal(done.rows.length, 1);
    });
  });
}

/* ============================ C. 装配 ============================ */

describe('buildPersistentPlatform 注入了事务', () => {
  test('提交写失败时整条升级回滚：内存里也没有半截升级（没注入的话，记事件那次写就失败，升级却已经记在活对象上）', async () => {
    const { buildPersistentPlatform } = await import('../src/main.ts');
    const path = tempState();
    const built = await buildPersistentPlatform(path, { workspace: new InPlaceWorkspaceManager() });
    await built.platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT, origin });
    const { attemptId } = await built.platform.startCoordinatorAttempt('M');

    mkdirSync(`${path}.tmp`);
    try {
      await assert.rejects(built.platform.escalateToL3('M', attemptId, { question: '拆吗？', why: 'w', options: ['是', '否'] }));
    } finally {
      rmSync(`${path}.tmp`, { recursive: true, force: true });
    }
    const view = await built.platform.getMissionView('M');
    assert.equal(view.escalations, 0, '没有半截升级留在内存里');
    assert.deepEqual(await built.deliveries.pending('me'), []);
  });
});
