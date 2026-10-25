/**
 * FileActivityLog 接上 ActivityIndex 之后的差分回归。
 *
 * 为什么是差分而不是"新实现自己长什么样"的断言：索引唯一的价值是**行为不变**。
 * 写成"返回了这几条事件"只能锁住眼下这一版，索引里任何一处失效判据写错——
 * 该重建时只读尾巴、或者该读尾巴时整表重建——都可能让某一侧悄悄陈旧。所以每个
 * 阶段都把新 list 与旧 filter 在**同一份**事件序列上逐 missionId 对照：旧写法
 * 是从改前的实现里原样抄下来的（refresh → 归档分支 → filter），它就是基准。
 *
 * 为什么选真实 FileStateStore + 临时 state.json：索引错的两种情形（事务回滚换数组、
 * 外部改写触发重载）都发生在文件存储的生命周期里，内存替身复现不出来。
 *
 * 为什么只有一条 test（契约 AC5 上限 3 条，本单占 1 条）：四个阶段共享同一份
 * 构造与比较helper，拆开只会让"同一序列上比较"这件事变形。
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileActivityLog,
  FileProjectRepository,
  FileStateStore,
} from '../src/application/file-store.ts';
import { Project } from '../src/kernel/index.ts';
import type { MissionSnapshot } from '../src/kernel/snapshot.ts';
import type { ActivityEvent } from '../src/application/ports.ts';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-file-activity-index-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

const FIXED_CLOCK = { now: () => new Date('2026-03-21T00:00:00.000Z') };

const CONTRACT = {
  intent: '差分回归样例',
  acceptance: ['ok'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const PLAN = {
  findings: 'f',
  rootCause: 'r',
  rejectedHypotheses: [] as string[],
  decisions: [] as string[],
  direction: 'd',
  risks: [] as string[],
};

const USAGE = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  total: 15,
  cost: 0,
  quality: 'reported' as const,
};

/**
 * 用 Domain 走合法流转生成可 restore 的终态快照。
 *
 * 为什么不直接写一个 status:'completed' 的对象：archived 归档要求真终态
 * （archiveMission 会拒非终态 Mission），而 restore 只认得出合法流转留下来的
 * 形状。照抄 test/file-store-archive-read.test.ts 的那条流转，别自创。
 */
function buildTerminalMission(projectId: string, missionId: string): MissionSnapshot {
  const project = Project.create({ id: projectId });
  const mission = project.createMission({
    id: missionId,
    contract: CONTRACT,
    origin: { clientType: 'claude-code', conversationRef: 'conv-arch' },
  });
  mission.touch('2026-01-01T00:00:00.000Z');
  mission.startPlanning();
  mission.updatePlan(PLAN);

  const coord = mission.startCoordinatorAttempt();
  coord.recordUsage(USAGE);
  coord.recordEndReason('structured_submit');
  coord.succeed();

  mission.startExecuting();
  const item = mission.createWorkItem({ id: 'W-1', title: 'archived work' });
  item.dispatch();
  const attempt = item.startAttempt();
  attempt.addEvidence({
    id: 'E-1',
    attemptId: attempt.id,
    kind: 'test',
    summary: 'node --test 全绿',
    command: 'node --test',
    exitCode: 0,
  });
  attempt.recordUsage(USAGE);
  attempt.recordEndReason('structured_submit');
  attempt.succeed();
  item.submit({
    outcome: 'completed',
    summary: '改好了',
    changedFiles: ['src/foo.ts'],
    evidenceIds: ['E-1'],
    notes: '',
  });
  item.review('accept', { attemptId: attempt.id, reasons: ['ok'], requiredChanges: [] });

  mission.recordResult({
    outcome: 'delivered',
    summary: 'done',
    acceptanceEvidence: ['e'],
    memoryDelta: [],
    openRisks: [],
  });
  mission.submitForReview();
  mission.complete({ verdict: 'merge', reasons: ['ok'] });
  return mission.toSnapshot();
}

