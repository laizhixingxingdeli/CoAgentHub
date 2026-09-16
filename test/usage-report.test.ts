/**
 * S11.5：用量聚合到 Project / Mission / Role / 运行时身份。
 *
 * 先前只有 Mission 级和单次 attempt 级。"这个项目花了多少钱""哪个模型最烧"
 * 都得人挨个点进去自己加——等于没提供。
 *
 * 身份维度**按事实键分组**，不是写死 provider/model 两个字段：适配层填什么
 * 键就按什么键分。接第二个 agent（可能是三个轴、也可能只有一个）时不用改这里。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import type { MissionContract, TokenUsage, WorkOrder } from '../src/kernel/index.ts';
import { PROTOCOL_VERSION } from '../src/application/platform.ts';
import type { UsageReport } from '../src/application/platform.ts';

const CONTRACT: MissionContract = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const ORDER: WorkOrder = {
  objective: 'o',
  allowedScope: ['src/a.ts'],
  requiredBehaviour: 'b',
  constraints: [],
  acceptance: ['a'],
  verification: ['node --test'],
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

function usage(n: number): TokenUsage {
  return {
    input: n,
    output: n,
    cacheRead: 0,
    cacheWrite: 0,
    total: n * 2,
    cost: n / 1000,
    quality: 'reported',
  };
}

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

function makePlatform() {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    workspace: new InPlaceWorkspaceManager(),
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
  return { platform, deliveries };
}

/**
 * 两个项目、各一条 Mission：
 *   P1/M1 协调者(acme/big) + 执行者(acme/small)
 *   P2/M2 协调者(other/big)，且**不报身份** —— 用来验未归因那一栏
 */
async function seed(platform: Platform) {
  await platform.createMission({ projectId: 'P1', missionId: 'M1', contract: CONTRACT });
  const c1 = await platform.startCoordinatorAttempt('M1', { endpoint: 'l', profileId: 'coord' });
  await platform.updatePlan('M1', c1.attemptId, PLAN);
  const { workItemId } = await platform.createWorkItem('M1', c1.attemptId, {
    title: 'W',
    order: ORDER,
  });
  // 派发必须在收尾之前：attempt 一旦 succeeded 就不能再拿它提交东西了。
  await platform.dispatchWorkItems('M1', c1.attemptId, [workItemId]);
  await platform.finishAttempt('M1', c1.attemptId, {
    endedBy: 'structured_submit',
    usage: usage(100),
    resolvedProfile: {
      revision: 'r1',
      resolved: [
        { key: 'provider', value: 'acme' },
        { key: 'model', value: 'big' },
      ],
    },
  });
  const e1 = await platform.startExecutorAttempt('M1', workItemId, {
    endpoint: 'l',
    profileId: 'exec',
  });
  await platform.finishAttempt('M1', e1.attemptId, {
    endedBy: 'structured_submit',
    usage: usage(10),
    resolvedProfile: {
      revision: 'r1',
      resolved: [
        { key: 'provider', value: 'acme' },
        { key: 'model', value: 'small' },
      ],
    },
  });

  await platform.createMission({ projectId: 'P2', missionId: 'M2', contract: CONTRACT });
  const c2 = await platform.startCoordinatorAttempt('M2', { endpoint: 'l', profileId: 'coord' });
  // 刻意不报身份：老数据 / 不上报的运行时就长这样。
  await platform.finishAttempt('M2', c2.attemptId, {
    endedBy: 'structured_submit',
    usage: usage(5),
  });
}

