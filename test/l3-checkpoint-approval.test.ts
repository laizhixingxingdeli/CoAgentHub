/**
 * 检查点批准的两种 L3 入口：CLI（显式签名）与控制面 HTTP。
 *
 * 覆盖「答复里写明了继续但检查点门禁没解除」这条恢复通路：CLI 用真子进程 + 临时
 * 状态文件签名批准，再用本测试自己起的本机服务 POST 同一个批准全重复一次，证明
 * 幂等（不重复投 approved / resumed 事件、不改状态），并表驱动拒绝未来阈值与缺签名。
 *
 * 不读改真实状态、不碰用户常驻服务、不发外部网络；只跑本文件。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPersistentPlatform, startServer } from '../src/main.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { createApi } from '../src/api/server.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import { probeLocalWriter } from '../src/application/lock.ts';
import { GitWorktreeManager, InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import type { ControlPrincipal, ControlPrincipalResolver } from '../src/api/control-auth.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

const L3 = fileURLToPath(new URL('../src/l3.ts', import.meta.url));

/**
 * 本测试自己的控制面 resolver：只在内存里认一个 operator / viewer 头，不读任何凭据文件，
 * 也不改仓库里的 policy。沿既有 control 测试的装法，用来证明这条新入口**复用**
 * 答复升级那一格权限（viewer 403），而不是另开一格。
 */
const OPERATOR_TOKEN = 'test-operator';
const VIEWER_TOKEN = 'test-viewer';
const resolveControl: ControlPrincipalResolver = (req) => {
  const raw = req.headers['x-coagent-control'];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (token === OPERATOR_TOKEN) return { id: 'op-test', role: 'operator' } satisfies ControlPrincipal;
  if (token === VIEWER_TOKEN) return { id: 'vw-test', role: 'viewer' } satisfies ControlPrincipal;
  return undefined;
};

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: ['不得改 Contract'],
};

const PLAN = {
  findings: 'foo 一直返回 0',
  rootCause: '初始值写错了',
  rejectedHypotheses: ['不是调用方传错'],
  decisions: ['直接改初始值'],
  direction: '改 src/foo.ts',
  risks: [],
};

function order(objective: string): WorkOrder {
  return {
    objective,
    allowedScope: ['src/foo.ts'],
    requiredBehaviour: 'foo 返回 1',
    constraints: [],
    acceptance: ['foo() === 1'],
    verification: ['node --test'],
    doNot: [],
    contextRefs: [],
  };
}

function l3(statePath: string, ...args: string[]): { status: number; out: string } {
  const result = spawnSync(process.execPath, [L3, ...args, '--state', statePath], { encoding: 'utf8' });
  return { status: result.status ?? 1, out: `${result.stdout}${result.stderr}` };
}

/**
 * 同是本真子进程，但不阻塞本进程事件循环。
 *
 * 回环那一格必须用它：CLI 要连本机写者的 /api/health 才会转发，而 spawnSync 会把
 * 这里的 HTTP 服务一起卡死，探测只会超时——看上去像「转发坏了」，其实是测法不对。
 */
function l3Async(statePath: string, ...args: string[]): Promise<{ status: number; out: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [L3, ...args, '--state', statePath], { encoding: 'utf8' });
    let out = '';
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', fail);
    child.on('close', (status) => done({ status: status ?? 1, out }));
  });
}

/** 15 项 + 答复过但仍卡检查点的临时真实状态（再现 W-459 的现场）。 */
async function checkpointFixture(statePath: string): Promise<void> {
  const built = await buildPersistentPlatform(statePath, { workspace: new GitWorktreeManager(), reconcile: false });
  await built.platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT });
  const { attemptId: coord } = await built.platform.startCoordinatorAttempt('M');
  await built.platform.updatePlan('M', coord, PLAN);
  await built.platform.submitContractCheck('M', coord, { verdict: 'ok', summary: '测试契约已核对' });
  for (let n = 1; n <= 15; n += 1) {
    await built.platform.createWorkItem('M', coord, { title: `项 ${n}`, order: order(`改 ${n}`) });
  }
  await built.platform.answerEscalation('M', '批准继续，已覆盖 reject 场景');
  built.persist();
}

interface ActivityReading {
  readonly approved: ReadonlyArray<{ threshold?: number; reviewer?: string; reason?: string }>;
  readonly resumed: number;
}

async function readActivity(statePath: string, missionId: string): Promise<ActivityReading> {
  const revived = await buildPersistentPlatform(statePath, { reconcile: false });
  const events = await revived.activity.list(missionId);
  return {
    approved: events
      .filter((e) => e.kind === 'mission.work_item_checkpoint.approved')
      .map((e) => e.data as { threshold?: number; reviewer?: string; reason?: string }),
    resumed: events.filter((e) => e.kind === 'mission.resumed').length,
  };
}

