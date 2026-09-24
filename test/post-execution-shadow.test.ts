/**
 * J2：POST_EXECUTION shadow 接进生产（Jev 设计 §9）。
 *
 * 守住：
 *   - 状态输入只取平台可信数据：工单、那一次提交、那个 attempt 的证据；改动清单优先平台 diff，
 *     拿不到才退回自报并标来源；工具次数记满上限时标为拿不到
 *   - 默认远端预算投影，事件记下截断；往外发之前先脱敏
 *   - 事件带齐对账用的键；评估器出错 / 超时、审计写失败都只记不抛，主流程不受影响
 *   - 只在注入了评估器且钩子含 POST_EXECUTION 时调用；同一次提交只问一次
 *   - 编排器：Standard 交卷后、协调者评审前；Lightweight 验收通过（含因规模被扣下）后；硬失败不问
 *   - 装配：buildDecisionDeps 与 startServer / run-mission / run-plan 三个入口
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { Platform } from '../src/application/platform.ts';
import {
  buildDecisionDeps,
  buildPersistentPlatform,
  buildPlatform,
  makeIssuer,
} from '../src/main.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import type { WorkspaceManager } from '../src/application/workspace.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';
import { ValidationEngine } from '../src/application/validation/engine.ts';
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import type { ChangedPathReader, CommandRunner } from '../src/application/validation/ports.ts';
import {
  DEFAULT_POST_EXECUTION_REMOTE_BUDGET,
  POST_EXECUTION_SHADOW_EVENT_KIND,
  postExecutionInputFrom,
  recordPostExecutionShadow,
} from '../src/application/post-execution-shadow.ts';
import { buildPostExecutionState } from '../src/application/post-execution-state.ts';
import { POST_EXECUTION_V1 } from '../src/application/decision-question-registry.ts';
import type { PostExecutionRemoteState } from '../src/application/post-execution-remote-input.ts';
import type {
  ActivityEvent,
  ActivityLog,
  DecisionAnswerSet,
  DecisionHook,
  PostExecutionEvaluator,
} from '../src/application/ports.ts';
import type {
  EvidenceRecord,
  ExecutionResultBody,
  MissionContract,
  WorkOrder,
} from '../src/kernel/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

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
  constraints: ['不改公共接口'],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: ['别动 bar'],
  contextRefs: [],
};

const PLAN = {
  findings: 'foo 一直返回 0',
  rejectedHypotheses: [] as string[],
  decisions: ['直接改初始值'],
  direction: '改 src/foo.ts',
  risks: [] as string[],
};

const RESULT: ExecutionResultBody = {
  outcome: 'completed',
  summary: '改了初始值',
  changedFiles: ['src/foo.ts', 'src/claimed-only.ts'],
  evidenceIds: ['E-1'],
  notes: '无',
};

const EVIDENCE: EvidenceRecord[] = [
  { id: 'E-1', attemptId: 'A-2', kind: 'test', summary: 'node --test 全绿', command: 'node --test', exitCode: 0 },
  { id: 'E-2', attemptId: 'A-2', kind: 'observation', summary: '看了一眼日志' },
];

const ANSWERS: DecisionAnswerSet = {
  answers: { objective_satisfied: { kind: 'score', value: 0.9 } },
  meta: { resolvedModel: 'jev-1.13.0', usage: { inputTokens: 10, outputTokens: 2 } },
};

function recordingEvaluator(impl?: (state: PostExecutionRemoteState) => Promise<DecisionAnswerSet>) {
  const seen: PostExecutionRemoteState[] = [];
  const evaluator: PostExecutionEvaluator = {
    kind: 'fake-post',
    async evaluate(state) {
      seen.push(state);
      return impl ? impl(state) : ANSWERS;
    },
  };
  return { evaluator, seen };
}

/** 每次 now() 往前走 stepMs：latencyMs 就是两次读钟之差。 */
function steppingClock(stepMs = 250) {
  let t = Date.parse('2026-09-24T00:00:00.000Z');
  return {
    now: () => {
      const d = new Date(t);
      t += stepMs;
      return d;
    },
  };
}

function shadowEvents(events: readonly ActivityEvent[]): ActivityEvent[] {
  return events.filter((e) => e.kind === POST_EXECUTION_SHADOW_EVENT_KIND);
}

function dataOf(event: ActivityEvent): Record<string, any> {
  return event.data as Record<string, any>;
}

/* ============================ A. 映射 ============================ */

