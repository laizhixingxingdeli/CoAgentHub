/**
 * 独立 QueryRun：只读问答，不进 Mission 状态机。
 *
 * 守住的硬边界：
 *   - 不 createMission / 不 prepare worktree / 不启 Coordinator
 *   - 写工具在 runtime.start 前被拒
 *   - role=query + 只读 tools allowlist
 *   - 成功/失败均可查询 QueryRun record
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  InMemoryQueryRunRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import {
  QUERY_READONLY_TOOLS,
  QueryRunner,
  assertQueryToolsAllowed,
  rejectedQueryTools,
  runQuery,
} from '../src/application/query-run.ts';
import type { DecisionProvider, DecisionRequest } from '../src/application/ports.ts';
import type { WorkspaceManager } from '../src/application/workspace.ts';
import { buildPlatform } from '../src/main.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import { SpawnRuntime } from '../src/runtime/spawn.ts';
import type { AgentRuntime } from '../src/application/ports.ts';

function spyWorkspace(): WorkspaceManager & { prepareCalls: number } {
  const state = { prepareCalls: 0 };
  return {
    get prepareCalls() {
      return state.prepareCalls;
    },
    async prepare() {
      state.prepareCalls += 1;
      return {
        cwd: process.cwd(),
        branch: 'spy',
        baseRevision: '0'.repeat(40),
      };
    },
    async mergeToTarget() {
      return { ok: true, mergedInto: 'main' };
    },
    async rollback() {},
    async clean() {},
    async diff() {
      return { stat: '', files: [] };
    },
    async head() {
      return '0'.repeat(40);
    },
    worktreePath() {
      return undefined;
    },
  };
}

function countingDecisionProvider(): DecisionProvider & { calls: number } {
  let calls = 0;
  return {
    kind: 'counting-test',
    get calls() {
      return calls;
    },
    async decide(_request: DecisionRequest) {
      calls += 1;
      return { answers: { noop: { kind: 'noop' as const } } };
    },
  };
}

describe('query tools allowlist', () => {
  test('默认只读表通过', () => {
    assert.deepEqual(rejectedQueryTools(QUERY_READONLY_TOOLS), []);
    assert.doesNotThrow(() => assertQueryToolsAllowed(QUERY_READONLY_TOOLS));
  });

  test('写工具与 shell 与 coagent_* 被拒', () => {
    const bad = rejectedQueryTools([
      'read',
      'write',
      'edit',
      'bash',
      'powershell',
      'coagent_update_plan',
      'coagent_submit_execution_result',
      'unknown_tool',
    ]);
    assert.deepEqual(bad, [
      'write',
      'edit',
      'bash',
      'powershell',
      'coagent_update_plan',
      'coagent_submit_execution_result',
      'unknown_tool',
    ]);
  });
});

describe('QueryRunner.runQuery', () => {
  test('成功 answered：role=query、只读 tools、可查询 record、有 usage/output', async () => {
    const clock = new FixedClock('2026-06-01T12:00:00.000Z');
    const ids = new SequentialIds();
    const queryRuns = new InMemoryQueryRunRepository();
    const runtime = new ScriptedRuntime({
      'query:-': {
        steps: [
          { tool: 'ls', body: {} },
          { tool: 'read', body: { path: 'README.md' } },
          { tool: 'grep', body: { pattern: 'CoAgent' } },
        ],
        output: '项目是 CoAgentHub v5 harness。',
        queryOutcome: 'answered',
        usage: {
          input: 100,
          output: 40,
          cacheRead: 0,
          cacheWrite: 0,
          total: 140,
          quality: 'reported',
        },
      },
    });
    const workspace = spyWorkspace();
    const decision = countingDecisionProvider();
    const projects = new InMemoryProjectRepository();
    const platform = new Platform({
      projects,
      deliveries: new InMemoryDeliveryRepository(clock, ids),
      workspace,
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
      decisionProvider: decision,
    });

    const runner = new QueryRunner({ runtime, queryRuns, clock, ids });
    const result = await runner.runQuery({
      projectId: 'P-q',
      prompt: '这个仓库是干什么的？',
      cwd: process.cwd(),
      source: 'test',
    });

    assert.equal(result.outcome, 'answered');
    assert.equal(result.queryRunId, 'Q-1');
    assert.equal(result.record.status, 'ended');
    assert.equal(result.record.outcome, 'answered');
    assert.equal(result.record.source, 'test');
    assert.equal(result.record.projectId, 'P-q');
    assert.equal(result.record.output, '项目是 CoAgentHub v5 harness。');
    assert.equal(result.record.usage.input, 100);
    assert.equal(result.record.usage.output, 40);
    assert.equal(result.record.startedAt, '2026-06-01T12:00:00.000Z');
    assert.ok(result.record.endedAt);

    const loaded = await runner.getQueryRun('Q-1');
    assert.ok(loaded);
    assert.equal(loaded?.outcome, 'answered');

    // runtime spec
    assert.equal(runtime.specs.length, 1);
    assert.equal(runtime.specs[0]?.role, 'query');
    assert.deepEqual([...runtime.specs[0]!.tools], [...QUERY_READONLY_TOOLS]);
    assert.equal(runtime.specs[0]?.missionId, '');
    assert.equal(runtime.specs[0]?.endpoint.token, '');
    assert.equal(runtime.specs[0]?.instruction, '这个仓库是干什么的？');

    // 硬边界：不 prepare、不建 Mission、不调 Decision
    assert.equal(workspace.prepareCalls, 0);
    assert.equal((await projects.list()).length, 0);
    assert.equal(decision.calls, 0);
    // platform 侧也无 Mission
    assert.deepEqual(await platform.listMissions(), []);
  });

  test('失败 failed：仍可查询 record，带 failureMessage', async () => {
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const queryRuns = new InMemoryQueryRunRepository();
    const runtime = new ScriptedRuntime({
      'query:-': {
        steps: [],
        upstreamFailure: 'model overloaded',
      },
    });
    const runner = new QueryRunner({ runtime, queryRuns, clock, ids });
    const result = await runner.runQuery({
      projectId: 'P',
      prompt: '?',
      cwd: '/tmp',
      source: 'cli',
    });

    assert.equal(result.outcome, 'failed');
    assert.equal(result.record.status, 'ended');
    assert.equal(result.record.outcome, 'failed');
    assert.equal(result.record.endedBy, 'upstream_failure');
    assert.equal(result.record.failureMessage, 'model overloaded');

    const listed = await runner.listQueryRuns('P');
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, result.queryRunId);
  });

  test('needs_mutation：只记账，不 createMission', async () => {
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const queryRuns = new InMemoryQueryRunRepository();
    const projects = new InMemoryProjectRepository();
    const workspace = spyWorkspace();
    const platform = new Platform({
      projects,
      deliveries: new InMemoryDeliveryRepository(clock, ids),
      workspace,
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
    });
    const runtime = new ScriptedRuntime({
      'query:-': {
        steps: [{ tool: 'find', body: { pattern: '**/*.ts' } }],
        output: '需要改代码才能完成。',
        queryOutcome: 'needs_mutation',
      },
    });

    const result = await runQuery(
      { runtime, queryRuns, clock, ids },
      {
        projectId: 'P-mut',
        prompt: '把 X 修好',
        cwd: process.cwd(),
        source: 'api',
      },
    );

    assert.equal(result.outcome, 'needs_mutation');
    assert.equal(result.record.outcome, 'needs_mutation');
    assert.equal(workspace.prepareCalls, 0);
    assert.equal((await projects.list()).length, 0);
    assert.deepEqual(await platform.listMissions(), []);
  });

  test('写工具注入在 runtime.start 前失败', async () => {
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const queryRuns = new InMemoryQueryRunRepository();
    let startCalls = 0;
    const runtime: AgentRuntime = {
      kind: 'spy',
      supportsQuery: true,
      async start() {
        startCalls += 1;
        throw new Error('不应被调用');
      },
    };
    const runner = new QueryRunner({ runtime, queryRuns, clock, ids });

    await assert.rejects(
      () =>
        runner.runQuery({
          projectId: 'P',
          prompt: '改文件',
          cwd: process.cwd(),
          source: 'test',
          tools: ['read', 'write', 'bash'],
        }),
      (err: unknown) => {
        assert.ok(err instanceof PlatformRuleError);
        assert.equal(err.code, 'QUERY_TOOLS_NOT_READONLY');
        assert.match(err.message, /write/);
        assert.match(err.message, /bash/);
        return true;
      },
    );
    assert.equal(startCalls, 0);
    // 拒绝发生在建 record / start 之前：仓库应为空
    assert.equal((await queryRuns.list()).length, 0);
  });

  test('coagent_* 写工具同样在 start 前拒绝', async () => {
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const queryRuns = new InMemoryQueryRunRepository();
    let startCalls = 0;
    const runner = new QueryRunner({
      runtime: {
        kind: 'spy',
        supportsQuery: true,
        async start() {
          startCalls += 1;
          return {
            resumeRef: undefined,
            on() {
              return () => {};
            },
            async abort() {},
            async wait() {
              return {
                endedBy: 'no_structured_result' as const,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                  quality: 'unknown' as const,
                },
              };
            },
          };
        },
      },
      queryRuns,
      clock,
      ids,
    });

    await assert.rejects(
      () =>
        runner.runQuery({
          projectId: 'P',
          prompt: 'x',
          cwd: process.cwd(),
          source: 'test',
          tools: ['ls', 'coagent_update_plan'],
        }),
      (err: unknown) => err instanceof PlatformRuleError && err.code === 'QUERY_TOOLS_NOT_READONLY',
    );
    assert.equal(startCalls, 0);
  });

  test('runtime 抛错也落 failed record', async () => {
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const queryRuns = new InMemoryQueryRunRepository();
    const runner = new QueryRunner({
      runtime: {
        kind: 'boom',
        supportsQuery: true,
        async start() {
          throw new Error('spawn failed');
        },
      },
      queryRuns,
      clock,
      ids,
    });

    const result = await runner.runQuery({
      projectId: 'P',
      prompt: 'q',
      cwd: process.cwd(),
      source: 'test',
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.record.failureMessage, 'spawn failed');
    assert.equal((await queryRuns.get(result.queryRunId))?.outcome, 'failed');
  });
});