test('CLI 签名批准检查点 15；本机 HTTP 重复批准幂等；表驱动拒绝未来阈值与缺签名', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-cp-approve-'));
  const statePath = join(dir, 'state.json');
  const serverResult = { server: undefined as ReturnType<typeof createApi> | undefined };
  try {
    await checkpointFixture(statePath);

    // 失败表：CLI 与 HTTP 同一批形状。表驱动塞在一条 test 里——每条只是「输进来的
    // 三元组不对」，不值得各自起一份临时状态。
    // 未来阈值是**领域**错误（Platform 规则：没到/不许提前批）→ 409；形状与签名错误 → 400。
    const bad: ReadonlyArray<{ name: string; cli: string[]; http: unknown; httpStatus: number }> = [
      {
        name: '未来阈值 30（没到 15 就别替用户提前批）',
        cli: ['--threshold', '30', '--as', 'L3-cli', '--reason', '提前批准'],
        http: { threshold: 30, reviewer: 'L3-http', reason: '提前批准' },
        httpStatus: 409,
      },
      { name: '缺 --as / reviewer', cli: ['--threshold', '15', '--reason', '继续'], http: { threshold: 15, reason: '继续' }, httpStatus: 400 },
      { name: '空 reviewer', cli: ['--threshold', '15', '--as', '   ', '--reason', '继续'], http: { threshold: 15, reviewer: '   ', reason: '继续' }, httpStatus: 400 },
      { name: '缺 --reason / reason', cli: ['--threshold', '15', '--as', 'L3-cli'], http: { threshold: 15, reviewer: 'L3-http' }, httpStatus: 400 },
      { name: '空 reason', cli: ['--threshold', '15', '--as', 'L3-cli', '--reason', '  '], http: { threshold: 15, reviewer: 'L3-cli', reason: '  ' }, httpStatus: 400 },
      { name: 'threshold 非 15 倍数', cli: ['--threshold', '16', '--as', 'L3-cli', '--reason', '继续'], http: { threshold: 16, reviewer: 'L3-http', reason: '继续' }, httpStatus: 400 },
      { name: 'threshold 非整数', cli: ['--threshold', '15.5', '--as', 'L3-cli', '--reason', '继续'], http: { threshold: 15.5, reviewer: 'L3-http', reason: '继续' }, httpStatus: 400 },
      { name: 'threshold 非正数', cli: ['--threshold', '-15', '--as', 'L3-cli', '--reason', '继续'], http: { threshold: -15, reviewer: 'L3-http', reason: '继续' }, httpStatus: 400 },
      { name: 'threshold 不是数字', cli: ['--threshold', '十五', '--as', 'L3-cli', '--reason', '继续'], http: { threshold: '15', reviewer: 'L3-http', reason: '继续' }, httpStatus: 400 },
    ];

    const before = await readActivity(statePath, 'M');
    assert.deepEqual(before.approved, [], '批准前没有 approved 事件');

    for (const row of bad) {
      const failed = l3(statePath, 'checkpoint', 'approve', 'M', ...row.cli);
      assert.notEqual(failed.status, 0, `CLI 应拒绝：${row.name}`);
      const afterCli = await readActivity(statePath, 'M');
      assert.deepEqual(afterCli, before, `CLI 失败不得留痕：${row.name}`);
    }

    // 缺 --as 时不能把下一项 --reason 当成检视者：形状对，但签名的人变了。
    const swapped = l3(statePath, 'checkpoint', 'approve', 'M', '--threshold', '15', '--as', '--reason');
    assert.notEqual(swapped.status, 0, '--as 缺值要把下一项当成缺值，不是签名');
    assert.match(swapped.out, /--as/);

    // 真 CLI 子进程 + 显式 --state：签名批准生效。
    const approved = l3(statePath, 'checkpoint', 'approve', 'M', '--threshold', '15', '--as', 'L3-cli', '--reason', '答复未解门禁，显式签名批准');
    assert.equal(approved.status, 0, approved.out);
    assert.match(approved.out, /检查点 15 已批准/);

    // 重复调用同样成功（幂等），且不重写事件。
    const repeated = l3(statePath, 'checkpoint', 'approve', 'M', '--threshold', '15', '--as', 'L3-cli', '--reason', '答复未解门禁，显式签名批准');
    assert.equal(repeated.status, 0, repeated.out);
    assert.match(repeated.out, /此前已批准/);

    const afterCliApproval = await readActivity(statePath, 'M');
    assert.equal(afterCliApproval.approved.length, 1, 'CLI 两次批准只投一条 approved');
    assert.equal(afterCliApproval.approved[0]?.reviewer, 'L3-cli');
    assert.equal(afterCliApproval.approved[0]?.threshold, 15);

    const view = await (await buildPersistentPlatform(statePath, { reconcile: false })).platform.getMissionView('M');
    assert.equal(view.waitReason, undefined, '批准后不再停在检查点');

    // 本机服务：本测试自己起的那一台，不是用户常驻服务。带 control resolver，
    // 好让「沿用答复升级那一格权限」这条验收有东西可验。
    const built = await buildPersistentPlatform(statePath, { workspace: new GitWorktreeManager(), reconcile: false });
    const api = createApi({
      platform: built.platform,
      tokens: new RunTokenRegistry(),
      deliveries: built.deliveries,
      onMutation: built.persist,
      resolveControlPrincipal: resolveControl,
    });
    serverResult.server = api;
    await listenLoopback(api, 0);
    // 不拿主锁、不发回环身份：这一段只验 HTTP 那一层（鉴权格 + 输入形状 + 幂等）。
    const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    const post = (body: unknown, token = OPERATOR_TOKEN) =>
      fetch(`${base}/api/missions/M/checkpoint/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-coagent-control': token },
        body: JSON.stringify(body),
      });

    // 权限沿用答复升级那一格：viewer 与无凭据都被挡在 Platform 之前。
    const asViewer = await post({ threshold: 15, reviewer: 'L3-http', reason: '继续' }, VIEWER_TOKEN);
    assert.equal(asViewer.status, 403, await asViewer.text());
    const anonymous = await fetch(`${base}/api/missions/M/checkpoint/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threshold: 15, reviewer: 'L3-http', reason: '继续' }),
    });
    assert.equal(anonymous.status, 401, await anonymous.text());

    for (const row of bad) {
      const res = await post(row.http);
      const text = await res.text();
      assert.equal(res.status, row.httpStatus, `HTTP 应拒「${row.name}」：${text}`);
      const afterHttp = await readActivity(statePath, 'M');
      assert.deepEqual(afterHttp, afterCliApproval, `HTTP 失败不得留痕：${row.name}`);
    }

    // 同一个批准再走一次 HTTP：幂等——不多一条 approved，也不多一条 resumed。
    const first = await post({ threshold: 15, reviewer: 'L3-http', reason: '答复未解门禁，显式签名批准' });
    const firstText = await first.text();
    assert.equal(first.status, 200, firstText);
    assert.deepEqual(JSON.parse(firstText) as { threshold: number; approved: boolean; alreadyApproved: boolean }, {
      threshold: 15,
      approved: true,
      alreadyApproved: true,
    });

    const second = await post({ threshold: 15, reviewer: 'L3-http', reason: '答复未解门禁，显式签名批准' });
    const secondText = await second.text();
    assert.equal(second.status, 200, secondText);
    assert.equal((JSON.parse(secondText) as { alreadyApproved: boolean }).alreadyApproved, true);

    const afterHttp = await readActivity(statePath, 'M');
    assert.deepEqual(afterHttp, afterCliApproval, 'HTTP 重复批准不投新事件');

    // 签名批准不碰升级历史与费用上限。
    const finalRevived = await buildPersistentPlatform(statePath, { reconcile: false });
    const mission = (await finalRevived.projects.list()).flatMap((p) => p.missions).find((m) => m.id === 'M')!;
    assert.equal(mission.workItems.length, 15);
    assert.ok(mission.costCap > 0, 'costCap 未被批准动作改写');

    // 这一段用完就关：下面要换一台真正持主锁的服务，不能两个写者同时开着。
    serverResult.server = undefined;
    await new Promise<void>((done) => {
      if (!api.listening) return done();
      api.close(() => done());
    });

    // 用法里要有这一行：入口多了但没写进 help，下次还是找不到。
    const usage = l3(statePath, 'nope-not-a-command');
    assert.match(usage.out, /checkpoint approve/);

    // 下一个检查点：再建 15 项后停等 30，CLI 这次经**回环**（本机持锁写者）批准。
    const grown = await buildPersistentPlatform(statePath, { workspace: new GitWorktreeManager(), reconcile: false });
    const { attemptId: coordAgain } = await grown.platform.startCoordinatorAttempt('M');
    for (let n = 16; n <= 30; n += 1) {
      await grown.platform.createWorkItem('M', coordAgain, { title: `项 ${n}`, order: order(`改 ${n}`) });
    }
    grown.persist();
    const at30 = await (await buildPersistentPlatform(statePath, { reconcile: false })).platform.getMissionView('M');
    assert.equal(at30.waitReason, 'work_item_checkpoint');
    assert.equal(at30.openEscalations[0]?.platformGate?.threshold, 30);

    // 真持锁写者：startServer 拿主锁并发布回环端口，CLI 探测到 live 就该转发而不是本地再写一份。
    const held = await startServer(0, statePath, {
      env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '0' },
      workspace: new InPlaceWorkspaceManager(),
    });
    serverResult.server = held.server;
    try {
      assert.equal((await probeLocalWriter(statePath)).status, 'live', '本测试服务应被探测为活着的本机写者');
      const forwarded = await l3Async(statePath, 'checkpoint', 'approve', 'M', '--threshold', '30', '--as', 'L3-cli', '--reason', '第 30 项检查点');
      assert.equal(forwarded.status, 0, forwarded.out);
      assert.match(forwarded.out, /检查点 30 已批准/);

      // 回环批准要落在持锁服务那份状态上：重开进程仍看得到两条 approved。
      const after30 = await readActivity(statePath, 'M');
      assert.deepEqual(after30.approved.map((a) => a.threshold), [15, 30]);
      assert.equal(after30.approved[1]?.reviewer, 'L3-cli');
    } finally {
      serverResult.server = undefined;
      await new Promise<void>((done) => {
        if (!held.server.listening) return done();
        held.server.close(() => done());
      });
    }
  } finally {
    serverResult.server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
