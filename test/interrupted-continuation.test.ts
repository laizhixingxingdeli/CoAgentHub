/**
 * 启动续跑（W-684）：服务启动收敛判为 interrupted 的托管 Mission，替它请求一次续跑。
 *
 * 这里守住的是装配契约：只对**不同**的 missionId 各请求一次，单个失败不向外抛；
 * 三个关闭条件（COAGENT_RESUME_INTERRUPTED=0 / COAGENT_AUTO_RESUME=0 / PG）一个都不调用；
 * 暂停的 Mission 不留事实（那条门禁在 auto-resume.ts 里，不许在这里重写）。
 *
 * 只测 requestInterruptedContinuations 本身，不起 startServer、不听端口、不碰状态文件。
 * 参照 auto-resume-policy.test.ts 的 world()。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform } from '../src/application/platform.ts';
import { RESUME_REQUESTED_EVENT_KIND } from '../src/application/platform/auto-resume.ts';
import { requestInterruptedContinuations } from '../src/main.ts';
import type { MissionContract } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const NOW = '2026-06-01T12:00:00.000Z';

function world() {
  const clock = new FixedClock(NOW);
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    activity,
    clock,
    ids,
  });
  return { platform, activity };
}

/** 建一条托管启动过的 Mission：没有 run_requested 时续跑请求会被直接丢掉，测不到本单的行为。 */
async function hostedMission(platform: Platform, missionId: string): Promise<void> {
  await platform.createMission({ projectId: 'P', missionId, contract: CONTRACT });
  await platform.recordHostedRunRequest(missionId, {
    cwd: '/proj',
    adapter: '/adapter/agent-entry.ts',
    acceptStaleBase: false,
  });
}

/** 本单请求产生的续跑事实条数：只数 service_interrupted 这个 cause。 */
async function interruptionRequests(activity: InMemoryActivityLog, missionId: string): Promise<number> {
  const events = await activity.list(missionId);
  return events.filter((event) => {
    if (event.kind !== RESUME_REQUESTED_EVENT_KIND) return false;
    const data = event.data;
    if (data === null || typeof data !== 'object') return false;
    return (data as { cause?: unknown }).cause === 'service_interrupted';
  }).length;
}

test('启动续跑：对不同的 interrupted missionId 各请求一次，暂停的不请求，三个关闭条件都不调用', async () => {
  // ---- 未暂停：请求一次，cause 是 service_interrupted；同一 id 传两次也只请求一次。 ----
  {
    const { platform, activity } = world();
    await hostedMission(platform, 'M-live');
    let calls = 0;
    const counting = {
      requestHostedContinuation: async (missionId: string, cause: string) => {
        calls++;
        await platform.requestHostedContinuation(missionId, cause);
      },
    };
    await requestInterruptedContinuations(
      counting,
      [{ missionId: 'M-live' }, { missionId: 'M-live' }],
      {},
      () => assert.fail('不应有警告'),
    );
    assert.equal(calls, 1, '同一 missionId 出现两次必须去重，只请求一次');
    assert.equal(await interruptionRequests(activity, 'M-live'), 1);
    const events = await activity.list('M-live');
    const requested = events.find((event) => event.kind === RESUME_REQUESTED_EVENT_KIND);
    assert.equal((requested?.data as { cause?: unknown }).cause, 'service_interrupted');
  }

  // ---- 暂停的 Mission：requestHostedContinuation 对暂停直接 return，不留事实。 ----
  {
    const { platform, activity } = world();
    await hostedMission(platform, 'M-paused');
    await platform.pauseMission('M-paused');
    await requestInterruptedContinuations(
      platform,
      [{ missionId: 'M-paused' }],
      {},
      () => assert.fail('不应有警告'),
    );
    assert.equal(await interruptionRequests(activity, 'M-paused'), 0, '暂停的 Mission 不得留下续跑请求');
  }

  // ---- 三个关闭条件：都不调用 platform。 ----
  {
    const { platform } = world();
    const cases: Array<{ name: string; env: Record<string, string> }> = [
      { name: 'COAGENT_RESUME_INTERRUPTED=0', env: { COAGENT_RESUME_INTERRUPTED: '0' } },
      { name: 'COAGENT_AUTO_RESUME=0', env: { COAGENT_AUTO_RESUME: '0' } },
    ];
    for (const item of cases) {
      let calls = 0;
      await requestInterruptedContinuations(
        {
          requestHostedContinuation: async (missionId: string, cause: string) => {
            calls++;
            await platform.requestHostedContinuation(missionId, cause);
          },
        },
        [{ missionId: 'M-off' }],
        item.env,
        () => assert.fail('不应有警告'),
      );
      assert.equal(calls, 0, `${item.name} 时不得请求续跑`);
    }
  }
});