describe('postExecutionInputFrom：只取平台可信数据', () => {
  test('工单取 objective / constraints + doNot / acceptance；证据取那个 attempt 的原样', () => {
    const { input } = postExecutionInputFrom({ order: ORDER, result: RESULT, evidence: EVIDENCE });
    assert.deepEqual(input.workOrder, {
      objective: '改 foo',
      constraints: ['不改公共接口', '不要：别动 bar'],
      acceptanceCriteria: ['foo() === 1'],
    });
    assert.equal(input.executorResult.status, 'completed');
    assert.equal(input.executorResult.summary, '改了初始值');
    // 自报引用到的证据才进 claimedEvidence.summaries；全部证据进 evidence（验证分桶用）。
    assert.deepEqual(input.executorResult.claimedEvidence.evidenceIds, ['E-1']);
    assert.deepEqual(input.executorResult.claimedEvidence.summaries, [
      { id: 'E-1', kind: 'test', summary: 'node --test 全绿' },
    ]);
    assert.deepEqual(input.evidence, [
      { id: 'E-1', kind: 'test', exitCode: 0, summary: 'node --test 全绿' },
      { id: 'E-2', kind: 'observation', summary: '看了一眼日志' },
    ]);
  });

  test('改动清单：有平台 diff 用 diff（workspace_diff），拿不到才退回自报（executor_claim）', () => {
    const trusted = postExecutionInputFrom({ order: ORDER, result: RESULT, evidence: EVIDENCE, trustedFiles: ['src/foo.ts'] });
    assert.equal(trusted.filesSource, 'workspace_diff');
    assert.deepEqual(trusted.input.fileChanges.files, ['src/foo.ts']);
    // 平台算出来「一个都没改」也是可信数据，不能因为是空的就换成自报。
    const empty = postExecutionInputFrom({ order: ORDER, result: RESULT, evidence: EVIDENCE, trustedFiles: [] });
    assert.equal(empty.filesSource, 'workspace_diff');
    assert.deepEqual(empty.input.fileChanges.files, []);
    const claimed = postExecutionInputFrom({ order: ORDER, result: RESULT, evidence: EVIDENCE });
    assert.equal(claimed.filesSource, 'executor_claim');
    assert.deepEqual(claimed.input.fileChanges.files, ['src/foo.ts', 'src/claimed-only.ts']);
  });

  test('工具次数：没到上限照报；记满 200 条（可能被截过）或没有记录，标为拿不到', () => {
    const toolCount = (n?: number) =>
      buildPostExecutionState(
        postExecutionInputFrom({
          order: ORDER,
          result: RESULT,
          evidence: EVIDENCE,
          ...(n !== undefined ? { toolActivityCount: n } : {}),
        }).input,
      ).execution.toolCount;
    assert.equal(toolCount(3), 3);
    assert.equal(toolCount(199), 199);
    assert.deepEqual(toolCount(200), { unavailable: true });
    assert.deepEqual(toolCount(undefined), { unavailable: true });
  });
});

/* ============================ B. 记事件 ============================ */

function shadowArgs() {
  const { input, filesSource } = postExecutionInputFrom({
    order: ORDER,
    result: RESULT,
    evidence: EVIDENCE,
    trustedFiles: ['src/foo.ts'],
    toolActivityCount: 3,
  });
  return { projectId: 'P', missionId: 'M', workItemId: 'W-1', submittedAttemptId: 'A-2', input, filesSource };
}

