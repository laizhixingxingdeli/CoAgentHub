/**
 * SpawnRuntime 子进程环境过滤：fail-closed 声明 + 基线 allowlist + 真实 spawn 金丝雀。
 *
 * 只用 HUB_TEST_* 假名，禁止在本文件出现任何厂商凭证名。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  filterSpawnEnv,
  parseAgentEnvPassthrough,
  SPAWN_ENV_BASE_ALLOWLIST,
  SPAWN_ENV_UNDECLARED_MESSAGE,
  SpawnRuntime,
} from '../src/runtime/spawn.ts';

const spawnSourcePath = fileURLToPath(new URL('../src/runtime/spawn.ts', import.meta.url));

describe('SpawnRuntime envPassthrough 构造期 fail-closed', () => {
  test('省略 envPassthrough → throw', () => {
    assert.throws(
      () =>
        new SpawnRuntime({
          kind: 't',
          command: 'node',
          args: ['-e', '0'],
        }),
      (err: unknown) =>
        err instanceof Error && err.message === SPAWN_ENV_UNDECLARED_MESSAGE,
    );
  });

  test('envPassthrough: undefined → throw', () => {
    assert.throws(
      () =>
        new SpawnRuntime({
          kind: 't',
          command: 'node',
          args: ['-e', '0'],
          envPassthrough: undefined,
        }),
      /COAGENT_AGENT_ENV_PASSTHROUGH/,
    );
  });

  test('envPassthrough: [] → 构造成功', () => {
    assert.doesNotThrow(
      () =>
        new SpawnRuntime({
          kind: 't',
          command: 'node',
          args: ['-e', '0'],
          envPassthrough: [],
        }),
    );
  });
});

describe('parseAgentEnvPassthrough', () => {
  test('undefined → 未声明', () => {
    assert.equal(parseAgentEnvPassthrough(undefined), undefined);
  });

  /**
   * 空串必须算「未声明」。
   *
   * 由来：PowerShell 的 `$env:VAR = ""` 会**删掉**变量，Node 侧看到的是 undefined。
   * 于是「声明了空名单」和「忘了声明」在用户的 shell 里是同一个动作。给它们不同语义，
   * 结果就是照文档设了空串、仍被拦下、而报错说「未声明」——实跑时就是这么撞上的，
   * 看起来像平台有 bug。
   */
  test('空串 → 未声明（PowerShell 造不出真空串）', () => {
    assert.equal(parseAgentEnvPassthrough(''), undefined);
  });

  test('纯空白 → 未声明', () => {
    assert.equal(parseAgentEnvPassthrough('   \t  '), undefined);
  });

  test('`-` → 已声明「一个都不透传」', () => {
    assert.deepEqual(parseAgentEnvPassthrough('-'), []);
  });

  test('`-` 两侧留白仍算声明空', () => {
    assert.deepEqual(parseAgentEnvPassthrough('  -  '), []);
  });

  test('`-` 混在名单里只是普通 token，不代表空', () => {
    assert.deepEqual(parseAgentEnvPassthrough('A,-,B'), ['A', '-', 'B']);
  });

  test('逗号分隔 + trim', () => {
    assert.deepEqual(parseAgentEnvPassthrough('  A, B '), ['A', 'B']);
  });

  test('星号是字面量，不代表通配', () => {
    assert.deepEqual(parseAgentEnvPassthrough('*'), ['*']);
  });
});

