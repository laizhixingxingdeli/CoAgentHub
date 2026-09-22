/**
 * Pi Query runtime factory：双键 opt-in + 路径存在，否则 fail-closed。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPiQueryRuntime } from '../src/runtime/pi-query.ts';

const dirs: string[] = [];

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempAdapter(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-pi-query-'));
  dirs.push(dir);
  const adapter = join(dir, 'query-adapter.ts');
  writeFileSync(adapter, '// fixture adapter\n', 'utf8');
  return adapter;
}

describe('createPiQueryRuntime env matrix', () => {
  test('empty env => undefined', () => {
    assert.equal(createPiQueryRuntime({}), undefined);
  });

  test('enabled only => undefined', () => {
    assert.equal(
      createPiQueryRuntime({ COAGENT_QUERY_ENABLED: '1' }),
      undefined,
    );
  });

  test('adapter only => undefined', () => {
    const adapter = tempAdapter();
    assert.equal(
      createPiQueryRuntime({ COAGENT_QUERY_ADAPTER: adapter }),
      undefined,
    );
  });

  test('enabled 非 1（true/yes/on）=> undefined', () => {
    const adapter = tempAdapter();
    for (const enabled of ['true', 'yes', 'on', '0', '2', '']) {
      assert.equal(
        createPiQueryRuntime({
          COAGENT_QUERY_ENABLED: enabled,
          COAGENT_QUERY_ADAPTER: adapter,
        }),
        undefined,
        `enabled=${JSON.stringify(enabled)} 不得开启`,
      );
    }
  });

  test('enabled=1 + missing path => undefined', () => {
    assert.equal(
      createPiQueryRuntime({
        COAGENT_QUERY_ENABLED: '1',
        COAGENT_QUERY_ADAPTER: join(tmpdir(), 'no-such-pi-query-adapter.ts'),
      }),
      undefined,
    );
  });

  test('enabled=1 + blank adapter => undefined', () => {
    for (const adapter of ['', '   ']) {
      assert.equal(
        createPiQueryRuntime({
          COAGENT_QUERY_ENABLED: '1',
          COAGENT_QUERY_ADAPTER: adapter,
        }),
        undefined,
      );
    }
  });

  test('enabled=1 + 存在的 adapter + 已声明透传 => supportsQuery runtime', () => {
    const adapter = tempAdapter();
    const runtime = createPiQueryRuntime({
      COAGENT_QUERY_ENABLED: '1',
      COAGENT_QUERY_ADAPTER: adapter,
      // 空串 = 已声明「只要基线」；假名亦可。
      COAGENT_AGENT_ENV_PASSTHROUGH: '-',
    });
    assert.ok(runtime, '应构造 SpawnRuntime');
    assert.equal(runtime.kind, 'pi');
    assert.equal(runtime.supportsQuery, true);
  });

  test('enabled=1 + adapter 但未声明透传 => throw（不是 undefined）', () => {
    const adapter = tempAdapter();
    assert.throws(
      () =>
        createPiQueryRuntime({
          COAGENT_QUERY_ENABLED: '1',
          COAGENT_QUERY_ADAPTER: adapter,
        }),
      /COAGENT_AGENT_ENV_PASSTHROUGH/,
    );
  });

  test('enabled=1 + adapter + 空串透传 => 构造成功', () => {
    const adapter = tempAdapter();
    const runtime = createPiQueryRuntime({
      COAGENT_QUERY_ENABLED: '1',
      COAGENT_QUERY_ADAPTER: adapter,
      COAGENT_AGENT_ENV_PASSTHROUGH: '-',
    });
    assert.ok(runtime);
  });

  test('enabled=1 + adapter + 假名透传 => 构造成功', () => {
    const adapter = tempAdapter();
    const runtime = createPiQueryRuntime({
      COAGENT_QUERY_ENABLED: '1',
      COAGENT_QUERY_ADAPTER: adapter,
      COAGENT_AGENT_ENV_PASSTHROUGH: 'HUB_TEST_TOKEN',
    });
    assert.ok(runtime);
  });

  test('query 配置不完整时仍返回 undefined，不为透传抛错', () => {
    // 观测-only：没开 query 就不该要求部署方声明 agent env。
    assert.equal(
      createPiQueryRuntime({
        COAGENT_QUERY_ENABLED: '1',
        // adapter 缺
      }),
      undefined,
    );
    assert.equal(createPiQueryRuntime({}), undefined);
  });

  test('传入 env 不回落 process.env 的 query 配置', () => {
    const adapter = tempAdapter();
    const prevEnabled = process.env.COAGENT_QUERY_ENABLED;
    const prevAdapter = process.env.COAGENT_QUERY_ADAPTER;
    process.env.COAGENT_QUERY_ENABLED = '1';
    process.env.COAGENT_QUERY_ADAPTER = adapter;
    try {
      // 显式空 env：即使 process.env 开着，也不得装配。
      assert.equal(createPiQueryRuntime({}), undefined);
    } finally {
      if (prevEnabled === undefined) delete process.env.COAGENT_QUERY_ENABLED;
      else process.env.COAGENT_QUERY_ENABLED = prevEnabled;
      if (prevAdapter === undefined) delete process.env.COAGENT_QUERY_ADAPTER;
      else process.env.COAGENT_QUERY_ADAPTER = prevAdapter;
    }
  });

  test('注入 env 缺透传键时不回落 process.env 上的声明', () => {
    const adapter = tempAdapter();
    const prevPass = process.env.COAGENT_AGENT_ENV_PASSTHROUGH;
    process.env.COAGENT_AGENT_ENV_PASSTHROUGH = '-';
    try {
      // 注入 env 齐备 query 键但无透传键：即便宿主 process.env 已声明，也必须 throw。
      assert.throws(
        () =>
          createPiQueryRuntime({
            COAGENT_QUERY_ENABLED: '1',
            COAGENT_QUERY_ADAPTER: adapter,
          }),
        /COAGENT_AGENT_ENV_PASSTHROUGH/,
      );
    } finally {
      if (prevPass === undefined) delete process.env.COAGENT_AGENT_ENV_PASSTHROUGH;
      else process.env.COAGENT_AGENT_ENV_PASSTHROUGH = prevPass;
    }
  });
});