describe('recordPostExecutionShadow：只记事件，从不抛', () => {
  test('成功：对账键、答案、模型与用量、耗时、截断信息都在；评估器拿到的是远端投影', async () => {
    const activity = new InMemoryActivityLog(new FixedClock());
    const { evaluator, seen } = recordingEvaluator();
    await recordPostExecutionShadow({ evaluator, activity, clock: steppingClock(250) }, shadowArgs());

    const events = await activity.list('M');
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.kind, 'decision.post_execution');
    assert.equal(event.projectId, 'P');
    assert.equal(event.workItemId, 'W-1');
    const data = dataOf(event);
    assert.equal(data.schemaVersion, 1);
    assert.equal(data.hook, 'POST_EXECUTION');
    assert.equal(data.mode, 'shadow');
    assert.equal(data.providerKind, 'fake-post');
    assert.deepEqual(data.ids, { projectId: 'P', missionId: 'M', workItemId: 'W-1', submittedAttemptId: 'A-2' });
    assert.equal(data.questionSetId, POST_EXECUTION_V1.id);
    assert.equal(data.filesSource, 'workspace_diff');
    assert.equal(data.quality, 'success');
    assert.equal(data.latencyMs, 250);
    assert.deepEqual(data.answers, ANSWERS.answers);
    assert.equal(data.resolvedModel, 'jev-1.13.0');
    assert.deepEqual(data.usage, { inputTokens: 10, outputTokens: 2 });
    assert.equal(data.truncation.applied, false);
    assert.deepEqual(data.truncation.omittedFields, []);

    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]!.fileChanges.files, ['src/foo.ts']);
    assert.equal(seen[0]!.execution.toolCount, 3);
    assert.equal(seen[0]!.truncation.applied, false);
  });

  test('默认远端预算：超长摘要被截，事件记下截了哪一格', async () => {
    const activity = new InMemoryActivityLog(new FixedClock());
    const { evaluator, seen } = recordingEvaluator();
    const long = 'x'.repeat(DEFAULT_POST_EXECUTION_REMOTE_BUDGET.maxSummaryBytes + 500);
    const { input, filesSource } = postExecutionInputFrom({
      order: ORDER,
      result: { ...RESULT, summary: long },
      evidence: EVIDENCE,
    });
    await recordPostExecutionShadow(
      { evaluator, activity, clock: new FixedClock() },
      { ...shadowArgs(), input, filesSource },
    );
    const data = dataOf((await activity.list('M'))[0]!);
    assert.equal(data.quality, 'success');
    assert.equal(data.truncation.applied, true);
    assert.ok(data.truncation.omittedFields.includes('executorResult.summary'), JSON.stringify(data.truncation));
    assert.ok(data.truncation.originalBytes > data.truncation.emittedBytes);
    assert.ok(
      Buffer.byteLength(seen[0]!.executorResult.summary) <= DEFAULT_POST_EXECUTION_REMOTE_BUDGET.maxSummaryBytes,
    );
  });

  test('往外发之前先脱敏：工单与摘要里的 key 到不了评估器', async () => {
    const { evaluator, seen } = recordingEvaluator();
    const secret = `sk-${'a'.repeat(24)}`;
    const { input, filesSource } = postExecutionInputFrom({
      order: { ...ORDER, objective: `用 ${secret} 调接口` },
      result: { ...RESULT, summary: `跑通了，api_key=${secret}` },
      evidence: EVIDENCE,
    });
    await recordPostExecutionShadow(
      { evaluator, activity: new InMemoryActivityLog(new FixedClock()), clock: new FixedClock() },
      { ...shadowArgs(), input, filesSource },
    );
    const sent = JSON.stringify(seen[0]);
    assert.ok(!sent.includes(secret), sent);
    assert.match(sent, /REDACTED/);
  });

  test('评估器抛错：只记 provider_error（错误原文脱敏、截到 200 字），不抛', async () => {
    const activity = new InMemoryActivityLog(new FixedClock());
    const secret = `sk-${'b'.repeat(24)}`;
    const { evaluator } = recordingEvaluator(async () => {
      throw new Error(`upstream 500 ${secret} ${'y'.repeat(500)}`);
    });
    await recordPostExecutionShadow({ evaluator, activity, clock: steppingClock(40) }, shadowArgs());
    const data = dataOf((await activity.list('M'))[0]!);
    assert.equal(data.quality, 'provider_error');
    assert.equal(data.answers, undefined);
    assert.equal(data.latencyMs, 40);
    assert.ok(data.error.length <= 200);
    assert.ok(!data.error.includes(secret), data.error);
    assert.equal(data.ids.submittedAttemptId, 'A-2');
  });

  test('输入建不出状态：state_error，评估器一次都不调', async () => {
    const activity = new InMemoryActivityLog(new FixedClock());
    const { evaluator, seen } = recordingEvaluator();
    const args = shadowArgs();
    const bad = { ...args.input, executorResult: { ...args.input.executorResult, status: 'failed' as never } };
    await recordPostExecutionShadow({ evaluator, activity, clock: new FixedClock() }, { ...args, input: bad });
    assert.equal(seen.length, 0);
    assert.equal(dataOf((await activity.list('M'))[0]!).quality, 'state_error');
  });

  test('审计写失败也不抛', async () => {
    const { evaluator, seen } = recordingEvaluator();
    const broken: ActivityLog = {
      async append() {
        throw new Error('disk full');
      },
      async list() {
        return [];
      },
    };
    await recordPostExecutionShadow({ evaluator, activity: broken, clock: new FixedClock() }, shadowArgs());
    assert.equal(seen.length, 1);
  });
});

/* ============================ C. Platform ============================ */

/** 有隔离工作区的替身：worktreePath 在，diff 回平台自己算的清单。 */
class DiffWorkspace extends InPlaceWorkspaceManager {
  calls: string[][] = [];
  files: string[] = ['src/foo.ts'];
  fail = false;
  worktreePath(missionId: string, projectRoot: string): string {
    return `${projectRoot}/.coagent-worktrees/${missionId}`;
  }
  override async diff(missionId?: string, baseRevision?: string, projectRoot?: string) {
    this.calls.push([String(missionId), String(baseRevision), String(projectRoot)]);
    if (this.fail) throw new Error('git 挂了');
    return { stat: `${this.files.length} files`, files: [...this.files] };
  }
}

function standardPlatform(opts: {
  evaluator?: PostExecutionEvaluator;
  hooks?: ReadonlySet<DecisionHook>;
  workspace?: WorkspaceManager;
} = {}) {
  const clock = new FixedClock();
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    workspace: opts.workspace ?? new InPlaceWorkspaceManager(),
    activity,
    clock,
    ids,
    ...(opts.evaluator ? { postExecutionEvaluator: opts.evaluator } : {}),
    ...(opts.hooks ? { decisionHooks: opts.hooks } : {}),
  });
  return { platform, activity };
}

