/**
 * direct-control HTTP 面：主控经控制面直接驱动协调者。
 *
 * 守住：
 *   - direct / hierarchical coordinationMode 经 POST /api/missions 创建后能回读；
 *     coordinationMode 的取值校验交给 Platform 白名单，HTTP 层只透传、默认不变。
 *   - 缺控制面凭据 401；带执行者令牌（x-coagent-run）403 且不返回 token ——
 *     执行者不能借控制面自验收。
 *   - 已认证请求的 actor 来自控制面 principal，而不是请求体 payload：
 *     body.actor 出现在顶层就 400，绝不被当成 actor 采纳。
 *   - 未知 action / 非对象 body / 伪 actor / attemptId 等非法顶层字段 400，
 *     且不产生新的协调者 attempt（被挡在 HTTP 层，没进 Platform）。
 *   - 窄并发门禁：runnerState.isRunning(missionId) 为真（托管执行或机器验证还在跑）
 *     时，合法命令也 409 DIRECT_RUN_ACTIVE 且不开新协调者 attempt；标记解除后
 *     同一条命令照常 200。门禁在权限之后，所以缺凭据仍是 401。
 *   - 成功链 plan → contract_check → create_work_item → dispatch：
 *     命令字段固定 {action:'plan',plan} / {action:'contract_check',check} /
 *     {action:'create_work_item',title,order,workItemId?} / {action:'dispatch',workItemIds}。
 *
 * 用真实 Platform（in-memory）+ createApi / loopback HTTP，复用
 * review-history.test.ts 的 harness 模式（每个 server finally closeAllConnections + close，
 * 15s test timeout）。
 */

import { describe, test } from 'node:test';
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
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: 'direct-control 接线测试',
  acceptance: ['ok'],
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

const PLAN = { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] };

const CHECK = { verdict: 'ok' as const, summary: '契约核对通过' };

/** 测试用的控制面凭据 token：resolver 只认这一条。 */
const OP_TOKEN = 'operator-token-direct';
const OP_PRINCIPAL_ID = 'op-direct-1';

const resolveFromHeader: ControlPrincipalResolver = (req: IncomingMessage) => {
  const raw = req.headers['x-coagent-control'];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (token !== OP_TOKEN) return undefined;
  return { id: OP_PRINCIPAL_ID, role: 'operator' } satisfies ControlPrincipal;
};

interface Harness {
  readonly base: string;
  readonly server: ReturnType<typeof createApi>;
  readonly platform: Platform;
  readonly activity: InMemoryActivityLog;
  readonly tokens: RunTokenRegistry;
  /** 可切换的 fake runner 探针：默认没人跑，测试自己标记哪条 Mission 在托管控中。 */
  readonly running: Set<string>;
}

