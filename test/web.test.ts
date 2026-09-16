/**
 * 观测面的读端点。
 *
 * 界面本身是静态字符串，值得测的是它依赖的两个读口，以及一条容易被
 * 忽略的行为：**状态文件被别的进程改过之后，常驻服务器要看得到新内容**。
 * 没有这条，页面上显示的永远是启动那一刻的快照——跑着的 Mission 纹丝不动，
 * 比没有界面更误导。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApi } from '../src/api/server.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { buildPersistentPlatform } from '../src/main.ts';

const CONTRACT = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const servers: Server[] = [];
const dirs: string[] = [];
after(() => {
  for (const server of servers) server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-web-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

async function serve(statePath: string) {
  const built = await buildPersistentPlatform(statePath, new InPlaceWorkspaceManager());
  const server = createApi({
    platform: built.platform,
    tokens: built.tokens,
    deliveries: built.deliveries,
    onMutation: built.persist,
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  return { ...built, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('观测面', () => {
  test('根路径返回可渲染的 HTML', async () => {
    const { base } = await serve(tempState());
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /CoAgentHub v5/);
    // 页面自己会拉这两个口，拼错了就永远是空白。
    assert.match(html, /\/api\/missions/);
  });

  test('Mission 列表带够列表页要的字段', async () => {
    const { platform, base } = await serve(tempState());
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const rows = (await (await fetch(`${base}/api/missions`)).json()) as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    for (const key of [
      'missionId',
      'projectId',
      'status',
      'isMutating',
      'intent',
      'workItems',
      'accepted',
      'openEscalations',
      'usage',
    ]) {
      assert.ok(key in rows[0], `列表缺字段 ${key}`);
    }
  });

  test('时间线按发生顺序返回；不存在的 Mission 要报错而不是给空数组', async () => {
    const { platform, base } = await serve(tempState());
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await platform.startCoordinatorAttempt('M1');

    const events = (await (await fetch(`${base}/api/missions/M1/activity`)).json()) as {
      kind: string;
    }[];
    assert.deepEqual(
      events.map((e) => e.kind),
      ['mission.created', 'attempt.started'],
    );

    // 空 Timeline 和「这条 Mission 不存在」在界面上长得一样，必须区分开。
    const missing = await fetch(`${base}/api/missions/不存在/activity`);
    assert.equal(missing.status, 409);
  });

  test('别的进程改了状态文件，常驻服务器要看得到', async () => {
    const statePath = tempState();
    const viewer = await serve(statePath);
    assert.equal(((await (await fetch(`${viewer.base}/api/missions`)).json()) as []).length, 0);

    // 另一个进程（这里用另一套实例模拟）建了一条 Mission 并落盘。
    const writer = await buildPersistentPlatform(statePath, new InPlaceWorkspaceManager());
    await writer.platform.createMission({
      projectId: 'P',
      missionId: 'M-new',
      contract: CONTRACT,
    });
    writer.persist();

    const rows = (await (await fetch(`${viewer.base}/api/missions`)).json()) as {
      missionId: string;
    }[];
    assert.equal(rows.length, 1, '不热重载的话这里永远是 0，页面就成了启动快照');
    assert.equal(rows[0].missionId, 'M-new');
  });
});

describe('页面读的字段必须真的存在', () => {
  // 实测踩到的：页面写的是 `w.attempts` / `view.coordinatorAttempts`，
  // 读模型给的却是 `attemptIds` / `coordinatorAttemptIds`。结果是尝试芯片
  // 一个都不渲染——**而且不报错**，页面照常显示，只是少了一块。
  //
  // 这类错没有任何东西会接住：页面是字符串，字段是运行时取的。所以这里
  // 拿真实读模型来对，把"页面以为有"和"后端真的有"钉在一起。
  test('MissionView 上页面用到的字段都在', async () => {
    const { platform, base } = await serve(tempState());
    await platform.createMission({
      projectId: 'P',
      missionId: 'M1',
      contract: {
        intent: '修 X',
        acceptance: ['绿'],
        constraints: [],
        nonGoals: [],
        guardrails: ['别动 package.json'],
      },
    });
    const coord = await platform.startCoordinatorAttempt('M1');
    await platform.updatePlan('M1', coord.attemptId, {
      findings: 'f',
      rejectedHypotheses: ['排除了 A'],
      decisions: [],
      direction: 'd',
      risks: [],
    });
    await platform.createWorkItem('M1', coord.attemptId, {
      title: 'W',
      order: {
        objective: 'o',
        allowedScope: ['src/a.ts'],
        requiredBehaviour: 'b',
        constraints: [],
        acceptance: ['a'],
        verification: ['node --test'],
        doNot: [],
        contextRefs: [],
      },
    });

    const view = (await (await fetch(`${base}/api/missions/M1`)).json()) as Record<string, unknown>;
    for (const field of [
      'missionId', 'projectId', 'status', 'paused', 'isMutating',
      'contract', 'contractRevision', 'plan', 'planRevision',
      'workItems', 'coordinatorAttemptIds', 'openEscalations', 'usage',
    ]) {
      assert.ok(field in view, `页面读 view.${field}，读模型里没有`);
    }
    for (const field of ['intent', 'acceptance', 'guardrails']) {
      assert.ok(field in (view.contract as object), `页面读 contract.${field}`);
    }
    for (const field of ['direction', 'rejectedHypotheses']) {
      assert.ok(field in (view.plan as object), `页面读 plan.${field}`);
    }
    const item = (view.workItems as Record<string, unknown>[])[0];
    for (const field of ['id', 'title', 'status', 'attemptIds']) {
      assert.ok(field in item, `页面读 workItem.${field}`);
    }
    for (const field of ['input', 'output', 'cacheRead', 'total', 'quality']) {
      assert.ok(field in (view.usage as object), `页面读 usage.${field}`);
    }
  });

  test('列表行上页面用到的字段都在', async () => {
    const { platform, base } = await serve(tempState());
    await platform.createMission({
      projectId: 'P',
      missionId: 'M1',
      contract: { intent: '修 X', acceptance: [], constraints: [], nonGoals: [], guardrails: [] },
    });
    const rows = (await (await fetch(`${base}/api/missions`)).json()) as Record<string, unknown>[];
    for (const field of [
      'missionId', 'projectId', 'status', 'intent', 'workItems', 'accepted',
      'isMutating', 'paused', 'openEscalations', 'usage',
    ]) {
      assert.ok(field in rows[0], `页面读列表行的 ${field}，读模型里没有`);
    }

    // waitReason / waitDetail 是可选的：没停机时 JSON 里根本不会有这两个键，
    // 页面也是按可选渲染的。所以判据落在「**设了就必须传出来**」，
    // 而不是「键永远在」——后者只会逼后端序列化一堆 null。
    await platform.setWaitReason('M1', 'project_busy', 'M-其他 占着名额');
    const stalled = (await (await fetch(`${base}/api/missions`)).json()) as Record<
      string,
      unknown
    >[];
    assert.equal(stalled[0].waitReason, 'project_busy');
    assert.equal(stalled[0].waitDetail, 'M-其他 占着名额');
  });
});