/** 走平台接口到「执行者交卷、这一跳收了尾」。 */
async function upToSubmitted(
  platform: Platform,
  opts: { toolCalls?: readonly string[]; submit?: boolean; workspaceRef?: boolean } = {},
) {
  await platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT });
  if (opts.workspaceRef) {
    await platform.recordWorkspace('M', { projectRoot: '/repo', branch: 'mission/M', baseRevision: 'base123' });
  }
  const { attemptId: coordinator } = await platform.startCoordinatorAttempt('M');
  await platform.updatePlan('M', coordinator, PLAN);
  const { workItemId } = await platform.createWorkItem('M', coordinator, { title: 'w', order: ORDER });
  await platform.dispatchWorkItems('M', coordinator, [workItemId]);
  await platform.finishAttempt('M', coordinator, { endedBy: 'structured_submit' });
  const { attemptId: executor } = await platform.startExecutorAttempt('M', workItemId);
  const { evidenceId } = await platform.submitEvidence('M', executor, {
    kind: 'test',
    summary: 'node --test 全绿',
    command: 'node --test',
    exitCode: 0,
  });
  await platform.submitEvidence('M', executor, { kind: 'observation', summary: '顺手看了日志' });
  if (opts.submit !== false) {
    await platform.submitExecutionResult('M', executor, {
      outcome: 'completed',
      summary: '改了初始值',
      changedFiles: ['src/foo.ts', 'src/claimed-only.ts'],
      evidenceIds: [evidenceId],
      notes: '无',
    });
  }
  await platform.finishAttempt('M', executor, {
    endedBy: opts.submit === false ? 'no_structured_result' : 'structured_submit',
    toolCalls: opts.toolCalls ?? ['coagent_get_work_order', 'coagent_submit_evidence', 'coagent_submit_execution_result'],
  });
  return { workItemId, executorAttemptId: executor, evidenceId };
}

describe('Platform.runPostExecutionShadow', () => {
  test('交卷后问一次：事件对得上那次提交；证据来自那个 attempt；工具次数来自 attempt 记录', async () => {
    const { evaluator, seen } = recordingEvaluator();
    const { platform, activity } = standardPlatform({ evaluator });
    const s = await upToSubmitted(platform);

    await platform.runPostExecutionShadow('M', s.workItemId);

    assert.equal(seen.length, 1);
    const events = shadowEvents(await activity.list('M'));
    assert.equal(events.length, 1);
    const data = dataOf(events[0]!);
    assert.deepEqual(data.ids, {
      projectId: 'P',
      missionId: 'M',
      workItemId: s.workItemId,
      submittedAttemptId: s.executorAttemptId,
    });
    assert.equal(data.quality, 'success');
    const state = seen[0]!;
    assert.deepEqual(state.workOrder.constraints, ['不改公共接口', '不要：别动 bar']);
    assert.deepEqual(state.executorResult.claimedEvidence.evidenceIds, [s.evidenceId]);
    assert.equal(state.verification.tests.status, 'passed');
    assert.equal(state.execution.toolCount, 3);
    // 原地模式没有隔离工作区：退回自报，并在事件里标明。
    assert.equal(data.filesSource, 'executor_claim');
    assert.deepEqual(state.fileChanges.files, ['src/foo.ts', 'src/claimed-only.ts']);
  });

  test('有隔离工作区：改动清单用平台 diff（相对分叉基线），不用自报；diff 失败才退回自报', async () => {
    const workspace = new DiffWorkspace();
    const { evaluator, seen } = recordingEvaluator();
    const { platform, activity } = standardPlatform({ evaluator, workspace });
    const s = await upToSubmitted(platform, { workspaceRef: true });

    await platform.runPostExecutionShadow('M', s.workItemId);
    assert.deepEqual(workspace.calls, [['M', 'base123', '/repo']]);
    assert.deepEqual(seen[0]!.fileChanges.files, ['src/foo.ts']);
    assert.equal(dataOf(shadowEvents(await activity.list('M'))[0]!).filesSource, 'workspace_diff');

    const failing = new DiffWorkspace();
    failing.fail = true;
    const second = recordingEvaluator();
    const other = standardPlatform({ evaluator: second.evaluator, workspace: failing });
    const t = await upToSubmitted(other.platform, { workspaceRef: true });
    await other.platform.runPostExecutionShadow('M', t.workItemId);
    assert.deepEqual(second.seen[0]!.fileChanges.files, ['src/foo.ts', 'src/claimed-only.ts']);
    assert.equal(dataOf(shadowEvents(await other.activity.list('M'))[0]!).filesSource, 'executor_claim');
  });

  test('证据只取交卷的那个 attempt：前一次没交卷的尝试留下的失败证据不混进来', async () => {
    const { evaluator, seen } = recordingEvaluator();
    const { platform } = standardPlatform({ evaluator });
    await platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT });
    const { attemptId: coordinator } = await platform.startCoordinatorAttempt('M');
    await platform.updatePlan('M', coordinator, PLAN);
    const { workItemId } = await platform.createWorkItem('M', coordinator, { title: 'w', order: ORDER });
    await platform.dispatchWorkItems('M', coordinator, [workItemId]);
    await platform.finishAttempt('M', coordinator, { endedBy: 'structured_submit' });
    // 第一次：跑挂了，只留下一条失败的测试证据。
    const { attemptId: first } = await platform.startExecutorAttempt('M', workItemId);
    await platform.submitEvidence('M', first, { kind: 'test', summary: '红了', command: 'node --test', exitCode: 1 });
    await platform.finishAttempt('M', first, { endedBy: 'upstream_failure', failureMessage: '403' });
    // 第二次：交卷。
    const { attemptId: second } = await platform.startExecutorAttempt('M', workItemId);
    const { evidenceId } = await platform.submitEvidence('M', second, { kind: 'test', summary: '绿了', command: 'node --test', exitCode: 0 });
    await platform.submitExecutionResult('M', second, { ...RESULT, evidenceIds: [evidenceId] });
    await platform.finishAttempt('M', second, { endedBy: 'structured_submit' });

    await platform.runPostExecutionShadow('M', workItemId);
    const state = seen[0]!;
    assert.equal(state.verification.tests.status, 'passed', JSON.stringify(state.verification.tests));
    assert.deepEqual(state.verification.tests.failedChecks, []);
    assert.deepEqual(state.executorResult.claimedEvidence.evidenceIds, [evidenceId]);
  });

  test('工具记录记满 200 条：toolCount 标为拿不到，而不是报 200', async () => {
    const { evaluator, seen } = recordingEvaluator();
    const { platform } = standardPlatform({ evaluator });
    const s = await upToSubmitted(platform, { toolCalls: Array.from({ length: 250 }, () => 'bash') });
    await platform.runPostExecutionShadow('M', s.workItemId);
    assert.deepEqual(seen[0]!.execution.toolCount, { unavailable: true });
  });

  test('没注入评估器 / 钩子不含 POST_EXECUTION / 还没交卷：一次都不调、不记事件', async () => {
    const none = standardPlatform();
    const a = await upToSubmitted(none.platform);
    await none.platform.runPostExecutionShadow('M', a.workItemId);
    assert.equal(shadowEvents(await none.activity.list('M')).length, 0);

    const preOnly = recordingEvaluator();
    const hooksOff = standardPlatform({ evaluator: preOnly.evaluator, hooks: new Set<DecisionHook>(['PRE_DISPATCH']) });
    const b = await upToSubmitted(hooksOff.platform);
    await hooksOff.platform.runPostExecutionShadow('M', b.workItemId);
    assert.equal(preOnly.seen.length, 0);
    assert.equal(shadowEvents(await hooksOff.activity.list('M')).length, 0);

    const early = recordingEvaluator();
    const notYet = standardPlatform({ evaluator: early.evaluator });
    const c = await upToSubmitted(notYet.platform, { submit: false });
    await notYet.platform.runPostExecutionShadow('M', c.workItemId);
    assert.equal(early.seen.length, 0);
    assert.equal(shadowEvents(await notYet.activity.list('M')).length, 0);

    // 找不到的工作项 / Mission 也只是静默返回。
    await notYet.platform.runPostExecutionShadow('M', 'W-nope');
    await notYet.platform.runPostExecutionShadow('M-nope', 'W-1');
  });

  test('同一次提交只问一次：崩溃后接着跑再触发，不再多花一次调用', async () => {
    const { evaluator, seen } = recordingEvaluator();
    const { platform, activity } = standardPlatform({ evaluator });
    const s = await upToSubmitted(platform);
    await platform.runPostExecutionShadow('M', s.workItemId);
    await platform.runPostExecutionShadow('M', s.workItemId);
    assert.equal(seen.length, 1);
    assert.equal(shadowEvents(await activity.list('M')).length, 1);
  });

  test('非权威：评估器抛错也不抛，Mission 与工作项的状态一点不变', async () => {
    const { evaluator } = recordingEvaluator(async () => {
      throw new Error('timeout after 1500ms');
    });
    const { platform, activity } = standardPlatform({ evaluator });
    const s = await upToSubmitted(platform);
    const before = await platform.getMissionView('M');

    await platform.runPostExecutionShadow('M', s.workItemId);

    assert.deepEqual(await platform.getMissionView('M'), before);
    const data = dataOf(shadowEvents(await activity.list('M'))[0]!);
    assert.equal(data.quality, 'provider_error');
    assert.match(data.error, /timeout/);
  });
});

