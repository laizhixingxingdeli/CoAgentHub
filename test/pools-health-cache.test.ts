/**
 * W-690：GET /api/pools 最终响应短缓存、single-flight 与写后失效。
 *
 * 两条测试，覆盖读缓存与写失效两条路径：
 *
 * ① 多 Mission 多候选、成功与失败 attempt 的夹具上，把「缓存关闭」的响应当完整
 *    deepEqual 基线，逐字段比较未命中、命中、?fresh=1 三种情形；用扫描计数证明
 *    默认两读两扫、开启后并发共享、TTL 到期、fresh 真重扫、失败不缓存且可重试；
 *    注入 resolver 证明每次请求都鉴权、未授权仍 401/403，且响应不泄露敏感字段。
 *
 * ② 三个成功写路由（POST add / configure / reset）预热后立即让缓存失效：新 GET
 *    看到新值并新增扫描；再用 holdAt 把一次旧代扫描悬在半空，写成功后释放，证明
 *    旧扫描不得回填新缓存（旧 snapshot 与新 snapshot 明显不同）。
 *
 * 并发与失效顺序全部由夹具 holdAt/hooks 确定性地控制，不含墙钟阈值。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPoolsHealthFixture,
  httpGetJson,
  POOLS_HEALTH_FIXTURE_NOW_ISO,
  type PoolsHealthFixture,
} from './helpers/pools-health-fixture.ts';
import type { ControlPrincipal, ControlPrincipalResolver } from '../src/api/control-auth.ts';
import type {
  CandidateCircuitRepository,
} from '../src/application/ports.ts';
import type {
  CandidateCircuit,
  ClaimCandidateProbeInput,
  OpenCandidateCircuitInput,
  ResolveCandidateProbeInput,
} from '../src/application/candidate-circuit.ts';
import { closedCandidateCircuit } from '../src/application/candidate-circuit.ts';

const MISSION_COUNT = 5;
const ATTEMPTS_PER_MISSION = 2;
/** 读失败的 Mission：让「失败不进缓存」那条也走夹具的 continue 路径。 */
const FAILING_MISSION_INDEX = 2;

type PoolsBody = Record<string, unknown> & {
  executor: Array<{ profileId: string; health: { circuit: { state: string; reason?: string } } }>;
  classifier: unknown[];
};

/** 逐字段比较两条响应；随时间变化的 fetchedAt 一类字段本夹具不产出，直接深比。 */
function assertSamePoolsBody(actual: unknown, expected: unknown, label: string): void {
  assert.deepEqual(actual, expected, label);
}

/**
 * 熔断仓储的内存替身：按接口形状给，不导出生产内部实现，也不读运行状态。
 * 只实现测试真正走的 get / open / reset，其余抛「不该被调到」。
 */
class FakeCandidateCircuits implements CandidateCircuitRepository {
  readonly rows = new Map<string, CandidateCircuit>();

  async get(profileId: string): Promise<CandidateCircuit> {
    return this.rows.get(profileId) ?? closedCandidateCircuit(profileId);
  }

  async open(input: OpenCandidateCircuitInput): Promise<CandidateCircuit> {
    const row: CandidateCircuit = {
      profileId: input.profileId,
      state: 'open',
      failureClass: input.failureClass,
      openUntil: input.openUntil,
    };
    this.rows.set(input.profileId, row);
    return row;
  }

  async reset(input: { profileId: string; actor: string; at: string; reason: string }): Promise<CandidateCircuit> {
    if (!this.rows.has(input.profileId)) throw new Error('candidate circuit does not exist');
    const row = closedCandidateCircuit(input.profileId);
    this.rows.set(input.profileId, row);
    return row;
  }

  async tryClaimProbe(_input: ClaimCandidateProbeInput): Promise<boolean> {
    throw new Error('FakeCandidateCircuits.tryClaimProbe 不该被调到');
  }

  async resolveProbe(_input: ResolveCandidateProbeInput): Promise<CandidateCircuit> {
    throw new Error('FakeCandidateCircuits.resolveProbe 不该被调到');
  }