describe('query runtime capability gate', () => {
  test('非 query-capable fake：构造即拒，start=0 save=0', async () => {
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const queryRuns = new InMemoryQueryRunRepository();
    let startCalls = 0;
    const runtime: AgentRuntime = {
      kind: 'not-query-capable',
      // 故意不声明 supportsQuery
      async start() {
        startCalls += 1;
        throw new Error('不应被调用');
      },
    };

    assert.throws(
      () => new QueryRunner({ runtime, queryRuns, clock, ids }),
      (err: unknown) => {
        assert.ok(err instanceof PlatformRuleError);
        assert.equal(err.code, 'QUERY_RUNTIME_UNSUPPORTED');
        return true;
      },
    );
    assert.equal(startCalls, 0);
    assert.equal((await queryRuns.list()).length, 0);
  });

  test('SpawnRuntime 默认不支持 query：构造拒 + buildPlatform 不暴露', async () => {
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const queryRuns = new InMemoryQueryRunRepository();
    const spawn = new SpawnRuntime({
      kind: 'pi',
      command: 'node',
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
    });
    assert.notEqual(spawn.supportsQuery, true);

    assert.throws(
      () => new QueryRunner({ runtime: spawn, queryRuns, clock, ids }),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'QUERY_RUNTIME_UNSUPPORTED',
    );
    assert.equal((await queryRuns.list()).length, 0);

    const built = buildPlatform(undefined, undefined, spawn);
    assert.equal(built.runQuery, undefined);
    assert.equal(built.queryRunner, undefined);
  });
});