/* ============================ D. 编排器 ============================ */

const EXECUTOR_HAPPY: ScriptTable = {
  'executor:W-1': {
    steps: [
      { tool: 'coagent_get_work_order', body: {} },
      {
        tool: 'coagent_submit_evidence',
        body: { kind: 'test', summary: 'node --test 全绿', command: 'node --test', exitCode: 0 },
      },
      {
        tool: 'coagent_submit_execution_result',
        body: (previous) => ({
          outcome: 'completed',
          summary: '改了初始值',
          changedFiles: ['src/foo.ts'],
          evidenceIds: [previous.evidenceId],
          notes: '无',
        }),
      },
    ],
  },
};

const REVIEW_AND_SUBMIT = [
  { tool: 'coagent_get_mission', body: {} },
  {
    tool: 'coagent_review_execution_result',
    body: {
      workItemId: 'W-1',
      verdict: 'accept',
      acceptanceResults: ORDER.acceptance.map((criterion) => ({
        criterion,
        status: 'pass' as const,
        evidence: '测试替身：逐条核过',
      })),
      reasons: ['复跑过 node --test'],
      requiredChanges: [],
    },
  },
  {
    tool: 'coagent_submit_mission_result',
    body: {
      outcome: 'delivered',
      summary: '改好了',
      acceptanceEvidence: ['node --test 退出码 0'],
      memoryDelta: [],
      openRisks: [],
    },
  },
];

