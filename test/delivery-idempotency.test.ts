/**
 * C1：投递按业务幂等键去重（设计 §8.1–8.2）。
 *
 * 守住：
 *   - 第二次升级（前一次已答复并确认）进收件箱；L3 打回后重新交卷进收件箱
 *   - 同一个键重建投递拿回原来那条（内存 / 文件 / 真 PG 三个实现同一语义）
 *   - 键只由持久化状态决定：升级 escalated:<第几次>，交卷 result:<协调者 attempt | 验收报告>
 *   - 旧数据：文件版读入时补键，归档包读出的副本补键、盘上不动；PG 迁移回填、换唯一约束、可重复执行
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPlatform } from '../src/main.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import {
  escalationDeliveryKey,
  InMemoryDeliveryRepository,
  legacyDeliveryKey,
  resultDeliveryKey,
} from '../src/application/delivery.ts';
import type { Delivery, DeliveryRepository } from '../src/application/delivery.ts';
import {
  FileDeliveryRepository,
  FileStateStore,
  PersistentIds,
} from '../src/application/file-store.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { ValidationEngine } from '../src/application/validation/engine.ts';
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
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

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-c1-'));
  dirs.push(dir);
  return dir;
}

function input(missionId: string, idempotencyKey: string, recipient = 'me', outcome: Delivery['outcome'] = 'escalated') {
  return { missionId, projectId: 'P', recipient, outcome, idempotencyKey, summary: `${missionId} ${idempotencyKey}` };
}

/** 三个实现共用的去重语义。收件人单独一个，免得和同库里别的行混在一起数。 */
async function assertKeySemantics(repo: DeliveryRepository, to = 'sem'): Promise<void> {
  const first = await repo.create(input('M1', 'escalated:0', to));
  const again = await repo.create({ ...input('M1', 'escalated:0', to), summary: '重建' });
  assert.equal(again.id, first.id, '同一个键拿回原来那条');
  assert.equal(again.summary, first.summary, '第一条才算数');
  assert.equal(first.idempotencyKey, 'escalated:0');

  const second = await repo.create(input('M1', 'escalated:1', to));
  assert.notEqual(second.id, first.id, '同一种结局、不同的键：各投一条');
  const otherMission = await repo.create(input('M2', 'escalated:0', to));
  assert.notEqual(otherMission.id, first.id, '键只在同一 Mission 内去重');

  await repo.acknowledge(first.id);
  const afterAck = await repo.create(input('M1', 'escalated:0', to));
  assert.equal(afterAck.id, first.id, '确认过的也不会因为重建而再投一次');
  const pending = await repo.pending(to);
  assert.deepEqual(pending.map((d) => `${d.missionId}/${d.idempotencyKey}`).sort(), ['M1/escalated:1', 'M2/escalated:0']);
}

describe('投递仓储：按 (missionId, idempotencyKey) 去重', () => {
  test('内存版', async () => {
    const clock = new FixedClock();
    await assertKeySemantics(new InMemoryDeliveryRepository(clock, new SequentialIds()));
  });

  test('文件版', async () => {
    const store = new FileStateStore(join(tempDir(), 'state.json'));
    await assertKeySemantics(new FileDeliveryRepository(store, new FixedClock(), new PersistentIds(store)));
  });

  test('键的写法', () => {
    assert.equal(escalationDeliveryKey(2), 'escalated:2');
    assert.equal(resultDeliveryKey('M.coord-3'), 'result:M.coord-3');
    assert.equal(legacyDeliveryKey('escalated'), 'escalated:0');
    assert.equal(legacyDeliveryKey('delivered'), 'result:legacy:delivered');
    assert.equal(legacyDeliveryKey('blocked'), 'result:legacy:blocked');
  });
});

