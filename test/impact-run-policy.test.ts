/**
 * impact Run 的可信发牌与 HTTP fail-closed 只读边界。
 *
 * 两条组合测试：一条管发牌（不可从 HTTP 自述激活），一条管真实 HTTP 权限路径
 * （impact 牌只能读、且写完之前就被挡，不留副作用）。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { createApi } from '../src/api/server.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import {
  FileActivityLog,
  FileDeliveryRepository,
  FileProjectRepository,
  FileQueuedHopRepository,
  FileStateStore,
  PersistentIds,
} from '../src/application/file-store.ts';
import { FixedClock } from '../src/application/in-memory.ts';
import { Platform, type QueueClaimIdentity } from '../src/application/platform.ts';

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

const NOW = '2025-01-01T00:00:00Z';
const LEASE = '2025-01-01T00:00:10Z';
const ORIGIN = { clientType: 'cli' as const, conversationRef: 'me' };

const CLAIM: QueueClaimIdentity = { id: 'h1', owner: 'owner', claimGeneration: 1 };

/** 发牌错误必须落在 randomUUID / 入表之前，所以每条都只验「抛了」。 */
const BAD_ISSUES: readonly { name: string; input: Record<string, unknown> }[] = [
  { name: '有 purpose 无 changeId', input: { purpose: 'impact' } },
  { name: '有 changeId 无 purpose', input: { changeId: 'chg-1' } },
  { name: 'changeId 空白', input: { purpose: 'impact', changeId: '   ' } },
  { name: '非 coordinator', input: { purpose: 'impact', changeId: 'chg-1', role: 'executor' } },
  { name: '无 claim', input: { purpose: 'impact', changeId: 'chg-1', noClaim: true } },
  { name: 'claim id 空白', input: { purpose: 'impact', changeId: 'chg-1', claim: { ...CLAIM, id: ' ' } } },
  { name: 'claim owner 空白', input: { purpose: 'impact', changeId: 'chg-1', claim: { ...CLAIM, owner: '' } } },
  { name: 'claimGeneration 为 0', input: { purpose: 'impact', changeId: 'chg-1', claim: { ...CLAIM, claimGeneration: 0 } } },
  { name: 'claimGeneration 非整数', input: { purpose: 'impact', changeId: 'chg-1', claim: { ...CLAIM, claimGeneration: 1.5 } } },
];

function issueInput(row: Record<string, unknown>): Record<string, unknown> {
  const { noClaim, ...rest } = row;
  return {
    missionId: 'M',
    attemptId: 'A1',
    role: 'coordinator',
    ...(noClaim === true ? {} : { claim: CLAIM }),
    ...rest,
  };
}

