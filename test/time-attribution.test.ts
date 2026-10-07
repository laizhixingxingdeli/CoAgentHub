/**
 * COM5 T1：纯时间归因投影的两条复合关键 fixture。
 *
 * 只覆盖验收点名的关键场景：串行工具相加 / 并行取并集 / 验证与运行重叠不双计；
 * 缺 completed、缺 attempt.ended、重复 callId 不重计、矛盾 ended 不求和。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TIME_ATTRIBUTION_SCHEMA_VERSION,
  projectTimeAttribution,
  type TimeAttribution,
  type TimeAttributionActivityEvent,
} from '../src/application/time-attribution.ts';

const T0 = Date.parse('2026-10-07T00:00:00.000Z');

function at(offsetS: number): string {
  return new Date(T0 + offsetS * 1000).toISOString();
}

function ev(
  offsetS: number,
  kind: string,
  extra: Partial<TimeAttributionActivityEvent> = {},
): TimeAttributionActivityEvent {
  return { at: at(offsetS), kind, ...extra };
}

function phasesOf(result: TimeAttribution, kind: string) {
  return result.phases.filter((p) => p.kind === kind);
}

function durations(result: TimeAttribution, kind: string): (number | null)[] {
  return phasesOf(result, kind).map((p) => p.durationMs);
}

function sum(values: readonly (number | null)[]): number {
  return values.reduce<number>((total, v) => total + (v ?? 0), 0);
}

describe('projectTimeAttribution', () => {
  test('串行工具相加、并行工具取并集、验证与运行重叠不双计', () => {
    const A = 'exec-A';
    const B = 'exec-B';
    const result = projectTimeAttribution({
      activity: [
        ev(0, 'attempt.started', { attemptId: A, workItemId: 'W-1', data: { kind: 'executor' } }),
        ev(5, 'runtime.command.started', { attemptId: A, data: { callId: 'c1' } }),
        ev(15, 'runtime.tool.completed', { attemptId: A, data: { callId: 'c1' } }),
        ev(16, 'runtime.command.started', { attemptId: A, data: { callId: 'c2' } }),
        ev(26, 'runtime.tool.completed', { attemptId: A, data: { callId: 'c2' } }),
        ev(30, 'runtime.command.started', { attemptId: A, data: { callId: 'c3' } }),
        ev(30, 'runtime.command.started', { attemptId: A, data: { callId: 'c4' } }),
        ev(40, 'runtime.tool.completed', { attemptId: A, data: { callId: 'c3' } }),
        ev(44, 'runtime.tool.completed', { attemptId: A, data: { callId: 'c4' } }),
        ev(60, 'attempt.ended', {
          attemptId: A,
          workItemId: 'W-1',
          data: { endedBy: 'completed', usage: { input: 1, output: 2, total: 3, quality: 'reported' } },
        }),
        // 并行的第二条运行：总占用对它取并集，不与 A 相加。
        ev(30, 'attempt.started', { attemptId: B, data: { kind: 'executor' } }),
        ev(90, 'attempt.ended', { attemptId: B, data: { endedBy: 'completed' } }),
        // 暂停：成对事件，正常相加。
        ev(100, 'mission.paused', { data: {} }),
        ev(102, 'mission.resumed_from_pause', { data: {} }),
      ],
      validationReports: [
        {
          id: 'VR-1',
          attemptId: A,
          startedAt: at(50),
          endedAt: at(56),
          checks: [{ kind: 'command', startedAt: at(50), endedAt: at(56) }],
        },
      ],
    });

    assert.equal(result.schemaVersion, TIME_ATTRIBUTION_SCHEMA_VERSION);
    assert.equal(result.coverage, 'complete');

    const runs = phasesOf(result, 'agent_run');
    assert.deepEqual(
      runs.map((p) => p.durationMs),
      [60_000, 60_000],
    );

    const tools = phasesOf(result, 'tool');
    const toolDurations = tools.map((p) => p.durationMs);
    assert.deepEqual(toolDurations, [10_000, 10_000, 10_000, 14_000]);
    // 串行两段相加。
    assert.equal((toolDurations[0] ?? 0) + (toolDurations[1] ?? 0), 20_000);
    // 并行两段开始同刻，覆盖 30..44 = 14s，而不是 10+14 相加。
    const [c3, c4] = tools.slice(2);
    assert.equal(c3!.start, c4!.start);
    assert.equal(
      Date.parse(c4!.end!) - Date.parse(c3!.start!),
      14_000,
    );

    // 未分类：嵌套在运行里，不额外加总，但可见。
    const unclassified = phasesOf(result, 'unclassified');
    assert.equal(unclassified.every((p) => p.countedInTotal), true);
    assert.equal(sum(unclassified.map((p) => p.durationMs)), 26_000 + 60_000);

    // 验证窗 50..56 落在运行 A 内：双向标明 overlaps，总占用不双计。
    const validation = phasesOf(result, 'validation');
    assert.equal(validation.length, 1);
    assert.equal(validation[0]!.durationMs, 6_000);
    assert.deepEqual(validation[0]!.overlaps, ['agent_run']);
    assert.deepEqual(runs[0]!.overlaps, ['validation']);

    // token 只原样带 usage。
    assert.deepEqual(runs[0]!.usage, { input: 1, output: 2, total: 3, quality: 'reported' });

    // 两条运行的并集 0..90 加暂停 100..102；不是 60+60。
    assert.equal(result.totalOccupiedMs, 92_000);
    assert.equal(phasesOf(result, 'pause')[0]!.durationMs, 2_000);
  });

  test('缺 completed / 缺 attempt.ended 标未知，重复 callId 不重计，矛盾 ended 不求和', () => {
    const A = 'exec-A';
    const B = 'exec-B';
    const C = 'exec-C';
    const D = 'exec-D';
    const result = projectTimeAttribution({
      activity: [
        // A：工具只有完成没有开始，且另一工具只有开始没有完成；运行本身有起止。
        ev(0, 'attempt.started', { attemptId: A, data: {} }),
        ev(4, 'runtime.tool.completed', { attemptId: A, data: { callId: 'c0' } }),
        ev(5, 'runtime.command.started', { attemptId: A, data: { callId: 'c1' } }),
        ev(30, 'attempt.ended', { attemptId: A, data: { endedBy: 'completed' } }),
        // B：缺 attempt.ended，运行时长未知。
        ev(100, 'attempt.started', { attemptId: B, data: {} }),
        // C：同一 messageId 的重投 + 同一 callId 的重复 started/completed，都不再计一次。
        ev(200, 'attempt.started', { attemptId: C, messageId: 'msg-c-start', data: {} }),
        ev(200, 'attempt.started', { attemptId: C, messageId: 'msg-c-start', data: {} }),
        ev(201, 'runtime.command.started', { attemptId: C, messageId: 'msg-c-tool-start', data: { callId: 'c9' } }),
        ev(201, 'runtime.command.started', { attemptId: C, messageId: 'msg-c-tool-start', data: { callId: 'c9' } }),
        ev(203, 'runtime.tool.completed', { attemptId: C, messageId: 'msg-c-tool-end', data: { callId: 'c9' } }),
        ev(203, 'runtime.tool.completed', { attemptId: C, messageId: 'msg-c-tool-end', data: { callId: 'c9' } }),
        ev(210, 'attempt.ended', { attemptId: C, data: { endedBy: 'completed' } }),
        // D：同一 attempt 的两条矛盾 attempt.ended，不求和。
        ev(300, 'attempt.started', { attemptId: D, data: {} }),
        ev(305, 'attempt.ended', { attemptId: D, data: { endedBy: 'completed' } }),
        ev(308, 'attempt.ended', { attemptId: D, data: { endedBy: 'interrupted' } }),
        // 无结束的等待：时长未知，不用 now 闭合。
        ev(400, 'mission.waiting', { data: { reason: 'waiting_l3' } }),
      ],
      hops: [{ id: 'H-legacy', workItemId: 'W-9', createdAt: at(350), status: 'completed' }],
    });

    assert.equal(result.schemaVersion, 1);
    assert.equal(result.coverage, 'partial');

    const runs = phasesOf(result, 'agent_run');
    const byAttempt = new Map(runs.map((p) => [p.attemptId, p]));
    assert.equal(byAttempt.get(A)!.durationMs, 30_000);
    assert.equal(byAttempt.get(B)!.durationMs, null);
    assert.equal(byAttempt.get(B)!.quality, 'unknown');
    assert.equal(byAttempt.get(C)!.durationMs, 10_000, '重复 messageId/attempt.started 不使运行未知');
    assert.equal(byAttempt.get(D)!.durationMs, null, '矛盾 ended 不求和');
    assert.equal(byAttempt.get(D)!.quality, 'unknown');

    const toolsFor = (attemptId: string) => phasesOf(result, 'tool').filter((p) => p.attemptId === attemptId);
    const toolsA = toolsFor(A);
    assert.equal(toolsA.length, 2);
    assert.equal(toolsA.every((p) => p.durationMs === null), true);
    // 「只有完成没有开始」的语义：有 end 无 start，仍不闭合。
    assert.equal(toolsA.some((p) => p.end !== undefined && p.start === undefined), true);
    const toolsC = toolsFor(C);
    assert.equal(toolsC.length, 1, '重复 callId 不生成第二条工具阶段');
    assert.equal(toolsC[0]!.durationMs, 2_000);
    assert.equal(toolsC[0]!.quality, 'measured');

    // 未分类：相关工具未知则未知；运行未知也未知。
    const unclassifiedFor = (attemptId: string) =>
      phasesOf(result, 'unclassified').filter((p) => p.attemptId === attemptId);
    assert.deepEqual(
      unclassifiedFor(A).map((p) => p.durationMs),
      [null],
    );
    assert.deepEqual(
      unclassifiedFor(B).map((p) => p.durationMs),
      [null],
    );
    // C：运行 10s 减去已知工具 2s，剩两段（1s + 7s）不计未知。
    assert.equal(sum(unclassifiedFor(C).map((p) => p.durationMs)), 8_000);
    assert.deepEqual(
      unclassifiedFor(C).map((p) => p.quality),
      ['measured', 'measured'],
    );
    assert.deepEqual(
      unclassifiedFor(D).map((p) => p.durationMs),
      [null],
    );

    // 历史 hop 只显示入队时点，等待时长未知；不读 updatedAt。
    const queue = phasesOf(result, 'queue');
    assert.equal(queue.length, 1);
    assert.equal(queue[0]!.durationMs, null);
    assert.equal(queue[0]!.start, at(350));
    assert.equal(queue[0]!.quality, 'unknown');

    // 无结束的等待：未知，不把 now 算进去。
    const waiting = phasesOf(result, 'waiting_decision');
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0]!.durationMs, null);

    // 总占用只对已知可计区间取并集：A 0..30 + C 200..210。
    assert.equal(result.totalOccupiedMs, 40_000);

    // 空输入不制造 0：没有已知区间就是 unknown。
    assert.deepEqual(projectTimeAttribution({ activity: [] }), {
      schemaVersion: 1,
      coverage: 'unknown',
      totalOccupiedMs: null,
      phases: [],
    });
  });
});
