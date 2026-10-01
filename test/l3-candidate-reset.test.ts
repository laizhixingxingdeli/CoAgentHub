/**
 * `node src/l3.ts candidate reset`：无服务时本地复位，常驻服务持锁时回环交给唯一写者。
 *
 * 两种情况都要留下**同一条**审计（谁、什么时候、为什么），因为「额度充值后恢复」
 * 这条链事后只能靠它解释；而存在检查覆盖了三个角色的桶，漏一个就会把在册候选
 * 判成不存在。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPersistentPlatform } from '../src/main.ts';
import { FileStateStore, FileCandidateCircuitRepository } from '../src/application/file-store.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const L3 = resolve(HERE, '..', 'src', 'l3.ts');
const MAIN = resolve(HERE, '..', 'src', 'main.ts');

const PROFILE = 'exec-reset';

function l3(statePath: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [L3, ...args, '--state', statePath], { encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** 父进程在听 HTTP 时不能 spawnSync：会堵住事件循环，探活超时。 */
function l3Async(statePath: string, ...args: string[]) {
  return new Promise<{ status: number | null; out: string }>((resolvePromise) => {
    const child = spawn(process.execPath, [L3, ...args, '--state', statePath]);
    let out = '';
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('close', (status) => resolvePromise({ status, out }));
  });
}

async function preparedState(): Promise<{ dir: string; statePath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-candidate-reset-'));
  const statePath = join(dir, 'state.json');
  const built = await buildPersistentPlatform(statePath, { exclusive: { what: 'test prepare' } });
  try {
    await built.agentPool.add({ role: 'executor', profileId: PROFILE, endpoint: 'local' });
    await built.candidateCircuits.open({ profileId: PROFILE, failureClass: 'quota', openUntil: null });
    await built.persist();
  } finally {
    built.releaseLock();
  }
  return { dir, statePath };
}

function circuits(statePath: string) {
  return new FileCandidateCircuitRepository(new FileStateStore(statePath));
}

function assertAudited(events: readonly { profileId: string; actor: string; at: string; reason: string }[], reason: string) {
  const mine = events.filter((event) => event.profileId === PROFILE);
  assert.equal(mine.length, 1);
  const event = mine[0]!;
  assert.ok(event.actor.length > 0);
  assert.equal(Number.isNaN(Date.parse(event.at)), false);
  assert.equal(new Date(event.at).toISOString(), event.at);
  assert.equal(event.reason, reason);
  return mine.length;
}

describe('l3 candidate reset', () => {
  test('无服务时本地复位：留下 operator 审计，无效请求明确非零且不写事件', async () => {
    const { dir, statePath } = await preparedState();
    try {
      assert.equal((await circuits(statePath).get(PROFILE)).state, 'open');

      const missingReason = l3(statePath, 'candidate', 'reset', PROFILE);
      assert.notEqual(missingReason.status, 0, missingReason.out);

      const done = l3(statePath, 'candidate', 'reset', PROFILE, '--reason', 'recharged');
      assert.equal(done.status, 0, done.out);

      const repo = circuits(statePath);
      assert.equal((await repo.get(PROFILE)).state, 'closed');
      const events = await repo.listResetEvents(PROFILE);
      assertAudited(events, 'recharged');
      assert.equal(events[0]!.actor, 'operator');

      const stranger = l3(statePath, 'candidate', 'reset', 'no-such-profile', '--reason', 'x');
      assert.notEqual(stranger.status, 0, stranger.out);
      const again = l3(statePath, 'candidate', 'reset', PROFILE, '--reason', 'again');
      assert.notEqual(again.status, 0, again.out);
      assert.equal((await circuits(statePath).listResetEvents(PROFILE)).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('常驻服务持锁时回环复位：同样留下一条审计', async () => {
    const { dir, statePath } = await preparedState();
    const child = spawn(process.execPath, [MAIN], {
      env: {
        ...process.env,
        COAGENT_STORE: 'file',
        COAGENT_STATE: statePath,
        PORT: '0',
        COAGENT_RECONCILE_INTERVAL_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    try {
      assert.equal((await circuits(statePath).get(PROFILE)).state, 'open');
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`常驻服务启动超时：${stderr}`)), 20_000);
        const failOnce = (error: Error) => {
          clearTimeout(timer);
          fail(error);
        };
        child.stdout?.on('data', (chunk) => {
          if (String(chunk).includes('平台已启动')) {
            clearTimeout(timer);
            done();
          }
        });
        child.once('error', failOnce);
        child.once('exit', (code) => failOnce(new Error(`常驻服务提前退出 ${String(code)}：${stderr}`)));
      });

      const result = await l3Async(statePath, 'candidate', 'reset', PROFILE, '--reason', 'recharged');
      assert.equal(result.status, 0, result.out);

      const repo = circuits(statePath);
      assert.equal((await repo.get(PROFILE)).state, 'closed');
      // live actor 是从控制凭据取的受控主体，可能不是离线那条 operator。
      assertAudited(await repo.listResetEvents(PROFILE), 'recharged');
    } finally {
      await new Promise<void>((done) => {
        const settle = () => done();
        child.once('exit', settle);
        child.kill();
        setTimeout(() => {
          child.kill('SIGKILL');
          settle();
        }, 3000);
      });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
