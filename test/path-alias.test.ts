import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function removeAliasThenRoot(alias: string, root: string): void {
  // 先摘联接/符号链接本身。对别名 recursive 删除会顺着联接把 real 里的内容删掉。
  try { unlinkSync(alias); } catch { try { rmdirSync(alias); } catch { /* 摘不掉也不能 recursive 删别名 */ } }
  rmSync(root, { recursive: true, force: true });
}

function runAliased(args: readonly string[]): Promise<{ code: number | null; output: string }> {
  const root = mkdtempSync(join(tmpdir(), 'coagent-alias-'));
  const real = join(root, 'real');
  const alias = join(root, 'alias');
  mkdirSync(real);
  symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  env.TEMP = alias;
  env.TMP = alias;
  env.TMPDIR = alias;
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env, windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += String(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { output += String(chunk); });
    const finish = (code: number | null, extra = ''): void => {
      removeAliasThenRoot(alias, root);
      resolvePromise({ code, output: output + extra });
    };
    child.on('error', (error) => finish(1, String(error)));
    child.on('close', (code) => finish(code));
  });
}

test('别名 TEMP 下 worktree / HA 既有套件仍退出 0', { timeout: 240_000 }, async () => {
  const { code, output } = await runAliased([
    '--test',
    'test/worktree-reconcile.test.ts',
    'test/ha-authority-config.test.ts',
    'test/platform-high-assurance-finalize.test.ts',
  ]);
  assert.equal(code, 0, output.slice(-3000));
});

test('别名 TEMP 下外部 cwd 启动隔离源码副本仍退出 0', { timeout: 240_000 }, async () => {
  const { code, output } = await runAliased([
    '--test',
    '--test-name-pattern',
    '外部 cwd 启动隔离源码副本',
    'test/start-server.test.ts',
  ]);
  assert.equal(code, 0, output.slice(-3000));
});
