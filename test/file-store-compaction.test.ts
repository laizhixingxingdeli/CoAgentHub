/**
 * OPS-002 B：显式 archiveMission 写入路径。
 *
 * 锁：eligible 终态可归档；pending/in_progress/非终态拒绝；package 先写 main 后裁；
 * 幂等 / 同 payload 复用 / 冲突 hard fail / COMPACT_RACE；归档后 append/create 拒绝。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), 'coagent-compact-'));
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
  intent: '归档压测',
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

const BIG = 'X'.repeat(8_192);

function buildTerminalMission(
  projectId: string,
  missionId: string,
  status: 'completed' | 'blocked' = 'completed',
  pad = BIG,
): MissionSnapshot {
  const project = Project.create({ id: projectId });
  const mission = project.createMission({
    id: missionId,
    contract: { ...CONTRACT, intent: `${CONTRACT.intent}:${missionId}:${pad.slice(0, 64)}` },
    origin: { clientType: 'claude-code', conversationRef: `conv-${missionId}` },
  });
  mission.touch('2026-01-01T00:00:00.000Z');
  mission.startPlanning();
  mission.updatePlan({ ...PLAN, findings: `${PLAN.findings}:${pad}` });

  const coord = mission.startCoordinatorAttempt();
  coord.recordUsage(USAGE);
  coord.recordEndReason('structured_submit');
  coord.succeed();

  mission.startExecuting();
  const item = mission.createWorkItem({ id: `W-${missionId}`, title: `work ${missionId}` });
  item.dispatch();
  const attempt = item.startAttempt();
  attempt.addEvidence({
    id: `E-${missionId}`,
    attemptId: attempt.id,
    kind: 'test',
    summary: `evidence ${missionId} ${pad}`,
    command: 'node --test',
    exitCode: 0,
  });
  attempt.recordUsage(USAGE);
  attempt.recordEndReason('structured_submit');
  attempt.succeed();
  item.submit({
    outcome: 'completed',
    summary: `done ${pad}`,
    changedFiles: ['src/foo.ts'],
    evidenceIds: [`E-${missionId}`],
    notes: pad,
  });
  item.review('accept', { attemptId: attempt.id, reasons: ['ok'], requiredChanges: [] });

  mission.recordResult({
    outcome: status === 'blocked' ? 'blocked' : 'delivered',
    summary: `result ${pad}`,
    acceptanceEvidence: [pad],
    memoryDelta: [],
    openRisks: [],
  });
  mission.submitForReview();
  if (status === 'blocked') {
    mission.block({ verdict: 'block', reasons: ['blocked-for-test'] });
  } else {
    mission.complete({ verdict: 'merge', reasons: ['ok'] });
  }
  return mission.toSnapshot();
}

function buildActiveMission(projectId: string, missionId: string): MissionSnapshot {
  const project = Project.create({ id: projectId });
  const mission = project.createMission({
    id: missionId,
    contract: { ...CONTRACT, intent: `active:${missionId}` },
    origin: { clientType: 'claude-code', conversationRef: `conv-${missionId}` },
  });
  mission.touch('2026-02-01T00:00:00.000Z');
  return mission.toSnapshot();
}

function buildPausedMission(projectId: string, missionId: string): MissionSnapshot {
  const project = Project.create({ id: projectId });
  const mission = project.createMission({
    id: missionId,
    contract: { ...CONTRACT, intent: `paused:${missionId}` },
    origin: { clientType: 'claude-code', conversationRef: `conv-${missionId}` },
  });
  mission.touch('2026-02-01T00:00:00.000Z');
  mission.pause();
  return mission.toSnapshot();
}

/** completed 但硬塞一个 in_progress attempt，绕过领域流转。 */
function buildTerminalWithInProgress(projectId: string, missionId: string): MissionSnapshot {
  const snap = buildTerminalMission(projectId, missionId, 'completed', 'small');
  snap.coordinatorAttempts.push({
    id: 'coord-zombie',
    kind: 'coordinator',
    missionId,
    status: 'in_progress',
    evidence: [],
    usage: {},
  });
  return snap;
}

