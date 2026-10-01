/**
 * W-326：Standard 交卷后的机器验证报告——通过 / 失败两场景。
 *
 * 守住的是「Standard 执行者交卷 → 平台亲自跑冻结 validation.commands → 落盘
 * ValidationReport → 协调者上一跳增量（since_last_hop）里带报告简版」这条链，
 * 而且**整条链由 Orchestrator 主链驱动**，不是测试直接调 platform method。
 *
 * 为什么必须断言 since_last_hop 而不只是工作项索引：W-323 上一轮回退就是因为
 * 复合键错位——索引按 workItemId 取报告，旧提交的事件可能把新交卷的报告挂上去。
 * since_last_hop 走的是「当前 submittedAttemptId 才认」的那条路，只有断言它，
 * 才算真的验证了协调者看到的是**这一次**的报告。
 *
 * 失败场景额外守住两件事：报告简版的 outputTail 是「先脱敏、再截尾 1000」，
 * 并且机器跑红**不会**替 L2 评审——工作项老老实实留在 submitted。
 *
 * W-328：机器接续。验证没过 / 交 partial 时，编排器直接把工单退回执行者（最多两次），
 * 前两次不叫协调者；第三次才把 submitted 连各次报告一起交给 L2。守住的是「机器能判的
 * 不叫醒协调者」这个省钱的判断本身——它一旦失效，症状只是账单变大，没有测试就不会有人发现。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Orchestrator } from '../src/application/orchestrator.ts';
import { Platform, STANDARD_AUTO_REDISPATCH_EVENT_KIND } from '../src/application/platform.ts';
import { makeIssuer } from '../src/main.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';
import { ValidationEngine } from '../src/application/validation/engine.ts';
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import type { ChangedPathReader, CommandRunner } from '../src/application/validation/ports.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import { redactSecrets } from '../src/application/redact.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: ['不得改 Contract'],
};

const ORDER: WorkOrder = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
  validation: {
    commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }],
  },
};

const PLAN = {
  findings: 'foo 一直返回 0',
  rootCause: '初始值写错了',
  rejectedHypotheses: [],
  decisions: ['直接改初始值'],
  direction: '改 src/foo.ts',
  risks: [],
};

/**
 * 协调者两跳：
 *   0 —— 规划 + 建工作项 + 派发（TERMINAL，structured_submit）
 *   1 —— 只读一眼，**不验收**。机器报告只是证据，工单留在 submitted 等 L2。
 *        这一跳不是 TERMINAL，因此 Orchestrator 跑完这一轮就撞上 maxRounds 收工。
 */
const COORDINATOR_SCRIPTS: ScriptTable = {
  'coordinator:-:0': {
    steps: [
      { tool: 'coagent_get_mission', body: {} },
      { tool: 'coagent_update_plan', body: PLAN },
      { tool: 'coagent_create_work_item', body: { title: '修 foo', ...ORDER } },
      // Standard 派发门禁：第一次派发前必须先落一条当前契约修订的核对结论。
      { tool: 'coagent_submit_contract_check', body: { verdict: 'ok', summary: '测试契约已核对' } },
      {
        tool: 'coagent_dispatch_work_item',
        body: (previous) => ({ workItemIds: [previous.workItemId] }),
      },
    ],
  },
  'coordinator:-:1': {
    steps: [{ tool: 'coagent_get_mission', body: {} }],
  },
};

