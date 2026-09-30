import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHostedPlan } from '../src/application/plan-runtime.ts';
import { FilePlanRunStore } from '../src/application/plan-run-store.ts';
import { parsePlanSpec } from '../src/application/plan-spec.ts';
import { InMemoryAgentPoolRepository } from '../src/application/agent-pool.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { FixedClock, InMemoryActivityLog, InMemoryProjectRepository, SequentialIds } from '../src/application/in-memory.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { makeIssuer } from '../src/main.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('runHostedPlan reads reviewer-stop history and resumes the same paused Mission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-resume-'));
  try {
    const repo = join(root, 'repo');
    const runDir = join(root, 'plans');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'test');
    git(repo, 'config', 'user.email', 'test@local');
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'checkout', '-q', '-b', 'auto/plan-x');

    const plan = parsePlanSpec({
      planId: 'PLAN-hosted-resume', projectId: 'project', integrationBranch: 'auto/plan-x', intent: 'resume', reviewer: 'reviewer',
      integrationVerification: [{ argv: ['node', '--test'], timeoutMs: 1 }],
      stopConditions: { unresolvedEscalations: 1, wallClockMs: 60_000, escalationTimeoutMs: 1_000 },
      features: [{ id: 'F1', title: 'feature', why: 'continue', allowedScope: ['a.txt'], acceptance: ['done'], status: 'pending' }],
    });
    mkdirSync(runDir);
    const historyPath = join(runDir, 'prior-run.json');
    const historical = {
      version: 1, id: 'prior-run', planId: plan.planId, projectId: plan.projectId,
      integrationBranch: plan.integrationBranch, reviewer: 'reviewer',
      stopConditions: { unresolvedEscalations: 1, wallClockMs: 60_000, escalationTimeoutMs: 1_000, maxEscalations: 5, maxRerunsPerFeature: 1 },
      startedAt: '2026-01-01T00:00:00.000Z',
      features: [{ featureId: 'F1', title: 'feature', status: 'running', missionIds: ['old'] }],
      escalations: [], stopped: { at: '2026-01-01T00:01:00.000Z', reason: 'reviewer_stop', detail: 'stop' },
    };
    writeFileSync(historyPath, JSON.stringify(historical));
    assert.equal(new FilePlanRunStore(historyPath).read()?.stopped?.reason, 'reviewer_stop');

    const clock = new FixedClock();
    const ids = new SequentialIds();
    const workspace = new InPlaceWorkspaceManager();
    const platform = {
      async listMissions() { return [{ missionId: 'old', projectId: 'project', status: 'executing', isMutating: true, paused: true }]; },
      async resumeMission(id: string) { events.push(`resume:${id}`); return { paused: false }; },
      async createMission() { events.push('create'); throw new Error('must not create'); },
      async createClassifiedMission() { events.push('create-classified'); throw new Error('must not create'); },
      async getMissionView() { return { status: 'blocked' }; },
    };
    const events: string[] = [];
    const tokens = new RunTokenRegistry();
    const agentPool = new InMemoryAgentPoolRepository();
    await agentPool.add({ role: 'coordinator', profileId: 'c', endpoint: 'local' });
    await agentPool.add({ role: 'executor', profileId: 'e', endpoint: 'local' });
    const lines: string[] = [];
    const result = await runHostedPlan({
      plan, selection: { candidates: plan.features, exclusions: [], warnings: [] }, cwd: repo,
      adapter: join(root, 'adapter.ts'), runDir, store: 'file', env: { COAGENT_AGENT_ENV_PASSTHROUGH: '-' },
      coordinator: 'c', executor: 'e',
    }, {
      built: {
        platform: platform as unknown as Platform,
        tokens: makeIssuer(platform as unknown as Platform, tokens), agentPool, persist: async () => {},
      },
      baseUrl: 'http://127.0.0.1:9', workspace,
    }, (_channel, line) => lines.push(line));

    assert.equal(result, 0, lines.join('\\n'));
    assert.ok(events.includes('resume:old'), events.join(','));
    assert.equal(events.some((event) => event.startsWith('create')), false);
    assert.ok(lines.some((line) => line.includes('恢复自上一次方案运行')), lines.join('\n'));
    const current = lines.find((line) => line.includes('方案运行记录：'));
    assert.ok(current);
    const path = current!.slice(current!.indexOf('：') + 1);
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { features: Array<{ missionIds: string[] }> };
    assert.deepEqual(saved.features[0]?.missionIds, ['old']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
