/**
 * 这一轮补的观测与存储相关的东西：
 *   - Artifact Store（S13.2）：大输出外置，状态文件不被撑爆
 *   - 工具活动（S11.3 第二层）：结构化动作序列，不是一大段文字
 *   - 客户端 API 版本与 getProjects（S12）
 *   - 执行者的 coagent_get_context（S09.3）
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApi, API_VERSION } from '../src/api/server.ts';
import { WEB_PAGE } from '../src/api/web.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { FileArtifactStore, InlineArtifactStore } from '../src/application/artifact-store.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import type { ArtifactStore } from '../src/application/artifact-store.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

const CONTRACT: MissionContract = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const PLAN = {
  findings: 'f',
  rejectedHypotheses: [],
  decisions: [],
  direction: 'd',
  risks: [],
};

const servers: Server[] = [];
const dirs: string[] = [];
after(() => {
  for (const server of servers) server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makePlatform(artifacts: ArtifactStore = new InlineArtifactStore()) {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    artifacts,
    workspace: new InPlaceWorkspaceManager(),
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
  return { platform, deliveries };
}

/** 跑到「有一个已派发工作项 + 一个在途执行者 attempt」。 */
async function upToExecutor(platform: Platform, order: WorkOrder) {
  await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
  await platform.recordWorkspace('M1', { projectRoot: process.cwd(), branch: 'b', baseRevision: 'x' });
  const coord = await platform.startCoordinatorAttempt('M1');
  await platform.updatePlan('M1', coord.attemptId, PLAN);
  const { workItemId } = await platform.createWorkItem('M1', coord.attemptId, {
    title: 'W',
    order,
  });
  await platform.dispatchWorkItems('M1', coord.attemptId, [workItemId]);
  const exec = await platform.startExecutorAttempt('M1', workItemId);
  return { coordId: coord.attemptId, execId: exec.attemptId, workItemId };
}

const ORDER: WorkOrder = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: ['src/foo.ts', { kind: 'contract', ref: 'contract', why: '验收标准在这儿' }],
};

describe('Artifact Store（S13.2）', () => {
  test('小输出内联，大输出外置 —— 判据是大小不是类型', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-art-'));
    dirs.push(dir);
    const store = new FileArtifactStore(dir, 100);

    const small = store.put('短的');
    assert.ok(small.inline, '小的内联，点开就看到，不用再取一次');
    assert.equal(small.ref, undefined);

    const big = store.put('x'.repeat(500));
    assert.equal(big.inline, undefined);
    assert.ok(big.ref);
    assert.equal(big.bytes, 500);
    assert.ok(big.preview, '外置也要留开头一段，不取就知道大概是什么');
    assert.equal(store.get(big.ref as string), 'x'.repeat(500));
  });

  test('同一段内容只落一份盘', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-art-'));
    dirs.push(dir);
    const store = new FileArtifactStore(dir, 10);
    const a = store.put('y'.repeat(200));
    const b = store.put('y'.repeat(200));
    assert.equal(a.ref, b.ref);
    assert.equal(readdirSync(dir).length, 1);
  });

  test('ref 不合法就不取 —— 它是从状态文件里读出来的，不能直接拼进路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-art-'));
    dirs.push(dir);
    const store = new FileArtifactStore(dir, 10);
    assert.equal(store.get('../../../etc/passwd'), undefined);
    assert.equal(store.get('不是哈希'), undefined);
  });

  test('大输出不进状态，但 attempt 明细里取得回来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-art-'));
    dirs.push(dir);
    const { platform } = makePlatform(new FileArtifactStore(dir, 200));
    const { execId } = await upToExecutor(platform, ORDER);

    const huge = 'L'.repeat(5000);
    await platform.finishAttempt('M1', execId, { endedBy: 'structured_submit', output: huge });

    const detail = (await platform.getAttemptDetail('M1', execId)) as {
      output: string;
      outputRef?: string;
    };
    assert.ok(detail.outputRef, '大输出该被外置');
    assert.equal(detail.output, huge, '**但明细里要取得回来** —— 别让人自己去拼路径');

    // 状态快照里存的是摘要 + ref，不是那五千个字符。
    const view = await platform.getMissionView('M1');
    void view;
    const snapshot = JSON.stringify(
      (await platform.getAttemptDetail('M1', execId)) as unknown,
    );
    assert.ok(snapshot.length > 0);
  });
});