const COORDINATOR_STANDARD: ScriptTable = {
  'coordinator:-:0': {
    steps: [
      { tool: 'coagent_get_mission', body: {} },
      { tool: 'coagent_update_plan', body: PLAN },
      { tool: 'coagent_create_work_item', body: { title: '修 foo', ...ORDER } },
      { tool: 'coagent_dispatch_work_item', body: (previous) => ({ workItemIds: [previous.workItemId] }) },
    ],
  },
  'coordinator:-:1': { steps: REVIEW_AND_SUBMIT },
};

/** 升级到 Standard 之后协调者只做 L2：一轮复核 + 交卷。 */
const COORDINATOR_AFTER_PROMOTION: ScriptTable = {
  'coordinator:-:0': { steps: REVIEW_AND_SUBMIT },
};

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

async function orchestrated(opts: {
  coordinator: ScriptTable;
  evaluator: PostExecutionEvaluator;
  /** 给了就注入 Lightweight 机器验收。 */
  validation?: { exitCode: number; files: readonly string[] };
}) {
  const clock = new FixedClock();
  const activity = new InMemoryActivityLog(clock);
  const projects = new InMemoryProjectRepository();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const workspace = new InPlaceWorkspaceManager();
  const runner: CommandRunner = {
    run: async () => ({ exitCode: opts.validation?.exitCode ?? 0, timedOut: false, durationMs: 1, output: 'x' }),
  };
  const paths: ChangedPathReader = {
    async listChanged() {
      return opts.validation?.files ?? ['src/foo.ts'];
    },
  };
  const platform = new Platform({
    projects,
    deliveries,
    workspace,
    activity,
    clock,
    ids,
    postExecutionEvaluator: opts.evaluator,
    ...(opts.validation
      ? {
          validation: {
            engine: new ValidationEngine({ clock, ids: new SequentialIds(), commandRunner: runner, changedPathReader: paths }),
            reports: new InMemoryValidationReportRepository(),
          },
        }
      : {}),
  });
  const tokens = new RunTokenRegistry();
  const server: Server = createApi({ platform, tokens, deliveries });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const orchestrator = new Orchestrator({
    platform,
    tokens: makeIssuer(platform, tokens),
    baseUrl,
    workspace,
    coordinator: {
      runtime: new ScriptedRuntime(opts.coordinator),
      candidates: [{ endpoint: 'local', profileId: 'coordinator-a' }],
    },
    executor: {
      runtime: new ScriptedRuntime(EXECUTOR_HAPPY),
      candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
    },
  });
  return { platform, activity, projects, orchestrator };
}

async function seedLightweight(projects: InMemoryProjectRepository, platform: Platform, order: WorkOrder) {
  const project = await projects.ensure('P');
  project.createMission({
    id: 'M-lw',
    contract: CONTRACT,
    executionMode: 'lightweight',
    runKind: 'mutation',
    origin: { clientType: 'cli', conversationRef: 'local-cli' },
  });
  await projects.save(project);
  await platform.createLightweightWorkItem('M-lw', { order, workItemId: 'W-1' });
}

const LW_ORDER: WorkOrder = {
  ...ORDER,
  validation: { commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }] },
};

function kinds(events: readonly ActivityEvent[]): string[] {
  return events.map((e) => {
    if (e.kind === 'review.recorded') {
      return (e.data as { authority?: string })?.authority === 'validator' ? 'review.recorded:validator' : 'review.recorded';
    }
    return e.kind;
  });
}

