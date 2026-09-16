/**
 * HTTP 面的端到端：走真实的 node:http，不 mock。
 *
 * 重点不是路由拼对了没有，是**身份不能靠调用方自述** —— 执行者拿着自己的
 * run token 去调协调者的工具，必须被挡。
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform } from '../src/application/platform.ts';

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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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
      token: execToken,
    });

    // 吊销之后迟到的调用必须被拒绝。
    const late = await call('/api/agent/coagent_submit_evidence', { kind: 'test', summary: '迟到' }, execToken);
    assert.equal(late.status, 401);

    const reviewed = await call(
      '/api/agent/coagent_review_execution_result',
      { workItemId, verdict: 'accept', reasons: ['自己跑过 node --test'], requiredChanges: [] },
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
});
