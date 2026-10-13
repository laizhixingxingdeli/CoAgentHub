/**
 * 状态一致性（P0）：有执行结果、有失败的验证报告，工单却停在 dispatched。
 *
 * 案例（MiRing-V0-probe 的 W-621）：契约 r8 把 Mission 退回 planning；恢复时机器验证没过，
 * 平台把工单续派回 dispatched——可调度器只在 executing 阶段跑执行者，于是没有人会去跑它，
 * 协调者又收到 `WorkItem: dispatched -> rejected is not allowed`，只能让 L3 作废重建。
 *
 * 守三件事：Mission 不在 executing 时不续派（留在 submitted 交协调者依法 reject）；已经卡住的
 * 存量状态能被受控恢复（核实尝试 / 租约 / 修订号、署名、幂等）；编排器叫协调者之前自己恢复。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Orchestrator } from '../src/application/orchestrator.ts';
import { PLATFORM_BLOCKED_EVENT_KIND, Platform, PlatformRuleError } from '../src/application/platform.ts';
import { makeIssuer } from '../src/main.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import { ValidationEngine } from '../src/application/validation/engine.ts';
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: ['不得改 Contract'],
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
  validation: { commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }] },
};

const PLAN = {
  findings: 'foo 一直返回 0',
  rejectedHypotheses: [],
  decisions: ['直接改初始值'],
  direction: '改 src/foo.ts',
  risks: [],
};

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

/** 验证报告会失败：改动里多了一个范围外的文件（就像 VR-339 里被越界的 docs/honor-win-probe.md）。 */
function build() {
  const clock = new FixedClock('2026-06-01T12:00:00.000Z');
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const reports = new InMemoryValidationReportRepository();
  const engine = new ValidationEngine({
    clock,
    ids: new SequentialIds(),
    commandRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' }) },
    changedPathReader: { listChanged: async () => ['src/foo.ts', 'docs/stray.md'] },
  });
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    workspace: new InPlaceWorkspaceManager(),
    activity,
    clock,
    ids,
    validation: { engine, reports },
  });
  return { platform, activity, deliveries };
}

type Fixture = ReturnType<typeof build>;

/** 走到「W-1 已交卷、验证报告没过」。Mission 此刻在 executing。 */
async function toFailedValidation(f: Fixture, missionId = 'M1') {
  const { platform } = f;
  await platform.createMission({ projectId: 'P', missionId, contract: CONTRACT });
  await platform.recordWorkspace(missionId, { projectRoot: '/proj', branch: `mission/${missionId}`, baseRevision: 'base0' });
  const { attemptId: coord } = await platform.startCoordinatorAttempt(missionId);
  await platform.updatePlan(missionId, coord, PLAN);
  await platform.createWorkItem(missionId, coord, { title: '修 foo', order: ORDER });
  await platform.submitContractCheck(missionId, coord, { verdict: 'ok', summary: '已核对' });
  await platform.dispatchWorkItems(missionId, coord, ['W-1']);
  await platform.finishAttempt(missionId, coord, { endedBy: 'structured_submit' });
  await platform.recordStandardValidationBaseline({ missionId, workItemId: 'W-1', head: 'base0' });
  const { attemptId: exec } = await platform.startExecutorAttempt(missionId, 'W-1');
  await platform.submitEvidence(missionId, exec, { kind: 'test', summary: '全绿', command: 'node --test', exitCode: 0 });
  await platform.submitExecutionResult(missionId, exec, {
    outcome: 'completed', summary: '改好了', changedFiles: ['src/foo.ts'], evidenceIds: [], notes: '无',
  });
  await platform.finishAttempt(missionId, exec, { endedBy: 'structured_submit' });
  const report = await platform.validateStandardWorkItem({ missionId, workItemId: 'W-1', cwd: '/proj' });
  assert.equal(report?.passed, false, '前置：验证报告没过');
  return { exec };
}

const reviseContract = (f: Fixture, missionId = 'M1') =>
  f.platform.reviseContract(missionId, { ...CONTRACT, intent: '把 X 修好（r2：改了说法）' });

const reject = (f: Fixture, coord: string, missionId = 'M1') =>
  f.platform.reviewExecutionResult(missionId, coord, {
    workItemId: 'W-1', verdict: 'reject', reasons: ['验证没过'], requiredChanges: ['去掉范围外的 docs/stray.md'],
    acceptanceResults: [{ criterion: 'foo() === 1', status: 'fail' }],
  });

const statusOf = async (f: Fixture, missionId = 'M1') =>
  (await f.platform.getMissionView(missionId)).workItems.find((item) => item.id === 'W-1')?.status;

const blockedEvents = async (f: Fixture, missionId = 'M1') =>
  (await f.activity.list(missionId)).filter((event) => event.kind === PLATFORM_BLOCKED_EVENT_KIND);

