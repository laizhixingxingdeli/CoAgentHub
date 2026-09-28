/**
 * SpawnRuntime 终态 contextMetrics：合成结果行只作不可信透传。
 *
 * adapter 不得宣称已验证、不得从 tool 事件猜 read 返回值、缺字段不得补伪零。
 * 畸形 JSON 仍走原来的失败兜底。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpawnRuntime } from '../src/runtime/spawn.ts';
import type { RuntimeEvent, RuntimeOutcome } from '../src/application/ports.ts';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const USAGE = {
  input: 10,
  output: 4,
  cacheRead: 2,
  cacheWrite: 0,
  total: 16,
  quality: 'reported' as const,
};

const PATH_DIGEST = 'ab'.repeat(32);
const CONTENT_DIGEST = 'cd'.repeat(32);

const VALID_METRICS = {
  version: 1,
  coverage: 'complete',
  brief: {
    renderedUtf8Bytes: 1200,
    sources: [
      { source: 'project_rules', estimatedTokens: 40, truncated: false },
      { source: 'work_order', truncated: true },
    ],
  },
  tools: [
    { kind: 'read', calls: 2, returnedUtf8Bytes: 80 },
    { kind: 'grep', calls: 1, returnedUtf8Bytes: 12 },
    { kind: 'find', calls: 1, returnedUtf8Bytes: 0 },
    { kind: 'ls', calls: 3, returnedUtf8Bytes: 40 },
    { kind: 'bash', calls: 1, returnedUtf8Bytes: 9 },
  ],
  reads: [{ pathDigest: PATH_DIGEST, contentDigest: CONTENT_DIGEST, repeats: 2 }],
};

function fakeAdapter(lines: readonly string[], outcomeLine: string | Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-spawn-cm-'));
  dirs.push(dir);
  const file = join(dir, 'adapter.mjs');
  const outcomeExpr =
    typeof outcomeLine === 'string'
      ? JSON.stringify(outcomeLine)
      : `JSON.stringify(${JSON.stringify(outcomeLine)})`;
  writeFileSync(
    file,
    [
      'let raw = "";',
      'for await (const c of process.stdin) raw += c;',
      `for (const line of ${JSON.stringify(lines)}) process.stdout.write(line + "\\n");`,
      `process.stdout.write("__COAGENT_OUTCOME__ " + ${outcomeExpr} + "\\n");`,
    ].join('\n'),
    'utf8',
  );
  return file;
}

async function runAdapter(
  lines: readonly string[],
  outcomeLine: string | Record<string, unknown>,
): Promise<{ events: RuntimeEvent[]; outcome: RuntimeOutcome }> {
  const runtime = new SpawnRuntime({
    kind: 'fake',
    command: 'node',
    args: [fakeAdapter(lines, outcomeLine)],
    cwd: process.cwd(),
    envPassthrough: [],
  });
  const run = await runtime.start({
    role: 'executor',
    attemptId: 'A1',
    missionId: 'M1',
    workItemId: 'W-1',
    cwd: process.cwd(),
    profile: { endpoint: 'local', profileId: 'p' },
    instruction: 'go',
    tools: [],
    endpoint: { baseUrl: 'http://127.0.0.1:1', token: 't' },
  });
  const events: RuntimeEvent[] = [];
  run.on((event) => events.push(event));
  const outcome = await run.wait();
  return { events, outcome };
}

describe('SpawnRuntime 合成结果行 contextMetrics', () => {
  test('可选 contextMetrics 原样透传，不改 endedBy / query / usage', async () => {
    const { outcome } = await runAdapter([], {
      endedBy: 'structured_submit',
      usage: USAGE,
      contextMetrics: VALID_METRICS,
    });
    assert.equal(outcome.endedBy, 'structured_submit');
    assert.deepEqual(outcome.usage, USAGE);
    assert.equal('queryOutcome' in outcome, false);
    assert.deepEqual(outcome.contextMetrics, VALID_METRICS);
  });

  test('旧结果行无指标、不产生伪零', async () => {
    const { outcome } = await runAdapter([], { endedBy: 'structured_submit', usage: USAGE });
    assert.equal(Object.prototype.hasOwnProperty.call(outcome, 'contextMetrics'), false);
    assert.equal(outcome.usage.total, 16);
    assert.notEqual(outcome.contextMetrics, 0);
  });

  test('畸形 JSON 结果行仍按原有失败逻辑，不带摘要', async () => {
    const { outcome } = await runAdapter([], '{not json');
    assert.equal(outcome.endedBy, 'upstream_failure');
    assert.equal(Object.prototype.hasOwnProperty.call(outcome, 'contextMetrics'), false);
    assert.match(outcome.failureMessage ?? '', /没有回传结果|子进程退出/);
  });

  test('摘要畸形也原样透传，adapter 不宣称已验证、不剥敏感字段', async () => {
    const dirty = {
      version: 1,
      coverage: 'complete',
      path: '/etc/passwd',
      body: 'SECRET_SENTINEL',
    };
    const { outcome } = await runAdapter([], {
      endedBy: 'no_structured_result',
      usage: USAGE,
      contextMetrics: dirty,
    });
    assert.equal(outcome.endedBy, 'no_structured_result');
    assert.deepEqual(outcome.contextMetrics, dirty);
  });

  test('不能从 toolActivity 猜 read 返回值', async () => {
    const { events, outcome } = await runAdapter(
      [
        '__COAGENT_EVENT__ {"t":"tool.started","name":"read","callId":"c1"}',
        '__COAGENT_EVENT__ {"t":"tool.completed","name":"read","callId":"c1"}',
      ],
      { endedBy: 'structured_submit', usage: USAGE },
    );
    assert.deepEqual(
      events.filter((event) => event.kind.startsWith('tool.')).map((event) => event.kind),
      ['tool.started', 'tool.completed'],
    );
    assert.equal(Object.prototype.hasOwnProperty.call(outcome, 'contextMetrics'), false);
    const dumped = JSON.stringify(outcome);
    assert.equal(dumped.includes('returnedUtf8Bytes'), false);
    assert.equal(dumped.includes('pathDigest'), false);
  });
});
