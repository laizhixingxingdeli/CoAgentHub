import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { EMPTY_USAGE } from '../src/kernel/index.ts';
import type { AgentRuntime, AgentRunSpec } from '../src/application/ports.ts';
import { agentPoolSnapshotRevision } from '../src/application/agent-pool.ts';
import { buildPersistentPlatform } from '../src/main.ts';
import { createApi } from '../src/api/server.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

test('分类池只读接线：按序故障替换、熔断、下一次新配置、空池停靠与真实用量', async () => {
  const root = mkdtempSync(join(tmpdir(), 'classifier-pool-'));
  const starts: AgentRunSpec[] = [];
  const runtime: AgentRuntime = {
    kind: 'scripted', supportsQuery: true,
    start: async (spec) => {
      starts.push(spec);
      return { on() {}, abort() {}, wait: async () => spec.profile.profileId === 'bad'
        ? { endedBy: 'upstream_failure', failureMessage: 'HTTP 503 unavailable' }
        : { endedBy: 'structured_submit', queryOutcome: spec.profile.profileId === 'mutation' ? 'needs_mutation' : 'answered',
          usage: { ...EMPTY_USAGE, quality: 'reported', cost: 0.2 }, output: 'ok' } };
    },
  };
  const built = await buildPersistentPlatform(join(root, 'state.json'), { queryRuntime: runtime, reconcile: false });
  const server = createApi({ ...built });
  await listenLoopback(server, 0);
  try {
    await built.agentPool.add({ role: 'coordinator', profileId: 'not-classifier', endpoint: 'local' });
    const replace = async (candidates: readonly { profileId: string; endpoint: string; enabled?: boolean; facts?: readonly { key: string; value: string }[] }[]) =>
      built.agentPool.replaceRole({ role: 'classifier', expectedRevision: agentPoolSnapshotRevision(await built.agentPool.list()), candidates });
    await replace([{ profileId: 'bad', endpoint: 'local' }, { profileId: 'good', endpoint: 'local' }]);
    const input = { projectId: 'P', source: 'test', cwd: root, prompt: '只读检查', profile: { profileId: 'request-override', endpoint: 'local' } };
    assert.equal((await built.runQuery!(input)).outcome, 'answered');
    assert.deepEqual(starts.map((spec) => spec.profile.profileId), ['bad', 'good']);
    assert.equal((await built.candidateCircuits.get('bad')).state, 'open');
    await built.runQuery!(input);
    assert.deepEqual(starts.map((spec) => spec.profile.profileId), ['bad', 'good', 'good']);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pools = await (await fetch(`${base}/api/pools`)).json();
    assert.equal(pools.classifier[1].health.window7d.attempts, 2);
    assert.equal(pools.classifier[1].health.window7d.reportedCost, 0.4);
    assert.equal(pools.classifier[0].health.lastFailure.source, 'query.ended');
    await replace([{ profileId: 'good', endpoint: 'local', enabled: false }, { profileId: 'mutation', endpoint: 'local', facts: [{ key: 'reasoning', value: 'high' }] }]);
    assert.equal((await built.runQuery!(input)).outcome, 'needs_mutation');
    assert.equal(starts.at(-1)?.profile.facts?.[0].value, 'high');
    assert.deepEqual(await built.platform.listMissions(), []);
    for (const spec of starts) assert.deepEqual(spec.tools, ['read', 'grep', 'find', 'ls']);
    await replace([]);
    await assert.rejects(built.runQuery!(input), { code: 'QUERY_NO_CANDIDATES' });
    assert.equal(starts.length, 4);
    await assert.rejects(built.runQuery!({ ...input, tools: ['write'] }), { code: 'QUERY_TOOLS_NOT_READONLY' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
