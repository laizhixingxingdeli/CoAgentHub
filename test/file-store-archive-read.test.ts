/**
 * archive 已存在时的 read/hydrate/flush 基础。
 *
 * 不测 compact/archiveMission 写入路径：这里只锁「main 索引 + 旁路 package」
 * 能完整读回，且 flush 不会把 archived 重新嵌进 main。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  FileActivityLog,
  FileDeliveryRepository,
  FileProjectRepository,
  FileStateStore,
} from '../src/application/file-store.ts';
import { Project } from '../src/kernel/index.ts';
import type { MissionSnapshot } from '../src/kernel/snapshot.ts';
import type { ActivityEvent } from '../src/application/ports.ts';
import type { Delivery } from '../src/application/delivery.ts';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-archive-read-'));
  dirs.push(dir);
  return dir;
}

const FIXED_CLOCK = { now: () => new Date('2026-03-21T00:00:00.000Z') };
const FIXED_IDS = {
  n: 0,
  next(prefix: string) {
    this.n += 1;
    return `${prefix}-${this.n}`;
  },
};

const CONTRACT = {
  intent: '归档样例',
  acceptance: ['ok'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const PLAN = {
  findings: 'f',
  rootCause: 'r',
  rejectedHypotheses: [] as string[],
  decisions: [] as string[],
  direction: 'd',
  risks: [] as string[],
};

const USAGE = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  total: 15,
  cost: 0,
  quality: 'reported' as const,
};

/** 用 Domain 走合法流转，生成可 restore 的终态快照（含 attempt evidence）。 */
function buildTerminalMission(projectId = 'P1', missionId = 'M-arch'): MissionSnapshot {
  const project = Project.create({ id: projectId });
  const mission = project.createMission({
    id: missionId,
    contract: CONTRACT,
    origin: { clientType: 'claude-code', conversationRef: 'conv-arch' },
  });
  mission.touch('2026-01-01T00:00:00.000Z');
  mission.startPlanning();
  mission.updatePlan(PLAN);

  const coord = mission.startCoordinatorAttempt();
  coord.recordUsage(USAGE);
  coord.recordEndReason('structured_submit');
  coord.succeed();

  mission.startExecuting();
  const item = mission.createWorkItem({ id: 'W-1', title: 'archived work' });
  item.dispatch();
  const attempt = item.startAttempt();
  attempt.addEvidence({
    id: 'E-1',
    attemptId: attempt.id,
    kind: 'test',
    summary: 'node --test 全绿',
    command: 'node --test',
    exitCode: 0,
  });
  attempt.recordUsage(USAGE);
  attempt.recordEndReason('structured_submit');
  attempt.succeed();
  item.submit({
    outcome: 'completed',
    summary: '改好了',
    changedFiles: ['src/foo.ts'],
    evidenceIds: ['E-1'],
    notes: '',
  });
  item.review('accept', { attemptId: attempt.id, reasons: ['ok'], requiredChanges: [] });

  mission.recordResult({
    outcome: 'delivered',
    summary: 'done',
    acceptanceEvidence: ['e'],
    memoryDelta: [],
    openRisks: [],
  });
  mission.submitForReview();
  mission.complete({ verdict: 'merge', reasons: ['ok'] });
  return mission.toSnapshot();
}

function buildLiveMission(projectId = 'P1', missionId = 'M-live'): MissionSnapshot {
  const project = Project.create({ id: projectId });
  const mission = project.createMission({
    id: missionId,
    contract: { ...CONTRACT, intent: '在途' },
    origin: { clientType: 'claude-code', conversationRef: 'conv-live' },
  });
  mission.touch('2026-02-01T00:00:00.000Z');
  return mission.toSnapshot();
}

function packageEvents(projectId: string, missionId: string): ActivityEvent[] {
  return [
    {
      at: '2026-01-01T00:00:00.000Z',
      projectId,
      missionId,
      kind: 'mission.created',
      data: { source: 'archive-fixture' },
    },
    {
      at: '2026-01-01T00:01:00.000Z',
      projectId,
      missionId,
      attemptId: 'W-1.exec-1',
      kind: 'attempt.ended',
      data: { evidence: 'node --test 全绿' },
    },
  ];
}

