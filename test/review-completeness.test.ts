/**
 * 检视面必须完整：**L3 看到的清单 == 实际落地的文件**。
 *
 * ## 这一条是实跑换来的
 *
 * P1（第一次拿真实新项目走流程）落地了 6 个文件，其中 3 个 L3 从没看过：
 * 两份记忆文件和一个 VIBE.md。原因不是谁偷懒，是时序——记忆文件是 merge
 * 那一刻才写进 worktree 的，检视时 `workspace.diff()` 里根本没有它们。
 * 于是 L3 读作"将要落地的全部"的那份清单，系统性地少掉这几份。
 *
 * VIBE.md 更糟：它连 memoryDelta 里都没有，是 writeVibe 无条件重写的，
 * 任何检视面都不显示——「批准 N 条记忆、落地 N+1 个文件」，多出来那个
 * 写在别人仓库的根目录上，还声明"不要手工编辑"。
 *
 * ## 为什么这么测
 *
 * 断言写成"预测 == 实际写盘"，而不是拿预测去对一份手抄的清单。抄清单的
 * 测试只能证明两份常量一致；这个形状能抓住真正会发生的那种漂移——**有人往
 * 写盘那一侧加了个文件，却忘了加进预测**。那正是 VIBE.md 当初的来路。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyMemoryDelta,
  plannedMemoryFiles,
  writeVibe,
} from '../src/application/project-memory.ts';
import type { MemoryDelta } from '../src/kernel/index.ts';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-review-'));
  dirs.push(dir);
  return dir;
}

const DELTAS: MemoryDelta[] = [
  {
    kind: 'living_spec',
    slug: 'profile-audit',
    title: '档案表上游对照审计',
    body: '正文',
  },
  {
    kind: 'adr',
    slug: 'adr-0001-profile-audit-cli',
    title: '独立为 audit 子命令',
    body: '正文',
  },
];

describe('检视面完整性：预测的落地文件 == 实际写盘的文件', () => {
  test('一个不多、一个不少 —— 包括谁都没批准过的 VIBE.md', () => {
    const dir = scratch();
    const actual = [...applyMemoryDelta(dir, DELTAS), writeVibe(dir, 'some-project')];

    assert.deepEqual(
      plannedMemoryFiles(DELTAS),
      actual,
      '检视时预告的清单必须和落地时真写的逐字一致 —— 不一致就等于让 L3 盲签',
    );
  });

  test('VIBE.md 在清单里 —— 它不在 memoryDelta 里，最容易被漏', () => {
    // 单独钉一条：上面那条即使有人把两边**同时**改错也会绿。
    // 这一条锁的是"根目录上那个文件必须被预告"，那是 P1 真正漏掉的那个。
    assert.ok(plannedMemoryFiles(DELTAS).includes('VIBE.md'));
  });

  test('没有记忆改动时清单是空的 —— 不许无中生有预告一个 VIBE.md', () => {
    // writeVibe 只在 memoryDelta 非空时才被调用（见 platform.finalReview）。
    // 预测那一侧要跟着这个条件走，否则界面会预告一个根本不会出现的文件。
    assert.deepEqual(plannedMemoryFiles([]), []);

    const dir = scratch();
    assert.deepEqual(applyMemoryDelta(dir, []), [], '没有改动就不该写盘');
  });
});

describe('启动简报要带上这台机器会静默咬人的地方', () => {
  test('平台知道自己跑在什么系统上，agent 不知道', async () => {
    // 实测 P1：协调者写探针用了 `cat > /tmp/probe.mjs`，没成，接着 `pwd && ls`
    // 自己诊断、改用相对路径 —— 处理得很好，但那一个来回是白花的。而平台
    // 一直知道自己在 Windows 上。
    const { Platform } = await import('../src/application/platform.ts');
    const { FixedClock, InMemoryActivityLog, InMemoryProjectRepository, SequentialIds } =
      await import('../src/application/in-memory.ts');
    const { InMemoryDeliveryRepository } = await import('../src/application/delivery.ts');

    const clock = new FixedClock();
    const ids = new SequentialIds();
    const platform = new Platform({
      projects: new InMemoryProjectRepository(),
      deliveries: new InMemoryDeliveryRepository(clock, ids),
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
    });
    await platform.createMission({
      projectId: 'P',
      missionId: 'M1',
      contract: {
        intent: 'x',
        acceptance: [],
        constraints: [],
        nonGoals: [],
        guardrails: [],
      },
    });
    const { attemptId } = await platform.startCoordinatorAttempt('M1');
    const brief = await platform.getStartupBrief('M1', attemptId);

    if (process.platform === 'win32') {
      const notes = (brief.environmentNotes ?? []).join('\n');
      assert.match(notes, /\/tmp/, 'Windows 上 /tmp 两套，是 P1 实际踩到的那个');
      assert.match(notes, /pgrep/, '恒为真的判据同样不报错，同样要提前说');
    } else {
      // 在 Linux 上讲 Windows 的坑是噪音，噪音多了就没人读简报了。
      assert.deepEqual(brief.environmentNotes, []);
    }
  });
});