function makePlatform(): { platform: Platform; activity: InMemoryActivityLog } {
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

async function startHarness(): Promise<Harness> {
  const { platform, activity } = makePlatform();
  const tokens = new RunTokenRegistry();
  // runnerState 只实现 isRunning / running：direct-control 门禁只看 isRunning，
  // 默认空集合，既有用例不受影响；要演练并发时由用例往集合里加一条 Mission。
  const running = new Set<string>();
  const server = createApi({
    platform,
    tokens,
    deliveries: new InMemoryDeliveryRepository(new FixedClock(), new SequentialIds()),
    agentPool: new InMemoryAgentPoolRepository(),
    resolveControlPrincipal: resolveFromHeader,
    runnerState: {
      isRunning: (missionId: string) => running.has(missionId),
      running: () => [...running],
    },
  });
  await listenLoopback(server, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, server, platform, activity, tokens, running };
}

async function stopHarness(h: Harness): Promise<void> {
  h.server.closeAllConnections?.();
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
}

async function post(
  base: string,
  path: string,
  body: unknown,
  opts: { controlToken?: string; runToken?: string } = {},
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.controlToken !== undefined) headers['x-coagent-control'] = opts.controlToken;
  if (opts.runToken !== undefined) headers['x-coagent-run'] = opts.runToken;
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers,
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

/** 协调者 attempt 的数量（coord-N）。用来证 HTTP 层拒绝路径没开新 attempt。 */
function coordinatorAttemptCount(view: { coordinatorAttemptIds?: readonly unknown[] }): number {
  return view.coordinatorAttemptIds?.length ?? 0;
}

describe('POST /api/missions/:id/direct-control', () => {
  test(
    'direct/hierarchical 创建回读；缺凭据 401；x-coagent-run 403；actor 来自 principal；未知 action 400 无新 attempt；托管运行中 409 DIRECT_RUN_ACTIVE 无新 attempt；成功 plan→contract_check→create_work_item→dispatch',
    { timeout: 15000 },
    async () => {
      const h = await startHarness();
      try {
        /* ---------- direct / hierarchical coordinationMode 创建回读 ---------- */

        // direct：透传 coordinationMode='direct'，Platform 白名单放行，回读为 direct。
        const direct = await post(h.base, '/api/missions', {
          projectId: 'P',
          missionId: 'M-direct',
          contract: CONTRACT,
          coordinationMode: 'direct',
        }, { controlToken: OP_TOKEN });
        assert.equal(direct.status, 201, 'direct 创建应 201');
        assert.equal(direct.json.missionId, 'M-direct');
        const directView = await h.platform.getMissionView('M-direct');
        assert.equal(directView.coordinationMode, 'direct', '回读 coordinationMode=direct');

        // hierarchical：不传 coordinationMode，默认不变，回读 hierarchical。
        const hier = await post(h.base, '/api/missions', {
          projectId: 'P',
          missionId: 'M-hier',
          contract: CONTRACT,
        }, { controlToken: OP_TOKEN });
        assert.equal(hier.status, 201, 'hierarchical 创建应 201');
        const hierView = await h.platform.getMissionView('M-hier');
        assert.equal(hierView.coordinationMode, 'hierarchical', '缺省 coordinationMode=hierarchical');

        /* ---------- 缺控制面凭据 401 ---------- */
        const noAuth = await post(h.base, '/api/missions/M-direct/direct-control', {
          action: 'plan', plan: PLAN,
        });
        assert.equal(noAuth.status, 401);
        assert.equal(noAuth.json.error, 'CONTROL_UNAUTHORIZED');
        assert.equal(noAuth.text.includes(OP_TOKEN), false, '拒绝不得回显凭据');

        /* ---------- x-coagent-run 403 且不返回 token ---------- */
        // 发一张执行者牌：direct-control 是控制面操作，执行者令牌不能借控制面自验收。
        const execRun = h.tokens.issue({
          missionId: 'M-direct',
          attemptId: 'coord-1',
          role: 'executor',
          workItemId: 'W-1',
        });
        const withRunToken = await post(h.base, '/api/missions/M-direct/direct-control', {
          action: 'plan', plan: PLAN,
        }, { runToken: execRun.token });
        assert.equal(withRunToken.status, 403, '带 x-coagent-run 必须 403');
        assert.equal(withRunToken.json.error, 'CONTROL_FORBIDDEN');
        assert.equal(withRunToken.text.includes(execRun.token), false, '不得回显执行者 token');
        // 不带 token 但带个随机 x-coagent-run 头也应 403（无论它能不能解析）。
        const bogusRun = await post(h.base, '/api/missions/M-direct/direct-control', {
          action: 'plan', plan: PLAN,
        }, { runToken: 'bogus-not-a-real-token' });
        assert.equal(bogusRun.status, 403, '带任何 x-coagent-run 都 403');

        /* ---------- actor 来自 principal 而非 payload ---------- */
        // body.actor 出现在顶层就 400：actor 只来自 controlActor(resolveControlPrincipal, req)。
        const fakeActor = await post(h.base, '/api/missions/M-direct/direct-control', {
          action: 'plan', plan: PLAN, actor: 'i-claim-to-be-someone-else',
        }, { controlToken: OP_TOKEN });
        assert.equal(fakeActor.status, 400, 'body.actor 必须 400');
        assert.match(String(fakeActor.json.error), /^BAD_REQUEST$/);

        // 伪 actor 也走同一道：{actor: '...'} 单独出现即拒。
        const actorOnly = await post(h.base, '/api/missions/M-direct/direct-control', {
          actor: 'attacker',
        }, { controlToken: OP_TOKEN });
        assert.equal(actorOnly.status, 400, '只有 actor 也要 400');

        /* ---------- 未知 action / 非对象 / 非法顶层字段 400 且无新 attempt ---------- */
        const beforeRejects = coordinatorAttemptCount(await h.platform.getMissionView('M-direct'));

        const unknownAction = await post(h.base, '/api/missions/M-direct/direct-control', {
          action: 'not_a_real_action', plan: PLAN,
        }, { controlToken: OP_TOKEN });
        assert.equal(unknownAction.status, 400, '未知 action 必须 400');
        assert.match(String(unknownAction.json.error), /^BAD_REQUEST$/);

        const missingAction = await post(h.base, '/api/missions/M-direct/direct-control', {
          plan: PLAN,
        }, { controlToken: OP_TOKEN });
        assert.equal(missingAction.status, 400, '缺 action 必须 400');

        const nonObject = await post(h.base, '/api/missions/M-direct/direct-control',
          'just-a-string-not-an-object', { controlToken: OP_TOKEN });
        assert.equal(nonObject.status, 400, '非对象 body 必须 400');

        const arrayWithAction = await post(h.base, '/api/missions/M-direct/direct-control',
          [{ action: 'plan', plan: PLAN }], { controlToken: OP_TOKEN });
        assert.equal(arrayWithAction.status, 400, '数组 body 必须 400');

        // attemptId 是身份/代次顶层字段：出现在顶层就 400（主控替协调者开工，
        // attemptId 由 Platform 决定，不让调用方挑「替哪一跳说话」）。
        const withAttemptId = await post(h.base, '/api/missions/M-direct/direct-control', {
          action: 'plan', plan: PLAN, attemptId: 'coord-99',
        }, { controlToken: OP_TOKEN });
        assert.equal(withAttemptId.status, 400, '顶层 attemptId 必须 400');

        // plan action 多塞一个未授权字段（order）也应 400：plan 只收 action/plan。
        const planWithExtra = await post(h.base, '/api/missions/M-direct/direct-control', {
          action: 'plan', plan: PLAN, order: ORDER,
        }, { controlToken: OP_TOKEN });
        assert.equal(planWithExtra.status, 400, 'plan 多塞 order 必须 400');

        // 未知顶层字段对七种 action 一律拒，而不只是前四个：身份/代次/预算类字段
        // （usage / passed）不得以任何 action 的名义混进来。
        const fieldProbes: ReadonlyArray<Record<string, unknown>> = [
          { action: 'plan', plan: PLAN, usage: {} },
          { action: 'contract_check', check: CHECK, passed: true },
          { action: 'create_work_item', title: 'W-x', order: ORDER, usage: {} },
          { action: 'revise_work_order', workItemId: 'W-1', order: ORDER, passed: true },
          { action: 'dispatch', workItemIds: ['W-1'], usage: {} },
          { action: 'review', workItemId: 'W-1', verdict: 'accept', reasons: [], requiredChanges: [], passed: true },
          { action: 'submit', result: { summary: 's' }, usage: {} },
        ];
        for (const probe of fieldProbes) {
          const res = await post(h.base, '/api/missions/M-direct/direct-control', probe, {
            controlToken: OP_TOKEN,
          });
          assert.equal(res.status, 400, `action=${String(probe.action)} 多余顶层字段必须 400`);
          assert.match(String(res.json.error), /^BAD_REQUEST$/);
        }

        // 合法 action 但 payload 形状不对：共享解析器（direct-control-command.ts）在
        // 开 host Attempt 之前就拒，HTTP 层只把 INVALID_DIRECT_COMMAND 翻成 400 BAD_REQUEST。
        const badPayloads: ReadonlyArray<Record<string, unknown>> = [
          { action: 'plan' },
          { action: 'plan', plan: {} },
          { action: 'dispatch', workItemIds: [1] },
        ];
        for (const bad of badPayloads) {
          const res = await post(h.base, '/api/missions/M-direct/direct-control', bad, {
            controlToken: OP_TOKEN,
          });
          assert.equal(res.status, 400, `action=${String(bad.action)} 坏 payload 必须 400`);
          assert.match(String(res.json.error), /^BAD_REQUEST$/);
        }

        // 拒绝路径一律不产生新协调者 attempt：全被挡在 HTTP 层，没进 Platform。
        const afterRejects = coordinatorAttemptCount(await h.platform.getMissionView('M-direct'));
        assert.equal(afterRejects, beforeRejects, 'HTTP 层拒绝不得开新协调者 attempt');

        /* ---------- 窄并发门禁：托管运行未结束时 409 DIRECT_RUN_ACTIVE ----------
         *
         * 这一段是执行者 attempt 已结束、机器验证还在跑的那个窗口：core 里没有活动
         * 执行者（ACTIVE_EXECUTOR_PRESENT 为假），但 runner 进程仍占着这条 Mission。
         * 光靠 core 判断会放主控进来，所以门禁看 runnerState.isRunning(missionId)。
         */
        h.running.add('M-direct');
        // 另一条 Mission 同时也在跑：门禁必须按 missionId 判，不能一看有托管运行就跑全锁。
        h.running.add('M-elsewhere');
        try {
          const gatedPlan = await post(h.base, '/api/missions/M-direct/direct-control', {
            action: 'plan', plan: PLAN,
          }, { controlToken: OP_TOKEN });
          assert.equal(gatedPlan.status, 409, '托管运行中合法 plan 必须 409');
          assert.equal(gatedPlan.json.error, 'DIRECT_RUN_ACTIVE', '错误码必须是 DIRECT_RUN_ACTIVE');
          assert.equal(
            coordinatorAttemptCount(await h.platform.getMissionView('M-direct')),
            afterRejects,
            '409 拒绝不得开新协调者 attempt（门禁在 performDirectControl 之前）',
          );

          // 门禁在两道 requireControl 之后：带不上控制面凭据仍是 401，不是 409。
          const gatedNoAuth = await post(h.base, '/api/missions/M-direct/direct-control', {
            action: 'plan', plan: PLAN,
          });
          assert.equal(gatedNoAuth.status, 401, '托管运行中缺凭据仍应先报 401');

          // 执行者牌在更外面的 fence 就 403，也不会被 409 抢先。
          const gatedRunToken = await post(h.base, '/api/missions/M-direct/direct-control', {
            action: 'plan', plan: PLAN,
          }, { runToken: execRun.token });
          assert.equal(gatedRunToken.status, 403, '托管运行中带 x-coagent-run 仍应先报 403');
        } finally {
          h.running.delete('M-direct');
        }

        /* ---------- 成功链 plan → contract_check → create_work_item → dispatch ----------
         *
         * 命令字段固定：
         *   {action:'plan', plan}
         *   {action:'contract_check', check}
         *   {action:'create_work_item', title, order, workItemId?}
         *   {action:'dispatch', workItemIds}
         */
        // 标记解除后原链照常 200：plan 这一步同时证明门禁按 missionId 判定，
        // M-elsewhere 仍在跑并不影响 M-direct。
        const planRes = await post(h.base, '/api/missions/M-direct/direct-control', {
          action: 'plan', plan: PLAN,
        }, { controlToken: OP_TOKEN });
        assert.equal(planRes.status, 200, `plan 应 200：${planRes.status} ${planRes.text}`);

        const checkRes = await post(h.base, '/api/missions/M-direct/direct-control', {
          action: 'contract_check', check: CHECK,
        }, { controlToken: OP_TOKEN });
        assert.equal(checkRes.status, 200, 'contract_check 应 200');

        const createRes = await post(h.base, '/api/missions/M-direct/direct-control', {
          action: 'create_work_item', title: 'W-1', order: ORDER,
        }, { controlToken: OP_TOKEN });
        assert.equal(createRes.status, 200, 'create_work_item 应 200');
        const createdWorkItemId =
          typeof createRes.json.workItemId === 'string' ? createRes.json.workItemId : 'W-1';

        const dispatchRes = await post(h.base, '/api/missions/M-direct/direct-control', {
          action: 'dispatch', workItemIds: [createdWorkItemId],
        }, { controlToken: OP_TOKEN });
        assert.equal(dispatchRes.status, 200, 'dispatch 应 200');

        // 成功链后协调者 attempt 推进了（plan 开了一次协调者 attempt）。
        const afterChain = coordinatorAttemptCount(await h.platform.getMissionView('M-direct'));
        assert.ok(afterChain > beforeRejects, '成功链应推进协调者 attempt');
        h.running.delete('M-elsewhere');
      } finally {
        await stopHarness(h);
      }
    },
  );
});
