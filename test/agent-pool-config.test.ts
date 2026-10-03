import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryAgentPoolRepository, agentPoolSnapshotRevision, type AgentPoolRepository } from '../src/application/agent-pool.ts';
import { FileStateStore, FileAgentPoolRepository } from '../src/application/file-store.ts';
import { createApi } from '../src/api/server.ts';
import { buildPlatform } from '../src/main.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import type { AddressInfo } from 'node:net';

async function revision(repo: AgentPoolRepository): Promise<string> {
  const snapshot = await repo.list();
  return agentPoolSnapshotRevision(snapshot);
}

test('角色整表替换保留其他角色，拒绝旧版本和无效输入，文件重开保留停用与顺序', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pool-config-'));
  try {
    const path = join(root, 'state.json');
    for (const repo of [new InMemoryAgentPoolRepository(), new FileAgentPoolRepository(new FileStateStore(path))]) {
      await repo.add({ role: 'coordinator', profileId: 'c', endpoint: 'local' });
      await repo.add({ role: 'executor', profileId: 'a', endpoint: 'local' });
      const before = await revision(repo);
      const input = { role: 'executor', expectedRevision: before, candidates: [
        { role: 'executor', profileId: 'b', endpoint: 'local', facts: [{ key: 'reasoning', value: 'high' }] },
        { role: 'executor', profileId: 'a', endpoint: 'other', enabled: false },
      ] };
      await repo.replaceRole(input);
      assert.deepEqual((await repo.list()).executor.map((row) => [row.profileId, row.order, row.enabled]), [['b', 0, undefined], ['a', 1, false]]);
      assert.equal((await repo.list()).coordinator[0].profileId, 'c');
      await assert.rejects(repo.replaceRole(input), { code: 'STALE_POOL' });
      const current = await revision(repo);
      await assert.rejects(repo.replaceRole({ ...input, expectedRevision: current, candidates: [input.candidates[0], input.candidates[0]] }), { code: 'DUPLICATE_PROFILE' });
      assert.equal(await revision(repo), current);
      await repo.replaceRole({ role: 'executor', expectedRevision: current, candidates: [] });
      assert.deepEqual((await repo.list()).executor, []);
    }
    const reopened = new FileAgentPoolRepository(new FileStateStore(path));
    assert.deepEqual((await reopened.list()).executor, []);
    assert.equal((await reopened.list()).coordinator[0].profileId, 'c');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HTTP 配置入口返回版本，成功持久化后响应，旧版本不改变配置', async () => {
  const built = buildPlatform();
  const agentPool = new InMemoryAgentPoolRepository();
  let persisted = 0;
  const server = createApi({ ...built, agentPool, onMutation: () => { persisted += 1; } });
  await listenLoopback(server, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const config = await (await fetch(`${base}/api/pools/config`)).json();
    const body = { expectedRevision: config.revision, candidates: [{ profileId: 'new', endpoint: 'local', enabled: false, facts: [{ key: 'reasoning', value: 'high' }] }] };
    const post = () => fetch(`${base}/api/pools/executor/configure`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const changed = await post();
    assert.equal(changed.status, 200);
    assert.equal(persisted, 1);
    const fresh = await changed.json();
    assert.notEqual(fresh.revision, config.revision);
    assert.equal(fresh.executor[0].enabled, false);
    assert.equal((await post()).status, 409);
    assert.equal(persisted, 1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
