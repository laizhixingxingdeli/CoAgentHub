/**
 * 凭据脱敏：该抹的抹掉，不该抹的一个字都不动。
 *
 * 两头都要守：漏抹是泄露；误抹（把 token 计数、提交号、耗时抹成 REDACTED）会把证据毁掉，
 * 检视者从此看不懂一跳到底发生了什么。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createRedactor } from '../src/application/redact.ts';

const ENV = {
  PATH: 'C:\\Windows\\system32;C:\\Program Files\\nodejs',
  HOME: 'C:\\Users\\someone',
  TYPESAFE_API_KEY: 'ts-live-7f3a9c2e1b8d4f6a',
  GATEWAY_TOKEN: 'gw-9d8c7b6a5f4e3d2c1b0a',
  // 是另一个值的前缀：先换短的会把长的切碎、剩半截漏出去。
  SHORT_SECRET: 'gw-9d8c7b6a',
  AUTH_MODE: 'local',
};

describe('脱敏：已知值', () => {
  const r = createRedactor(ENV);

  test('名字像凭据的变量，按值精确替换成 [REDACTED:变量名]', () => {
    assert.equal(
      r.redact('TYPESAFE_API_KEY=ts-live-7f3a9c2e1b8d4f6a\nPATH=...'),
      'TYPESAFE_API_KEY=[REDACTED:TYPESAFE_API_KEY]\nPATH=...',
    );
    assert.equal(r.redact('用的是 ts-live-7f3a9c2e1b8d4f6a 这把'), '用的是 [REDACTED:TYPESAFE_API_KEY] 这把');
  });

  test('长的先换：一个值是另一个值的前缀时，不留半截', () => {
    const out = r.redact('token gw-9d8c7b6a5f4e3d2c1b0a and short gw-9d8c7b6a');
    assert.equal(out, 'token [REDACTED:GATEWAY_TOKEN] and short [REDACTED:SHORT_SECRET]');
    assert.doesNotMatch(out, /5f4e3d2c/);
  });

  test('名字不像凭据的、值太短的，不当成已知值', () => {
    assert.equal(r.redact('HOME=C:\\Users\\someone'), 'HOME=C:\\Users\\someone');
    assert.equal(r.redact('AUTH_MODE is local'), 'AUTH_MODE is local');
  });
});

describe('脱敏：形状', () => {
  const r = createRedactor({});

  test('私钥块整段抹掉', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\nabc\n-----END RSA PRIVATE KEY-----';
    assert.equal(r.redact(`前\n${key}\n后`), '前\n[REDACTED:PRIVATE KEY]\n后');
  });

  test('Bearer / JWT / 常见前缀的 key', () => {
    assert.equal(r.redact('Authorization: Bearer abcdEFGH1234.xyz'), 'Authorization: Bearer [REDACTED]');
    assert.equal(
      r.redact('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM'),
      'jwt [REDACTED:JWT]',
    );
    for (const key of [
      'sk-proj-abcdefghijklmnopqrstuv',
      'xai-AbCdEfGhIjKlMnOpQrStUv',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'AKIAIOSFODNN7EXAMPLE',
    ]) {
      assert.equal(r.redact(`key: ${key} 结束`).includes(key), false, key);
    }
  });

  test('赋值形式保留名字、只抹值：env 行、JSON、YAML', () => {
    assert.equal(r.redact('OPENAI_API_KEY=abc123def456ghi'), 'OPENAI_API_KEY=[REDACTED]');
    assert.equal(r.redact('{"apiKey": "abc123def456ghi"}'), '{"apiKey": "[REDACTED]"}');
    assert.equal(r.redact('db_password: hunter2hunter2'), 'db_password: [REDACTED]');
  });
});

describe('脱敏：不误伤', () => {
  const r = createRedactor(ENV);

  test('计数、耗时、提交号、UUID、路径原样', () => {
    const text = [
      '[tok 45723] total=67360 cost=$0.0665',
      'tokenCount=12345678 maxTotalTokens: 100000',
      'commit 96b944c4ac0a1f2e3d4c5b6a7980716253443526',
      'run 4f9a3c2e-8b1d-4e6f-9a2b-3c4d5e6f7a8b',
      'C:\\program1\\v5-demo\\.coagent-worktrees\\CANARY-LW-3#2\\src\\window.ts',
      'node --test → 42 pass / 0 fail',
    ].join('\n');
    assert.equal(r.redact(text), text);
  });
});

describe('脱敏：深拷贝', () => {
  const r = createRedactor(ENV);

  test('字符串叶子都过一遍，非字符串原样，不改入参', () => {
    const input = {
      kind: 'command',
      exitCode: 0,
      ok: true,
      output: 'TYPESAFE_API_KEY=ts-live-7f3a9c2e1b8d4f6a',
      nested: { list: ['Bearer abcdEFGH1234.xyz', 7, null] },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = r.redactDeep(input);
    assert.deepEqual(out, {
      kind: 'command',
      exitCode: 0,
      ok: true,
      output: 'TYPESAFE_API_KEY=[REDACTED:TYPESAFE_API_KEY]',
      nested: { list: ['Bearer [REDACTED]', 7, null] },
    });
    assert.deepEqual(input, snapshot, '入参不能被改');
  });
});
