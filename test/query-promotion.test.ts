/**
 * QueryRun → Lightweight Mutation Mission 显式晋升。
 *
 * 守住的硬边界：
 *   - 仅 ended + needs_mutation 可 promote
 *   - origin.queryRunId 来自可信 record.id，caller 伪造无效
 *   - findings 靠 queryRunId 引用，Mission 不抄 output
 *   - 同 query 幂等；contract / mode / missionId 冲突不覆盖
 *   - 不 mutate QueryRun；runQuery 本身仍不自动 createMission
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  InMemoryQueryRunRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import {
  QueryPromotionError,
  QueryPromotionService,
  promoteQueryRun,
} from '../src/application/query-promotion.ts';
import type { QueryRunRecord } from '../src/application/query-run.ts';
import type {
  MissionContract,
  OriginChannel,
} from '../src/kernel/index.ts';
import { Project } from '../src/kernel/index.ts';
import { EMPTY_USAGE } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = Object.freeze({
  intent: '把 needs_mutation 的发现落成改动',
  acceptance: Object.freeze(['改动可验证', '不越 scope']),
  constraints: Object.freeze(['只改 allowed paths']),
  nonGoals: Object.freeze(['不重做 query']),
  guardrails: Object.freeze(['不抄 findings 进 contract']),
});

const CONTRACT_OTHER: MissionContract = Object.freeze({
  intent: '另一份契约',
  acceptance: Object.freeze(['不同验收']),
  constraints: Object.freeze([]),
  nonGoals: Object.freeze([]),
  guardrails: Object.freeze([]),
});

function baseRecord(over: Partial<QueryRunRecord> = {}): QueryRunRecord {
  return {
    id: 'Q-1',
    projectId: 'P-1',
    source: 'cli',
    prompt: '为什么测试挂了？',
    cwd: '/repo',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    outcome: 'needs_mutation',
    status: 'ended',
    usage: {
      ...EMPTY_USAGE,
      input: 10,
      output: 20,
      total: 30,
      quality: 'reported',
    },
    endedBy: 'completed',
    output: 'ROOT CAUSE: missing null check in foo.ts\n建议改 bar.ts',
    toolCalls: Object.freeze(['read', 'grep']),
    ...over,
  };
}

function harness() {
  const clock = new FixedClock('2026-06-01T12:00:00.000Z');
  const ids = new SequentialIds();
  const queryRuns = new InMemoryQueryRunRepository();
  const projects = new InMemoryProjectRepository();
  const activity = new InMemoryActivityLog(clock);
  const service = new QueryPromotionService({
    queryRuns,
    projects,
    activity,
    clock,
    ids,
  });
  return { clock, ids, queryRuns, projects, activity, service };
}

describe('QueryPromotionService', () => {
  test('happy needs_mutation => created:true, lightweight/mutation, origin.queryRunId', async () => {
    const { service, queryRuns, projects, activity } = harness();
    const record = baseRecord();
    await queryRuns.save(record);

    const result = await service.promote({
      queryRunId: record.id,
      contract: CONTRACT,
    });

    assert.equal(result.created, true);
    assert.equal(result.mission.executionMode, 'lightweight');
    assert.equal(result.mission.runKind, 'mutation');
    assert.equal(result.mission.origin?.queryRunId, record.id);
    assert.equal(result.mission.origin?.clientType, 'cli');
    assert.equal(result.mission.origin?.rerunOf, undefined);
    assert.deepEqual(result.mission.contract, CONTRACT);
    assert.equal(result.source.queryRunId, record.id);
    assert.equal(result.source.prompt, record.prompt);
    assert.equal(result.source.outcome, 'needs_mutation');
    assert.equal((result.source as { output?: unknown }).output, undefined);

    const project = await projects.get('P-1');
    assert.equal(project?.missions.length, 1);
    assert.equal(project?.missions[0]?.id, result.mission.id);

    const events = await activity.list(result.mission.id);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'mission.created');
  });

  test('ROUTE-001 findings reuse：靠 origin.queryRunId 再 get，Mission 不抄 output', async () => {
    const { service, queryRuns } = harness();
    const record = baseRecord({
      id: 'Q-findings',
      output: 'DETAILED FINDINGS should stay in QueryRun only',
      toolCalls: Object.freeze(['read', 'find', 'grep']),
    });
    await queryRuns.save(record);

    const { mission } = await service.promote({
      queryRunId: record.id,
      contract: CONTRACT,
    });

    assert.equal(mission.origin?.queryRunId, 'Q-findings');
    const reused = await queryRuns.get(mission.origin!.queryRunId!);
    assert.ok(reused);
    assert.equal(reused.prompt, record.prompt);
    assert.equal(reused.output, record.output);
    assert.deepEqual(reused.toolCalls, record.toolCalls);
    assert.deepEqual(reused.usage, record.usage);

    const snap = mission.toSnapshot();
    assert.equal(
      JSON.stringify(snap).includes('DETAILED FINDINGS'),
      false,
      'Mission snapshot 不得复制 QueryRun output',
    );
    assert.equal(
      JSON.stringify(mission.contract).includes('DETAILED FINDINGS'),
      false,
    );
    assert.equal((snap as { output?: unknown }).output, undefined);
  });

  test('missing / running / answered / failed 全拒绝且 Mission 数量不变', async () => {
    const { service, queryRuns, projects } = harness();

    await assert.rejects(
      () => service.promote({ queryRunId: 'Q-missing', contract: CONTRACT }),
      (err: unknown) => {
        assert.ok(err instanceof QueryPromotionError);
        assert.equal(err.code, 'NOT_FOUND');
        return true;
      },
    );

    for (const bad of [
      baseRecord({ id: 'Q-running', status: 'running', outcome: undefined, endedAt: undefined }),
      baseRecord({ id: 'Q-answered', outcome: 'answered' }),
      baseRecord({ id: 'Q-failed', outcome: 'failed' }),
    ] as const) {
      await queryRuns.save(bad);
      await assert.rejects(
        () => service.promote({ queryRunId: bad.id, contract: CONTRACT }),
        (err: unknown) => {
          assert.ok(err instanceof QueryPromotionError);
          assert.equal(err.code, 'NOT_PROMOTABLE');
          return true;
        },
      );
    }

    assert.equal((await projects.list()).length, 0);
  });

  test('idempotent same query+same contract => same mission, created:false, 无第二 event', async () => {
    const { service, queryRuns, activity } = harness();
    const record = baseRecord({ id: 'Q-idem' });
    await queryRuns.save(record);

    const first = await service.promote({
      queryRunId: record.id,
      contract: CONTRACT,
    });
    assert.equal(first.created, true);

    const second = await service.promote({
      queryRunId: record.id,
      contract: CONTRACT,
    });
    assert.equal(second.created, false);
    assert.equal(second.mission.id, first.mission.id);

    const events = await activity.list(first.mission.id);
    assert.equal(events.length, 1, '幂等路径不得再写 promotion event');
  });

  test('same query + different contract / mode corruption / missionId => conflict', async () => {
    const { service, queryRuns, projects, ids } = harness();
    const record = baseRecord({ id: 'Q-conflict' });
    await queryRuns.save(record);

    const first = await service.promote({
      queryRunId: record.id,
      contract: CONTRACT,
    });

    await assert.rejects(
      () =>
        service.promote({
          queryRunId: record.id,
          contract: CONTRACT_OTHER,
        }),
      (err: unknown) => {
        assert.ok(err instanceof QueryPromotionError);
        assert.equal(err.code, 'PROMOTION_CONFLICT');
        return true;
      },
    );

    await assert.rejects(
      () =>
        service.promote({
          queryRunId: record.id,
          contract: CONTRACT,
          missionId: 'M-other-id',
        }),
      (err: unknown) => {
        assert.ok(err instanceof QueryPromotionError);
        assert.equal(err.code, 'PROMOTION_CONFLICT');
        return true;
      },
    );

    // mode corruption：同 queryRunId 但 mode 被破坏 → conflict，不新建
    const project = await projects.get(record.projectId);
    assert.ok(project);
    // 换一条“脏” Mission 占住 queryRunId（绕过 promote，直接 kernel）
    const dirtyProject = Project.create({ id: 'P-dirty' });
    await projects.save(dirtyProject);
    const dirtyRecord = baseRecord({ id: 'Q-dirty', projectId: 'P-dirty' });
    await queryRuns.save(dirtyRecord);
    dirtyProject.createMission({
      id: ids.next('M'),
      contract: CONTRACT,
      origin: { clientType: 'cli', queryRunId: dirtyRecord.id },
      executionMode: 'standard',
      runKind: 'mutation',
    });
    await projects.save(dirtyProject);

    await assert.rejects(
      () =>
        service.promote({
          queryRunId: dirtyRecord.id,
          contract: CONTRACT,
        }),
      (err: unknown) => {
        assert.ok(err instanceof QueryPromotionError);
        assert.equal(err.code, 'PROMOTION_CONFLICT');
        return true;
      },
    );

    assert.equal((await projects.get(record.projectId))?.missions.length, 1);
    assert.equal((await projects.get('P-dirty'))?.missions.length, 1);
    assert.equal(first.mission.id, (await projects.get(record.projectId))?.missions[0]?.id);
  });

  test('default origin clientType=source；caller clientType/conversationRef 保留；伪造 queryRunId/rerunOf 不进入', async () => {
    const { service, queryRuns } = harness();
    const record = baseRecord({ id: 'Q-origin', source: 'api' });
    await queryRuns.save(record);

    const forged = {
      clientType: 'web',
      conversationRef: 'conv-9',
      queryRunId: 'Q-FORGED',
      rerunOf: 'M-FORGED',
    } as Pick<OriginChannel, 'clientType' | 'conversationRef'>;

    const { mission } = await service.promote({
      queryRunId: record.id,
      contract: CONTRACT,
      origin: forged,
    });

    assert.equal(mission.origin?.clientType, 'web');
    assert.equal(mission.origin?.conversationRef, 'conv-9');
    assert.equal(mission.origin?.queryRunId, record.id);
    assert.equal(mission.origin?.rerunOf, undefined);
    assert.notEqual(mission.origin?.queryRunId, 'Q-FORGED');
  });

  test('event causationId=queryRunId，data 含 promotedFromQueryRunId', async () => {
    const { service, queryRuns, activity } = harness();
    const record = baseRecord({ id: 'Q-evt' });
    await queryRuns.save(record);

    const { mission } = await service.promote({
      queryRunId: record.id,
      contract: CONTRACT,
    });

    const events = await activity.list(mission.id);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.kind, 'mission.created');
    assert.equal(event.causationId, record.id);
    assert.equal(event.correlationId, mission.id);
    assert.equal(event.projectId, 'P-1');
    assert.equal(event.missionId, mission.id);
    assert.equal(event.contractRevision, 1);
    const data = event.data as Record<string, unknown>;
    assert.equal(data.promotedFromQueryRunId, record.id);
    assert.equal(data.executionMode, 'lightweight');
    assert.equal(data.runKind, 'mutation');
    assert.ok(mission.updatedAt, 'touch 后 updatedAt 可追溯');
  });

  test('queryRuns record promotion 前后深等（服务不 mutate QueryRun）', async () => {
    const { service, queryRuns } = harness();
    const record = baseRecord({ id: 'Q-immutable' });
    await queryRuns.save(record);
    const before = structuredClone(await queryRuns.get(record.id));

    await service.promote({ queryRunId: record.id, contract: CONTRACT });

    const after = await queryRuns.get(record.id);
    assert.deepEqual(after, before);
  });

  test('Project snapshot 自然保存 origin.queryRunId（无 schema 改动）', async () => {
    const { service, queryRuns, projects } = harness();
    const record = baseRecord({ id: 'Q-snap' });
    await queryRuns.save(record);

    const { mission } = await service.promote({
      queryRunId: record.id,
      contract: CONTRACT,
    });

    const project = await projects.get(record.projectId);
    assert.ok(project);
    const snap = project.toSnapshot();
    const missionSnap = snap.missions.find((m) => m.id === mission.id);
    assert.ok(missionSnap);
    assert.equal(missionSnap.origin?.queryRunId, record.id);
    assert.equal(missionSnap.executionMode, 'lightweight');
    assert.equal(missionSnap.runKind, 'mutation');

    const restored = Project.restore(snap);
    const restoredMission = restored.missions.find((m) => m.id === mission.id);
    assert.equal(restoredMission?.origin?.queryRunId, record.id);
  });

  test('promoteQueryRun 便捷函数与 service 等价', async () => {
    const { queryRuns, projects, activity, clock, ids } = harness();
    await queryRuns.save(baseRecord({ id: 'Q-fn' }));
    const result = await promoteQueryRun(
      { queryRuns, projects, activity, clock, ids },
      { queryRunId: 'Q-fn', contract: CONTRACT },
    );
    assert.equal(result.created, true);
    assert.equal(result.mission.origin?.queryRunId, 'Q-fn');
  });
});