const EXECUTOR_SCRIPTS: ScriptTable = {
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

const PARTIAL_SUMMARY = '只改完一半：foo() 的边界还没处理';

/** 执行者每跳都只交 partial：这条链要靠机器接续往前走，前两次不叫协调者。 */
const PARTIAL_EXECUTOR_SCRIPTS: ScriptTable = {
  'executor:W-1': {
    steps: [
      { tool: 'coagent_get_work_order', body: {} },
      {
        tool: 'coagent_submit_evidence',
        body: { kind: 'test', summary: '改了一半', command: 'node --test', exitCode: 0 },
      },
      {
        tool: 'coagent_submit_execution_result',
        body: (previous) => ({
          outcome: 'partial',
          summary: PARTIAL_SUMMARY,
          changedFiles: ['src/foo.ts'],
          evidenceIds: [previous.evidenceId],
          notes: '还在改边界',
        }),
      },
    ],
  },
};

function fakeRunner(impl: CommandRunner['run']): CommandRunner {
  return { run: impl };
}

function fakePaths(files: readonly string[] = ['src/foo.ts']): ChangedPathReader {
  return {
    async listChanged() {
      return files;
    },
  };
}

const servers: Server[] = [];
const tempDirs: string[] = [];

after(() => {
  for (const server of servers) server.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * 内存 Platform / Workspace / Engine 接缝 + 真 HTTP 面的 ScriptedRuntime，
 * 装配方式与 test/orchestrator.test.ts 一致。cwd 是每次自建的 mkdtemp 临时目录，
 * 被测目标不是进程 cwd；原地工作区不隔离，所以也不涉及 worktree / 真 git。
 */
async function harness(opts: {
  runner: CommandRunner;
  paths: ChangedPathReader;
  /** partial 场景要换一套执行者脚本；不传就用默认的「交 completed」。 */
  executorScripts?: ScriptTable;
}) {
  const clock = new FixedClock('2026-06-01T12:00:00.000Z');
  const activity = new InMemoryActivityLog(clock);
  const projects = new InMemoryProjectRepository();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const reports = new InMemoryValidationReportRepository();
  const engine = new ValidationEngine({
    clock,
    ids: new SequentialIds(),
    commandRunner: opts.runner,
    changedPathReader: opts.paths,
  });
  const workspace = new InPlaceWorkspaceManager();
  const platform = new Platform({
    projects,
    deliveries,
    workspace,
    activity,
    clock,
    ids,
    validation: { engine, reports },
  });
  const tokens = new RunTokenRegistry();
  const server: Server = createApi({ platform, tokens, deliveries });
  await listenLoopback(server, 0);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);

  // 两个 runtime 留成实例，测试才能断言「叫醒语里说了什么、有没有接上一跳的会话」——
  // 这两件事没有别的外部可见症状。
  const coordinatorRuntime = new ScriptedRuntime(COORDINATOR_SCRIPTS);
  const executorRuntime = new ScriptedRuntime(opts.executorScripts ?? EXECUTOR_SCRIPTS);

  return {
    platform,
    projects,
    reports,
    activity,
    coordinatorRuntime,
    executorRuntime,
    makeOrchestrator: () =>
      new Orchestrator({
        platform,
        tokens: makeIssuer(platform, tokens),
        baseUrl,
        workspace,
        coordinator: {
          runtime: coordinatorRuntime,
          candidates: [{ endpoint: 'local', profileId: 'coordinator-a' }],
        },
        executor: {
          runtime: executorRuntime,
          candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
        },
      }),
  };
}

function tempProjectRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Orchestrator 主链走完；maxRounds 恰好覆盖 coord0 / executor / coord1 三轮。 */
async function runStandardChain(
  h: Awaited<ReturnType<typeof harness>>,
  projectRoot: string,
  maxRounds = 3,
) {
  await h.platform.createMission({ projectId: 'P', missionId: 'M-std', contract: CONTRACT });
  await h.makeOrchestrator().runMission('M-std', { projectRoot, maxRounds });
}

/** 取交卷之后的第二跳协调者简报——上一跳增量就是它这一跳要看的「新情况」。 */
async function lastCoordinatorBrief(h: Awaited<ReturnType<typeof harness>>) {
  const view = await h.platform.getMissionView('M-std');
  assert.equal(view.coordinatorAttemptIds.length, 2, 'coord0 派发 + coord1 读一眼');
  const attemptId = view.coordinatorAttemptIds[1]!;
  return h.platform.getStartupBrief('M-std', attemptId);
}

async function liveItem(h: Awaited<ReturnType<typeof harness>>) {
  const project = await h.projects.get('P');
  assert.ok(project);
  const mission = project.missions.find((m) => m.id === 'M-std');
  assert.ok(mission);
  const item = mission.workItem('W-1');
  assert.ok(item);
  return { mission, item };
}

describe('Standard 交卷后的机器验证报告', () => {
  test('命令通过：报告落盘 passed，since_last_hop 带简版，item 仍 submitted', async () => {
    const runner = fakeRunner(async () => ({
      exitCode: 0,
      timedOut: false,
      durationMs: 5,
      output: 'pass',
    }));
    const h = await harness({ runner, paths: fakePaths(['src/foo.ts']) });
    await runStandardChain(h, tempProjectRoot('orchestrator-std-pass-'));

    const brief = await lastCoordinatorBrief(h);

    // 上一跳增量里正好一条带报告简版的机器验证条目，而且是「当前这一次提交」的。
    const withReport = brief.sinceLastHop!.filter((entry) => entry.validationReport !== undefined);
    assert.equal(withReport.length, 1, `since_last_hop 应有且仅有一条报告简版：${JSON.stringify(brief.sinceLastHop)}`);
    const entry = withReport[0]!;
    assert.match(entry.summary, /机器验证/);
    assert.match(entry.summary, /passed/);

    const report = entry.validationReport!;
    assert.equal(report.passed, true);
    assert.equal(report.commands.length, 1);
    assert.equal(report.commands[0]!.passed, true);
    assert.equal(report.commands[0]!.durationMs, 5);
    assert.equal(report.commands[0]!.outputTail, undefined, '通过的命令不带输出尾');
    assert.deepEqual(report.changedPaths, { passed: true, violations: [] });

    // 工作项索引带的是同一份简版（不是复合键错位取到的旧报告）。
    const indexEntry = brief.workItemsIndex!.find((row) => row.id === 'W-1');
    assert.equal(indexEntry?.validationReport?.reportId, report.reportId);

    // 报告确实持久化了，且归属正确。
    const stored = await h.reports.get(report.reportId);
    assert.ok(stored, 'reports.get 必须能取到报告');
    assert.equal(stored.passed, true);
    assert.equal(stored.missionId, 'M-std');
    assert.equal(stored.workItemId, 'W-1');

    // 机器跑绿不等于放行：工单留在 submitted，零评审。
    const { item } = await liveItem(h);
    assert.equal(item.status, 'submitted');
    assert.equal(item.reviews.length, 0);
    assert.equal(item.submittedAttemptId, stored.attemptId);
    const events = await h.activity.list('M-std');
    assert.equal(events.filter((e) => e.kind === 'review.recorded').length, 0);
    assert.equal(events.filter((e) => e.kind === 'validation.reported').length, 1);
  });

  test('命令连续失败：前两次机器退回执行者，第三次失败才交 L2 复核各次报告', async () => {
    // >1000 字，且尾部带一个非数字后缀的凭据值——脱敏器认得出。
    const secret = `sk-${'b'.repeat(30)}`;
    const rawOutput = `${'x'.repeat(1500)}\napi_key=${secret}\nEND-MARKER`;
    const runner = fakeRunner(async () => ({
      exitCode: 1,
      timedOut: false,
      durationMs: 7,
      output: rawOutput,
    }));
    const h = await harness({ runner, paths: fakePaths(['src/foo.ts']) });
    // 每轮 pending 只领一条工单：开局派发 + 三次执行者 + 触顶后收尾，共五轮。
    await runStandardChain(h, tempProjectRoot('orchestrator-std-fail-'), 5);

    const view = await h.platform.getMissionView('M-std');
    // 前两次失败由机器自己退回执行者，协调者不出场：只有开局派发与触顶后的收尾两跳。
    assert.equal(
      view.coordinatorAttemptIds.length,
      2,
      `前两轮不该叫协调者：${JSON.stringify(view.coordinatorAttemptIds)}`,
    );
    // 每轮都是新的一次执行者 Attempt 接续，而不是把同一跳重跑。
    const itemView = view.workItems.find((row) => row.id === 'W-1');
    assert.equal(itemView?.attemptIds.length, 3, '三次提交各对应一次新的执行者 Attempt');

    // 失败摘要随唤醒语到达下一跳：执行者拿得到「上一轮哪条命令、怎么挂的」。
    const instructions = h.executorRuntime.instructions;
    assert.equal(instructions.length, 3);
    assert.match(instructions[1]!, /第 1 次退回重做/);
    assert.match(instructions[1]!, /node --test: command exited 1/);
    assert.match(instructions[2]!, /第 2 次退回重做/);

    // 验证失败**不**接上一跳的会话：那条会话产出的结果已经被机器判为不合格。
    assert.deepEqual(h.executorRuntime.resumeRefs, [undefined, undefined, undefined]);

    // 触顶：第三次失败留在 submitted，机器不再退回（也就没有第三条 auto 事件）。
    const events = await h.activity.list('M-std');
    const auto = events.filter((event) => event.kind === STANDARD_AUTO_REDISPATCH_EVENT_KIND);
    assert.equal(auto.length, 2, '只有前两次失败被自动退回');
    assert.deepEqual(
      auto.map((event) => (event.data as { reason: string }).reason),
      ['validation_failed', 'validation_failed'],
    );
    assert.deepEqual(
      auto.map((event) => (event.data as { count: number }).count),
      [1, 2],
    );
    assert.match((auto[0]!.data as { summary: string }).summary, /node --test: command exited 1/);

    // 各次报告都留在仓储里：L2 逐份复核，不是只看最后那份。
    const reported = events.filter((event) => event.kind === 'validation.reported');
    assert.equal(reported.length, 3);
    const reportIds = reported.map((event) => (event.data as { reportId: string }).reportId);
    assert.equal(new Set(reportIds).size, 3, '每次失败都是新报告，不覆盖上一份');
    for (const reportId of reportIds) {
      const stored = await h.reports.get(reportId);
      assert.ok(stored, `报告 ${reportId} 必须可复核`);
      assert.equal(stored.passed, false);
    }

    // 触顶那次失败的报告就是 L2 这一跳看到的「新情况」。
    const brief = await lastCoordinatorBrief(h);

    const withReport = brief.sinceLastHop!.filter((entry) => entry.validationReport !== undefined);
    assert.equal(withReport.length, 1, `since_last_hop 应有且仅有一条报告简版：${JSON.stringify(brief.sinceLastHop)}`);
    const entry = withReport[0]!;
    assert.match(entry.summary, /机器验证/);
    assert.match(entry.summary, /failed/);

    const reportView = entry.validationReport!;
    assert.equal(reportView.passed, false);
    assert.equal(reportView.commands.length, 1);
    assert.equal(reportView.commands[0]!.passed, false);
    assert.equal(reportView.commands[0]!.durationMs, 7);

    const outputTail = reportView.commands[0]!.outputTail;
    assert.ok(outputTail !== undefined, '失败命令必须带输出尾');
    // 顺序反了（先截尾再脱敏）时，被切掉的值不再命中形状，长度也会短一截：
    // 恰好 1000 字 + 值被替换，才说明是「先脱敏、再截尾」。
    assert.equal(outputTail.length, 1000);
    assert.equal(outputTail, redactSecrets(rawOutput).slice(-1000));
    assert.ok(outputTail.includes('api_key=[REDACTED]'), `未脱敏：${outputTail}`);
    assert.ok(!outputTail.includes(secret), '凭据原文不得出现在简报里');
    assert.ok(outputTail.endsWith('END-MARKER'));

    // report passed=false，按 ID 能取到完整报告。
    const stored = await h.platform.getValidationReport('M-std', reportView.reportId);
    assert.ok(stored, '按 reportId 必须能取到完整报告');
    assert.equal(stored.passed, false);
    assert.equal(stored.missionId, 'M-std');
    assert.equal(stored.workItemId, 'W-1');
    assert.ok(reportIds.includes(stored.id), 'L2 看的就是这一次提交的报告');

    // 机器跑红也不替 L2 评审：item 仍 submitted，没有接受也没有退回。
    const { item, mission } = await liveItem(h);
    assert.equal(item.status, 'submitted');
    assert.equal(item.reviews.length, 0);
    assert.equal(item.submittedAttemptId, stored.attemptId);
    assert.equal(mission.status, 'executing');
    assert.equal(events.filter((event) => event.kind === 'review.recorded').length, 0);
  });

  test('partial 连续两次接着做：上轮说明与 resumeRef 传下去，第三次才叫 L2', async () => {
    const runner = fakeRunner(async () => ({
      exitCode: 0,
      timedOut: false,
      durationMs: 3,
      output: 'pass',
    }));
    const h = await harness({
      runner,
      paths: fakePaths(['src/foo.ts']),
      executorScripts: PARTIAL_EXECUTOR_SCRIPTS,
    });
    // 同上：开局派发 + 三次 partial + 触顶后收尾。
    await runStandardChain(h, tempProjectRoot('orchestrator-std-partial-'), 5);

    const view = await h.platform.getMissionView('M-std');
    assert.equal(
      view.coordinatorAttemptIds.length,
      2,
      `两次 partial 之间不该有协调者：${JSON.stringify(view.coordinatorAttemptIds)}`,
    );
    assert.equal(view.workItems.find((row) => row.id === 'W-1')?.attemptIds.length, 3);

    // 上一轮说明确实带到了下一跳（从持久事件读回来的，不是内存里的）。
    const instructions = h.executorRuntime.instructions;
    assert.equal(instructions.length, 3);
    assert.match(instructions[1]!, /半成品/);
    assert.match(instructions[1]!, /只改完一半/);
    assert.match(instructions[2]!, /第 2 次接着做/);
    assert.match(instructions[2]!, /只改完一半/);

    // partial 有已存 resumeRef 就传给运行时：接着上一跳那个会话做最省。
    assert.deepEqual(h.executorRuntime.resumeRefs, [
      undefined,
      'scripted:executor:W-1:0',
      'scripted:executor:W-1:1',
    ]);

    // partial 不是「做完了」：冻结命令一次都没跑。
    const events = await h.activity.list('M-std');
    assert.equal(events.filter((event) => event.kind === 'validation.reported').length, 0);

    const auto = events.filter((event) => event.kind === STANDARD_AUTO_REDISPATCH_EVENT_KIND);
    assert.equal(auto.length, 2);
    assert.deepEqual(
      auto.map((event) => (event.data as { reason: string }).reason),
      ['partial', 'partial'],
    );
    assert.deepEqual(
      auto.map((event) => (event.data as { count: number }).count),
      [1, 2],
    );
    assert.equal((auto[0]!.data as { summary: string }).summary, PARTIAL_SUMMARY);

    // 第三次 partial 触顶：留在 submitted 交 L2，机器不再退回。
    const { item } = await liveItem(h);
    assert.equal(item.status, 'submitted');
    assert.equal(item.reviews.length, 0);

    // L2 这一跳才被叫起来，简报里看得到三次 partial 提交。
    const brief = await lastCoordinatorBrief(h);
    assert.equal(
      brief.sinceLastHop!.filter((entry) => entry.summary.includes('partial')).length,
      3,
      `L2 应看到三次 partial 提交：${JSON.stringify(brief.sinceLastHop)}`,
    );
    assert.equal(events.filter((event) => event.kind === 'review.recorded').length, 0);
  });
});
