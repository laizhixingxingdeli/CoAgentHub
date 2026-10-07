/**
 * 验收处置工具的真实 HTTP 组合测试（W-504）。
 *
 * 为什么单独一个文件：这里要验的是「身份从 x-coagent-run 进来 → 门禁在 readJson
 * 之前 → 处置落在真实 Platform + File 事务里」这条链路。直接调 Platform 测出来的
 * 「通过」不覆盖 HTTP 层那第四组分流。
 *
 * 为什么用真实 FileStateStore：内存版没有事务回滚，「拒绝之后盘上有没有多一条」
 * 这句话在内存版上根本测不到。拒绝必须是逐字节不改。
 *
 * 门禁刻意不开 acceptanceEvidenceGate：这一条单只验 HTTP 分流与形状，验收门那条
 * 规则另有其测（acceptance-disposition-gate.test.ts）。
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import { FixedClock } from '../src/application/in-memory.ts';
import {
  FileActivityLog,
  FileDeliveryRepository,
  FileProjectRepository,
  FileStateStore,
  FileValidationReportRepository,
  PersistentIds,
} from '../src/application/file-store.ts';
import { FileChangeImpactRepository } from '../src/application/change-impact-repository.ts';
import { FileContractHistoryRepository } from '../src/application/contract-history-repository.ts';
import { FileAcceptanceDispositionRepository } from '../src/application/acceptance-disposition-repository.ts';
import { Platform } from '../src/application/platform.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { createApi } from '../src/api/server.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

const NOW = '2026-01-01T00:00:00.000Z';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['旧口径', '另一条'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const PLAN = {
  findings: '查到了',
  rejectedHypotheses: [] as string[],
  decisions: [] as string[],
  direction: '这么改',
  risks: [] as string[],
};

/** criteria:[1] 才是「这个工单自己声明覆盖第 1 条口径」，缺省一律不算。 */
const ORDER: WorkOrder = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
  criteria: [1],
};

const TOOL = '/api/agent/coagent_record_acceptance_disposition';