describe('filterSpawnEnv', () => {
  test('基线保留、未声明密钥丢弃、透传名保留', () => {
    const filtered = filterSpawnEnv(
      {
        PATH: '/bin',
        HUB_TEST_SECRET: 'should-drop',
        HUB_TEST_TOKEN: 'keep-me',
        UNRELATED: 'nope',
      },
      ['HUB_TEST_TOKEN'],
    );
    assert.equal(filtered.PATH, '/bin');
    assert.equal(filtered.HUB_TEST_TOKEN, 'keep-me');
    assert.equal(filtered.HUB_TEST_SECRET, undefined);
    assert.equal(filtered.UNRELATED, undefined);
  });

  test('Windows Path 原样保留（大小写不敏感匹配）', () => {
    const filtered = filterSpawnEnv({ Path: 'C:\\Windows\\System32' }, []);
    assert.equal(filtered.Path, 'C:\\Windows\\System32');
    assert.equal(Object.keys(filtered).includes('Path'), true);
    assert.equal(Object.keys(filtered).includes('PATH'), false);
  });

  test('http_proxy 小写原样保留', () => {
    const filtered = filterSpawnEnv({ http_proxy: 'http://127.0.0.1:9' }, []);
    assert.equal(filtered.http_proxy, 'http://127.0.0.1:9');
  });

  test('HTTP_PROXY 与 http_proxy 同时存在时都保留', () => {
    const filtered = filterSpawnEnv(
      {
        HTTP_PROXY: 'http://upper',
        http_proxy: 'http://lower',
      },
      [],
    );
    assert.equal(filtered.HTTP_PROXY, 'http://upper');
    assert.equal(filtered.http_proxy, 'http://lower');
  });

  test('透传名单里的 * 不复制全部键', () => {
    const filtered = filterSpawnEnv(
      {
        PATH: '/bin',
        HUB_TEST_SECRET: 'x',
        '*': 'star-value',
      },
      ['*'],
    );
    assert.equal(filtered.PATH, '/bin');
    assert.equal(filtered['*'], 'star-value');
    assert.equal(filtered.HUB_TEST_SECRET, undefined);
  });

  test('Windows 程序目录基线大小写无关、保留源键且缺键不造值', () => {
    const filtered = filterSpawnEnv(
      {
        programfiles: 'C:\\Synthetic\\PF',
        'PROGRAMFILES(X86)': 'C:\\Synthetic\\PF86',
        OTHER: 'drop',
      },
      [],
    );
    assert.deepEqual(filtered, {
      programfiles: 'C:\\Synthetic\\PF',
      'PROGRAMFILES(X86)': 'C:\\Synthetic\\PF86',
    });
    assert.equal(Object.hasOwn(filtered, 'ProgramW6432'), false);
  });

  test('源中 undefined 值不写入（不造空串）', () => {
    const filtered = filterSpawnEnv({ PATH: undefined, TEMP: '/tmp' }, []);
    assert.equal(Object.keys(filtered).includes('PATH'), false);
    assert.equal(filtered.TEMP, '/tmp');
  });
});

describe('SPAWN_ENV_BASE_ALLOWLIST 冻结名单', () => {
  test('恰好 22 个 OS/代理名（排序后比对；加名必须改本断言）', () => {
    const expected = [
      'ALL_PROXY',
      'APPDATA',
      'COMSPEC',
      'HOME',
      'HOMEDRIVE',
      'HOMEPATH',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'LOCALAPPDATA',
      'NO_PROXY',
      'PATH',
      'PATHEXT',
      'ProgramFiles',
      'ProgramFiles(x86)',
      'ProgramW6432',
      'SYSTEMDRIVE',
      'SYSTEMROOT',
      'TEMP',
      'TMP',
      'TMPDIR',
      'USERPROFILE',
      'WINDIR',
    ];
    // locale 字典序：纯 code-point 下 'S' < '_'，HTTPS_PROXY 会排到 HTTP_PROXY 前。
    const sorted = [...SPAWN_ENV_BASE_ALLOWLIST].sort((a, b) => a.localeCompare(b, 'en'));
    assert.deepEqual(sorted, expected);
    assert.equal(SPAWN_ENV_BASE_ALLOWLIST.length, 22);
  });
});

describe('spawn.ts 源码锁', () => {
  // 只留零凭据约定：源码里不得出现厂商凭证形键名（见文件头「只用 HUB_TEST_* 假名」，
  // 对应项目红线「不在输出/日志/提交里出现 key」）。
  // 「不再整份下发 process.env」那条已删：它由下面真实 spawn 金丝雀用例覆盖——
  // 子进程实际拿到的 env 里不含未声明金丝雀，比源码拼写更能锁住行为。
  test('源码不含凭证形键名', () => {
    const source = readFileSync(spawnSourcePath, 'utf8');
    assert.doesNotMatch(source, /API_KEY|ACCESS_KEY|SECRET_ACCESS/);
  });
});

