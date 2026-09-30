/**
 * 控制面可选鉴权：注入 resolver 时，敏感读允许 viewer/operator，写操作只允许 operator。
 * 不注入时行为与既有 api.test 一致。
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
import { listenLoopback } from '../src/application/loopback-listen.ts';

const OPERATOR: ControlPrincipal = { id: 'op-1', role: 'operator' };
const VIEWER: ControlPrincipal = { id: 'vw-1', role: 'viewer' };
const OP_TOKEN = 'operator-token';
const VW_TOKEN = 'viewer-token';
const EXPIRED_TOKEN = 'expired-token';
const BAD_ROLE_TOKEN = 'bad-role-token';

const resolveFromHeader: ControlPrincipalResolver = (req: IncomingMessage) => {
  const raw = req.headers['x-coagent-control'];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (token === OP_TOKEN) return OPERATOR;
  if (token === VW_TOKEN) return VIEWER;
  if (token === EXPIRED_TOKEN) return { status: 'expired' };
  if (token === BAD_ROLE_TOKEN) {
    // 模拟 resolver 边界收到未来/畸形角色：服务端必须 fail-closed，而不是默认放行。
    return { id: 'bad-1', role: 'auditor' } as unknown as ControlPrincipal;
  }
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
  await listenLoopback(server, 0);
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

async function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    /* non-json */
  }
  return { status: res.status, json, text };
}

function assertNoCredentialEcho(text: string): void {
  for (const token of [OP_TOKEN, VW_TOKEN, EXPIRED_TOKEN, BAD_ROLE_TOKEN, 'no-such-token']) {
    assert.equal(text.includes(token), false, `response must not echo ${token}`);
  }
}

/** 同一路由：missing/unknown/expired 401，viewer/异常角色 403；不回显 token。 */
async function assertWriteGate(path: string, body: unknown = {}): Promise<void> {
  const missing = await post(path, body);
  assert.equal(missing.status, 401, `${path} missing → 401`);
  assert.equal(missing.json.error, 'CONTROL_UNAUTHORIZED');
  assertNoCredentialEcho(missing.text);

  const unknown = await post(path, body, control('no-such-token'));
  assert.equal(unknown.status, 401, `${path} unknown → 401`);
  assert.equal(unknown.json.error, 'CONTROL_UNAUTHORIZED');
  assertNoCredentialEcho(unknown.text);

  const expired = await post(path, body, control(EXPIRED_TOKEN));
  assert.equal(expired.status, 401, `${path} expired → 401`);
  assert.equal(expired.json.error, 'CONTROL_EXPIRED');
  assertNoCredentialEcho(expired.text);

  const viewer = await post(path, body, control(VW_TOKEN));
  assert.equal(viewer.status, 403, `${path} viewer → 403`);
  assert.equal(viewer.json.error, 'CONTROL_FORBIDDEN');
  assertNoCredentialEcho(viewer.text);

  const badRole = await post(path, body, control(BAD_ROLE_TOKEN));
  assert.equal(badRole.status, 403, `${path} unsupported role → 403`);
  assert.equal(badRole.json.error, 'CONTROL_FORBIDDEN');
  assertNoCredentialEcho(badRole.text);
}