function missionEvents(projectId: string, missionId: string, pad = BIG): ActivityEvent[] {
  return [
    {
      at: '2026-01-01T00:00:00.000Z',
      projectId,
      missionId,
      kind: 'mission.created',
      data: { pad },
    },
    {
      at: '2026-01-01T00:01:00.000Z',
      projectId,
      missionId,
      kind: 'attempt.ended',
      data: { pad },
    },
  ];
}

function ackDelivery(projectId: string, missionId: string, id: string): Delivery {
  return {
    id,
    missionId,
    projectId,
    recipient: `conv-${missionId}`,
    outcome: 'delivered',
    summary: `ack ${missionId}`,
    createdAt: '2026-01-01T00:02:00.000Z',
    status: 'acknowledged',
    acknowledgedAt: '2026-01-01T00:03:00.000Z',
  };
}

function pendingDelivery(projectId: string, missionId: string, id: string): Delivery {
  return {
    id,
    missionId,
    projectId,
    recipient: `conv-${missionId}`,
    outcome: 'delivered',
    summary: `pending ${missionId}`,
    createdAt: '2026-01-01T00:02:00.000Z',
    status: 'pending',
  };
}

interface FixtureMission {
  id: string;
  snap: MissionSnapshot;
  events: ActivityEvent[];
  deliveries: Delivery[];
}

function writeFixture(statePath: string): {
  beforeBytes: number;
  missions: Record<string, FixtureMission>;
} {
  const mBig1 = buildTerminalMission('P1', 'M-big-1', 'completed');
  const mBig2 = buildTerminalMission('P1', 'M-big-2', 'blocked');
  const mActive = buildActiveMission('P1', 'M-active');
  const mPending = buildTerminalMission('P1', 'M-pending', 'completed', 'pending-pad');
  const mInProg = buildTerminalWithInProgress('P1', 'M-inprog');
  const mPaused = buildPausedMission('P1', 'M-paused');

  const missions: Record<string, FixtureMission> = {
    'M-big-1': {
      id: 'M-big-1',
      snap: mBig1,
      events: missionEvents('P1', 'M-big-1'),
      deliveries: [ackDelivery('P1', 'M-big-1', 'D-big-1')],
    },
    'M-big-2': {
      id: 'M-big-2',
      snap: mBig2,
      events: missionEvents('P1', 'M-big-2'),
      deliveries: [ackDelivery('P1', 'M-big-2', 'D-big-2')],
    },
    'M-active': {
      id: 'M-active',
      snap: mActive,
      events: missionEvents('P1', 'M-active', 'active'),
      deliveries: [],
    },
    'M-pending': {
      id: 'M-pending',
      snap: mPending,
      events: missionEvents('P1', 'M-pending', 'pend'),
      deliveries: [pendingDelivery('P1', 'M-pending', 'D-pending')],
    },
    'M-inprog': {
      id: 'M-inprog',
      snap: mInProg,
      events: missionEvents('P1', 'M-inprog', 'inprog'),
      deliveries: [ackDelivery('P1', 'M-inprog', 'D-inprog')],
    },
    'M-paused': {
      id: 'M-paused',
      snap: mPaused,
      events: missionEvents('P1', 'M-paused', 'paused'),
      deliveries: [],
    },
  };

  const state = {
    version: 1 as const,
    projects: [
      {
        id: 'P1',
        missions: Object.values(missions).map((m) => m.snap),
      },
    ],
    deliveries: Object.values(missions).flatMap((m) => m.deliveries),
    events: Object.values(missions).flatMap((m) => m.events),
    idCounters: {},
    agentPool: [],
    archivedMissions: [],
  };
  const body = `${JSON.stringify(state, null, 2)}\n`;
  writeFileSync(statePath, body, 'utf8');
  return { beforeBytes: Buffer.byteLength(body, 'utf8'), missions };
}

function readMain(statePath: string) {
  return JSON.parse(readFileSync(statePath, 'utf8')) as {
    projects: { id: string; missions: { id: string }[] }[];
    events: { missionId: string }[];
    deliveries: { missionId: string; id: string; status: string }[];
    archivedMissions: {
      projectId: string;
      missionId: string;
      archivedAt: string;
      bytes: number;
      sha256: string;
    }[];
  };
}

