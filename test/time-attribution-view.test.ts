/**
 * COM5 T4：GET 任务详情读模型里的时间归因投影（src/application/platform/time-attribution-view.ts）。
 *
 * 只覆盖验收点名的关键场景：一条内存 Platform 夹具，活动流里有 validation.reported
 * 引用、报告带 outputTail、另有一条别的 Mission 的 hop。
 *
 * 最要紧的一条是「序列化结果里没有 outputTail」：报告是引擎写的，命令原文就挂在
 * 它上面；这条投影是只读观测面，一旦整份透传，命令输出会随页面载荷一起离开平台。
 * 断言放在**序列化之后**的字符串上，而不是字段级比较——字段级比较只能证明我今天
 * 记得删掉它，证明不了它没从别的路径漏出去。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import type { QueuedHop, QueuedHopRepository } from '../src/application/ports.ts';
import type { ValidationReport } from '../src/kernel/index.ts';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (offsetS: number) => new Date(T0 + offsetS * 1000).toISOString();
const OUTPUT_TAIL = 'SECRET-COMMAND-OUTPUT-TAIL';

/** 只实现投影真正用到的一条（list）；其余方法抛错，免得被误当成可用能力。 */
function hopsStub(rows: QueuedHop[]): QueuedHopRepository {
  const unused = () => {
    throw new Error('unused');
  };
  return {
    list: async () => rows,
    enqueue: unused,
    get: unused,
    claim: unused,
    renew: unused,
    complete: unused,
  } as unknown as QueuedHopRepository;
}

function hopRow(input: Partial<QueuedHop> & Pick<QueuedHop, 'id' | 'missionId'>): QueuedHop {
  return {
    projectId: 'P-view',
    workItemId: 'W-1',
    role: 'executor',
    priority: 0,
    availableAt: at(0),
    attemptCount: 0,
    maxAttempts: 3,
    idempotencyKey: `key-${input.id}`,
    status: 'queued',
    createdAt: at(0),
    updatedAt: at(0),
    ...input,
  };
}

const REPORT: ValidationReport = {
  id: 'VR-1',
  policyRevision: 1,
  missionId: 'M-view',
  workItemId: 'W-1',
  attemptId: 'W-1.exec-1',
  startedAt: at(50),
  endedAt: at(56),
  passed: true,
  checks: [
    {
      kind: 'command',
      passed: true,
      startedAt: at(50),
      endedAt: at(56),
      summary: '过了',
      command: {
        argv: ['node', '--test'],
        cwd: '/tmp',
        exitCode: 0,
        timedOut: false,
        durationMs: 6000,
        outputTail: OUTPUT_TAIL,
      },
    },
  ],
};

async function fixture() {
  const clock = new FixedClock(at(0));
  const ids = new SequentialIds();
  const activity = new InMemoryActivityLog(clock);
  const reports = new InMemoryValidationReportRepository();
  const hops = hopsStub([
    // 本项目里另一条 Mission 的 hop：不按 missionId 过滤就会串进这条时间线。
    hopRow({ id: 'HOP-other', missionId: 'M-other', createdAt: at(-600) }),
    // 本 Mission 的历史 hop：没有 hop.enqueued/claimed，等待时长未知（只留入队时点）。
    hopRow({ id: 'HOP-view', missionId: 'M-view', createdAt: at(-120) }),
  ]);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    workspace: new InPlaceWorkspaceManager(),
    activity,
    clock,
    ids,
    queuedHops: hops,
    validation: {
      // 只 stub 不调用：这条路径只读报告，不该碰 engine。
      engine: {
        validate: async () => {
          throw new Error('unused');
        },
      },
      reports,
    },
  });
  const contract = {
    intent: '把耗时变成原因',
    acceptance: ['能定位阶段'],
    constraints: [],
    nonGoals: [],
    guardrails: [],
  };
  await platform.createMission({ projectId: 'P-view', missionId: 'M-view', contract });
  await platform.createMission({ projectId: 'P-view', missionId: 'M-bare', contract });

  const append = (missionId: string, _offsetS: number, kind: string, rest: Record<string, unknown>) =>
    activity.append({
      projectId: 'P-view',
      missionId,
      kind,
      data: rest.data ?? {},
      ...(rest.workItemId !== undefined ? { workItemId: rest.workItemId as string } : {}),
      ...(rest.attemptId !== undefined ? { attemptId: rest.attemptId as string } : {}),
      ...(rest.messageId !== undefined ? { messageId: rest.messageId as string } : {}),
    } as never);
  // InMemoryActivityLog 用 clock 打 at；夹具只往前走时钟（倒退出来的顺序不是真实形状）。
  const atTime = (offsetS: number) => clock.advance(T0 + offsetS * 1000 - clock.now().getTime());

  atTime(0);
  await append('M-view', 0, 'attempt.started', { attemptId: 'W-1.exec-1', workItemId: 'W-1' });
  atTime(60);
  await append('M-view', 60, 'attempt.ended', {
    attemptId: 'W-1.exec-1',
    workItemId: 'W-1',
    data: { endedBy: 'structured_submit', usage: { input: 10, output: 5, total: 15, quality: 'reported' } },
  });
  atTime(61);
  await append('M-view', 61, 'validation.reported', {
    workItemId: 'W-1',
    data: { reportId: 'VR-1', passed: true, submittedAttemptId: 'W-1.exec-1' },
  });
  // 没有引用的报告不该被拉进来（报告 id 是可猜的自增事实，只看 id 取等于开了跨 Mission 扫库的口子）。
  await reports.save({ ...REPORT, id: 'VR-unref', startedAt: at(70), endedAt: at(80) } as ValidationReport);
  await reports.save(REPORT);

  return { platform };
}

describe('时间归因读模型投影', () => {
  test('读活动流 + 引用报告起止 + 本 Mission hop（含 outputTail 不外泄、未知仍可读）', async () => {
    const { platform } = await fixture();
    const result = await platform.getTimeAttribution('M-view');

    // 验证窗起止来自**报告**（活动流里只有时点），并与运行相交。
    const validation = result.phases.filter((p) => p.kind === 'validation');
    assert.equal(validation.length, 1);
    assert.equal(validation[0]!.start, at(50));
    assert.equal(validation[0]!.end, at(56));
    assert.equal(validation[0]!.durationMs, 6_000);
    assert.deepEqual(validation[0]!.overlaps, ['agent_run']);

    // usage 原样带上，且与毫秒分开。
    const runs = result.phases.filter((p) => p.kind === 'agent_run');
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0]!.usage, { input: 10, output: 5, total: 15, quality: 'reported' });
    assert.equal(runs[0]!.durationMs, 60_000);

    // hop：只认本 Mission 的那一条；历史缺认领时点 → 等待时长未知。
    const queue = result.phases.filter((p) => p.kind === 'queue');
    assert.equal(queue.length, 1, '别的 Mission 的 hop 不得串进这条时间线');
    assert.equal(queue[0]!.workItemId, 'W-1');
    assert.equal(queue[0]!.durationMs, null);

    // 报告原文（命令输出）绝不出现在投影里。
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(OUTPUT_TAIL), false, 'outputTail 随投影外泄了');
    assert.equal(serialized.includes('outputTail'), false);
    assert.equal(serialized.includes('VR-unref'), false, '只有被活动流引用过的报告才认领');

    // 历史 Mission 缺全部事件也要能读，不抛错。
    const bare = await platform.getTimeAttribution('M-bare');
    assert.deepEqual(bare.phases, []);
    assert.equal(bare.coverage, 'unknown');
  });
});