describe('真实 spawn：金丝雀不泄漏 / 透传可见', () => {
  test('envPassthrough:[] 时 HUB_TEST_SECRET 不进子进程；PATH 类键仍在', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coagent-spawn-env-'));
    const outFile = join(dir, 'env.json');
    const script = join(dir, 'dump-env.mjs');
    // 子进程把 process.env 写成 JSON，供父进程断言。
    writeFileSync(
      script,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(process.env));`,
      ].join('\n'),
      'utf8',
    );

    const canary = 'HUB_TEST_SECRET';
    const token = 'HUB_TEST_TOKEN';
    const prevSecret = process.env[canary];
    const prevToken = process.env[token];
    const programKeys = ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432'];
    const previousProgramValues = programKeys.map((key) => process.env[key]);
    const programValues = ['C:\\Synthetic\\ProgramDirectory', 'C:\\Synthetic\\ProgramDirectory', 'C:\\Synthetic\\ProgramDirectory'];
    process.env[canary] = 'canary-value-must-not-leak';
    programKeys.forEach((key, index) => { process.env[key] = programValues[index]!; });
    process.env[token] = 'token-value-for-passthrough';

    try {
      const emptyPassthrough = parseAgentEnvPassthrough('-');
      assert.deepEqual(emptyPassthrough, []);
      const locked = new SpawnRuntime({
        kind: 'env-probe',
        // 不用 process.execPath：win32 shell:true 下含空格路径会炸（见 runtime-events）。
        command: 'node',
        args: [script],
        cwd: dir,
        envPassthrough: emptyPassthrough!,
        env: {
          PATH: process.env.PATH ?? process.env.Path,
          HUB_TEST_SECRET: 'canary-value-must-not-leak',
          HUB_TEST_TOKEN: 'token-value-for-passthrough',
          ProgramFiles: programValues[0],
          'ProgramFiles(x86)': programValues[1],
          ProgramW6432: programValues[2],
        },
      });
      const run = await locked.start({
        role: 'executor',
        attemptId: 'A-env',
        missionId: 'M-env',
        workItemId: 'W-env',
        cwd: dir,
        profile: { endpoint: 'local', profileId: 'p' },
        instruction: 'dump',
        tools: [],
        endpoint: { baseUrl: 'http://127.0.0.1:1', token: 't' },
      });
      await run.wait();

      const childEnv = JSON.parse(readFileSync(outFile, 'utf8')) as Record<string, string>;
      assert.equal(childEnv[canary], undefined, '金丝雀密钥不得出现在子进程 env');
      const pathLike = Object.keys(childEnv).some((k) => k.toUpperCase() === 'PATH');
      assert.ok(pathLike, 'PATH/Path 基线必须保留，否则 child 会 command not found');
      for (let index = 0; index < programKeys.length; index++) {
        assert.equal(childEnv[programKeys[index]], programValues[index]);
      }

      // 第二次：声明透传假名后应可见。
      const open = new SpawnRuntime({
        kind: 'env-probe',
        command: 'node',
        args: [script],
        cwd: dir,
        envPassthrough: [token],
        env: {
          PATH: process.env.PATH ?? process.env.Path,
          HUB_TEST_SECRET: 'canary-value-must-not-leak',
          HUB_TEST_TOKEN: 'token-value-for-passthrough',
        },
      });
      const run2 = await open.start({
        role: 'executor',
        attemptId: 'A-env-2',
        missionId: 'M-env',
        workItemId: 'W-env',
        cwd: dir,
        profile: { endpoint: 'local', profileId: 'p' },
        instruction: 'dump',
        tools: [],
        endpoint: { baseUrl: 'http://127.0.0.1:1', token: 't' },
      });
      await run2.wait();
      const childEnv2 = JSON.parse(readFileSync(outFile, 'utf8')) as Record<string, string>;
      assert.equal(childEnv2[token], 'token-value-for-passthrough');
      assert.equal(childEnv2[canary], undefined, '未声明的金丝雀仍不得泄漏');
    } finally {
      if (prevSecret === undefined) delete process.env[canary];
      else process.env[canary] = prevSecret;
      if (prevToken === undefined) delete process.env[token];
      else process.env[token] = prevToken;
      programKeys.forEach((key, index) => {
        const previous = previousProgramValues[index];
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
