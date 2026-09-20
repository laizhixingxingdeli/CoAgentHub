/**
 * 控制面可选鉴权：注入 resolver 时，受保护写路由按 Principal 角色放行/拒绝。
 * 不注入时行为与既有 api.test 一致（本文件只覆盖注入路径）。
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';

import { createApi } from '../src/api/server.ts';
import type { ControlPrincipal, ControlPrincipalResolver } from '../src/api/control-auth.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { InMemoryAgentPoolRepository } from '../src/application/agent-pool.ts';
import { Platform } from '../src/application/platform.ts';

const OPERATOR: ControlPrincipal = { id: 'op-1', role: 'operator' };
const VIEWER: ControlPrincipal = { id: 'vw-1', role: 'viewer' };
const OP_TOKEN = 'operator-token';
const VW_TOKEN = 'viewer-token';

const resolveFromHeader: ControlPrincipalResolver = (req: IncomingMessage) => {
  const raw = req.headers['x-coagent-control'];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (token === OP_TOKEN) return OPERATOR;
  if (token === VW_TOKEN) return VIEWER;
  return undefined;
};

const CONTRACT = {
  intent: 'auth slice',
  acceptance: ['ok'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

let base: string;
let server: ReturnType<typeof createApi>;
let tokens: RunTokenRegistry;

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
  tokens = new RunTokenRegistry();
  server = createApi({
    platform,
    tokens,
    deliveries,
    agentPool: new InMemoryAgentPoolRepository(),
    resolveControlPrincipal: resolveFromHeader,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

async function post(
  path: string,
  body: unknown = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-json */
  }
  return { status: res.status, json, text };
}

function control(token?: string): Record<string, string> {
  return token ? { 'x-coagent-control': token } : {};
}

/** 同一路由：无凭据 401、未知 401、viewer 403；不把 token 回显。 */
async function assertWriteGate(path: string, body: unknown = {}): Promise<void> {
  const missing = await post(path, body);
  assert.equal(missing.status, 401, `${path} missing → 401`);
  assert.equal(missing.json.error, 'CONTROL_UNAUTHORIZED');
  assert.equal(missing.text.includes(OP_TOKEN), false);
  assert.equal(missing.text.includes(VW_TOKEN), false);

  const unknown = await post(path, body, control('no-such-token'));
  assert.equal(unknown.status, 401, `${path} unknown → 401`);
  assert.equal(unknown.json.error, 'CONTROL_UNAUTHORIZED');
  assert.equal(unknown.text.includes('no-such-token'), false);

  const viewer = await post(path, body, control(VW_TOKEN));
  assert.equal(viewer.status, 403, `${path} viewer → 403`);
  assert.equal(viewer.json.error, 'CONTROL_FORBIDDEN');
  assert.equal(viewer.text.includes(VW_TOKEN), false);
}

