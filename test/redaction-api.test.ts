/**
 * 凭据脱敏的落点：agent 交进来的、运行时报上来的、验收命令打出来的，落盘前都已抹掉。
 *
 * 走真实 node:http。已知值来自本进程环境——node --test 每个文件一个进程，
 * 在任何脱敏发生之前设好即可（脱敏器第一次用到时才读环境）。
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform } from '../src/application/platform.ts';
import { OUTPUT_TAIL_MAX_CHARS, ValidationEngine } from '../src/application/validation/engine.ts';
import { QueryRunner } from '../src/application/query-run.ts';
import { InMemoryQueryRunRepository } from '../src/application/in-memory.ts';
import { InMemoryLiveOutput } from '../src/application/live.ts';
import { Orchestrator } from '../src/application/orchestrator.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { makeIssuer } from '../src/main.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { AgentRuntime, RuntimeEvent, RuntimeOutcome } from '../src/application/ports.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

const KNOWN = 'e2e-known-secret-7c1f9a2b';
process.env.E2E_REDACTION_API_KEY = KNOWN;
const SHAPED = 'sk-proj-abcdefghijklmnopqrstuv';

const CONTRACT = { intent: '把 X 修好', acceptance: ['测试全绿'], constraints: [], nonGoals: [], guardrails: [] };
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

let base: string;
let server: ReturnType<typeof createApi>;
let platform: Platform;

before(async () => {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
  server = createApi({ platform, tokens: new RunTokenRegistry(), deliveries });
  await listenLoopback(server, 0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

async function call(path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-coagent-run': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function assertClean(text: unknown, where: string) {
  const s = JSON.stringify(text);
  assert.ok(!s.includes(KNOWN), `${where} 里还有已知 key：${s}`);
  assert.ok(!s.includes(SHAPED), `${where} 里还有 sk- key：${s}`);
}

describe('凭据脱敏的落点', () => {
  test('执行者交的证据 / 执行结果、运行时报的失败原文与输出，落盘前都已抹掉', async () => {
    assert.equal((await call('/api/missions', { projectId: 'P', missionId: 'M-red', contract: CONTRACT })).status, 201);
    const coord = await call('/api/missions/M-red/coordinator-attempts', {});
    const coordToken = coord.json.token as string;
    await call(
      '/api/agent/coagent_update_plan',
      { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] },
      coordToken,
    );
    const workItemId = (await call('/api/agent/coagent_create_work_item', { title: 'W', ...ORDER }, coordToken)).json
      .workItemId as string;
    await call('/api/agent/coagent_submit_contract_check', { verdict: 'ok', summary: '测试契约已核对' }, coordToken);
    await call('/api/agent/coagent_dispatch_work_item', { workItemIds: [workItemId] }, coordToken);

    const exec = await call(`/api/missions/M-red/work-items/${workItemId}/executor-attempts`, {});
    const execToken = exec.json.token as string;
    const attemptId = exec.json.attemptId as string;

    const evidence = await call(
      '/api/agent/coagent_submit_evidence',
      {
        kind: 'command',
        summary: `跑了 env，里面有 ${KNOWN}`,
        command: `curl -H "Authorization: Bearer ${KNOWN}" https://example.invalid`,
        exitCode: 0,
        output: `E2E_REDACTION_API_KEY=${KNOWN}\nOPENAI_KEY=${SHAPED}\ntotal=67360`,
      },
      execToken,
    );
    assert.equal(evidence.status, 200);
    await call(
      '/api/agent/coagent_submit_execution_result',
      {
        outcome: 'completed',
        summary: '改好了',
        changedFiles: ['src/foo.ts'],
        evidenceIds: [evidence.json.evidenceId],
        notes: `顺手看了 .env：api_key=${SHAPED}`,
      },
      execToken,
    );
    await call(`/api/missions/M-red/attempts/${attemptId}/finish`, {
      endedBy: 'upstream_failure',
      failureMessage: `401 with key ${KNOWN}`,
      output: `last lines… ${SHAPED}`,
    });

    const detail = await platform.getAttemptDetail('M-red', attemptId);
    assertClean(detail, 'attempt detail');
    const stored = JSON.stringify(detail);
    assert.match(stored, /\[REDACTED:E2E_REDACTION_API_KEY\]/, '已知值要标出是哪个变量');
    assert.match(stored, /total=67360/, '计数不能被误伤');

    const view = await platform.getMissionView('M-red');
    assertClean(view, 'mission view');
  });

  test('验收命令的输出尾部：先脱敏再截尾', async () => {
    const engine = new ValidationEngine({
      clock: new FixedClock(),
      ids: new SequentialIds(),
      commandRunner: {
        async run() {
          return { exitCode: 1, timedOut: false, durationMs: 1, output: `${'x'.repeat(5000)}\nKEY=${KNOWN}\n${SHAPED}` };
        },
      },
      changedPathReader: { async listChanged() { return []; } },
    });
    const { report } = await engine.validate({
      missionId: 'M-v',
      baseRevision: 'b',
      projectRoot: '/p',
      allowedScope: [],
      commands: [{ argv: ['node', '--test'], cwd: '/p', timeoutMs: 1000 }],
    });
    const tail = report.checks[0]!.command!.outputTail;
    assertClean(tail, 'outputTail');
    assert.match(tail, /\[REDACTED:E2E_REDACTION_API_KEY\]/);
  });

  test('QueryRun 的回答原文落盘前抹掉', async () => {
    const runtime = new ScriptedRuntime({
      'query:-': {
        steps: [],
        output: `答案里带了 ${KNOWN} 和 ${SHAPED}`,
        queryOutcome: 'answered',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, quality: 'reported' },
      },
    });
    const runner = new QueryRunner({
      runtime,
      queryRuns: new InMemoryQueryRunRepository(),
      clock: new FixedClock(),
      ids: new SequentialIds(),
    });
    const result = await runner.runQuery({ projectId: 'P', prompt: '问', cwd: process.cwd(), source: 'test' });
    assertClean(result.record, 'query record');
    assert.match(result.record.output ?? '', /\[REDACTED:E2E_REDACTION_API_KEY\]/);
  });

  test('QueryRun 运行时抛错那条出口：落盘的失败原文里也没有 key', async () => {
    const runtime = new ScriptedRuntime({
      'query:-': { steps: [], connectionError: `401 Unauthorized: key ${KNOWN} rejected` },
    });
    const runner = new QueryRunner({
      runtime,
      queryRuns: new InMemoryQueryRunRepository(),
      clock: new FixedClock(),
      ids: new SequentialIds(),
    });
    const result = await runner.runQuery({ projectId: 'P', prompt: '问', cwd: process.cwd(), source: 'test' });
    assert.equal(result.outcome, 'failed');
    assertClean(result.record, 'failed query record');
    assert.match(result.record.failureMessage ?? '', /\[REDACTED:E2E_REDACTION_API_KEY\]/);
  });

  test('实时输出：文本块与工具行里的命令详情落盘前抹掉', async () => {
    // 自造运行时：订阅之后发一段带 key 的文本、一条带 Authorization 头的命令，然后结束这一跳。
    const probe: AgentRuntime = {
      kind: 'probe',
      async start() {
        const handlers: ((event: RuntimeEvent) => void)[] = [];
        let finish!: (outcome: RuntimeOutcome) => void;
        const finished = new Promise<RuntimeOutcome>((resolve) => {
          finish = resolve;
        });
        setImmediate(() => {
          for (const handler of handlers) {
            handler({ kind: 'output', text: `打印了 env：E2E_REDACTION_API_KEY=${KNOWN}` });
            handler({ kind: 'tool.started', name: 'bash', callId: 'c1', detail: `curl -H "Authorization: Bearer ${KNOWN}"` });
          }
          finish({ endedBy: 'upstream_failure', failureMessage: 'probe done' });
        });
        return {
          resumeRef: undefined,
          on(handler) {
            handlers.push(handler);
            return () => {};
          },
          async abort() {},
          wait: () => finished,
        };
      },
    };
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const deliveries = new InMemoryDeliveryRepository(clock, ids);
    const livePlatform = new Platform({
      projects: new InMemoryProjectRepository(),
      deliveries,
      workspace: new InPlaceWorkspaceManager(),
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
    });
    const tokens = new RunTokenRegistry();
    const liveServer = createApi({ platform: livePlatform, tokens, deliveries });
    await listenLoopback(liveServer, 0);
    try {
      const live = new InMemoryLiveOutput();
      await livePlatform.createMission({ projectId: 'P', missionId: 'M-live', contract: CONTRACT });
      await new Orchestrator({
        platform: livePlatform,
        tokens: makeIssuer(livePlatform, tokens),
        baseUrl: `http://127.0.0.1:${(liveServer.address() as AddressInfo).port}`,
        workspace: new InPlaceWorkspaceManager(),
        live,
        coordinator: { runtime: probe, candidates: [{ endpoint: 'local', profileId: 'probe' }] },
        executor: { runtime: probe, candidates: [{ endpoint: 'local', profileId: 'probe' }] },
      }).runMission('M-live', { projectRoot: process.cwd(), maxRounds: 1 });

      const chunks = await live.since('M-live');
      assert.ok(chunks.some((c) => c.kind === 'text'), '探针的文本块应该进了实时输出');
      assert.ok(chunks.some((c) => c.kind === 'tool' && (c.text ?? '').startsWith('bash · curl')), '工具行应该在');
      assertClean(chunks, 'live chunks');
    } finally {
      liveServer.close();
    }
  });

  test('截尾点正好切在 key 中间：不留半截', async () => {
    // key、换行、再跟 N-9 个 y（换行隔开，免得形状匹配把 y 一起吞了）：先截尾的话，
    // 留下的是 key 的最后 8 个字符，哪个形状都对不上。
    const output = `${SHAPED}\n${'y'.repeat(OUTPUT_TAIL_MAX_CHARS - 9)}`;
    const engine = new ValidationEngine({
      clock: new FixedClock(),
      ids: new SequentialIds(),
      commandRunner: { async run() { return { exitCode: 1, timedOut: false, durationMs: 1, output }; } },
      changedPathReader: { async listChanged() { return []; } },
    });
    const { report } = await engine.validate({
      missionId: 'M-v2',
      baseRevision: 'b',
      projectRoot: '/p',
      allowedScope: [],
      commands: [{ argv: ['node', '--test'], cwd: '/p', timeoutMs: 1000 }],
    });
    const tail = report.checks[0]!.command!.outputTail;
    assert.equal(tail.length, OUTPUT_TAIL_MAX_CHARS);
    assert.ok(!tail.includes(SHAPED.slice(-8)), `半截 key 漏出来了：${tail.slice(0, 20)}`);
  });
});