describe('机器续派只在 Mission 能跑执行者时发生', () => {
  test('契约修订把 Mission 退回 planning 后，验证没过的工单留在 submitted，协调者可以依法 reject', async () => {
    const f = build();
    await toFailedValidation(f);
    await reviseContract(f);
    assert.equal((await f.platform.getMissionView('M1')).status, 'planning');

    const result = await f.platform.autoRedispatchStandardWorkItem({ missionId: 'M1', workItemId: 'W-1' });
    assert.deepEqual(result, { redispatched: false, reason: 'mission_not_executing' });
    assert.equal(await statusOf(f), 'submitted', '原样留给协调者：没有变成无人执行的 dispatched');

    const { attemptId: coord } = await f.platform.startCoordinatorAttempt('M1');
    assert.deepEqual(await reject(f, coord), { status: 'rejected' });
  });
});

describe('受控恢复：有结果却停在 dispatched 的存量状态', () => {
  /** 存量卡死状态：先在 executing 时被机器续派，随后契约修订把 Mission 退回 planning。 */
  async function stuck() {
    const f = build();
    await toFailedValidation(f);
    const redispatch = await f.platform.autoRedispatchStandardWorkItem({ missionId: 'M1', workItemId: 'W-1' });
    assert.equal(redispatch.redispatched, true);
    await reviseContract(f);
    assert.equal(await statusOf(f), 'dispatched');
    const { attemptId: coord } = await f.platform.startCoordinatorAttempt('M1');
    await assert.rejects(
      () => reject(f, coord),
      /dispatched -> rejected is not allowed/,
    );
    await f.platform.finishAttempt('M1', coord, { endedBy: 'structured_submit' });
    return f;
  }

  test('自动路径：核实后收成 blocked；成果与报告保留；重复调用幂等；协调者可修订再派发', async () => {
    const f = await stuck();
    const first = await f.platform.recoverStrandedWorkItem({
      missionId: 'M1', workItemId: 'W-1', source: 'stranded_dispatch', expectedAttemptId: 'W-1.exec-1', orderRevision: 'r1',
    });
    assert.equal(first.converted, true);
    assert.match(first.reason, /已有执行结果和验证报告 VR-1/);
    assert.equal(await statusOf(f), 'blocked');
    const view = (await f.platform.getMissionView('M1')).workItems.find((item) => item.id === 'W-1')!;
    assert.equal(view.hasResult, true, '成果保留');
    assert.equal(view.validationReport?.reportId, 'VR-1', '失败的验证报告保留');

    const events = await blockedEvents(f);
    assert.equal(events.length, 1);
    assert.equal((events[0]!.data as { source: string }).source, 'stranded_dispatch');
    assert.equal(Object.hasOwn(events[0]!.data as object, 'orderRevision'), false);

    // 幂等：第二次什么都不写。
    const again = await f.platform.recoverStrandedWorkItem({ missionId: 'M1', workItemId: 'W-1', source: 'stranded_dispatch' });
    assert.equal(again.converted, false);
    assert.equal(again.alreadyRecovered, true);
    assert.equal((await blockedEvents(f)).length, 1);

    // 恢复之后走正常平台流程：修订 → 重新派发（也把 Mission 推回 executing）。
    const { attemptId: coord } = await f.platform.startCoordinatorAttempt('M1');
    await f.platform.reviseWorkOrder('M1', coord, 'W-1', { ...ORDER, requiredBehaviour: 'foo 返回 1，且不碰 docs/' });
    await f.platform.submitContractCheck('M1', coord, { verdict: 'ok', summary: 'r2 已核对' });
    await f.platform.dispatchWorkItems('M1', coord, ['W-1']);
    assert.equal(await statusOf(f), 'dispatched');
    assert.equal((await f.platform.getMissionView('M1')).status, 'executing');
  });

  test('不动真正在执行的工单；快照对不上、Mission 仍在 executing 时自动路径都拒绝，且不留事件', async () => {
    const f = await stuck();
    // 过期快照。
    const stale = await f.platform.recoverStrandedWorkItem({
      missionId: 'M1', workItemId: 'W-1', source: 'stranded_dispatch', expectedAttemptId: 'W-1.exec-9',
    });
    assert.equal(stale.converted, false);
    assert.match(stale.reason, /快照已过期/);
    const revised = await f.platform.recoverStrandedWorkItem({
      missionId: 'M1', workItemId: 'W-1', source: 'stranded_dispatch', orderRevision: 'r7',
    });
    assert.match(revised.reason, /工单已修订/);

    // 有活执行者：再开一次尝试，恢复必须拒绝。
    const { attemptId: live } = await f.platform.startExecutorAttempt('M1', 'W-1');
    const busy = await f.platform.recoverStrandedWorkItem({ missionId: 'M1', workItemId: 'W-1', source: 'stranded_dispatch' });
    assert.equal(busy.converted, false);
    assert.match(busy.reason, new RegExp(`${live}.*in_progress`));
    assert.equal(await statusOf(f), 'dispatched');
    await f.platform.finishAttempt('M1', live, { endedBy: 'upstream_failure', failureMessage: 'x' });

    // Mission 回到 executing：执行者会接着跑，自动路径不收尾。
    const { attemptId: coord } = await f.platform.startCoordinatorAttempt('M1');
    await f.platform.submitContractCheck('M1', coord, { verdict: 'ok', summary: 'r2 已核对' });
    await f.platform.updatePlan('M1', coord, PLAN);
    await f.platform.createWorkItem('M1', coord, { title: '另一张', order: { ...ORDER, allowedScope: ['src/bar.ts'] } });
    await f.platform.dispatchWorkItems('M1', coord, ['W-2']);
    await f.platform.finishAttempt('M1', coord, { endedBy: 'structured_submit' });
    assert.equal((await f.platform.getMissionView('M1')).status, 'executing');
    const running = await f.platform.recoverStrandedWorkItem({ missionId: 'M1', workItemId: 'W-1', source: 'stranded_dispatch' });
    assert.match(running.reason, /仍在 executing/);

    assert.equal((await blockedEvents(f)).length, 0, '拒绝时无副作用');
  });

  test('操作员路径：必须署名写理由；通过核实后审计里有署名', async () => {
    const f = await stuck();
    await assert.rejects(
      () => f.platform.recoverStrandedWorkItem({ missionId: 'M1', workItemId: 'W-1', source: 'operator_recovery' }),
      (error) => error instanceof PlatformRuleError && error.code === 'RECOVERY_SIGNATURE_REQUIRED',
    );
    const done = await f.platform.recoverStrandedWorkItem({
      missionId: 'M1', workItemId: 'W-1', source: 'operator_recovery',
      reviewer: '检视者（测试）', reason: '核对过 W-1.exec-1 已结束、无租约、VR-1 失败',
    });
    assert.equal(done.converted, true);
    const [event] = await blockedEvents(f);
    const data = event!.data as { source: string; reviewer: string; operatorReason: string };
    assert.equal(data.source, 'operator_recovery');
    assert.equal(data.reviewer, '检视者（测试）');
    assert.match(data.operatorReason, /VR-1 失败/);
  });
});

