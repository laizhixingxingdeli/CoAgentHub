/**
 * Mission 内部编排入口的接线：注入既有平台即可跑，不另建平台、不另听端口。
 *
 * CLI（run-mission.ts）仍自己装配、接续、过滤候选、回连和打结果；
 * 本文件守的是抽出来的那一层，不是把 CLI 再测一遍。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { MissionRunner } from '../src/application/mission-runner.ts';
import { Platform } from '../src/application/platform.ts';
import { makeIssuer } from '../src/main.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

const CONTRACT = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: ['不得改 Contract'],
};

const ORDER = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
};

const PLAN = {
  findings: 'foo 一直返回 0',
  rootCause: '初始值写错了',
  rejectedHypotheses: ['不是调用方传错'],
  decisions: ['直接改初始值'],
  direction: '改 src/foo.ts',
  risks: [],
};

const COORDINATOR_HAPPY: ScriptTable = {
  'coordinator:-:0': {
    steps: [
      { tool: 'coagent_get_mission', body: {} },
      { tool: 'coagent_update_plan', body: PLAN },
      { tool: 'coagent_create_work_item', body: { title: '修 foo', ...ORDER } },
      {
        tool: 'coagent_dispatch_work_item',
        body: (previous) => ({ workItemIds: [previous.workItemId] }),
      },
    ],
  },
  'coordinator:-:1': {
    steps: [
      { tool: 'coagent_get_mission', body: {} },
      {
        tool: 'coagent_review_execution_result',
        body: {
          workItemId: 'W-1',
          verdict: 'accept',
          acceptanceResults: ORDER.acceptance.map((criterion) => ({
            criterion,
            status: 'pass' as const,
            evidence: '测试替身：逐条核过',
          })),
          reasons: ['自己复跑过 node --test，退出码 0'],
          requiredChanges: [],
        },
      },
      {
        tool: 'coagent_submit_mission_result',
        body: {
          outcome: 'delivered',
          summary: '改好了并验证过',
          acceptanceEvidence: ['node --test 退出码 0'],
          memoryDelta: [],
          openRisks: [],
        },
      },
    ],
  },
};

const EXECUTOR_HAPPY: ScriptTable = {
  'executor:W-1': {
    steps: [
      { tool: 'coagent_get_work_order', body: {} },
      {
        tool: 'coagent_submit_evidence',
        body: { kind: 'test', summary: 'node --test 全绿', command: 'node --test', exitCode: 0 },
      },
      {
        tool: 'coagent_submit_execution_result',
        body: (previous) => ({
          outcome: 'completed',
          summary: '改了初始值',
          changedFiles: ['src/foo.ts'],
          evidenceIds: [previous.evidenceId],
          notes: '无',
        }),
      },
    ],
  },
};

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

function src(rel: string): string {
  return readFileSync(join(srcRoot, rel), 'utf8');
}

async function existingPlatform() {
  const clock = new FixedClock();
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const projects = new InMemoryProjectRepository();
  const platform = new Platform({
    projects,
    deliveries,
    workspace: new InPlaceWorkspaceManager(),
    activity,
    clock,
    ids,
  });
  const tokens = new RunTokenRegistry();
  const server: Server = createApi({ platform, tokens, deliveries });
  await listenLoopback(server, 0);
  servers.push(server);
  const addr = server.address() as AddressInfo;
  return {
    platform,
    projects,
    tokens,
    server,
    port: addr.port,
    baseUrl: `http://127.0.0.1:${addr.port}`,
  };
}

describe('内部入口：注入既有依赖即可跑，不另建平台或监听', () => {
  test('源码：入口不创建平台、不 listen、不拿锁', () => {
    const runner = src('application/mission-runner.ts');
    // 守的是 import / 调用，不是注释里提到这些词。
    assert.doesNotMatch(runner, /from ['"]\.\.\/api\//);
    assert.doesNotMatch(runner, /from ['"]\.\/loopback-listen\.ts['"]/);
    assert.doesNotMatch(runner, /from ['"]\.\.\/main\.ts['"]/);
    assert.doesNotMatch(runner, /from ['"]\.\/lock\.ts['"]/);
    assert.doesNotMatch(runner, /buildPersistentPlatform\s*\(/);
    assert.doesNotMatch(runner, /buildPgPlatform\s*\(/);
    assert.doesNotMatch(runner, /buildPlatform\s*\(/);
    assert.doesNotMatch(runner, /startServer\s*\(/);
    assert.doesNotMatch(runner, /acquireLock\s*\(/);
    assert.doesNotMatch(runner, /createApi\s*\(/);
    assert.doesNotMatch(runner, /listenLoopback\s*\(/);
    assert.doesNotMatch(runner, /\.listen\s*\(/);
    assert.doesNotMatch(runner, /createMission\s*\(/);
    assert.doesNotMatch(runner, /createClassifiedMission\s*\(/);
    assert.match(runner, /independentReviewer\?:/);
  });

  test('源码：CLI 仍自行装配、接续、过滤候选、回连并输出', () => {
    const cli = src('run-mission.ts');
    assert.match(cli, /new MissionRunner\(/);
    assert.match(cli, /runner\.run\(/);
    assert.match(cli, /createApi\(/);
    assert.match(cli, /listenLoopback\(/);
    assert.match(cli, /loadPoolOrSeed\(/);
    assert.match(cli, /exclusive:\s*\{\s*what:/);
    assert.match(cli, /platform\.createMission\(/);
    assert.match(cli, /platform\.createClassifiedMission\(/);
    assert.match(cli, /Mission \$\{spec\.missionId\} 已存在/);
    assert.match(cli, /--coordinator/);
    assert.match(cli, /--executor/);
    assert.match(cli, /--independent-reviewer/);
    assert.match(cli, /candidates: coordinatorPool\.map/);
    assert.match(cli, /candidates: executorPool\.map/);
    assert.match(cli, /independentReviewer:/);
    assert.match(cli, /server\.close\(\)/);
    assert.match(cli, /releaseLock\(\)/);
    assert.match(cli, /Mission 结果：/);
    // 默认 CLI 参数行为：用法字符串仍在，不把装配挪进内部入口。
    assert.match(cli, /--cwd/);
    assert.match(cli, /--adapter/);
    assert.match(cli, /--in-place/);
    assert.match(cli, /--accept-stale-base/);
  });

  test('注入既有 Platform / issuer / 回环 baseUrl / workspace / 候选，同一实例上跑完一条', async () => {
    const built = await existingPlatform();
    const listeningBefore = built.server.listening;
    const portBefore = built.port;
    assert.equal(listeningBefore, true);

    await built.platform.createMission({
      projectId: 'P',
      missionId: 'M-inject',
      contract: CONTRACT,
    });

    const runner = new MissionRunner({
      platform: built.platform,
      tokens: makeIssuer(built.platform, built.tokens),
      baseUrl: built.baseUrl,
      workspace: new InPlaceWorkspaceManager(),
      coordinator: {
        runtime: new ScriptedRuntime(COORDINATOR_HAPPY),
        candidates: [{ endpoint: 'local', profileId: 'coordinator-a' }],
      },
      executor: {
        runtime: new ScriptedRuntime(EXECUTOR_HAPPY),
        candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
      },
    });

    const ran = await runner.run('M-inject', { projectRoot: process.cwd() });

    assert.deepEqual(ran.outcome, { kind: 'awaiting_l3_review' });
    // 证据必须落在注入的那份平台上——另建第二份的话这里是空的。
    const view = await built.platform.getMissionView('M-inject');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.workItems.length, 1);
    assert.equal(view.workItems[0].status, 'accepted');
    assert.deepEqual(
      ran.hops.map((h) => `${h.role}:${h.endedBy}`),
      ['coordinator:structured_submit', 'executor:structured_submit', 'coordinator:structured_submit'],
    );

    // 入口没有另起监听：原来的口还在、端口没换。
    assert.equal(built.server.listening, true);
    const addr = built.server.address() as AddressInfo;
    assert.equal(addr.port, portBefore);
    const health = await fetch(`${built.baseUrl}/api/health`);
    assert.equal(health.status, 200);
  });

  test('makeIssuer 为独立候选发牌；成功与失败都吊销；重启不复用旧 token', async () => {
    const built = await existingPlatform();
    const issuer = makeIssuer(built.platform, built.tokens);
    assert.equal(typeof issuer.startIndependentReviewer, 'function');

    await assert.rejects(() =>
      issuer.startIndependentReviewer!('M-missing', [{ profileId: 'ir-a', endpoint: 'local' }]),
    );
    // 失败路径没有发出可解析的 token：registry 仍是空的。
    assert.equal(built.tokens.resolve('nope'), undefined);

    const issued = built.tokens.issue({
      missionId: 'M-tok',
      attemptId: 'A-fake',
      role: 'independent_reviewer',
    });
    assert.ok(built.tokens.resolve(issued.token));
    issuer.revoke(issued.token);
    assert.equal(built.tokens.resolve(issued.token), undefined, '成功路径吊销');

    const again = built.tokens.issue({
      missionId: 'M-tok',
      attemptId: 'A-fake-2',
      role: 'independent_reviewer',
    });
    assert.notEqual(again.token, issued.token, '重启续跑不会重复使用旧 token');
    issuer.revoke(again.token);
    assert.equal(built.tokens.resolve(again.token), undefined, '失败后同样吊销');
    assert.equal((built.server.address() as AddressInfo).port, built.port);
  });
});
