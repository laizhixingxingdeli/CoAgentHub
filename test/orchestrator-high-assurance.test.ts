/**
 * E2：独立检视不接入 HA 主链。验收 9。
 * 不替换 process.stdout.write。
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Orchestrator } from '../src/application/orchestrator.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import { makeIssuer } from '../src/main.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: 'HA stalled 夹具',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const ORDER: WorkOrder = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
};

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function haFacts() {
  const no = false as const;
  return {
    mutationSideEffect: true,
    readOnlyProven: no,
    highAssurance: {
      productionDeployRelease: no,
      externalPaidOp: no,
      destructiveData: no,
      credentialsPermissionsSecurity: true,
      schemaPublicApiPersistenceCompat: no,
      unrecoverableExternalSideEffect: no,
    },
    standardFloor: {
      publicInterface: no,
      buildSystemOrDependency: no,
      multipleDomainModules: no,
      acceptanceNotCheckableUpfront: no,
      rootCauseOrCompetingDesigns: no,
    },
  };
}

describe('E2 合入后 HA 主链仍 fail-closed', () => {
  test('编排器源码不调用独立检视', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/application/orchestrator.ts', import.meta.url)),
      'utf8',
    );
    assert.doesNotMatch(src, /startIndependentReviewerAttempt/);
    assert.doesNotMatch(src, /independent_reviewer/);
    assert.doesNotMatch(src, /submitIndependentReview/);
  });

  test('runMission 对 HA 在调度前 stalled，不开 Attempt、不派检视', async () => {
    const clock = new FixedClock();
    const projects = new InMemoryProjectRepository();
    const ids = new SequentialIds();
    const platform = new Platform({
      projects,
      deliveries: new InMemoryDeliveryRepository(clock, ids),
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
      workspace: new InPlaceWorkspaceManager(),
    });
    const tokens = new RunTokenRegistry();
    const orchestrator = new Orchestrator({
      platform,
      tokens: makeIssuer(platform, tokens),
      baseUrl: 'http://127.0.0.1:9',
      workspace: new InPlaceWorkspaceManager(),
      coordinator: {
        runtime: new ScriptedRuntime({}),
        candidates: [{ endpoint: 'local', profileId: 'coord-a' }],
      },
      executor: {
        runtime: new ScriptedRuntime({}),
        candidates: [{ endpoint: 'local', profileId: 'exec-a' }],
      },
    });
    const project = await projects.ensure('P');
    project.createMission({
      id: 'M-ha',
      contract: CONTRACT,
      executionMode: 'high_assurance',
    });
    await projects.save(project);
    const root = mkdtempSync(join(tmpdir(), 'coagent-e2-ha-'));
    temps.push(root);
    const outcome = await orchestrator.runMission('M-ha', { projectRoot: root });
    assert.equal(outcome.kind, 'stalled');
    if (outcome.kind === 'stalled') {
      assert.match(outcome.reason, /High Assurance/);
    }
    const view = await platform.getMissionView('M-ha');
    assert.equal(view.coordinatorAttemptIds.length, 0);
    assert.equal(view.independentReviewerAttemptIds.length, 0);
    assert.equal(orchestrator.hops.length, 0);
  });

  test('HA 分类建单仍 HIGH_ASSURANCE_NOT_AVAILABLE', async () => {
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const platform = new Platform({
      projects: new InMemoryProjectRepository(),
      deliveries: new InMemoryDeliveryRepository(clock, ids),
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
    });
    await assert.rejects(
      () =>
        platform.createClassifiedMission({
          projectId: 'P',
          contract: CONTRACT,
          facts: haFacts(),
          workOrder: ORDER,
        }),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'HIGH_ASSURANCE_NOT_AVAILABLE',
    );
  });

  test('机器 HA 放行仍 HIGH_ASSURANCE_NEEDS_HUMAN', async () => {
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const projects = new InMemoryProjectRepository();
    const platform = new Platform({
      projects,
      deliveries: new InMemoryDeliveryRepository(clock, ids),
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
      workspace: new InPlaceWorkspaceManager(),
    });
    const project = await projects.ensure('P');
    const mission = project.createMission({
      id: 'M-ha-fin',
      contract: CONTRACT,
      executionMode: 'high_assurance',
    });
    mission.submitForReview();
    await projects.save(project);
    await assert.rejects(
      () =>
        platform.finalizeMissionByMachine('M-ha-fin', {
          integrationBranch: 'master',
          verification: [{ argv: ['node', '--test'], timeoutMs: 1000 }],
        }),
      (err: unknown) =>
        err instanceof PlatformRuleError && err.code === 'HIGH_ASSURANCE_NEEDS_HUMAN',
    );
  });
});
