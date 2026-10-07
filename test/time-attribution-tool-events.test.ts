/**
 * COM5 T2 —— 工具结束事实落库。
 *
 * 只验平台可信入口：`tool.completed` 经 `recordToolCompleted` 落成
 * `runtime.tool.completed`，同 attemptId + callId 只有一条，`at` 用落盘时钟。
 * 断言**不**看回调捕获的时间——那正是这张票要避免的时间源。
 *
 * 内存 Platform + FixedClock，与 test/budget-command-facts.test.ts:324-404 同一种接缝。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';

const CONTRACT = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: ['不得改 Contract'],
};

const AT = '2026-01-01T00:00:00.000Z';

async function harness() {
  const clock = new FixedClock(AT);
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    workspace: new InPlaceWorkspaceManager(),
    activity,
    clock,
    ids,
  });
  return { platform, clock };
}

describe('COM5 T2 tool-completed facts', () => {
  test('recordToolCompleted 落一条 runtime.tool.completed；同 attemptId+callId 不重复', async () => {
    const h = await harness();
    await h.platform.createMission({ projectId: 'P', missionId: 'M-tool', contract: CONTRACT });

    // attemptId 允许任意（本票不要求 attempt 真的存在）。
    await h.platform.recordToolCompleted('M-tool', 'A-1', { callId: 'call-7', name: 'shell_run' });

    const first = (await h.platform.getActivity('M-tool')).filter(
      (e) => e.kind === 'runtime.tool.completed',
    );
    assert.equal(first.length, 1);
    assert.equal(first[0]!.attemptId, 'A-1');
    assert.deepEqual(first[0]!.data, { schemaVersion: 1, callId: 'call-7', name: 'shell_run' });
    // at 必须是落盘时钟，而不是调用方任何捕获值。
    assert.equal(first[0]!.at, AT);

    // 重连/重复投递会把同一次结束再报一遍：不得第二条。
    h.clock.advance(5_000);
    await h.platform.recordToolCompleted('M-tool', 'A-1', { callId: 'call-7', name: 'shell_run' });
    const again = (await h.platform.getActivity('M-tool')).filter(
      (e) => e.kind === 'runtime.tool.completed',
    );
    assert.equal(again.length, 1, '同 attemptId+callId 只留一条');

    // 不同 callId 仍是一条新事实。
    await h.platform.recordToolCompleted('M-tool', 'A-1', { callId: 'call-8', name: 'read' });
    const all = (await h.platform.getActivity('M-tool')).filter(
      (e) => e.kind === 'runtime.tool.completed',
    );
    assert.equal(all.length, 2);
    assert.deepEqual(all[1]!.data, { schemaVersion: 1, callId: 'call-8', name: 'read' });
    // 第二条用的是推进后的落盘时钟，证明 at 跟着写入时刻走。
    assert.equal(all[1]!.at, h.clock.now().toISOString());
  });
});