/** 只到 planning 的在途 Mission：能活着拿 append 事件，但归档会被拒。 */
function buildLiveMission(projectId: string, missionId: string): MissionSnapshot {
  const project = Project.create({ id: projectId });
  const mission = project.createMission({
    id: missionId,
    contract: { ...CONTRACT, intent: '在途' },
    origin: { clientType: 'claude-code', conversationRef: `conv-${missionId}` },
  });
  mission.touch('2026-02-01T00:00:00.000Z');
  return mission.toSnapshot();
}

/** 造一份最小可读的 state.json：一个项目、两条在途 Mission、一条终态 Mission。 */
function writeInitialState(statePath: string): void {
  const state = {
    version: 1,
    projects: [
      {
        id: 'P1',
        missions: [
          buildLiveMission('P1', 'M-a'),
          buildLiveMission('P1', 'M-b'),
          buildTerminalMission('P1', 'M-arch'),
        ],
      },
    ],
    deliveries: [],
    events: [],
    idCounters: {},
    agentPool: [],
    archivedMissions: [],
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * 旧基准：非归档 = 改前的 `raw().events.filter`，归档 = `(await log.all()).filter`。
 *
 * 为什么归档那侧不拿 `store.archivedEvents(missionId)` 当基准：那正是新 list 在归档
 * 分支里直接返回的东西（`return this.#store.archivedEvents(missionId)`）——拿它比对等于
 * 自己跟自己比，这条分支永远绿。`all()` 走的是另一条路（`allEventsMerged`：main +
 * 各 package 按 archivedAt 接上），它跟 package 分支是否一致是真有信息量的检查。
 *
 * 为什么非归档那侧不也给 `all()`：`all()` 会把 package 也拼进来，而待比的就是
 * 工作集范围，混进归档包就不再是「改前那次 filter」了。
 */
async function legacyList(
  store: FileStateStore,
  log: FileActivityLog,
  missionId: string,
): Promise<readonly ActivityEvent[]> {
  store.refreshIfChanged();
  if (store.hasArchivedMission(missionId)) {
    return (await log.all()).filter((event) => event.missionId === missionId);
  }
  return store.raw().events.filter((event) => event.missionId === missionId);
}

const IDS = ['M-a', 'M-b', 'M-arch', '', 'M-missing'] as const;

/**
 * 逐 ID 对照新旧 list。
 *
 * 为什么每条 acceptance 都断言 strictEqual：AC1 要求"逐个相同"，deepEqual 只比内容，
 * 换了对象引用照样过——而引用相同正是增量只读尾巴的前提。
 */
async function assertMatchesLegacy(store: FileStateStore, log: FileActivityLog, label: string) {
  for (const missionId of IDS) {
    const expected = await legacyList(store, log, missionId);
    const actual = await log.list(missionId);
    assert.deepEqual(
      actual.map((e) => `${e.missionId}:${e.kind}`),
      expected.map((e) => `${e.missionId}:${e.kind}`),
      `${label}：missionId=${JSON.stringify(missionId)} 内容/顺序应与旧 filter 一致`,
    );
    assert.equal(actual.length, expected.length, `${label}：missionId=${JSON.stringify(missionId)} 长度一致`);
    for (let i = 0; i < expected.length; i += 1) {
      assert.strictEqual(actual[i], expected[i], `${label}：missionId=${JSON.stringify(missionId)} 第 ${i} 项须是同一对象`);
    }
  }
}

/** 只对非归档 ID 检查"返回新数组"：归档分支返回的是包里的 events。 */
async function assertFreshArrayPerCall(log: FileActivityLog, missionId: string, label: string) {
  const first = await log.list(missionId);
  const second = await log.list(missionId);
  assert.notStrictEqual(first, second, `${label}：missionId=${JSON.stringify(missionId)} 每次都要新数组`);
  assert.deepEqual(
    first.map((e) => e.kind),
    second.map((e) => e.kind),
  );
  // 调用方往返回数组里塞东西/改下标，之后的结果不得受影响。
  first.push({ at: '2026-01-01T00:00:00.000Z', projectId: 'P1', missionId, kind: 'polluted', data: null });
  if (first.length > 0) first[0] = { at: '2026-01-01T00:00:00.000Z', projectId: 'P1', missionId, kind: 'polluted', data: null };
  const third = await log.list(missionId);
  assert.deepEqual(
    third.map((e) => e.kind),
    second.map((e) => e.kind),
    `${label}：missionId=${JSON.stringify(missionId)} 改动返回数组不得污染后续结果`,
  );
}

/** 把 state.json 读回、按改写函数加工后写回；utimesSync 让 mtime 明确变化。 */
function rewriteStateFile(statePath: string, mutate: (state: Record<string, unknown>) => void): void {
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
  mutate(state);
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const future = new Date(Date.now() + 60_000);
  utimesSync(statePath, future, future);
}

test('FileActivityLog 接索引后与旧 filter 差分一致：连续 append、事务回滚后再追加、归档后继续 append、外部文件触发重载', async () => {
  const statePath = tempStatePath();
  writeInitialState(statePath);
  const store = new FileStateStore(statePath);
  const projects = new FileProjectRepository(store);
  const log = new FileActivityLog(store, FIXED_CLOCK);

  const append = (missionId: string, kind: string, data: unknown = {}) =>
    log.append({ projectId: 'P1', missionId, kind, data });

  /* ---- 阶段 1：交错连续 append 到两个 Mission 与空串 ID ---- */
  // 先给待归档 Mission 一条事件：归档包里的 events 就是这条，归档分支才验得出东西。
  await append('M-arch', 'note.before_archive', { n: 0 });
  await append('M-a', 'note', { n: 1 });
  await append('', 'project.execution_configured', { n: 2 });
  await append('M-b', 'note', { n: 3 });
  await append('M-a', 'note', { n: 4 });
  await append('', 'note', { n: 5 });
  await append('M-b', 'note', { n: 6 });
  await assertMatchesLegacy(store, log, '阶段1(连续 append)');
  for (const id of ['M-a', 'M-b', '', 'M-missing']) await assertFreshArrayPerCall(log, id, '阶段1');

  /* ---- 阶段 2：事务内 append 后抛错回滚，再追加到完全相同的长度 ----
   *
   * 危险路径：「回滚又把数组换回开事务时的快照副本」，紧接着再 append 到同一长度——
   * 只比长度的话索引会停在回滚尾部的错内容上。事务内那次 list 是刻意的：它让索引
   * 先吃过那段不该留下的尾巴，回滚后的相等才有说服力。
   */
  const beforeTx = store.raw().events.length;
  await assert.rejects(
    store.run(async () => {
      await append('M-a', 'note.to_rollback', { doomed: true });
      await append('M-b', 'note.to_rollback', { doomed: true });
      await assertMatchesLegacy(store, log, '阶段2(事务内)');
      assert.equal(store.raw().events.length, beforeTx + 2, '事务内应能看见刚追加的两条');
      throw new Error('差分测试：事务半路失败');
    }),
    /差分测试：事务半路失败/,
  );
  assert.equal(store.raw().events.length, beforeTx, '回滚应把事件数撤回事务前');
  // 中间不插任何 list：索引必须自己认出数组换了。追加到与回滚前相同的长度。
  await append('M-b', 'note.after_rollback', { n: 7 });
  await append('M-a', 'note.after_rollback', { n: 8 });
  assert.equal(store.raw().events.length, beforeTx + 2, '此时长度与事务抛错前相同');
  await assertMatchesLegacy(store, log, '阶段2(回滚后同长度)');
  const rolled = await log.list('M-a');
  assert.equal(
    rolled.some((e) => e.kind === 'note.to_rollback'),
    false,
    '回滚尾部不得泄漏到索引结果里',
  );
  const rolledB = await log.list('M-b');
  assert.equal(
    rolledB.some((e) => e.kind === 'note.to_rollback'),
    false,
    '回滚尾部不得留在 M-b 的索引结果里',
  );
  assert.deepEqual(
    rolledB.map((e) => e.kind),
    ['note', 'note', 'note.after_rollback'],
    'M-b 应只剩合法追加（两条 note + 回滚后的追加）',
  );

  /* ---- 阶段 3：归档一条终态 Mission，继续向存活 Mission 与空串 ID append ---- */
  store.archiveMission('P1', 'M-arch');
  assert.equal(store.hasArchivedMission('M-arch'), true);
  await append('M-a', 'note.after_archive', { n: 9 });
  await append('', 'note.after_archive', { n: 10 });
  await append('M-b', 'note.after_archive', { n: 11 });
  await assertMatchesLegacy(store, log, '阶段3(归档后继续 append)');
  const archived = await log.list('M-arch');
  assert.deepEqual(
    archived.map((e) => e.kind),
    ['note.before_archive'],
    '归档分支仍走 package，且看得到归档那条',
  );
  // 归档分支返回的是包里的 events（原来的实现直接返回它，本单保留该分支）：
  // 不在这里对返回数组做破坏性改动，改后再读一次不得变形。
  const archivedAgain = await log.list('M-arch');
  assert.deepEqual(archivedAgain.map((e) => e.kind), ['note.before_archive']);
  for (const id of ['M-a', 'M-b', '', 'M-missing']) await assertFreshArrayPerCall(log, id, '阶段3');
  // 还活着的 Mission 不应被归档影响。
  await assertMatchesLegacy(store, log, '阶段3(复验)');

  /* ---- 阶段 4：外部改写状态文件，由 list 自己触发 refreshIfChanged ---- */
  // 先 list 一次让索引吃完当前数组，再改盘：不这样，索引本来就要整表重建，
  // 测出来的不是"外部改动被认出来"。
  await log.list('M-a');
  rewriteStateFile(statePath, (state) => {
    const events = state.events as ActivityEvent[];
    events.push({ at: '2026-04-01T00:00:00.000Z', projectId: 'P1', missionId: 'M-a', kind: 'external.note', data: { from: 'disk' } });
    // 把 M-b 的全部 note 改名：只要有一条被索引漏掉（索引停在旧数组上），
    // 下面就能看到旧 kind 残留。
    let replaced = 0;
    for (let i = 0; i < events.length; i += 1) {
      if (events[i]!.missionId !== 'M-b' || events[i]!.kind !== 'note') continue;
      events[i] = { at: '2026-04-01T00:00:01.000Z', projectId: 'P1', missionId: 'M-b', kind: 'external.replaced', data: { from: 'disk' } };
      replaced += 1;
    }
    assert.ok(replaced >= 1, '夹具里应有可替换的 M-b 事件');
  });
  // 取 raw 参考必须在 list 触发重载之后：重载会换掉 events 数组对象。
  const actualA = await log.list('M-a');
  const reloaded = store.raw().events;
  assert.deepEqual(
    actualA.map((e) => e.kind),
    reloaded.filter((e) => e.missionId === 'M-a').map((e) => e.kind),
    '外部改写后 list 必须看到盘上的新内容',
  );
  assert.equal(actualA.some((e) => e.kind === 'external.note'), true);
  const actualB = await log.list('M-b');
  assert.equal(actualB.some((e) => e.kind === 'external.replaced'), true);
  assert.equal(actualB.some((e) => e.kind === 'note'), false, '被替换掉的旧事件不得留下');
  await assertMatchesLegacy(store, log, '阶段4(外部改写后)');

  await projects.persist();
});
