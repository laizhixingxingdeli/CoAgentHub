/**
 * L2 逐条验收（优化方案 §11 / A5b）。
 *
 * 守住：
 *   - 工单有验收标准时，协调者评审必须逐条交代：一条对一条、照抄原文
 *   - pass 要证据，unverified / not_applicable 要说明；有 fail 不能 accept（内核也挡）
 *   - 没有验收标准的旧工作项不受约束；旧快照照常恢复
 *   - 逐条结果随快照落盘；事件带计数与未验证项；l3 show 把未验证项摆出来
 *
 * 为什么要逐条：一句总结里「都过了」和「三条过了、第四条没法验」看起来一样，
 * 而后者正是 L3 最需要看到的。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { buildPersistentPlatform } from '../src/main.ts';
import { InvariantViolationError, Project, WorkItem } from '../src/kernel/index.ts';
import type { AcceptanceResult, MissionContract, WorkOrder } from '../src/kernel/index.ts';

const L3 = fileURLToPath(new URL('../src/l3.ts', import.meta.url));
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const CONTRACT: MissionContract = { intent: 'x', acceptance: ['x'], constraints: [], nonGoals: [], guardrails: [] };
const PLAN = { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] };
const ORDER: WorkOrder = {
  objective: 'o',
  allowedScope: ['src/a.ts'],
  requiredBehaviour: 'r',
  constraints: [],
  acceptance: ['A 行为成立', 'B 在真机上验过'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
};
const GOOD: AcceptanceResult[] = [
  { criterion: 'A 行为成立', status: 'pass', evidence: 'node --test 退出码 0' },
  { criterion: 'B 在真机上验过', status: 'unverified', note: '没有真机' },
];

function makePlatform() {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const activity = new InMemoryActivityLog(clock);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    activity,
    clock,
    ids,
  });
  return { platform, activity };
}

async function submitted(platform: Platform, missionId = 'M1', order: WorkOrder = ORDER, projectId = 'P') {
  await platform.createMission({ projectId, missionId, contract: CONTRACT });
  const coord = await platform.startCoordinatorAttempt(missionId);
  await platform.updatePlan(missionId, coord.attemptId, PLAN);
  const { workItemId } = await platform.createWorkItem(missionId, coord.attemptId, { title: 'W', order });
  await platform.dispatchWorkItems(missionId, coord.attemptId, [workItemId]);
  const exec = await platform.startExecutorAttempt(missionId, workItemId);
  await platform.submitEvidence(missionId, exec.attemptId, { kind: 'test', summary: '绿', command: 'node --test', exitCode: 0 });
  await platform.submitExecutionResult(missionId, exec.attemptId, {
    outcome: 'completed',
    summary: '好了',
    changedFiles: ['src/a.ts'],
    evidenceIds: [],
    notes: '无',
  });
  await platform.finishAttempt(missionId, exec.attemptId, { endedBy: 'structured_submit' });
  return { coord: coord.attemptId, workItemId };
}

const codeOf = (e: unknown) => (e as { code?: string }).code;

describe('协调者评审必须逐条交代', () => {
  test('缺 / 条数不对 / 原文不符 / 状态非法 / 缺证据 / 缺说明 / accept 含 fail → 拒收，工作项仍 submitted', async () => {
    const { platform } = makePlatform();
    const { coord, workItemId } = await submitted(platform);
    const base = { workItemId, verdict: 'accept' as const, reasons: ['r'], requiredChanges: [] };
    const cases: [unknown, string, RegExp][] = [
      [{ ...base }, 'ACCEPTANCE_RESULTS_REQUIRED', /2 条验收标准/],
      [{ ...base, acceptanceResults: GOOD.slice(0, 1) }, 'ACCEPTANCE_RESULTS_MISMATCH', /1 条、验收标准 2 条/],
      [{ ...base, acceptanceResults: [{ ...GOOD[0], criterion: 'A 成立' }, GOOD[1]] }, 'ACCEPTANCE_RESULTS_MISMATCH', /照抄验收原文：「A 行为成立」/],
      [{ ...base, acceptanceResults: [{ ...GOOD[0], status: 'ok' }, GOOD[1]] }, 'ACCEPTANCE_RESULT_INVALID', /pass \/ fail/],
      [{ ...base, acceptanceResults: [{ criterion: 'A 行为成立', status: 'pass' }, GOOD[1]] }, 'ACCEPTANCE_EVIDENCE_REQUIRED', /证据/],
      [{ ...base, acceptanceResults: [GOOD[0], { criterion: 'B 在真机上验过', status: 'unverified' }] }, 'ACCEPTANCE_NOTE_REQUIRED', /原因/],
      [{ ...base, acceptanceResults: [GOOD[0], { criterion: 'B 在真机上验过', status: 'not_applicable', note: '  ' }] }, 'ACCEPTANCE_NOTE_REQUIRED', /原因/],
      [{ ...base, acceptanceResults: [GOOD[0], { criterion: 'B 在真机上验过', status: 'fail' }] }, 'ACCEPT_WITH_FAILED_CRITERION', /fail/],
    ];
    for (const [input, code, message] of cases) {
      await assert.rejects(
        platform.reviewExecutionResult('M1', coord, input as never),
        (e: unknown) => codeOf(e) === code && message.test((e as Error).message),
        code,
      );
    }
    const view = await platform.getMissionView('M1');
    assert.equal(view.workItems[0]!.status, 'submitted');
    assert.equal(view.workItems[0]!.lastReview, undefined);
  });

  test('合规：accept 连同逐条结果记下，事件带计数与未验证项；reject 可以带 fail', async () => {
    const { platform, activity } = makePlatform();
    const { coord, workItemId } = await submitted(platform);
    const out = await platform.reviewExecutionResult('M1', coord, {
      workItemId,
      verdict: 'accept',
      reasons: ['A 复跑过'],
      requiredChanges: [],
      acceptanceResults: GOOD,
    });
    assert.equal(out.status, 'accepted');
    const view = await platform.getMissionView('M1');
    assert.deepEqual(view.workItems[0]!.lastReview?.acceptanceResults, GOOD);
    const event = (await activity.list('M1')).find((e) => e.kind === 'review.recorded');
    assert.deepEqual((event?.data as { acceptance?: unknown }).acceptance, { pass: 1, fail: 0, unverified: 1, not_applicable: 0 });
    assert.deepEqual((event?.data as { unverified?: unknown }).unverified, ['B 在真机上验过']);

    // 同一项目的改动名额被 M1 占着，换个项目。
    const second = await submitted(platform, 'M2', ORDER, 'P2');
    const rejected = await platform.reviewExecutionResult('M2', second.coord, {
      workItemId: second.workItemId,
      verdict: 'reject',
      reasons: ['A 没过'],
      requiredChanges: ['修 A'],
      acceptanceResults: [{ criterion: 'A 行为成立', status: 'fail' }, GOOD[1]!],
    });
    assert.equal(rejected.status, 'rejected');
  });

  test('没有验收标准的旧工作项不要求；给了非空结果反而对不上', async () => {
    const { platform } = makePlatform();
    const legacy = { ...ORDER, acceptance: [] };
    const { coord, workItemId } = await submitted(platform, 'M1', legacy);
    await assert.rejects(
      platform.reviewExecutionResult('M1', coord, {
        workItemId,
        verdict: 'accept',
        reasons: ['r'],
        requiredChanges: [],
        acceptanceResults: GOOD,
      }),
      (e: unknown) => codeOf(e) === 'ACCEPTANCE_RESULTS_MISMATCH',
    );
    const ok = await platform.reviewExecutionResult('M1', coord, { workItemId, verdict: 'accept', reasons: ['r'], requiredChanges: [] });
    assert.equal(ok.status, 'accepted');
  });
});

describe('内核：不变式与旧快照', () => {
  function submittedItem(): WorkItem {
    const mission = Project.create({ id: 'p' }).createMission({ id: 'm' });
    mission.startExecuting();
    const item = mission.createWorkItem({ id: 'w-1', title: 't' });
    item.dispatch();
    item.submit({ files: ['a.ts'] });
    return item;
  }

  test('不经平台直接 review：accept 含 fail 也挡；状态非法算坏记录', () => {
    assert.throws(
      () => submittedItem().review('accept', { attemptId: 'c-1', reasons: [], requiredChanges: [], acceptanceResults: [{ criterion: 'A', status: 'fail' }] }),
      (e: unknown) => e instanceof InvariantViolationError && e.code === 'ACCEPT_WITH_FAILED_CRITERION',
    );
    assert.throws(
      () =>
        submittedItem().review('reject', {
          attemptId: 'c-1',
          reasons: [],
          requiredChanges: ['x'],
          acceptanceResults: [{ criterion: 'A', status: 'maybe' as never }],
        }),
      (e: unknown) => e instanceof InvariantViolationError && e.code === 'INVALID_REVIEW_RECORD',
    );
  });

  test('快照往返保留逐条结果；旧快照（没有这个字段）照常恢复', () => {
    const item = submittedItem();
    item.review('accept', { attemptId: 'c-1', reasons: ['r'], requiredChanges: [], acceptanceResults: GOOD });
    assert.deepEqual(WorkItem.restore(item.toSnapshot()).reviews[0]?.acceptanceResults, GOOD);

    const legacy = submittedItem();
    legacy.review('accept', { attemptId: 'c-1', reasons: ['r'], requiredChanges: [] });
    const snapshot = legacy.toSnapshot();
    const restored = WorkItem.restore(JSON.parse(JSON.stringify(snapshot)));
    assert.equal(restored.reviews[0]?.acceptanceResults, undefined);
    assert.equal(restored.status, 'accepted');
  });
});

describe('落盘与 L3 眼前', () => {
  test('写进状态文件、另一个进程读回来一样；l3 show 列出未验证项', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-review-acc-'));
    dirs.push(dir);
    const statePath = join(dir, 'state.json');
    const writer = await buildPersistentPlatform(statePath, { workspace: new InPlaceWorkspaceManager() });
    const { coord, workItemId } = await submitted(writer.platform);
    await writer.platform.reviewExecutionResult('M1', coord, {
      workItemId,
      verdict: 'accept',
      reasons: ['A 复跑过'],
      requiredChanges: [],
      acceptanceResults: GOOD,
    });
    writer.persist();

    const reader = await buildPersistentPlatform(statePath, { workspace: new InPlaceWorkspaceManager(), reconcile: false });
    assert.deepEqual((await reader.platform.getMissionView('M1')).workItems[0]!.lastReview?.acceptanceResults, GOOD);

    const shown = spawnSync(process.execPath, [L3, 'show', 'M1', '--state', statePath], { encoding: 'utf8' });
    assert.equal(shown.status, 0, `${shown.stdout}${shown.stderr}`);
    assert.match(shown.stdout, /逐条：1\/2 pass/);
    assert.match(shown.stdout, /⚠ 未验证 B 在真机上验过 —— 没有真机/);
    assert.doesNotMatch(shown.stdout, /A 行为成立 ——/, '过了的那条不用摆出来');
  });
});
