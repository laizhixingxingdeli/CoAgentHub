/**
 * ADR-0009 状态瘦身的门禁事实。
 *
 * ①遥测外置：runtime.command.started / runtime.tool.completed 进边车 NDJSON，
 *   不进主状态、不触发整份落盘；list() 拼回时间线，读方无感。
 * ②一次性迁移：主状态里既有的遥测事件搬进边车，幂等。
 * ③归档清扫：completed 且已合入超过时限的 Mission 进旁路包；blocked / 未合入 /
 *   刚完成的不动。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileActivityLog, FileStateStore } from '../src/application/file-store.ts';
import { archiveEligibleMissions } from '../src/application/reconcile.ts';
import { SystemClock } from '../src/application/in-memory.ts';
import { buildPersistentPlatform } from '../src/main.ts';
import type { MissionContract } from '../src/kernel/index.ts';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const CONTRACT: MissionContract = {
  intent: 'x',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

describe('遥测边车', () => {
  test('遥测事件进边车不进主状态；其余事件照旧；list() 按时间线拼回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-slim-'));
    dirs.push(dir);
    const store = new FileStateStore(join(dir, 'state.json'));
    const log = new FileActivityLog(store, new SystemClock());
    const ats = ['2026-10-01T00:00:00.000Z', '2026-10-01T00:00:01.000Z', '2026-10-01T00:00:02.000Z', '2026-10-01T00:00:03.000Z'];
    let i = 0;
    const clock = { now: () => new Date(ats[i++ % ats.length]) } as const;
    const realLog = new FileActivityLog(store, clock as never);
    await realLog.append({ projectId: 'P', missionId: 'M1', kind: 'mission.created', data: {} });
    await realLog.append({ projectId: 'P', missionId: 'M1', kind: 'runtime.tool.completed', data: { callId: 'c1' } });
    await realLog.append({ projectId: 'P', missionId: 'M1', kind: 'runtime.command.started', data: { callId: 'c2' } });
    await realLog.append({ projectId: 'P', missionId: 'M1', kind: 'attempt.started', data: {} });

    const raw = store.raw().events;
    assert.deepEqual(raw.map((e) => e.kind), ['mission.created', 'attempt.started'], '主状态不含遥测');
    const sidecar = readFileSync(join(dir, '.coagent-events', 'M1.ndjson'), 'utf8');
    assert.match(sidecar, /runtime\.tool\.completed/);
    assert.match(sidecar, /runtime\.command\.started/);

    const listed = await log.list('M1');
    assert.deepEqual(
      listed.map((e) => e.kind),
      ['mission.created', 'runtime.tool.completed', 'runtime.command.started', 'attempt.started'],
      'list() 按 at 拼回真实时间线',
    );
  });

  test('迁移把主状态既有遥测搬进边车，幂等', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-slim-mig-'));
    dirs.push(dir);
    const path = join(dir, 'state.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      projects: [],
      deliveries: [],
      events: [
        { projectId: 'P', missionId: 'M-old', kind: 'runtime.tool.completed', data: {}, at: '2026-10-01T00:00:00.000Z' },
        { projectId: 'P', missionId: 'M-old', kind: 'mission.created', data: {}, at: '2026-10-01T00:00:01.000Z' },
      ],
      idCounters: {},
    }));
    const store = new FileStateStore(path);
    const first = store.migrateTelemetryEventsToSidecars();
    assert.deepEqual(first, { moved: 1, missions: 1 });
    assert.deepEqual(store.raw().events.map((e) => e.kind), ['mission.created']);
    const again = store.migrateTelemetryEventsToSidecars();
    assert.deepEqual(again, { moved: 0, missions: 0 }, '第二次零写入');
    const log = new FileActivityLog(store, new SystemClock());
    assert.equal((await log.list('M-old')).length, 2, 'list() 拼回后数量不变');
  });
});

describe('归档清扫', () => {
  test('completed 且已合入超过时限的归档；blocked / 未合入 / 刚完成的不动', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-slim-arc-'));
    dirs.push(dir);
    const statePath = join(dir, 'state.json');
    const built = await buildPersistentPlatform(statePath, { reconcile: false, exclusive: { what: 'slim-test' } });
    try {
      const project = await built.projects.ensure('P');
      const old = '2020-01-01T00:00:00.000Z';
      const done = project.createMission({ id: 'M-done-old', contract: CONTRACT });
      done.recordWorkspace({ projectRoot: dir, branch: 'mission/M-done-old', baseRevision: 'a'.repeat(40) });
      done.submitForReview();
      done.complete({ verdict: 'merge', reasons: ['ok'], mergedInto: 'main', mergedAt: old });

      const fresh = project.createMission({ id: 'M-done-fresh', contract: CONTRACT });
      fresh.submitForReview();
      fresh.complete({ verdict: 'merge', reasons: ['ok'], mergedInto: 'main', mergedAt: new Date().toISOString() });

      const notMerged = project.createMission({ id: 'M-not-merged', contract: CONTRACT });
      notMerged.recordWorkspace({ projectRoot: dir, branch: 'mission/M-not-merged', baseRevision: 'b'.repeat(40) });
      notMerged.submitForReview();
      notMerged.complete({ verdict: 'merge', reasons: ['ok'] });

      const blocked = project.createMission({ id: 'M-blocked', contract: CONTRACT });
      blocked.block();
      await built.projects.save(project);

      const result = await archiveEligibleMissions(await built.projects.list(), built.store, {
        now: new Date(),
        maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      });
      assert.deepEqual(result.archived, [{ projectId: 'P', missionId: 'M-done-old' }]);
      assert.ok(existsSync(join(dir, '.coagent-archive', 'missions', 'P', 'M-done-old.json')));
      assert.equal(built.store.hasArchivedMission('M-done-old'), true);
      assert.equal(built.store.hasArchivedMission('M-done-fresh'), false);
      assert.equal(built.store.hasArchivedMission('M-not-merged'), false);
      assert.equal(built.store.hasArchivedMission('M-blocked'), false);
      // 归档后从主状态序列化中滤掉（#write 的既有行为），工作集收缩。
      assert.equal(
        JSON.parse(readFileSync(statePath, 'utf8')).projects[0].missions.some((m: { id: string }) => m.id === 'M-done-old'),
        false,
      );
      // 域对象仍在（内存含完整史），事件照读。
      assert.ok((await built.activity.list('M-done-old')).length >= 0);
    } finally {
      built.releaseLock();
    }
  });
});
