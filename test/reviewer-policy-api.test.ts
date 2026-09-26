/**
 * E2：独立检视 HTTP 路径。验收 3、6、7。真 createApi、真 token。
 * 不替换 process.stdout.write。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApi } from '../src/api/server.ts';
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
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import type { MissionContract, ValidationReport, WorkOrder } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: 'HA HTTP 夹具',
  acceptance: ['证据齐'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
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

const REPORT: ValidationReport = {
  id: 'VR-1',
  policyRevision: 1,
  missionId: 'M-ha',
  workItemId: 'W-1',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:00:01.000Z',
  passed: true,
  checks: [],
};

const servers: Server[] = [];
const temps: string[] = [];

after(() => {
  for (const server of servers) server.close();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

async function agent(
  base: string,
  tool: string,
  token: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/agent/${tool}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-coagent-run': token,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function setup() {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const projects = new InMemoryProjectRepository();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const reports = new InMemoryValidationReportRepository();
  const pool = new InMemoryAgentPoolRepository();
  const tokens = new RunTokenRegistry();
  const platform = new Platform({
    projects,
    deliveries,
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
    workspace: new InPlaceWorkspaceManager(),
    validation: {
      engine: {
        async validate() {
          throw new Error('E2 HTTP 测试不跑 ValidationEngine');
        },
      },
      reports,
    },
  });
  await pool.add({
    role: 'independent_reviewer',
    profileId: 'ir-a',
    endpoint: 'local',
  });
  const root = mkdtempSync(join(tmpdir(), 'coagent-e2-http-'));
  temps.push(root);

  const seed = async (missionId: string, projectId: string) => {
    const project = await projects.ensure(projectId);
    const mission = project.createMission({
      id: missionId,
      contract: CONTRACT,
      executionMode: 'high_assurance',
    });
    mission.startExecuting();
    const coord = mission.startCoordinatorAttempt();
    coord.recordProfile({ profileId: `coord-${missionId}`, endpoint: 'local' });
    coord.succeed();
    const item = mission.createWorkItem({ id: `${missionId}-W`, title: '改 foo', order: ORDER });
    item.dispatch();
    const exec = item.startAttempt();
    exec.recordProfile({ profileId: `exec-${missionId}`, endpoint: 'local' });
    exec.succeed();
    item.submit(
      {
        outcome: 'completed',
        summary: 'ok',
        changedFiles: ['src/foo.ts'],
        evidenceIds: [],
        notes: '',
      },
      exec.id,
    );
    item.review('accept', {
      attemptId: coord.id,
      submittedAttemptId: exec.id,
      reasons: ['ok'],
      requiredChanges: [],
      acceptanceResults: ORDER.acceptance.map((criterion) => ({
        criterion,
        status: 'pass',
        evidence: 'node --test 退出码 0',
      })),
      authority: { kind: 'validator', reportId: `VR-${missionId}`, policyRevision: 1 },
    });
    mission.recordResult({
      outcome: 'delivered',
      summary: '交付',
      acceptanceEvidence: ['ok'],
      memoryDelta: [],
      openRisks: [],
    });
    mission.submitForReview();
    mission.recordWorkspace({
      projectRoot: root,
      branch: `mission/${missionId}`,
      baseRevision: 'base',
    });
    await reports.save({
      ...REPORT,
      id: `VR-${missionId}`,
      missionId,
      workItemId: `${missionId}-W`,
    });
    await projects.save(project);
  };

  await seed('M-ha', 'P');
  await seed('M-other', 'P-other');

  const server = createApi({ platform, tokens, deliveries, agentPool: pool });
  await listenLoopback(server, 0);
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, tokens, platform };
}

describe('独立检视 HTTP', () => {
  test('验收3：bundle 只回本 Mission 的 revision / HEAD / L2 / 报告引用；请求体 {}', async () => {
    const { base } = await setup();
    const opened = await fetch(`${base}/api/missions/M-ha/independent-reviewer-attempts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(opened.status, 201);
    const { token, attemptId } = (await opened.json()) as {
      token: string;
      attemptId: string;
    };
    assert.ok(attemptId.startsWith('indrev-'));

    const bundle = await agent(base, 'coagent_get_mission_review_bundle', token, {
      missionId: 'M-other',
      role: 'coordinator',
    });
    assert.equal(bundle.status, 200);
    assert.equal(bundle.json.missionId, 'M-ha');
    assert.equal(bundle.json.contractRevision, 1);
    assert.equal(typeof bundle.json.reviewedCommit, 'string');
    assert.ok(Array.isArray(bundle.json.l2ItemResults));
    assert.ok(Array.isArray(bundle.json.validationReportRefs));
    const refs = bundle.json.validationReportRefs as { id: string }[];
    assert.ok(refs.some((row) => row.id === 'VR-M-ha'));
    assert.equal('workItems' in bundle.json, false);
    assert.equal('plan' in bundle.json, false);
  });

  test('验收3/7：L2、L1、finalize 被明确拒绝', async () => {
    const { base } = await setup();
    const opened = await fetch(`${base}/api/missions/M-ha/independent-reviewer-attempts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const { token } = (await opened.json()) as { token: string };

    const plan = await agent(base, 'coagent_update_plan', token, {
      findings: 'x',
      rejectedHypotheses: [],
      decisions: [],
      direction: 'd',
      risks: [],
    });
    assert.equal(plan.status, 403);
    assert.equal(plan.json.error, 'ACTION_DENIED');

    const order = await agent(base, 'coagent_get_work_order', token, {});
    assert.equal(order.status, 403);
    assert.equal(order.json.error, 'ACTION_DENIED');

    const fin = await fetch(`${base}/api/missions/M-ha/finalize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-coagent-run': token,
      },
      body: JSON.stringify({ verdict: 'approve', reasons: ['no'] }),
    });
    const finJson = (await fin.json()) as { error: string };
    assert.equal(fin.status, 403);
    assert.equal(finJson.error, 'ACTION_DENIED');
  });

  test('验收6：请求体伪造 role/missionId/attemptId 不被采信；吊销后 401；错 Mission token 写不进本 Mission', async () => {
    const { base, platform } = await setup();
    const a = await fetch(`${base}/api/missions/M-ha/independent-reviewer-attempts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const { token: tokenA, attemptId: attemptA } = (await a.json()) as {
      token: string;
      attemptId: string;
    };
    const b = await fetch(`${base}/api/missions/M-other/independent-reviewer-attempts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const { token: tokenB } = (await b.json()) as { token: string };

    const forged = await agent(base, 'coagent_submit_independent_review', tokenA, {
      verdict: 'send_back',
      reasons: ['伪造身份也不该换绑'],
      role: 'coordinator',
      missionId: 'M-other',
      attemptId: 'coord-1',
    });
    assert.equal(forged.status, 200);
    const viewA = await platform.getMissionView('M-ha');
    assert.equal(viewA.independentReviews[0]?.reviewerAttemptId, attemptA);
    assert.equal(viewA.independentReviews[0]?.verdict, 'send_back');
    const viewB = await platform.getMissionView('M-other');
    assert.equal(viewB.independentReviews.length, 0);

    const cross = await agent(base, 'coagent_submit_independent_review', tokenB, {
      verdict: 'pass',
      reasons: ['想写到 M-ha'],
    });
    // tokenB 绑的是 M-other：即使想 pass，也只可能落在 M-other，且缺本 Mission 对照。
    assert.ok(cross.status === 409 || cross.status === 200);
    const stillA = await platform.getMissionView('M-ha');
    assert.equal(stillA.independentReviews.length, 1);
    assert.equal(stillA.independentReviews[0]?.verdict, 'send_back');

    await fetch(`${base}/api/missions/M-ha/attempts/${attemptA}/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endedBy: 'structured_submit' }),
    });
    const late = await agent(base, 'coagent_submit_independent_review', tokenA, {
      verdict: 'pass',
      reasons: ['吊销后还想交'],
    });
    assert.equal(late.status, 401);
    assert.equal(late.json.error, 'UNKNOWN_RUN_TOKEN');
  });
});
