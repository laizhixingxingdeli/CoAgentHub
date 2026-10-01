/**
 * HTTP 面的端到端：走真实的 node:http，不 mock。
 *
 * 重点不是路由拼对了没有，是**身份不能靠调用方自述** —— 执行者拿着自己的
 * run token 去调协调者的工具，必须被挡。
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { request as httpRequest } from 'node:http';

import {
  API_VERSION,
  createApi,
  drainApi,
  HOSTED_RUN_HEARTBEAT_IDLE_MS,
  type HostedRunHandler,
} from '../src/api/server.ts';
import {
  LoopbackHttpError,
  LoopbackIdentityError,
  loopbackRunRequest,
} from '../src/application/loopback-control-client.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform, PlatformRuleError, type QueueClaimIdentity } from '../src/application/platform.ts';
import { PlanRun } from '../src/application/plan-run.ts';
import { FilePlanRunStore } from '../src/application/plan-run-store.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import {
  FileActivityLog,
  FileAgentPoolRepository,
  FileCandidateCircuitRepository,
  FileDeliveryRepository,
  FileProjectRepository,
  FileQueuedHopRepository,
  FileStateStore,
  PersistentIds,
} from '../src/application/file-store.ts';
import { InMemoryAgentPoolRepository } from '../src/application/agent-pool.ts';
import type { ControlPrincipal, ControlPrincipalResolver } from '../src/api/control-auth.ts';
import type { ClaimFence } from '../src/application/durable-scheduler.ts';
import {
  PgActivityLog,
  PgDeliveryRepository,
  PgIds,
  PgProjectRepository,
  PgQueuedHopRepository,
  PgStateStore,
} from '../src/application/pg-store.ts';
import { ensureTestDatabase } from './helpers/pg.ts';

const CONTRACT = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: ['不得改 Contract'],
};

const ORDER = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
};

let base: string;
let server: ReturnType<typeof createApi>;

before(async () => {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
  server = createApi({ platform, tokens: new RunTokenRegistry(), deliveries });
  await listenLoopback(server, 0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

async function call(
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, never> }> {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-coagent-run': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, never> };
}

describe('HTTP 面', () => {
  test('健康检查', async () => {
    const { status, json } = await call('/api/health');
    assert.equal(status, 200);
    assert.equal((json as { ok: boolean }).ok, true);
  });

  test('没有 run token 的工具调用一律 401', async () => {
    const { status, json } = await call('/api/agent/coagent_get_mission', {});
    assert.equal(status, 401);
    assert.equal((json as { error: string }).error, 'UNKNOWN_RUN_TOKEN');
  });

  test('完整一趟：建 Mission → 协调者规划派发 → 执行者提交 → 协调者验收 → 交卷', async () => {
    const created = await call('/api/missions', {
      projectId: 'P',
      missionId: 'M-api',
      contract: CONTRACT,
    });
    assert.equal(created.status, 201);

    const coord = await call('/api/missions/M-api/coordinator-attempts', {});
    const coordToken = (coord.json as { token: string }).token;
    const coordAttempt = (coord.json as { attemptId: string }).attemptId;

    // 没 Plan 先拒绝——规则在平台，不在 prompt。
    const tooEarly = await call(
      '/api/agent/coagent_create_work_item',
      { title: 'W', ...ORDER },
      coordToken,
    );
    assert.equal(tooEarly.status, 409);
    assert.equal((tooEarly.json as { error: string }).error, 'PLAN_REQUIRED');

    const planned = await call(
      '/api/agent/coagent_update_plan',
      {
        findings: '查到了',
        rejectedHypotheses: [],
        decisions: [],
        direction: '这么改',
        risks: [],
      },
      coordToken,
    );
    assert.equal(planned.status, 200);
    assert.equal((planned.json as { planRevision: number }).planRevision, 1);

    const wi = await call(
      '/api/agent/coagent_create_work_item',
      { title: 'W', ...ORDER },
      coordToken,
    );
    assert.equal(wi.status, 200);
    const workItemId = (wi.json as { workItemId: string }).workItemId;

    // W-334 门禁：Standard 派发前必须先提交当前契约修订的核对结论。
    await call(
      '/api/agent/coagent_submit_contract_check',
      { verdict: 'ok', summary: '测试契约已核对' },
      coordToken,
    );

    const dispatched = await call(
      '/api/agent/coagent_dispatch_work_item',
      { workItemIds: [workItemId] },
      coordToken,
    );
    assert.equal(dispatched.status, 200);

    const exec = await call(
      `/api/missions/M-api/work-items/${workItemId}/executor-attempts`,
      {},
    );
    const execToken = (exec.json as { token: string }).token;
    const execAttempt = (exec.json as { attemptId: string }).attemptId;

    const order = await call('/api/agent/coagent_get_work_order', {}, execToken);
    assert.equal(order.status, 200);
    assert.equal((order.json as { workItemId: string }).workItemId, workItemId);

    const evidence = await call(
      '/api/agent/coagent_submit_evidence',
      { kind: 'test', summary: 'node --test 全绿', command: 'node --test', exitCode: 0 },
      execToken,
    );
    assert.equal(evidence.status, 200);

    const submitted = await call(
      '/api/agent/coagent_submit_execution_result',
      {
        outcome: 'completed',
        summary: '改好了',
        changedFiles: ['src/foo.ts'],
        evidenceIds: [(evidence.json as { evidenceId: string }).evidenceId],
        notes: '无',
      },
      execToken,
    );
    assert.equal(submitted.status, 200);
    assert.equal((submitted.json as { status: string }).status, 'submitted');

    await call(`/api/missions/M-api/attempts/${execAttempt}/finish`, {
      endedBy: 'structured_submit',
      usage: { input: 10, output: 5, cacheRead: 900, cacheWrite: 0, total: 915, quality: 'reported' },
    });

    // finish 不需要调用方回传 token；平台按 attemptId 吊销后，迟到调用仍必须被拒绝。
    const late = await call('/api/agent/coagent_submit_evidence', { kind: 'test', summary: '迟到' }, execToken);
    assert.equal(late.status, 401);

    const reviewed = await call(
      '/api/agent/coagent_review_execution_result',
      { workItemId, verdict: 'accept', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })), reasons: ['自己跑过 node --test'], requiredChanges: [] },
      coordToken,
    );
    assert.equal(reviewed.status, 200);
    assert.equal((reviewed.json as { status: string }).status, 'accepted');

    const delivered = await call(
      '/api/agent/coagent_submit_mission_result',
      {
        outcome: 'delivered',
        summary: '交付',
        acceptanceEvidence: ['node --test 退出码 0'],
        memoryDelta: [],
        openRisks: [],
      },
      coordToken,
    );
    assert.equal(delivered.status, 200);

    await call(`/api/missions/M-api/attempts/${coordAttempt}/finish`, {
      endedBy: 'structured_submit',
      token: coordToken,
    });

    const view = await call('/api/missions/M-api');
    const json = view.json as unknown as {
      workItems: { status: string }[];
      result: { outcome: string };
      usage: { cacheRead: number };
    };
    assert.equal(json.workItems[0].status, 'accepted');
    assert.equal(json.result.outcome, 'delivered');
    assert.equal(json.usage.cacheRead, 900, '用量按分项聚合');
  });

  test('执行者拿自己的 token 调协调者的工具会被挡', async () => {
    await call('/api/missions', { projectId: 'P2', missionId: 'M-guard', contract: CONTRACT });
    const coord = await call('/api/missions/M-guard/coordinator-attempts', {});
    const coordToken = (coord.json as { token: string }).token;
    await call(
      '/api/agent/coagent_update_plan',
      { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] },
      coordToken,
    );
    const wi = await call('/api/agent/coagent_create_work_item', { title: 'W', ...ORDER }, coordToken);
    const workItemId = (wi.json as { workItemId: string }).workItemId;
    // W-334 门禁：Standard 派发前必须先提交当前契约修订的核对结论。
    await call('/api/agent/coagent_submit_contract_check', { verdict: 'ok', summary: '测试契约已核对' }, coordToken);
    await call('/api/agent/coagent_dispatch_work_item', { workItemIds: [workItemId] }, coordToken);
    const exec = await call(`/api/missions/M-guard/work-items/${workItemId}/executor-attempts`, {});
    const execToken = (exec.json as { token: string }).token;

    const stolen = await call(
      '/api/agent/coagent_update_plan',
      { findings: '我想改计划', rejectedHypotheses: [], decisions: [], direction: 'x', risks: [] },
      execToken,
    );
    assert.equal(stolen.status, 409);
    assert.equal((stolen.json as { error: string }).error, 'WRONG_ROLE');
  });

  test('agent 请求体自述身份不被采信，错误体不回显 run token', async () => {
    await call('/api/missions', { projectId: 'P3', missionId: 'M-spoof', contract: CONTRACT });
    const coord = await call('/api/missions/M-spoof/coordinator-attempts', {});
    const coordToken = (coord.json as { token: string }).token;
    await call(
      '/api/agent/coagent_update_plan',
      { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] },
      coordToken,
    );
    const wi = await call('/api/agent/coagent_create_work_item', { title: 'W', ...ORDER }, coordToken);
    const workItemId = (wi.json as { workItemId: string }).workItemId;
    // W-334 门禁：Standard 派发前必须先提交当前契约修订的核对结论。
    await call('/api/agent/coagent_submit_contract_check', { verdict: 'ok', summary: '测试契约已核对' }, coordToken);
    await call('/api/agent/coagent_dispatch_work_item', { workItemIds: [workItemId] }, coordToken);
    const exec = await call(`/api/missions/M-spoof/work-items/${workItemId}/executor-attempts`, {});
    const execToken = (exec.json as { token: string }).token;

    const stolen = await call(
      '/api/agent/coagent_update_plan',
      {
        role: 'coordinator',
        attemptId: (coord.json as { attemptId: string }).attemptId,
        missionId: 'M-spoof',
        findings: '自述协调者',
        rejectedHypotheses: [],
        decisions: [],
        direction: 'x',
        risks: [],
      },
      execToken,
    );
    assert.equal(stolen.status, 409);
    assert.equal((stolen.json as { error: string }).error, 'WRONG_ROLE');
    const echoed = JSON.stringify(stolen.json);
    assert.equal(echoed.includes(execToken), false);
    assert.equal(echoed.includes(coordToken), false);
  });

  test('协调者可原子修订 created / blocked 的工单，修订号递增且事件记录 changedFields', async () => {
    await call('/api/missions', {
      projectId: 'P-revise',
      missionId: 'M-revise',
      contract: CONTRACT,
    });
    const coord = await call('/api/missions/M-revise/coordinator-attempts', {});
    const coordToken = (coord.json as { token: string }).token;
    await call(
      '/api/agent/coagent_update_plan',
      { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] },
      coordToken,
    );
    const wi = await call('/api/agent/coagent_create_work_item', { title: 'W', ...ORDER }, coordToken);
    const workItemId = (wi.json as { workItemId: string }).workItemId;

    // created：整份替换，修订号 r1 -> r2。
    const firstRevise = await call(
      '/api/agent/coagent_revise_work_order',
      { workItemId, ...ORDER, objective: '改 bar', allowedScope: ['src/bar.ts'] },
      coordToken,
    );
    assert.equal(firstRevise.status, 200);
    assert.equal((firstRevise.json as { revision: string }).revision, 'r2');
    assert.deepEqual(
      [...(firstRevise.json as { changedFields: string[] }).changedFields].sort(),
      ['allowedScope', 'objective'],
    );

    const events = (await call('/api/missions/M-revise/activity')).json as unknown as ActivityRow[];
    const revised = events.filter((row) => row.kind === 'work_item.order_revised');
    assert.equal(revised.length, 1);
    assert.equal(revised[0]?.workItemId, workItemId);
    assert.equal((revised[0]?.data as { revision: string }).revision, 'r2');
    assert.deepEqual((revised[0]?.data as { changedFields: string[] }).changedFields, [
      'allowedScope',
      'objective',
    ]);

    // blocked：执行者报卡住之后仍可修订，修订号 r2 -> r3。
    // W-334 门禁：Standard 派发前必须先提交当前契约修订的核对结论。
    await call('/api/agent/coagent_submit_contract_check', { verdict: 'ok', summary: '测试契约已核对' }, coordToken);
    await call('/api/agent/coagent_dispatch_work_item', { workItemIds: [workItemId] }, coordToken);
    const exec = await call(`/api/missions/M-revise/work-items/${workItemId}/executor-attempts`, {});
    const execToken = (exec.json as { token: string }).token;
    const blocked = await call(
      '/api/agent/coagent_report_blocked',
      { reason: '工单前提不成立', whatWasTried: [], needsFromUpstream: '补上下文' },
      execToken,
    );
    assert.equal(blocked.status, 200);

    const secondRevise = await call(
      '/api/agent/coagent_revise_work_order',
      { workItemId, ...ORDER, objective: '改 baz', allowedScope: ['src/bar.ts'] },
      coordToken,
    );
    assert.equal(secondRevise.status, 200);
    assert.equal((secondRevise.json as { revision: string }).revision, 'r3');
    assert.deepEqual((secondRevise.json as { changedFields: string[] }).changedFields, ['objective']);
  });

  test('运行中的工单拒绝修订并指出下一步，原工单不变；非协调者不能借路由修订', async () => {
    await call('/api/missions', {
      projectId: 'P-revise-guard',
      missionId: 'M-revise-guard',
      contract: CONTRACT,
    });
    const coord = await call('/api/missions/M-revise-guard/coordinator-attempts', {});
    const coordToken = (coord.json as { token: string }).token;
    await call(
      '/api/agent/coagent_update_plan',
      { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] },
      coordToken,
    );
    const wi = await call(
      '/api/agent/coagent_create_work_item',
      { title: 'W', ...ORDER },
      coordToken,
    );
    const workItemId = (wi.json as { workItemId: string }).workItemId;
    // W-334 门禁：Standard 派发前必须先提交当前契约修订的核对结论。
    await call('/api/agent/coagent_submit_contract_check', { verdict: 'ok', summary: '测试契约已核对' }, coordToken);
    await call('/api/agent/coagent_dispatch_work_item', { workItemIds: [workItemId] }, coordToken);
    const exec = await call(
      `/api/missions/M-revise-guard/work-items/${workItemId}/executor-attempts`,
      {},
    );
    const execToken = (exec.json as { token: string }).token;

    const rejected = await call(
      '/api/agent/coagent_revise_work_order',
      { workItemId, ...ORDER, objective: '不该生效' },
      coordToken,
    );
    assert.equal(rejected.status, 409);
    assert.equal((rejected.json as { error: string }).error, 'WORK_ITEM_NOT_REVISABLE');
    // 错误里要有下一步，而不是一句 invalid state。
    assert.match((rejected.json as { message: string }).message, /执行/);

    // 原工单没被动过：修订号仍是 r1，objective 未变，也没有修订事件。
    const order = await call('/api/agent/coagent_get_work_order', {}, execToken);
    assert.equal(order.status, 200);
    const view = order.json as unknown as { order: { objective: string; orderRevision: string } };
    assert.equal(view.order.objective, ORDER.objective);
    assert.equal(view.order.orderRevision, 'r1');
    const events = (await call('/api/missions/M-revise-guard/activity')).json as unknown as ActivityRow[];
    assert.equal(events.filter((row) => row.kind === 'work_item.order_revised').length, 0);

    // 执行者拿着自己的 token 调修订路由：角色闸直接挡在入口。
    const stolen = await call(
      '/api/agent/coagent_revise_work_order',
      { workItemId, ...ORDER, objective: '越权' },
      execToken,
    );
    assert.equal(stolen.status, 409);
    assert.equal((stolen.json as { error: string }).error, 'WRONG_ROLE');
  });
  test('协调者经 HTTP 工具建/修超标工单：软警告审计同步、直接调用无警告字段', async () => {
    // --- HTTP 路径：超标工单照常成功，响应与事件同步含软警告 ---
    await call('/api/missions', {
      projectId: 'P-warn',
      missionId: 'M-warn',
      contract: CONTRACT,
    });
    const coord = await call('/api/missions/M-warn/coordinator-attempts', {});
    const coordToken = (coord.json as { token: string }).token;
    await call(
      '/api/agent/coagent_update_plan',
      { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] },
      coordToken,
    );

    // 触发三类软警告：allowedScope 超 2 项（含一目录冒充文件）、verification 超 2 条、contextRefs 为空。
    const violatingOrder = {
      objective: '改多个文件',
      allowedScope: ['src/a.ts', 'src/b.ts', 'src/c/dir'],
      requiredBehaviour: '做点事',
      constraints: [],
      acceptance: ['a() === 1', 'b() === 1'],
      verification: ['v1', 'v2', 'v3'],
      doNot: [],
      contextRefs: [],
    };

    const created = await call(
      '/api/agent/coagent_create_work_item',
      { title: 'W-warn', ...violatingOrder },
      coordToken,
    );
    assert.ok(created.status >= 200 && created.status < 300);
    const workItemId = (created.json as { workItemId: string }).workItemId;
    assert.ok(workItemId);
    const createWarnings = (created.json as { warnings?: { rule: string; suggestion: string }[] })
      .warnings;
    assert.ok(Array.isArray(createWarnings) && createWarnings.length >= 1);
    // 标出违规项，且每条都有可照做的下一步建议。
    for (const w of createWarnings!) {
      assert.ok(['allowedScope', 'verification', 'contextRefs'].includes(w.rule));
      assert.ok(typeof w.suggestion === 'string' && w.suggestion.length > 0);
    }

    // 原事件 work_item.created 同步含 warnings。
    const events = (await call('/api/missions/M-warn/activity')).json as unknown as ActivityRow[];
    const createdEvt = events.find((row) => row.kind === 'work_item.created');
    assert.ok(createdEvt);
    assert.deepEqual(
      (createdEvt?.data as { warnings?: unknown[] }).warnings,
      createWarnings,
    );

    // 经协调者工具修订成另一份超标工单：成功、revision/changedFields、warnings 与事件同步。
    const revisedOrder = {
      ...violatingOrder,
      objective: '改更多文件',
      allowedScope: ['src/x.ts', 'src/y.ts', 'src/z/another'],
    };
    const revised = await call(
      '/api/agent/coagent_revise_work_order',
      { workItemId, ...revisedOrder },
      coordToken,
    );
    assert.equal(revised.status, 200);
    assert.equal((revised.json as { revision: string }).revision, 'r2');
    assert.ok(Array.isArray((revised.json as { changedFields: string[] }).changedFields));
    assert.ok((revised.json as { changedFields: string[] }).changedFields.length >= 1);
    const revWarnings = (revised.json as { warnings?: { rule: string }[] }).warnings;
    assert.ok(Array.isArray(revWarnings) && revWarnings.length >= 1);

    const events2 = (await call('/api/missions/M-warn/activity')).json as unknown as ActivityRow[];
    const revisedEvt = events2.find((row) => row.kind === 'work_item.order_revised');
    assert.ok(revisedEvt);
    assert.deepEqual((revisedEvt?.data as { warnings?: unknown[] }).warnings, revWarnings);
    assert.equal((revisedEvt?.data as { revision: string }).revision, 'r2');

    // --- 直接调用路径：独立内存 Platform，不传 viaCoordinatorTool -> 无 warnings 字段、不硬拒 ---
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const directPlatform = new Platform({
      projects: new InMemoryProjectRepository(),
      deliveries: new InMemoryDeliveryRepository(clock, ids),
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
    });
    await directPlatform.createMission({
      projectId: 'P-warn-direct',
      missionId: 'M-warn-direct',
      contract: CONTRACT,
    });
    const directAttempt = await directPlatform.startCoordinatorAttempt('M-warn-direct');
    await directPlatform.updatePlan('M-warn-direct', directAttempt.attemptId, {
      findings: 'f',
      rejectedHypotheses: [],
      decisions: [],
      direction: 'd',
      risks: [],
    });
    // 同样的超标工单，但直接调用（不带 viaCoordinatorTool）：应照常建出、不返回 warnings。
    const directRes = await directPlatform.createWorkItem('M-warn-direct', directAttempt.attemptId, {
      title: 'W-direct',
      order: violatingOrder,
    });
    assert.ok(directRes.workItemId);
    assert.equal(
      (directRes as Record<string, unknown>).warnings,
      undefined,
      '直接调用不应带软警告字段',
    );
  });

  test('W-319 T1: 60 项 Mission 精简视图 <=30KB 仅索引，网页 GET 仍给完整 60 工单', async () => {
    await call('/api/missions', { projectId: 'P-60', missionId: 'M-60', contract: CONTRACT });
    const coord = await call('/api/missions/M-60/coordinator-attempts', {});
    const coordToken = (coord.json as { token: string }).token;
    await call(
      '/api/agent/coagent_update_plan',
      { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] },
      coordToken,
    );
    const shortOrder = {
      objective: 'o',
      allowedScope: ['x.ts'],
      requiredBehaviour: 'b',
      constraints: [],
      acceptance: ['a'],
      verification: ['v'],
      doNot: [],
      contextRefs: [],
    };
    for (let i = 0; i < 60; i++) {
      const wi = await call(
        '/api/agent/coagent_create_work_item',
        { title: `W-${i}`, ...shortOrder },
        coordToken,
      );
      assert.equal(wi.status, 200, `第 ${i} 个工单应建成功`);
    }

    const agentView = await call('/api/agent/coagent_get_mission', {}, coordToken);
    assert.equal(agentView.status, 200);
    const av = agentView.json as unknown as Record<string, unknown>;
    const serialized = JSON.stringify(av);
    assert.ok(
      Buffer.byteLength(serialized, 'utf8') <= 30 * 1024,
      `精简视图应 <=30KB，实际 ${Buffer.byteLength(serialized, 'utf8')}`,
    );
    const index = av.workItemIndex as unknown[];
    assert.equal(index.length, 60, '精简视图应恰含 60 条索引');
    for (const entry of index) {
      const e = entry as Record<string, unknown>;
      assert.equal('order' in e, false, '索引不得含工单正文');
      assert.equal('executionResult' in e, false, '索引不得含执行结果');
      assert.equal('reviews' in e, false, '索引不得含评审');
    }
    assert.equal('order' in av, false);
    assert.equal('executionResult' in av, false);
    assert.equal('reviews' in av, false);

    const full = await call('/api/missions/M-60');
    assert.equal(full.status, 200);
    const fv = full.json as unknown as { workItems: unknown[] };
    assert.equal(fv.workItems.length, 60, '网页 GET 应仍返回完整 60 工单');
  });

  test('W-319 T2: 协调者取详情含最新正文/证据/评审与旧摘要，executor 403，空 id 400，超长标截断', async () => {
    await call('/api/missions', { projectId: 'P-det', missionId: 'M-det', contract: CONTRACT });
    const coord = await call('/api/missions/M-det/coordinator-attempts', {});
    const coordToken = (coord.json as { token: string }).token;
    await call(
      '/api/agent/coagent_update_plan',
      { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] },
      coordToken,
    );
    const detOrder = {
      objective: '细项',
      allowedScope: ['x.ts'],
      requiredBehaviour: 'b',
      constraints: [],
      acceptance: ['a'],
      verification: ['v'],
      doNot: [],
      contextRefs: [],
    };
    const wi = await call('/api/agent/coagent_create_work_item', { title: 'W-det', ...detOrder }, coordToken);
    assert.equal(wi.status, 200);
    const workItemId = (wi.json as { workItemId: string }).workItemId;
    // W-334 门禁：Standard 派发前必须先提交当前契约修订的核对结论。
    await call('/api/agent/coagent_submit_contract_check', { verdict: 'ok', summary: '测试契约已核对' }, coordToken);
    await call('/api/agent/coagent_dispatch_work_item', { workItemIds: [workItemId] }, coordToken);

    const exec1 = await call(`/api/missions/M-det/work-items/${workItemId}/executor-attempts`, {});
    const exec1Id = (exec1.json as { attemptId: string }).attemptId;
    const exec1Token = (exec1.json as { token: string }).token;
    const ev1 = await call('/api/agent/coagent_submit_evidence', { kind: 'test', summary: '证据一', command: 'node --test', exitCode: 0 }, exec1Token);
    assert.equal(ev1.status, 200);
    const sub1 = await call(
      '/api/agent/coagent_submit_execution_result',
      { outcome: 'completed', summary: '旧提交全文', changedFiles: ['x.ts'], evidenceIds: [(ev1.json as { evidenceId: string }).evidenceId], notes: 'n1' },
      exec1Token,
    );
    assert.equal(sub1.status, 200);
    await call(`/api/missions/M-det/attempts/${exec1Id}/finish`, { endedBy: 'structured_submit' });

    const reviewed = await call(
      '/api/agent/coagent_review_execution_result',
      {
        workItemId,
        verdict: 'accept',
        acceptanceResults: detOrder.acceptance.map((c) => ({ criterion: c, status: 'pass' as const, evidence: '逐条核过' })),
        reasons: ['跑过'],
        requiredChanges: [],
      },
      coordToken,
    );
    assert.equal(reviewed.status, 200);

    // 重派（accepted 可派发）后第二次提交，制造「旧正文未保存」摘要。
    await call('/api/agent/coagent_dispatch_work_item', { workItemIds: [workItemId] }, coordToken);
    const exec2 = await call(`/api/missions/M-det/work-items/${workItemId}/executor-attempts`, {});
    const exec2Token = (exec2.json as { token: string }).token;
    const ev2 = await call('/api/agent/coagent_submit_evidence', { kind: 'test', summary: '证据二', command: 'node --test', exitCode: 0 }, exec2Token);
    assert.equal(ev2.status, 200);
    const sub2 = await call(
      '/api/agent/coagent_submit_execution_result',
      { outcome: 'completed', summary: '最新提交全文', changedFiles: ['x.ts'], evidenceIds: [(ev2.json as { evidenceId: string }).evidenceId], notes: 'n2' },
      exec2Token,
    );
    assert.equal(sub2.status, 200);

    const detail = await call('/api/agent/coagent_get_work_item', { workItemId }, coordToken);
    assert.equal(detail.status, 200);
    const d = detail.json as unknown as Record<string, unknown>;
    const result = d.executionResult as { summary?: string } | undefined;
    assert.equal(result?.summary, '最新提交全文', '应给最新提交全文');
    const evSum = d.evidenceSummary as { summary?: string }[];
    assert.ok(evSum.some((e) => e.summary === '证据一'));
    assert.ok(evSum.some((e) => e.summary === '证据二'));
    const reviews = d.reviews as { verdict?: string }[];
    assert.ok(reviews.length >= 1);
    assert.equal(reviews[reviews.length - 1]?.verdict, 'accept');
    const subs = d.submissionSummaries as { isLatest?: boolean; note?: string }[];
    assert.equal(subs.length, 2);
    const oldOne = subs.find((s) => s.isLatest !== true);
    assert.equal(oldOne?.note, '旧正文未保存');
    const latest = subs.find((s) => s.isLatest === true);
    assert.equal(latest?.note, undefined);

    const execFetch = await call('/api/agent/coagent_get_work_item', { workItemId }, exec2Token);
    assert.equal(execFetch.status, 403);

    const empty = await call('/api/agent/coagent_get_work_item', {}, coordToken);
    assert.equal(empty.status, 400);

    // 合法超长数据触发截断。
    await call('/api/missions', { projectId: 'P-big', missionId: 'M-big', contract: CONTRACT });
    const coordB = await call('/api/missions/M-big/coordinator-attempts', {});
    const coordBToken = (coordB.json as { token: string }).token;
    await call('/api/agent/coagent_update_plan', { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] }, coordBToken);
    const bigWi = await call('/api/agent/coagent_create_work_item', { title: 'W-big', ...detOrder }, coordBToken);
    const bigId = (bigWi.json as { workItemId: string }).workItemId;
    // W-334 门禁：Standard 派发前必须先提交当前契约修订的核对结论。
    await call('/api/agent/coagent_submit_contract_check', { verdict: 'ok', summary: '测试契约已核对' }, coordBToken);
    await call('/api/agent/coagent_dispatch_work_item', { workItemIds: [bigId] }, coordBToken);
    const execB = await call(`/api/missions/M-big/work-items/${bigId}/executor-attempts`, {});
    const execBToken = (execB.json as { token: string }).token;
    await call('/api/agent/coagent_submit_evidence', { kind: 'test', summary: 'e', command: 'c', exitCode: 0 }, execBToken);
    const huge = 'x'.repeat(100 * 1024);
    const subB = await call(
      '/api/agent/coagent_submit_execution_result',
      { outcome: 'completed', summary: huge, changedFiles: ['x.ts'], evidenceIds: [], notes: 'n' },
      execBToken,
    );
    assert.equal(subB.status, 200);
    const bigDetail = await call('/api/agent/coagent_get_work_item', { workItemId: bigId }, coordBToken);
    assert.equal(bigDetail.status, 200);
    const bd = bigDetail.json as unknown as Record<string, unknown>;
    assert.equal(bd.truncated, true, '超长详情应标截断');
    const bigBytes = Buffer.byteLength(JSON.stringify(bd), 'utf8');
    assert.ok(bigBytes <= 20 * 1024, `截断后 JSON 应 <=20KB，实际 ${bigBytes}`);
  });
});

const QUEUE_NOW = '2025-01-01T00:00:00Z';
const QUEUE_LEASE = '2025-01-01T00:00:10Z';
const QUEUE_LATER = '2025-01-01T00:00:20Z';
const QUEUE_ORIGIN = { clientType: 'cli' as const, conversationRef: 'me' };

const AGENT_QUEUE_WRITES: readonly { tool: string; body: Record<string, unknown> }[] = [
  { tool: 'coagent_update_findings', body: { findings: 'stale' } },
  {
    tool: 'coagent_update_plan',
    body: { findings: 'stale', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] },
  },
  { tool: 'coagent_create_work_item', body: { title: 'W', ...ORDER } },
  { tool: 'coagent_dispatch_work_item', body: { workItemIds: ['nope'] } },
  {
    tool: 'coagent_review_execution_result',
    body: { workItemId: 'nope', verdict: 'accept', reasons: ['x'], requiredChanges: [], acceptanceResults: [] },
  },
  { tool: 'coagent_escalate_to_l3', body: { question: 'q', why: 'w', optionsConsidered: ['a'] } },
  {
    tool: 'coagent_submit_mission_result',
    body: { outcome: 'blocked', summary: 's', acceptanceEvidence: [], memoryDelta: [], openRisks: [] },
  },
  { tool: 'coagent_submit_evidence', body: { kind: 'test', summary: 's', command: 'x', exitCode: 0 } },
  {
    tool: 'coagent_submit_execution_result',
    body: { outcome: 'partial', summary: 's', changedFiles: [], evidenceIds: [], notes: '' },
  },
  {
    tool: 'coagent_report_blocked',
    body: { reason: '工单前提不成立', whatWasTried: [], needsFromUpstream: 'x' },
  },
  { tool: 'coagent_submit_independent_review', body: { verdict: 'send_back', reasons: ['r'] } },
];

async function postJson(
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: { error?: string } }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-coagent-run': token } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: (await res.json()) as { error?: string } };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function snapshotMission(
  projects: FileProjectRepository | PgProjectRepository,
  activity: FileActivityLog | PgActivityLog,
  deliveries: FileDeliveryRepository | PgDeliveryRepository,
) {
  return {
    project: JSON.stringify((await projects.get('P'))?.toSnapshot()),
    events: (await activity.list('M')).length,
    deliveries: (await deliveries.listForMission('M')).length,
  };
}

async function enqueueAndClaim(
  hops: FileQueuedHopRepository | PgQueuedHopRepository,
  id = 'h1',
): Promise<QueueClaimIdentity> {
  await hops.enqueue({
    id,
    projectId: 'P',
    missionId: 'M',
    workItemId: 'w',
    role: 'coordinator',
    priority: 1,
    availableAt: QUEUE_NOW,
    attemptCount: 0,
    maxAttempts: 2,
    idempotencyKey: `http-fence-${id}`,
    status: 'queued',
    createdAt: QUEUE_NOW,
    updatedAt: QUEUE_NOW,
  });
  const claimed = await hops.claim(id, 'owner', QUEUE_NOW, QUEUE_LEASE);
  assert.equal(claimed?.claimGeneration, 1);
  return { id, owner: 'owner', claimGeneration: 1 };
}

const QUEUE_PLAN = {
  findings: '查到了',
  rejectedHypotheses: [] as string[],
  decisions: [] as string[],
  direction: '这么改',
  risks: [] as string[],
};

describe('HTTP 队列 Attempt 身份', () => {
  test('三类 start 与 attempt.started 同事务写入按 attemptId 可查的队列标记；非队列不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'http-queue-mark-'));
    try {
      const store = new FileStateStore(join(dir, 'state.json'));
      const clock = new FixedClock(QUEUE_NOW);
      const ids = new PersistentIds(store);
      const projects = new FileProjectRepository(store);
      const activity = new FileActivityLog(store, clock);
      const deliveries = new FileDeliveryRepository(store, clock, ids);
      const hops = new FileQueuedHopRepository(store);
      const platform = new Platform({
        projects,
        deliveries,
        activity,
        clock,
        ids,
        transaction: store,
      });
      await platform.createMission({
        projectId: 'P',
        missionId: 'M',
        contract: CONTRACT,
        origin: QUEUE_ORIGIN,
      });
      const live = await enqueueAndClaim(hops);
      const unmarked = await platform.startCoordinatorAttempt('M');
      assert.equal(await platform.attemptRequiresQueueClaim('M', unmarked.attemptId), false);
      await platform.finishAttempt('M', unmarked.attemptId, { endedBy: 'structured_submit' });

      const queued = await platform.startCoordinatorAttempt('M', undefined, live);
      assert.equal(await platform.attemptRequiresQueueClaim('M', queued.attemptId), true);
      const started = (await activity.list('M')).filter(
        (event) => event.kind === 'attempt.started' && event.attemptId === queued.attemptId,
      );
      assert.equal(started.length, 1);
      assert.equal((started[0]!.data as { queue?: unknown }).queue, true);

      await assert.rejects(
        () => platform.updateFindings('M', queued.attemptId, 'no-claim'),
        (error: unknown) => error instanceof PlatformRuleError && error.code === 'QUEUE_CLAIM_REQUIRED',
      );
      await platform.updateFindings('M', queued.attemptId, 'queued-ok', undefined, live);
      await platform.updatePlan('M', queued.attemptId, QUEUE_PLAN, live);
      const { workItemId } = await platform.createWorkItem(
        'M',
        queued.attemptId,
        { title: 'W', order: ORDER, workItemId: 'W1' },
        live,
      );
      // W-334 门禁：Standard 派发前必须先提交当前契约修订的核对结论。
      await platform.submitContractCheck('M', queued.attemptId, { verdict: 'ok', summary: '测试契约已核对' }, live);
      await platform.dispatchWorkItems('M', queued.attemptId, [workItemId], live);
      const exec = await platform.startExecutorAttempt('M', workItemId, undefined, live);
      assert.equal(await platform.attemptRequiresQueueClaim('M', exec.attemptId), true);

      await assert.rejects(
        () => platform.startIndependentReviewerAttempt('M', [], live),
        (error: unknown) => error instanceof PlatformRuleError && error.code !== 'CLAIM_FENCE_UNAVAILABLE',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('真实 HTTP：旧代次 11 个写 handler 非 2xx 且快照不变，请求体伪造身份无效，当前代次仍可写', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'http-queue-writes-'));
    const store = new FileStateStore(join(dir, 'state.json'));
    const clock = new FixedClock(QUEUE_NOW);
    const ids = new PersistentIds(store);
    const projects = new FileProjectRepository(store);
    const activity = new FileActivityLog(store, clock);
    const deliveries = new FileDeliveryRepository(store, clock, ids);
    const hops = new FileQueuedHopRepository(store);
    const platform = new Platform({
      projects,
      deliveries,
      activity,
      clock,
      ids,
      transaction: store,
    });
    const tokens = new RunTokenRegistry();
    const server = createApi({ platform, tokens, deliveries });
    try {
      await listenLoopback(server, 0);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await platform.createMission({
        projectId: 'P',
        missionId: 'M',
        contract: CONTRACT,
        origin: QUEUE_ORIGIN,
      });
      const live = await enqueueAndClaim(hops);
      const { attemptId } = await platform.startCoordinatorAttempt('M', undefined, live);
      const stale = tokens.issue({ missionId: 'M', attemptId, role: 'coordinator', claim: live });
      await platform.updateFindings('M', attemptId, 'live', undefined, live);

      const taken = await hops.claim(live.id, 'next', QUEUE_LEASE, QUEUE_LATER);
      assert.equal(taken?.claimGeneration, 2);
      const current: QueueClaimIdentity = { id: live.id, owner: 'next', claimGeneration: 2 };
      const fresh = tokens.issue({ missionId: 'M', attemptId, role: 'coordinator', claim: current });
      const before = await snapshotMission(projects, activity, deliveries);
      assert.equal(AGENT_QUEUE_WRITES.length, 11);

      for (const row of AGENT_QUEUE_WRITES) {
        const spoofed = {
          ...row.body,
          role: 'coordinator',
          owner: 'next',
          claimGeneration: 2,
          id: live.id,
        };
        const res = await postJson(base, `/api/agent/${row.tool}`, spoofed, stale.token);
        assert.notEqual(res.status, 200, `${row.tool} stale token must not succeed`);
        assert.ok(res.status >= 400, `${row.tool} must be non-2xx`);
        assert.equal(res.json.error, 'CLAIM_FENCE_REJECTED', row.tool);
        assert.equal(JSON.stringify(res.json).includes(stale.token), false);
        assert.deepEqual(await snapshotMission(projects, activity, deliveries), before);
      }

      const ok = await postJson(
        base,
        '/api/agent/coagent_update_findings',
        { findings: 'current-gen' },
        fresh.token,
      );
      assert.equal(ok.status, 200);
      assert.equal((await projects.get('P'))!.missions[0]!.plan?.findings, 'live\n\n—— 第 2 次补充\ncurrent-gen');
      assert.equal(tokens.resolve(fresh.token)?.attemptId, attemptId);
    } finally {
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('真实 HTTP：入口解析后写事务前接管，事务内核对拒绝旧代次', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'http-queue-race-'));
    const store = new FileStateStore(join(dir, 'state.json'));
    const clock = new FixedClock(QUEUE_NOW);
    const ids = new PersistentIds(store);
    const projects = new FileProjectRepository(store);
    const activity = new FileActivityLog(store, clock);
    const deliveries = new FileDeliveryRepository(store, clock, ids);
    const hops = new FileQueuedHopRepository(store);
    const platform = new Platform({
      projects,
      deliveries,
      activity,
      clock,
      ids,
      transaction: store,
    });
    const tokens = new RunTokenRegistry();
    const server = createApi({ platform, tokens, deliveries });
    try {
      await listenLoopback(server, 0);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await platform.createMission({
        projectId: 'P',
        missionId: 'M',
        contract: CONTRACT,
        origin: QUEUE_ORIGIN,
      });
      const live = await enqueueAndClaim(hops);
      const { attemptId } = await platform.startCoordinatorAttempt('M', undefined, live);
      const run = tokens.issue({ missionId: 'M', attemptId, role: 'coordinator', claim: live });
      await platform.updateFindings('M', attemptId, 'before-race', undefined, live);

      const orig = store.runFenced.bind(store);
      let hijacked = false;
      store.runFenced = ((fence: ClaimFence, fn: () => Promise<unknown>) => {
        hijacked = true;
        return hops.claim(live.id, 'next', QUEUE_LEASE, QUEUE_LATER).then((taken) => {
          assert.equal(taken?.claimGeneration, 2);
          return orig(fence, fn);
        });
      }) as typeof store.runFenced;

      const before = await snapshotMission(projects, activity, deliveries);
      const res = await postJson(
        base,
        '/api/agent/coagent_update_findings',
        { findings: 'should-not-land' },
        run.token,
      );
      assert.equal(hijacked, true);
      assert.notEqual(res.status, 200);
      assert.equal(res.json.error, 'CLAIM_FENCE_REJECTED');
      assert.deepEqual(await snapshotMission(projects, activity, deliveries), before);
      assert.equal((await projects.get('P'))!.missions[0]!.plan?.findings, 'before-race');
      assert.equal((await hops.get(live.id))?.claimGeneration, 2);
      assert.equal(tokens.resolve(run.token)?.token, run.token);
    } finally {
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('队列 HTTP finish：旧代次、失租、重启缺牌拒绝且不收尾不吊销；当前代次可收尾；非队列旧路径不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'http-queue-finish-'));
    const store = new FileStateStore(join(dir, 'state.json'));
    const clock = new FixedClock(QUEUE_NOW);
    const ids = new PersistentIds(store);
    const projects = new FileProjectRepository(store);
    const activity = new FileActivityLog(store, clock);
    const deliveries = new FileDeliveryRepository(store, clock, ids);
    const hops = new FileQueuedHopRepository(store);
    const platform = new Platform({
      projects,
      deliveries,
      activity,
      clock,
      ids,
      transaction: store,
    });
    const tokens = new RunTokenRegistry();
    let server = createApi({ platform, tokens, deliveries });
    try {
      await listenLoopback(server, 0);
      let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await platform.createMission({
        projectId: 'P',
        missionId: 'M',
        contract: CONTRACT,
        origin: QUEUE_ORIGIN,
      });
      const live = await enqueueAndClaim(hops);
      const { attemptId } = await platform.startCoordinatorAttempt('M', undefined, live);
      const stale = tokens.issue({ missionId: 'M', attemptId, role: 'coordinator', claim: live });

      const taken = await hops.claim(live.id, 'next', QUEUE_LEASE, QUEUE_LATER);
      assert.equal(taken?.claimGeneration, 2);
      const gen2: QueueClaimIdentity = { id: live.id, owner: 'next', claimGeneration: 2 };
      const current = tokens.issue({ missionId: 'M', attemptId, role: 'coordinator', claim: gen2 });

      const staleFinish = await postJson(
        base,
        `/api/missions/M/attempts/${attemptId}/finish`,
        { endedBy: 'structured_submit', owner: 'next', claimGeneration: 2 },
        stale.token,
      );
      assert.notEqual(staleFinish.status, 200);
      assert.equal(staleFinish.json.error, 'CLAIM_FENCE_REJECTED');
      assert.equal((await projects.get('P'))!.missions[0]!.coordinatorAttempts[0]!.status, 'in_progress');
      assert.equal(tokens.resolve(current.token)?.attemptId, attemptId);

      clock.advance(Date.parse(QUEUE_LATER) - Date.parse(QUEUE_NOW));
      const expiredFinish = await postJson(
        base,
        `/api/missions/M/attempts/${attemptId}/finish`,
        { endedBy: 'structured_submit' },
        current.token,
      );
      assert.notEqual(expiredFinish.status, 200);
      assert.equal(expiredFinish.json.error, 'CLAIM_FENCE_REJECTED');
      assert.equal((await projects.get('P'))!.missions[0]!.coordinatorAttempts[0]!.status, 'in_progress');
      assert.equal(tokens.resolve(current.token)?.attemptId, attemptId);

      await closeServer(server);
      const restarted = new RunTokenRegistry();
      server = createApi({ platform, tokens: restarted, deliveries });
      await listenLoopback(server, 0);
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const missing = await postJson(base, `/api/missions/M/attempts/${attemptId}/finish`, {
        endedBy: 'structured_submit',
      });
      assert.equal(missing.status, 401);
      assert.equal(missing.json.error, 'UNKNOWN_RUN_TOKEN');
      assert.equal((await projects.get('P'))!.missions[0]!.coordinatorAttempts[0]!.status, 'in_progress');

      const reclaimed = await hops.claim(live.id, 'third', QUEUE_LATER, '2025-01-01T00:00:30Z');
      assert.equal(reclaimed?.claimGeneration, 3);
      const gen3: QueueClaimIdentity = { id: live.id, owner: 'third', claimGeneration: 3 };
      const liveToken = restarted.issue({ missionId: 'M', attemptId, role: 'coordinator', claim: gen3 });
      const ok = await postJson(
        base,
        `/api/missions/M/attempts/${attemptId}/finish`,
        { endedBy: 'structured_submit' },
        liveToken.token,
      );
      assert.equal(ok.status, 200);
      assert.notEqual((await projects.get('P'))!.missions[0]!.coordinatorAttempts[0]!.status, 'in_progress');
      assert.equal(restarted.resolve(liveToken.token), undefined);

      await platform.createMission({
        projectId: 'P',
        missionId: 'M-nq',
        contract: CONTRACT,
        origin: QUEUE_ORIGIN,
      });
      const nq = await postJson(base, '/api/missions/M-nq/coordinator-attempts', {});
      assert.equal(nq.status, 201);
      const nqAttempt = (nq.json as { attemptId?: string }).attemptId;
      assert.ok(nqAttempt);
      const nqFinish = await postJson(base, `/api/missions/M-nq/attempts/${nqAttempt}/finish`, {
        endedBy: 'structured_submit',
      });
      assert.equal(nqFinish.status, 200);
    } finally {
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Postgres 可用时真实 HTTP 解析后接管竞态在事务内拒绝', async (t) => {
    const connectionString = await ensureTestDatabase('http_queue_fence');
    if (!connectionString) {
      t.skip('Postgres unavailable; PG HTTP claim-fence race not verified');
      return;
    }
    const store = await PgStateStore.open({ connectionString });
    await store.pool.query('TRUNCATE queued_hops, projects, activity, deliveries, id_counters');
    await store.refresh();
    const clock = new FixedClock(QUEUE_NOW);
    const ids = new PgIds(store);
    await ids.reserve(['D', 'W', 'M', 'E']);
    const projects = new PgProjectRepository(store);
    const activity = new PgActivityLog(store, clock);
    const deliveries = new PgDeliveryRepository(store, clock, ids);
    const hops = new PgQueuedHopRepository(store);
    const platform = new Platform({
      projects,
      deliveries,
      activity,
      clock,
      ids,
      transaction: store,
    });
    const tokens = new RunTokenRegistry();
    const server = createApi({ platform, tokens, deliveries });
    try {
      await listenLoopback(server, 0);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await hops.enqueue({
        id: 'h1',
        projectId: 'P',
        missionId: 'M',
        workItemId: 'w',
        role: 'coordinator',
        priority: 1,
        availableAt: QUEUE_NOW,
        attemptCount: 0,
        maxAttempts: 2,
        idempotencyKey: 'http-pg-fence',
        status: 'queued',
        createdAt: QUEUE_NOW,
        updatedAt: QUEUE_NOW,
      });
      assert.equal((await hops.claim('h1', 'owner', QUEUE_NOW, QUEUE_LEASE))?.claimGeneration, 1);
      const live: QueueClaimIdentity = { id: 'h1', owner: 'owner', claimGeneration: 1 };
      await platform.createMission({
        projectId: 'P',
        missionId: 'M',
        contract: CONTRACT,
        origin: QUEUE_ORIGIN,
      });
      const { attemptId } = await platform.startCoordinatorAttempt('M', undefined, live);
      const run = tokens.issue({ missionId: 'M', attemptId, role: 'coordinator', claim: live });
      await platform.updateFindings('M', attemptId, 'pg-before', undefined, live);

      const orig = store.runFenced.bind(store);
      let hijacked = false;
      store.runFenced = ((fence: ClaimFence, fn: () => Promise<unknown>) => {
        hijacked = true;
        return hops.claim('h1', 'next', QUEUE_LEASE, QUEUE_LATER).then((taken) => {
          assert.equal(taken?.claimGeneration, 2);
          return orig(fence, fn);
        });
      }) as typeof store.runFenced;

      const before = await snapshotMission(projects, activity, deliveries);
      const res = await postJson(
        base,
        '/api/agent/coagent_update_findings',
        { findings: 'pg-stale', owner: 'next', claimGeneration: 2 },
        run.token,
      );
      assert.equal(hijacked, true);
      assert.notEqual(res.status, 200);
      assert.equal(res.json.error, 'CLAIM_FENCE_REJECTED');
      assert.deepEqual(await snapshotMission(projects, activity, deliveries), before);
      assert.equal((await projects.get('P'))!.missions[0]!.plan?.findings, 'pg-before');
    } finally {
      await closeServer(server);
      await store.close();
    }
  });
});

const BRIEF_SHA256 = /^[0-9a-f]{64}$/;
const BRIEF_RULES = '# 架构约束\n\nkernel 不得依赖任何第三方包。\n';
const BRIEF_SPEC_BODY = '# HTTP brief spec\n\nSPEC-BODY-MUST-NOT-PREFETCH\n';
const BRIEF_CONTRACT_R2 = {
  ...CONTRACT,
  intent: '把 X 修好（r2）',
};
const BRIEF_PLAN = {
  findings: '第三次规划',
  rejectedHypotheses: [] as string[],
  decisions: [] as string[],
  direction: '按 r3 改',
  risks: [] as string[],
};
const BRIEF_REFS = [
  'src/does-not-exist-w1.ts',
  { kind: 'living_spec' as const, ref: 'http-brief', why: '规格在这儿' },
  { kind: 'contract' as const, ref: 'contract', why: '验收标准在这儿' },
  { kind: 'previous_result' as const, ref: 'W-prev', why: '上一工单结果' },
];
const BRIEF_ORDER = {
  ...ORDER,
  contextRefs: BRIEF_REFS,
};
const EXPECTED_ENV_NOTES =
  process.platform === 'win32'
    ? [
        'Windows：bash 的 `/tmp` 和 Node 的 `/tmp` **不是同一个目录**（前者在 ' +
          '%LOCALAPPDATA%\\Temp，后者是 C:\\tmp）。要落临时文件就用工作区里的相对路径，' +
          '跨这两者传文件必须用绝对路径——弄错不会报错，只会读到一个旧文件或空文件。',
        'Windows：Git Bash 里没有 `pgrep`。`if ! pgrep -f x` 这类判据**恒为真**，' +
          '不会报"命令不存在"，只会让你以为进程已经没了。判进程死活用 tasklist，' +
          '或者干脆改判产物（文件 mtime、库里的记录）。',
      ]
    : [];

async function getJson(
  base: string,
  path: string,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: 'GET',
    headers: token ? { 'x-coagent-run': token } : {},
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('HTTP 简报与按需引用权限',
  () => {
    test('同一 Mission：角色 Bundle、旧简报字段、get_work_order/get_context 形状与权限',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'http-brief-bundle-'));
        mkdirSync(join(dir, '.coagent', 'specs'), { recursive: true });
        writeFileSync(join(dir, '.coagent', 'project.md'), BRIEF_RULES, 'utf8');
        writeFileSync(join(dir, '.coagent', 'specs', 'http-brief.md'), BRIEF_SPEC_BODY, 'utf8');

        const clock = new FixedClock();
        const ids = new SequentialIds();
        const deliveries = new InMemoryDeliveryRepository(clock, ids);
        const platform = new Platform({
          projects: new InMemoryProjectRepository(),
          deliveries,
          activity: new InMemoryActivityLog(clock),
          clock,
          ids,
        });
        const tokens = new RunTokenRegistry();
        const server = createApi({ platform, tokens, deliveries });
        try {
          await listenLoopback(server, 0);
          const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

          const created = await postJson(base, '/api/missions', {
            projectId: 'P-brief',
            missionId: 'M-brief',
            contract: CONTRACT,
          });
          assert.equal(created.status, 201);
          await platform.recordWorkspace('M-brief', {
            projectRoot: dir,
            branch: 'b',
            baseRevision: 'x',
          });

          const coord = await postJson(base, '/api/missions/M-brief/coordinator-attempts', {});
          assert.equal(coord.status, 201);
          const coordToken = (coord.json as { token?: string }).token;
          assert.equal(typeof coordToken, 'string');

          for (const findings of ['r1', 'r2', '第三次规划']) {
            const planned = await postJson(
              base,
              '/api/agent/coagent_update_plan',
              { ...BRIEF_PLAN, findings },
              coordToken,
            );
            assert.equal(planned.status, 200);
          }

          const wi = await postJson(
            base,
            '/api/agent/coagent_create_work_item',
            { title: 'W1', ...BRIEF_ORDER },
            coordToken,
          );
          assert.equal(wi.status, 200);
          const workItemId = (wi.json as { workItemId?: string }).workItemId;
          assert.equal(typeof workItemId, 'string');

          // W-334 门禁：Standard 派发前必须先提交当前契约修订的核对结论。
          await postJson(
            base,
            '/api/agent/coagent_submit_contract_check',
            { verdict: 'ok', summary: '测试契约已核对' },
            coordToken,
          );

          const dispatched = await postJson(
            base,
            '/api/agent/coagent_dispatch_work_item',
            { workItemIds: [workItemId] },
            coordToken,
          );
          assert.equal(dispatched.status, 200);

          const exec = await postJson(
            base,
            `/api/missions/M-brief/work-items/${workItemId}/executor-attempts`,
            {},
          );
          assert.equal(exec.status, 201);
          const execToken = (exec.json as { token?: string }).token;
          assert.equal(typeof execToken, 'string');

          const revised = await platform.reviseContract('M-brief', BRIEF_CONTRACT_R2);
          assert.equal(revised.contractRevision, 2);

          const coordBriefRes = await getJson(base, '/api/run/brief', coordToken);
          const execBriefRes = await getJson(base, '/api/run/brief', execToken);
          assert.equal(coordBriefRes.status, 200);
          assert.equal(execBriefRes.status, 200);

          type BundleEntry = {
            source: string;
            revision?: number;
            hash?: string;
            reason?: string;
            estimatedTokens?: number;
            content?: unknown;
          };
          type Brief = {
            role?: string;
            projectRules?: string;
            environmentNotes?: unknown;
            contract?: { intent?: string };
            contractRevision?: number;
            plan?: { direction?: string; findings?: string };
            planRevision?: number;
            workItem?: { id?: string; title?: string; order?: { contextRefs?: unknown }; l3SendBackReasons?: string[] };
            finalReview?: { verdict?: string; reasons?: string[] };
            contextBundle?: { role?: string; entries?: BundleEntry[] };
          };
          const coordBrief = coordBriefRes.json as Brief;
          const execBrief = execBriefRes.json as Brief;

          assert.equal(coordBrief.role, 'coordinator');
          assert.equal(coordBrief.contract?.intent, BRIEF_CONTRACT_R2.intent);
          assert.equal(coordBrief.contractRevision, 2);
          assert.equal(coordBrief.plan?.direction, BRIEF_PLAN.direction);
          assert.equal(coordBrief.plan?.findings, '第三次规划');
          assert.equal(coordBrief.planRevision, 3);
          assert.equal(coordBrief.workItem, undefined);
          assert.equal(coordBrief.finalReview?.verdict, 'send_back');
          assert.match(coordBrief.finalReview?.reasons?.[0] ?? '', /Contract 已更新到 r2/);
          assert.equal(coordBrief.projectRules, BRIEF_RULES);
          assert.deepEqual(coordBrief.environmentNotes, EXPECTED_ENV_NOTES);
          assert.equal(coordBrief.contextBundle?.role, 'coordinator');
          assert.deepEqual(
            coordBrief.contextBundle?.entries?.map((e) => e.source),
            ['project_rules', 'environment_notes', 'contract', 'plan', 'final_review', 'work_items_index', 'since_last_hop'],
          );
          const coordContract = coordBrief.contextBundle?.entries?.find((e) => e.source === 'contract');
          const coordPlan = coordBrief.contextBundle?.entries?.find((e) => e.source === 'plan');
          assert.equal(coordContract?.revision, 2);
          assert.equal(coordContract?.hash, undefined);
          assert.equal(coordPlan?.revision, 3);
          assert.equal(coordPlan?.hash, undefined);
          const coordRules = coordBrief.contextBundle?.entries?.find((e) => e.source === 'project_rules');
          assert.equal(coordRules?.revision, undefined);
          assert.match(coordRules?.hash ?? '', BRIEF_SHA256);

          assert.equal(execBrief.role, 'executor');
          assert.equal(execBrief.workItem?.id, workItemId);
          assert.equal(execBrief.workItem?.title, 'W1');
          assert.deepEqual(execBrief.workItem?.order?.contextRefs, BRIEF_REFS);
          assert.deepEqual(execBrief.workItem?.l3SendBackReasons, [
            'Contract 已更新到 r2，需要按新契约重新核对',
          ]);
          assert.equal(execBrief.contract, undefined);
          assert.equal(execBrief.plan, undefined);
          assert.equal(execBrief.finalReview, undefined);
          assert.equal(execBrief.contractRevision, undefined);
          assert.equal(execBrief.planRevision, undefined);
          assert.equal(execBrief.projectRules, BRIEF_RULES);
          assert.deepEqual(execBrief.environmentNotes, EXPECTED_ENV_NOTES);
          assert.equal(execBrief.contextBundle?.role, 'executor');
          assert.deepEqual(
            execBrief.contextBundle?.entries?.map((e) => e.source),
            ['project_rules', 'environment_notes', 'work_order'],
          );
          const execDumped = JSON.stringify(execBrief);
          assert.equal(execDumped.includes('SPEC-BODY-MUST-NOT-PREFETCH'), false);
          assert.equal(execDumped.includes(BRIEF_CONTRACT_R2.intent), false);
          assert.equal(execDumped.includes('executionResult'), false);
          assert.equal(JSON.stringify(execBrief.workItem).includes('"body"'), false);

          const order = await postJson(base, '/api/agent/coagent_get_work_order', {}, execToken);
          assert.equal(order.status, 200);
          const orderJson = order.json as {
            workItemId?: string;
            title?: string;
            status?: string;
            order?: { contextRefs?: unknown; objective?: string };
            missionIntent?: string;
            guardrails?: unknown;
            l3SendBackReasons?: unknown;
          };
          assert.deepEqual(Object.keys(order.json).sort(), [
            'guardrails',
            'l3SendBackReasons',
            'missionIntent',
            'order',
            'status',
            'title',
            'workItemId',
          ]);
          assert.equal(orderJson.workItemId, workItemId);
          assert.equal(orderJson.title, 'W1');
          assert.equal(orderJson.order?.objective, BRIEF_ORDER.objective);
          assert.deepEqual(orderJson.order?.contextRefs, BRIEF_REFS);
          assert.equal(orderJson.missionIntent, BRIEF_CONTRACT_R2.intent);
          assert.deepEqual(orderJson.guardrails, BRIEF_CONTRACT_R2.guardrails);
          // 此 fixture 是 contract r2 触发的 send_back，从未 reject：只带 L3 理由，
          // 不带空的 previousRequiredChanges（空数组会被读成「上次要求是空」）。
          assert.deepEqual(orderJson.l3SendBackReasons, [
            'Contract 已更新到 r2，需要按新契约重新核对',
          ]);
          assert.equal(JSON.stringify(orderJson.order).includes('SPEC-BODY-MUST-NOT-PREFETCH'), false);

          const coordOrder = await postJson(base, '/api/agent/coagent_get_work_order', {}, coordToken);
          assert.equal(coordOrder.status, 409);
          assert.equal(coordOrder.json.error, 'ATTEMPT_NOT_BOUND');

          const undeclared = await postJson(
            base,
            '/api/agent/coagent_get_context',
            { ref: 'src/not-in-order.ts' },
            execToken,
          );
          assert.equal(undeclared.status, 200);
          assert.equal((undeclared.json as { found?: boolean }).found, false);
          assert.equal((undeclared.json as { body?: string }).body, undefined);
          assert.match(String((undeclared.json as { note?: string }).note ?? ''), /没有声明/);

          const fileRef = await postJson(
            base,
            '/api/agent/coagent_get_context',
            { ref: 'src/does-not-exist-w1.ts' },
            execToken,
          );
          assert.equal(fileRef.status, 200);
          assert.equal((fileRef.json as { found?: boolean }).found, true);
          assert.equal((fileRef.json as { kind?: string }).kind, 'file');
          assert.equal((fileRef.json as { body?: string }).body, undefined);
          assert.match(String((fileRef.json as { note?: string }).note ?? ''), /file/);

          const specRef = await postJson(
            base,
            '/api/agent/coagent_get_context',
            { ref: 'http-brief' },
            execToken,
          );
          assert.equal(specRef.status, 200);
          assert.equal((specRef.json as { found?: boolean }).found, true);
          assert.equal((specRef.json as { kind?: string }).kind, 'living_spec');
          assert.match(String((specRef.json as { body?: string }).body ?? ''), /SPEC-BODY-MUST-NOT-PREFETCH/);

          const contractRef = await postJson(
            base,
            '/api/agent/coagent_get_context',
            { ref: 'contract' },
            execToken,
          );
          assert.equal(contractRef.status, 200);
          assert.equal((contractRef.json as { found?: boolean }).found, true);
          assert.equal((contractRef.json as { kind?: string }).kind, 'contract');
          assert.match(String((contractRef.json as { body?: string }).body ?? ''), /把 X 修好（r2）/);

          const prevRef = await postJson(
            base,
            '/api/agent/coagent_get_context',
            { ref: 'W-prev' },
            execToken,
          );
          assert.equal(prevRef.status, 200);
          assert.equal((prevRef.json as { found?: boolean }).found, false);
          assert.equal((prevRef.json as { body?: string }).body, undefined);
          assert.match(String((prevRef.json as { note?: string }).note ?? ''), /还没有执行结果/);

          const coordCtx = await postJson(
            base,
            '/api/agent/coagent_get_context',
            { ref: 'contract' },
            coordToken,
          );
          assert.equal(coordCtx.status, 409);
          assert.equal(coordCtx.json.error, 'WRONG_ROLE');

          const coordMission = await postJson(base, '/api/agent/coagent_get_mission', {}, coordToken);
          const execMission = await postJson(base, '/api/agent/coagent_get_mission', {}, execToken);
          assert.equal(coordMission.status, 200);
          assert.equal(execMission.status, 200);
          assert.equal((coordMission.json as { contractRevision?: number }).contractRevision, 2);
          assert.equal((coordMission.json as { planRevision?: number }).planRevision, 3);
          assert.equal((execMission.json as { contractRevision?: number }).contractRevision, 2);

          const coordContractTool = await postJson(
            base,
            '/api/agent/coagent_get_contract',
            {},
            coordToken,
          );
          const execContractTool = await postJson(
            base,
            '/api/agent/coagent_get_contract',
            {},
            execToken,
          );
          assert.equal(coordContractTool.status, 200);
          assert.equal(execContractTool.status, 200);
          assert.deepEqual(Object.keys(coordContractTool.json).sort(), [
            'contract',
            'contractRevision',
          ]);
          assert.equal(
            (coordContractTool.json as { contractRevision?: number }).contractRevision,
            2,
          );
          assert.equal(
            (coordContractTool.json as { contract?: { intent?: string } }).contract?.intent,
            BRIEF_CONTRACT_R2.intent,
          );
          assert.equal(
            (execContractTool.json as { contractRevision?: number }).contractRevision,
            2,
          );

          const coordProject = await postJson(
            base,
            '/api/agent/coagent_get_project_context',
            {},
            coordToken,
          );
          const execProject = await postJson(
            base,
            '/api/agent/coagent_get_project_context',
            {},
            execToken,
          );
          assert.equal(coordProject.status, 200);
          assert.equal(execProject.status, 200);
          assert.equal((coordProject.json as { available?: boolean }).available, true);
          assert.equal((coordProject.json as { projectProfile?: string }).projectProfile, BRIEF_RULES);
          const specIndex = (coordProject.json as { specs?: { slug: string }[] }).specs ?? [];
          assert.equal(specIndex.some((s) => s.slug === 'http-brief'), true);
          assert.equal(JSON.stringify(coordProject.json).includes('SPEC-BODY-MUST-NOT-PREFETCH'), false);
          assert.equal((execProject.json as { available?: boolean }).available, true);

          const specDoc = await postJson(
            base,
            '/api/agent/coagent_get_project_context',
            { slug: 'http-brief' },
            coordToken,
          );
          assert.equal(specDoc.status, 200);
          assert.equal((specDoc.json as { available?: boolean }).available, true);
          assert.match(String((specDoc.json as { body?: string }).body ?? ''), /SPEC-BODY-MUST-NOT-PREFETCH/);
        } finally {
          await closeServer(server);
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  },
);

type BriefEntry = {
  source: string;
  estimatedTokens?: number;
  content?: unknown;
};
type BriefBudgetReport = {
  budget?: number;
  estimatedBefore?: number;
  estimatedAfter?: number;
  omittedSources?: string[];
  overflow?: boolean;
  remainingOverBudget?: number;
};
type BriefBody = {
  role?: string;
  projectRules?: string;
  environmentNotes?: unknown;
  contract?: { intent?: string };
  contractRevision?: number;
  plan?: { direction?: string; findings?: string };
  planRevision?: number;
  workItem?: { id?: string; order?: { contextRefs?: unknown } };
  finalReview?: unknown;
  contextBundle?: {
    role?: string;
    entries?: BriefEntry[];
    budgetReport?: BriefBudgetReport;
  };
};
type ActivityRow = {
  kind?: string;
  missionId?: string;
  attemptId?: string;
  workItemId?: string;
  correlationId?: string;
  causationId?: string;
  data?: Record<string, unknown>;
};

function briefTokenTotal(brief: BriefBody): number {
  return (brief.contextBundle?.entries ?? []).reduce(
    (sum, entry) => sum + (entry.estimatedTokens ?? 0),
    0,
  );
}

function truncatedEvents(rows: unknown): ActivityRow[] {
  return (rows as ActivityRow[]).filter((row) => row.kind === 'context.truncated');
}

function assertSafeTruncationData(data: Record<string, unknown> | undefined, forbidden: string[]): void {
  assert.ok(data);
  const keys = Object.keys(data).sort();
  assert.deepEqual(
    keys.filter((key) => key !== 'remainingOverBudget'),
    ['budget', 'estimatedAfter', 'estimatedBefore', 'omittedSources', 'overflow', 'role'].sort(),
  );
  const dumped = JSON.stringify(data);
  for (const needle of forbidden) {
    assert.equal(dumped.includes(needle), false, `审计 data 不得含正文：${needle}`);
  }
}

async function startCoordWithPlan(
  base: string,
  platform: Platform,
  missionId: string,
): Promise<string> {
  const coord = await postJson(base, `/api/missions/${missionId}/coordinator-attempts`, {});
  assert.equal(coord.status, 201);
  const token = (coord.json as { token?: string }).token;
  assert.equal(typeof token, 'string');
  const planned = await postJson(
    base,
    '/api/agent/coagent_update_plan',
    BRIEF_PLAN,
    token,
  );
  assert.equal(planned.status, 200);
  await platform.reviseContract(missionId, BRIEF_CONTRACT_R2);
  return token;
}

describe('HTTP 简报显式预算与事务化裁剪审计', () => {
  test('恰好预算与无预算全留且零审计；N-1 保留顺序/必需字段；同 Attempt 去重、异 Attempt 各一条',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'http-brief-budget-'));
      mkdirSync(join(dir, '.coagent'), { recursive: true });
      writeFileSync(join(dir, '.coagent', 'project.md'), BRIEF_RULES, 'utf8');
      const store = new FileStateStore(join(dir, 'state.json'));
      const clock = new FixedClock();
      const ids = new PersistentIds(store);
      const projects = new FileProjectRepository(store);
      const activity = new FileActivityLog(store, clock);
      const deliveries = new FileDeliveryRepository(store, clock, ids);
      const platform = new Platform({
        projects,
        deliveries,
        activity,
        clock,
        ids,
        transaction: store,
      });
      const tokens = new RunTokenRegistry();
      const server = createApi({ platform, tokens, deliveries });
      try {
        await listenLoopback(server, 0);
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const created = await postJson(base, '/api/missions', {
          projectId: 'P-budget',
          missionId: 'M-budget',
          contract: CONTRACT,
        });
        assert.equal(created.status, 201);
        await platform.recordWorkspace('M-budget', {
          projectRoot: dir,
          branch: 'b',
          baseRevision: 'x',
        });
        const coordToken = await startCoordWithPlan(base, platform, 'M-budget');
        const coordAttemptId = tokens.resolve(coordToken)?.attemptId;
        assert.equal(typeof coordAttemptId, 'string');

        const noneRes = await getJson(base, '/api/run/brief', coordToken);
        assert.equal(noneRes.status, 200);
        const none = noneRes.json as BriefBody;
        const N = briefTokenTotal(none);
        assert.ok(N >= 2);
        assert.equal(none.contextBundle?.budgetReport, undefined);
        assert.deepEqual(
          none.contextBundle?.entries?.map((e) => e.source),
          ['project_rules', 'environment_notes', 'contract', 'plan', 'final_review', 'work_items_index', 'since_last_hop'],
        );
        assert.equal(none.contract?.intent, BRIEF_CONTRACT_R2.intent);
        assert.equal(none.plan?.direction, BRIEF_PLAN.direction);
        assert.equal(none.projectRules, BRIEF_RULES);

        const exactRes = await getJson(base, `/api/run/brief?budget=${N}`, coordToken);
        assert.equal(exactRes.status, 200);
        const exact = exactRes.json as BriefBody;
        assert.deepEqual(
          exact.contextBundle?.entries?.map((e) => e.source),
          none.contextBundle?.entries?.map((e) => e.source),
        );
        assert.deepEqual(exact.contextBundle?.budgetReport?.omittedSources, []);
        assert.equal(exact.contextBundle?.budgetReport?.budget, N);
        assert.equal(exact.contextBundle?.budgetReport?.overflow, false);
        assert.equal(exact.plan?.direction, BRIEF_PLAN.direction);

        const activityNone = await getJson(base, '/api/missions/M-budget/activity');
        assert.equal(activityNone.status, 200);
        assert.equal(truncatedEvents(activityNone.json).length, 0);

        const planTokens =
          none.contextBundle?.entries?.find((e) => e.source === 'plan')?.estimatedTokens ?? 0;
        assert.ok(planTokens >= 1);
        const cutRes = await getJson(base, `/api/run/brief?budget=${N - 1}`, coordToken);
        assert.equal(cutRes.status, 200);
        const cut = cutRes.json as BriefBody;
        assert.deepEqual(cut.contextBundle?.entries?.map((e) => e.source), [
          'project_rules',
          'environment_notes',
          'contract',
          'final_review',
          'work_items_index',
          'since_last_hop',
        ]);
        assert.deepEqual(cut.contextBundle?.budgetReport?.omittedSources, ['plan']);
        assert.equal(cut.contextBundle?.budgetReport?.estimatedBefore, N);
        assert.equal(cut.contextBundle?.budgetReport?.estimatedAfter, N - planTokens);
        assert.equal(cut.contextBundle?.budgetReport?.estimatedAfter, briefTokenTotal(cut));
        assert.equal(cut.contextBundle?.budgetReport?.overflow, false);
        assert.equal(cut.contract?.intent, BRIEF_CONTRACT_R2.intent);
        assert.equal(cut.contractRevision, 2);
        assert.equal(cut.projectRules, BRIEF_RULES);
        assert.equal(cut.plan, undefined);
        assert.equal(cut.planRevision, undefined);

        const again = await getJson(base, `/api/run/brief?budget=${N - 1}`, coordToken);
        assert.equal(again.status, 200);

        const wi = await postJson(
          base,
          '/api/agent/coagent_create_work_item',
          { title: 'W1', ...BRIEF_ORDER },
          coordToken,
        );
        assert.equal(wi.status, 200);
        const workItemId = (wi.json as { workItemId?: string }).workItemId;
        // 契约已在 startCoordWithPlan 里改到 r2，核对要按当前修订提交。
        await postJson(
          base,
          '/api/agent/coagent_submit_contract_check',
          { verdict: 'ok', summary: '测试契约已核对' },
          coordToken,
        );
        const dispatched = await postJson(
          base,
          '/api/agent/coagent_dispatch_work_item',
          { workItemIds: [workItemId] },
          coordToken,
        );
        assert.equal(dispatched.status, 200);
        const exec = await postJson(
          base,
          `/api/missions/M-budget/work-items/${workItemId}/executor-attempts`,
          {},
        );
        assert.equal(exec.status, 201);
        const execToken = (exec.json as { token?: string }).token;
        assert.equal(typeof execToken, 'string');
        const execAttemptId = tokens.resolve(execToken)?.attemptId;
        assert.equal(typeof execAttemptId, 'string');

        const execFullRes = await getJson(base, '/api/run/brief', execToken);
        assert.equal(execFullRes.status, 200);
        const execFull = execFullRes.json as BriefBody;
        const execN = briefTokenTotal(execFull);
        const execNotes =
          execFull.contextBundle?.entries?.find((e) => e.source === 'environment_notes')
            ?.estimatedTokens ?? 0;
        assert.ok(execNotes >= 1);
        const execCutRes = await getJson(
          base,
          `/api/run/brief?budget=${execN - execNotes}`,
          execToken,
        );
        assert.equal(execCutRes.status, 200);
        const execCut = execCutRes.json as BriefBody;
        assert.deepEqual(execCut.contextBundle?.budgetReport?.omittedSources, [
          'environment_notes',
        ]);
        assert.equal(execCut.projectRules, BRIEF_RULES);
        assert.deepEqual(execCut.workItem?.order?.contextRefs, BRIEF_REFS);
        assert.equal(execCut.environmentNotes, undefined);

        const overflowRes = await getJson(base, '/api/run/brief?budget=0', coordToken);
        assert.equal(overflowRes.status, 200);
        const overflow = overflowRes.json as BriefBody;
        assert.equal(overflow.contextBundle?.budgetReport?.overflow, true);
        assert.equal(
          overflow.contextBundle?.budgetReport?.remainingOverBudget,
          briefTokenTotal(overflow),
        );
        assert.equal(overflow.contract?.intent, BRIEF_CONTRACT_R2.intent);
        assert.equal(overflow.projectRules, BRIEF_RULES);
        assert.deepEqual(overflow.contextBundle?.budgetReport?.omittedSources, [
          'plan',
          'environment_notes',
        ]);

        for (const bad of ['-1', '1.5', 'abc', '01', '1e2', '', '+1']) {
          const rejected = await getJson(base, `/api/run/brief?budget=${bad}`, coordToken);
          assert.equal(rejected.status, 400, bad);
          assert.equal(rejected.json.error, 'INVALID_BUDGET', bad);
        }

        const activityCut = await getJson(base, '/api/missions/M-budget/activity');
        assert.equal(activityCut.status, 200);
        const trunc = truncatedEvents(activityCut.json);
        assert.equal(trunc.length, 2);
        const coordEvt = trunc.find((row) => row.attemptId === coordAttemptId);
        const execEvt = trunc.find((row) => row.attemptId === execAttemptId);
        assert.ok(coordEvt);
        assert.ok(execEvt);
        assert.equal(coordEvt.missionId, 'M-budget');
        assert.equal(coordEvt.correlationId, 'M-budget');
        assert.equal(coordEvt.causationId, coordAttemptId);
        assert.equal(coordEvt.workItemId, undefined);
        assertSafeTruncationData(coordEvt.data, [
          BRIEF_RULES,
          BRIEF_CONTRACT_R2.intent,
          BRIEF_PLAN.direction,
          BRIEF_PLAN.findings,
          'SPEC-BODY-MUST-NOT-PREFETCH',
        ]);
        assert.equal(coordEvt.data?.role, 'coordinator');
        assert.equal(coordEvt.data?.omittedSources?.[0], 'plan');
        assert.equal(execEvt.missionId, 'M-budget');
        assert.equal(execEvt.correlationId, 'M-budget');
        assert.equal(execEvt.causationId, execAttemptId);
        assertSafeTruncationData(execEvt.data, [BRIEF_RULES, BRIEF_CONTRACT_R2.intent]);
        assert.equal(execEvt.data?.role, 'executor');
      } finally {
        await closeServer(server);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test('FileStateStore 事务路径：事件写入失败不返回裁剪简报；成功可重启后读到',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'http-brief-budget-fail-'));
      mkdirSync(join(dir, '.coagent'), { recursive: true });
      writeFileSync(join(dir, '.coagent', 'project.md'), BRIEF_RULES, 'utf8');
      const statePath = join(dir, 'state.json');
      const store = new FileStateStore(statePath);
      const clock = new FixedClock();
      const ids = new PersistentIds(store);
      const projects = new FileProjectRepository(store);
      const innerActivity = new FileActivityLog(store, clock);
      const injected = {
        fail: true,
        async append(event: { kind: string }): Promise<void> {
          if (this.fail && event.kind === 'context.truncated') {
            throw new Error('injected context.truncated persist failure');
          }
          await innerActivity.append(event as Parameters<FileActivityLog['append']>[0]);
        },
        list: (missionId: string) => innerActivity.list(missionId),
      };
      const deliveries = new FileDeliveryRepository(store, clock, ids);
      const platform = new Platform({
        projects,
        deliveries,
        activity: injected,
        clock,
        ids,
        transaction: store,
      });
      const tokens = new RunTokenRegistry();
      const server = createApi({ platform, tokens, deliveries });
      try {
        await listenLoopback(server, 0);
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const created = await postJson(base, '/api/missions', {
          projectId: 'P-fail',
          missionId: 'M-fail',
          contract: CONTRACT,
        });
        assert.equal(created.status, 201);
        await platform.recordWorkspace('M-fail', {
          projectRoot: dir,
          branch: 'b',
          baseRevision: 'x',
        });
        const coordToken = await startCoordWithPlan(base, platform, 'M-fail');
        const none = (await getJson(base, '/api/run/brief', coordToken)).json as BriefBody;
        const N = briefTokenTotal(none);
        const failed = await getJson(base, `/api/run/brief?budget=${N - 1}`, coordToken);
        assert.notEqual(failed.status, 200);
        assert.equal(failed.json.error, 'INTERNAL');
        const liveEvents = truncatedEvents(await innerActivity.list('M-fail'));
        assert.equal(liveEvents.length, 0);

        const reopenAfterFail = new FileStateStore(statePath);
        const persistedFail = new FileActivityLog(reopenAfterFail, clock);
        assert.equal(truncatedEvents(await persistedFail.list('M-fail')).length, 0);

        injected.fail = false;
        const ok = await getJson(base, `/api/run/brief?budget=${N - 1}`, coordToken);
        assert.equal(ok.status, 200);
        const cut = ok.json as BriefBody;
        assert.deepEqual(cut.contextBundle?.budgetReport?.omittedSources, ['plan']);
        assert.equal(truncatedEvents(await innerActivity.list('M-fail')).length, 1);
      } finally {
        await closeServer(server);
      }

      const restarted = new FileStateStore(statePath);
      const restartedActivity = new FileActivityLog(restarted, clock);
      const persisted = truncatedEvents(await restartedActivity.list('M-fail'));
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0]?.missionId, 'M-fail');
      assert.equal(persisted[0]?.correlationId, 'M-fail');
      assert.equal(typeof persisted[0]?.attemptId, 'string');
      assert.equal(persisted[0]?.causationId, persisted[0]?.attemptId);
      assertSafeTruncationData(persisted[0]?.data, [BRIEF_RULES, BRIEF_CONTRACT_R2.intent, BRIEF_PLAN.direction]);
      rmSync(dir, { recursive: true, force: true });
    },
  );

  test('队列 Attempt 裁剪写入必须带 claim，不得绕过 #attemptWrite',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'http-brief-budget-queue-'));
      try {
        const store = new FileStateStore(join(dir, 'state.json'));
        const clock = new FixedClock(QUEUE_NOW);
        const ids = new PersistentIds(store);
        const projects = new FileProjectRepository(store);
        const activity = new FileActivityLog(store, clock);
        const deliveries = new FileDeliveryRepository(store, clock, ids);
        const hops = new FileQueuedHopRepository(store);
        const platform = new Platform({
          projects,
          deliveries,
          activity,
          clock,
          ids,
          transaction: store,
        });
        await platform.createMission({
          projectId: 'P',
          missionId: 'M',
          contract: CONTRACT,
          origin: QUEUE_ORIGIN,
        });
        const live = await enqueueAndClaim(hops);
        const queued = await platform.startCoordinatorAttempt('M', undefined, live);
        await platform.updatePlan('M', queued.attemptId, QUEUE_PLAN, live);
        const full = await platform.getStartupBrief('M', queued.attemptId);
        const N = briefTokenTotal(full);
        assert.ok(N >= 2);
        await assert.rejects(
          () => platform.getStartupBrief('M', queued.attemptId, N - 1),
          (error: unknown) =>
            error instanceof PlatformRuleError && error.code === 'QUEUE_CLAIM_REQUIRED',
        );
        assert.equal(
          (await activity.list('M')).filter((event) => event.kind === 'context.truncated').length,
          0,
        );
        const trimmed = await platform.getStartupBrief('M', queued.attemptId, N - 1, live);
        assert.ok((trimmed.contextBundle.budgetReport?.omittedSources.length ?? 0) > 0);
        await platform.getStartupBrief('M', queued.attemptId, N - 1, live);
        const trunc = (await activity.list('M')).filter((event) => event.kind === 'context.truncated');
        assert.equal(trunc.length, 1);
        assert.equal(trunc[0]?.attemptId, queued.attemptId);
        assert.equal(trunc[0]?.missionId, 'M');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

async function request(
  base: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
    headers: res.headers,
  };
}

function tapPlatform(
  platform: Platform,
  method: 'finalizeMission' | 'finalizeMissionByReviewer' | 'finalizeMissionByHaAuthority',
): unknown[][] {
  const calls: unknown[][] = [];
  const orig = platform[method].bind(platform) as (...args: unknown[]) => unknown;
  (platform as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
    calls.push(args);
    return orig(...args);
  };
  return calls;
}

async function openApi(options?: {
  onMutation?: () => void | Promise<void>;
  identity?: { instanceId: string; stateId: string };
  runMission?: HostedRunHandler;
  runPlan?: HostedRunHandler;
  planRunDirs?: () => readonly string[];
  resolveControlPrincipal?: ControlPrincipalResolver;
  agentPool?: import('../src/application/agent-pool.ts').AgentPoolRepository;
  platformStatus?: import('../src/api/server.ts').ApiDeps['platformStatus'];
  queuedHops?: import('../src/application/ports.ts').QueuedHopRepository;
  candidateCircuits?: import('../src/application/ports.ts').CandidateCircuitRepository;
  now?: () => number;
}): Promise<{
  server: Server;
  base: string;
  platform: Platform;
  projects: InMemoryProjectRepository;
}> {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const projects = new InMemoryProjectRepository();
  const platform = new Platform({
    projects,
    deliveries,
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
  const server = createApi({
    platform,
    tokens: new RunTokenRegistry(),
    deliveries,
    ...(options?.onMutation ? { onMutation: options.onMutation } : {}),
    ...(options?.identity ? { identity: options.identity } : {}),
    ...(options?.runMission ? { runMission: options.runMission } : {}),
    ...(options?.runPlan ? { runPlan: options.runPlan } : {}),
    ...(options?.planRunDirs ? { planRunDirs: options.planRunDirs } : {}),
    ...(options?.resolveControlPrincipal
      ? { resolveControlPrincipal: options.resolveControlPrincipal }
      : {}),
    ...(options?.agentPool ? { agentPool: options.agentPool } : {}),
    ...(options?.platformStatus ? { platformStatus: options.platformStatus } : {}),
    ...(options?.queuedHops ? { queuedHops: options.queuedHops } : {}),
    ...(options?.candidateCircuits ? { candidateCircuits: options.candidateCircuits } : {}),
    ...(options?.now ? { now: options.now } : {}),
  });
  await listenLoopback(server, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, platform, projects };
}

async function seedAwaitingReview(base: string, missionId: string, projectId = 'P'): Promise<string> {
  const created = await request(base, '/api/missions', {
    projectId,
    missionId,
    contract: CONTRACT,
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const coord = await request(base, `/api/missions/${missionId}/coordinator-attempts`, {});
  assert.equal(coord.status, 201, JSON.stringify(coord.json));
  const coordToken = coord.json.token as string;
  const planned = await postJson(base, '/api/agent/coagent_update_plan', {
    findings: 'f',
    rejectedHypotheses: [],
    decisions: [],
    direction: 'd',
    risks: [],
  }, coordToken);
  assert.equal(planned.status, 200, JSON.stringify(planned.json));
  const wi = await postJson(base, '/api/agent/coagent_create_work_item', { title: 'W', ...ORDER }, coordToken);
  assert.equal(wi.status, 200, JSON.stringify(wi.json));
  const workItemId = (wi.json as { workItemId?: string }).workItemId as string;
  // W-334 门禁：Standard 派发前必须先提交当前契约修订的核对结论。
  await postJson(base, '/api/agent/coagent_submit_contract_check', { verdict: 'ok', summary: '测试契约已核对' }, coordToken);
  const dispatched = await postJson(base, '/api/agent/coagent_dispatch_work_item', { workItemIds: [workItemId] }, coordToken);
  assert.equal(dispatched.status, 200, JSON.stringify(dispatched.json));
  const exec = await request(base, `/api/missions/${missionId}/work-items/${workItemId}/executor-attempts`, {});
  assert.equal(exec.status, 201, JSON.stringify(exec.json));
  const execToken = exec.json.token as string;
  const evidence = await postJson(
    base,
    '/api/agent/coagent_submit_evidence',
    { kind: 'test', summary: 'ok', command: 'node --test', exitCode: 0 },
    execToken,
  );
  assert.equal(evidence.status, 200, JSON.stringify(evidence.json));
  const submitted = await postJson(
    base,
    '/api/agent/coagent_submit_execution_result',
    {
      outcome: 'completed',
      summary: 'ok',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [(evidence.json as { evidenceId?: string }).evidenceId],
      notes: '无',
    },
    execToken,
  );
  assert.equal(submitted.status, 200, JSON.stringify(submitted.json));
  const finished = await request(base, `/api/missions/${missionId}/attempts/${exec.json.attemptId as string}/finish`, {
    endedBy: 'structured_submit',
  });
  assert.equal(finished.status, 200, JSON.stringify(finished.json));
  const reviewed = await postJson(
    base,
    '/api/agent/coagent_review_execution_result',
    {
      workItemId,
      verdict: 'accept',
      acceptanceResults: ORDER.acceptance.map((criterion) => ({
        criterion,
        status: 'pass',
        evidence: '测过',
      })),
      reasons: ['ok'],
      requiredChanges: [],
    },
    coordToken,
  );
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
  const delivered = await postJson(
    base,
    '/api/agent/coagent_submit_mission_result',
    {
      outcome: 'delivered',
      summary: '交付',
      acceptanceEvidence: ['ok'],
      memoryDelta: [],
      openRisks: [],
    },
    coordToken,
  );
  assert.equal(delivered.status, 200, JSON.stringify(delivered.json));
  const view = await request(base, `/api/missions/${missionId}`);
  assert.equal(view.json.status, 'awaiting_review', JSON.stringify(view.json));
  return workItemId;
}

describe('L3 写路由与落盘后应答', () => {
  test('人签名 / reviewer / HA reviewer merge 分别打到对应 Platform 入口', async () => {
    const { server, base, platform, projects } = await openApi();
    try {
      const humanCalls = tapPlatform(platform, 'finalizeMission');
      const reviewerCalls = tapPlatform(platform, 'finalizeMissionByReviewer');
      const haCalls = tapPlatform(platform, 'finalizeMissionByHaAuthority');

      await seedAwaitingReview(base, 'M-human', 'P-human');
      const human = await request(base, '/api/missions/M-human/finalize', {
        verdict: 'send_back',
        reasons: ['边界不够'],
      });
      assert.equal(human.status, 200);
      assert.equal(human.json.status, 'planning');
      assert.equal(humanCalls.length, 1);
      assert.equal(reviewerCalls.length, 0);
      assert.equal(haCalls.length, 0);

      await seedAwaitingReview(base, 'M-reviewer', 'P-reviewer');
      const reviewer = await request(base, '/api/missions/M-reviewer/finalize/reviewer', {
        verdict: 'send_back',
        reasons: ['检视者打回'],
        reviewerId: 'claude',
        confirmedBy: 'echo',
      });
      assert.equal(reviewer.status, 200, JSON.stringify(reviewer.json));
      assert.equal(reviewer.json.status, 'planning');
      assert.equal(reviewerCalls.length, 1);
      assert.equal(haCalls.length, 0);

      const project = await projects.ensure('P');
      project.createMission({
        id: 'M-ha',
        contract: CONTRACT,
        executionMode: 'high_assurance',
      });
      await projects.save(project);
      const ha = await request(base, '/api/missions/M-ha/finalize/reviewer', {
        verdict: 'merge',
        reasons: ['ok'],
        reviewerId: 'claude',
        confirmedBy: 'echo',
      });
      assert.notEqual(ha.status, 200);
      assert.equal(haCalls.length, 1);
      assert.equal((haCalls[0] as unknown[])[0], 'M-ha');
      assert.equal(reviewerCalls.length, 1, 'HA merge 不得再走普通 reviewer 入口');
    } finally {
      await closeServer(server);
    }
  });

  test('park 与 parked-resume 使用独立 Platform 入口并传递检视信息', async () => {
    const { server, base, platform } = await openApi();
    try {
      const parkedCalls: unknown[][] = [];
      const resumedCalls: unknown[][] = [];
      (platform as unknown as Record<string, unknown>).parkMission = async (...args: unknown[]) => {
        parkedCalls.push(args);
        return { parked: true };
      };
      (platform as unknown as Record<string, unknown>).resumeParkedMission = async (...args: unknown[]) => {
        resumedCalls.push(args);
        return { parked: false };
      };
      const created = await request(base, '/api/missions', {
        projectId: 'P-park', missionId: 'M-park-api', contract: CONTRACT,
      });
      assert.equal(created.status, 201);
      const parked = await request(base, '/api/missions/M-park-api/park', { reason: '等用户', reviewer: 'reviewer' });
      assert.equal(parked.status, 200, JSON.stringify(parked.json));
      assert.equal(parkedCalls.length, 1);
      assert.deepEqual(parkedCalls[0], ['M-park-api', { reason: '等用户', reviewer: 'reviewer' }]);
      const resumed = await request(base, '/api/missions/M-park-api/parked-resume', { reason: '答复到达', reviewer: 'reviewer', answer: '选 A' });
      assert.equal(resumed.status, 200, JSON.stringify(resumed.json));
      assert.deepEqual(resumedCalls[0], ['M-park-api', { reason: '答复到达', reviewer: 'reviewer', answer: '选 A' }]);
    } finally {
      await closeServer(server);
    }
  });

  test('retire / rerun / answer / revise / control / ack 成功与规则拒绝', async () => {
    const { server, base } = await openApi();
    try {
      const created = await request(base, '/api/missions', {
        projectId: 'P',
        missionId: 'M-l3',
        contract: CONTRACT,
      });
      assert.equal(created.status, 201);

      const coord = await request(base, '/api/missions/M-l3/coordinator-attempts', {});
      const coordToken = coord.json.token as string;
      await postJson(
        base,
        '/api/agent/coagent_update_plan',
        { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] },
        coordToken,
      );
      const wi = await postJson(
        base,
        '/api/agent/coagent_create_work_item',
        { title: 'W', ...ORDER },
        coordToken,
      );
      const workItemId = (wi.json as { workItemId?: string }).workItemId as string;

      const retired = await request(base, `/api/missions/M-l3/work-items/${workItemId}/retire`, {
        reason: '契约改了，不用做了',
      });
      assert.equal(retired.status, 200, JSON.stringify(retired.json));
      assert.equal(retired.json.status, 'retired');
      const retiredAgain = await request(base, `/api/missions/M-l3/work-items/${workItemId}/retire`, {
        reason: '再作废一次',
      });
      assert.equal(retiredAgain.status, 409);
      assert.equal(retiredAgain.json.error, 'NOT_RETIRABLE');

      const rerun = await request(base, '/api/missions/M-l3/rerun', { newMissionId: 'M-l3-b' });
      assert.equal(rerun.status, 200, JSON.stringify(rerun.json));
      assert.equal(rerun.json.missionId, 'M-l3-b');
      const rerunMissing = await request(base, '/api/missions/no-such/rerun', {});
      assert.notEqual(rerunMissing.status, 200);
      assert.equal(typeof rerunMissing.json.error, 'string');

      const noEscalation = await request(base, '/api/missions/M-l3/escalations/answer', {
        answer: '先答',
      });
      assert.equal(noEscalation.status, 409);
      assert.equal(noEscalation.json.error, 'NO_OPEN_ESCALATION');
      await postJson(
        base,
        '/api/agent/coagent_escalate_to_l3',
        {
          question: '边界是什么',
          why: '范围不清楚',
          optionsConsidered: ['只改 foo', '全盘重做'],
        },
        coordToken,
      );
      const answered = await request(base, '/api/missions/M-l3/escalations/answer', {
        answer: '只改 foo',
      });
      assert.equal(answered.status, 200, JSON.stringify(answered.json));
      assert.equal(answered.json.answer, '只改 foo');

      const revised = await request(base, '/api/missions/M-l3/contract', {
        intent: '改过的意图',
        acceptance: ['测试全绿'],
        constraints: [],
        nonGoals: [],
        guardrails: ['不得改 Contract'],
      });
      assert.equal(revised.status, 200, JSON.stringify(revised.json));
      assert.equal(revised.json.contractRevision, 2);

      const paused = await request(base, '/api/missions/M-l3/pause', {});
      assert.equal(paused.status, 200);
      assert.equal(paused.json.paused, true);
      const resumed = await request(base, '/api/missions/M-l3/resume', {});
      assert.equal(resumed.status, 200);
      assert.equal(resumed.json.paused, false);
      const cancelled = await request(base, '/api/missions/M-l3/cancel', { reason: '停' });
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.json.status, 'blocked');
      const cancelAgain = await request(base, '/api/missions/M-l3/cancel', { reason: '再停' });
      assert.notEqual(cancelAgain.status, 200);

      const inbox = await request(base, '/api/inbox');
      assert.equal(inbox.status, 200);
      const pending = inbox.json.pending as Array<{ id: string }>;
      assert.ok(pending.length >= 1);
      const acked = await request(base, `/api/deliveries/${pending[0].id}/ack`, {});
      assert.equal(acked.status, 200);
      const ackMissing = await request(base, '/api/deliveries/no-such/ack', {});
      assert.equal(ackMissing.status, 404);
      assert.equal(ackMissing.json.error, 'UNKNOWN_DELIVERY');
    } finally {
      await closeServer(server);
    }
  });

  test('onMutation 拒绝时 POST 不得 2xx；成功落盘后可被读到', async () => {
    const rejecting = await openApi({
      onMutation: () => {
        throw new Error('disk full');
      },
    });
    try {
      const failed = await request(rejecting.base, '/api/missions', {
        projectId: 'P',
        missionId: 'M-persist-fail',
        contract: CONTRACT,
      });
      assert.notEqual(failed.status, 200);
      assert.ok(failed.status < 200 || failed.status >= 300);
      assert.equal(failed.json.error, 'PERSIST_FAILED');
      assert.match(String(failed.json.message), /结果不确定/);
    } finally {
      await closeServer(rejecting.server);
    }

    const dir = mkdtempSync(join(tmpdir(), 'http-l3-persist-'));
    const statePath = join(dir, 'state.json');
    const store = new FileStateStore(statePath);
    const clock = new FixedClock();
    const ids = new PersistentIds(store);
    const projects = new FileProjectRepository(store);
    const deliveries = new FileDeliveryRepository(store, clock, ids);
    const platform = new Platform({
      projects,
      deliveries,
      activity: new FileActivityLog(store, clock),
      clock,
      ids,
      transaction: store,
    });
    const server = createApi({
      platform,
      tokens: new RunTokenRegistry(),
      deliveries,
      onMutation: () => store.flush(),
    });
    try {
      await listenLoopback(server, 0);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const created = await request(base, '/api/missions', {
        projectId: 'P-file',
        missionId: 'M-file',
        contract: CONTRACT,
      });
      assert.equal(created.status, 201);
      const restarted = new FileStateStore(statePath);
      const names = (await new FileProjectRepository(restarted).list()).flatMap((project) =>
        project.missions.map((mission) => mission.id),
      );
      assert.ok(names.includes('M-file'));
    } finally {
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('错误带 api 版本及与 health 一致的 instance/state', async () => {
    const identity = { instanceId: '11111111-1111-4111-8111-111111111111', stateId: 'state-l3' };
    const { server, base } = await openApi({ identity });
    try {
      const health = await request(base, '/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.headers.get('x-coagent-api'), API_VERSION);
      assert.equal(health.headers.get('x-coagent-instance'), identity.instanceId);
      assert.equal(health.headers.get('x-coagent-state-id'), identity.stateId);

      const missing = await request(base, '/api/missions/no-such/finalize', {
        verdict: 'merge',
        reasons: [],
      });
      assert.notEqual(missing.status, 200);
      assert.equal(missing.headers.get('x-coagent-api'), API_VERSION);
      assert.equal(missing.headers.get('x-coagent-instance'), health.headers.get('x-coagent-instance'));
      assert.equal(missing.headers.get('x-coagent-state-id'), health.headers.get('x-coagent-state-id'));
      assert.equal(typeof missing.json.error, 'string');
      assert.equal(typeof missing.json.message, 'string');
    } finally {
      await closeServer(server);
    }
  });
});

const RUN_IDENTITY = {
  instanceId: '22222222-2222-4222-8222-222222222222',
  stateId: 'state-run',
};

function writerTarget(port: number) {
  return {
    port,
    instanceId: RUN_IDENTITY.instanceId,
    stateId: RUN_IDENTITY.stateId,
    apiVersion: API_VERSION,
  };
}

describe('hosted run 流与排空门禁', () => {
  test('未配置的 run-mission / run-plan 明确拒绝，JSON API 语义不变', async () => {
    const { server, base } = await openApi({ identity: RUN_IDENTITY });
    try {
      await assert.rejects(
        () =>
          loopbackRunRequest(writerTarget((server.address() as AddressInfo).port), {
            path: '/api/control/run-mission',
            body: {},
          }, () => {}),
        (error: unknown) =>
          error instanceof LoopbackHttpError &&
          error.status === 501 &&
          error.code === 'HOSTED_RUN_UNAVAILABLE',
      );
      await assert.rejects(
        () =>
          loopbackRunRequest(writerTarget((server.address() as AddressInfo).port), {
            path: '/api/control/run-plan',
            body: {},
          }, () => {}),
        (error: unknown) =>
          error instanceof LoopbackHttpError &&
          error.status === 501 &&
          error.code === 'HOSTED_RUN_UNAVAILABLE',
      );
      const health = await request(base, '/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);
    } finally {
      await closeServer(server);
    }
  });

  test('持锁身份下流先进度后终态，stdout/stderr 可区分，非零 exitCode 原样返回', async () => {
    const seenBodies: unknown[] = [];
    const runMission: HostedRunHandler = async (body, emit) => {
      seenBodies.push(body);
      emit('stdout', 'running-out');
      emit('stderr', 'running-err');
      return 7;
    };
    const runPlan: HostedRunHandler = async (_body, emit) => {
      emit('stdout', 'plan-out');
      return 0;
    };
    const { server, base } = await openApi({
      identity: RUN_IDENTITY,
      runMission,
      runPlan,
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`${base}/api/control/run-mission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp/x' }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-coagent-api'), API_VERSION);
      assert.equal(res.headers.get('x-coagent-instance'), RUN_IDENTITY.instanceId);
      assert.equal(res.headers.get('x-coagent-state-id'), RUN_IDENTITY.stateId);
      assert.match(res.headers.get('content-type') ?? '', /application\/x-ndjson/);
      const frames = (await res.text())
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(frames.slice(0, -1), [
        { channel: 'stdout', line: 'running-out' },
        { channel: 'stderr', line: 'running-err' },
      ]);
      assert.deepEqual(frames.at(-1), { exitCode: 7 });
      assert.deepEqual(seenBodies, [{ cwd: '/tmp/x' }]);

      const lines: Array<{ channel: string; line: string }> = [];
      const code = await loopbackRunRequest(
        writerTarget(port),
        { path: '/api/control/run-mission', body: { cwd: '/tmp/x' } },
        (channel, line) => {
          lines.push({ channel, line });
        },
      );
      assert.equal(code, 7);
      assert.deepEqual(lines, [
        { channel: 'stdout', line: 'running-out' },
        { channel: 'stderr', line: 'running-err' },
      ]);

      const planCode = await loopbackRunRequest(
        writerTarget(port),
        { path: '/api/control/run-plan', body: {} },
        (channel, line) => {
          assert.equal(channel, 'stdout');
          assert.equal(line, 'plan-out');
        },
      );
      assert.equal(planCode, 0);
    } finally {
      await closeServer(server);
    }
  });

  test('回调抛错写成 stderr 和非零终态；身份错误与断线/缺终态显式失败且不重试', async () => {
    const runMission: HostedRunHandler = async (_body, emit) => {
      emit('stdout', 'before-throw');
      throw new Error('hosted boom');
    };
    const { server } = await openApi({ identity: RUN_IDENTITY, runMission });
    try {
      const port = (server.address() as AddressInfo).port;
      const lines: Array<{ channel: string; line: string }> = [];
      const code = await loopbackRunRequest(
        writerTarget(port),
        { path: '/api/control/run-mission', body: {} },
        (channel, line) => lines.push({ channel, line }),
      );
      assert.equal(code, 1);
      assert.deepEqual(lines, [
        { channel: 'stdout', line: 'before-throw' },
        { channel: 'stderr', line: 'hosted boom' },
      ]);

      await assert.rejects(
        () =>
          loopbackRunRequest(
            { ...writerTarget(port), instanceId: 'other-instance' },
            { path: '/api/control/run-mission', body: {} },
            () => {
              throw new Error('身份错误后不得把进度当成功');
            },
          ),
        (error: unknown) => error instanceof LoopbackIdentityError && /实例漂移/.test(error.message),
      );
    } finally {
      await closeServer(server);
    }

    let hits = 0;
    const stub = createServer((req, res) => {
      hits += 1;
      const url = req.url ?? '/';
      if (url.includes('cut')) {
        res.writeHead(200, {
          'x-coagent-api': API_VERSION,
          'x-coagent-instance': RUN_IDENTITY.instanceId,
          'x-coagent-state-id': RUN_IDENTITY.stateId,
          'content-type': 'application/x-ndjson; charset=utf-8',
        });
        res.write(`${JSON.stringify({ channel: 'stdout', line: 'partial' })}\n`);
        res.end();
        return;
      }
      res.writeHead(200, {
        'x-coagent-api': API_VERSION,
        'x-coagent-instance': RUN_IDENTITY.instanceId,
        'x-coagent-state-id': RUN_IDENTITY.stateId,
        'content-type': 'application/x-ndjson; charset=utf-8',
      });
      res.write(`${JSON.stringify({ channel: 'stdout', line: 'hang' })}\n`);
      req.socket.destroy();
    });
    try {
      await listenLoopback(stub, 0);
      const port = (stub.address() as AddressInfo).port;
      const target = writerTarget(port);
      await assert.rejects(
        () => loopbackRunRequest(target, { path: '/cut', body: {} }, () => {}),
        (error: unknown) => error instanceof Error && /截断/.test(error.message),
      );
      await assert.rejects(
        () => loopbackRunRequest(target, { path: '/drop', body: {} }, () => {}),
        (error: unknown) => error instanceof Error && /写者断线|截断/.test(error.message),
      );
      assert.equal(hits, 2, '断线与缺终态都不得自动重试');
    } finally {
      await closeServer(stub);
    }
  });

  test('关闭门禁拒新启动并等待在途 job/HTTP 写；断连后 job 仍只执行一次，JSON 仍可响应', async () => {
    let releaseJob: (code: number) => void = () => {};
    let jobStarted!: () => void;
    const jobStartedPromise = new Promise<void>((resolve) => {
      jobStarted = resolve;
    });
    let runs = 0;
    const runMission: HostedRunHandler = async (_body, emit) => {
      runs += 1;
      emit('stdout', 'job-running');
      jobStarted();
      return await new Promise<number>((resolve) => {
        releaseJob = resolve;
      });
    };
    let releaseMutation: () => void = () => {};
    let mutationStarted!: () => void;
    const mutationStartedPromise = new Promise<void>((resolve) => {
      mutationStarted = resolve;
    });
    const { server, base } = await openApi({
      identity: RUN_IDENTITY,
      runMission,
      onMutation: async () => {
        mutationStarted();
        await new Promise<void>((resolve) => {
          releaseMutation = resolve;
        });
      },
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const aborted = await new Promise<{ status: number }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            family: 4,
            port,
            path: '/api/control/run-mission',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': 2 },
          },
          (res) => {
            res.once('data', () => {
              req.destroy();
              resolve({ status: res.statusCode ?? 0 });
            });
          },
        );
        req.on('error', () => {
          // destroy 之后 socket 报错是预期，job 必须继续。
        });
        req.on('timeout', () => reject(new Error('abort fixture timed out')));
        req.write('{}');
        req.end();
      });
      assert.equal(aborted.status, 200);
      await jobStartedPromise;
      assert.equal(runs, 1);

      const writePromise = request(base, '/api/missions', {
        projectId: 'P-drain',
        missionId: 'M-drain',
        contract: CONTRACT,
      });
      await mutationStartedPromise;

      const draining = drainApi(server);
      let drainDone = false;
      void draining.then(() => {
        drainDone = true;
      });
      await Promise.resolve();
      assert.equal(drainDone, false);

      await assert.rejects(
        () =>
          loopbackRunRequest(writerTarget(port), { path: '/api/control/run-mission', body: {} }, () => {}),
        (error: unknown) =>
          error instanceof LoopbackHttpError &&
          error.status === 503 &&
          error.code === 'SERVICE_DRAINING',
      );
      assert.equal(runs, 1);

      const health = await request(base, '/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);
      assert.equal(drainDone, false);

      releaseJob(0);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(drainDone, false, '写请求未结束时 drain 不能完成');
      releaseMutation();
      const written = await writePromise;
      assert.equal(written.status, 201);
      await draining;
      assert.equal(drainDone, true);
      assert.equal(runs, 1);

      const after = await request(base, '/api/health');
      assert.equal(after.status, 200);
    } finally {
      releaseJob(1);
      releaseMutation();
      await closeServer(server);
    }
  });

  test('心跳帧不进 onLine；有心跳时短超时不断流；无字节才超时且不重试', async () => {
    const ndjsonHeaders = {
      'x-coagent-api': API_VERSION,
      'x-coagent-instance': RUN_IDENTITY.instanceId,
      'x-coagent-state-id': RUN_IDENTITY.stateId,
      'content-type': 'application/x-ndjson; charset=utf-8',
    };
    const waitUntil = (predicate: () => boolean, timeoutMs: number, dump: () => string): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve, reject) => {
        const tick = () => {
          if (predicate()) {
            resolve();
            return;
          }
          if (Date.now() >= deadline) {
            reject(new Error(`等待超时：${dump()}`));
            return;
          }
          setTimeout(tick, 15);
        };
        tick();
      });
    };

    const mixed = createServer((_req, res) => {
      res.writeHead(200, ndjsonHeaders);
      res.write(`${JSON.stringify({ heartbeat: true })}\n`);
      res.write(`${JSON.stringify({ channel: 'stdout', line: 'keep' })}\n`);
      res.write(`${JSON.stringify({ heartbeat: true })}\n`);
      res.write(`${JSON.stringify({ exitCode: 0 })}\n`);
      res.end();
    });
    try {
      await listenLoopback(mixed, 0);
      const lines: Array<{ channel: string; line: string }> = [];
      const code = await loopbackRunRequest(
        writerTarget((mixed.address() as AddressInfo).port),
        { path: '/run', body: {} },
        (channel, line) => lines.push({ channel, line }),
      );
      assert.equal(code, 0);
      assert.deepEqual(lines, [{ channel: 'stdout', line: 'keep' }]);
    } finally {
      await closeServer(mixed);
    }

    let liveHits = 0;
    let heartbeats = 0;
    let finishLive: (() => void) | undefined;
    const live = createServer((_req, res) => {
      liveHits += 1;
      res.writeHead(200, ndjsonHeaders);
      const timer = setInterval(() => {
        heartbeats += 1;
        res.write(`${JSON.stringify({ heartbeat: true })}\n`);
      }, 20);
      finishLive = () => {
        clearInterval(timer);
        res.write(`${JSON.stringify({ exitCode: 0 })}\n`);
        res.end();
      };
    });
    try {
      await listenLoopback(live, 0);
      const lines: Array<{ channel: string; line: string }> = [];
      const running = loopbackRunRequest(
        writerTarget((live.address() as AddressInfo).port),
        { path: '/run', body: {} },
        (channel, line) => lines.push({ channel, line }),
        { timeoutMs: 80 },
      );
      await waitUntil(() => heartbeats >= 4, 1_000, () => `heartbeats=${String(heartbeats)}`);
      finishLive?.();
      assert.equal(await running, 0);
      assert.deepEqual(lines, []);
      assert.equal(liveHits, 1, '有心跳的长流不得自动重试');
    } finally {
      finishLive?.();
      await closeServer(live);
    }

    let idleHits = 0;
    const idle = createServer((_req, res) => {
      idleHits += 1;
      res.writeHead(200, ndjsonHeaders);
    });
    try {
      await listenLoopback(idle, 0);
      const target = writerTarget((idle.address() as AddressInfo).port);
      await assert.rejects(
        () => loopbackRunRequest(target, { path: '/run', body: {} }, () => {}, { timeoutMs: 80 }),
        (error: unknown) => error instanceof Error && /回环运行流超时/.test(error.message),
      );
      await assert.rejects(
        () => loopbackRunRequest(target, { path: '/run', body: {} }, () => {}, { timeoutMs: 80 }),
        (error: unknown) => error instanceof Error && /回环运行流超时/.test(error.message),
      );
      assert.equal(idleHits, 2, '超时失败不得在单次调用内重试；两次调用才是两次');
    } finally {
      await closeServer(idle);
    }
  });

  test('hosted run 空闲心跳可被探测且不进进度；等待期间健康检查仍可回应', async () => {
    let releaseJob: (code: number) => void = () => {};
    const runPlan: HostedRunHandler = async (_body, emit) => {
      emit('stdout', 'waiting');
      return await new Promise<number>((resolve) => {
        releaseJob = resolve;
      });
    };
    const { server, base } = await openApi({ identity: RUN_IDENTITY, runPlan });
    try {
      const port = (server.address() as AddressInfo).port;
      const frames: Array<Record<string, unknown>> = [];
      const raw = await new Promise<{ req: ReturnType<typeof httpRequest> }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            family: 4,
            port,
            path: '/api/control/run-plan',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': 2 },
          },
          (res) => {
            let buffer = '';
            res.on('data', (chunk) => {
              buffer += String(chunk);
              let nl = buffer.indexOf('\n');
              while (nl >= 0) {
                const rawLine = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                nl = buffer.indexOf('\n');
                if (rawLine.length === 0) continue;
                frames.push(JSON.parse(rawLine) as Record<string, unknown>);
              }
            });
            resolve({ req });
          },
        );
        req.on('error', reject);
        req.write('{}');
        req.end();
      });
      const deadline = Date.now() + HOSTED_RUN_HEARTBEAT_IDLE_MS * 3;
      await new Promise<void>((resolve, reject) => {
        const tick = () => {
          if (frames.some((frame) => frame.heartbeat === true)) {
            resolve();
            return;
          }
          if (Date.now() >= deadline) {
            reject(new Error(`未见心跳：${JSON.stringify(frames)}`));
            return;
          }
          setTimeout(tick, 20);
        };
        tick();
      });
      assert.ok(frames.some((frame) => frame.channel === 'stdout' && frame.line === 'waiting'));
      assert.equal(
        frames.some((frame) => frame.heartbeat === true && (frame.channel === 'stdout' || frame.channel === 'stderr')),
        false,
      );
      const health = await request(base, '/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);
      assert.equal(
        frames.filter((frame) => frame.heartbeat === true).every((frame) => frame.channel === undefined),
        true,
      );
      releaseJob(0);
      const endAt = Date.now() + 2_000;
      await new Promise<void>((resolve, reject) => {
        const tick = () => {
          if (frames.some((frame) => typeof frame.exitCode === 'number')) {
            resolve();
            return;
          }
          if (Date.now() >= endAt) {
            reject(new Error(`未见终态：${JSON.stringify(frames)}`));
            return;
          }
          setTimeout(tick, 20);
        };
        tick();
      });
      assert.equal(frames.at(-1)?.exitCode, 0);
      raw.req.destroy();
    } finally {
      releaseJob(1);
      await closeServer(server);
    }
  });
});

describe('轻量报卡升级、答复重派与执行者问答视图', () => {
  const PLAN = {
    findings: '查到了',
    rejectedHypotheses: [] as string[],
    decisions: [] as string[],
    direction: '这么改',
    risks: [] as string[],
  };

  function harness() {
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const activity = new InMemoryActivityLog(clock);
    const deliveries = new InMemoryDeliveryRepository(clock, ids);
    const projects = new InMemoryProjectRepository();
    let txRuns = 0;
    const platform = new Platform({
      projects,
      deliveries,
      activity,
      clock,
      ids,
      transaction: {
        async run<T>(fn: () => Promise<T>) {
          txRuns += 1;
          return fn();
        },
      },
    });
    return {
      platform,
      projects,
      activity,
      deliveries,
      txRuns: () => txRuns,
    };
  }

  async function lightweightDispatched(h: ReturnType<typeof harness>, missionId = 'M-lw') {
    const project = await h.projects.ensure('P');
    project.createMission({
      id: missionId,
      contract: CONTRACT,
      executionMode: 'lightweight',
      runKind: 'mutation',
      origin: { clientType: 'cli', conversationRef: 'me' },
    });
    await h.projects.save(project);
    const { workItemId } = await h.platform.createLightweightWorkItem(missionId, {
      title: 'W',
      order: ORDER,
    });
    await h.platform.dispatchLightweightWorkItem(missionId, workItemId);
    const exec = await h.platform.startExecutorAttempt(missionId, workItemId);
    return { missionId, workItemId, attemptId: exec.attemptId };
  }

  test('轻量有需求的 blocked 记一条字段映射准确的升级与一次投递；standard/空白需求无升级', async () => {
    const lw = harness();
    const live = await lightweightDispatched(lw);
    const reason = '工单前提不成立';
    const whatWasTried = ['ls src/', '选 A', '选 B'];
    const question = '确认真正的文件路径';
    await lw.platform.reportBlocked(live.missionId, live.attemptId, {
      reason,
      whatWasTried,
      needsFromUpstream: question,
    });
    const view = await lw.platform.getMissionView(live.missionId);
    assert.equal(view.escalations, 1);
    assert.equal(view.openEscalations.length, 1);
    assert.equal(view.openEscalations[0]?.attemptId, live.attemptId);
    assert.equal(view.openEscalations[0]?.question, question);
    assert.equal(view.openEscalations[0]?.why, reason);
    assert.deepEqual(view.openEscalations[0]?.optionsConsidered, whatWasTried);
    assert.equal(view.openEscalations[0]?.answer, undefined);
    const deliveries = await lw.deliveries.listForMission(live.missionId);
    assert.equal(deliveries.filter((row) => row.outcome === 'escalated').length, 1);
    assert.equal(deliveries[0]?.idempotencyKey, 'escalated:0');
    const events = await lw.activity.list(live.missionId);
    assert.equal(events.filter((event) => event.kind === 'escalated').length, 1);
    assert.equal(events.filter((event) => event.kind === 'delivery.created').length, 1);
    assert.equal(events.filter((event) => event.kind === 'blocked.reported').length, 1);

    const blank = harness();
    const blankLive = await lightweightDispatched(blank, 'M-blank');
    await blank.platform.reportBlocked(blankLive.missionId, blankLive.attemptId, {
      reason: '暂时做不了',
      whatWasTried: ['试过了'],
      needsFromUpstream: '   ',
    });
    const blankView = await blank.platform.getMissionView(blankLive.missionId);
    assert.equal(blankView.escalations, 0);
    assert.equal(blankView.openEscalations.length, 0);
    assert.equal((await blank.deliveries.listForMission(blankLive.missionId)).length, 0);

    const empty = harness();
    const emptyLive = await lightweightDispatched(empty, 'M-empty');
    await empty.platform.reportBlocked(emptyLive.missionId, emptyLive.attemptId, {
      reason: '暂时做不了',
      whatWasTried: [],
      needsFromUpstream: '',
    });
    assert.equal((await empty.platform.getMissionView(emptyLive.missionId)).escalations, 0);

    const std = harness();
    await std.platform.createMission({ projectId: 'P', missionId: 'M-std', contract: CONTRACT });
    const coord = await std.platform.startCoordinatorAttempt('M-std');
    await std.platform.updatePlan('M-std', coord.attemptId, PLAN);
    const { workItemId } = await std.platform.createWorkItem('M-std', coord.attemptId, {
      title: 'W',
      order: ORDER,
    });
    // W-334 门禁：Standard 派发前必须先提交当前契约修订的核对结论。
    await std.platform.submitContractCheck('M-std', coord.attemptId, { verdict: 'ok', summary: '测试契约已核对' });
    await std.platform.dispatchWorkItems('M-std', coord.attemptId, [workItemId]);
    const exec = await std.platform.startExecutorAttempt('M-std', workItemId);
    await std.platform.reportBlocked('M-std', exec.attemptId, {
      reason: '工单前提不成立',
      whatWasTried: ['ls'],
      needsFromUpstream: '确认路径',
    });
    const stdView = await std.platform.getMissionView('M-std');
    assert.equal(stdView.escalations, 0);
    assert.equal(stdView.workItems[0]?.status, 'blocked');
    assert.equal((await std.deliveries.listForMission('M-std')).length, 0);
  });

  test('answerEscalation 同一事务答复并重派原 blocked 轻量工单，写事件，不造 coordinator；不误派别的项', async () => {
    const h = harness();
    const live = await lightweightDispatched(h);
    await h.platform.reportBlocked(live.missionId, live.attemptId, {
      reason: '工单前提不成立',
      whatWasTried: ['A', 'B', 'C'],
      needsFromUpstream: '选哪条？',
    });
    await h.platform.finishAttempt(live.missionId, live.attemptId, { endedBy: 'no_structured_result' });
    const before = h.txRuns();
    const answered = await h.platform.answerEscalation(live.missionId, '选 B，改 foo');
    assert.equal(h.txRuns() - before, 1);
    assert.equal(answered.question, '选哪条？');
    assert.equal(answered.answer, '选 B，改 foo');
    const view = await h.platform.getMissionView(live.missionId);
    assert.equal(view.workItems[0]?.status, 'dispatched');
    assert.equal(view.workItems[0]?.id, live.workItemId);
    assert.equal(view.openEscalations.length, 0);
    assert.equal(view.escalationLog[0]?.answer, '选 B，改 foo');
    assert.equal(view.coordinatorAttemptIds.length, 0);
    const events = await h.activity.list(live.missionId);
    const redispatched = events.filter((event) => event.kind === 'work_item.redispatched');
    assert.equal(redispatched.length, 1);
    assert.deepEqual(redispatched[0]?.data, {
      ids: [live.workItemId],
      reason: 'escalation_answered',
    });
    assert.equal(redispatched[0]?.workItemId, live.workItemId);
    assert.ok(events.some((event) => event.kind === 'escalation.answered'));

    const std = harness();
    await std.platform.createMission({
      projectId: 'P',
      missionId: 'M-std',
      contract: CONTRACT,
      origin: { clientType: 'cli', conversationRef: 'me' },
    });
    const coord = await std.platform.startCoordinatorAttempt('M-std');
    await std.platform.updatePlan('M-std', coord.attemptId, PLAN);
    const first = await std.platform.createWorkItem('M-std', coord.attemptId, {
      title: 'W1',
      order: ORDER,
    });
    const second = await std.platform.createWorkItem('M-std', coord.attemptId, {
      title: 'W2',
      order: ORDER,
    });
    // W-334 门禁：Standard 派发前必须先提交当前契约修订的核对结论。
    await std.platform.submitContractCheck('M-std', coord.attemptId, { verdict: 'ok', summary: '测试契约已核对' });
    await std.platform.dispatchWorkItems('M-std', coord.attemptId, [
      first.workItemId,
      second.workItemId,
    ]);
    const exec1 = await std.platform.startExecutorAttempt('M-std', first.workItemId);
    await std.platform.reportBlocked('M-std', exec1.attemptId, {
      reason: 'W1 不成立',
      whatWasTried: ['试了'],
      needsFromUpstream: '怎么改 W1？',
    });
    await std.platform.finishAttempt('M-std', exec1.attemptId, { endedBy: 'no_structured_result' });
    await std.platform.finishAttempt('M-std', coord.attemptId, { endedBy: 'structured_submit' });
    const coord2 = await std.platform.startCoordinatorAttempt('M-std');
    await std.platform.escalateToL3('M-std', coord2.attemptId, {
      question: 'W1 怎么改？',
      why: '执行者卡住了',
      optionsConsidered: ['重写工单', '作废'],
    });
    await std.platform.answerEscalation('M-std', '重写工单');
    const after = await std.platform.getMissionView('M-std');
    assert.equal(after.workItems.find((item) => item.id === first.workItemId)?.status, 'blocked');
    assert.equal(after.workItems.find((item) => item.id === second.workItemId)?.status, 'dispatched');
    const stdEvents = await std.activity.list('M-std');
    assert.equal(stdEvents.filter((event) => event.kind === 'work_item.redispatched').length, 0);
  });
});

describe('方案运行只读 API 与 Mission 来源投影', () => {
  const T0 = '2026-09-23T14:00:00.000Z';
  const MIN = 60_000;
  const at = (minutes: number) => new Date(Date.parse(T0) + minutes * MIN).toISOString();
  const STOP = {
    unresolvedEscalations: 5,
    wallClockMs: 8 * 60 * MIN,
    escalationTimeoutMs: 20 * MIN,
  };

  test('列表摘要倒序、project 筛选、坏文件不拖垮；详情含升级决定；恶意 id 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-plan-runs-'));
    try {
      const older = new FilePlanRunStore(join(dir, 'R-old.json'));
      await older.create(
        PlanRun.start({
          id: 'R-old',
          planId: 'PLAN-old',
          projectId: 'p-a',
          integrationBranch: 'auto/a',
          reviewer: 'claude',
          stopConditions: STOP,
          featureIds: ['F1'],
          titles: { F1: '旧功能' },
          startedAt: at(0),
        }),
      );
      await older.update((run) => {
        run.startFeature('F1', 'R-old-F1');
        run.openEscalation(
          { featureId: 'F1', missionId: 'R-old-F1', failure: '红', question: '跳过还是重跑？' },
          at(10),
        );
      });
      await older.update((run) => {
        run.choose(
          'E-1',
          { action: 'skip', reason: '今晚不值得', decidedBy: 'claude' },
          at(12),
        );
      });

      const newer = new FilePlanRunStore(join(dir, 'R-new.json'));
      await newer.create(
        PlanRun.start({
          id: 'R-new',
          planId: 'PLAN-new',
          projectId: 'p-b',
          integrationBranch: 'auto/b',
          reviewer: 'claude',
          stopConditions: STOP,
          featureIds: ['F9'],
          startedAt: at(40),
        }),
      );
      writeFileSync(join(dir, 'R-bad.json'), '{not-json', 'utf8');

      const { server, base } = await openApi({ planRunDirs: () => [dir] });
      try {
        const listed = await request(base, '/api/plan-runs');
        assert.equal(listed.status, 200);
        const rows = listed.json as unknown as Array<Record<string, unknown>>;
        assert.ok(Array.isArray(rows));
        assert.equal(rows[0]?.id, 'R-new');
        assert.equal(rows[1]?.id, 'R-old');
        assert.equal(rows[2]?.id, 'R-bad');
        assert.equal(typeof rows[2]?.error, 'string');
        assert.equal(String(rows[2]?.error).includes(dir), false);
        assert.equal(rows[1]?.planId, 'PLAN-old');
        assert.equal(rows[1]?.projectId, 'p-a');
        assert.equal(rows[1]?.integrationBranch, 'auto/a');
        assert.equal(rows[1]?.startedAt, at(0));
        assert.equal(rows[1]?.escalationCount, 1);
        const features = rows[1]?.features as Array<Record<string, unknown>>;
        assert.equal(features[0]?.featureId, 'F1');
        assert.equal(features[0]?.title, '旧功能');
        assert.equal(features[0]?.status, 'skipped');

        const filtered = await request(base, '/api/plan-runs?project=p-a');
        assert.equal(filtered.status, 200);
        const filteredRows = filtered.json as unknown as Array<Record<string, unknown>>;
        assert.ok(filteredRows.some((row) => row.id === 'R-old' && row.projectId === 'p-a'));
        assert.equal(filteredRows.some((row) => row.id === 'R-new' && !row.error), false);
        assert.ok(filteredRows.some((row) => row.id === 'R-bad' && row.error));

        const detail = await request(base, '/api/plan-runs/R-old');
        assert.equal(detail.status, 200);
        const snap = detail.json as {
          id: string;
          escalations: Array<Record<string, unknown>>;
        };
        assert.equal(snap.id, 'R-old');
        assert.equal(snap.escalations.length, 1);
        assert.equal(snap.escalations[0]?.question, '跳过还是重跑？');
        const resolution = snap.escalations[0]?.resolution as Record<string, unknown>;
        assert.equal(resolution.kind, 'decided');
        assert.equal(resolution.action, 'skip');
        assert.equal(resolution.reason, '今晚不值得');
        assert.equal(resolution.decidedBy, 'claude');
        assert.equal(resolution.decidedAt, at(12));

        const missing = await request(base, '/api/plan-runs/no-such');
        assert.equal(missing.status, 404);
        assert.equal(missing.json.error, 'PLAN_RUN_NOT_FOUND');

        const corrupt = await request(base, '/api/plan-runs/R-bad');
        assert.equal(corrupt.status, 409);
        assert.equal(corrupt.json.error, 'PLAN_RUN_CORRUPT');
        assert.equal(String(corrupt.json.message).includes(dir), false);

        const traversal = await request(base, '/api/plan-runs/..%2Fsecret');
        assert.equal(traversal.status, 404);
        assert.equal(String(traversal.json.message ?? '').includes('secret'), false);
        const slash = await request(base, '/api/plan-runs/R-old%2F../R-new');
        assert.notEqual(slash.status, 200);
      } finally {
        await closeServer(server);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('plan-run Mission 带可证实的 planRunId/featureId，普通行其它字段不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-plan-origin-'));
    try {
      const store = new FilePlanRunStore(join(dir, 'R1.json'));
      await store.create(
        PlanRun.start({
          id: 'R1',
          planId: 'PLAN-x',
          projectId: 'P-origin',
          integrationBranch: 'auto/x',
          reviewer: 'claude',
          stopConditions: STOP,
          featureIds: ['F1', 'foo-r2'],
          titles: { F1: '一', 'foo-r2': '易混' },
          startedAt: T0,
        }),
      );
      await store.update((run) => {
        run.startFeature('foo-r2', 'R1-foo-r2');
      });

      const { server, base } = await openApi({ planRunDirs: () => [dir] });
      try {
        const plain = await request(base, '/api/missions', {
          projectId: 'P-origin',
          missionId: 'M-plain',
          contract: CONTRACT,
        });
        assert.equal(plain.status, 201, JSON.stringify(plain.json));
        const fromPlan = await request(base, '/api/missions', {
          projectId: 'P-origin',
          missionId: 'R1-foo-r2',
          contract: CONTRACT,
          origin: { clientType: 'plan-run', conversationRef: 'plan-run:R1' },
        });
        assert.equal(fromPlan.status, 201, JSON.stringify(fromPlan.json));

        const listed = await request(base, '/api/missions');
        assert.equal(listed.status, 200);
        const rows = listed.json as unknown as Array<Record<string, unknown>>;
        const ordinary = rows.find((row) => row.missionId === 'M-plain');
        const sourced = rows.find((row) => row.missionId === 'R1-foo-r2');
        assert.ok(ordinary);
        assert.ok(sourced);
        assert.equal('planRunId' in ordinary, false);
        assert.equal('featureId' in ordinary, false);
        assert.equal(sourced.planRunId, 'R1');
        assert.equal(sourced.featureId, 'foo-r2');

        const ordinaryKeys = Object.keys(ordinary).sort();
        const sourcedRest = { ...sourced };
        delete sourcedRest.planRunId;
        delete sourcedRest.featureId;
        assert.deepEqual(Object.keys(sourcedRest).sort(), ordinaryKeys);
        assert.equal(ordinary.projectId, sourced.projectId);
        assert.equal(ordinary.status, sourced.status);
        assert.equal(ordinary.intent, sourced.intent);
        assert.equal(ordinary.workItems, sourced.workItems);
        assert.equal(ordinary.accepted, sourced.accepted);
        assert.equal(ordinary.openEscalations, sourced.openEscalations);
        assert.equal(ordinary.paused, sourced.paused);
        assert.equal(ordinary.isMutating, sourced.isMutating);
      } finally {
        await closeServer(server);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('只读平台状态与候选健康',
  () => {
    const T0 = '2026-01-01T00:00:00.000Z';
    const T_LEASE = '2026-01-01T01:00:00.000Z';
    const T_EXPIRED = '2026-01-01T00:00:30.000Z';
    const T_NOW = '2026-01-01T00:30:00.000Z';

    test('未装配时身份/队列/占用标不适用，listen 为回环，接口只读',
      async () => {
        const { server, base } = await openApi({
          platformStatus: {
            store: 'memory',
            startedAt: T0,
          },
        });
        try {
          const status = await request(base, '/api/platform/status');
          assert.equal(status.status, 200);
          assert.equal(status.json.api, API_VERSION);
          assert.equal(status.json.pid, process.pid);
          assert.equal(status.json.store, 'memory');
          assert.equal(status.json.startedAt, T0);
          const listen = status.json.listen as { address: string; port: number };
          assert.equal(listen.address, '127.0.0.1');
          assert.ok(listen.port > 0);
          assert.equal((status.json.instanceId as { reason: string }).reason, 'memory_has_no_file_instance_lock');
          assert.equal((status.json.statePath as { reason: string }).reason, 'memory_has_no_state_file');
          assert.equal((status.json.holdsMainLock as { reason: string }).reason, 'memory_has_no_file_main_lock');
          assert.equal((status.json.queue as { reason: string }).reason, 'queued_hops_unavailable');
          assert.equal((status.json.occupancy as { reason: string }).reason, 'queued_hops_unavailable');
          assert.equal((status.json.agentEnv as { inapplicable: boolean }).inapplicable, true);
          assert.equal((status.json.defaultAdapter as { inapplicable: boolean }).inapplicable, true);
          const dumped = JSON.stringify(status.json);
          assert.equal(dumped.includes('COAGENT_AGENT_ENV_PASSTHROUGH'), false);
          assert.equal(Object.hasOwn(status.json, 'token'), false);

          const post = await fetch(`${base}/api/platform/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          assert.ok(post.status === 404 || post.status === 405);
        } finally {
          await closeServer(server);
        }
      },
    );

    test('PG 装配字段不虚构文件锁身份',
      async () => {
        const { server, base } = await openApi({
          platformStatus: { store: 'pg', startedAt: T0, defaultAdapter: 'pi' },
        });
        try {
          const status = await request(base, '/api/platform/status');
          assert.equal(status.status, 200);
          assert.equal(status.json.store, 'pg');
          assert.equal((status.json.instanceId as { reason: string }).reason, 'pg_has_no_file_instance_lock');
          assert.equal((status.json.statePath as { reason: string }).reason, 'pg_has_no_state_file');
          assert.equal((status.json.holdsMainLock as { reason: string }).reason, 'pg_has_no_file_main_lock');
          assert.equal(status.json.defaultAdapter, 'pi');
        } finally {
          await closeServer(server);
        }
      },
    );

    test('状态与池接口在注入 resolver 时走只读鉴权',
      async () => {
        const operator: ControlPrincipal = { id: 'op', role: 'operator' };
        const viewer: ControlPrincipal = { id: 'vw', role: 'viewer' };
        const resolveControlPrincipal: ControlPrincipalResolver = (req) => {
          const raw = req.headers['x-coagent-control'];
          const token = Array.isArray(raw) ? raw[0] : raw;
          if (token === 'op') return operator;
          if (token === 'vw') return viewer;
          if (token === 'expired') return { status: 'expired' };
          return undefined;
        };
        const { server, base } = await openApi({
          resolveControlPrincipal,
          agentPool: new InMemoryAgentPoolRepository(),
          platformStatus: { store: 'memory', startedAt: T0 },
        });
        const gated = async (path: string) => {
          const missing = await fetch(`${base}${path}`);
          assert.equal(missing.status, 401, path);
          const viewerRes = await fetch(`${base}${path}`, { headers: { 'x-coagent-control': 'vw' } });
          assert.equal(viewerRes.status, 200, path);
          const opRes = await fetch(`${base}${path}`, { headers: { 'x-coagent-control': 'op' } });
          assert.equal(opRes.status, 200, path);
        };
        try {
          await gated('/api/platform/status');
          await gated('/api/pools');
        } finally {
          await closeServer(server);
        }
      },
    );

    test('文件队列：空仓、过期租约不占位、死信倒序、五维占用',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'http-platform-status-'));
        try {
          const store = new FileStateStore(join(dir, 'state.json'));
          const clock = new FixedClock(T0);
          const ids = new PersistentIds(store);
          const projects = new FileProjectRepository(store);
          const activity = new FileActivityLog(store, clock);
          const deliveries = new FileDeliveryRepository(store, clock, ids);
          const hops = new FileQueuedHopRepository(store);
          const platform = new Platform({
            projects,
            deliveries,
            activity,
            clock,
            ids,
            transaction: store,
          });
          const server = createApi({
            platform,
            tokens: new RunTokenRegistry(),
            deliveries,
            queuedHops: hops,
            now: () => Date.parse(T_NOW),
            platformStatus: {
              store: 'file',
              startedAt: T0,
              instanceId: 'inst-file',
              statePath: join(dir, 'state.json'),
              holdsMainLock: true,
              agentEnv: {
                passthroughDeclared: true,
                baselineFiltered: true,
                extraPassthroughCount: 0,
              },
              defaultAdapter: 'pi',
            },
          });
          try {
            await listenLoopback(server, 0);
            const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

            const empty = await request(base, '/api/platform/status');
            assert.equal(empty.status, 200);
            assert.equal(empty.json.instanceId, 'inst-file');
            assert.equal(empty.json.statePath, join(dir, 'state.json'));
            assert.equal(empty.json.holdsMainLock, true);
            assert.deepEqual(empty.json.queue, {
              counts: { queued: 0, claimed: 0, completed: 0, retry_wait: 0, dead_letter: 0 },
              deadLetters: [],
            });
            const emptyOcc = empty.json.occupancy as { activeLeases: number; global: number };
            assert.equal(emptyOcc.activeLeases, 0);
            assert.equal(emptyOcc.global, 0);

            await hops.enqueue({
              id: 'h-expired',
              projectId: 'P',
              missionId: 'M',
              workItemId: 'w',
              role: 'executor',
              priority: 1,
              availableAt: T0,
              attemptCount: 0,
              maxAttempts: 3,
              idempotencyKey: 'expired',
              status: 'queued',
              createdAt: T0,
              updatedAt: T0,
            });
            const expired = await hops.claim('h-expired', 'owner', T0, T_EXPIRED);
            assert.equal(expired?.status, 'claimed');

            await hops.enqueue({
              id: 'h-live',
              projectId: 'P1',
              missionId: 'M1',
              workItemId: 'w1',
              role: 'executor',
              priority: 1,
              availableAt: T0,
              attemptCount: 0,
              maxAttempts: 3,
              idempotencyKey: 'live',
              status: 'queued',
              createdAt: T0,
              updatedAt: T0,
            });
            const live = await hops.claimAvailable({
              owner: 'runner',
              now: T0,
              leaseUntil: T_LEASE,
              limits: {
                global: 8,
                project: 2,
                role: 4,
                runtime: 4,
                profile: 2,
              },
              eligible: [{ hopId: 'h-live', runtimeKind: 'pi', profileId: 'exec-qwen' }],
            });
            assert.equal(live.kind, 'claimed');

            await hops.enqueue({
              id: 'h-dead-old',
              projectId: 'P',
              missionId: 'M-old',
              workItemId: 'w',
              role: 'executor',
              priority: 1,
              availableAt: T0,
              attemptCount: 0,
              maxAttempts: 1,
              idempotencyKey: 'dead-old',
              status: 'queued',
              createdAt: T0,
              updatedAt: T0,
            });
            await hops.claim('h-dead-old', 'owner', T0, T_LEASE);
            await hops.reportFailure?.({
              id: 'h-dead-old',
              claimGeneration: 1,
              attemptId: 'a-old',
              failedAt: '2026-01-01T00:10:00.000Z',
              classification: 'auth',
              disposition: 'dead',
              retryable: false,
            });

            await hops.enqueue({
              id: 'h-dead-new',
              projectId: 'P',
              missionId: 'M-new',
              workItemId: 'w',
              role: 'coordinator',
              priority: 1,
              availableAt: T0,
              attemptCount: 0,
              maxAttempts: 1,
              idempotencyKey: 'dead-new',
              status: 'queued',
              createdAt: T0,
              updatedAt: T0,
            });
            await hops.claim('h-dead-new', 'owner', T0, T_LEASE);
            await hops.reportFailure?.({
              id: 'h-dead-new',
              claimGeneration: 1,
              attemptId: 'a-new',
              failedAt: '2026-01-01T00:20:00.000Z',
              classification: 'quota',
              disposition: 'dead',
              retryable: false,
            });

            const filled = await request(base, '/api/platform/status');
            assert.equal(filled.status, 200);
            const counts = (filled.json.queue as { counts: Record<string, number> }).counts;
            assert.equal(counts.claimed, 2, JSON.stringify(counts));
            assert.equal(counts.dead_letter, 2);
            const dead = (filled.json.queue as { deadLetters: Array<{ hopId: string; classification: string }> }).deadLetters;
            assert.deepEqual(dead.map((row) => row.hopId), ['h-dead-new', 'h-dead-old']);
            assert.equal(dead[0]?.classification, 'quota');
            const occ = filled.json.occupancy as {
              activeLeases: number;
              global: number;
              project: Record<string, number>;
              role: Record<string, number>;
              runtime: Record<string, number>;
              profile: Record<string, number>;
            };
            assert.equal(occ.activeLeases, 1);
            assert.equal(occ.global, 1);
            assert.equal(occ.project.P1, 1);
            assert.equal(occ.role.executor, 1);
            assert.equal(occ.runtime.pi, 1);
            assert.equal(occ.profile['exec-qwen'], 1);
            assert.equal(occ.project.P, undefined, 'expired lease must not occupy');
          } finally {
            await closeServer(server);
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    test('资源池每个候选带熔断、失败口径与七日用量；POST 语义不变',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'http-pool-health-'));
        try {
          const store = new FileStateStore(join(dir, 'state.json'));
          const clock = new FixedClock(T0);
          const ids = new PersistentIds(store);
          const projects = new FileProjectRepository(store);
          const activity = new FileActivityLog(store, clock);
          const deliveries = new FileDeliveryRepository(store, clock, ids);
          const hops = new FileQueuedHopRepository(store);
          const circuits = new FileCandidateCircuitRepository(store);
          const agentPool = new FileAgentPoolRepository(store);
          const platform = new Platform({
            projects,
            deliveries,
            activity,
            clock,
            ids,
            transaction: store,
          });
          await agentPool.add({ role: 'executor', profileId: 'exec-qwen', endpoint: 'local' });
          await agentPool.add({ role: 'executor', profileId: 'exec-idle', endpoint: 'local' });
          await circuits.open({
            profileId: 'exec-qwen',
            failureClass: 'quota',
            openUntil: '2026-01-02T00:00:00.000Z',
          });
          await platform.createMission({
            projectId: 'P',
            missionId: 'M-usage',
            contract: CONTRACT,
          });
          const started = await platform.startCoordinatorAttempt('M-usage', {
            profileId: 'exec-qwen',
            endpoint: 'local',
          });
          await platform.finishAttempt('M-usage', started.attemptId, {
            endedBy: 'upstream_failure',
            failureMessage: 'HTTP 429 quota exceeded',
            usage: {
              input: 10,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              total: 12,
              cost: 1.25,
              quality: 'reported',
            },
          });
          const server = createApi({
            platform,
            tokens: new RunTokenRegistry(),
            deliveries,
            agentPool,
            queuedHops: hops,
            candidateCircuits: circuits,
            now: () => Date.parse('2026-01-02T00:00:00.000Z'),
          });
          try {
            await listenLoopback(server, 0);
            const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            const list = await request(base, '/api/pools');
            assert.equal(list.status, 200);
            const snapshot = list.json as {
              executor: Array<{
                profileId: string;
                endpoint: string;
                runtime: string;
                order: number;
                facts: unknown[];
                role?: string;
                health: {
                  circuit: { state: string; failureClass?: string; openUntil?: string };
                  lastFailure: { failureClass: string; at: string | null; source: string };
                  window7d: { attempts: number; successes: number; reportedCost: number | null };
                  runtime: { running: boolean; reason?: string };
                };
              }>;
            };
            const qwen = snapshot.executor.find((row) => row.profileId === 'exec-qwen');
            const idle = snapshot.executor.find((row) => row.profileId === 'exec-idle');
            assert.ok(qwen);
            assert.ok(idle);
            assert.equal(qwen.role, undefined);
            assert.equal(qwen.runtime, 'pi');
            assert.equal(qwen.health.circuit.state, 'open');
            assert.equal(qwen.health.circuit.failureClass, 'quota');
            assert.equal(qwen.health.lastFailure.failureClass, 'quota');
            assert.equal(qwen.health.lastFailure.source, 'attempt.ended');
            assert.equal(qwen.health.window7d.attempts, 1);
            assert.equal(qwen.health.window7d.successes, 0);
            assert.equal(qwen.health.window7d.reportedCost, 1.25);
            assert.equal(qwen.health.runtime.running, false);
            assert.equal(qwen.health.runtime.reason, 'no_active_lease');
            assert.equal(idle.health.circuit.state, 'closed');
            assert.equal(idle.health.lastFailure.failureClass, 'unknown');
            assert.equal(idle.health.lastFailure.at, null);
            assert.equal(idle.health.window7d.attempts, 0);
            assert.equal(idle.health.window7d.reportedCost, null);
            assert.equal(idle.health.runtime.reason, 'no_active_lease');

            const created = await request(base, '/api/pools', {
              role: 'coordinator',
              profileId: 'coord-new',
              endpoint: 'local',
            });
            assert.equal(created.status, 201);
            assert.equal(created.json.role, 'coordinator');
            assert.equal(created.json.profileId, 'coord-new');
            assert.equal(created.json.runtime, 'pi');
            assert.equal(created.json.order, 0);
          } finally {
            await closeServer(server);
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  },
);
