/**
 * Project Memory（S04）。
 *
 * 核心判据只有一条：**memory 的改动跟代码同一次 merge 落地**。
 * 分两次提交的话，"代码进去了文档没进去"就会发生，而且没人会发现——
 * 一年之后 .coagent/ 描述的是一个已经不存在的系统。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform } from '../src/application/platform.ts';
import {
  applyMemoryDelta,
  generateVibe,
  initProjectMemory,
  readProjectMemory,
} from '../src/application/project-memory.ts';
import { GitWorktreeManager } from '../src/application/workspace.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const ORDER: WorkOrder = {
  objective: '改 a.txt',
  allowedScope: ['a.txt'],
  requiredBehaviour: 'a.txt 变成 mission',
  constraints: [],
  acceptance: ['内容是 mission'],
  verification: ['cat a.txt'],
  doNot: [],
  contextRefs: [],
};

const PLAN = {
  findings: 'f',
  rejectedHypotheses: [],
  decisions: [],
  direction: 'd',
  risks: [],
};

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function tempRepo(withMemory = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-mem-'));
  dirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@local');
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  if (withMemory) {
    initProjectMemory(dir, 'demo');
    mkdirSync(join(dir, '.coagent', 'specs'), { recursive: true });
    writeFileSync(
      join(dir, '.coagent', 'specs', 'scheduling.md'),
      '# 调度\n\n同一 Project 同时只有一个 Mission 在改代码。\n',
    );
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('读写 .coagent/', () => {
  test('init 只建骨架，不预填一堆没人信的模板文字', () => {
    const repo = tempRepo();
    const created = initProjectMemory(repo, 'demo');
    assert.ok(created.includes('.coagent/project.yaml'));
    assert.ok(created.includes('.coagent/architecture/constitution.md'));

    const memory = readProjectMemory(repo);
    assert.equal(memory.exists, true);
    assert.equal(memory.projectName, 'demo');
    assert.deepEqual(memory.specs, [], '刚建好不该有任何 Living Spec');
  });

  test('重复 init 不覆盖已有内容', () => {
    const repo = tempRepo();
    initProjectMemory(repo, 'demo');
    const path = join(repo, '.coagent', 'architecture', 'constitution.md');
    writeFileSync(path, '# 架构约束\n\n我自己写的东西\n', 'utf8');
    const second = initProjectMemory(repo, 'demo');
    assert.equal(second.length, 0, '第二次不该再建任何文件');
    assert.match(readFileSync(path, 'utf8'), /我自己写的东西/);
  });

  test('VIBE.md 写明它是生成物 —— 不写的话总有人往里加东西然后丢掉', () => {
    const repo = tempRepo(true);
    const vibe = generateVibe(readProjectMemory(repo));
    assert.match(vibe, /不要手工编辑/);
    assert.match(vibe, /scheduling/, 'Capability 索引要在');
    assert.match(vibe, /同一 Project 同时只有一个/, '索引要带一句摘要，不能只有标题');
  });

  test('正文以子标题开头时，索引摘要跳过它 —— 实测踩到的', () => {
    // 真实产出的 Living Spec 常常直接 `## 某函数` 起头。只剥一级标题的话，
    // 索引里印出来的就是这行标题：没信息量，而且一个 `##` 挂在列表项底下
    // 会把 VIBE.md 的结构撑坏。
    const vibe = generateVibe({
      specs: [
        {
          slug: 'windowing',
          title: 'windowing',
          body: '## slidingWindows\n\n步长为 1 的重叠定长窗口。\n',
        },
      ],
      decisions: [],
      constitution: undefined,
      root: '/tmp/x',
      exists: true,
      projectName: 'demo',
    });
    assert.match(vibe, /步长为 1 的重叠定长窗口/);
    assert.doesNotMatch(vibe, /^\s+## slidingWindows/m, '标题不该被当成摘要印出来');
  });

  test('没有 project.yaml 时用传进来的项目名，不用目录名 —— 实测踩到的', () => {
    // 落地时读的是 Mission 的 worktree，目录名是 Mission ID。靠目录名兜底
    // 会让 VIBE.md 的标题变成「M-ctx」这种 Mission 名，而它是**项目**的门面。
    const worktree = mkdtempSync(join(tmpdir(), 'M-ctx-'));
    dirs.push(worktree);
    assert.match(generateVibe(readProjectMemory(worktree, 'v5-demo')), /^# v5-demo$/m);
    // 不传就只能退回目录名——这正是要避免的，所以留个对照。
    assert.doesNotMatch(generateVibe(readProjectMemory(worktree)), /^# v5-demo$/m);
  });
});

describe('落地时把知识跟代码一起合进去', () => {
  test('批准的 memoryDelta 写进 worktree，随同一次 merge 进目标分支', async () => {
    const repo = tempRepo(true);
    const worktrees = mkdtempSync(join(tmpdir(), 'coagent-wt-'));
    dirs.push(worktrees);

    const clock = new FixedClock();
    const ids = new SequentialIds();
    const workspace = new GitWorktreeManager(worktrees);
    const platform = new Platform({
      projects: new InMemoryProjectRepository(),
      deliveries: new InMemoryDeliveryRepository(clock, ids),
      workspace,
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
    });

    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const prepared = await workspace.prepare('M1', repo);
    await platform.recordWorkspace('M1', {
      projectRoot: repo,
      branch: prepared.branch,
      baseRevision: prepared.baseRevision,
    });

    const coord = await platform.startCoordinatorAttempt('M1');
    await platform.updatePlan('M1', coord.attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem('M1', coord.attemptId, {
      title: 'W',
      order: ORDER,
    });
    await platform.dispatchWorkItems('M1', coord.attemptId, [workItemId]);
    writeFileSync(join(prepared.cwd, 'a.txt'), 'mission\n');

    const exec = await platform.startExecutorAttempt('M1', workItemId);
    // S11.1：completed 必须有证据撑着，平台会拦下没证据的提交。
    await platform.submitEvidence('M1', exec.attemptId, {
      kind: 'test',
      summary: 'node --test 全绿',
      command: 'node --test',
      exitCode: 0,
    });
    await platform.submitExecutionResult('M1', exec.attemptId, {
      outcome: 'completed',
      summary: 's',
      changedFiles: ['a.txt'],
      evidenceIds: [],
      notes: '无',
    });
    await platform.finishAttempt('M1', exec.attemptId, { endedBy: 'structured_submit' });
    await platform.reviewExecutionResult('M1', coord.attemptId, {
      workItemId,
      verdict: 'accept',
      reasons: ['ok'],
      requiredChanges: [],
    });
    await platform.submitMissionResult('M1', coord.attemptId, {
      outcome: 'delivered',
      summary: '交付',
      acceptanceEvidence: [],
      memoryDelta: [
        {
          kind: 'living_spec',
          slug: 'scheduling',
          title: '调度',
          body: '# 调度\n\n同一 Project 同时只有一个 Mission 在改代码；交卷不放名额。\n',
        },
        {
          kind: 'adr',
          slug: 'adr-0001-single-writer-lock',
          title: '用单写者锁而不是数据库',
          body: '# 用单写者锁而不是数据库\n\n写并发在这里不该发生，所以做成排他锁 + 明确报错。\n',
        },
      ],
      openRisks: [],
    });
    await platform.finishAttempt('M1', coord.attemptId, { endedBy: 'structured_submit' });

    const result = await platform.finalizeMission('M1', {
      verdict: 'merge',
      reasons: ['ok'],
      projectRoot: repo,
    });
    assert.equal(result.status, 'completed');

    // **关键**：代码和文档在同一个提交里进了目标分支。
    assert.equal(git(repo, 'show', 'HEAD:a.txt'), 'mission');
    assert.match(git(repo, 'show', 'HEAD:.coagent/specs/scheduling.md'), /交卷不放名额/);
    assert.match(
      git(repo, 'show', 'HEAD:.coagent/architecture/decisions/adr-0001-single-writer-lock.md'),
      /排他锁/,
    );
    // VIBE.md 也跟着更新了，而且索引里有新写的那份。
    const vibe = git(repo, 'show', 'HEAD:VIBE.md');
    assert.match(vibe, /不要手工编辑/);
    assert.match(vibe, /scheduling/);
    assert.match(vibe, /adr-0001/);
  });

  test('没有 memoryDelta 时不生成任何东西 —— 不是每次改动都该留永久文档', () => {
    const repo = tempRepo(true);
    const before = readProjectMemory(repo).specs.length;
    const written = applyMemoryDelta(repo, []);
    assert.deepEqual(written, []);
    assert.equal(readProjectMemory(repo).specs.length, before);
    assert.equal(existsSync(join(repo, 'VIBE.md')), false, '空 delta 不该顺手生成 VIBE');
  });
});

describe('给 agent 的项目上下文', () => {
  test('默认只给索引，不把所有 Spec 全文倒进对话', async () => {
    const repo = tempRepo(true);
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const platform = new Platform({
      projects: new InMemoryProjectRepository(),
      deliveries: new InMemoryDeliveryRepository(clock, ids),
      workspace: new GitWorktreeManager(mkdtempSync(join(tmpdir(), 'wt-'))),
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
    });
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await platform.recordWorkspace('M1', {
      projectRoot: repo,
      branch: 'mission/M1',
      baseRevision: 'x',
    });

    const index = (await platform.getProjectContext('M1')) as {
      available: boolean;
      specs: { slug: string }[];
      constitution?: string;
    };
    assert.equal(index.available, true);
    assert.deepEqual(index.specs.map((s) => s.slug), ['scheduling']);
    assert.ok(index.constitution, '架构约束是红线，要默认给');
    assert.ok(
      !JSON.stringify(index).includes('同一 Project 同时只有一个 Mission 在改代码'),
      '默认不该带 Spec 正文——那是纯浪费',
    );

    const detail = (await platform.getProjectContext('M1', 'scheduling')) as { body: string };
    assert.match(detail.body, /同一 Project 同时只有一个/);
  });

  test('项目没有 .coagent/ 时说清楚，而不是给个空壳', async () => {
    const repo = tempRepo(false);
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const platform = new Platform({
      projects: new InMemoryProjectRepository(),
      deliveries: new InMemoryDeliveryRepository(clock, ids),
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
    });
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await platform.recordWorkspace('M1', { projectRoot: repo, branch: 'b', baseRevision: 'x' });

    const context = (await platform.getProjectContext('M1')) as {
      available: boolean;
      note: string;
    };
    assert.equal(context.available, false);
    assert.match(context.note, /没有 \.coagent/);
  });
});