const dirs: string[] = [];
const servers: Server[] = [];
after(async () => {
  for (const server of servers) await closeServer(server);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly statePath: string;
  readonly clock: FixedClock;
  readonly platform: Platform;
  readonly tokens: RunTokenRegistry;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-disposition-http-'));
  dirs.push(dir);
  const statePath = join(dir, 'state.json');
  // 处置仓储与其它仓储共用同一个 FileStateStore：事务边界就是这一个文件。
  const store = new FileStateStore(statePath);
  const clock = new FixedClock(NOW);
  const ids = new PersistentIds(store);
  const platform = new Platform({
    projects: new FileProjectRepository(store),
    deliveries: new FileDeliveryRepository(store, clock, ids),
    activity: new FileActivityLog(store, clock),
    clock,
    ids,
    transaction: store,
    changeImpacts: new FileChangeImpactRepository(store),
    contractHistories: new FileContractHistoryRepository(store),
    acceptanceDispositions: new FileAcceptanceDispositionRepository(store),
    // 处置要拿报告仓储核对「证据是不是按当前工单这套命令跑出来的」：不装配的话
    // 缺仓储备会被拒成 UNSUPPORTED，这里的 409 就测不到越界这一条了。
    validation: {
      engine: {
        validate: async () => {
          throw new Error('unused');
        },
      },
      reports: new FileValidationReportRepository(store),
    },
  });
  return { statePath, clock, platform, tokens: new RunTokenRegistry() };
}

async function startApi(h: Harness): Promise<string> {
  const server = createApi({ platform: h.platform, tokens: h.tokens });
  servers.push(server);
  await listenLoopback(server, 0);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * 建一个「协调者已开工、有一个点名第 1 条口径的工作项」的真实装配，返回三种牌。
 *
 * 普通协调者牌由 tokens.issue 发且**不带 claim、不带 purpose**：处置说的是 L2 这一
 * 趟 hop 对整份契约的判断，不该要求队列领取身份，也不该要求 workItemId。
 */
async function buildTokens(h: Harness): Promise<{
  readonly missionId: string;
  readonly execToken: string;
  readonly reviewerToken: string;
  readonly impactToken: string;
  readonly coordinatorToken: string;
}> {
  const missionId = 'M-1';
  await h.platform.createMission({
    projectId: 'P',
    missionId,
    contract: CONTRACT,
    origin: { clientType: 'cli', conversationRef: 'me' },
  });
  const coord = await h.platform.startCoordinatorAttempt(missionId);
  await h.platform.updatePlan(missionId, coord.attemptId, PLAN);
  await h.platform.submitContractCheck(missionId, coord.attemptId, { verdict: 'ok', summary: '核过' });
  const { workItemId } = await h.platform.createWorkItem(missionId, coord.attemptId, {
    title: 'W1',
    order: ORDER,
  });

  const execAttempt = 'W-1.exec-1';
  const execToken = h.tokens.issue({
    missionId,
    attemptId: execAttempt,
    role: 'executor',
    workItemId,
  }).token;
  const reviewerToken = h.tokens.issue({
    missionId,
    attemptId: execAttempt,
    role: 'independent_reviewer',
    workItemId,
  }).token;
  const impactToken = h.tokens.issue({
    missionId,
    attemptId: coord.attemptId,
    role: 'coordinator',
    purpose: 'impact',
    changeId: 'CH-1',
    claim: { id: 'h-impact', owner: 'owner', claimGeneration: 1 },
  }).token;
  const coordinatorToken = h.tokens.issue({
    missionId,
    attemptId: coord.attemptId,
    role: 'coordinator',
  }).token;
  return { missionId, execToken, reviewerToken, impactToken, coordinatorToken };
}

/** raw 用非法 JSON 是为了证明门禁在读 body 之前：能到 403 就说明 body 没被解析。 */
async function postRaw(
  base: string,
  raw: string,
  token: string,
): Promise<{ status: number; json: Record<string, unknown> & { error?: string } }> {
  const res = await fetch(`${base}${TOOL}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-coagent-run': token },
    body: raw,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function postJson(
  base: string,
  body: unknown,
  token: string,
): Promise<{ status: number; json: Record<string, unknown> & { error?: string } }> {
  return postRaw(base, JSON.stringify(body), token);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function diskBytes(statePath: string): string {
  return readFileSync(statePath, 'utf8');
}

test('真实 HTTP：错身份 403、body 多字段 400、越界 index 409，全部零副作用', async () => {
  const h = harness();
  const base = await startApi(h);
  const fx = await buildTokens(h);

  /** 每次拒绝前读盘、拒绝后比字节：门禁失败不得改动盘文件一个字节。 */
  const reject = async (
    token: string,
    expected: number,
    code: string,
    raw: string = 'not-json',
  ): Promise<void> => {
    const before = diskBytes(h.statePath);
    const res = await postRaw(base, raw, token);
    assert.equal(res.status, expected, `应 ${expected}，实际 ${res.status} ${JSON.stringify(res.json)}`);
    assert.equal(res.json.error, code, `${TOOL} 错误码：${JSON.stringify(res.json)}`);
    assert.equal(diskBytes(h.statePath), before, '被拒不得改动盘文件字节');
  };

  // —— 错身份：403，且非法 JSON 也是 403 而不是 400（证明门禁在 readJson 之前）——
  await reject(fx.execToken, 403, 'ACTION_DENIED');
  await reject(fx.reviewerToken, 403, 'ACTION_DENIED');
  await reject(fx.impactToken, 403, 'ACTION_DENIED');

  // —— body 多一个身份字段：400，字节不变 ——
  await reject(
    fx.coordinatorToken,
    400,
    'BAD_REQUEST',
    JSON.stringify({
      dispositionId: 'D-1',
      index: 1,
      decision: 'revalidate',
      workItemIds: ['W-1'],
      basis: { note: '复验' },
      missionId: fx.missionId,
    }),
  );

  // —— 形状合法但业务不允许：409，不是 403 也不是 404 ——
  const outOfRange = await postJson(
    base,
    {
      dispositionId: 'D-1',
      index: 99,
      decision: 'revalidate',
      workItemIds: ['W-1'],
      basis: { note: '复验' },
    },
    fx.coordinatorToken,
  );
  const before = diskBytes(h.statePath);
  assert.equal(outOfRange.status, 409, `应 409，实际 ${outOfRange.status} ${JSON.stringify(outOfRange.json)}`);
  assert.equal(outOfRange.json.error, 'ACCEPTANCE_DISPOSITION_REJECTED', JSON.stringify(outOfRange.json));
  assert.equal(diskBytes(h.statePath), before, '业务拒绝不得改动盘文件字节');

  // 全程零处置落盘、零处置事件。
  const disk = JSON.parse(diskBytes(h.statePath));
  assert.deepEqual(disk.acceptanceDispositions, [], '拒绝之后不该有任何处置落盘');
  assert.deepEqual(
    disk.events.filter((event: { kind: string }) => event.kind === 'acceptance.disposition_recorded'),
    [],
    '拒绝不得发处置事件',
  );
  // 牌没有被吊销：门禁拒绝不等于这张牌作废。
  assert.equal(h.tokens.resolve(fx.coordinatorToken)?.role, 'coordinator');
});