  async listResetEvents(_profileId?: string): Promise<Array<{ profileId: string; actor: string; at: string; reason: string }>> {
    return [];
  }
}

/** 让 GET /api/pools 的扫描在顶层拒绝：候选快照读失败，扫描还没开始就抛。 */
function makeListFailing(fixture: PoolsHealthFixture): void {
  const original = fixture.pool.list.bind(fixture.pool);
  let once = true;
  (fixture.pool as unknown as { list: () => Promise<unknown> }).list = async () => {
    if (once) {
      once = false;
      throw new Error('fixture: 这一次 list 失败（失败不进缓存）');
    }
    return original();
  };
}

test('池健康缓存：默认不缓存、命中复用、并发共享、TTL 到期、fresh 重扫、失败可重试', async () => {
  // 基线夹具：缓存关闭（缺省 0）。同一份数据下它逐请求重扫；全程开着，供各处对拍。
  const baseline = await createPoolsHealthFixture({
    missions: MISSION_COUNT,
    attemptsPerMission: ATTEMPTS_PER_MISSION,
    failingMissionIndexes: [FAILING_MISSION_INDEX],
  });
  const fixture = await createPoolsHealthFixture({
    missions: MISSION_COUNT,
    attemptsPerMission: ATTEMPTS_PER_MISSION,
    failingMissionIndexes: [FAILING_MISSION_INDEX],
    poolsHealthCacheMs: 15_000,
  });
  try {
    // 缓存关闭：两次读各自扫一遍，内容逐字段相同。
    const first = await httpGetJson(`${baseline.base}/api/pools`);
    const second = await httpGetJson(`${baseline.base}/api/pools`);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assertSamePoolsBody(second.json, first.json, '缓存关闭时两次读应逐字段一致');
    assert.equal(baseline.scanned(), MISSION_COUNT * 2, '缺省每请求一次扫描');
    assert.equal(
      (first.json as PoolsBody).executor.find((row) => row.profileId === 'exec-1')?.health.circuit.reason,
      'candidate_circuits_unavailable',
      '没注入熔断仓储时 circuit 要说明原因',
    );

    const zero = fixture.scanned();
    // 未命中：第一次扫描，内容与缓存关闭基线逐字段相同（补上熔断原因等可选键之后）。
    const miss = await httpGetJson(`${fixture.base}/api/pools`);
    assert.equal(miss.status, 200);
    assert.equal(fixture.scanned() - zero, MISSION_COUNT, '首次读未命中要扫一遍');
    // 命中：TTL 内不再扫，内容逐字段相同。
    const hit = await httpGetJson(`${fixture.base}/api/pools`);
    assert.equal(hit.status, 200);
    assert.equal(fixture.scanned() - zero, MISSION_COUNT, 'TTL 内第二读不得新增扫描');
    assertSamePoolsBody(hit.json, miss.json, '命中与未命中应逐字段一致');

    // ?fresh=1 绕过缓存真重扫，并刷新缓存。
    const fresh = await httpGetJson(`${fixture.base}/api/pools?fresh=1`);
    assert.equal(fresh.status, 200);
    assert.equal(fixture.scanned() - zero, MISSION_COUNT * 2, 'fresh=1 必须真重扫一次');
    assertSamePoolsBody(fresh.json, miss.json, 'fresh 与未命中应逐字段一致');
    // fresh 之后缓存已被刷新：紧接着的普通读命中，不新增扫描。
    await httpGetJson(`${fixture.base}/api/pools`);
    assert.equal(fixture.scanned() - zero, MISSION_COUNT * 2, 'fresh 刷新后普通读应命中新缓存');

    // 未命中 + 命中 + fresh 三种内容都与缓存关闭基线逐字段相同。
    const baselineFirst = await httpGetJson(`${baseline.base}/api/pools`);
    assertSamePoolsBody(miss.json, baselineFirst.json, '未命中应与缓存关闭逐字段一致');
    assertSamePoolsBody(hit.json, baselineFirst.json, '命中应与缓存关闭逐字段一致');
    assertSamePoolsBody(fresh.json, baselineFirst.json, 'fresh 应与缓存关闭逐字段一致');
  } finally {
    await fixture.close();
    await baseline.close();
  }

  // single-flight：并发多个读共用同一次扫描。
  const concurrent = await createPoolsHealthFixture({
    missions: MISSION_COUNT,
    attemptsPerMission: ATTEMPTS_PER_MISSION,
    poolsHealthCacheMs: 15_000,
  });
  try {
    concurrent.holdAt(1);
    const pending = [
      httpGetJson(`${concurrent.base}/api/pools`),
      httpGetJson(`${concurrent.base}/api/pools`),
      httpGetJson(`${concurrent.base}/api/pools`),
    ];
    // 让扫描确实推进到 holdAt 点（held 之前已扫过第一条），再释放。
    await new Promise((resolve) => setImmediate(resolve));
    concurrent.release();
    const results = await Promise.all(pending);
    for (const result of results) assert.equal(result.status, 200);
    assertSamePoolsBody(results[1].json, results[0].json, '并发读应拿到同一份响应');
    assertSamePoolsBody(results[2].json, results[0].json, '并发读应拿到同一份响应');
    assert.equal(concurrent.scanned(), MISSION_COUNT, '同代并发读只扫一次');
  } finally {
    await concurrent.close();
  }

  // TTL 从完成开始算：拨过 TTL 后过期重扫。
  const ttl = await createPoolsHealthFixture({
    missions: MISSION_COUNT,
    attemptsPerMission: ATTEMPTS_PER_MISSION,
    poolsHealthCacheMs: 15_000,
  });
  try {
    await httpGetJson(`${ttl.base}/api/pools`);
    assert.equal(ttl.scanned(), MISSION_COUNT);
    // 未到 TTL：仍命中。
    ttl.setNow(Date.parse(POOLS_HEALTH_FIXTURE_NOW_ISO) + 14_000);
    await httpGetJson(`${ttl.base}/api/pools`);
    assert.equal(ttl.scanned(), MISSION_COUNT, 'TTL 内不得重扫');
    // 拨过 TTL：过期重扫。
    ttl.setNow(Date.parse(POOLS_HEALTH_FIXTURE_NOW_ISO) + 15_001);
    await httpGetJson(`${ttl.base}/api/pools`);
    assert.equal(ttl.scanned(), MISSION_COUNT * 2, '拨过 TTL 必须重扫');
  } finally {
    await ttl.close();
  }

  // 失败不缓存：顶层拒绝的第一次读 500，缓存里不得留东西；修好后重试可成功且扫描。
  const flaky = await createPoolsHealthFixture({
    missions: MISSION_COUNT,
    attemptsPerMission: ATTEMPTS_PER_MISSION,
    poolsHealthCacheMs: 15_000,
  });
  try {
    makeListFailing(flaky);
    const failed = await httpGetJson(`${flaky.base}/api/pools`);
    assert.equal(failed.status, 500, '扫描失败应 500');
    // 失败没进缓存：修复后重试必须真扫一遍并 200。
    const recovered = await httpGetJson(`${flaky.base}/api/pools`);
    assert.equal(recovered.status, 200, '失败之后应可重试成功');
    assert.equal(flaky.scanned(), MISSION_COUNT, '重试要真扫一遍');
    // 成功后进入正常缓存：再读命中。
    await httpGetJson(`${flaky.base}/api/pools`);
    assert.equal(flaky.scanned(), MISSION_COUNT, '成功后应命中');
  } finally {
    await flaky.close();
  }
});

