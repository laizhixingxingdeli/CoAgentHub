/**
 * 单写者锁。
 *
 * 要防的不是"数据库并发"，是一个很具体的场景：`run-mission` 跑着的十分钟里，
 * 你在另一个终端 `l3 merge`。两边各持一份内存快照，谁最后落盘谁赢，
 * 另一边的改动**悄无声息地没了**。
 *
 * 所以判据有两条：写入口互斥，只读入口不受影响。
 *
 * 常驻写者还要能被 CLI 核验：空锁 / 活着的本机服务 / 占着但不可用，三者不能混。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  LockBusyError,
  acquireLock,
  acquireRecoverableLock,
  probeLocalWriter,
  publishLockPort,
  readLockAudit,
  stateIdFor,
  type LockInfo,
} from '../src/application/lock.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { buildPersistentPlatform } from '../src/main.ts';

const CONTRACT = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const dirs: string[] = [];
const servers: Server[] = [];
after(() => {
  for (const server of servers) {
    if (!server.listening) continue;
    try {
      server.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-lock-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockDirOf(statePath: string): string {
  const id = stateIdFor(statePath);
  return join(dirname(id), `.lock-${basename(id)}`);
}

function readHolderFile(statePath: string): LockInfo {
  return JSON.parse(readFileSync(join(lockDirOf(statePath), 'holder.json'), 'utf8')) as LockInfo;
}

function flipAsciiCase(value: string): string {
  return value.replace(/[A-Za-z]/g, (ch) =>
    ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase(),
  );
}

function listenHealth(headers: {
  instanceId: string;
  stateId: string;
  api: string;
}): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/api/health') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'x-coagent-instance': headers.instanceId,
        'x-coagent-state-id': headers.stateId,
      });
      res.end(JSON.stringify({ ok: true, api: headers.api }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

describe('单写者锁', () => {
  test('第二个写者拿不到锁，而且错误信息说得出是谁占着', () => {
    const statePath = tempState();
    const release = acquireLock(statePath, '跑 Mission M1');
    try {
      assert.throws(
        () => acquireLock(statePath, 'l3 merge M2'),
        (error: unknown) => {
          assert.ok(error instanceof LockBusyError);
          assert.equal(error.holder?.pid, process.pid);
          assert.match(error.message, /跑 Mission M1/);
          // 报错要告诉人怎么办，不是甩一句 EEXIST。
          assert.match(error.message, /pid=\d+/);
          assert.match(error.message, /instanceId=（无）/);
          assert.match(error.message, /port=（无）/);
          assert.match(error.message, /since=/);
          assert.match(error.message, /核实进程仍活着（POSIX）/);
          assert.match(error.message, /Get-Process -Id/);
          assert.match(error.message, /仅在确认持有者进程已死亡/);
          assert.match(error.message, /rm -rf --/);
          assert.match(error.message, /Remove-Item -LiteralPath/);
          assert.ok(error.message.includes(lockDirOf(statePath)));
          return true;
        },
      );
    } finally {
      release();
    }
  });

  test('元数据缺失或损坏时仍拒绝占锁并只提供谨慎人工步骤', () => {
    for (const contents of [undefined, '{broken']) {
      const statePath = tempState();
      const lockPath = lockDirOf(statePath);
      mkdirSync(lockPath);
      if (contents !== undefined) writeFileSync(join(lockPath, 'holder.json'), contents, 'utf8');
      assert.throws(() => acquireLock(statePath, 'second'), (error: unknown) => {
        assert.ok(error instanceof LockBusyError);
        assert.equal(error.holder, undefined);
        assert.match(error.message, /无法确定 PID/);
        assert.match(error.message, /不要仅凭元数据缺失判断进程已死/);
        assert.match(error.message, /仅在确认持有者进程已死亡/);
        assert.ok(error.message.includes(lockPath));
        assert.ok(existsSync(lockPath), 'lock remains untouched');
        return true;
      });
    }
  });

  test('放掉之后下一个拿得到；重复释放无害', () => {
    const statePath = tempState();
    const first = acquireLock(statePath, 'a');
    first();
    first(); // 重复释放不该炸
    const second = acquireLock(statePath, 'b');
    second();
  });

  test('**不自动抢占**陈旧的锁：进程卡住和进程已死从外面看一模一样', () => {
    const statePath = tempState();
    const release = acquireLock(statePath, '假装卡住了');
    try {
      // 即使持有者看起来不动了，也不许自己判定它死了然后抢过来——
      // 猜错的代价就是两个进程一起写，正是这把锁要防的事。
      assert.throws(() => acquireLock(statePath, '我觉得它死了'), LockBusyError);
    } finally {
      release();
    }
  });

  test('写入口互斥：第二个 buildPersistentPlatform 被挡', async () => {
    const statePath = tempState();
    const first = await buildPersistentPlatform(statePath, {
      workspace: new InPlaceWorkspaceManager(),
      exclusive: { what: '跑 Mission' },
    });
    try {
      await assert.rejects(
        () =>
          buildPersistentPlatform(statePath, {
            workspace: new InPlaceWorkspaceManager(),
            exclusive: { what: 'l3 merge' },
          }),
        LockBusyError,
      );
    } finally {
      first.releaseLock();
    }
  });

  test('只读入口不抢锁：跑着 Mission 的时候照样能看', async () => {
    const statePath = tempState();
    const writer = await buildPersistentPlatform(statePath, {
      workspace: new InPlaceWorkspaceManager(),
      exclusive: { what: '跑 Mission' },
    });
    try {
      await writer.platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });

      // 观测面/只读命令不带 exclusive，应当照常打开并读到最新内容。
      const viewer = await buildPersistentPlatform(statePath, {
        workspace: new InPlaceWorkspaceManager(),
      });
      const rows = await viewer.platform.listMissions();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].missionId, 'M1');
    } finally {
      writer.releaseLock();
    }
  });

  test('锁目录用完要清掉，不留垃圾', () => {
    const statePath = tempState();
    const lockPath = join(statePath, '..', '.lock-state.json');
    const release = acquireLock(statePath, 'x');
    assert.ok(existsSync(lockPath));
    release();
    assert.ok(!existsSync(lockPath));
  });

  test('反复拿放不在 process 上堆 exit 监听：常驻进程一晚上要拿几十次', () => {
    const statePath = tempState();
    const before = process.listenerCount('exit');
    for (let i = 0; i < 20; i += 1) acquireLock(statePath, `第 ${i} 次`)();
    assert.equal(process.listenerCount('exit'), before);
  });
});

describe('主锁心跳', () => {
  test('新锁带 heartbeatAt：短间隔前移，释放后定时器不再动锁', async () => {
    const statePath = tempState();
    const release = acquireLock(statePath, '心跳', undefined, { heartbeatIntervalMs: 10 });
    let stoppedAt = '';
    try {
      const born = readHolderFile(statePath);
      assert.equal(typeof born.heartbeatAt, 'string');
      assert.ok(
        Number.isFinite(Date.parse(born.heartbeatAt as string)),
        'heartbeatAt 必须是可解析的时间',
      );
      assert.equal(born.pid, process.pid);
      assert.equal(born.what, '心跳');

      await delay(80);
      const beating = readHolderFile(statePath);
      assert.ok(
        Date.parse(beating.heartbeatAt as string) > Date.parse(born.heartbeatAt as string),
        `持锁期间心跳应当前移：${born.heartbeatAt} → ${beating.heartbeatAt}`,
      );
      // 心跳只改时间：持有者身份与用途不能被刷掉。
      assert.equal(beating.pid, process.pid);
      assert.equal(beating.what, '心跳');
      stoppedAt = beating.heartbeatAt as string;
    } finally {
      release();
    }
    assert.ok(!existsSync(lockDirOf(statePath)), '释放仍要删掉自己的锁');

    // 放一把「同进程」的假锁回去：若 release 没停掉定时器，旧回调会把它当成
    // 自己的锁接着刷——这正是「释放后还在动锁」要防的样子。
    const lockPath = lockDirOf(statePath);
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, 'holder.json'),
      JSON.stringify(
        {
          pid: process.pid,
          since: new Date().toISOString(),
          what: '后来的持有者',
          heartbeatAt: stoppedAt,
        },
        null,
        2,
      ),
      'utf8',
    );
    await delay(80);
    const kept = readHolderFile(statePath);
    assert.equal(kept.what, '后来的持有者');
    assert.equal(kept.heartbeatAt, stoppedAt, '释放后不得再刷新任何锁的心跳');
    rmSync(lockPath, { recursive: true, force: true });
  });

  test('发布端口与心跳交错：不丢 port / instanceId，也不把心跳倒回去', async () => {
    const statePath = tempState();
    writeFileSync(statePath, '{}\n', 'utf8');
    const instanceId = 'inst-hb-pub';
    const apiVersion = 'v-hb-pub';
    const release = acquireLock(statePath, '常驻心跳', { instanceId, apiVersion }, {
      heartbeatIntervalMs: 10,
    });
    try {
      const { port } = await listenHealth({
        instanceId,
        stateId: stateIdFor(statePath),
        api: apiVersion,
      });
      await delay(40);
      const beforePublish = readHolderFile(statePath);
      publishLockPort(statePath, instanceId, port);
      const afterPublish = readHolderFile(statePath);
      assert.equal(afterPublish.port, port);
      assert.equal(afterPublish.instanceId, instanceId);
      assert.equal(afterPublish.apiVersion, apiVersion);
      assert.equal(afterPublish.pid, process.pid);
      assert.ok(
        Date.parse(afterPublish.heartbeatAt as string) >=
          Date.parse(beforePublish.heartbeatAt as string),
        '发布端口不得把 heartbeatAt 倒退回旧值',
      );

      // 再让心跳跑几轮：端口与身份必须还在（心跳以整份元数据为基刷新）。
      await delay(40);
      const beating = readHolderFile(statePath);
      assert.equal(beating.port, port);
      assert.equal(beating.instanceId, instanceId);
      assert.equal(beating.apiVersion, apiVersion);
      assert.ok(
        Date.parse(beating.heartbeatAt as string) >= Date.parse(afterPublish.heartbeatAt as string),
      );
    } finally {
      release();
    }
    assert.ok(!existsSync(lockDirOf(statePath)), '释放后不留锁');
  });
});

describe('常驻写者身份与本机探测', () => {
  test('stateIdFor 对真实文件与可解析符号链接稳定', (t) => {
    const statePath = tempState();
    writeFileSync(statePath, '{}\n', 'utf8');
    const viaAbs = stateIdFor(statePath);
    const viaSame = stateIdFor(join(dirname(statePath), '.', basename(statePath)));
    assert.equal(viaAbs, viaSame);

    const link = join(dirname(statePath), 'alias-state.json');
    try {
      symlinkSync(statePath, link);
    } catch {
      t.skip('未验证：本机无权创建符号链接');
      return;
    }
    assert.equal(stateIdFor(link), stateIdFor(statePath));
  });

  test('同一真实状态文件的符号链接共享一把锁', (t) => {
    const statePath = tempState();
    writeFileSync(statePath, '{}\n', 'utf8');
    const link = join(dirname(statePath), 'alias-state.json');
    try {
      symlinkSync(statePath, link);
    } catch {
      t.skip('未验证：本机无权创建符号链接');
      return;
    }
    const release = acquireLock(statePath, '真实路径');
    try {
      assert.throws(() => acquireLock(link, '经链接'), LockBusyError);
    } finally {
      release();
    }
  });

  test('带身份拿锁可读到 PID、规范 stateId、实例、API 版本；发布后是实际非零端口', async () => {
    const statePath = tempState();
    writeFileSync(statePath, '{}\n', 'utf8');
    const instanceId = 'inst-resident';
    const apiVersion = 'test-api';
    const release = acquireLock(statePath, '常驻服务', { instanceId, apiVersion });
    try {
      const before = readHolderFile(statePath);
      assert.equal(before.pid, process.pid);
      assert.equal(before.stateId, stateIdFor(statePath));
      assert.equal(before.instanceId, instanceId);
      assert.equal(before.apiVersion, apiVersion);
      assert.equal(before.port, undefined);

      const { port } = await listenHealth({
        instanceId,
        stateId: stateIdFor(statePath),
        api: apiVersion,
      });
      assert.ok(port > 0);
      publishLockPort(statePath, instanceId, port);
      const after = readHolderFile(statePath);
      assert.equal(after.port, port);
      assert.notEqual(after.port, 0);
    } finally {
      release();
    }
  });

  test('普通写者仍互斥，且不能冒充持有者发布端口', () => {
    const statePath = tempState();
    const release = acquireLock(statePath, '普通写者');
    try {
      assert.throws(() => acquireLock(statePath, '下一个'), LockBusyError);
      assert.throws(() => publishLockPort(statePath, 'not-holder', 3456), /发布锁端口失败/);
    } finally {
      release();
    }
  });

  test('发布失败：非法端口、未持锁、错误实例；释放后不伪造 empty', async () => {
    const statePath = tempState();
    const instanceId = 'inst-pub';
    const release = acquireLock(statePath, '常驻', { instanceId, apiVersion: 'v-test' });
    assert.throws(() => publishLockPort(statePath, instanceId, 0), /发布锁端口失败/);
    assert.throws(() => publishLockPort(statePath, instanceId, -1), /发布锁端口失败/);
    assert.throws(() => publishLockPort(statePath, instanceId, 65536), /发布锁端口失败/);
    assert.throws(() => publishLockPort(statePath, instanceId, 1.5), /发布锁端口失败/);
    assert.throws(() => publishLockPort(statePath, 'other-instance', 4321), /发布锁端口失败/);
    release();

    const empty = await probeLocalWriter(statePath);
    assert.equal(empty.status, 'empty');
    assert.ok(!existsSync(lockDirOf(statePath)));
    assert.throws(() => publishLockPort(statePath, instanceId, 4321), /发布锁端口失败/);
    const stillEmpty = await probeLocalWriter(statePath);
    assert.equal(stillEmpty.status, 'empty');
    assert.ok(!existsSync(lockDirOf(statePath)));
  });

  test('probe：空目录 → empty；匹配回环身份/API 版本 → live', async () => {
    const statePath = tempState();
    writeFileSync(statePath, '{}\n', 'utf8');
    assert.equal((await probeLocalWriter(statePath)).status, 'empty');

    const instanceId = 'inst-live';
    const apiVersion = 'v-live';
    const release = acquireLock(statePath, '常驻', { instanceId, apiVersion });
    try {
      const { port } = await listenHealth({
        instanceId,
        stateId: stateIdFor(statePath),
        api: apiVersion,
      });
      publishLockPort(statePath, instanceId, port);
      const live = await probeLocalWriter(statePath);
      assert.equal(live.status, 'live');
      if (live.status === 'live') {
        assert.equal(live.holder.instanceId, instanceId);
        assert.equal(live.holder.apiVersion, apiVersion);
        assert.equal(live.holder.port, port);
        assert.equal(live.holder.stateId, stateIdFor(statePath));
      }
    } finally {
      release();
    }
  });

  test('probe：未发布端口 → occupied，不删锁', async () => {
    const statePath = tempState();
    const release = acquireLock(statePath, '常驻', { instanceId: 'inst-np', apiVersion: 'v-np' });
    try {
      const probed = await probeLocalWriter(statePath);
      assert.equal(probed.status, 'occupied');
      if (probed.status === 'occupied') assert.match(probed.reason, /未发布/);
      assert.ok(existsSync(lockDirOf(statePath)));
    } finally {
      release();
    }
  });

  test('probe：缺失或损坏元数据 → occupied，不删锁', async () => {
    const missingPath = tempState();
    mkdirSync(lockDirOf(missingPath));
    const missing = await probeLocalWriter(missingPath);
    assert.equal(missing.status, 'occupied');
    assert.ok(existsSync(lockDirOf(missingPath)));

    const corruptPath = tempState();
    mkdirSync(lockDirOf(corruptPath));
    writeFileSync(join(lockDirOf(corruptPath), 'holder.json'), '{not-json', 'utf8');
    const corrupt = await probeLocalWriter(corruptPath);
    assert.equal(corrupt.status, 'occupied');
    assert.ok(existsSync(lockDirOf(corruptPath)));
  });

  test('probe：死 PID → occupied，不删锁', async () => {
    const statePath = tempState();
    writeFileSync(statePath, '{}\n', 'utf8');
    const lockPath = lockDirOf(statePath);
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, 'holder.json'),
      JSON.stringify(
        {
          pid: 2147483647,
          since: new Date().toISOString(),
          what: '已死进程',
          stateId: stateIdFor(statePath),
          instanceId: 'inst-dead',
          apiVersion: 'v-dead',
          port: 34567,
        },
        null,
        2,
      ),
      'utf8',
    );
    const probed = await probeLocalWriter(statePath);
    assert.equal(probed.status, 'occupied');
    if (probed.status === 'occupied') assert.match(probed.reason, /已不在|pid/);
    assert.ok(existsSync(lockPath));
  });

  test('probe：连接失败 → occupied，不删锁', async () => {
    const statePath = tempState();
    const instanceId = 'inst-conn';
    const apiVersion = 'v-conn';
    const release = acquireLock(statePath, '常驻', { instanceId, apiVersion });
    try {
      const closed = createServer();
      servers.push(closed);
      const port = await new Promise<number>((resolve, reject) => {
        closed.once('error', reject);
        closed.listen(0, '127.0.0.1', () => resolve((closed.address() as AddressInfo).port));
      });
      await new Promise<void>((resolve, reject) => closed.close((err) => (err ? reject(err) : resolve())));
      publishLockPort(statePath, instanceId, port);
      const probed = await probeLocalWriter(statePath);
      assert.equal(probed.status, 'occupied');
      if (probed.status === 'occupied') assert.match(probed.reason, /连接不可达/);
      assert.ok(existsSync(lockDirOf(statePath)));
    } finally {
      release();
    }
  });

  test('probe：实例 / 状态 / API 版本不符 → occupied，不删锁；x-coagent-run 不算身份', async () => {
    const statePath = tempState();
    writeFileSync(statePath, '{}\n', 'utf8');
    const instanceId = 'inst-real';
    const apiVersion = 'v-real';
    const stateId = stateIdFor(statePath);
    const release = acquireLock(statePath, '常驻', { instanceId, apiVersion });
    try {
      const { server, port } = await listenHealth({
        instanceId: 'inst-other',
        stateId,
        api: apiVersion,
      });
      publishLockPort(statePath, instanceId, port);
      const inst = await probeLocalWriter(statePath);
      assert.equal(inst.status, 'occupied');
      if (inst.status === 'occupied') assert.match(inst.reason, /实例/);
      assert.ok(existsSync(lockDirOf(statePath)));

      server.close();
      const { server: stateServer, port: statePort } = await listenHealth({
        instanceId,
        stateId: stateId + '-other',
        api: apiVersion,
      });
      publishLockPort(statePath, instanceId, statePort);
      const st = await probeLocalWriter(statePath);
      assert.equal(st.status, 'occupied');
      if (st.status === 'occupied') assert.match(st.reason, /状态/);
      assert.ok(existsSync(lockDirOf(statePath)));
      stateServer.close();

      const { server: apiServer, port: apiPort } = await listenHealth({
        instanceId,
        stateId,
        api: 'v-other',
      });
      publishLockPort(statePath, instanceId, apiPort);
      const api = await probeLocalWriter(statePath);
      assert.equal(api.status, 'occupied');
      if (api.status === 'occupied') assert.match(api.reason, /API/);
      assert.ok(existsSync(lockDirOf(statePath)));
      apiServer.close();

      const runOnly = createServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0];
        if (req.method === 'GET' && path === '/api/health') {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'x-coagent-run': instanceId,
            'x-coagent-state-id': stateId,
          });
          res.end(JSON.stringify({ ok: true, api: apiVersion }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      servers.push(runOnly);
      const runPort = await new Promise<number>((resolve, reject) => {
        runOnly.once('error', reject);
        runOnly.listen(0, '127.0.0.1', () => resolve((runOnly.address() as AddressInfo).port));
      });
      publishLockPort(statePath, instanceId, runPort);
      const runProbe = await probeLocalWriter(statePath);
      assert.equal(runProbe.status, 'occupied');
      if (runProbe.status === 'occupied') assert.match(runProbe.reason, /实例/);
      assert.ok(existsSync(lockDirOf(statePath)));
    } finally {
      release();
    }
  });

  test('probe：同一状态文件大小写不同时 Windows 为 live，非 Windows 仍 occupied', async () => {
    const statePath = tempState();
    writeFileSync(statePath, '{}\n', 'utf8');
    const instanceId = 'inst-case';
    const apiVersion = 'v-case';
    const canonical = stateIdFor(statePath);
    const folded = flipAsciiCase(canonical);
    assert.notEqual(folded, canonical);

    const release = acquireLock(statePath, '常驻', { instanceId, apiVersion });
    try {
      const { port } = await listenHealth({
        instanceId,
        stateId: folded,
        api: apiVersion,
      });
      publishLockPort(statePath, instanceId, port);

      const asWin = await probeLocalWriter(statePath, { treatStateIdAsWindows: true });
      assert.equal(asWin.status, 'live');
      if (asWin.status === 'live') {
        assert.equal(asWin.holder.instanceId, instanceId);
        assert.equal(asWin.holder.port, port);
      }

      const asPosix = await probeLocalWriter(statePath, { treatStateIdAsWindows: false });
      assert.equal(asPosix.status, 'occupied');
      if (asPosix.status === 'occupied') assert.match(asPosix.reason, /状态/);
      assert.ok(existsSync(lockDirOf(statePath)));

      const native = await probeLocalWriter(statePath);
      if (process.platform === 'win32') {
        assert.equal(native.status, 'live');
        const viaFoldedPath = await probeLocalWriter(folded);
        assert.equal(viaFoldedPath.status, 'live');
      } else {
        assert.equal(native.status, 'occupied');
        if (native.status === 'occupied') assert.match(native.reason, /状态/);
      }
    } finally {
      release();
    }
  });

  test('probe：Windows 规则下不同状态身份仍 occupied，不删锁', async () => {
    const statePath = tempState();
    writeFileSync(statePath, '{}\n', 'utf8');
    const instanceId = 'inst-case-other';
    const apiVersion = 'v-case-other';
    const canonical = stateIdFor(statePath);
    const release = acquireLock(statePath, '常驻', { instanceId, apiVersion });
    try {
      const { port } = await listenHealth({
        instanceId,
        stateId: canonical + '-other',
        api: apiVersion,
      });
      publishLockPort(statePath, instanceId, port);
      const probed = await probeLocalWriter(statePath, { treatStateIdAsWindows: true });
      assert.equal(probed.status, 'occupied');
      if (probed.status === 'occupied') assert.match(probed.reason, /状态/);
      assert.ok(existsSync(lockDirOf(statePath)));
    } finally {
      release();
    }
  });
});

describe('残锁安全接管', () => {
  // 心跳停在 00:00，探测时刻取 00:10：停摆 10 分钟，超过 120 秒阈值。
  const STALE_HEARTBEAT = new Date(Date.parse('2026-01-01T00:00:00.000Z')).toISOString();
  const PROBE_NOW = Date.parse('2026-01-01T00:10:00.000Z');

  function plantStaleLock(statePath: string, holder: Partial<LockInfo> & { pid: number }): string {
    const lockPath = lockDirOf(statePath);
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, 'holder.json'),
      JSON.stringify({ since: STALE_HEARTBEAT, what: '意外退出前的写者', ...holder }, null, 2),
      'utf8',
    );
    return lockPath;
  }

  /** 接管期间临时建的 guard / 隔离目录都不该留在状态目录里。 */
  function takeoverTemps(statePath: string): string[] {
    return readdirSync(dirname(statePath)).filter(
      (name) => name.includes('takeover') || name.includes('stale-'),
    );
  }

  test('死 pid + 停摆心跳 + 端口无人监听：接管并留下可读审计', async () => {
    const statePath = tempState();
    writeFileSync(statePath, '{}\n', 'utf8');
    const lockPath = plantStaleLock(statePath, {
      pid: 2147483646,
      heartbeatAt: STALE_HEARTBEAT,
      stateId: stateIdFor(statePath),
      instanceId: 'inst-dead',
      apiVersion: 'v-dead',
      port: 45678,
    });

    const release = await acquireRecoverableLock(
      statePath,
      '常驻服务重启后接管',
      { instanceId: 'inst-new', apiVersion: 'v-new' },
      { now: () => PROBE_NOW, pidAlive: () => false, portListening: async () => false },
    );
    try {
      const held = readHolderFile(statePath);
      assert.equal(held.pid, process.pid);
      assert.equal(held.what, '常驻服务重启后接管');
      assert.equal(held.instanceId, 'inst-new');
      assert.deepEqual(takeoverTemps(statePath), [], 'guard 与隔离目录都要清干净');
    } finally {
      release();
    }
    assert.ok(!existsSync(lockPath), '正常释放只删自己的锁');

    const audit = readLockAudit(statePath);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].oldPid, 2147483646);
    assert.equal(audit[0].oldInstanceId, 'inst-dead');
    assert.equal(audit[0].oldHeartbeatAt, STALE_HEARTBEAT);
    assert.equal(audit[0].newPid, process.pid);
    assert.equal(audit[0].newInstanceId, 'inst-new');
    assert.equal(audit[0].at, new Date(PROBE_NOW).toISOString());
  });

  test('活 pid / 无心跳 / 端口状态未知都不接管，旧锁原样不动', async () => {
    const statePath = tempState();
    writeFileSync(statePath, '{}\n', 'utf8');
    const lockPath = plantStaleLock(statePath, {
      pid: 2147483647,
      heartbeatAt: STALE_HEARTBEAT,
      stateId: stateIdFor(statePath),
      instanceId: 'inst-live',
      apiVersion: 'v-live',
      port: 45679,
    });
    const planted = readHolderFile(statePath);

    // 1) 进程还活着：停摆再久也不接管，且把"怎么人工核实端口"一起给出。
    await assert.rejects(
      () =>
        acquireRecoverableLock(statePath, '抢', undefined, {
          now: () => PROBE_NOW,
          pidAlive: () => true,
          portListening: async () => false,
        }),
      (error: unknown) => {
        assert.ok(error instanceof LockBusyError);
        assert.match(error.message, /仍然存活/);
        assert.match(error.message, /lsof -nP -iTCP:45679/);
        assert.match(error.message, /Get-NetTCPConnection -LocalPort 45679/);
        assert.match(error.message, /rm -rf --/);
        return true;
      },
    );
    assert.deepEqual(readHolderFile(statePath), planted, '拒绝时旧锁元数据不动');
    assert.equal(readLockAudit(statePath).length, 0, '拒绝不写审计');

    // 2) 没有 heartbeatAt 的旧版本锁：说不清停摆多久，拒绝。
    writeFileSync(
      join(lockPath, 'holder.json'),
      JSON.stringify({ pid: 2147483647, since: STALE_HEARTBEAT, what: '旧版本锁' }, null, 2),
      'utf8',
    );
    await assert.rejects(
      () =>
        acquireRecoverableLock(statePath, '抢', undefined, {
          now: () => PROBE_NOW,
          pidAlive: () => false,
          portListening: async () => false,
        }),
      (error: unknown) => {
        assert.ok(error instanceof LockBusyError);
        assert.match(error.message, /heartbeatAt/);
        return true;
      },
    );
    assert.equal(readHolderFile(statePath).what, '旧版本锁');

    // 3) 端口探测报的是未知网络错误（不是明确的 ECONNREFUSED）：一律 fail closed。
    writeFileSync(join(lockPath, 'holder.json'), JSON.stringify(planted, null, 2), 'utf8');
    await assert.rejects(
      () =>
        acquireRecoverableLock(statePath, '抢', undefined, {
          now: () => PROBE_NOW,
          pidAlive: () => false,
          portListening: async () => {
            throw new Error('EHOSTUNREACH 网络不可达');
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof LockBusyError);
        assert.match(error.message, /状态未知/);
        return true;
      },
    );
    assert.deepEqual(readHolderFile(statePath), planted);
    assert.ok(existsSync(lockPath), '拒绝时旧锁目录仍在');
    assert.deepEqual(takeoverTemps(statePath), [], '拒绝也要清掉自己的 guard');
  });
});