describe('平台：每一次升级、每一次交卷都进收件箱', () => {
  test('第二次升级（前一次已答复并确认）照样进收件箱，键按第几次升级', async () => {
    const { platform, deliveries } = buildPlatform(new InPlaceWorkspaceManager());
    await platform.createMission({
      projectId: 'P',
      missionId: 'M',
      contract: CONTRACT,
      origin: { clientType: 'cli', conversationRef: 'me' },
    });
    const { attemptId: first } = await platform.startCoordinatorAttempt('M');
    await platform.escalateToL3('M', first, { question: '第一问？', why: 'w1', options: ['x', 'y'] });
    const [one] = await deliveries.pending('me');
    assert.equal(one?.idempotencyKey, 'escalated:0');
    await platform.answerEscalation('M', { answer: 'x' });
    await deliveries.acknowledge(one!.id);
    await platform.finishAttempt('M', first, { endedBy: 'structured_submit' });

    const { attemptId: second } = await platform.startCoordinatorAttempt('M');
    await platform.escalateToL3('M', second, { question: '第二问？', why: 'w2', options: ['p', 'q'] });

    const pending = await deliveries.pending('me');
    assert.equal(pending.length, 1, '第二次升级必须进收件箱');
    assert.equal(pending[0]!.idempotencyKey, 'escalated:1');
    assert.match(pending[0]!.summary, /第二问/);
  });

  test('L3 打回后重新交卷：新结果进收件箱，键是提交它的协调者 attempt', async () => {
    const { platform, deliveries } = buildPlatform(new InPlaceWorkspaceManager());
    await platform.createMission({
      projectId: 'P',
      missionId: 'M',
      contract: CONTRACT,
      origin: { clientType: 'cli', conversationRef: 'me' },
    });
    const result = (summary: string) => ({
      outcome: 'delivered' as const,
      summary,
      acceptanceEvidence: ['e'],
      memoryDelta: [],
      openRisks: [],
    });
    const { attemptId: first } = await platform.startCoordinatorAttempt('M');
    await platform.submitMissionResult('M', first, result('第一版'));
    // 同一次交卷重复提交（同一个协调者 attempt）：状态机拒也好、放也好，收件箱里只能有一条。
    await platform.submitMissionResult('M', first, result('第一版重发')).catch(() => undefined);
    await platform.finishAttempt('M', first, { endedBy: 'structured_submit' });
    const firstRound = await deliveries.pending('me');
    assert.equal(firstRound.length, 1, '同一次交卷只投一条');
    const [firstDelivery] = firstRound;
    assert.equal(firstDelivery?.idempotencyKey, `result:${first}`);
    assert.equal(firstDelivery?.summary, '第一版');
    await deliveries.acknowledge(firstDelivery!.id);

    await platform.finalizeMission('M', { verdict: 'send_back', reasons: ['边界说明不够'] });
    const { attemptId: second } = await platform.startCoordinatorAttempt('M');
    await platform.submitMissionResult('M', second, result('第二版'));

    const pending = await deliveries.pending('me');
    assert.equal(pending.length, 1, '重新交卷的结果必须进收件箱');
    assert.equal(pending[0]!.idempotencyKey, `result:${second}`);
    assert.equal(pending[0]!.summary, '第二版');
  });

  test('收件箱补注 stillOpen：已答复的升级、被打回的旧结果都不再开放', async () => {
    const { platform, deliveries } = buildPlatform(new InPlaceWorkspaceManager());
    const start = (missionId: string) => platform.createMission({
      projectId: 'P',
      missionId,
      contract: CONTRACT,
      origin: { clientType: 'cli', conversationRef: 'me' },
    });

    // 升级流程：第一问已答复，第二问还开着。两条都不 ACK，否则旧投递就离开 pending 了。
    await start('M-esc');
    const { attemptId: escFirst } = await platform.startCoordinatorAttempt('M-esc');
    await platform.escalateToL3('M-esc', escFirst, { question: '第一问？', why: 'w1', options: ['x', 'y'] });
    await platform.answerEscalation('M-esc', { answer: 'x' });
    await platform.finishAttempt('M-esc', escFirst, { endedBy: 'structured_submit' });
    const { attemptId: escSecond } = await platform.startCoordinatorAttempt('M-esc');
    await platform.escalateToL3('M-esc', escSecond, { question: '第二问？', why: 'w2', options: ['p', 'q'] });

    // 交卷流程：第一版被打回，第二版在等终审。
    await start('M-res');
    const result = (summary: string) => ({
      outcome: 'delivered' as const,
      summary,
      acceptanceEvidence: ['e'],
      memoryDelta: [],
      openRisks: [],
    });
    const { attemptId: resFirst } = await platform.startCoordinatorAttempt('M-res');
    await platform.submitMissionResult('M-res', resFirst, result('第一版'));
    await platform.finishAttempt('M-res', resFirst, { endedBy: 'structured_submit' });
    await platform.finalizeMission('M-res', { verdict: 'send_back', reasons: ['边界说明不够'] });
    const { attemptId: resSecond } = await platform.startCoordinatorAttempt('M-res');
    await platform.submitMissionResult('M-res', resSecond, result('第二版'));

    const pending = await deliveries.pending('me');
    const annotated = await platform.annotateInboxStillOpen(pending);
    assert.deepEqual(annotated.map((row) => row.id), pending.map((row) => row.id), '补注不过滤、不改顺序');
    const open = (missionId: string, idempotencyKey: string) => annotated
      .find((row) => row.missionId === missionId && row.idempotencyKey === idempotencyKey)?.stillOpen;
    assert.equal(open('M-esc', 'escalated:0'), false, '已答复的升级不再开放');
    assert.equal(open('M-esc', 'escalated:1'), true, '未答复的升级仍开放');
    assert.equal(open('M-res', `result:${resFirst}`), false, '被打回的旧结果不再开放');
    assert.equal(open('M-res', `result:${resSecond}`), true, '最新结果在等终审，仍开放');
    // 判定是只读的：存储里的投递不该多出这个字段。
    const stored = await deliveries.get(pending[0]!.id);
    assert.equal(Object.prototype.hasOwnProperty.call(stored, 'stillOpen'), false, 'Delivery 存储字段不变');
  });

  test('Lightweight 交卷：键是那份验收报告', async () => {
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const projects = new InMemoryProjectRepository();
    const deliveries = new InMemoryDeliveryRepository(clock, ids);
    const platform = new Platform({
      projects,
      deliveries,
      workspace: new InPlaceWorkspaceManager(),
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
      validation: {
        engine: new ValidationEngine({
          clock,
          ids: new SequentialIds(),
          commandRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' }) },
          changedPathReader: { listChanged: async () => ['src/foo.ts'] },
        }),
        reports: new InMemoryValidationReportRepository(),
      },
    });
    const project = await projects.ensure('P');
    project.createMission({
      id: 'M-lw',
      contract: CONTRACT,
      executionMode: 'lightweight',
      runKind: 'mutation',
      origin: { clientType: 'cli', conversationRef: 'me' },
    });
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
    await platform.recordWorkspace('M-lw', { projectRoot: '/proj', branch: 'mission/M-lw', baseRevision: 'base-rev-1' });
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
    const validated = await platform.validateAndAcceptLightweightWorkItem({ missionId: 'M-lw', workItemId, cwd: process.cwd() });
    // 机器过了也留在 submitted：验收结论归协调者（W-442 之后），交卷前必须先有 L2 的 accept。
    assert.equal(validated.status, 'submitted');

    // 真实 L2：起协调者 attempt，凭这份报告逐条判 pass，再收尾这一跳。
    const { attemptId: l2 } = await platform.startCoordinatorAttempt('M-lw');
    await platform.reviewExecutionResult('M-lw', l2, {
      workItemId,
      verdict: 'accept',
      reasons: ['机器验收通过，逐条核过'],
      requiredChanges: [],
      acceptanceResults: order.acceptance.map((criterion) => ({
        criterion,
        status: 'pass' as const,
        evidence: `机器验收报告 ${validated.reportId}：node --test 退出 0`,
      })),
    });
    await platform.finishAttempt('M-lw', l2, { endedBy: 'structured_submit' });

    const { reportId } = await platform.submitLightweightMissionForReview('M-lw');

    const [delivery] = await deliveries.pending('me');
    assert.equal(delivery?.idempotencyKey, `result:${reportId}`);
  });
});