describe('HTTP 恢复入口', () => {
  test('POST /recover：署名必填；成功后幂等；响应说清有没有转换', async () => {
    const f = build();
    await toFailedValidation(f);
    await f.platform.autoRedispatchStandardWorkItem({ missionId: 'M1', workItemId: 'W-1' });
    await reviseContract(f);
    const server: Server = createApi({ platform: f.platform, tokens: new RunTokenRegistry(), deliveries: f.deliveries });
    await listenLoopback(server, 0);
    servers.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/missions/M1/work-items/W-1/recover`;
    const post = (body: unknown) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const unsigned = await post({ reason: '只有理由' });
    assert.ok(unsigned.status >= 400 && unsigned.status < 500, '缺署名是调用方错误');
    assert.equal(await statusOf(f), 'dispatched', '被拒的恢复不动状态');

    const done = await (await post({ reviewer: 'L3', reason: '核对过无租约', expectedAttemptId: 'W-1.exec-1' })).json();
    assert.equal(done.converted, true);
    assert.equal(await statusOf(f), 'blocked');
    const again = await (await post({ reviewer: 'L3', reason: '再来一次' })).json();
    assert.equal(again.alreadyRecovered, true);
    assert.equal((await blockedEvents(f)).length, 1);
  });
});

describe('编排器叫协调者之前自己恢复', () => {
  test('存量卡死状态 + runMission：协调者这一跳面对的是 blocked，不是无法处理的 dispatched', async () => {
    const f = build();
    await toFailedValidation(f);
    await f.platform.autoRedispatchStandardWorkItem({ missionId: 'M1', workItemId: 'W-1' });
    await reviseContract(f);

    const tokens = new RunTokenRegistry();
    const server: Server = createApi({ platform: f.platform, tokens, deliveries: f.deliveries });
    await listenLoopback(server, 0);
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const coordinator = new ScriptedRuntime({ 'coordinator:-:0': { steps: [{ tool: 'coagent_get_mission', body: {} }] } });
    const executor = new ScriptedRuntime({});
    const orchestrator = new Orchestrator({
      platform: f.platform,
      tokens: makeIssuer(f.platform, tokens),
      baseUrl,
      workspace: new InPlaceWorkspaceManager(),
      coordinator: { runtime: coordinator, candidates: [{ endpoint: 'local', profileId: 'coordinator-a' }] },
      executor: { runtime: executor, candidates: [{ endpoint: 'local', profileId: 'exec-a' }] },
    });

    await orchestrator.runMission('M1', { projectRoot: '/proj', maxRounds: 1 });

    assert.equal(executor.specs.length, 0, 'planning 阶段不为它启动执行者');
    assert.equal(await statusOf(f), 'blocked');
    const [event] = await blockedEvents(f);
    assert.equal((event!.data as { source: string }).source, 'stranded_dispatch');
    const mission = coordinator.transcript.find((row) => row.tool === 'coagent_get_mission')?.json as {
      workItemIndex: { id: string; status: string }[];
    };
    assert.equal(mission.workItemIndex.find((item) => item.id === 'W-1')?.status, 'blocked', '协调者读到的已经是 blocked');
  });
});