describe('编排器接线：什么时候问', () => {
  test('Standard：执行者交卷之后、协调者评审之前问一次', async () => {
    const { evaluator, seen } = recordingEvaluator();
    const h = await orchestrated({ coordinator: COORDINATOR_STANDARD, evaluator });
    await h.platform.createMission({ projectId: 'P', missionId: 'M-std', contract: CONTRACT });

    const result = await h.orchestrator.runMission('M-std', { projectRoot: process.cwd() });
    assert.deepEqual(result, { kind: 'awaiting_l3_review' });

    assert.equal(seen.length, 1);
    const order = kinds(await h.activity.list('M-std'));
    const submitted = order.indexOf('execution_result.submitted');
    const shadow = order.indexOf('decision.post_execution');
    const review = order.indexOf('review.recorded');
    assert.ok(submitted >= 0 && shadow > submitted && review > shadow, order.join(' → '));
    assert.equal(order.filter((k) => k === 'decision.post_execution').length, 1);
    // 对账键就是那次交卷的 attempt。
    const events = await h.activity.list('M-std');
    const submit = events.find((e) => e.kind === 'execution_result.submitted')!;
    assert.equal(dataOf(shadowEvents(events)[0]!).ids.submittedAttemptId, submit.attemptId);
  });

  test('评估器出错：主流程照走，结局与没有 shadow 时一样', async () => {
    const { evaluator, seen } = recordingEvaluator(async () => {
      throw new Error('socket hang up');
    });
    const h = await orchestrated({ coordinator: COORDINATOR_STANDARD, evaluator });
    await h.platform.createMission({ projectId: 'P', missionId: 'M-err', contract: CONTRACT });

    const result = await h.orchestrator.runMission('M-err', { projectRoot: process.cwd() });

    assert.deepEqual(result, { kind: 'awaiting_l3_review' });
    assert.deepEqual(
      h.orchestrator.hops.map((x) => `${x.role}:${x.endedBy}`),
      ['coordinator:structured_submit', 'executor:structured_submit', 'coordinator:structured_submit'],
    );
    const view = await h.platform.getMissionView('M-err');
    assert.equal(view.workItems[0]!.status, 'accepted');
    assert.equal(seen.length, 1);
    assert.equal(dataOf(shadowEvents(await h.activity.list('M-err'))[0]!).quality, 'provider_error');
  });

  test('Lightweight 验收通过：机器验收之后问一次', async () => {
    const { evaluator, seen } = recordingEvaluator();
    const h = await orchestrated({ coordinator: {}, evaluator, validation: { exitCode: 0, files: ['src/foo.ts'] } });
    await seedLightweight(h.projects, h.platform, LW_ORDER);

    const result = await h.orchestrator.runMission('M-lw', { projectRoot: process.cwd() });
    assert.deepEqual(result, { kind: 'awaiting_l3_review' });

    assert.equal(seen.length, 1);
    const order = kinds(await h.activity.list('M-lw'));
    assert.ok(order.indexOf('decision.post_execution') > order.indexOf('validation.reported'), order.join(' → '));
    assert.equal(order.filter((k) => k === 'decision.post_execution').length, 1);
  });

  test('Lightweight 验收通过但改动超出轻量规模（被扣下）：照样问一次，在升级之前', async () => {
    const { evaluator, seen } = recordingEvaluator();
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    const h = await orchestrated({ coordinator: COORDINATOR_AFTER_PROMOTION, evaluator, validation: { exitCode: 0, files } });
    await seedLightweight(h.projects, h.platform, { ...LW_ORDER, allowedScope: ['src/'] });

    const result = await h.orchestrator.runMission('M-lw', { projectRoot: process.cwd() });
    assert.equal(result.kind, 'awaiting_l3_review');
    const view = await h.platform.getMissionView('M-lw');
    assert.equal(view.promotions[0]?.triggerCode, 'changed_files_gt_3');

    assert.equal(seen.length, 1);
    const order = kinds(await h.activity.list('M-lw'));
    assert.ok(order.indexOf('decision.post_execution') < order.indexOf('mission.promoted'), order.join(' → '));
    // 升级后协调者复核的是同一次提交：不会为它再问一次。
    assert.equal(order.filter((k) => k === 'decision.post_execution').length, 1);
  });

  test('Lightweight 验收硬失败：不问（Jev 不推翻确定性结果）', async () => {
    const { evaluator, seen } = recordingEvaluator();
    const h = await orchestrated({ coordinator: COORDINATOR_AFTER_PROMOTION, evaluator, validation: { exitCode: 1, files: ['src/foo.ts'] } });
    await seedLightweight(h.projects, h.platform, LW_ORDER);

    const result = await h.orchestrator.runMission('M-lw', { projectRoot: process.cwd() });
    assert.equal(result.kind, 'awaiting_l3_review');
    assert.equal((await h.platform.getMissionView('M-lw')).promotions[0]?.triggerCode, 'validator_failure_unrepairable');
    assert.equal(seen.length, 0);
    assert.equal(shadowEvents(await h.activity.list('M-lw')).length, 0);
  });
});

/* ============================ E. 装配 ============================ */

describe('buildDecisionDeps：三个入口共用的装配', () => {
  function recordingEnv(raw: Record<string, string | undefined>) {
    const touched: string[] = [];
    const env = new Proxy(raw, {
      get(target, key) {
        if (typeof key === 'string') touched.push(key);
        return target[key as string];
      },
    });
    return { env, touched };
  }

  test('off / 缺省 / 不认识的值：空依赖，除 COAGENT_DECISION_MODE 外一个 env 都不读', () => {
    for (const mode of [undefined, 'off', 'ENFORCED']) {
      const { env, touched } = recordingEnv({
        ...(mode !== undefined ? { COAGENT_DECISION_MODE: mode } : {}),
        TYPESAFE_API_KEY: 'should-not-read',
        COAGENT_DECISION_HOOKS: 'pre',
        COAGENT_DECISION_TIMEOUT_MS: '1',
      });
      const deps = buildDecisionDeps(env, async () => {
        throw new Error('fetch must not run');
      });
      assert.deepEqual(deps, {}, String(mode));
      assert.deepEqual([...new Set(touched)], ['COAGENT_DECISION_MODE'], String(mode));
    }
  });

  test('shadow + key：PRE provider、POST 评估器、钩子（缺省只有 POST）都装上，启动不联网', () => {
    let fetchCalls = 0;
    const fetchImpl: typeof globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('boot must not fetch');
    };
    const deps = buildDecisionDeps({ COAGENT_DECISION_MODE: 'shadow', TYPESAFE_API_KEY: 'k' }, fetchImpl);
    assert.equal(deps.decisionProvider?.kind, 'jev-system-one');
    assert.equal(deps.postExecutionEvaluator?.kind, 'jev-system-one');
    assert.deepEqual([...(deps.decisionHooks ?? [])], ['POST_EXECUTION']);
    const withPre = buildDecisionDeps(
      { COAGENT_DECISION_MODE: 'shadow', TYPESAFE_API_KEY: 'k', COAGENT_DECISION_HOOKS: 'pre,post' },
      fetchImpl,
    );
    assert.deepEqual([...(withPre.decisionHooks ?? [])].sort(), ['POST_EXECUTION', 'PRE_DISPATCH']);
    assert.equal(fetchCalls, 0);
  });

  test('shadow 缺 key：直接抛，说清缺什么', () => {
    assert.throws(() => buildDecisionDeps({ COAGENT_DECISION_MODE: 'shadow' }), /TYPESAFE_API_KEY/);
  });
});

