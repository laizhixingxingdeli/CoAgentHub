/**
 * 两层外部主控协作的第一步：**只**做持久化与视图标识。
 *
 * 守住三件事：
 *   - coordinationMode 是与 executionMode 正交的只读轴，缺省/非法一律 hierarchical；
 *   - Project / Mission 快照往返保留 direct，旧数据（缺字段、坏值）恢复为 hierarchical；
 *   - 平台公开 createMission 只接受 undefined / hierarchical / direct，非法值在
 *     ensureProject 与发 id 之前就拒掉（不留空 Project、不烧 id）。
 *
 * 刻意不测调度器 / API / MCP：本阶段它们都不读这一格。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Mission,
  Project,
} from '../src/kernel/index.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';

const CONTRACT: MissionContract = {
  intent: 'direct coordination mode',
  acceptance: ['ok'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const ORDER: WorkOrder = {
  objective: '改 foo.ts',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
};

function harness() {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const projects = new InMemoryProjectRepository();
  const activity = new InMemoryActivityLog(clock);
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({ projects, deliveries, activity, clock, ids });
  return { platform, projects, activity, ids };
}

describe('coordinationMode: kernel 持久化与缺省', () => {
  test('Mission 默认 hierarchical；direct 往返保留；Project 快照保留；旧数据/非法恢复为 hierarchical', () => {
    const project = Project.create({ id: 'P-kernel' });

    // 缺省：不传就是 hierarchical，与 executionMode 互不影响。
    const plain = project.createMission({
      id: 'M-plain',
      executionMode: 'high_assurance',
      runKind: 'query',
    });
    assert.equal(plain.coordinationMode, 'hierarchical');
    assert.equal(plain.executionMode, 'high_assurance');
    assert.equal(plain.runKind, 'query');
    assert.equal(plain.toSnapshot().coordinationMode, 'hierarchical');

    // direct 是独立的只读轴：不改 executionMode / runKind / 状态流转。
    const direct = project.createMission({
      id: 'M-direct',
      contract: CONTRACT,
      executionMode: 'lightweight',
      coordinationMode: 'direct',
    });
    assert.equal(direct.coordinationMode, 'direct');
    assert.equal(direct.executionMode, 'lightweight');
    assert.equal(direct.runKind, 'mutation');
    assert.equal(direct.status, 'investigating');
    direct.startPlanning();
    direct.startExecuting();
    assert.equal(direct.status, 'executing');
    assert.equal(direct.isMutating, true);
    assert.equal(direct.coordinationMode, 'direct');

    // 原子 seed 入口同样透传。
    const { mission: seeded } = project.createMissionWithInitialWorkItem({
      id: 'M-seeded',
      coordinationMode: 'direct',
      initialWorkItem: { id: 'W-seeded', title: 'seed', order: ORDER },
    });
    assert.equal(seeded.coordinationMode, 'direct');

    // Project 级快照往返：三种都按原样回来。
    const roundTrip = Project.restore(project.toSnapshot());
    assert.deepEqual(
      roundTrip.missions.map((m) => [m.id, m.coordinationMode]),
      [
        ['M-plain', 'hierarchical'],
        ['M-direct', 'direct'],
        ['M-seeded', 'direct'],
      ],
    );
    // executionMode 的既有缺省规则不变（这里 plain 显式 HA，direct 显式 lightweight）。
    assert.deepEqual(
      roundTrip.missions.map((m) => m.executionMode),
      ['high_assurance', 'lightweight', 'standard'],
    );

    // 老快照缺字段 -> hierarchical，且后续 snapshot 写出具体值。
    const legacyProject = Project.create({ id: 'P-legacy' });
    const legacyBase = legacyProject.createMission({ id: 'M-legacy' });
    const legacySnap = legacyBase.toSnapshot();
    delete legacySnap.coordinationMode;
    const legacyRestored = Mission.restore(legacySnap, legacyProject);
    assert.equal(legacyRestored.coordinationMode, 'hierarchical');
    assert.equal(legacyRestored.toSnapshot().coordinationMode, 'hierarchical');

    // 非法/畸形值一律 hierarchical，不偷偷推断 direct，也不改写 executionMode。
    for (const bad of ['nope', 'Direct', null, 0, {}, [] as unknown[]] as const) {
      const snap = direct.toSnapshot();
      (snap as { coordinationMode?: unknown }).coordinationMode = bad as never;
      const restored = Mission.restore(snap, project);
      assert.equal(restored.coordinationMode, 'hierarchical', `bad=${JSON.stringify(bad)}`);
      assert.equal(restored.toSnapshot().coordinationMode, 'hierarchical');
      // 既有 executionMode 规则不受影响。
      assert.equal(restored.executionMode, 'lightweight');
      assert.equal(restored.runKind, 'mutation');
    }

    // 只读：没有 setter，赋值抛 TypeError（与其它只读投影一致）。
    assert.throws(() => {
      (direct as unknown as Record<string, unknown>).coordinationMode = 'hierarchical';
    }, TypeError);
  });
});

describe('coordinationMode: Platform create / get / list 与非法值拒绝', () => {
  test('createMission 透传并投影；缺省 hierarchical；非法值在建 Project / 发 id 前被拒且无副作用', async () => {
    const { platform, projects, activity, ids } = harness();

    const direct = await platform.createMission({
      projectId: 'P-plat',
      missionId: 'M-plat-direct',
      contract: CONTRACT,
      coordinationMode: 'direct',
    });
    assert.equal(direct.missionId, 'M-plat-direct');

    const explicit = await platform.createMission({
      projectId: 'P-plat',
      missionId: 'M-plat-hier',
      contract: CONTRACT,
      coordinationMode: 'hierarchical',
    });
    assert.equal(explicit.missionId, 'M-plat-hier');

    // 不传 = hierarchical（不是 direct）。
    const implicit = await platform.createMission({
      projectId: 'P-plat',
      missionId: 'M-plat-default',
      contract: CONTRACT,
    });
    assert.equal(implicit.missionId, 'M-plat-default');

    // getMissionView 投影。
    const directView = await platform.getMissionView('M-plat-direct');
    assert.equal(directView.coordinationMode, 'direct');
    assert.equal(directView.executionMode, 'standard');
    assert.equal(directView.runKind, 'mutation');
    const defaultView = await platform.getMissionView('M-plat-default');
    assert.equal(defaultView.coordinationMode, 'hierarchical');

    // listMissions 投影。
    const rows = await platform.listMissions();
    assert.deepEqual(
      rows
        .filter((row) => row.projectId === 'P-plat')
        .map((row) => [row.missionId, row.coordinationMode]),
      [
        ['M-plat-direct', 'direct'],
        ['M-plat-hier', 'hierarchical'],
        ['M-plat-default', 'hierarchical'],
      ],
    );

    // 重跑继承协作方式：direct 的源头重跑还是 direct，缺省源头重跑还是 hierarchical。
    // 不继承的话 direct 重跑会悄悄落回 hierarchical——「谁在派工」变了，成本就不可比了。
    const rerunDirect = await platform.rerunMission('M-plat-direct', {
      newMissionId: 'M-plat-direct-rerun',
    });
    assert.equal(rerunDirect.rerunOf, 'M-plat-direct');
    assert.equal(
      (await platform.getMissionView('M-plat-direct-rerun')).coordinationMode,
      'direct',
    );
    const rerunDefault = await platform.rerunMission('M-plat-default', {
      newMissionId: 'M-plat-default-rerun',
    });
    assert.equal(rerunDefault.rerunOf, 'M-plat-default');
    assert.equal(
      (await platform.getMissionView('M-plat-default-rerun')).coordinationMode,
      'hierarchical',
    );
    // 源头一点没动。
    assert.equal((await platform.getMissionView('M-plat-direct')).coordinationMode, 'direct');

    // mission.created 事件带上协作方式。
    const createdEvent = (await activity.list('M-plat-direct')).find(
      (event) => event.kind === 'mission.created',
    );
    assert.equal(
      (createdEvent?.data as Record<string, unknown> | undefined)?.coordinationMode,
      'direct',
    );

    // ---- 非法值：在 ensureProject / 发 id 之前拒绝 ----
    const projectCountBefore = (await projects.list()).length;
    const missionCountBefore = (await platform.listMissions()).length;
    const projectBefore = await projects.get('P-reject');
    assert.equal(projectBefore, undefined);
    const idBefore = ids.next('M'); // 探测用掉一个 id，只为确认拒绝路径不再消耗
    const nextIdAfterProbe = `M-${Number(idBefore.slice(2)) + 1}`;
    for (const bad of ['Direct', 'direct ', 'hierarchy', 'none', null, 0, true, {}] as const) {
      await assert.rejects(
        () =>
          platform.createMission({
            projectId: 'P-reject',
            contract: CONTRACT,
            coordinationMode: bad as never,
          }),
        (error: unknown) => {
          assert.ok(error instanceof PlatformRuleError);
          assert.equal((error as PlatformRuleError).code, 'INVALID_COORDINATION_MODE');
          return true;
        },
        `bad=${JSON.stringify(bad)}`,
      );
    }

    // 无副作用：没建空 Project、没多出 Mission、没有 mission.created 事件、id 未被消耗。
    assert.equal((await projects.list()).length, projectCountBefore);
    assert.equal(await projects.get('P-reject'), undefined);
    assert.equal((await platform.listMissions()).length, missionCountBefore);
    assert.deepEqual(await activity.list('M-1'), []);
    assert.deepEqual(await activity.list('M-2'), []);
    // 拒绝后再建一条，id 紧接探测之后那个：说明拒绝路径一个都没烧掉。
    const afterReject = await platform.createMission({
      projectId: 'P-reject',
      contract: CONTRACT,
    });
    assert.equal(afterReject.missionId, nextIdAfterProbe);
    assert.equal((await platform.getMissionView(afterReject.missionId)).coordinationMode, 'hierarchical');

    // 显式 missionId 的拒绝路径同样不留下半条 Mission。
    await assert.rejects(
      () =>
        platform.createMission({
          projectId: 'P-plat',
          missionId: 'M-plat-bad',
          contract: CONTRACT,
          coordinationMode: 'direct-ish' as never,
        }),
      (error: unknown) =>
        error instanceof PlatformRuleError &&
        (error as PlatformRuleError).code === 'INVALID_COORDINATION_MODE',
    );
    assert.equal((await platform.listMissions()).length, missionCountBefore + 1);
  });
});
