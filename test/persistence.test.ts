/**
 * 持久化：状态跨重启还在。
 *
 * 由来：`run-mission` 跑完进程就退，全内存的收件箱跟着没了——而收件箱的
 * 全部意义就是"结果留着等人来取"。这组用例锁住：**重启之后 Mission、
 * 工作项、Attempt、证据、投递、事件、发号器全都续得上。**
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { buildPersistentPlatform } from '../src/main.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: ['不加依赖'],
  nonGoals: [],
  guardrails: ['不许放宽断言'],
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

const PLAN = {
  findings: '循环条件少算一轮',
  rootCause: 'off-by-one',
  rejectedHypotheses: ['不是调用方传错'],
  decisions: ['改 < 为 <='],
  direction: '改 src/foo.ts',
  risks: [],
};

const dirs: string[] = [];
function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-state-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('文件持久化', () => {
  test('整条 Mission 跨重启还原：状态、载荷、证据、用量一个不少', async () => {
    const statePath = tempState();

    // ---- 第一个进程 ----
    {
      const { platform } = await buildPersistentPlatform(statePath, new InPlaceWorkspaceManager());
      await platform.createMission({
        projectId: 'P',
        missionId: 'M1',
        contract: CONTRACT,
        origin: { clientType: 'claude-code', conversationRef: 'conv-7' },
      });
      await platform.recordWorkspace('M1', {
        branch: 'mission/M1',
        baseRevision: 'base0',
      });
      const coord = await platform.startCoordinatorAttempt('M1');
      await platform.updatePlan('M1', coord.attemptId, PLAN);
      const { workItemId } = await platform.createWorkItem('M1', coord.attemptId, {
        title: '修 foo',
        order: ORDER,
      });
      await platform.dispatchWorkItems('M1', coord.attemptId, [workItemId]);

      const exec = await platform.startExecutorAttempt('M1', workItemId);
      await platform.submitEvidence('M1', exec.attemptId, {
        kind: 'test',
        summary: 'node --test 全绿',
        command: 'node --test',
        exitCode: 0,
      });
      // S11.1：completed 必须有证据撑着，平台会拦下没证据的提交。
      await platform.submitEvidence('M1', exec.attemptId, {
        kind: 'test',
        summary: 'node --test 全绿',
        command: 'node --test',
        exitCode: 0,
      });
      await platform.submitExecutionResult('M1', exec.attemptId, {
        outcome: 'completed',
        summary: '改好了',
        changedFiles: ['src/foo.ts'],
        evidenceIds: ['E-1'],
        notes: '无',
      });
      await platform.finishAttempt('M1', exec.attemptId, {
        endedBy: 'structured_submit',
        usage: {
          input: 100,
          output: 50,
          cacheRead: 9000,
          cacheWrite: 0,
          total: 9150,
          cost: 0.5,
          quality: 'reported',
        },
      });
    }

    // ---- 换一个进程（同一个状态文件）----
    const { platform: revived, deliveries } = await buildPersistentPlatform(statePath, new InPlaceWorkspaceManager());
    const view = await revived.getMissionView('M1');

    assert.equal(view.status, 'executing', 'Mission 状态要续得上');
    assert.equal(view.isMutating, true, '改动名额也要续得上，否则重启就能并发写');
    assert.equal(view.contractRevision, 1);
    assert.equal(view.contract?.intent, CONTRACT.intent);
    assert.equal(view.planRevision, 1);
    assert.equal(view.plan?.rootCause, 'off-by-one');
    assert.deepEqual(view.plan?.rejectedHypotheses, ['不是调用方传错']);
    assert.equal(view.workItems.length, 1);
    assert.equal(view.workItems[0].status, 'submitted');
    assert.equal(view.workItems[0].attempts, 1);
    assert.equal(view.usage.cacheRead, 9000, '用量分项要续得上');
    // 上一进程崩在半路，那个协调者 attempt 的用量永远拿不到了。
    // 混了一条没上报的 → estimated 才是诚实的读数，不该谎称 reported。
    assert.equal(view.usage.quality, 'estimated');

    // 工单正文也在，否则重启后执行者拿不到活干。
    const order = await revived.getWorkOrder('M1', view.workItems[0].id);
    assert.equal(order.order.objective, ORDER.objective);
    assert.deepEqual(order.guardrails, CONTRACT.guardrails);

    // 还能接着往下走：验收、交卷、进收件箱。
    const coord2 = await revived.startCoordinatorAttempt('M1');
    await revived.reviewExecutionResult('M1', coord2.attemptId, {
      workItemId: view.workItems[0].id,
      verdict: 'accept',
      reasons: ['复跑过'],
      requiredChanges: [],
    });
    await revived.submitMissionResult('M1', coord2.attemptId, {
      outcome: 'delivered',
      summary: '交付',
      acceptanceEvidence: ['node --test 退出码 0'],
      memoryDelta: [],
      openRisks: [],
    });
    // 交卷只到 awaiting_review：要 L3 放行才算完成。
    assert.equal((await revived.getMissionView('M1')).status, 'awaiting_review');
    await revived.finalizeMission('M1', {
      verdict: 'merge',
      reasons: ['验收标准都对上了'],
      projectRoot: process.cwd(),
    });
    assert.equal((await revived.getMissionView('M1')).status, 'completed');

    // ---- 再换一个进程：收件箱里的结果还在等 ----
    const third = await buildPersistentPlatform(statePath, new InPlaceWorkspaceManager());
    const pending = await third.deliveries.pending('conv-7');
    assert.equal(pending.length, 1, '结果必须留着等人来取');
    assert.equal(pending[0].outcome, 'delivered');
    assert.equal(pending[0].missionId, 'M1');

    // 上一进程里读到的那条也是同一条。
    assert.equal((await deliveries.pending('conv-7')).length, 1);
  });

  test('发号器跨重启不回头，不会发出已存在的 id', async () => {
    const statePath = tempState();

    let firstId: string;
    {
      const { platform } = await buildPersistentPlatform(statePath, new InPlaceWorkspaceManager());
      await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
      const coord = await platform.startCoordinatorAttempt('M1');
      await platform.updatePlan('M1', coord.attemptId, PLAN);
      const created = await platform.createWorkItem('M1', coord.attemptId, {
        title: 'W',
        order: ORDER,
      });
      firstId = created.workItemId;
    }

    const { platform: revived } = await buildPersistentPlatform(statePath, new InPlaceWorkspaceManager());
    const coord = await revived.startCoordinatorAttempt('M1');
    const second = await revived.createWorkItem('M1', coord.attemptId, {
      title: 'W2',
      order: ORDER,
    });

    assert.notEqual(second.workItemId, firstId, '重启后不能从头发号');
    const view = await revived.getMissionView('M1');
    assert.equal(view.workItems.length, 2);
  });

  test('事件流也持久化，Timeline 不会因为重启断档', async () => {
    const statePath = tempState();
    {
      const { platform } = await buildPersistentPlatform(statePath, new InPlaceWorkspaceManager());
      await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
      await platform.startCoordinatorAttempt('M1');
    }
    const { activity } = await buildPersistentPlatform(statePath, new InPlaceWorkspaceManager());
    const events = await activity.list('M1');
    assert.deepEqual(
      events.map((e) => e.kind),
      [
        'mission.created',
        'attempt.started',
        // 启动收敛给那个没人收尾的 attempt 补的终结事件。
        'attempt.ended',
      ],
    );
  });

  test('状态文件损坏时直接失败，不静默重置', async () => {
    const statePath = tempState();
    // 写一份读不动的内容。
    writeFileSync(statePath, '{ 这不是 JSON', 'utf8');
    await assert.rejects(
      () => buildPersistentPlatform(statePath),
      /状态文件读取失败/,
      '损坏时必须报错——静默重置等于把 Mission 历史一声不吭地抹掉',
    );
  });
});