function packageDeliveries(projectId: string, missionId: string): Delivery[] {
  return [
    {
      id: 'D-arch-1',
      missionId,
      projectId,
      recipient: 'conv-arch',
      outcome: 'delivered',
      summary: '归档投递',
      createdAt: '2026-01-01T00:02:00.000Z',
      status: 'acknowledged',
      acknowledgedAt: '2026-01-01T00:03:00.000Z',
    },
  ];
}

interface PackageOpts {
  projectId?: string;
  missionId?: string;
  archivedAt?: string;
  mission?: MissionSnapshot;
  events?: ActivityEvent[];
  deliveries?: Delivery[];
  sha256?: string;
  bytes?: number;
  skipPackage?: boolean;
  packageBody?: string;
  /** 写进 package JSON 的 archivedAt；缺省跟 ref 一致。 */
  packageArchivedAt?: string;
}

function writeArchivePackage(statePath: string, opts: PackageOpts = {}) {
  const projectId = opts.projectId ?? 'P1';
  const missionId = opts.missionId ?? 'M-arch';
  const archivedAt = opts.archivedAt ?? '2026-01-02T00:00:00.000Z';
  const mission = opts.mission ?? buildTerminalMission(projectId, missionId);
  const pkg = {
    version: 1 as const,
    projectId,
    missionId,
    archivedAt: opts.packageArchivedAt ?? archivedAt,
    mission,
    events: opts.events ?? packageEvents(projectId, missionId),
    deliveries: opts.deliveries ?? packageDeliveries(projectId, missionId),
  };
  const body = opts.packageBody ?? `${JSON.stringify(pkg)}\n`;
  const bytesBuf = Buffer.from(body, 'utf8');
  const sha256 = opts.sha256 ?? createHash('sha256').update(bytesBuf).digest('hex');
  const bytes = opts.bytes ?? bytesBuf.byteLength;

  if (!opts.skipPackage) {
    const dir = join(dirname(statePath), '.coagent-archive', 'missions', projectId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${missionId}.json`), body, 'utf8');
  }

  return {
    ref: { projectId, missionId, archivedAt, bytes, sha256 },
    pkg,
    body,
  };
}

function writeMainState(
  statePath: string,
  archivedMissions: unknown[],
  extra?: {
    projects?: unknown[];
    events?: unknown[];
    deliveries?: unknown[];
    omitArchivedField?: boolean;
  },
): void {
  const live = buildLiveMission();
  const state: Record<string, unknown> = {
    version: 1,
    projects: extra?.projects ?? [{ id: 'P1', missions: [live] }],
    deliveries: extra?.deliveries ?? [
      {
        id: 'D-live-1',
        missionId: 'M-live',
        projectId: 'P1',
        recipient: 'conv-live',
        outcome: 'delivered',
        summary: '在途',
        createdAt: '2026-02-01T00:00:00.000Z',
        status: 'pending',
      },
    ],
    events: extra?.events ?? [
      {
        at: '2026-02-01T00:00:00.000Z',
        projectId: 'P1',
        missionId: 'M-live',
        kind: 'mission.created',
        data: {},
      },
    ],
    idCounters: {},
    agentPool: [],
  };
  if (!extra?.omitArchivedField) state.archivedMissions = archivedMissions;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** 先用 File store 落一份合法 working 态，再手工挂上 package/index。 */
function openWithArchive(
  statePath: string,
  archivedMissions: unknown[],
  extra?: Parameters<typeof writeMainState>[2],
) {
  writeMainState(statePath, archivedMissions, extra);
  return new FileStateStore(statePath);
}

describe('file-store archive read model', () => {
  test('list/get/activity/delivery 读到 archive；flush 后 main 仍干净；重开完整', async () => {
    const dir = tempDir();
    const statePath = join(dir, 'state.json');
    const { ref } = writeArchivePackage(statePath);
    const store = openWithArchive(statePath, [ref]);
    const projects = new FileProjectRepository(store);
    const activity = new FileActivityLog(store, FIXED_CLOCK);
    const deliveries = new FileDeliveryRepository(store, FIXED_CLOCK, FIXED_IDS);

    const listed = await projects.list();
    assert.equal(listed.length, 1);
    const project = await projects.get('P1');
    assert.ok(project);
    assert.deepEqual(
      project.missions.map((m) => m.id).sort(),
      ['M-arch', 'M-live'],
    );

    const archived = project.missions.find((m) => m.id === 'M-arch');
    assert.ok(archived);
    assert.equal(archived.status, 'completed');
    const evidence = archived.workItems[0]?.attempts[0]?.evidence[0];
    assert.equal(evidence?.summary, 'node --test 全绿');
    assert.equal(evidence?.command, 'node --test');

    const archEvents = await activity.list('M-arch');
    assert.deepEqual(
      archEvents.map((e) => e.kind),
      ['mission.created', 'attempt.ended'],
    );
    assert.equal(archEvents[0].data.source, 'archive-fixture');

    const all = await activity.all();
    assert.deepEqual(
      all.map((e) => e.missionId),
      ['M-live', 'M-arch', 'M-arch'],
    );

    const archivedDelivery = await deliveries.get('D-arch-1');
    assert.ok(archivedDelivery);
    assert.equal(archivedDelivery.summary, '归档投递');
    assert.equal(archivedDelivery.status, 'acknowledged');
    // C1：加键之前写下的归档包，读出来的副本按旧规则补键（盘上的包有 sha256 钉着，不改——下面重开时会校验）。
    assert.equal(archivedDelivery.idempotencyKey, 'result:legacy:delivered');

    const pending = await deliveries.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, 'D-live-1');

    assert.equal(store.raw().events.every((e) => e.missionId !== 'M-arch'), true);
    assert.equal(store.raw().deliveries.every((d) => d.missionId !== 'M-arch'), true);

    projects.persist();

    const main = JSON.parse(readFileSync(statePath, 'utf8')) as {
      projects: { id: string; missions: { id: string }[] }[];
      events: { missionId: string }[];
      deliveries: { missionId: string }[];
      archivedMissions: unknown[];
    };
    assert.deepEqual(
      main.projects[0].missions.map((m) => m.id),
      ['M-live'],
    );
    assert.equal(main.events.every((e) => e.missionId !== 'M-arch'), true);
    assert.equal(main.deliveries.every((d) => d.missionId !== 'M-arch'), true);
    assert.equal(main.archivedMissions.length, 1);

    const reopened = new FileStateStore(statePath);
    const again = await new FileProjectRepository(reopened).get('P1');
    assert.ok(again?.missions.some((m) => m.id === 'M-arch'));
    const evidence2 = again!.missions.find((m) => m.id === 'M-arch')!.workItems[0].attempts[0]
      .evidence[0];
    assert.equal(evidence2.summary, 'node --test 全绿');
    assert.equal((await new FileActivityLog(reopened, FIXED_CLOCK).list('M-arch')).length, 2);
    assert.equal(
      (await new FileDeliveryRepository(reopened, FIXED_CLOCK, FIXED_IDS).get('D-arch-1'))?.id,
      'D-arch-1',
    );
  });

  test('archived 被内存改动后 save/persist/flush 拒绝，查询恢复原样', async () => {
    const dir = tempDir();
    const statePath = join(dir, 'state.json');
    const { ref } = writeArchivePackage(statePath);
    const store = openWithArchive(statePath, [ref]);
    const projects = new FileProjectRepository(store);
    const project = await projects.get('P1');
    assert.ok(project);

    const mutatedSnap = project.toSnapshot();
    const archived = mutatedSnap.missions.find((m) => m.id === 'M-arch');
    assert.ok(archived);
    archived.status = 'failed' as MissionSnapshot['status'];
    if (archived.result) {
      (archived.result as { summary: string }).summary = '被篡改';
    }

    await assert.rejects(() => projects.save(Project.restore(mutatedSnap)), /ARCHIVED_MISSION_MUTATED/);

    const afterSave = await projects.get('P1');
    const restored = afterSave?.missions.find((m) => m.id === 'M-arch');
    assert.equal(restored?.status, 'completed');
    assert.equal(restored?.result?.summary, 'done');

    // persist / flush 同样拒绝
    const again = await projects.get('P1');
    assert.ok(again);
    const snap2 = again.toSnapshot();
    const target = snap2.missions.find((m) => m.id === 'M-arch')!;
    target.result = { ...target.result!, summary: 'persist-tamper' };
    store.projectsMap().set(again.id, Project.restore(snap2));
    assert.throws(() => projects.persist(), /ARCHIVED_MISSION_MUTATED/);

    const afterPersist = await projects.get('P1');
    assert.equal(afterPersist?.missions.find((m) => m.id === 'M-arch')?.result?.summary, 'done');

    const main = JSON.parse(readFileSync(statePath, 'utf8')) as {
      projects: { missions: { id: string }[] }[];
    };
    assert.equal(
      main.projects[0].missions.some((m) => m.id === 'M-arch'),
      false,
      '失败的 flush 不得把 archived 写进 main',
    );
  });

  test('缺 package / hash / bytes / archivedAt / pending delivery / duplicate index / 非法 id 硬失败', () => {
    {
      const dir = tempDir();
      const statePath = join(dir, 'state.json');
      const { ref } = writeArchivePackage(statePath, { skipPackage: true });
      writeMainState(statePath, [ref]);
      assert.throws(() => new FileStateStore(statePath), /archive package 缺失/);
    }
    {
      const dir = tempDir();
      const statePath = join(dir, 'state.json');
      const { ref } = writeArchivePackage(statePath, { sha256: '0'.repeat(64) });
      writeMainState(statePath, [ref]);
      assert.throws(() => new FileStateStore(statePath), /archive package hash 不匹配/);
    }
    {
      const dir = tempDir();
      const statePath = join(dir, 'state.json');
      const { ref } = writeArchivePackage(statePath, { bytes: 1 });
      writeMainState(statePath, [ref]);
      assert.throws(() => new FileStateStore(statePath), /archive package bytes 不匹配/);
    }
    {
      const dir = tempDir();
      const statePath = join(dir, 'state.json');
      const { ref } = writeArchivePackage(statePath, {
        packageArchivedAt: '1999-01-01T00:00:00.000Z',
      });
      writeMainState(statePath, [ref]);
      assert.throws(() => new FileStateStore(statePath), /archive package archivedAt 与 index 不一致/);
    }
    {
      const dir = tempDir();
      const statePath = join(dir, 'state.json');
      const pending: Delivery[] = [
        {
          id: 'D-pending',
          missionId: 'M-arch',
          projectId: 'P1',
          recipient: 'conv-arch',
          outcome: 'delivered',
          summary: '未确认',
          createdAt: '2026-01-01T00:02:00.000Z',
          status: 'pending',
        },
      ];
      const { ref } = writeArchivePackage(statePath, { deliveries: pending });
      writeMainState(statePath, [ref]);
      assert.throws(() => new FileStateStore(statePath), /archive package 含未确认投递/);
    }
    {
      const dir = tempDir();
      const statePath = join(dir, 'state.json');
      const { ref } = writeArchivePackage(statePath);
      writeMainState(statePath, [ref, { ...ref }]);
      assert.throws(() => new FileStateStore(statePath), /archive index 重复/);
    }
    {
      const dir = tempDir();
      const statePath = join(dir, 'state.json');
      writeMainState(statePath, [
        {
          projectId: '../evil',
          missionId: 'M-arch',
          archivedAt: '2026-01-02T00:00:00.000Z',
          bytes: 2,
          sha256: '00',
        },
      ]);
      assert.throws(() => new FileStateStore(statePath), /archive project id 非法/);
    }
    {
      const dir = tempDir();
      const statePath = join(dir, 'state.json');
      writeMainState(statePath, [
        {
          projectId: 'P1',
          missionId: 'M/arch',
          archivedAt: '2026-01-02T00:00:00.000Z',
          bytes: 2,
          sha256: '00',
        },
      ]);
      assert.throws(() => new FileStateStore(statePath), /archive mission id 非法/);
    }
  });

  test('package version/id/mission/events 与 working 重复硬失败', () => {
    {
      const dir = tempDir();
      const statePath = join(dir, 'state.json');
      const mission = buildTerminalMission();
      const bad = {
        version: 2,
        projectId: 'P1',
        missionId: 'M-arch',
        archivedAt: '2026-01-02T00:00:00.000Z',
        mission,
        events: packageEvents('P1', 'M-arch'),
        deliveries: packageDeliveries('P1', 'M-arch'),
      };
      const body = `${JSON.stringify(bad)}\n`;
      const { ref } = writeArchivePackage(statePath, { packageBody: body });
      writeMainState(statePath, [ref]);
      assert.throws(() => new FileStateStore(statePath), /archive package 版本不认识/);
    }
    {
      const dir = tempDir();
      const statePath = join(dir, 'state.json');
      const mission = buildTerminalMission();
      const bad = {
        version: 1,
        projectId: 'P-other',
        missionId: 'M-arch',
        archivedAt: '2026-01-02T00:00:00.000Z',
        mission,
        events: packageEvents('P1', 'M-arch'),
        deliveries: packageDeliveries('P1', 'M-arch'),
      };
      const body = `${JSON.stringify(bad)}\n`;
      const { ref } = writeArchivePackage(statePath, { packageBody: body });
      writeMainState(statePath, [ref]);
      assert.throws(() => new FileStateStore(statePath), /archive package id 与 index 不一致/);
    }
    {
      const dir = tempDir();
      const statePath = join(dir, 'state.json');
      const mission = buildTerminalMission('P1', 'M-wrong');
      const { ref } = writeArchivePackage(statePath, { mission });
      writeMainState(statePath, [ref]);
      assert.throws(() => new FileStateStore(statePath), /archive package mission\.id 与 index 不一致/);
    }
    {
      const dir = tempDir();
      const statePath = join(dir, 'state.json');
      const mission = buildTerminalMission();
      const bad = {
        version: 1,
        projectId: 'P1',
        missionId: 'M-arch',
        archivedAt: '2026-01-02T00:00:00.000Z',
        mission,
        events: { not: 'array' },
        deliveries: packageDeliveries('P1', 'M-arch'),
      };
      const body = `${JSON.stringify(bad)}\n`;
      const { ref } = writeArchivePackage(statePath, { packageBody: body });
      writeMainState(statePath, [ref]);
      assert.throws(() => new FileStateStore(statePath), /archive package events 无效/);
    }
    {
      const dir = tempDir();
      const statePath = join(dir, 'state.json');
      const { ref } = writeArchivePackage(statePath);
      const archivedSnap = buildTerminalMission('P1', 'M-arch');
      writeMainState(statePath, [ref], {
        projects: [{ id: 'P1', missions: [buildLiveMission(), archivedSnap] }],
      });
      assert.throws(() => new FileStateStore(statePath), /archived mission 与 working 重复/);
    }
  });

  test('legacy version1 无 archivedMissions 字段仍可读', async () => {
    const dir = tempDir();
    const statePath = join(dir, 'state.json');
    const live = buildLiveMission('P-old', 'M-old');
    writeMainState(statePath, [], {
      projects: [{ id: 'P-old', missions: [live] }],
      events: [],
      deliveries: [],
      omitArchivedField: true,
    });

    const store = new FileStateStore(statePath);
    assert.deepEqual(store.raw().archivedMissions, []);
    const project = await new FileProjectRepository(store).get('P-old');
    assert.equal(project?.missions[0]?.id, 'M-old');
  });
});