describe('控制面鉴权骨架', () => {
  test('POST /api/missions：无/未知 401，viewer 403，operator 201', async () => {
    await assertWriteGate('/api/missions', {
      projectId: 'P-auth',
      missionId: 'M-gate',
      contract: CONTRACT,
    });

    const ok = await post(
      '/api/missions',
      { projectId: 'P-auth', missionId: 'M-op', contract: CONTRACT },
      control(OP_TOKEN),
    );
    assert.equal(ok.status, 201);
  });

  test('contract / pause-cancel-resume / finalize / escalation answer 门禁', async () => {
    const created = await post(
      '/api/missions',
      { projectId: 'P-auth', missionId: 'M-ctrl', contract: CONTRACT },
      control(OP_TOKEN),
    );
    assert.equal(created.status, 201);

    await assertWriteGate('/api/missions/M-ctrl/contract', {
      intent: 'revised',
      acceptance: ['ok'],
      constraints: [],
      nonGoals: [],
      guardrails: [],
    });
    await assertWriteGate('/api/missions/M-ctrl/pause', {});
    await assertWriteGate('/api/missions/M-ctrl/resume', {});
    await assertWriteGate('/api/missions/M-ctrl/cancel', { reason: 'stop' });
    await assertWriteGate('/api/missions/M-ctrl/finalize', {
      decision: 'accept',
      note: 'n',
    });
    await assertWriteGate('/api/missions/M-ctrl/escalations/answer', { answer: 'go' });

    // operator 不被 auth 层阻断（业务层可能另有 409，但绝不是 401/403）
    const revise = await post(
      '/api/missions/M-ctrl/contract',
      {
        intent: 'revised by op',
        acceptance: ['ok'],
        constraints: [],
        nonGoals: [],
        guardrails: [],
      },
      control(OP_TOKEN),
    );
    assert.notEqual(revise.status, 401);
    assert.notEqual(revise.status, 403);

    const pause = await post('/api/missions/M-ctrl/pause', {}, control(OP_TOKEN));
    assert.notEqual(pause.status, 401);
    assert.notEqual(pause.status, 403);
  });

  test('coordinator/executor attempt start 与 finish 门禁', async () => {
    const created = await post(
      '/api/missions',
      { projectId: 'P-auth', missionId: 'M-att', contract: CONTRACT },
      control(OP_TOKEN),
    );
    assert.equal(created.status, 201);

    await assertWriteGate('/api/missions/M-att/coordinator-attempts', {});
    await assertWriteGate('/api/missions/M-att/work-items/W-x/executor-attempts', {});
    await assertWriteGate('/api/missions/M-att/attempts/a1/finish', {
      endedBy: 'structured_submit',
    });

    const coord = await post('/api/missions/M-att/coordinator-attempts', {}, control(OP_TOKEN));
    assert.equal(coord.status, 201);
    const attemptId = coord.json.attemptId as string;
    const runToken = coord.json.token as string;
    assert.equal(typeof runToken, 'string');

    const finish = await post(
      `/api/missions/M-att/attempts/${attemptId}/finish`,
      { endedBy: 'structured_submit', token: runToken },
      control(OP_TOKEN),
    );
    assert.notEqual(finish.status, 401);
    assert.notEqual(finish.status, 403);
  });

  test('POST /api/pools：无/未知 401，viewer 403，operator 201', async () => {
    await assertWriteGate('/api/pools', {
      role: 'coordinator',
      profileId: 'p-auth',
      endpoint: 'local',
    });

    const ok = await post(
      '/api/pools',
      { role: 'executor', profileId: 'e-auth', endpoint: 'local' },
      control(OP_TOKEN),
    );
    assert.equal(ok.status, 201);
  });

  test('agent 工具仍要 run token；control token 不能替代', async () => {
    const noRun = await post('/api/agent/coagent_get_mission', {}, control(OP_TOKEN));
    assert.equal(noRun.status, 401);
    assert.equal(noRun.json.error, 'UNKNOWN_RUN_TOKEN');

    const bare = await post('/api/agent/coagent_get_mission', {});
    assert.equal(bare.status, 401);
    assert.equal(bare.json.error, 'UNKNOWN_RUN_TOKEN');
  });

  test('未保护读路径在注入 resolver 时仍可匿名读', async () => {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);

    const version = await fetch(`${base}/api/version`);
    assert.equal(version.status, 200);

    const missions = await fetch(`${base}/api/missions`);
    assert.equal(missions.status, 200);

    const pools = await fetch(`${base}/api/pools`);
    assert.equal(pools.status, 200);
  });
});

describe('默认不注入 resolver', () => {
  test('无 resolveControlPrincipal 时写路由不要求控制凭据', async () => {
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
    const plain = createApi({
      platform,
      tokens: new RunTokenRegistry(),
      deliveries,
    });
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    const plainBase = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${plainBase}/api/missions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: 'P',
          missionId: 'M-plain',
          contract: CONTRACT,
        }),
      });
      assert.equal(res.status, 201);
    } finally {
      plain.close();
    }
  });
});
