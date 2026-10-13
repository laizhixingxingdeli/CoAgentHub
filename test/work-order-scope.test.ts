import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { FixedClock, InMemoryActivityLog, InMemoryProjectRepository, SequentialIds } from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import { exactFileScopeIssue } from '../src/application/scope-paths.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['范围要在执行前就拒绝'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

function order(allowedScope: string[]): WorkOrder {
  return {
    objective: '改 foo',
    allowedScope,
    requiredBehaviour: 'foo 返回 1',
    constraints: [],
    acceptance: [],
    verification: ['node --test'],
    doNot: [],
    contextRefs: [],
  };
}

/** 两个 Platform 共用同一套仓储：一个装检查点工作区（生产形态），一个不装（内存 / 原地形态）。 */
function makePlatforms() {
  const clock = new FixedClock();
  const activity = new InMemoryActivityLog(clock);
  const projects = new InMemoryProjectRepository();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const base = { projects, deliveries, activity, clock, ids };
  const checkpointing = Object.assign(new InPlaceWorkspaceManager(), { checkpoint: async () => {} });
  return {
    plain: new Platform(base),
    strict: new Platform({ ...base, workspace: checkpointing }),
  };
}

async function bootstrap() {
  const platforms = makePlatforms();
  await platforms.plain.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
  const { attemptId: coord } = await platforms.plain.startCoordinatorAttempt('M1');
  await platforms.plain.updatePlan('M1', coord, {
    findings: '查到了', rejectedHypotheses: [], decisions: [], direction: '这么改', risks: [],
  });
  return { ...platforms, coord };
}

const isScopeError = (e: unknown) => e instanceof PlatformRuleError && e.code === 'WORK_ORDER_SCOPE_INVALID';

describe('工单范围：执行前拒绝模糊授权', () => {
  test('共用判据：目录、通配符、绝对路径、穿越都说得出原因和改法；精确文件放行', () => {
    for (const [entry, code] of [
      ['app/', 'directory'],
      ['src/*.ts', 'glob'],
      ['/etc/passwd', 'absolute'],
      ['C:\\x\\y.ts', 'absolute'],
      ['C:foo.ts', 'absolute'],
      ['../x.ts', 'traversal'],
      ['', 'empty'],
    ] as const) {
      const issue = exactFileScopeIssue(entry);
      assert.equal(issue?.code, code, entry);
      assert.ok(issue!.reason.length > 0 && issue!.example.length > 0, `${entry} 要给原因和改法`);
    }
    assert.equal(exactFileScopeIssue('src/foo.ts'), undefined);
    assert.equal(exactFileScopeIssue('./src\\foo.ts'), undefined, '先规范化再判，与验证器口径一致');
    assert.equal(exactFileScopeIssue('Makefile'), undefined, '无扩展名的文件也是精确文件');
  });

  test('装了检查点的平台：建单、修订、派发都在执行之前拒，且不留副作用', async () => {
    const { plain, strict, coord } = await bootstrap();
    const good = await strict.createWorkItem('M1', coord, { title: 'ok', order: order(['src/foo.ts']) });
    const before = (await strict.getMissionView('M1')).workItems.length;

    await assert.rejects(
      () => strict.createWorkItem('M1', coord, { title: 'bad', order: order(['src/foo.ts', 'app/']) }),
      (e) => isScopeError(e) && /app\/.*目录形式.*app\/<文件名>/s.test((e as Error).message),
    );
    await assert.rejects(
      () => strict.reviseWorkOrder('M1', coord, good.workItemId, order(['src/*.ts'])),
      isScopeError,
    );
    await assert.rejects(
      () => strict.createWorkItem('M1', coord, { title: 'empty', order: order([]) }),
      isScopeError,
    );
    assert.equal((await strict.getMissionView('M1')).workItems.length, before, '被拒的建单不得新增工作项');

    // 存量工单（校验上线前冻结的）：由没有检查点的平台建出来，到装了检查点的平台派发时再拦一次。
    const legacy = await plain.createWorkItem('M1', coord, { title: 'legacy', order: order(['app/']) });
    await plain.submitContractCheck('M1', coord, { verdict: 'ok', summary: '已核对' });
    await assert.rejects(() => strict.dispatchWorkItems('M1', coord, [legacy.workItemId]), isScopeError);
    const status = (await strict.getMissionView('M1')).workItems.find((row) => row.id === legacy.workItemId)?.status;
    assert.equal(status, 'created', '被拒的派发不得改变工作项状态');
  });

  test('没有检查点的平台（原地 / 内存）不收紧：目录前缀仍是验证器的合法语义', async () => {
    const { plain, coord } = await bootstrap();
    const created = await plain.createWorkItem('M1', coord, { title: 'dir', order: order(['src/']) });
    assert.ok(created.workItemId);
  });
});