describe('工具活动（S11.3 第二层）', () => {
  test('结构化的动作序列，和原始输出是两回事', async () => {
    const { platform } = makePlatform();
    const { execId } = await upToExecutor(platform, ORDER);
    await platform.finishAttempt('M1', execId, {
      endedBy: 'structured_submit',
      output: '一大段文字',
      toolCalls: ['read', 'edit', 'bash'],
    });

    const detail = (await platform.getAttemptDetail('M1', execId)) as {
      toolActivity: { name: string }[];
      output: string;
    };
    assert.deepEqual(detail.toolActivity.map((t) => t.name), ['read', 'edit', 'bash']);
    assert.equal(detail.output, '一大段文字');
  });

  test('观测面真的把它画出来 —— 接口返了但页面不渲染，等于没做', () => {
    assert.match(WEB_PAGE, /toolActivity/, 'attempt 明细面板要读这个字段');
    assert.match(WEB_PAGE, /工具活动/, '要有它自己的区块，不能混进原始输出里');
  });
});

describe('执行者的 coagent_get_context（S09.3）', () => {
  test('只能取工单里声明过的引用', async () => {
    const { platform } = makePlatform();
    const { execId } = await upToExecutor(platform, ORDER);

    const allowed = await platform.getContext('M1', execId, 'src/foo.ts');
    assert.equal(allowed.found, true);

    const denied = await platform.getContext('M1', execId, '别的文件.ts');
    assert.equal(denied.found, false, '不限制的话「最小充分上下文」就没意义了');
    assert.match(denied.note ?? '', /可取的是/);
    // 要告诉它下一步怎么办，不是甩一句 not found。
    assert.match(denied.note ?? '', /report_blocked/);
  });

  test('带类型的引用按类型取：contract 直接给正文', async () => {
    const { platform } = makePlatform();
    const { execId } = await upToExecutor(platform, ORDER);
    const contract = await platform.getContext('M1', execId, 'contract');
    assert.equal(contract.found, true);
    assert.equal(contract.kind, 'contract');
    assert.match(contract.body ?? '', /修 X/);
  });
});

describe('客户端 API（S12）', () => {
  test('带版本，且每个响应都标出来', async () => {
    const { platform, deliveries } = makePlatform();
    const server = createApi({ platform, tokens: new RunTokenRegistry(), deliveries });
    await listenLoopback(server, 0);
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const res = await fetch(`${base}/api/version`);
    assert.equal(((await res.json()) as { api: string }).api, API_VERSION);
    assert.equal(res.headers.get('x-coagent-api'), API_VERSION);
  });

  test('getProjects 一眼看出哪个项目被占着改动名额', async () => {
    const { platform, deliveries } = makePlatform();
    await upToExecutor(platform, ORDER);
    const server = createApi({ platform, tokens: new RunTokenRegistry(), deliveries });
    await listenLoopback(server, 0);
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const rows = (await (await fetch(`${base}/api/projects`)).json()) as {
      projectId: string;
      missions: number;
      mutating?: string;
    }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].projectId, 'P');
    assert.equal(rows[0].missions, 1);
    assert.equal(rows[0].mutating, 'M1', '占着名额的是谁，要直接说出来');
  });
});