describe('buildPlatform 注入 query', () => {
  test('注入 ScriptedRuntime 后 runQuery answered 可用', async () => {
    const runtime = new ScriptedRuntime({
      'query:-': {
        steps: [{ tool: 'ls', body: {} }],
        output: 'ok',
        queryOutcome: 'answered',
      },
    });
    assert.equal(runtime.supportsQuery, true);
    const built = buildPlatform(undefined, undefined, runtime);
    assert.ok(built.runQuery);
    assert.ok(built.queryRunner);
    const result = await built.runQuery!({
      projectId: 'P',
      prompt: 'hi',
      cwd: process.cwd(),
      source: 'buildPlatform',
    });
    assert.equal(result.outcome, 'answered');
    assert.equal((await built.queryRuns.get(result.queryRunId))?.source, 'buildPlatform');
  });

  test('未注入 runtime 时 queryRuns 仍在，runQuery 为空', () => {
    const built = buildPlatform();
    assert.ok(built.queryRuns);
    assert.equal(built.runQuery, undefined);
    assert.equal(built.queryRunner, undefined);
  });

  test('注入非 query-capable runtime 时 runQuery 仍为空（fail-closed）', () => {
    const fake: AgentRuntime = {
      kind: 'looks-safe-but-isnt',
      async start() {
        throw new Error('不应暴露');
      },
    };
    const built = buildPlatform(undefined, undefined, fake);
    assert.equal(built.runQuery, undefined);
    assert.equal(built.queryRunner, undefined);
  });
});

describe('InMemoryQueryRunRepository 不伪装 durable', () => {
  test('注释与实现：仅 Map，无文件路径', async () => {
    const repo = new InMemoryQueryRunRepository();
    await repo.save({
      id: 'Q-x',
      projectId: 'P',
      source: 't',
      prompt: 'p',
      cwd: '/',
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'ended',
      outcome: 'answered',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        total: 2,
        quality: 'reported',
      },
    });
    assert.equal((await repo.get('Q-x'))?.id, 'Q-x');
    // 新实例彼此隔离 = 进程内记忆，非跨进程
    const other = new InMemoryQueryRunRepository();
    assert.equal(await other.get('Q-x'), undefined);
  });
});