test('池健康写后失效：add/configure/reset 立刻读新值，旧在途扫描不得回填新缓存', async () => {
  const principalResolverCalls: Array<string | undefined> = [];
  const operator: ControlPrincipal = { id: 'op', role: 'operator' };
  const viewer: ControlPrincipal = { id: 'vw', role: 'viewer' };
  const resolveControlPrincipal: ControlPrincipalResolver = (req) => {
    const raw = req.headers['x-coagent-control'];
    const token = Array.isArray(raw) ? raw[0] : raw;
    principalResolverCalls.push(token);
    if (token === 'op') return operator;
    if (token === 'vw') return viewer;
    if (token === 'expired') return { status: 'expired' };
    return undefined;
  };
  const circuits = new FakeCandidateCircuits();
  const fixture = await createPoolsHealthFixture({
    missions: MISSION_COUNT,
    attemptsPerMission: ATTEMPTS_PER_MISSION,
    poolsHealthCacheMs: 15_000,
    resolveControlPrincipal,
    candidateCircuits: circuits,
  });
  const control = (token?: string) =>
    token === undefined ? {} : { headers: { 'x-coagent-control': token } };
  const getPools = (token?: string, query = '') =>
    fetch(`${fixture.base}/api/pools${query}`, control(token));
  try {
    // 鉴权在缓存之外：每次请求都要走 resolver，未授权仍然被挡。
    assert.equal((await getPools()).status, 401, '无凭据应 401');
    assert.equal((await getPools('expired')).status, 401, '过期凭据应 401');
    assert.equal((await getPools('vw')).status, 200, 'viewer 可读');
    assert.equal((await getPools('op')).status, 200, 'operator 可读');
    // 每次请求都解析身份（缓存不得跳过鉴权）。
    assert.deepEqual(principalResolverCalls, [undefined, 'expired', 'vw', 'op']);
    // 写操作要求 operator：viewer 应 403，且不得改动缓存/配置。
    const viewerPost = await fetch(`${fixture.base}/api/pools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-coagent-control': 'vw' },
      body: JSON.stringify({ role: 'executor', profileId: 'exec-new', endpoint: 'local' }),
    });
    assert.equal(viewerPost.status, 403, 'viewer 写应 403');

    // 预热缓存。
    const warm = await getPools('op');
    assert.equal(warm.status, 200);
    const warmScans = fixture.scanned();
    const warmBody = (await warm.json()) as PoolsBody;
    // 注入熔断仓储后，候选的 circuit 是 closed。
    assert.equal(warmBody.executor.find((row) => row.profileId === 'exec-0')?.health.circuit.state, 'closed');

    // --- POST add：写成功后立刻失效，新 GET 看到新候选并新增扫描。---
    const addRes = await fetch(`${fixture.base}/api/pools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-coagent-control': 'op' },
      body: JSON.stringify({ role: 'executor', profileId: 'exec-new', endpoint: 'local' }),
    });
    assert.equal(addRes.status, 201);
    const afterAdd = await getPools('op');
    assert.equal(afterAdd.status, 200);
    const afterAddBody = (await afterAdd.json()) as PoolsBody;
    assert.ok(afterAddBody.executor.some((row) => row.profileId === 'exec-new'), 'add 后应看到新候选');
    assert.equal(fixture.scanned(), warmScans + MISSION_COUNT, '写后第一读必须重扫');

    // --- POST <role>/configure：先取 revision，再整角色替换。---
    const configRes = await fetch(`${fixture.base}/api/pools/config`, control('op'));
    assert.equal(configRes.status, 200);
    const revision = ((await configRes.json()) as { revision: string }).revision;
    const configureRes = await fetch(`${fixture.base}/api/pools/executor/configure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-coagent-control': 'op' },
      body: JSON.stringify({
        expectedRevision: revision,
        candidates: [
          { profileId: 'exec-only', endpoint: 'local' },
        ],
      }),
    });
    assert.equal(configureRes.status, 200, 'configure 应成功');
    const afterConfigure = await getPools('op');
    const afterConfigureBody = (await afterConfigure.json()) as PoolsBody;
    const executorIds = afterConfigureBody.executor.map((row) => row.profileId);
    assert.deepEqual(executorIds, ['exec-only'], 'configure 后只剩新候选');
    assert.equal(fixture.scanned(), warmScans + MISSION_COUNT * 2, 'configure 后第一读必须重扫');

    // --- POST circuit/reset：先开一个已知候选的熔断，再复位看到 closed。---
    // open 直接改仓储、不走 HTTP 写路由，因此不会触发失效 —— 用 fresh=1 绕过缓存读真值。
    await circuits.open({ profileId: 'exec-only', failureClass: 'quota', openUntil: null });
    const opened = (await (await getPools('op', '?fresh=1')).json()) as PoolsBody;
    assert.equal(opened.executor.find((row) => row.profileId === 'exec-only')?.health.circuit.state, 'open', '复位前应为 open');
    const resetRes = await fetch(`${fixture.base}/api/pools/${encodeURIComponent('exec-only')}/circuit/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-coagent-control': 'op' },
      body: JSON.stringify({ reason: '充值完成' }),
    });
    assert.equal(resetRes.status, 200, 'reset 应成功');
    const afterReset = await getPools('op');
    const afterResetBody = (await afterReset.json()) as PoolsBody;
    assert.equal(
      afterResetBody.executor.find((row) => row.profileId === 'exec-only')?.health.circuit.state,
      'closed',
      'reset 后第一读应看到 closed',
    );

    // --- 旧在途扫描不得回填新缓存：holdAt 悬起一次旧代扫描（fresh 强制重扫），
    //     写成功后新代先扫完并缓存，再释放旧扫描——它完成后不得把旧 snapshot 回填。---
    // 旧代扫描看到的是当前 executor=[exec-only]；写操作把它整角色换成 exec-replaced，
    // 两者内容明显不同，缓存里到底存的是哪一代一眼可辨。
    const revisionBeforeHold = ((await (await fetch(`${fixture.base}/api/pools/config`, control('op'))).json()) as { revision: string }).revision;
    fixture.holdAt(1);
    const stalePending = getPools('op', '?fresh=1');
    await new Promise((resolve) => setImmediate(resolve));
    // 旧扫描还悬着的时候写成功：代次自增、缓存与 flight 清空。
    const replaceDuringHold = await fetch(`${fixture.base}/api/pools/executor/configure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-coagent-control': 'op' },
      body: JSON.stringify({
        expectedRevision: revisionBeforeHold,
        candidates: [{ profileId: 'exec-replaced', endpoint: 'local' }],
      }),
    });
    assert.equal(replaceDuringHold.status, 200);
    // 写后新代先扫完：它写入新缓存。
    const freshAfter = await getPools('op');
    assert.equal(freshAfter.status, 200);
    const freshAfterBody = (await freshAfter.json()) as PoolsBody;
    assert.ok(freshAfterBody.executor.some((row) => row.profileId === 'exec-replaced'), '新代读必须看到写后的候选');
    // 新代缓存就位后再释放旧代扫描（它看到的是旧 snapshot），等它彻底完成。
    fixture.release();
    const stale = await stalePending;
    assert.equal(stale.status, 200);
    assert.ok(((await stale.json()) as PoolsBody).executor.some((row) => row.profileId === 'exec-only'), '旧扫描应返回它开始时的旧 snapshot');
    // 旧代完成后不得把它那份旧结果写进新缓存：紧接着的读命中且仍是新值。
    const cachedAfter = (await (await getPools('op')).json()) as PoolsBody;
    assert.ok(cachedAfter.executor.some((row) => row.profileId === 'exec-replaced'), '缓存不得被旧扫描重填');
    assert.ok(
      !cachedAfter.executor.some((row) => row.profileId === 'exec-only'),
      '旧 snapshot 的内容不得出现在新缓存里',
    );

    // 响应不泄露敏感字段：整份 body 里不应出现控制面 token。
    const serialized = JSON.stringify(cachedAfter);
    assert.ok(!serialized.includes('x-coagent-control'), '响应不得回显控制头名');
    for (const token of ['op', 'vw']) {
      assert.ok(!new RegExp(`"${token}"`).test(serialized), `响应不得回显凭据 ${token}`);
    }
  } finally {
    await fixture.close();
  }
});
