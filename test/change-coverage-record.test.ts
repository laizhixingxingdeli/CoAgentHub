/**
 * W-496：ChangeCoverage 的平台用例。
 *
 * 为什么必须走 Platform 而不是直接 append 仓储：这条规则的全部价值在于「平台核对
 * 之后才写」，绕开就测不到「哈希不符时盘上一个字节都不变」。
 *
 * ① 协调者在可修订工作项上对本工作项的 compatible 变更记下与当前工单一致的轮次
 *   与内容哈希后，仓储一条、change.coverage_recorded 只发一次；重试不新增。
 * ② 哈希不符抛 CHANGE_COVERAGE_MISMATCH 且字节不变；未装配 changeCoverages 抛
 *   CHANGE_COVERAGE_UNSUPPORTED。
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import { FixedClock } from '../src/application/in-memory.ts';
import {
  FileActivityLog,
  FileDeliveryRepository,
  FileProjectRepository,
  FileStateStore,
  PersistentIds,
} from '../src/application/file-store.ts';
import { FileChangeImpactRepository } from '../src/application/change-impact-repository.ts';
import { FileChangeCoverageRepository } from '../src/application/change-coverage-repository.ts';
import { workOrderContentHash } from '../src/application/change-receipt.ts';
import type { ChangeImpact } from '../src/application/change-impact.ts';
import { Platform } from '../src/application/platform.ts';
import { PlatformRuleError } from '../src/application/platform/context.ts';

const NOW = '2026-01-01T00:00:00.000Z';
const CONTRACT: MissionContract = { intent: '把 X 修好', acceptance: ['测试全绿'], constraints: [], nonGoals: [], guardrails: [] };
const PLAN = {
  findings: '查到了',
  rejectedHypotheses: [] as string[],
  decisions: [] as string[],
  direction: '这么改',
  risks: [] as string[],
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
const HASH = workOrderContentHash(ORDER);

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** 最小文件装配：只比 change-snapshot-review 的 harness 多一个 changeCoverages。 */
function harness(withCoverage = true) {
  const dir = mkdtempSync(join(tmpdir(), 'change-coverage-'));
  dirs.push(dir);
  const statePath = join(dir, 'state.json');
  const store = new FileStateStore(statePath);
  const clock = new FixedClock(NOW);
  const ids = new PersistentIds(store);
  const activity = new FileActivityLog(store, clock);
  const impacts = new FileChangeImpactRepository(store);
  const coverages = new FileChangeCoverageRepository(store);
  const platform = new Platform({
    projects: new FileProjectRepository(store),
    deliveries: new FileDeliveryRepository(store, clock, ids),
    activity,
    clock,
    ids,
    transaction: store,
    changeImpacts: impacts,
    ...(withCoverage ? { changeCoverages: coverages } : {}),
  });
  return { statePath, platform, activity, impacts, coverages };
}
type H = ReturnType<typeof harness>;

/** Mission + 已交卷的协调者 + 一个停在 created 的工作项：工单正文还没定稿。 */
async function start(h: H, missionId = 'M'): Promise<{ missionId: string; workItemId: string; coordinatorAttemptId: string }> {
  await h.platform.createMission({ projectId: 'P', missionId, contract: CONTRACT, origin: { clientType: 'cli', conversationRef: 'me' } });
  const coord = await h.platform.startCoordinatorAttempt(missionId);
  await h.platform.updatePlan(missionId, coord.attemptId, PLAN);
  await h.platform.submitContractCheck(missionId, coord.attemptId, { verdict: 'ok', summary: '核过' });
  const { workItemId } = await h.platform.createWorkItem(missionId, coord.attemptId, { title: 'W', order: ORDER });
  return { missionId, workItemId, coordinatorAttemptId: coord.attemptId };
}

async function appendImpact(h: H, live: { missionId: string; workItemId: string }, changeId: string): Promise<void> {
  const impact: ChangeImpact = {
    changeId,
    missionId: live.missionId,
    workItemId: live.workItemId,
    attemptId: 'A-exec',
    claimGeneration: 1,
    coordinatorAttemptId: 'coord-unused',
    claim: { id: 'h-impact', owner: 'owner', claimGeneration: 1 },
    decision: 'compatible',
    workOrderDiff: '把 step 2 换成 step 2b',
    affectedAcceptance: [1],
    reason: 'step 2b 仍可执行',
  };
  await h.impacts.append(impact);
}

test('覆盖一次落一条记录、只发一次事件；重试不新增', async () => {
  const h = harness();
  const live = await start(h);
  await appendImpact(h, live, 'C-1');
  const body = { changeId: 'C-1', orderRevision: 'r1', workOrderHash: HASH };

  const saved = await h.platform.recordChangeCoverage(live.missionId, live.coordinatorAttemptId, live.workItemId, body);
  assert.equal(saved.coordinatorAttemptId, live.coordinatorAttemptId);
  assert.equal(saved.missionId, live.missionId);
  assert.equal(saved.workItemId, live.workItemId);
  const rows = await h.coverages.listByMission(live.missionId);
  assert.equal(rows.length, 1);

  const events = (await h.activity.list(live.missionId)).filter((e) => e.kind === 'change.coverage_recorded');
  assert.equal(events.length, 1);
  const data = events[0]!.data as { changeId?: string; workOrderHash?: string };
  assert.equal(data.changeId, 'C-1');
  assert.equal(data.workOrderHash, HASH);
  // 覆盖是一条声明，不是已应用 / 已验证：事件数据里不得出现这两种措辞。
  assert.doesNotMatch(JSON.stringify(data), /已应用|已验证/);

  const again = await h.platform.recordChangeCoverage(live.missionId, live.coordinatorAttemptId, live.workItemId, body);
  assert.equal(again.changeId, saved.changeId);
  assert.equal((await h.coverages.listByMission(live.missionId)).length, 1);
  assert.equal((await h.activity.list(live.missionId)).filter((e) => e.kind === 'change.coverage_recorded').length, 1);
});

test('哈希不符拒且字节不变；未装配即 unsupported', async () => {
  const h = harness();
  const live = await start(h);
  await appendImpact(h, live, 'C-1');
  const before = readFileSync(h.statePath);
  const bad: string[] = [];
  await assert.rejects(
    h.platform.recordChangeCoverage(live.missionId, live.coordinatorAttemptId, live.workItemId, {
      changeId: 'C-1',
      orderRevision: 'r1',
      workOrderHash: `${HASH.slice(0, -1)}a`,
    }),
    (error: unknown) => {
      bad.push(String((error as Error).message));
      return error instanceof PlatformRuleError && error.code === 'CHANGE_COVERAGE_MISMATCH';
    },
  );
  assert.deepEqual(readFileSync(h.statePath), before);
  assert.equal((await h.coverages.listByMission(live.missionId)).length, 0);

  const bare = harness(false);
  const live2 = await start(bare, 'M2');
  await appendImpact(bare, live2, 'C-2');
  await assert.rejects(
    bare.platform.recordChangeCoverage(live2.missionId, live2.coordinatorAttemptId, live2.workItemId, {
      changeId: 'C-2',
      orderRevision: 'r1',
      workOrderHash: HASH,
    }),
    (error: unknown) => error instanceof PlatformRuleError && error.code === 'CHANGE_COVERAGE_UNSUPPORTED',
  );
});
