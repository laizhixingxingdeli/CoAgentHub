/**
 * 自动恢复策略（P0）：平台能自己处理的停机不再被手动表一刀切。
 *
 * 案例（MiRing-V0-probe）：执行者死信 / 打转、协调者打转、平台不可达、同项目占名额
 * 这几类以前都要 L3 手动 start_mission。本文件把「哪些停机平台会自己接着跑」钉死：
 * 退避表、连续打转第二次才停、project_busy 名额没释放时不叫醒、被解闸的托管 Mission
 * 会被 listAutoResumeDue 捡起。
 *
 * 参照 retry-wake.test.ts 的 world() / waiting()。
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
import { platformUnreachableResumeAt } from '../src/application/platform/auto-resume.ts';
import type { MissionContract } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const PAST = '2026-06-01T11:59:00.000Z';
const NOW = '2026-06-01T12:00:00.000Z';

function world() {
  const clock = new FixedClock(NOW);
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const projects = new InMemoryProjectRepository();
  const platform = new Platform({
    projects,
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    activity,
    clock,
    ids,
  });
  return { platform, activity, projects };
}

async function waiting(
  platform: Platform,
  missionId: string,
  reason: Parameters<Platform['setWaitReason']>[1],
  resumeAt: string | undefined,
) {
  await platform.createMission({ projectId: 'P', missionId, contract: CONTRACT });
  await platform.setWaitReason(missionId, reason, '测试用', resumeAt);
}

/** 直接写一条 attempt.ended：测「从尾部数连续」这类纯筛选，不跑整条编排器。 */
async function endedEvent(
  activity: InMemoryActivityLog,
  missionId: string,
  data: { endedBy: string },
  workItemId?: string,
) {
  await activity.append({
    projectId: 'P',
    missionId,
    workItemId,
    kind: 'attempt.ended',
    data,
  } as Parameters<InMemoryActivityLog['append']>[0]);
}

describe('自动恢复策略：平台能自己处理的停机自动接着跑', () => {
  test('退避表 1/5/15 分钟后第 4 次停；打转第二次才停；project_busy 名额没释放不叫醒；被解闸的托管 Mission 会被捡起', async () => {
    // ---- platformUnreachableResumeAt：第 1/2/3 次约 +1/+5/+15 分钟，第 4 次 undefined。 ----
    const nowMs = Date.parse(NOW);
    for (const [n, minutes] of [
      [1, 1],
      [2, 5],
      [3, 15],
    ] as const) {
      const at = platformUnreachableResumeAt(NOW, n);
      assert.equal(at, new Date(nowMs + minutes * 60_000).toISOString(), `第 ${n} 次约 ${minutes} 分钟`);
    }
    assert.equal(platformUnreachableResumeAt(NOW, 4), undefined, '第 4 次停下来等人');
    assert.equal(platformUnreachableResumeAt('not-a-time', 1), undefined, 'now 非法返回 undefined');

    // ---- 协调者打转：activity 里已有两条无 workItemId、endedBy killed_wall_clock 的 attempt.ended。 ----
    {
      const { platform, activity } = world();
      await waiting(platform, 'runaway-twice', 'runaway_suspected', PAST);
      await endedEvent(activity, 'runaway-twice', { endedBy: 'killed_wall_clock' });
      await endedEvent(activity, 'runaway-twice', { endedBy: 'killed_wall_clock' });
      const due = await platform.listAutoResumeDue(NOW);
      assert.equal(
        due.some((row) => row.missionId === 'runaway-twice'),
        false,
        '协调者连续第二次 killed_wall_clock：不自动续跑',
      );
    }
    {
      const { platform, activity } = world();
      await waiting(platform, 'runaway-once', 'runaway_suspected', PAST);
      await endedEvent(activity, 'runaway-once', { endedBy: 'killed_wall_clock' });
      const due = await platform.listAutoResumeDue(NOW);
      assert.equal(
        due.some((row) => row.missionId === 'runaway-once'),
        true,
        '只有一条打转记录：仍会进入 listDue',
      );
    }

    // ---- project_busy：同项目另一条 Mission isMutating 时不叫醒；不占名额时叫醒。 ----
    {
      const { platform, projects } = world();
      await waiting(platform, 'busy-me', 'project_busy', PAST);
      await platform.createMission({ projectId: 'P', missionId: 'holder', contract: CONTRACT });
      const project = (await projects.list())[0]!;
      project.missions.find((m) => m.id === 'holder')!.startExecuting();
      await projects.save(project);
      assert.equal((await platform.listAutoResumeDue(NOW)).some((row) => row.missionId === 'busy-me'), false, '名额还占着：不叫醒');
    }
    {
      const { platform, projects } = world();
      await waiting(platform, 'busy-me', 'project_busy', PAST);
      await platform.createMission({ projectId: 'P', missionId: 'holder', contract: CONTRACT });
      const project = (await projects.list())[0]!;
      project.missions.find((m) => m.id === 'holder')!.startExecuting();
      project.missions.find((m) => m.id === 'holder')!.park('名额释放');
      await projects.save(project);
      assert.equal((await platform.listAutoResumeDue(NOW)).some((row) => row.missionId === 'busy-me'), true, '名额释放后接着派');
    }

    // ---- 被解闸的托管 Mission：写过 run_requested，之后 requestHostedContinuation、没有未答复升级。 ----
    {
      const { platform } = world();
      await waiting(platform, 'M-cont', undefined, undefined);
      await platform.recordHostedRunRequest('M-cont', {
        cwd: '/proj',
        adapter: '/adapter/agent-entry.ts',
        acceptStaleBase: false,
      });
      await platform.requestHostedContinuation('M-cont', 'escalation_answered');
      const due = await platform.listAutoResumeDue(NOW);
      assert.equal(due.some((row) => row.missionId === 'M-cont'), true, '有续跑请求的托管 Mission 会被捡起');
    }
    {
      const { platform } = world();
      await waiting(platform, 'M-cont-paused', undefined, undefined);
      await platform.recordHostedRunRequest('M-cont-paused', {
        cwd: '/proj',
        adapter: '/adapter/agent-entry.ts',
        acceptStaleBase: false,
      });
      await platform.requestHostedContinuation('M-cont-paused', 'escalation_answered');
      await platform.pauseMission('M-cont-paused');
      const due = await platform.listAutoResumeDue(NOW);
      assert.equal(due.some((row) => row.missionId === 'M-cont-paused'), false, '暂停时不捡起');
    }
  });
});
