/**
 * S11.4：运行时事件映射。
 *
 * 这组测试的由来是一次**说过头**：我声称实时面板有结构化工具活动和会跳动的
 * token 数，但真实路径上 SpawnRuntime 只发 `output` 和一次收尾时的 `usage`——
 * `tool.started` 这一支一次都没进过。库里的实时行印证：历史上只有 text 类型。
 *
 * 当时的测试是手工把事件塞进管道，所以它测的是**管道通不通**，
 * 不是真有东西流过。这里补上后者：从子进程真实的 stdout 出发。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpawnRuntime } from '../src/runtime/spawn.ts';
import type { RuntimeEvent } from '../src/application/ports.ts';

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * 伪装成适配层的子进程：按真实协议往 stdout 写几行，然后收尾。
 *
 * 刻意不用 mock：要验的就是"**跨进程边界**之后事件还在不在"，
 * 而那正是先前悄悄失效的地方。
 */
function fakeAdapter(lines: readonly string[], outcome: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-rt-'));
  dirs.push(dir);
  const file = join(dir, 'adapter.mjs');
  writeFileSync(
    file,
    [
      'let raw = "";',
      'for await (const c of process.stdin) raw += c;',
      `for (const line of ${JSON.stringify(lines)}) process.stdout.write(line + "\\n");`,
      `process.stdout.write("__COAGENT_OUTCOME__ " + ${JSON.stringify(
        JSON.stringify(outcome),
      )} + "\\n");`,
    ].join('\n'),
    'utf8',
  );
  return file;
}

async function runAndCollect(
  lines: readonly string[],
  outcome: Record<string, unknown>,
): Promise<{ events: RuntimeEvent[]; outcome: Awaited<ReturnType<Awaited<ReturnType<SpawnRuntime['start']>>['wait']>> }> {
  const runtime = new SpawnRuntime({
    kind: 'fake',
    // 不用 process.execPath：spawn 在 win32 下开了 shell，
    // 而它的路径含空格（C:Program Files…），不加引号就找不到。
    command: 'node',
    args: [fakeAdapter(lines, outcome)],
    cwd: process.cwd(),
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
  const result = await run.wait();
  return { events, outcome: result };
}

const USAGE = {
  input: 10,
  output: 4,
  cacheRead: 2,
  cacheWrite: 0,
  total: 16,
  quality: 'reported' as const,
};

describe('S11.4 事件映射：跨进程之后还得在', () => {
  test('工具事件变成 tool.started / tool.completed，不再是普通文本', async () => {
    const { events } = await runAndCollect(
      [
        '__COAGENT_EVENT__ {"t":"tool.started","name":"read","callId":"c1"}',
        '__COAGENT_EVENT__ {"t":"tool.completed","name":"read","callId":"c1"}',
      ],
      { endedBy: 'structured_submit', usage: USAGE },
    );

    // 收尾时还会补一条权威总量（运行时不发增量用量时那就是唯一一条），
    // 所以这里只看工具那两支。
    assert.deepEqual(
      events.filter((e) => e.kind.startsWith('tool.')).map((e) => e.kind),
      ['tool.started', 'tool.completed'],
      '这两支先前一次都没进过',
    );
    // **不能同时又发一份 output**：同一件事在界面上会出现两次。
    assert.equal(events.filter((e) => e.kind === 'output').length, 0);
  });

  test('用量在跑的过程中就报，不是等收尾', async () => {
    const { events } = await runAndCollect(
      [
        `__COAGENT_EVENT__ {"t":"usage","usage":${JSON.stringify(USAGE)}}`,
        '__COAGENT_EVENT__ {"t":"tool.started","name":"bash","callId":"c2"}',
      ],
      { endedBy: 'structured_submit', usage: USAGE },
    );

    const first = events[0];
    assert.equal(first.kind, 'usage', '用量要能在工具事件之前就到');
    assert.equal((first as { usage: { total: number } }).usage.total, 16);
    // 界面上的 token 数靠这个涨。只在收尾时报一次的话，
    // 实时缓冲随即被清掉，那张卡片实际上永远看不到。
    assert.ok(events.some((e) => e.kind === 'tool.started'));
  });

  test('普通文本仍然照常走 output', async () => {
    const { events } = await runAndCollect(['模型在说话'], {
      endedBy: 'structured_submit',
      usage: USAGE,
    });
    assert.deepEqual(
      events.filter((e) => e.kind === 'output'),
      [{ kind: 'output', text: '模型在说话' }],
    );
  });

  test('坏掉的事件行被忽略，不会拖垮整跳', async () => {
    // 一行坏 JSON 只是少了一条观测数据，不该让这一跳失败。
    const { events, outcome } = await runAndCollect(
      ['__COAGENT_EVENT__ {这不是 JSON', '__COAGENT_EVENT__ {"t":"不认识的类型"}', '正常文本'],
      { endedBy: 'structured_submit', usage: USAGE },
    );
    assert.equal(outcome.endedBy, 'structured_submit');
    // 坏行既不该变成事件，也不该退化成一条 output 文本糊到界面上。
    assert.deepEqual(
      events.filter((e) => e.kind === 'output'),
      [{ kind: 'output', text: '正常文本' }],
    );
    assert.equal(events.filter((e) => e.kind.startsWith('tool.')).length, 0);
  });

  test('S13.3：运行时报回来的实际身份被带进 outcome', async () => {
    const { outcome } = await runAndCollect([], {
      endedBy: 'structured_submit',
      usage: USAGE,
      resolvedProfile: {
        revision: 'r1',
        resolved: [
          { key: 'provider', value: 'acme' },
          { key: 'model', value: 'acme-1' },
        ],
      },
    });
    assert.equal(outcome.resolvedProfile?.revision, 'r1');
    assert.deepEqual(
      outcome.resolvedProfile?.resolved.map((f) => `${f.key}=${f.value}`),
      ['provider=acme', 'model=acme-1'],
    );
  });
});