describe('文件版旧数据：读入补键，去重接得上', () => {
  test('加键之前的状态文件：读入时按旧规则补键；重建第一次升级拿回旧行，第二次升级新建', async () => {
    const path = join(tempDir(), 'state.json');
    const legacy = (id: string, outcome: Delivery['outcome'], status: Delivery['status']) => ({
      id,
      missionId: 'M-old',
      projectId: 'P',
      recipient: 'me',
      outcome,
      summary: `${outcome} 旧行`,
      createdAt: '2026-01-01T00:00:00.000Z',
      status,
    });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        projects: [],
        deliveries: [legacy('D-1', 'escalated', 'pending'), legacy('D-2', 'delivered', 'acknowledged')],
        events: [],
        idCounters: { D: 2 },
      }),
    );
    const store = new FileStateStore(path);
    const repo = new FileDeliveryRepository(store, new FixedClock(), new PersistentIds(store));

    assert.equal((await repo.get('D-1'))?.idempotencyKey, 'escalated:0');
    assert.equal((await repo.get('D-2'))?.idempotencyKey, 'result:legacy:delivered');
    const rebuilt = await repo.create(input('M-old', 'escalated:0'));
    assert.equal(rebuilt.id, 'D-1', '旧行就是第一次升级的投递');
    const next = await repo.create(input('M-old', 'escalated:1'));
    assert.equal(next.id, 'D-3');

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { deliveries: Delivery[] };
    assert.deepEqual(
      onDisk.deliveries.map((d) => `${d.id}=${d.idempotencyKey}`),
      ['D-1=escalated:0', 'D-2=result:legacy:delivered', 'D-3=escalated:1'],
      '下一次落盘把补上的键一起写下',
    );

    // 「重启」：新开一个 store 读同一个文件，重建同一次升级的投递拿回原来那条。
    const reopened = new FileStateStore(path);
    const again = new FileDeliveryRepository(reopened, new FixedClock(), new PersistentIds(reopened));
    assert.equal((await again.create(input('M-old', 'escalated:1'))).id, 'D-3');
    assert.equal((await again.create(input('M-old', 'escalated:0'))).id, 'D-1');
    assert.equal((await again.pending('me')).filter((d) => d.missionId === 'M-old').length, 2);
  });
});