function packagePath(statePath: string, projectId: string, missionId: string): string {
  return join(dirname(statePath), '.coagent-archive', 'missions', projectId, `${missionId}.json`);
}

function mainMissionIds(statePath: string): string[] {
  const main = readMain(statePath);
  return main.projects.flatMap((p) => p.missions.map((m) => m.id)).sort();
}

describe('file-store archiveMission compaction', () => {
  test('eligible 归档：main 裁掉完整体；读语义不变；重开完整；报告 bytes', async () => {
    const dir = tempDir();
    const statePath = join(dir, 'state.json');
    const { beforeBytes } = writeFixture(statePath);

    const store = new FileStateStore(statePath);
    const projects = new FileProjectRepository(store);
    const activity = new FileActivityLog(store, FIXED_CLOCK);
    const deliveries = new FileDeliveryRepository(store, FIXED_CLOCK, FIXED_IDS);

    store.archiveMission('P1', 'M-big-1');
    store.archiveMission('P1', 'M-big-2');

    const afterBytes = statSync(statePath).size;
    const pkg1 = statSync(packagePath(statePath, 'P1', 'M-big-1')).size;
    const pkg2 = statSync(packagePath(statePath, 'P1', 'M-big-2')).size;
    const saved = beforeBytes - afterBytes;

    console.log(
      JSON.stringify({
        compactReport: {
          mainBytesBefore: beforeBytes,
          mainBytesAfter: afterBytes,
          mainBytesSaved: saved,
          archivePackageBytes: { 'M-big-1': pkg1, 'M-big-2': pkg2 },
        },
      }),
    );

    assert.ok(saved > 0, `main working-set 应下降，before=${beforeBytes} after=${afterBytes}`);
    assert.ok(pkg1 > 0 && pkg2 > 0);

    const main = readMain(statePath);
    assert.deepEqual(main.projects[0].missions.map((m) => m.id).sort(), [
      'M-active',
      'M-inprog',
      'M-paused',
      'M-pending',
    ]);
    assert.equal(main.events.every((e) => e.missionId !== 'M-big-1' && e.missionId !== 'M-big-2'), true);
    assert.equal(
      main.deliveries.every((d) => d.missionId !== 'M-big-1' && d.missionId !== 'M-big-2'),
      true,
    );
    assert.equal(main.archivedMissions.length, 2);
    assert.equal(main.archivedMissions.some((r) => r.missionId === 'M-big-1'), true);
    assert.equal(main.archivedMissions.some((r) => r.missionId === 'M-big-2'), true);

    // 内存 / 读路径仍完整
    const listed = await projects.list();
    const ids = listed[0]!.missions.map((m) => m.id).sort();
    assert.ok(ids.includes('M-big-1') && ids.includes('M-big-2') && ids.includes('M-active'));

    const arch = (await projects.get('P1'))!.missions.find((m) => m.id === 'M-big-1');
    assert.equal(arch?.status, 'completed');
    assert.ok(String(arch?.workItems[0]?.attempts[0]?.evidence[0]?.summary ?? '').includes('M-big-1'));

    const events = await activity.list('M-big-1');
    assert.equal(events.length, 2);
    assert.equal(events[0]!.data.pad, BIG);

    const d = await deliveries.get('D-big-1');
    assert.equal(d?.status, 'acknowledged');
    assert.equal(d?.summary, 'ack M-big-1');

    // 重开
    const reopened = new FileStateStore(statePath);
    const again = await new FileProjectRepository(reopened).get('P1');
    assert.ok(again?.missions.some((m) => m.id === 'M-big-1'));
    assert.ok(again?.missions.some((m) => m.id === 'M-big-2'));
    assert.equal(
      (await new FileActivityLog(reopened, FIXED_CLOCK).list('M-big-2')).length,
      2,
    );
    assert.equal(
      (await new FileDeliveryRepository(reopened, FIXED_CLOCK, FIXED_IDS).get('D-big-2'))?.id,
      'D-big-2',
    );
  });

  test('active/paused/pending/in_progress 拒绝且 main 不变', () => {
    const dir = tempDir();
    const statePath = join(dir, 'state.json');
    writeFixture(statePath);
    const before = readFileSync(statePath, 'utf8');
    const store = new FileStateStore(statePath);

    assert.throws(() => store.archiveMission('P1', 'M-active'), /非终态/);
    assert.throws(() => store.archiveMission('P1', 'M-paused'), /已暂停/);
    assert.throws(() => store.archiveMission('P1', 'M-pending'), /未确认投递/);
    assert.throws(() => store.archiveMission('P1', 'M-inprog'), /进行中的 Attempt/);

    assert.equal(readFileSync(statePath, 'utf8'), before);
    assert.equal(existsSync(packagePath(statePath, 'P1', 'M-active')), false);
    assert.deepEqual(mainMissionIds(statePath).includes('M-big-1'), true);
  });

  test('归档后 activity append / delivery create 拒绝；acknowledge 只动 main', async () => {
    const dir = tempDir();
    const statePath = join(dir, 'state.json');
    writeFixture(statePath);
    const store = new FileStateStore(statePath);
    store.archiveMission('P1', 'M-big-1');

    const activity = new FileActivityLog(store, FIXED_CLOCK);
    const deliveries = new FileDeliveryRepository(store, FIXED_CLOCK, FIXED_IDS);

    await assert.rejects(
      () =>
        activity.append({
          projectId: 'P1',
          missionId: 'M-big-1',
          kind: 'mission.note',
          data: {},
        }),
      /已归档 Mission 不可追加事件/,
    );

    await assert.rejects(
      () =>
        deliveries.create({
          missionId: 'M-big-1',
          projectId: 'P1',
          recipient: 'conv-M-big-1',
          outcome: 'delivered',
          summary: 'nope',
        }),
      /已归档 Mission 不可新建投递/,
    );

    // archived delivery 只读：acknowledge 找不到 main 行
    const ackArchived = await deliveries.acknowledge('D-big-1');
    assert.equal(ackArchived, undefined);
    assert.equal((await deliveries.get('D-big-1'))?.status, 'acknowledged');

    // main pending 仍可确认
    const ackPending = await deliveries.acknowledge('D-pending');
    assert.equal(ackPending?.status, 'acknowledged');
    const main = readMain(statePath);
    assert.equal(main.deliveries.find((d) => d.id === 'D-pending')?.status, 'acknowledged');
  });

  test('已存在同 payload package 可恢复 crash window；冲突 hard fail', () => {
    const dir = tempDir();
    const statePath = join(dir, 'state.json');
    const { missions } = writeFixture(statePath);
    const store = new FileStateStore(statePath);

    // 模拟 crash window：package 已写、index 未加
    const m = missions['M-big-1']!;
    const archivedAt = '2026-01-05T00:00:00.000Z';
    const pkg = {
      version: 1 as const,
      projectId: 'P1',
      missionId: 'M-big-1',
      archivedAt,
      mission: m.snap,
      events: m.events,
      deliveries: m.deliveries,
    };
    const body = `${JSON.stringify(pkg)}\n`;
    const p = packagePath(statePath, 'P1', 'M-big-1');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
    const sha = createHash('sha256').update(body).digest('hex');
    const bytes = Buffer.byteLength(body, 'utf8');

    store.archiveMission('P1', 'M-big-1');

    const main = readMain(statePath);
    const ref = main.archivedMissions.find((r) => r.missionId === 'M-big-1');
    assert.ok(ref);
    assert.equal(ref.archivedAt, archivedAt, '复用已有 archivedAt');
    assert.equal(ref.sha256, sha);
    assert.equal(ref.bytes, bytes);
    assert.equal(readFileSync(p, 'utf8'), body, '不改 package bytes');

    // payload 冲突
    const dir2 = tempDir();
    const statePath2 = join(dir2, 'state.json');
    writeFixture(statePath2);
    const store2 = new FileStateStore(statePath2);
    const conflictPath = packagePath(statePath2, 'P1', 'M-big-2');
    mkdirSync(dirname(conflictPath), { recursive: true });
    const conflictPkg = {
      version: 1 as const,
      projectId: 'P1',
      missionId: 'M-big-2',
      archivedAt: '2026-01-06T00:00:00.000Z',
      mission: missions['M-big-2']!.snap,
      events: missions['M-big-2']!.events,
      deliveries: [
        {
          ...missions['M-big-2']!.deliveries[0]!,
          summary: 'different-payload',
        },
      ],
    };
    writeFileSync(conflictPath, `${JSON.stringify(conflictPkg)}\n`, 'utf8');
    const before2 = readFileSync(statePath2, 'utf8');
    assert.throws(() => store2.archiveMission('P1', 'M-big-2'), /COMPACT_PACKAGE_CONFLICT/);
    assert.equal(readFileSync(statePath2, 'utf8'), before2);
    assert.equal(readMain(statePath2).archivedMissions.length, 0);
  });

  test('重复 archive 幂等；index 不重复；package hash 稳定', () => {
    const dir = tempDir();
    const statePath = join(dir, 'state.json');
    writeFixture(statePath);
    const store = new FileStateStore(statePath);

    store.archiveMission('P1', 'M-big-1');
    const main1 = readMain(statePath);
    const ref1 = main1.archivedMissions.find((r) => r.missionId === 'M-big-1')!;
    const pkgBody1 = readFileSync(packagePath(statePath, 'P1', 'M-big-1'));

    store.archiveMission('P1', 'M-big-1');
    store.archiveMission('P1', 'M-big-1');

    const main2 = readMain(statePath);
    assert.equal(main2.archivedMissions.filter((r) => r.missionId === 'M-big-1').length, 1);
    assert.deepEqual(
      main2.archivedMissions.find((r) => r.missionId === 'M-big-1'),
      ref1,
    );
    assert.deepEqual(readFileSync(packagePath(statePath, 'P1', 'M-big-1')), pkgBody1);
  });

  test('main mtime race => COMPACT_RACE，main 不裁，之后可 retry', () => {
    const dir = tempDir();
    const statePath = join(dir, 'state.json');
    writeFixture(statePath);
    const store = new FileStateStore(statePath);

    const beforeIds = mainMissionIds(statePath);
    const before = readFileSync(statePath, 'utf8');

    // 跳过 refresh，制造 stamp 与磁盘 mtime 不一致的窗口。
    store.refreshIfChanged = () => {};
    const future = new Date(Date.now() + 60_000);
    utimesSync(statePath, future, future);

    assert.throws(() => store.archiveMission('P1', 'M-big-1'), /COMPACT_RACE/);

    // race 后重载 canonical：main 未裁（可能 stamp 已同步）
    assert.deepEqual(mainMissionIds(statePath), beforeIds);
    // 内容仍含完整 mission（utimes 不改内容）
    assert.equal(JSON.parse(before).projects[0].missions.some((m: { id: string }) => m.id === 'M-big-1'), true);

    // package 可能已落下（race 在 package 之后），允许复用 retry
    const retry = new FileStateStore(statePath);
    retry.archiveMission('P1', 'M-big-1');
    assert.equal(mainMissionIds(statePath).includes('M-big-1'), false);
    assert.equal(readMain(statePath).archivedMissions.some((r) => r.missionId === 'M-big-1'), true);
    assert.ok(existsSync(packagePath(statePath, 'P1', 'M-big-1')));
  });

  test('path traversal id 拒绝', () => {
    const dir = tempDir();
    const statePath = join(dir, 'state.json');
    writeFixture(statePath);
    const store = new FileStateStore(statePath);
    const before = readFileSync(statePath, 'utf8');

    assert.throws(() => store.archiveMission('../evil', 'M-big-1'), /archive project id 非法/);
    assert.throws(() => store.archiveMission('P1', '../M-big-1'), /archive mission id 非法/);
    assert.throws(() => store.archiveMission('P1', 'M/arch'), /archive mission id 非法/);
    assert.equal(readFileSync(statePath, 'utf8'), before);
  });
});
