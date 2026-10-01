/**
 * QueryRun → Lightweight Mutation Mission 显式晋升。
 *
 * 守住的硬边界：
 *   - 仅 ended + needs_mutation 可 promote
 *   - origin.queryRunId 来自可信 record.id，caller 伪造无效
 *   - findings 靠 queryRunId 引用，Mission 不抄 output
 *   - caller 必须显式提供 Frozen WorkOrder；禁止从 QueryRun 自动生成
 *   - 同 query 幂等；contract / mode / missionId / WorkOrder 冲突不覆盖
 *   - legacy matching Mission + 0 WI 可一次性 backfill 一张 Frozen WI
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
  WorkOrder,
} from '../src/kernel/index.ts';
import {
  InvariantViolationError,
  Project,
  EMPTY_USAGE,
} from '../src/kernel/index.ts';

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

const WORK_ORDER: WorkOrder = Object.freeze({
  objective: '修 foo.ts 空指针',
  allowedScope: Object.freeze(['src/foo.ts']),
  requiredBehaviour: 'foo 对 null 安全返回',
  constraints: Object.freeze(['只改 foo.ts']),
  acceptance: Object.freeze(['相关测试通过']),
  verification: Object.freeze(['node --test']),
  doNot: Object.freeze(['不抄 QueryRun output']),
  contextRefs: Object.freeze(['src/foo.ts']),
});

/**
 * WORK_ORDER 的「冻结后」形态：kernel 冻结时给缺省修订号补 r1。
 *
 * 深等断言比这个，而不是把 WORK_ORDER 本身改成带 r1——后者会让入参看起来
 * 已经带修订号，就验证不到「legacy 无修订号入参仍幂等」和「caller 对象不被
 * 改写」这两条了。
 */
const WORK_ORDER_R1: WorkOrder = Object.freeze({
  ...WORK_ORDER,
  orderRevision: 'r1',
});