describe('构建器把 POST 评估器交到 Platform', () => {
  const dirs: string[] = [];
  const releases: Array<() => void> = [];
  after(() => {
    for (const release of releases) release();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  test('buildPersistentPlatform：给了就问一次，不给零次', async () => {
    for (const give of [true, false]) {
      const dir = mkdtempSync(join(tmpdir(), 'coagent-j2-'));
      dirs.push(dir);
      const { evaluator, seen } = recordingEvaluator();
      const built = await buildPersistentPlatform(join(dir, 'state.json'), {
        workspace: new InPlaceWorkspaceManager(),
        ...(give ? { postExecutionEvaluator: evaluator } : {}),
      });
      if ('releaseLock' in built && typeof built.releaseLock === 'function') releases.push(built.releaseLock);
      const s = await upToSubmitted(built.platform);
      await built.platform.runPostExecutionShadow('M', s.workItemId);
      assert.equal(seen.length, give ? 1 : 0, give ? '给了评估器应问一次' : '不给应零次');
    }
  });

  test('buildPlatform（全内存）：第 5 个参数就是评估器', async () => {
    const { evaluator, seen } = recordingEvaluator();
    const built = buildPlatform(new InPlaceWorkspaceManager(), undefined, undefined, undefined, evaluator);
    const s = await upToSubmitted(built.platform);
    await built.platform.runPostExecutionShadow('M', s.workItemId);
    assert.equal(seen.length, 1);
  });

  test('buildPgPlatform 与两个 CLI：评估器原样透传（源码约束，PG 与真 CLI 不在单测里起）', () => {
    const main = readFileSync(join(root, 'src', 'main.ts'), 'utf8');
    const pg = main.slice(main.indexOf('export async function buildPgPlatform'), main.indexOf('export function makeIssuer'));
    assert.match(pg, /postExecutionEvaluator\?: PostExecutionEvaluator;/);
    assert.match(pg, /\.\.\.\(postExecutionEvaluator \? \{ postExecutionEvaluator \} : \{\}\)/);
    const server = main.slice(main.indexOf('export async function startServer'));
    assert.match(server, /buildDecisionDeps\(env,/);
    assert.match(server, /buildPgPlatform\(\{ \.\.\.decision,/);
    assert.match(server, /buildPersistentPlatform\(statePath, \{ \.\.\.decision,/);

    for (const cli of ['run-mission.ts', 'run-plan.ts']) {
      const source = readFileSync(join(root, 'src', cli), 'utf8');
      const deps = source.indexOf('buildDecisionDeps(process.env)');
      assert.ok(deps > 0, `${cli} 没按 env 组装决策依赖`);
      for (const builder of ['buildPgPlatform({', 'buildPersistentPlatform(statePath, {']) {
        const at = source.indexOf(builder);
        assert.ok(at > deps, `${cli}：${builder} 要在组装决策依赖之后`);
        assert.match(source.slice(at, at + 160), /\.\.\.decision,/, `${cli}：${builder} 没带上决策依赖`);
      }
    }
  });
});

describe('CLI：shadow 缺 key 在读任何输入之前就失败', () => {
  function run(cli: string, mode: string | undefined) {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    delete env.COAGENT_DECISION_HOOKS;
    delete env.COAGENT_STORE;
    if (mode === undefined) delete env.COAGENT_DECISION_MODE;
    else env.COAGENT_DECISION_MODE = mode;
    env.COAGENT_AGENT_ENV_PASSTHROUGH = '-';
    const missing = join(tmpdir(), `coagent-j2-missing-${process.pid}.json`);
    const result = spawnSync(process.execPath, [join(root, 'src', cli), missing], {
      encoding: 'utf8',
      env,
      timeout: 60_000,
    });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  }

  for (const cli of ['run-mission.ts', 'run-plan.ts']) {
    test(`${cli}：shadow 缺 key → 退出 1、点名 TYPESAFE_API_KEY，还没去读输入文件`, () => {
      const shadow = run(cli, 'shadow');
      assert.equal(shadow.status, 1, shadow.out);
      assert.match(shadow.out, /TYPESAFE_API_KEY/);
      assert.doesNotMatch(shadow.out, /ENOENT/);
    });

    test(`${cli}：off 模式不因决策配置失败（走到读输入文件才停）`, () => {
      const off = run(cli, undefined);
      assert.equal(off.status, 1, off.out);
      assert.doesNotMatch(off.out, /TYPESAFE_API_KEY/);
      assert.match(off.out, /ENOENT/);
    });
  }
});