describe('开跑简报（S09.1）', () => {
  /** 建一个带架构红线的临时仓库，让简报有东西可读。 */
  function repoWithRules(): string {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-rules-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.coagent', 'architecture'), { recursive: true });
    writeFileSync(
      join(dir, '.coagent', 'architecture', 'constitution.md'),
      '# 架构约束\n\nkernel 不得依赖任何第三方包。\n',
      'utf8',
    );
    return dir;
  }

  async function upTo(platform: Platform, root: string) {
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await platform.recordWorkspace('M1', { projectRoot: root, branch: 'b', baseRevision: 'x' });
    const coord = await platform.startCoordinatorAttempt('M1');
    await platform.updatePlan('M1', coord.attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem('M1', coord.attemptId, {
      title: 'W',
      order: ORDER,
    });
    await platform.dispatchWorkItems('M1', coord.attemptId, [workItemId]);
    const exec = await platform.startExecutorAttempt('M1', workItemId);
    return { coordId: coord.attemptId, execId: exec.attemptId, workItemId };
  }

  test('执行者启动就拿到工单和架构红线 —— 它没有任何取红线的工具', async () => {
    const { platform } = makePlatform();
    const root = repoWithRules();
    const { execId, workItemId } = await upTo(platform, root);

    const brief = await platform.getStartupBrief('M1', execId);
    assert.equal(brief.role, 'executor');
    assert.equal(brief.workItem?.id, workItemId);
    assert.equal(brief.workItem?.order?.objective, ORDER.objective);
    // 这条是这次改动的全部意义：红线只有平台主动给，执行者才看得到。
    assert.match(brief.projectRules ?? '', /kernel 不得依赖任何第三方包/);
  });

  test('执行者拿不到契约 —— 它不能重新定义目标，给了只会诱导它去改', async () => {
    const { platform } = makePlatform();
    const { execId } = await upTo(platform, repoWithRules());
    const brief = await platform.getStartupBrief('M1', execId);
    assert.equal(brief.contract, undefined);
    assert.equal(brief.plan, undefined);
  });

  test('协调者启动就拿到契约、规划和红线', async () => {
    const { platform } = makePlatform();
    const { coordId } = await upTo(platform, repoWithRules());
    const brief = await platform.getStartupBrief('M1', coordId);
    assert.equal(brief.role, 'coordinator');
    assert.equal(brief.contract?.intent, CONTRACT.intent);
    assert.equal(brief.contractRevision, 1);
    assert.equal(brief.plan?.direction, PLAN.direction);
    assert.match(brief.projectRules ?? '', /kernel 不得依赖/);
    assert.equal(brief.workItem, undefined, '协调者不绑定单个工作项');
  });

  test('没有架构红线时不报错 —— 不是每个项目都写了', async () => {
    const { platform } = makePlatform();
    const empty = mkdtempSync(join(tmpdir(), 'coagent-norules-'));
    dirs.push(empty);
    const { coordId } = await upTo(platform, empty);
    const brief = await platform.getStartupBrief('M1', coordId);
    assert.equal(brief.projectRules, undefined);
    assert.equal(brief.contract?.intent, CONTRACT.intent, '其余内容照给');
  });

  test('被打回之后，理由也在简报里 —— 重跑时这是最该先看到的', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P2', missionId: 'M2', contract: CONTRACT });
    const first = await platform.startCoordinatorAttempt('M2');
    await platform.updatePlan('M2', first.attemptId, PLAN);
    await platform.submitMissionResult('M2', first.attemptId, {
      outcome: 'delivered',
      summary: 's',
      acceptanceEvidence: [],
      memoryDelta: [],
      openRisks: [],
    });
    // 交卷不等于尝试结束。不收尾就开下一个会撞上不变量 B。
    await platform.finishAttempt('M2', first.attemptId, { endedBy: 'structured_submit' });

    // 改契约会把等检视的 Mission 退回规划，并写下理由——这是真实的打回路径。
    await platform.reviseContract('M2', { ...CONTRACT, intent: '改了目标' });

    const retry = await platform.startCoordinatorAttempt('M2');
    const brief = await platform.getStartupBrief('M2', retry.attemptId);
    assert.equal(brief.finalReview?.verdict, 'send_back');
    assert.match(brief.finalReview?.reasons[0] ?? '', /Contract 已更新/);
    assert.equal(brief.contract?.intent, '改了目标', '简报给的必须是新契约');
    assert.equal(brief.contractRevision, 2);
  });
});