const WORK_ORDER_OTHER: WorkOrder = Object.freeze({
  objective: '另一张工单',
  allowedScope: Object.freeze(['src/bar.ts']),
  requiredBehaviour: 'bar 行为',
  constraints: Object.freeze([]),
  acceptance: Object.freeze(['ok']),
  verification: Object.freeze(['node --test']),
  doNot: Object.freeze([]),
  contextRefs: Object.freeze([]),
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

function promoteInput(
  queryRunId: string,
  over: {
    contract?: MissionContract;
    workOrder?: WorkOrder;
    missionId?: string;
    origin?: Pick<OriginChannel, 'clientType' | 'conversationRef'>;
  } = {},
) {
  return {
    queryRunId,
    contract: over.contract ?? CONTRACT,
    workOrder: over.workOrder ?? WORK_ORDER,
    ...(over.missionId !== undefined ? { missionId: over.missionId } : {}),
    ...(over.origin !== undefined ? { origin: over.origin } : {}),
  };
}

describe('QueryPromotionService', () => {
  test('happy => created true, lightweight/mutation, 恰好 1 frozen WI；caller 不污染', async () => {
    const { service, queryRuns, projects, activity } = harness();
    const record = baseRecord();
    await queryRuns.save(record);

    const mutableOrder: WorkOrder = {
      objective: WORK_ORDER.objective,
      allowedScope: [...WORK_ORDER.allowedScope],
      requiredBehaviour: WORK_ORDER.requiredBehaviour,
      constraints: [...WORK_ORDER.constraints],
      acceptance: [...WORK_ORDER.acceptance],
      verification: [...WORK_ORDER.verification],
      doNot: [...WORK_ORDER.doNot],
      contextRefs: [...WORK_ORDER.contextRefs],
    };

    const result = await service.promote(
      promoteInput(record.id, { workOrder: mutableOrder }),
    );

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

    assert.equal(result.mission.workItems.length, 1);
    const wi = result.mission.workItems[0]!;
    assert.match(wi.id, /^W-/);
    assert.equal(wi.title, WORK_ORDER.objective);
    assert.deepEqual(wi.order, WORK_ORDER_R1);
    assert.ok(Object.isFrozen(wi.order));
    assert.ok(Object.isFrozen(wi.order!.allowedScope));

    // caller mutation 不污染已 seed 的 order
    // freezePayload 会就地 freeze 共享数组；顶层 object 与 string 字段仍可被 caller 改。
    (mutableOrder as { objective: string }).objective = 'HACKED';
    (mutableOrder as { requiredBehaviour: string }).requiredBehaviour = 'HACKED';
    assert.equal(wi.title, '修 foo.ts 空指针');
    assert.equal(wi.order?.objective, '修 foo.ts 空指针');
    assert.equal(wi.order?.requiredBehaviour, 'foo 对 null 安全返回');
    assert.deepEqual(wi.order?.allowedScope, ['src/foo.ts']);
    assert.notEqual(wi.order, mutableOrder);

    const project = await projects.get('P-1');
    assert.equal(project?.missions.length, 1);
    assert.equal(project?.missions[0]?.id, result.mission.id);
    assert.equal(project?.missions[0]?.workItems.length, 1);

    const events = await activity.list(result.mission.id);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.kind, 'mission.created');
    assert.equal(events[1]?.kind, 'work_item.created');
  });

  test('新 promotion events 恰好 mission.created → work_item.created；causation=query id', async () => {
    const { service, queryRuns, activity } = harness();
    const record = baseRecord({ id: 'Q-evt' });
    await queryRuns.save(record);

    const { mission } = await service.promote(promoteInput(record.id));
    const wi = mission.workItems[0]!;

    const events = await activity.list(mission.id);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.kind, 'mission.created');
    assert.equal(events[1]?.kind, 'work_item.created');

    for (const event of events) {
      assert.equal(event.causationId, record.id);
      assert.equal(event.correlationId, mission.id);
      assert.equal(event.attemptId, undefined);
      assert.equal(event.projectId, 'P-1');
      assert.equal(event.missionId, mission.id);
    }

    const createdData = events[0]!.data as Record<string, unknown>;
    assert.equal(createdData.promotedFromQueryRunId, record.id);
    assert.equal(createdData.executionMode, 'lightweight');
    assert.equal(createdData.runKind, 'mutation');

    assert.equal(events[1]!.workItemId, wi.id);
    const wiData = events[1]!.data as Record<string, unknown>;
    assert.equal(wiData.title, WORK_ORDER.objective);
    assert.equal(wiData.executionMode, 'lightweight');
    assert.equal(wiData.promotedFromQueryRunId, record.id);
    assert.ok(mission.updatedAt, 'touch 后 updatedAt 可追溯');
  });

  test('ROUTE-001 / no-copy：QueryRun output/toolCalls/usage 不进 Mission/WO/events', async () => {
    const { service, queryRuns, activity } = harness();
    const record = baseRecord({
      id: 'Q-findings',
      output: 'DETAILED FINDINGS should stay in QueryRun only',
      toolCalls: Object.freeze(['read', 'find', 'grep']),
    });
    await queryRuns.save(record);

    const { mission } = await service.promote(promoteInput(record.id));

    assert.equal(mission.origin?.queryRunId, 'Q-findings');
    const reused = await queryRuns.get(mission.origin!.queryRunId!);
    assert.ok(reused);
    assert.equal(reused.prompt, record.prompt);
    assert.equal(reused.output, record.output);
    assert.deepEqual(reused.toolCalls, record.toolCalls);
    assert.deepEqual(reused.usage, record.usage);

    const snap = mission.toSnapshot();
    const blob = JSON.stringify({
      snap,
      contract: mission.contract,
      order: mission.workItems[0]?.order,
      events: await activity.list(mission.id),
    });
    assert.equal(
      blob.includes('DETAILED FINDINGS'),
      false,
      'Mission/WO/events 不得复制 QueryRun output',
    );
    assert.equal((snap as { output?: unknown }).output, undefined);
    assert.equal((snap as { toolCalls?: unknown }).toolCalls, undefined);
    assert.equal((snap as { usage?: unknown }).usage, undefined);
  });

  test('missing / running / answered / failed 优先 NOT_FOUND/NOT_PROMOTABLE（即使缺 workOrder）', async () => {
    const { service, queryRuns, projects } = harness();

    await assert.rejects(
      () =>
        service.promote({
          queryRunId: 'Q-missing',
          contract: CONTRACT,
        } as never),
      (err: unknown) => {
        assert.ok(err instanceof QueryPromotionError);
        assert.equal(err.code, 'NOT_FOUND');
        return true;
      },
    );

    // 显式缺 workOrder 也不该改变优先级
    await assert.rejects(
      () =>
        service.promote({
          queryRunId: 'Q-missing',
          contract: CONTRACT,
          workOrder: undefined,
        } as never),
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
        () =>
          service.promote({
            queryRunId: bad.id,
            contract: CONTRACT,
            workOrder: undefined,
          } as never),
        (err: unknown) => {
          assert.ok(err instanceof QueryPromotionError);
          assert.equal(err.code, 'NOT_PROMOTABLE');
          return true;
        },
      );
    }

    assert.equal((await projects.list()).length, 0);
  });

  test('idempotent same query+contract+equal order/title => created:false, 仍 1 WI, 零新 event', async () => {
    const { service, queryRuns, activity } = harness();
    const record = baseRecord({ id: 'Q-idem' });
    await queryRuns.save(record);

    const first = await service.promote(promoteInput(record.id));
    assert.equal(first.created, true);
    assert.equal(first.mission.workItems.length, 1);

    const second = await service.promote(promoteInput(record.id));
    assert.equal(second.created, false);
    assert.equal(second.mission.id, first.mission.id);
    assert.equal(second.mission.workItems.length, 1);
    assert.equal(second.mission.workItems[0]?.id, first.mission.workItems[0]?.id);

    const events = await activity.list(first.mission.id);
    assert.equal(events.length, 2, '幂等路径不得再写 event');
    assert.deepEqual(
      events.map((e) => e.kind),
      ['mission.created', 'work_item.created'],
    );
  });

  test('same query + different contract/mode/missionId/WorkOrder/title/missing order/>1 WI => conflict', async () => {
    const { service, queryRuns, projects, ids, activity } = harness();
    const record = baseRecord({ id: 'Q-conflict' });
    await queryRuns.save(record);

    const first = await service.promote(promoteInput(record.id));
    const beforeEvents = (await activity.list(first.mission.id)).length;

    await assert.rejects(
      () => service.promote(promoteInput(record.id, { contract: CONTRACT_OTHER })),
      (err: unknown) => {
        assert.ok(err instanceof QueryPromotionError);
        assert.equal(err.code, 'PROMOTION_CONFLICT');
        return true;
      },
    );

    await assert.rejects(
      () => service.promote(promoteInput(record.id, { missionId: 'M-other-id' })),
      (err: unknown) => {
        assert.ok(err instanceof QueryPromotionError);
        assert.equal(err.code, 'PROMOTION_CONFLICT');
        return true;
      },
    );

    // different WorkOrder
    await assert.rejects(
      () => service.promote(promoteInput(record.id, { workOrder: WORK_ORDER_OTHER })),
      (err: unknown) => {
        assert.ok(err instanceof QueryPromotionError);
        assert.equal(err.code, 'PROMOTION_CONFLICT');
        return true;
      },
    );

    // mode corruption：同 queryRunId 但 mode 被破坏 → conflict，不新建
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
      () => service.promote(promoteInput(dirtyRecord.id)),
      (err: unknown) => {
        assert.ok(err instanceof QueryPromotionError);
        assert.equal(err.code, 'PROMOTION_CONFLICT');
        return true;
      },
    );

    // title mismatch / missing order / >1 WI
    const pTitle = Project.create({ id: 'P-title' });
    await projects.save(pTitle);
    const rTitle = baseRecord({ id: 'Q-title', projectId: 'P-title' });
    await queryRuns.save(rTitle);
    const mTitle = pTitle.createMission({
      id: ids.next('M'),
      contract: CONTRACT,
      origin: { clientType: 'cli', queryRunId: rTitle.id },
      executionMode: 'lightweight',
      runKind: 'mutation',
    });
    mTitle.createWorkItem({
      id: ids.next('W'),
      title: 'WRONG TITLE',
      order: WORK_ORDER,
    });
    await projects.save(pTitle);

    await assert.rejects(
      () => service.promote(promoteInput(rTitle.id)),
      (err: unknown) => {
        assert.ok(err instanceof QueryPromotionError);
        assert.equal(err.code, 'PROMOTION_CONFLICT');
        return true;
      },
    );

    const pNoOrder = Project.create({ id: 'P-no-order' });
    await projects.save(pNoOrder);
    const rNoOrder = baseRecord({ id: 'Q-no-order', projectId: 'P-no-order' });
    await queryRuns.save(rNoOrder);
    const mNoOrder = pNoOrder.createMission({
      id: ids.next('M'),
      contract: CONTRACT,
      origin: { clientType: 'cli', queryRunId: rNoOrder.id },
      executionMode: 'lightweight',
      runKind: 'mutation',
    });
    mNoOrder.createWorkItem({
      id: ids.next('W'),
      title: WORK_ORDER.objective,
      // no order
    });
    await projects.save(pNoOrder);

    await assert.rejects(
      () => service.promote(promoteInput(rNoOrder.id)),
      (err: unknown) => {
        assert.ok(err instanceof QueryPromotionError);
        assert.equal(err.code, 'PROMOTION_CONFLICT');
        return true;
      },
    );

    const pMulti = Project.create({ id: 'P-multi' });
    await projects.save(pMulti);
    const rMulti = baseRecord({ id: 'Q-multi', projectId: 'P-multi' });
    await queryRuns.save(rMulti);
    const mMulti = pMulti.createMission({
      id: ids.next('M'),
      contract: CONTRACT,
      origin: { clientType: 'cli', queryRunId: rMulti.id },
      executionMode: 'lightweight',
      runKind: 'mutation',
    });
    mMulti.createWorkItem({
      id: ids.next('W'),
      title: WORK_ORDER.objective,
      order: WORK_ORDER,
    });
    mMulti.createWorkItem({
      id: ids.next('W'),
      title: WORK_ORDER.objective,
      order: WORK_ORDER,
    });
    await projects.save(pMulti);

    await assert.rejects(
      () => service.promote(promoteInput(rMulti.id)),
      (err: unknown) => {
        assert.ok(err instanceof QueryPromotionError);
        assert.equal(err.code, 'PROMOTION_CONFLICT');
        return true;
      },
    );

    // 冲突路径不覆盖原 WI / 不加 event
    const still = await projects.get(record.projectId);
    assert.equal(still?.missions.length, 1);
    assert.equal(still?.missions[0]?.workItems.length, 1);
    assert.deepEqual(still?.missions[0]?.workItems[0]?.order, WORK_ORDER_R1);
    assert.equal((await activity.list(first.mission.id)).length, beforeEvents);

    assert.equal((await projects.get('P-dirty'))?.missions.length, 1);
    assert.equal((await projects.get('P-title'))?.missions[0]?.workItems[0]?.title, 'WRONG TITLE');
    assert.equal((await projects.get('P-no-order'))?.missions[0]?.workItems[0]?.order, undefined);
    assert.equal((await projects.get('P-multi'))?.missions[0]?.workItems.length, 2);
  });

  test('legacy matching promoted Mission 0 WI：backfill 1 Frozen WI；created:false；只写 work_item.created', async () => {
    const { service, queryRuns, projects, activity, ids } = harness();
    const record = baseRecord({ id: 'Q-legacy' });
    await queryRuns.save(record);

    const project = await projects.ensure(record.projectId);
    const legacy = project.createMission({
      id: ids.next('M'),
      contract: CONTRACT,
      origin: { clientType: 'cli', queryRunId: record.id },
      executionMode: 'lightweight',
      runKind: 'mutation',
    });
    await projects.save(project);
    assert.equal(legacy.workItems.length, 0);

    const result = await service.promote(promoteInput(record.id));
    assert.equal(result.created, false);
    assert.equal(result.mission.id, legacy.id);
    assert.equal(result.mission.workItems.length, 1);
    const wi = result.mission.workItems[0]!;
    assert.match(wi.id, /^W-/);
    assert.equal(wi.title, WORK_ORDER.objective);
    assert.deepEqual(wi.order, WORK_ORDER_R1);
    assert.ok(Object.isFrozen(wi.order));

    const events = await activity.list(result.mission.id);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'work_item.created');
    assert.equal(events[0]?.workItemId, wi.id);
    assert.equal(events[0]?.causationId, record.id);
    assert.equal(events[0]?.correlationId, legacy.id);
    assert.equal(events[0]?.attemptId, undefined);
    assert.equal(
      events.filter((e) => e.kind === 'mission.created').length,
      0,
      'legacy backfill 不得再写 mission.created',
    );
  });

  test('legacy 0 WI + invalid WorkOrder.validation => INVALID_WORK_ORDER_VALIDATION；仍 0 WI，无 event', async () => {
    const { service, queryRuns, projects, activity, ids } = harness();
    const record = baseRecord({ id: 'Q-bad-wo' });
    await queryRuns.save(record);

    const project = await projects.ensure(record.projectId);
    const legacy = project.createMission({
      id: ids.next('M'),
      contract: CONTRACT,
      origin: { clientType: 'cli', queryRunId: record.id },
      executionMode: 'lightweight',
      runKind: 'mutation',
    });
    await projects.save(project);

    const badOrder = {
      ...WORK_ORDER,
      validation: {
        commands: [
          {
            argv: ['node', '--test'],
            timeoutMs: 1000,
            cwd: '/tmp',
          } as never,
        ],
      },
    } satisfies WorkOrder;

    await assert.rejects(
      () => service.promote(promoteInput(record.id, { workOrder: badOrder })),
      (err: unknown) => {
        assert.ok(err instanceof InvariantViolationError);
        assert.equal(err.code, 'INVALID_WORK_ORDER_VALIDATION');
        return true;
      },
    );

    const after = await projects.get(record.projectId);
    const mission = after?.missions.find((m) => m.id === legacy.id);
    assert.ok(mission);
    assert.equal(mission.workItems.length, 0);
    assert.equal((await activity.list(legacy.id)).length, 0);
  });

  test('runtime workOrder=undefined/null/[] => WORK_ORDER_REQUIRED；无 Mission/Project side effect', async () => {
    const { service, queryRuns, projects, activity } = harness();
    const record = baseRecord({ id: 'Q-req' });
    await queryRuns.save(record);

    for (const bad of [undefined, null, []] as const) {
      await assert.rejects(
        () =>
          service.promote({
            queryRunId: record.id,
            contract: CONTRACT,
            workOrder: bad,
          } as never),
        (err: unknown) => {
          assert.ok(err instanceof QueryPromotionError);
          assert.equal(err.code, 'WORK_ORDER_REQUIRED');
          return true;
        },
      );
    }

    // 新路径无 Mission/Project side effect：projectId 尚不存在时 list 仍为空
    assert.equal((await projects.list()).length, 0);
    // activity 全局：无 mission events（list 需要 missionId；用 all）
    assert.equal((await activity.all()).length, 0);
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

    const { mission } = await service.promote(
      promoteInput(record.id, { origin: forged }),
    );

    assert.equal(mission.origin?.clientType, 'web');
    assert.equal(mission.origin?.conversationRef, 'conv-9');
    assert.equal(mission.origin?.queryRunId, record.id);
    assert.equal(mission.origin?.rerunOf, undefined);
    assert.notEqual(mission.origin?.queryRunId, 'Q-FORGED');
    assert.equal(mission.workItems.length, 1);
  });

  test('queryRuns record promotion 前后深等（服务不 mutate QueryRun）', async () => {
    const { service, queryRuns } = harness();
    const record = baseRecord({ id: 'Q-immutable' });
    await queryRuns.save(record);
    const before = structuredClone(await queryRuns.get(record.id));

    await service.promote(promoteInput(record.id));

    const after = await queryRuns.get(record.id);
    assert.deepEqual(after, before);
  });

  test('Project snapshot 自然保存 origin.queryRunId + frozen WorkItem（无 schema 改动）', async () => {
    const { service, queryRuns, projects } = harness();
    const record = baseRecord({ id: 'Q-snap' });
    await queryRuns.save(record);

    const { mission } = await service.promote(promoteInput(record.id));

    const project = await projects.get(record.projectId);
    assert.ok(project);
    const snap = project.toSnapshot();
    const missionSnap = snap.missions.find((m) => m.id === mission.id);
    assert.ok(missionSnap);
    assert.equal(missionSnap.origin?.queryRunId, record.id);
    assert.equal(missionSnap.executionMode, 'lightweight');
    assert.equal(missionSnap.runKind, 'mutation');
    assert.equal(missionSnap.workItems.length, 1);
    assert.equal(missionSnap.workItems[0]?.title, WORK_ORDER.objective);
    assert.deepEqual(missionSnap.workItems[0]?.order, WORK_ORDER_R1);

    const restored = Project.restore(snap);
    const restoredMission = restored.missions.find((m) => m.id === mission.id);
    assert.equal(restoredMission?.origin?.queryRunId, record.id);
    assert.equal(restoredMission?.workItems.length, 1);
    assert.deepEqual(restoredMission?.workItems[0]?.order, WORK_ORDER_R1);
  });

  test('promoteQueryRun 便捷函数同样要求 workOrder 并行为一致', async () => {
    const { queryRuns, projects, activity, clock, ids } = harness();
    await queryRuns.save(baseRecord({ id: 'Q-fn' }));
    const deps = { queryRuns, projects, activity, clock, ids };

    const result = await promoteQueryRun(deps, promoteInput('Q-fn'));
    assert.equal(result.created, true);
    assert.equal(result.mission.origin?.queryRunId, 'Q-fn');
    assert.equal(result.mission.workItems.length, 1);
    assert.equal(result.mission.workItems[0]?.title, WORK_ORDER.objective);
    assert.deepEqual(result.mission.workItems[0]?.order, WORK_ORDER_R1);

    await assert.rejects(
      () =>
        promoteQueryRun(deps, {
          queryRunId: 'Q-fn',
          contract: CONTRACT,
          workOrder: undefined,
        } as never),
      (err: unknown) => {
        // Q-fn 已 promote：先走 existing 兼容；缺 workOrder → WORK_ORDER_REQUIRED
        // 若先查 promotable 再 require，existing 路径 assert 后 require
        assert.ok(err instanceof QueryPromotionError);
        assert.equal(err.code, 'WORK_ORDER_REQUIRED');
        return true;
      },
    );

    // 新 query 缺 workOrder
    await queryRuns.save(baseRecord({ id: 'Q-fn-2' }));
    await assert.rejects(
      () =>
        promoteQueryRun(deps, {
          queryRunId: 'Q-fn-2',
          contract: CONTRACT,
        } as never),
      (err: unknown) => {
        assert.ok(err instanceof QueryPromotionError);
        assert.equal(err.code, 'WORK_ORDER_REQUIRED');
        return true;
      },
    );
  });
});
