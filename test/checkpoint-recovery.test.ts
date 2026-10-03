/**
 * 签名显式检查点批准核心及持久恢复回归。
 *
 * 复现「答复里写明了 reject 场景却仍被当作放行/或解析失败之后仍卡在检查点等待、
 * 派发受阻」，再演示用显式签名 approveWorkItemCheckpoint 批准、状态落临时文件后
 * 从同一 state 重新装配（恢复），同 Mission 续派成功，签名事件与 costCap / 升级历史保留。
 *
 * 不读改 AC4、不启停真实服务；只跑本文件。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPersistentPlatform } from '../src/main.ts';
import { GitWorktreeManager } from '../src/application/workspace.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: ['不得改 Contract'],
};

const PLAN = {
  findings: 'foo 一直返回 0',
  rootCause: '初始值写错了',
  rejectedHypotheses: ['不是调用方传错'],
  decisions: ['直接改初始值'],
  direction: '改 src/foo.ts',
  risks: [],
};

function order(objective: string): WorkOrder {
  return {
    objective,
    allowedScope: ['src/foo.ts'],
    requiredBehaviour: 'foo 返回 1',
    constraints: [],
    acceptance: ['foo() === 1'],
    verification: ['node --test'],
    doNot: [],
    contextRefs: [],
  };
}

test('批准答复误判后仍卡检查点；显式签名批准 15 持久恢复后续派', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-cp-recovery-'));
  const statePath = join(dir, 'state.json');
  const workspace = new GitWorktreeManager();
  // 第一装配：建 15 项、答复检查点、持久化。reconcile:false（只读命令不收敛）。
  const built = await buildPersistentPlatform(statePath, { workspace, reconcile: false });
  try {
    await built.platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT });
    const { attemptId: coord } = await built.platform.startCoordinatorAttempt('M');
    await built.platform.updatePlan('M', coord, PLAN);
    await built.platform.submitContractCheck('M', coord, { verdict: 'ok', summary: '测试契约已核对' });

    for (let n = 1; n <= 15; n += 1) {
      const created = await built.platform.createWorkItem('M', coord, { title: `项 ${n}`, order: order(`改 ${n}`) });
      assert.equal(created.workItemId, `W-${n}`);
    }

    // 第 15 项照常建出，同时停等升级（未答复）。
    const at15 = await built.platform.getMissionView('M');
    assert.equal(at15.workItems.length, 15, '第 15 项照常建出来');
    assert.equal(at15.waitReason, 'work_item_checkpoint');
    assert.equal(at15.openEscalations[0]?.platformGate?.threshold, 15);
    assert.deepEqual(await built.platform.dispatchWorkItems('M', coord, ['W-15']), { dispatched: [] });

    // 批准答复：批准继续、且说明已覆盖 reject 场景。答复落库但检查点阈值没被签名批准，
    // 等待与派发仍受阻——这正是要靠显式签名恢复的现场。
    const answered = await built.platform.answerEscalation('M', '批准继续，已覆盖 reject 场景');
    assert.match(answered.answer, /批准继续/);

    const afterAnswer = await built.platform.getMissionView('M');
    // 答复已落库 → 无「开放」升级；但检查点等待仍在，派发仍受阻。
    assert.deepEqual(afterAnswer.openEscalations, [], '答复后升级已答复，无开放升级');
    assert.equal(afterAnswer.waitReason, 'work_item_checkpoint', '答复未解除检查点等待');
    assert.deepEqual(await built.platform.dispatchWorkItems('M', coord, ['W-15']), { dispatched: [] }, '答复后派发仍受阻');

    // 落盘：升级历史与 costCap 要被保存下来，供「重启」后的显式签名批准验证保留。
    built.persist();

    // 持久恢复：用同一 statePath 重新装配平台（模拟进程重启后从文件恢复状态）。
    const recovered = await buildPersistentPlatform(statePath, { workspace: new GitWorktreeManager(), reconcile: false });

    const projects = await recovered.projects.list();
    const mission = projects.flatMap((p) => p.missions).find((m) => m.id === 'M')!;
    const escalationsBefore = JSON.parse(JSON.stringify(mission.escalations));
    const costCapBefore = mission.costCap;

    // 显式签名批准第 15 个检查点。
    const approved = await recovered.platform.approveWorkItemCheckpoint('M', {
      threshold: 15,
      reviewer: 'L3-signature',
      reason: '批准答复未落地签名，显式签名批准检查点 15',
    });
    assert.deepEqual(approved, { threshold: 15, approved: true, alreadyApproved: false });

    // 批准事件带签名（threshold/reviewer/reason）。
    const events = await recovered.activity.list('M');
    const approvedEvent = events.find(
      (e) => e.kind === 'mission.work_item_checkpoint.approved' && (e.data as { threshold?: unknown }).threshold === 15,
    );
    assert.ok(approvedEvent, '应有 mission.work_item_checkpoint.approved 事件');
    assert.equal((approvedEvent!.data as { reviewer?: string }).reviewer, 'L3-signature');
    assert.equal((approvedEvent!.data as { reason?: string }).reason, '批准答复未落地签名，显式签名批准检查点 15');

    // 升级历史完全不变：签名批准不增删、不自动答复任何 escalation。
    const missionAfter = (await recovered.projects.list()).flatMap((p) => p.missions).find((m) => m.id === 'M')!;
    assert.deepEqual(JSON.parse(JSON.stringify(missionAfter.escalations)), escalationsBefore, '升级历史完全相同');
    assert.equal(missionAfter.costCap, costCapBefore, 'costCap 不变');

    // 只清当前检查点等待，不保留 work_item_checkpoint 等待。
    const afterApproval = await recovered.platform.getMissionView('M');
    assert.equal(afterApproval.waitReason, undefined, '签名批准后检查点等待清掉');
    assert.deepEqual(afterApproval.openEscalations, []);

    // 同 Mission 续派成功：之前卡住的 W-15 现在能派出去。
    assert.deepEqual(await recovered.platform.dispatchWorkItems('M', coord, ['W-15']), { dispatched: ['W-15'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
