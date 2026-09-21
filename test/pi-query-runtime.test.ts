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

  test('enabled=1 + 存在的 adapter => supportsQuery runtime', () => {
    const adapter = tempAdapter();
    const runtime = createPiQueryRuntime({
      COAGENT_QUERY_ENABLED: '1',
      COAGENT_QUERY_ADAPTER: adapter,
    });
    assert.ok(runtime, '应构造 SpawnRuntime');
    assert.equal(runtime.kind, 'pi');
    assert.equal(runtime.supportsQuery, true);
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
});