/** 敏感读：missing/unknown/expired 拒绝，畸形角色 403，viewer 为正常读凭据。 */
async function assertReadGate(path: string): Promise<void> {
  const missing = await get(path);
  assert.equal(missing.status, 401, `${path} missing → 401`);
  assert.equal((missing.json as Record<string, unknown>).error, 'CONTROL_UNAUTHORIZED');
  assertNoCredentialEcho(missing.text);

  const unknown = await get(path, control('no-such-token'));
  assert.equal(unknown.status, 401, `${path} unknown → 401`);
  assert.equal((unknown.json as Record<string, unknown>).error, 'CONTROL_UNAUTHORIZED');
  assertNoCredentialEcho(unknown.text);

  const expired = await get(path, control(EXPIRED_TOKEN));
  assert.equal(expired.status, 401, `${path} expired → 401`);
  assert.equal((expired.json as Record<string, unknown>).error, 'CONTROL_EXPIRED');
  assertNoCredentialEcho(expired.text);

  const badRole = await get(path, control(BAD_ROLE_TOKEN));
  assert.equal(badRole.status, 403, `${path} unsupported role → 403`);
  assert.equal((badRole.json as Record<string, unknown>).error, 'CONTROL_FORBIDDEN');
  assertNoCredentialEcho(badRole.text);

  const viewer = await get(path, control(VW_TOKEN));
  assert.equal(viewer.status, 200, `${path} viewer → 200`);
  assertNoCredentialEcho(viewer.text);
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

  test('POST /api/missions/classified：无/未知 401，viewer 403，operator 可达', async () => {
    const body = {
      projectId: 'P-auth',
      missionId: 'M-cls-gate',
      contract: CONTRACT,
      facts: {
        mutationSideEffect: true,
        readOnlyProven: false,
        highAssurance: {
          productionDeployRelease: false,
          externalPaidOp: false,
          destructiveData: false,
          credentialsPermissionsSecurity: false,
          schemaPublicApiPersistenceCompat: false,
          unrecoverableExternalSideEffect: false,
        },
        standardFloor: {
          publicInterface: false,
          buildSystemOrDependency: false,
          multipleDomainModules: false,
          acceptanceNotCheckableUpfront: false,
          rootCauseOrCompetingDesigns: false,
        },
      },
      assessment: {
        goalUncertainty: 1,
        changeScope: 1,
        operationalRisk: 1,
        verificationDifficulty: 1,
        coordinationNeed: 0,
        recoveryDifficulty: 0,
        reasons: ['auth'],
        decidedBy: 'rule',
        assessedAt: '2026-01-01T00:00:00.000Z',
      },
      workOrder: {
        objective: 'auth classified',
        allowedScope: ['src/x.ts'],
        requiredBehaviour: 'ok',
        constraints: [],
        acceptance: ['ok'],
        verification: [],
        doNot: [],
        contextRefs: [],
      },
    };
    await assertWriteGate('/api/missions/classified', body);

    const ok = await post('/api/missions/classified', body, control(OP_TOKEN));
    // auth 放行后业务应成功（201），绝不是 401/403
    assert.equal(ok.status, 201);
    assert.equal(ok.json.missionId, 'M-cls-gate');
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

  test('agent 工具与 run brief 仍只认 run token；control token 不能替代', async () => {
    const noRun = await post('/api/agent/coagent_get_mission', {}, control(OP_TOKEN));
    assert.equal(noRun.status, 401);
    assert.equal(noRun.json.error, 'UNKNOWN_RUN_TOKEN');

    const bare = await post('/api/agent/coagent_get_mission', {});
    assert.equal(bare.status, 401);
    assert.equal(bare.json.error, 'UNKNOWN_RUN_TOKEN');

    const briefWithControl = await get('/api/run/brief', control(OP_TOKEN));
    assert.equal(briefWithControl.status, 401);
    assert.equal(
      (briefWithControl.json as Record<string, unknown>).error,
      'UNKNOWN_RUN_TOKEN',
    );
  });

  test('敏感读逐端点要求 control read；viewer 正常读取，operator 也可读', async () => {
    const created = await post(
      '/api/missions',
      { projectId: 'P-auth-read', missionId: 'M-auth-read', contract: CONTRACT },
      control(OP_TOKEN),
    );
    assert.equal(created.status, 201);

    const coord = await post(
      '/api/missions/M-auth-read/coordinator-attempts',
      {},
      control(OP_TOKEN),
    );
    assert.equal(coord.status, 201);
    const attemptId = coord.json.attemptId as string;
    const runToken = coord.json.token as string;

    const sensitive = [
      '/api/usage',
      '/api/runtime/models',
      '/api/projects',
      '/api/pools',
      '/api/missions',
      '/api/missions/M-auth-read',
      '/api/missions/M-auth-read/activity',
      '/api/missions/M-auth-read/live?cursor=0',
      `/api/missions/M-auth-read/attempts/${attemptId}`,
      '/api/missions/M-auth-read/diff',
      '/api/inbox',
    ];
    for (const path of sensitive) await assertReadGate(path);

    const operatorRead = await get('/api/missions/M-auth-read', control(OP_TOKEN));
    assert.equal(operatorRead.status, 200);

    // Run Token 路径与 control auth 正交：没有 control token 也可凭有效 run token 读取。
    const brief = await get('/api/run/brief', { 'x-coagent-run': runToken });
    assert.equal(brief.status, 200);
  });

  test('Inbox acknowledge 属控制写：非 operator 被挡，operator 才进入业务层', async () => {
    await assertWriteGate('/api/deliveries/no-such-delivery/ack');

    const operator = await post(
      '/api/deliveries/no-such-delivery/ack',
      {},
      control(OP_TOKEN),
    );
    assert.equal(operator.status, 404);
    assert.notEqual(operator.json.error, 'CONTROL_UNAUTHORIZED');
    assert.notEqual(operator.json.error, 'CONTROL_EXPIRED');
    assert.notEqual(operator.json.error, 'CONTROL_FORBIDDEN');
  });

  test('请求体自述 operator 不能代替控制头；错误体不回显凭据', async () => {
    const missing = await post('/api/missions', {
      projectId: 'P-auth',
      missionId: 'M-spoof-body',
      contract: CONTRACT,
      role: 'operator',
      id: 'op-1',
    });
    assert.equal(missing.status, 401);
    assert.equal(missing.json.error, 'CONTROL_UNAUTHORIZED');
    assertNoCredentialEcho(missing.text);

    const viewerSpoof = await post(
      '/api/missions',
      {
        projectId: 'P-auth',
        missionId: 'M-spoof-viewer',
        contract: CONTRACT,
        role: 'operator',
      },
      control(VW_TOKEN),
    );
    assert.equal(viewerSpoof.status, 403);
    assert.equal(viewerSpoof.json.error, 'CONTROL_FORBIDDEN');
    assertNoCredentialEcho(viewerSpoof.text);
  });

  test('health/version 保持公开，不因注入 control resolver 改变', async () => {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);

    const version = await fetch(`${base}/api/version`);
    assert.equal(version.status, 200);
  });
});

describe('默认不注入 resolver', () => {
  test('无 resolveControlPrincipal 时读写路由都保持历史免 control 凭据行为', async () => {
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
    await listenLoopback(plain, 0);
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

      const missions = await fetch(`${plainBase}/api/missions`);
      assert.equal(missions.status, 200);
    } finally {
      plain.close();
    }
  });
});
