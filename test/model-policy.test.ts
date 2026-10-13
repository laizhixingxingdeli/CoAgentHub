/**
 * Mission 级模型约束（P1）：平台在派发前强制，而不是等模型自己发现身份不符。
 *
 * 案例（MiRing-V0-probe）：契约要求协调者必须是 xai/grok-4.7；Grok 上游故障进入冷却后，候选池
 * 自动把活派给 gpt-6.1-sol，Sol 读出「我不是 Grok」才升级停止。用户后来明确授权改用 Sol——
 * 旧的限制不能被当成当前要求。
 *
 * 守：指定（required）时匹配的候选不可用就等、不派别的；优先（preferred）才替代；约束只管这条
 * Mission；改了约束下一次派发就按新的；每次派发可追溯；不从契约正文猜。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { InMemoryAgentPoolRepository } from '../src/application/agent-pool.ts';
import { Orchestrator } from '../src/application/orchestrator.ts';
import { Platform } from '../src/application/platform.ts';
import { FileCandidateCircuitRepository, FileStateStore } from '../src/application/file-store.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import {
  ModelPolicyError,
  applyRolePolicy,
  parseRoleModelPolicy,
} from '../src/application/model-policy.ts';
import { classifyCandidateFailure } from '../src/application/candidate-circuit.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import { makeIssuer } from '../src/main.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import type { ExecutionProfile } from '../src/application/ports.ts';
import type { MissionContract } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '协调者必须是 xai/grok-4.7（契约正文，可能已过期）',
  acceptance: ['做完'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const GROK: ExecutionProfile = {
  endpoint: 'local',
  profileId: 'coordinator-grok',
  facts: [
    { key: 'provider', value: 'xai' },
    { key: 'model', value: 'grok-4.7' },
    { key: 'reasoning', value: 'medium' },
  ],
};
const SOL: ExecutionProfile = {
  endpoint: 'local',
  profileId: 'coordinator-sol',
  facts: [
    { key: 'provider', value: 'openai-codex' },
    { key: 'model', value: 'gpt-6.1-sol' },
    { key: 'reasoning', value: 'medium' },
  ],
};

const GROK_ONLY = { mode: 'required', selectors: [{ provider: 'xai', model: 'grok-4.7' }] } as const;

describe('约束规整与应用（纯函数）', () => {
  test('非法输入整份拒绝，并说得出改法', () => {
    for (const [raw, pattern] of [
      [{ mode: 'maybe', selectors: [{ model: 'x' }] }, /preferred.*required/],
      [{ mode: 'required', selectors: [] }, /至少一条/],
      [{ mode: 'required', selectors: [{}] }, /空选择器会匹配一切/],
      [{ mode: 'required', selectors: [{ vendor: 'x' }] }, /不认识字段 vendor/],
      [{ mode: 'required', selectors: [{ model: '  ' }] }, /非空字符串/],
    ] as const) {
      assert.throws(() => parseRoleModelPolicy(raw, 'coordinator'), (error) => error instanceof ModelPolicyError && pattern.test(error.message));
    }
  });

  test('required 只留匹配的（选择器各项都满足、不区分大小写）；preferred 把匹配的排前面', () => {
    const required = parseRoleModelPolicy({ mode: 'required', selectors: [{ provider: 'XAI', model: 'grok-4.7' }] }, 'coordinator');
    assert.deepEqual(applyRolePolicy([SOL, GROK], required).candidates.map((p) => p.profileId), ['coordinator-grok']);
    assert.equal(applyRolePolicy([SOL], required).blocked, true, '匹配的都不可用：挡住，不退到别的');
    const preferred = parseRoleModelPolicy({ mode: 'preferred', selectors: [{ profileId: 'coordinator-grok' }] }, 'coordinator');
    assert.deepEqual(applyRolePolicy([SOL, GROK], preferred).candidates.map((p) => p.profileId), ['coordinator-grok', 'coordinator-sol']);
    assert.equal(applyRolePolicy([SOL], preferred).blocked, false, '优先模式没有匹配的就退回其余');
    // 一个选择器里给的条件都要满足：模型对、供应商错就不算。
    const strict = parseRoleModelPolicy({ mode: 'required', selectors: [{ provider: 'openai-codex', model: 'grok-4.7' }] }, 'coordinator');
    assert.equal(applyRolePolicy([GROK, SOL], strict).blocked, true);
  });

  test('「模型不可用」是候选配置问题：独立成类并允许换候选，其余未知错误仍是 unknown', () => {
    const message = '模型不可用：tenrouter/cbai/deepseek-v4.1-flash。可用的有：deepseek/deepseek-flash, openai-codex/gpt-5.5';
    assert.deepEqual(classifyCandidateFailure('upstream_failure', message), { failureClass: 'model_unavailable', failover: true });
    assert.deepEqual(classifyCandidateFailure('upstream_failure', 'Unknown model: foo'), { failureClass: 'model_unavailable', failover: true });
    assert.deepEqual(classifyCandidateFailure('upstream_failure', 'ordinary execution failed'), { failureClass: 'unknown', failover: false });
  });
});

describe('平台强制：指定不可替代，优先才替代，只管这一条 Mission', () => {
  const dirs: string[] = [];
  const servers: Server[] = [];
  after(() => {
    for (const server of servers) server.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  async function world() {
    const clock = new FixedClock('2026-06-01T12:00:00.000Z');
    const activity = new InMemoryActivityLog(clock);
    const ids = new SequentialIds();
    const deliveries = new InMemoryDeliveryRepository(clock, ids);
    const platform = new Platform({
      projects: new InMemoryProjectRepository(),
      deliveries,
      workspace: new InPlaceWorkspaceManager(),
      activity,
      clock,
      ids,
    });
    const dir = mkdtempSync(join(tmpdir(), 'model-policy-'));
    dirs.push(dir);
    const circuits = new FileCandidateCircuitRepository(new FileStateStore(join(dir, 'state.json')));
    const tokens = new RunTokenRegistry();
    const agentPool = new InMemoryAgentPoolRepository();
    const server: Server = createApi({ platform, tokens, deliveries, agentPool });
    await listenLoopback(server, 0);
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const coordinator = new ScriptedRuntime({ 'coordinator:-:0': { steps: [{ tool: 'coagent_get_mission', body: {} }] } });
    const orchestrator = () =>
      new Orchestrator({
        platform,
        tokens: makeIssuer(platform, tokens),
        baseUrl,
        workspace: new InPlaceWorkspaceManager(),
        candidateCircuits: circuits,
        // 不读真实额度：默认读取器会起适配器进程去查，单测不该为此等好几秒。
        usageReader: async () => [],
        coordinator: { runtime: coordinator, candidates: [GROK, SOL] },
        executor: { runtime: new ScriptedRuntime({}), candidates: [{ endpoint: 'local', profileId: 'exec-a' }] },
      });
    return { platform, circuits, coordinator, orchestrator, baseUrl, agentPool };
  }

  const coolGrok = (w: Awaited<ReturnType<typeof world>>, until: string) =>
    w.circuits.open({ profileId: 'coordinator-grok', failureClass: 'upstream_5xx', openUntil: until });

  const selections = async (w: Awaited<ReturnType<typeof world>>, missionId: string) =>
    (await w.platform.getActivity(missionId)).filter((event) => event.kind === 'attempt.profile_selected').map((event) => event.data as Record<string, unknown>);

  test('指定 Grok 而 Grok 冷却：不派 Sol，停在 model_unavailable 并带恢复时刻；没约束的 Mission 照常用 Sol', async () => {
    const w = await world();
    const until = new Date(Date.now() + 5 * 60_000).toISOString();
    await coolGrok(w, until);
    await w.platform.createMission({ projectId: 'P', missionId: 'M-req', contract: CONTRACT });
    await w.platform.createMission({ projectId: 'P', missionId: 'M-free', contract: CONTRACT });
    await w.platform.setMissionModelPolicy('M-req', { coordinator: GROK_ONLY, reviewer: 'L3', reason: '用户要求协调者只用 Grok 4.7' });

    const blocked = await w.orchestrator().runMission('M-req', { projectRoot: process.cwd(), maxRounds: 1 });
    assert.equal(blocked.kind, 'waiting');
    assert.equal((blocked as { reason: string }).reason, 'model_unavailable');
    assert.equal((blocked as { resumeAt?: string }).resumeAt, until);
    assert.match((blocked as { detail: string }).detail, /不派发其他模型/);
    assert.equal(w.coordinator.specs.length, 0, '一个 Agent 都没启动，更没有换成 Sol');
    const view = await w.platform.getMissionView('M-req');
    assert.equal(view.waitReason, 'model_unavailable');
    assert.equal(view.waitResumeAt, until);
    assert.equal(view.modelPolicy?.revision, 1);

    // 其它 Mission 不受影响：同一个池、同一个熔断状态，没设约束就照旧退到 Sol。
    await w.orchestrator().runMission('M-free', { projectRoot: process.cwd(), maxRounds: 1 });
    assert.deepEqual(w.coordinator.specs.map((spec) => spec.profile.profileId), ['coordinator-sol']);
    assert.deepEqual(await selections(w, 'M-free'), [], '没约束的 Mission 事件流不变');
  });

  test('优先 Grok 时 Grok 冷却才退到 Sol，并标明是替代；Grok 可用就用 Grok', async () => {
    const w = await world();
    await w.platform.createMission({ projectId: 'P', missionId: 'M-pref', contract: CONTRACT });
    await w.platform.createMission({ projectId: 'P', missionId: 'M-pref-ok', contract: CONTRACT });
    const preferred = { mode: 'preferred', selectors: [{ provider: 'xai' }] };
    await w.platform.setMissionModelPolicy('M-pref', { coordinator: preferred, reviewer: 'L3', reason: '优先 Grok' });
    await w.platform.setMissionModelPolicy('M-pref-ok', { coordinator: preferred, reviewer: 'L3', reason: '优先 Grok' });

    await w.orchestrator().runMission('M-pref-ok', { projectRoot: process.cwd(), maxRounds: 1 });
    assert.equal(w.coordinator.specs.at(-1)?.profile.profileId, 'coordinator-grok', 'Grok 可用：用 Grok，不替代');
    // 身份由平台强制，唤醒语明说：协调者不必核对自己是哪个模型，更不要因契约正文里的旧叙述升级。
    assert.match(w.coordinator.instructions.at(-1) ?? '', /模型身份由平台强制.*r1.*不要核对自己是哪个模型/s);
    assert.deepEqual(await selections(w, 'M-pref-ok'), [
      { role: 'coordinator', profileId: 'coordinator-grok', mode: 'preferred', policyRevision: 1, matched: true, substituted: false },
    ]);

    await coolGrok(w, new Date(Date.now() + 5 * 60_000).toISOString());
    await w.orchestrator().runMission('M-pref', { projectRoot: process.cwd(), maxRounds: 1 });
    assert.equal(w.coordinator.specs.at(-1)?.profile.profileId, 'coordinator-sol', 'Grok 冷却：优先模式允许退到 Sol');
    assert.deepEqual(await selections(w, 'M-pref'), [
      { role: 'coordinator', profileId: 'coordinator-sol', mode: 'preferred', policyRevision: 1, matched: false, substituted: true },
    ]);
  });

  test('用户改了要求（授权改用 Sol）：下一次派发按新版本，旧限制留在历史里不再生效', async () => {
    const w = await world();
    await coolGrok(w, new Date(Date.now() + 5 * 60_000).toISOString());
    await w.platform.createMission({ projectId: 'P', missionId: 'M-switch', contract: CONTRACT });
    await w.platform.setMissionModelPolicy('M-switch', { coordinator: GROK_ONLY, reviewer: 'L3', reason: 'r1：只用 Grok' });
    const first = await w.orchestrator().runMission('M-switch', { projectRoot: process.cwd(), maxRounds: 1 });
    assert.equal((first as { reason: string }).reason, 'model_unavailable');

    await assert.rejects(
      () => w.platform.setMissionModelPolicy('M-switch', { coordinator: GROK_ONLY, reviewer: 'L3', reason: 'x', expectedRevision: 0 }),
      /MODEL_POLICY_STALE|模型约束已经变了/,
    );
    const changed = await w.platform.setMissionModelPolicy('M-switch', {
      coordinator: { mode: 'required', selectors: [{ model: 'gpt-6.1-sol' }] },
      reviewer: 'L3',
      reason: 'r2：用户明确授权改用 Sol',
      expectedRevision: 1,
    });
    assert.equal(changed.revision, 2);

    await w.orchestrator().runMission('M-switch', { projectRoot: process.cwd(), maxRounds: 1 });
    assert.equal(w.coordinator.specs.at(-1)?.profile.profileId, 'coordinator-sol');
    assert.deepEqual(await selections(w, 'M-switch'), [
      { role: 'coordinator', profileId: 'coordinator-sol', mode: 'required', policyRevision: 2, matched: true, substituted: false },
    ]);
    const history = (await w.platform.getActivity('M-switch')).filter((event) => event.kind === 'mission.model_policy_set');
    assert.deepEqual(history.map((event) => (event.data as { revision: number }).revision), [1, 2], '历史全留');

    await w.platform.setMissionModelPolicy('M-switch', { clear: true, reviewer: 'L3', reason: '取消约束' });
    assert.equal((await w.platform.getMissionView('M-switch')).modelPolicy, undefined);
  });

  test('HTTP：署名必填；设置后响应点名资源池里匹配不到的约束；GET 读回', async () => {
    const w = await world();
    await w.platform.createMission({ projectId: 'P', missionId: 'M-http', contract: CONTRACT });
    await w.agentPool.add({ role: 'coordinator', profileId: 'coordinator-sol', endpoint: 'local', facts: SOL.facts });
    const url = `${w.baseUrl}/api/missions/M-http/model-policy`;
    const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const unsigned = await post({ coordinator: GROK_ONLY });
    assert.ok(unsigned.status >= 400 && unsigned.status < 500);
    assert.equal((await (await fetch(url)).json()).policy, null, '被拒的设置不留约束');

    const done = await (await post({ coordinator: GROK_ONLY, reviewer: 'L3', reason: '用户要求' })).json();
    assert.equal(done.revision, 1);
    assert.equal(done.warnings.length, 1, '池里只有 Sol，Grok 约束匹配不到');
    assert.match(done.warnings[0], /coordinator：资源池里当前没有匹配的启用候选.*model_unavailable/);
    assert.equal((await (await fetch(url)).json()).policy.coordinator.mode, 'required');
    const mission = await (await fetch(`${w.baseUrl}/api/missions/M-http`)).json();
    assert.equal(mission.modelPolicy.revision, 1);
  });
});