describe('impact Run 发牌与 HTTP 只读边界', () => {
  test('issue 只接受可信配对的 impact 牌，并冻结字段；普通牌与生命周期不变', () => {
    const tokens = new RunTokenRegistry();

    for (const row of BAD_ISSUES) {
      assert.throws(
        () => tokens.issue(issueInput(row.input) as never),
        undefined,
        `${row.name} 必须拒绝签发`,
      );
    }

    // 调用方事后改 claim 不影响已发的 impact 牌。
    const mutable = { id: 'h1', owner: 'owner', claimGeneration: 1 };
    const impact = tokens.issue({
      missionId: 'M',
      attemptId: 'A1',
      role: 'coordinator',
      claim: mutable,
      purpose: 'impact',
      changeId: 'chg-1',
    });
    mutable.owner = 'intruder';
    mutable.claimGeneration = 99;
    const resolved = tokens.resolve(impact.token);
    assert.equal(resolved?.purpose, 'impact');
    assert.equal(resolved?.changeId, 'chg-1');
    assert.deepEqual(resolved?.claim, { id: 'h1', owner: 'owner', claimGeneration: 1 });
    assert.equal(Object.isFrozen(resolved?.claim), true);
    assert.equal(Object.isFrozen(resolved), true);

    // 普通缺省牌：不带 purpose / changeId，claim 形状与旧语义一致。
    const plain = tokens.issue({ missionId: 'M', attemptId: 'A2', role: 'coordinator' });
    assert.equal(plain.purpose, undefined);
    assert.equal(plain.changeId, undefined);
    assert.equal(plain.claim, undefined);
    assert.equal(tokens.resolve(plain.token)?.attemptId, 'A2');

    // 旧生命周期不受影响：单张 revoke 与按 Attempt revoke 语义不变。
    const sibling = tokens.issue({ missionId: 'M', attemptId: 'A1', role: 'coordinator', claim: CLAIM });
    tokens.revoke(sibling.token);
    assert.equal(tokens.resolve(sibling.token), undefined);
    assert.equal(tokens.resolve(impact.token)?.purpose, 'impact');
    tokens.revokeAttempt('M', 'A1');
    assert.equal(tokens.resolve(impact.token), undefined);
    assert.equal(tokens.resolve(plain.token)?.attemptId, 'A2');
  });

  test('真实 HTTP：impact 牌只读放行、其余入口全部 403 且无副作用；普通牌行为不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'impact-run-policy-'));
    const store = new FileStateStore(join(dir, 'state.json'));
    const clock = new FixedClock(NOW);
    const ids = new PersistentIds(store);
    const projects = new FileProjectRepository(store);
    const activity = new FileActivityLog(store, clock);
    const deliveries = new FileDeliveryRepository(store, clock, ids);
    const hops = new FileQueuedHopRepository(store);
    const platform = new Platform({ projects, deliveries, activity, clock, ids, transaction: store });
    const tokens = new RunTokenRegistry();
    let mutations = 0;
    const server = createApi({
      platform,
      tokens,
      deliveries,
      onMutation: () => {
        mutations += 1;
      },
    });
    try {
      await listenLoopback(server, 0);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      await platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT, origin: ORIGIN });
      await hops.enqueue({
        id: CLAIM.id,
        projectId: 'P',
        missionId: 'M',
        workItemId: 'W1',
        role: 'coordinator',
        priority: 1,
        availableAt: NOW,
        attemptCount: 0,
        maxAttempts: 2,
        idempotencyKey: 'impact-fence-h1',
        status: 'queued',
        createdAt: NOW,
        updatedAt: NOW,
      });
      const claimed = await hops.claim(CLAIM.id, CLAIM.owner, NOW, LEASE);
      assert.equal(claimed?.claimGeneration, 1);

      const { attemptId } = await platform.startCoordinatorAttempt('M', undefined, CLAIM);
      await platform.updatePlan('M', attemptId, {
        findings: 'f',
        rejectedHypotheses: [],
        decisions: [],
        direction: 'd',
        risks: [],
      }, CLAIM);
      const { workItemId } = await platform.createWorkItem(
        'M',
        attemptId,
        { title: 'W1', order: ORDER, workItemId: 'W1' },
        CLAIM,
      );
      await platform.submitContractCheck('M', attemptId, { verdict: 'ok', summary: '已核对' }, CLAIM);
      await platform.dispatchWorkItems('M', attemptId, [workItemId], CLAIM);
      const exec = await platform.startExecutorAttempt('M', workItemId, undefined, CLAIM);

      // 可信签发：impact 牌由 orchestrator 之外的可信调用方在这里直接 issue，
      // HTTP 上没有签发端点，body 里自称什么都换不来这张牌。
      const impact = tokens.issue({
        missionId: 'M',
        attemptId,
        role: 'coordinator',
        claim: CLAIM,
        purpose: 'impact',
        changeId: 'chg-1',
      });
      const coord = tokens.issue({ missionId: 'M', attemptId, role: 'coordinator', claim: CLAIM });
      const executor = tokens.issue({
        missionId: 'M',
        attemptId: exec.attemptId,
        role: 'executor',
        workItemId,
        claim: CLAIM,
      });
      const reviewer = tokens.issue({ missionId: 'M', attemptId: 'A-ir', role: 'independent_reviewer' });

      // —— 只读白名单：impact 牌能读 ——
      for (const tool of [
        'coagent_get_mission',
        'coagent_get_contract',
        'coagent_get_project_context',
        'coagent_get_work_item',
      ]) {
        const res = await postJson(base, `/api/agent/${tool}`, { workItemId }, impact.token);
        assert.equal(res.status, 200, `${tool} 应放行，实际 ${res.status} ${JSON.stringify(res.json)}`);
      }
      const brief = await getJson(base, '/api/run/brief', impact.token);
      assert.equal(brief.status, 200, JSON.stringify(brief.json));
      assert.equal(brief.json.role, 'coordinator');

      // get_context 仍按 Platform 的 executor-only 来源门禁走：impact 不解锁它。
      const context = await postJson(base, '/api/agent/coagent_get_context', { ref: 'x' }, impact.token);
      assert.equal(context.status, 409);
      assert.equal(context.json.error, 'WRONG_ROLE');
      const execContext = await postJson(base, '/api/agent/coagent_get_context', { ref: 'x' }, executor.token);
      assert.equal(execContext.status, 200);

      // 放行出去的读也是 POST（agent 工具本身就是 POST），它们照旧会走落盘回调；
      // 这里只关心被拒绝的请求，所以从写阶段开始重新计数。
      mutations = 0;

      const before = {
        project: JSON.stringify((await projects.get('P'))?.toSnapshot()),
        events: (await activity.list('M')).length,
        deliveries: (await deliveries.listForMission('M')).length,
        generation: (await hops.get(CLAIM.id))?.claimGeneration,
      };

      // —— 写与其它入口：一律 403 ACTION_DENIED，body 自述一律不采信 ——
      const selfClaimed = {
        role: 'coordinator',
        purpose: 'impact',
        changeId: 'chg-1',
        owner: CLAIM.owner,
        claimGeneration: CLAIM.claimGeneration,
        id: CLAIM.id,
      };
      const writes: readonly { path: string; body: Record<string, unknown> }[] = [
        { path: '/api/agent/coagent_update_findings', body: { findings: 'x' } },
        { path: '/api/agent/coagent_update_plan', body: { findings: 'x', decisions: [], direction: 'd', risks: [] } },
        { path: '/api/agent/coagent_create_work_item', body: { title: 'W2', ...ORDER } },
        { path: '/api/agent/coagent_dispatch_work_item', body: { workItemIds: [workItemId] } },
        { path: '/api/agent/coagent_revise_work_order', body: { workItemId, ...ORDER } },
        { path: '/api/agent/coagent_retire_work_item', body: { workItemId, reason: 'r' } },
        { path: '/api/agent/coagent_review_execution_result', body: { workItemId, verdict: 'accept', reasons: ['x'] } },
        { path: '/api/agent/coagent_submit_contract_check', body: { verdict: 'ok', summary: 's' } },
        { path: '/api/agent/coagent_escalate_to_l3', body: { question: 'q', why: 'w', optionsConsidered: ['a'] } },
        { path: '/api/agent/coagent_submit_mission_result', body: { outcome: 'blocked', summary: 's' } },
        { path: '/api/agent/coagent_submit_evidence', body: { kind: 'test', summary: 's', command: 'c', exitCode: 0 } },
        { path: '/api/agent/coagent_submit_execution_result', body: { outcome: 'partial', summary: 's' } },
        { path: '/api/agent/coagent_report_blocked', body: { reason: 'r', whatWasTried: [], needsFromUpstream: 'x' } },
        { path: '/api/agent/coagent_submit_independent_review', body: { verdict: 'send_back', reasons: ['r'] } },
        // 不在白名单里的读同样拒绝：白名单之外没有「看着像读就放行」。
        { path: '/api/agent/coagent_get_work_order', body: {} },
        { path: '/api/agent/coagent_get_mission_review_bundle', body: {} },
        // finish、两种终审、一个其它控制写。
        { path: `/api/missions/M/attempts/${attemptId}/finish`, body: { endedBy: 'structured_submit' } },
        { path: '/api/missions/M/finalize', body: { verdict: 'merge', reasons: [] } },
        { path: '/api/missions/M/finalize/reviewer', body: { verdict: 'merge', reasons: [] } },
        { path: '/api/missions/M/pause', body: {} },
      ];
      for (const row of writes) {
        const res = await postJson(base, row.path, { ...row.body, ...selfClaimed }, impact.token);
        assert.equal(res.status, 403, `${row.path} 必须 403，实际 ${res.status}`);
        assert.equal(res.json.error, 'ACTION_DENIED', row.path);
      }
      const unknownTool = await postJson(base, '/api/agent/coagent_not_a_tool', selfClaimed, impact.token);
      assert.equal(unknownTool.status, 403);
      assert.equal(unknownTool.json.error, 'ACTION_DENIED');

      assert.deepEqual(
        {
          project: JSON.stringify((await projects.get('P'))?.toSnapshot()),
          events: (await activity.list('M')).length,
          deliveries: (await deliveries.listForMission('M')).length,
          generation: (await hops.get(CLAIM.id))?.claimGeneration,
        },
        before,
        '被拒绝的请求不得留下任何副作用',
      );
      assert.equal(mutations, 0, '被拒绝的 POST 不得触发 onMutation');
      assert.equal(tokens.resolve(impact.token)?.changeId, 'chg-1', '拒绝不得吊销牌');

      // 两个专属工具只认 impact 牌：普通协调者 / 执行者 / 独立检视者一律 403，
      // 而且不看 body——body 里写满 purpose / changeId / claim 也换不来授权。
      for (const [who, token] of [
        ['普通协调者', coord.token],
        ['执行者', executor.token],
        ['独立检视者', reviewer.token],
      ] as const) {
        for (const tool of ['coagent_get_change_request', 'coagent_submit_change_impact']) {
          const res = await postJson(base, `/api/agent/${tool}`, selfClaimed, token);
          assert.equal(res.status, 403, `${who} 调 ${tool} 必须 403，实际 ${res.status}`);
          assert.equal(res.json.error, 'ACTION_DENIED', `${who} 调 ${tool}`);
        }
      }

      // —— 普通牌不受影响：body 自称 impact 也不改变它的写行为 ——
      const plainWrite = await postJson(
        base,
        '/api/agent/coagent_update_findings',
        { findings: 'plain', ...selfClaimed },
        coord.token,
      );
      assert.equal(plainWrite.status, 200, JSON.stringify(plainWrite.json));
      assert.match((await projects.get('P'))!.missions[0]!.plan?.findings ?? '', /plain/);

      // 执行者与独立检视者保持既有门禁。
      const execWrite = await postJson(
        base,
        '/api/agent/coagent_update_findings',
        { findings: 'no', ...selfClaimed },
        executor.token,
      );
      assert.equal(execWrite.status, 409);
      assert.equal(execWrite.json.error, 'WRONG_ROLE');
      const reviewerFinalize = await postJson(base, '/api/missions/M/finalize/reviewer', { verdict: 'merge', reasons: [] }, reviewer.token);
      assert.equal(reviewerFinalize.status, 403);
      assert.equal(reviewerFinalize.json.error, 'ACTION_DENIED');
    } finally {
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
