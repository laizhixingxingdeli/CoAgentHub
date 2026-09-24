/**
 * C5a：文件版缺失投递补建。
 *
 * 造「缺投递」的旧数据：内核 API 写下升级 / 结果，事件手工 append，
 * 不走平台命令（平台现在会一起建投递）。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { FixedClock, SequentialIds } from '../src/application/in-memory.ts';
import {
  FileActivityLog,
  FileDeliveryRepository,
  FileProjectRepository,
  FileStateStore,
  PersistentIds,
} from '../src/application/file-store.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import type { ActivityLog } from '../src/application/ports.ts';
import { repairMissingDeliveries } from '../src/application/reconcile.ts';
import type { MissionContract, MissionResultBody } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const RESULT: MissionResultBody = {
  outcome: 'delivered',
  summary: '改好了',
  acceptanceEvidence: ['e'],
  memoryDelta: [],
  openRisks: [],
};

const origin = { clientType: 'cli', conversationRef: 'me' };

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-c5a-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

function openFile(path: string) {
  const store = new FileStateStore(path);
  const clock = new FixedClock();
  const ids = new PersistentIds(store);
  return {
    store,
    clock,
    projects: new FileProjectRepository(store),
    activity: new FileActivityLog(store, clock),
    deliveries: new FileDeliveryRepository(store, clock, ids),
  };
}

function deps(ctx: ReturnType<typeof openFile>) {
  return {
    projects: ctx.projects,
    activity: ctx.activity,
    deliveries: ctx.deliveries,
    transaction: ctx.store,
    clock: ctx.clock,
  };
}

async function seedMission(
  ctx: ReturnType<typeof openFile>,
  id: string,
  extra?: { executionMode?: 'lightweight' | 'standard' },
) {
  const project = await ctx.projects.ensure('P');
  const mission = project.createMission({
    id,
    contract: CONTRACT,
    origin,
    ...extra,
  });
  await ctx.projects.save(project);
  return mission;
}

function onDisk(path: string): {
  events: { kind: string; missionId: string; data?: { deliveryId?: string } }[];
  deliveries: { id: string; missionId: string; idempotencyKey: string; status: string }[];
} {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function recoveryCount(events: readonly { kind: string }[]): number {
  return events.filter((event) => event.kind === 'recovery.applied').length;
}

describe('DeliveryRepository.listForMission：含 acknowledged', () => {
  test('内存版：pending 与已确认都返回，不改 pending 语义', async () => {
    const repo = new InMemoryDeliveryRepository(new FixedClock(), new SequentialIds());
    const pending = await repo.create({
      missionId: 'M',
      projectId: 'P',
      recipient: 'me',
      outcome: 'escalated',
      idempotencyKey: 'escalated:0',
      summary: 'q0',
    });
    const acked = await repo.create({
      missionId: 'M',
      projectId: 'P',
      recipient: 'me',
      outcome: 'escalated',
      idempotencyKey: 'escalated:1',
      summary: 'q1',
    });
    await repo.acknowledge(acked.id);
    const listed = await repo.listForMission('M');
    assert.deepEqual(
      listed.map((row) => `${row.idempotencyKey}:${row.status}`).sort(),
      ['escalated:0:pending', 'escalated:1:acknowledged'],
    );
    assert.deepEqual(
      (await repo.pending('me')).map((row) => row.id),
      [pending.id],
    );
  });
});

describe('验收 1：文件版补升级投递，幂等，已有行不重投', () => {
  test('缺第一次/第二次升级分别补 escalated:0/1，正文和收件人正确', async () => {
    const path = tempState();
    const ctx = openFile(path);
    const mission = await seedMission(ctx, 'M-esc');
    mission.recordEscalation({
      attemptId: 'A-1',
      question: '第一问？',
      why: 'w1',
      optionsConsidered: ['x', 'y'],
    });
    mission.recordEscalation({
      attemptId: 'A-2',
      question: '第二问？',
      why: 'w2',
      optionsConsidered: ['a', 'b'],
    });
    await ctx.projects.save((await ctx.projects.get('P'))!);

    const report = await repairMissingDeliveries(deps(ctx));
    assert.deepEqual(
      report.created.map((row) => row.idempotencyKey).sort(),
      ['escalated:0', 'escalated:1'],
    );
    assert.equal(report.errors.length, 0);

    const rows = await ctx.deliveries.listForMission('M-esc');
    const byKey = new Map(rows.map((row) => [row.idempotencyKey, row]));
    assert.equal(byKey.get('escalated:0')?.recipient, 'me');
    assert.equal(byKey.get('escalated:0')?.outcome, 'escalated');
    assert.equal(byKey.get('escalated:0')?.summary, '第一问？\n\n为什么需要 L3：w1');
    assert.equal(byKey.get('escalated:1')?.summary, '第二问？\n\n为什么需要 L3：w2');
    assert.equal(byKey.get('escalated:1')?.status, 'pending');

    const events = await ctx.activity.list('M-esc');
    assert.equal(recoveryCount(events), 2);
    assert.equal(events.filter((event) => event.kind === 'delivery.created').length, 2);
  });

  test('重复运行及重开后均不增加投递或审计', async () => {
    const path = tempState();
    const ctx = openFile(path);
    const mission = await seedMission(ctx, 'M-esc');
    mission.recordEscalation({
      attemptId: 'A-1',
      question: '第一问？',
      why: 'w1',
      optionsConsidered: [],
    });
    mission.recordEscalation({
      attemptId: 'A-2',
      question: '第二问？',
      why: 'w2',
      optionsConsidered: [],
    });
    await ctx.projects.save((await ctx.projects.get('P'))!);
    await repairMissingDeliveries(deps(ctx));

    const again = await repairMissingDeliveries(deps(ctx));
    assert.equal(again.created.length, 0);
    assert.equal((await ctx.deliveries.listForMission('M-esc')).length, 2);
    assert.equal(recoveryCount(await ctx.activity.list('M-esc')), 2);

    const reopened = openFile(path);
    const third = await repairMissingDeliveries(deps(reopened));
    assert.equal(third.created.length, 0);
    assert.equal((await reopened.deliveries.listForMission('M-esc')).length, 2);
    assert.equal(recoveryCount(await reopened.activity.list('M-esc')), 2);
  });

  test('已有 pending 或 acknowledged 均不重投', async () => {
    const path = tempState();
    const ctx = openFile(path);
    const mission = await seedMission(ctx, 'M-esc');
    mission.recordEscalation({
      attemptId: 'A-1',
      question: '第一问？',
      why: 'w1',
      optionsConsidered: [],
    });
    mission.recordEscalation({
      attemptId: 'A-2',
      question: '第二问？',
      why: 'w2',
      optionsConsidered: [],
    });
    await ctx.projects.save((await ctx.projects.get('P'))!);
    const first = await ctx.deliveries.create({
      missionId: 'M-esc',
      projectId: 'P',
      recipient: 'me',
      outcome: 'escalated',
      idempotencyKey: 'escalated:0',
      summary: '已有 pending',
    });
    const second = await ctx.deliveries.create({
      missionId: 'M-esc',
      projectId: 'P',
      recipient: 'me',
      outcome: 'escalated',
      idempotencyKey: 'escalated:1',
      summary: '已有 ack',
    });
    await ctx.deliveries.acknowledge(second.id);

    const report = await repairMissingDeliveries(deps(ctx));
    assert.equal(report.created.length, 0);
    assert.equal(recoveryCount(await ctx.activity.list('M-esc')), 0);
    const rows = await ctx.deliveries.listForMission('M-esc');
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.id === first.id)?.status, 'pending');
    assert.equal(rows.find((row) => row.id === second.id)?.status, 'acknowledged');
  });
});

describe('验收 2：文件版补当前交卷，不可核实只报告 uncertain', () => {
  test('Standard 最新交卷取事件 attemptId 补 result:<id>，outcome/summary 来自当前 result', async () => {
    const path = tempState();
    const ctx = openFile(path);
    const mission = await seedMission(ctx, 'M-std');
    mission.recordResult(RESULT);
    mission.submitForReview();
    await ctx.projects.save((await ctx.projects.get('P'))!);
    await ctx.activity.append({
      projectId: 'P',
      missionId: 'M-std',
      attemptId: 'coord-9',
      kind: 'mission_result.submitted',
      data: { outcome: 'delivered', missionStatus: 'awaiting_review' },
    });

    const report = await repairMissingDeliveries(deps(ctx));
    assert.deepEqual(
      report.created.map((row) => row.idempotencyKey),
      ['result:coord-9'],
    );
    const [row] = await ctx.deliveries.listForMission('M-std');
    assert.equal(row?.outcome, 'delivered');
    assert.equal(row?.summary, '改好了');
    assert.equal(row?.recipient, 'me');
  });

  test('Lightweight 最新交卷取 data.reportId 补 result:<id>', async () => {
    const path = tempState();
    const ctx = openFile(path);
    const mission = await seedMission(ctx, 'M-lw', { executionMode: 'lightweight' });
    mission.recordResult(RESULT);
    mission.submitForReview();
    await ctx.projects.save((await ctx.projects.get('P'))!);
    await ctx.activity.append({
      projectId: 'P',
      missionId: 'M-lw',
      kind: 'mission_result.submitted',
      data: {
        outcome: 'delivered',
        missionStatus: 'awaiting_review',
        executionMode: 'lightweight',
        reportId: 'VR-77',
      },
    });

    const report = await repairMissingDeliveries(deps(ctx));
    assert.deepEqual(
      report.created.map((row) => row.idempotencyKey),
      ['result:VR-77'],
    );
  });

  test('缺身份、outcome 不匹配或较早交卷缺正文时报告 uncertain 而不杜撰', async () => {
    const path = tempState();
    const ctx = openFile(path);

    const missingId = await seedMission(ctx, 'M-noid');
    missingId.recordResult(RESULT);
    missingId.submitForReview();
    await ctx.activity.append({
      projectId: 'P',
      missionId: 'M-noid',
      kind: 'mission_result.submitted',
      data: { outcome: 'delivered', missionStatus: 'awaiting_review' },
    });

    const mismatch = await seedMission(ctx, 'M-mis');
    mismatch.recordResult(RESULT);
    mismatch.submitForReview();
    await ctx.activity.append({
      projectId: 'P',
      missionId: 'M-mis',
      attemptId: 'coord-x',
      kind: 'mission_result.submitted',
      data: { outcome: 'blocked', missionStatus: 'awaiting_review' },
    });

    const earlier = await seedMission(ctx, 'M-old');
    earlier.recordResult({ ...RESULT, summary: '第二次正文' });
    earlier.submitForReview();
    await ctx.activity.append({
      projectId: 'P',
      missionId: 'M-old',
      attemptId: 'coord-old',
      kind: 'mission_result.submitted',
      data: { outcome: 'delivered', missionStatus: 'awaiting_review' },
    });
    await ctx.activity.append({
      projectId: 'P',
      missionId: 'M-old',
      attemptId: 'coord-new',
      kind: 'mission_result.submitted',
      data: { outcome: 'delivered', missionStatus: 'awaiting_review' },
    });
    await ctx.projects.save((await ctx.projects.get('P'))!);

    const report = await repairMissingDeliveries(deps(ctx));
    assert.ok(report.uncertain.some((row) => row.missionId === 'M-noid' && row.reason.includes('缺少身份')));
    assert.equal((await ctx.deliveries.listForMission('M-noid')).length, 0);

    assert.ok(report.uncertain.some((row) => row.missionId === 'M-mis' && row.reason.includes('不一致')));
    assert.equal((await ctx.deliveries.listForMission('M-mis')).length, 0);

    assert.ok(report.uncertain.some((row) => row.missionId === 'M-old' && row.reason.includes('较早交卷')));
    const oldRows = await ctx.deliveries.listForMission('M-old');
    assert.deepEqual(
      oldRows.map((row) => row.idempotencyKey),
      ['result:coord-new'],
    );
    assert.equal(oldRows[0]?.summary, '第二次正文');
    assert.equal(
      oldRows.some((row) => row.idempotencyKey === 'result:coord-old'),
      false,
      '不得杜撰较早交卷的投递',
    );
  });
});

describe('验收 3：旧 result:legacy 归属与归档跳过', () => {
  test('旧 result:legacy 行能明确关联当前提交时不重复补', async () => {
    const path = tempState();
    const ctx = openFile(path);
    const mission = await seedMission(ctx, 'M-leg');
    mission.recordResult(RESULT);
    mission.submitForReview();
    await ctx.projects.save((await ctx.projects.get('P'))!);
    await ctx.activity.append({
      projectId: 'P',
      missionId: 'M-leg',
      attemptId: 'coord-now',
      kind: 'mission_result.submitted',
      data: { outcome: 'delivered', missionStatus: 'awaiting_review' },
    });
    const legacy = await ctx.deliveries.create({
      missionId: 'M-leg',
      projectId: 'P',
      recipient: 'me',
      outcome: 'delivered',
      idempotencyKey: 'result:legacy:delivered',
      summary: '旧行',
    });
    await ctx.activity.append({
      projectId: 'P',
      missionId: 'M-leg',
      kind: 'delivery.created',
      data: { deliveryId: legacy.id },
    });

    const report = await repairMissingDeliveries(deps(ctx));
    assert.equal(report.created.length, 0);
    assert.equal((await ctx.deliveries.listForMission('M-leg')).length, 1);
    assert.equal((await ctx.deliveries.get(legacy.id))?.status, 'pending');
  });

  test('能明确关联先前提交时允许补最新提交', async () => {
    const path = tempState();
    const ctx = openFile(path);
    const mission = await seedMission(ctx, 'M-leg2');
    mission.recordResult({ ...RESULT, summary: '最新正文' });
    mission.submitForReview();
    await ctx.projects.save((await ctx.projects.get('P'))!);
    await ctx.activity.append({
      projectId: 'P',
      missionId: 'M-leg2',
      attemptId: 'coord-old',
      kind: 'mission_result.submitted',
      data: { outcome: 'delivered', missionStatus: 'awaiting_review' },
    });
    const legacy = await ctx.deliveries.create({
      missionId: 'M-leg2',
      projectId: 'P',
      recipient: 'me',
      outcome: 'delivered',
      idempotencyKey: 'result:legacy:delivered',
      summary: '第一次的旧行',
    });
    await ctx.activity.append({
      projectId: 'P',
      missionId: 'M-leg2',
      kind: 'delivery.created',
      data: { deliveryId: legacy.id },
    });
    await ctx.activity.append({
      projectId: 'P',
      missionId: 'M-leg2',
      attemptId: 'coord-new',
      kind: 'mission_result.submitted',
      data: { outcome: 'delivered', missionStatus: 'awaiting_review' },
    });

    const report = await repairMissingDeliveries(deps(ctx));
    assert.ok(report.created.some((row) => row.idempotencyKey === 'result:coord-new'));
    const rows = await ctx.deliveries.listForMission('M-leg2');
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.idempotencyKey === 'result:coord-new')?.summary, '最新正文');
  });

  test('唯一一次同 outcome 交卷可将无 delivery.created 的 legacy 行无歧义归属，不重复补', async () => {
    const path = tempState();
    const ctx = openFile(path);
    const mission = await seedMission(ctx, 'M-uniq');
    mission.recordResult(RESULT);
    mission.submitForReview();
    await ctx.projects.save((await ctx.projects.get('P'))!);
    await ctx.activity.append({
      projectId: 'P',
      missionId: 'M-uniq',
      attemptId: 'coord-only',
      kind: 'mission_result.submitted',
      data: { outcome: 'delivered', missionStatus: 'awaiting_review' },
    });
    await ctx.deliveries.create({
      missionId: 'M-uniq',
      projectId: 'P',
      recipient: 'me',
      outcome: 'delivered',
      idempotencyKey: 'result:legacy:delivered',
      summary: '旧行',
    });

    const report = await repairMissingDeliveries(deps(ctx));
    assert.equal(report.created.length, 0);
    assert.equal((await ctx.deliveries.listForMission('M-uniq')).length, 1);
  });

  test('无法归属时报告 uncertain、不重复通知', async () => {
    const path = tempState();
    const ctx = openFile(path);
    const mission = await seedMission(ctx, 'M-amb');
    mission.recordResult(RESULT);
    mission.submitForReview();
    await ctx.projects.save((await ctx.projects.get('P'))!);
    await ctx.activity.append({
      projectId: 'P',
      missionId: 'M-amb',
      attemptId: 'coord-a',
      kind: 'mission_result.submitted',
      data: { outcome: 'delivered', missionStatus: 'awaiting_review' },
    });
    await ctx.activity.append({
      projectId: 'P',
      missionId: 'M-amb',
      attemptId: 'coord-b',
      kind: 'mission_result.submitted',
      data: { outcome: 'delivered', missionStatus: 'awaiting_review' },
    });
    await ctx.deliveries.create({
      missionId: 'M-amb',
      projectId: 'P',
      recipient: 'me',
      outcome: 'delivered',
      idempotencyKey: 'result:legacy:delivered',
      summary: '不知属于哪一次',
    });

    const report = await repairMissingDeliveries(deps(ctx));
    assert.equal(report.created.length, 0);
    assert.ok(report.uncertain.some((row) => row.missionId === 'M-amb' && row.reason.includes('无法归属')));
    assert.equal((await ctx.deliveries.listForMission('M-amb')).length, 1);
  });

  test('归档 Mission 不写投递/事件、不改 package/hash', async () => {
    const path = tempState();
    const ctx = openFile(path);
    const mission = await seedMission(ctx, 'M-arch');
    mission.recordEscalation({
      attemptId: 'A-1',
      question: '归档前的问？',
      why: 'why',
      optionsConsidered: [],
    });
    mission.recordResult(RESULT);
    mission.submitForReview();
    mission.complete({ verdict: 'merge', reasons: ['ok'] });
    await ctx.projects.save((await ctx.projects.get('P'))!);
    ctx.store.archiveMission('P', 'M-arch');

    const pkg = join(dirname(path), '.coagent-archive', 'missions', 'P', 'M-arch.json');
    assert.equal(existsSync(pkg), true);
    const before = createHash('sha256').update(readFileSync(pkg)).digest('hex');
    const diskBefore = readFileSync(path, 'utf8');

    const report = await repairMissingDeliveries(deps(ctx));
    assert.ok(report.skipped.some((row) => row.missionId === 'M-arch'));
    assert.equal(report.created.length, 0);
    assert.equal(createHash('sha256').update(readFileSync(pkg)).digest('hex'), before);
    assert.equal(readFileSync(path, 'utf8'), diskBefore);
    assert.equal((await ctx.deliveries.listForMission('M-arch')).length, 0);
  });
});

describe('验收 4：故障注入全无；成功时一条投递一条 recovery.applied', () => {
  test('追加 recovery.applied 失败：重开后投递与两个事件全无', async () => {
    const path = tempState();
    const ctx = openFile(path);
    const mission = await seedMission(ctx, 'M-crash');
    mission.recordEscalation({
      attemptId: 'A-1',
      question: '崩？',
      why: 'w',
      optionsConsidered: [],
    });
    await ctx.projects.save((await ctx.projects.get('P'))!);

    const activity: ActivityLog = {
      async append(event) {
        if (event.kind === 'recovery.applied') throw new Error('CRASH before recovery.applied');
        return ctx.activity.append(event);
      },
      list: (missionId) => ctx.activity.list(missionId),
    };
    const report = await repairMissingDeliveries({
      ...deps(ctx),
      activity,
    });
    assert.ok(report.errors.some((row) => row.missionId === 'M-crash'));

    const reopened = openFile(path);
    assert.equal((await reopened.deliveries.listForMission('M-crash')).length, 0);
    const events = await reopened.activity.list('M-crash');
    assert.equal(events.filter((event) => event.kind === 'delivery.created').length, 0);
    assert.equal(recoveryCount(events), 0);
  });

  test('事务提交失败：重开后投递与两个事件全无', async () => {
    const path = tempState();
    const ctx = openFile(path);
    const mission = await seedMission(ctx, 'M-commit');
    mission.recordEscalation({
      attemptId: 'A-1',
      question: '提交失败？',
      why: 'w',
      optionsConsidered: [],
    });
    await ctx.projects.save((await ctx.projects.get('P'))!);
    const diskBefore = readFileSync(path, 'utf8');

    mkdirSync(`${path}.tmp`);
    try {
      const report = await repairMissingDeliveries(deps(ctx));
      assert.ok(report.errors.length > 0);
      assert.equal(readFileSync(path, 'utf8'), diskBefore);
    } finally {
      rmSync(`${path}.tmp`, { recursive: true, force: true });
    }

    const reopened = openFile(path);
    assert.equal((await reopened.deliveries.listForMission('M-commit')).length, 0);
    const events = await reopened.activity.list('M-commit');
    assert.equal(events.filter((event) => event.kind === 'delivery.created').length, 0);
    assert.equal(recoveryCount(events), 0);
  });

  test('成功时每条新增投递恰好一条 recovery.applied；重复执行无新增审计', async () => {
    const path = tempState();
    const ctx = openFile(path);
    const mission = await seedMission(ctx, 'M-ok');
    mission.recordEscalation({
      attemptId: 'A-1',
      question: '一？',
      why: 'w1',
      optionsConsidered: [],
    });
    mission.recordEscalation({
      attemptId: 'A-2',
      question: '二？',
      why: 'w2',
      optionsConsidered: [],
    });
    await ctx.projects.save((await ctx.projects.get('P'))!);

    await repairMissingDeliveries(deps(ctx));
    const events = await ctx.activity.list('M-ok');
    const created = events.filter((event) => event.kind === 'delivery.created');
    const applied = events.filter((event) => event.kind === 'recovery.applied');
    assert.equal(created.length, 2);
    assert.equal(applied.length, 2);
    assert.deepEqual(
      applied.map((event) => (event.data as { deliveryId: string }).deliveryId).sort(),
      created.map((event) => (event.data as { deliveryId: string }).deliveryId).sort(),
    );

    await repairMissingDeliveries(deps(ctx));
    assert.equal(recoveryCount(await ctx.activity.list('M-ok')), 2);
    assert.equal(onDisk(path).deliveries.length, 2);
  });
});

describe('补建不改 Mission 状态、不把已确认恢复成 pending', () => {
  test('已确认行保持 acknowledged', async () => {
    const path = tempState();
    const ctx = openFile(path);
    const mission = await seedMission(ctx, 'M-ack');
    mission.recordEscalation({
      attemptId: 'A-1',
      question: 'q',
      why: 'w',
      optionsConsidered: [],
    });
    mission.recordResult(RESULT);
    mission.submitForReview();
    const statusBefore = mission.status;
    await ctx.projects.save((await ctx.projects.get('P'))!);
    const row = await ctx.deliveries.create({
      missionId: 'M-ack',
      projectId: 'P',
      recipient: 'me',
      outcome: 'escalated',
      idempotencyKey: 'escalated:0',
      summary: 'q\n\n为什么需要 L3：w',
    });
    await ctx.deliveries.acknowledge(row.id);

    await repairMissingDeliveries(deps(ctx));
    assert.equal((await ctx.deliveries.get(row.id))?.status, 'acknowledged');
    assert.equal((await ctx.projects.get('P'))?.missions.find((item) => item.id === 'M-ack')?.status, statusBefore);
  });
});