describe('用量报表（S11.5）', () => {
  test('按 Project 分', async () => {
    const { platform } = makePlatform();
    await seed(platform);
    const report = await platform.getUsage();

    const p1 = report.byProject.find((r) => r.key === 'P1');
    assert.equal(p1?.attempts, 2);
    assert.equal(p1?.usage.total, 220, '100+10 各算 input+output');
    assert.equal(report.byProject.find((r) => r.key === 'P2')?.usage.total, 10);
    assert.equal(report.total.total, 230);
  });

  test('按 Role 分 —— 协调者和执行者的开销是两回事', async () => {
    const { platform } = makePlatform();
    await seed(platform);
    const report = await platform.getUsage();
    assert.equal(report.byRole.find((r) => r.key === 'coordinator')?.usage.total, 210);
    assert.equal(report.byRole.find((r) => r.key === 'executor')?.usage.total, 20);
  });

  test('按运行时身份分 —— Provider 与 Model 两个维度都落在这里', async () => {
    const { platform } = makePlatform();
    await seed(platform);
    const report = await platform.getUsage();

    const fact = (key: string, value: string) =>
      report.byFact.find((f) => f.key === key && f.value === value);
    // 同一家的两个模型合起来算一家。
    assert.equal(fact('provider', 'acme')?.attempts, 2);
    assert.equal(fact('provider', 'acme')?.usage.total, 220);
    assert.equal(fact('model', 'big')?.usage.total, 200);
    assert.equal(fact('model', 'small')?.usage.total, 20);
  });

  test('没冻结身份的单列出来，不摊给任何一家', async () => {
    const { platform } = makePlatform();
    await seed(platform);
    const report = await platform.getUsage();
    // 摊给谁都是编的；而这个数不为零本身就是信号：有一批 attempt 归因是缺的。
    assert.equal(report.unattributed, 1);
    assert.equal(
      report.byFact.reduce((sum, f) => sum + f.attempts, 0),
      4,
      '两个 attempt × 两个事实键',
    );
  });

  test('可以收窄到单个 Project / Mission', async () => {
    const { platform } = makePlatform();
    await seed(platform);
    const only = await platform.getUsage({ projectId: 'P1' });
    assert.equal(only.total.total, 220);
    assert.equal(only.unattributed, 0);
    assert.equal((await platform.getUsage({ missionId: 'M2' })).attempts, 1);
  });

  test('项目列表直接带上用量 —— 不能逼人挨个点进去自己加', async () => {
    const { platform, deliveries } = makePlatform();
    await seed(platform);
    const server = createApi({ platform, tokens: new RunTokenRegistry(), deliveries });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const rows = (await (await fetch(`${base}/api/projects`)).json()) as {
      projectId: string;
      usage: TokenUsage;
    }[];
    assert.equal(rows.find((r) => r.projectId === 'P1')?.usage.total, 220);

    const report = (await (await fetch(`${base}/api/usage?projectId=P1`)).json()) as UsageReport;
    assert.equal(report.total.total, 220);
  });

  test('quality 不得伪装精确，且两处口径一致', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P3', missionId: 'M3', contract: CONTRACT });
    const c = await platform.startCoordinatorAttempt('M3', { endpoint: 'l', profileId: 'x' });
    // 一条都没上报 → unknown。在途 attempt 不该把整体拉成"估算过"，
    // 那会让读数看起来比实际更有依据。
    const before = await platform.getUsage({ missionId: 'M3' });
    assert.equal(before.total.quality, 'unknown');

    await platform.finishAttempt('M3', c.attemptId, {
      endedBy: 'structured_submit',
      usage: usage(1),
    });
    const after = await platform.getUsage({ missionId: 'M3' });
    assert.equal(after.total.quality, 'reported');
    // 同一个数在 Mission 页和用量页必须同一个口径，否则两个都不可信。
    assert.equal((await platform.getMissionView('M3')).usage.quality, after.total.quality);
  });
});

describe('Envelope 公共语义（S10.3）', () => {
  test('事件带上因果链字段 —— 否则「这一步为什么发生」只能靠时间戳猜', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('M1');
    await platform.updatePlan('M1', coord.attemptId, PLAN);

    const events = await platform.getActivity('M1');
    for (const event of events) {
      assert.equal(event.protocolVersion, PROTOCOL_VERSION);
      assert.ok(event.messageId, '每条事件要有自己的 id');
      assert.equal(event.correlationId, 'M1', '同一 Mission 的事件串在一条因果链上');
    }
    // messageId 必须互不相同，否则"哪一条"这个问题就没法回答。
    assert.equal(new Set(events.map((e) => e.messageId)).size, events.length);

    // 由哪一跳引发：plan.updated 指回那次协调者尝试。
    const planned = events.find((e) => e.kind === 'plan.updated');
    assert.equal(planned?.causationId, coord.attemptId);
    assert.equal(planned?.planRevision, 1);
    assert.equal(planned?.contractRevision, 1);
  });

  test('同一秒内的多条事件也分得清先后与来源', async () => {
    // 时钟是固定的，所以这几条的时间戳完全一样 —— 正是靠时间戳猜会失败的场景。
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('M1');
    await platform.updatePlan('M1', coord.attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem('M1', coord.attemptId, {
      title: 'W',
      order: ORDER,
    });
    await platform.dispatchWorkItems('M1', coord.attemptId, [workItemId]);

    const events = await platform.getActivity('M1');
    assert.equal(new Set(events.map((e) => e.at)).size, 1, '这条测试的前提：时间戳全一样');
    const caused = events.filter((e) => e.causationId === coord.attemptId);
    assert.ok(caused.length >= 3, '这几步都该指回那次协调者尝试');
  });
});
