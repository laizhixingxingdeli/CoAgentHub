import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IllegalTransitionError,
  InvariantViolationError,
  KernelError,
  Mission,
  Project,
  WorkItem,
} from '../src/kernel/index.ts';
import type {
  ComplexityAssessment,
  ExecutionBudget,
  WorkOrder,
} from '../src/kernel/index.ts';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ATOMIC_ORDER: WorkOrder = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
  validation: {
    commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }],
  },
};

function freshMission(): Mission {
  return Project.create({ id: 'p-m' }).createMission({ id: 'm-1' });
}

function illegal(entity: string, from: string, to: string) {
  return (err: unknown) => {
    assert.ok(err instanceof IllegalTransitionError, `got ${String(err)}`);
    assert.ok(err instanceof KernelError);
    assert.equal(err.code, 'ILLEGAL_TRANSITION');
    assert.equal(err.name, 'IllegalTransitionError');
    assert.equal(err.entity, entity);
    assert.equal(err.from, from);
    assert.equal(err.to, to);
    return true;
  };
}

function invariant(code: string) {
  return (err: unknown) => {
    assert.ok(err instanceof InvariantViolationError, `got ${String(err)}`);
    assert.ok(err instanceof KernelError);
    assert.equal(err.code, code);
    return true;
  };
}

describe('Project / Mission: 创建', () => {
  test('Project.create 与 createMission 建好链接，Mission 初始 investigating', () => {
    const project = Project.create({ id: 'p-1' });
    assert.equal(project.id, 'p-1');
    assert.deepEqual(project.missions, []);

    const mission = project.createMission({ id: 'm-1' });
    assert.ok(mission instanceof Mission);
    assert.equal(mission.id, 'm-1');
    assert.equal(mission.projectId, 'p-1');
    assert.equal(mission.status, 'investigating');
    assert.equal(mission.isMutating, false);
    assert.deepEqual(mission.workItems, []);
    assert.deepEqual(mission.coordinatorAttempts, []);
    assert.equal(project.missions.length, 1);
    assert.equal(project.missions[0], mission);
  });

  test('同一 Project 里重复 mission id 抛 DUPLICATE_ID', () => {
    const project = Project.create({ id: 'p-dup' });
    project.createMission({ id: 'm-dup' });
    assert.throws(() => project.createMission({ id: 'm-dup' }), invariant('DUPLICATE_ID'));
    assert.equal(project.missions.length, 1);
  });

  test('不同 Project 之间 id 可以相同', () => {
    const a = Project.create({ id: 'pa' }).createMission({ id: 'same' });
    const b = Project.create({ id: 'pb' }).createMission({ id: 'same' });
    assert.equal(a.projectId, 'pa');
    assert.equal(b.projectId, 'pb');
  });

  test('missions / workItems / coordinatorAttempts 是副本', () => {
    const project = Project.create({ id: 'p-copy' });
    const mission = project.createMission({ id: 'm-copy' });
    mission.createWorkItem({ id: 'w-1', title: 't' });

    (project.missions as Mission[]).push(mission);
    (mission.workItems as WorkItem[]).pop();
    assert.equal(project.missions.length, 1);
    assert.equal(mission.workItems.length, 1);
    assert.equal(mission.coordinatorAttempts.length, 0);
  });

  test('Project.id / Mission.id 等字段不可写', () => {
    const project = Project.create({ id: 'p-ro' });
    const mission = project.createMission({ id: 'm-ro' });
    for (const key of ['id', 'missions']) {
      assert.throws(
        () => {
          (project as unknown as Record<string, unknown>)[key] = 'x';
        },
        TypeError,
        `Project.${key}`,
      );
    }
    for (const key of [
      'id',
      'projectId',
      'status',
      'isMutating',
      'workItems',
      'coordinatorAttempts',
      'executionMode',
      'runKind',
      'complexityAssessment',
      'executionBudget',
    ]) {
      assert.throws(
        () => {
          (mission as unknown as Record<string, unknown>)[key] = 'x';
        },
        TypeError,
        `Mission.${key}`,
      );
    }
  });
});

describe('Project: createMissionWithInitialWorkItem 原子 seed', () => {
  test('valid atomic seed => 1 Mission + 唯一 frozen WorkItem；caller mutation 不污染', () => {
    const project = Project.create({ id: 'p-atomic' });
    const argv = ['node', '--test'];
    const commands = [{ argv, timeoutMs: 5000 }];
    const validation = { commands };
    const order: WorkOrder = { ...ATOMIC_ORDER, validation };

    const { mission, workItem } = project.createMissionWithInitialWorkItem({
      id: 'm-atomic',
      executionMode: 'lightweight',
      runKind: 'mutation',
      initialWorkItem: { id: 'w-seed', title: 'seed', order },
    });

    assert.equal(project.missions.length, 1);
    assert.equal(project.missions[0], mission);
    assert.equal(mission.id, 'm-atomic');
    assert.equal(mission.executionMode, 'lightweight');
    assert.equal(mission.runKind, 'mutation');
    assert.equal(mission.workItems.length, 1);
    assert.equal(mission.workItems[0], workItem);
    assert.equal(workItem.id, 'w-seed');
    assert.equal(workItem.status, 'created');
    assert.equal(workItem.planRevision, 0);
    assert.equal(mission.planRevision, 0);

    assert.deepEqual(workItem.order?.validation, {
      commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }],
    });
    assert.ok(Object.isFrozen(workItem.order));
    assert.ok(Object.isFrozen(workItem.order!.validation));
    assert.ok(Object.isFrozen(workItem.order!.validation!.commands));
    assert.ok(Object.isFrozen(workItem.order!.validation!.commands[0]));
    assert.ok(Object.isFrozen(workItem.order!.validation!.commands[0].argv));

    argv.push('--hack');
    commands.push({ argv: ['rm', '-rf', '/'], timeoutMs: 1 });
    (validation as { commands: unknown }).commands = [];
    assert.deepEqual(workItem.order?.validation?.commands, [
      { argv: ['node', '--test'], timeoutMs: 5000 },
    ]);
  });

  test('invalid WorkOrder.validation => INVALID_WORK_ORDER_VALIDATION；Project 不残留 Mission',
    () => {
      const project = Project.create({ id: 'p-atomic-bad' });
      const beforeIds = project.missions.map((m) => m.id);

      assert.throws(
        () =>
          project.createMissionWithInitialWorkItem({
            id: 'm-bad-order',
            initialWorkItem: {
              id: 'w-bad',
              title: 'bad',
              order: {
                ...ATOMIC_ORDER,
                validation: {
                  commands: [
                    {
                      argv: ['node', '--test'],
                      timeoutMs: 1000,
                      cwd: '/tmp',
                    } as never,
                  ],
                },
              },
            },
          }),
        invariant('INVALID_WORK_ORDER_VALIDATION'),
      );

      assert.equal(project.missions.length, beforeIds.length);
      assert.deepEqual(
        project.missions.map((m) => m.id),
        beforeIds,
      );

      // bad timeout 同样 fail-closed
      assert.throws(
        () =>
          project.createMissionWithInitialWorkItem({
            id: 'm-bad-timeout',
            initialWorkItem: {
              id: 'w-bad-to',
              title: 'bad timeout',
              order: {
                ...ATOMIC_ORDER,
                validation: { commands: [{ argv: ['node'], timeoutMs: 0 }] },
              },
            },
          }),
        invariant('INVALID_WORK_ORDER_VALIDATION'),
      );
      assert.equal(project.missions.length, 0);
    },
  );

  test('duplicate Mission id => DUPLICATE_ID；原 Mission 不变、不多 WorkItem', () => {
    const project = Project.create({ id: 'p-atomic-dup' });
    const existing = project.createMission({ id: 'm-dup-atomic' });
    existing.createWorkItem({ id: 'w-existing', title: 'keep' });
    const beforeCount = project.missions.length;
    const beforeWorkItems = existing.workItems.length;

    assert.throws(
      () =>
        project.createMissionWithInitialWorkItem({
          id: 'm-dup-atomic',
          initialWorkItem: {
            id: 'w-new',
            title: 'should not land',
            order: ATOMIC_ORDER,
          },
        }),
      invariant('DUPLICATE_ID'),
    );

    assert.equal(project.missions.length, beforeCount);
    assert.equal(existing.workItems.length, beforeWorkItems);
    assert.equal(existing.workItems[0]?.id, 'w-existing');
    assert.equal(project.missions[0], existing);
  });

  test('createMission 仍可 0 WorkItem', () => {
    const project = Project.create({ id: 'p-legacy-empty' });
    const mission = project.createMission({ id: 'm-empty' });
    assert.deepEqual(mission.workItems, []);
    assert.equal(project.missions.length, 1);
  });
});

describe('Mission: executionMode', () => {
  test('新建默认 standard，快照写出 concrete standard', () => {
    const mission = freshMission();
    assert.equal(mission.executionMode, 'standard');
    assert.equal(mission.toSnapshot().executionMode, 'standard');
  });

  test('Project.createMission 各显式档位 getter/snapshot 一致', () => {
    for (const mode of ['lightweight', 'standard', 'high_assurance'] as const) {
      const mission = Project.create({ id: `p-em-${mode}` }).createMission({
        id: `m-${mode}`,
        executionMode: mode,
      });
      assert.equal(mission.executionMode, mode);
      assert.equal(mission.toSnapshot().executionMode, mode);
    }
  });

  test('老快照缺字段 restore -> standard，后续 snapshot 显式 standard', () => {
    const project = Project.create({ id: 'p-em-old' });
    const base = project.createMission({ id: 'm-old' });
    const snap = base.toSnapshot();
    delete snap.executionMode;
    const restored = Mission.restore(snap, project);
    assert.equal(restored.executionMode, 'standard');
    assert.equal(restored.toSnapshot().executionMode, 'standard');
  });

  test('lightweight / high_assurance 往返保留', () => {
    for (const mode of ['lightweight', 'high_assurance'] as const) {
      const project = Project.create({ id: `p-rt-${mode}` });
      const mission = project.createMission({ id: `m-rt-${mode}`, executionMode: mode });
      const restored = Mission.restore(mission.toSnapshot(), project);
      assert.equal(restored.executionMode, mode);
      assert.equal(restored.toSnapshot().executionMode, mode);
    }
  });

  test("损坏 'nope' 与 null restore -> standard", () => {
    const project = Project.create({ id: 'p-em-bad' });
    const base = project.createMission({ id: 'm-bad' });
    for (const bad of ['nope', null] as const) {
      const snap = base.toSnapshot();
      (snap as { executionMode?: unknown }).executionMode = bad as never;
      const restored = Mission.restore(snap, project);
      assert.equal(restored.executionMode, 'standard');
    }
  });
});

describe('Mission: runKind', () => {
  test('新建默认 mutation，快照写出 concrete mutation', () => {
    const mission = freshMission();
    assert.equal(mission.runKind, 'mutation');
    assert.equal(mission.toSnapshot().runKind, 'mutation');
  });

  test('Project.createMission 各显式种类 getter/snapshot 一致', () => {
    for (const kind of ['mutation', 'query'] as const) {
      const mission = Project.create({ id: `p-rk-${kind}` }).createMission({
        id: `m-${kind}`,
        runKind: kind,
      });
      assert.equal(mission.runKind, kind);
      assert.equal(mission.toSnapshot().runKind, kind);
    }
  });

  test('老快照缺字段 restore -> mutation，后续 snapshot 显式 mutation', () => {
    const project = Project.create({ id: 'p-rk-old' });
    const base = project.createMission({ id: 'm-old' });
    const snap = base.toSnapshot();
    delete snap.runKind;
    const restored = Mission.restore(snap, project);
    assert.equal(restored.runKind, 'mutation');
    assert.equal(restored.toSnapshot().runKind, 'mutation');
  });

  test('query 往返保留，且不改变 status / isMutating 行为', () => {
    const project = Project.create({ id: 'p-rk-rt' });
    const mission = project.createMission({ id: 'm-rt-query', runKind: 'query' });
    assert.equal(mission.status, 'investigating');
    assert.equal(mission.isMutating, false);
    mission.startPlanning();
    mission.startExecuting();
    assert.equal(mission.status, 'executing');
    assert.equal(mission.isMutating, true);
    const restored = Mission.restore(mission.toSnapshot(), project);
    assert.equal(restored.runKind, 'query');
    assert.equal(restored.toSnapshot().runKind, 'query');
    assert.equal(restored.status, 'executing');
    assert.equal(restored.isMutating, true);
  });

  test('runKind 与 executionMode 任意组合合法且往返保留', () => {
    for (const mode of ['lightweight', 'standard', 'high_assurance'] as const) {
      for (const kind of ['mutation', 'query'] as const) {
        const project = Project.create({ id: `p-rk-x-${mode}-${kind}` });
        const mission = project.createMission({
          id: `m-x-${mode}-${kind}`,
          executionMode: mode,
          runKind: kind,
        });
        assert.equal(mission.executionMode, mode);
        assert.equal(mission.runKind, kind);
        const restored = Mission.restore(mission.toSnapshot(), project);
        assert.equal(restored.executionMode, mode);
        assert.equal(restored.runKind, kind);
      }
    }
  });

  test("损坏 'nope' 与 null restore -> mutation", () => {
    const project = Project.create({ id: 'p-rk-bad' });
    const base = project.createMission({ id: 'm-bad' });
    for (const bad of ['nope', null] as const) {
      const snap = base.toSnapshot();
      (snap as { runKind?: unknown }).runKind = bad as never;
      const restored = Mission.restore(snap, project);
      assert.equal(restored.runKind, 'mutation');
    }
  });
});

function sampleAssessment(
  overrides: Partial<ComplexityAssessment> = {},
): ComplexityAssessment {
  return {
    goalUncertainty: 1,
    changeScope: 2,
    operationalRisk: 0,
    verificationDifficulty: 1,
    coordinationNeed: 2,
    recoveryDifficulty: 0,
    reasons: ['scope crosses two modules', 'needs coordinator review'],
    decidedBy: 'user',
    assessedAt: '2026-03-21T12:00:00.000Z',
    ...overrides,
  };
}

describe('Mission: complexityAssessment', () => {
  test('新建默认 undefined，快照不产生假评估', () => {
    const mission = freshMission();
    assert.equal(mission.complexityAssessment, undefined);
    assert.equal(mission.toSnapshot().complexityAssessment, undefined);
  });

  test('显式合法 create：getter/snapshot 完整；reasons 复制且不可变', () => {
    const reasons = ['a', 'b'];
    const assessment = sampleAssessment({ reasons });
    const mission = Project.create({ id: 'p-ca-ok' }).createMission({
      id: 'm-ca-ok',
      complexityAssessment: assessment,
    });

    const got = mission.complexityAssessment;
    assert.ok(got);
    assert.equal(got.goalUncertainty, 1);
    assert.equal(got.changeScope, 2);
    assert.equal(got.operationalRisk, 0);
    assert.equal(got.verificationDifficulty, 1);
    assert.equal(got.coordinationNeed, 2);
    assert.equal(got.recoveryDifficulty, 0);
    assert.deepEqual(got.reasons, ['a', 'b']);
    assert.equal(got.decidedBy, 'user');
    assert.equal(got.assessedAt, '2026-03-21T12:00:00.000Z');

    reasons.push('caller-mutated');
    assert.deepEqual(mission.complexityAssessment?.reasons, ['a', 'b']);

    assert.ok(Object.isFrozen(got));
    assert.ok(Object.isFrozen(got.reasons));
    assert.throws(() => {
      (got as { goalUncertainty: number }).goalUncertainty = 0;
    }, TypeError);
    assert.throws(() => {
      (got.reasons as string[]).push('x');
    }, TypeError);

    const snap = mission.toSnapshot().complexityAssessment;
    assert.ok(snap);
    assert.deepEqual(snap, {
      goalUncertainty: 1,
      changeScope: 2,
      operationalRisk: 0,
      verificationDifficulty: 1,
      coordinationNeed: 2,
      recoveryDifficulty: 0,
      reasons: ['a', 'b'],
      decidedBy: 'user',
      assessedAt: '2026-03-21T12:00:00.000Z',
    });
  });

  test('老快照缺字段 restore -> undefined，不抛', () => {
    const project = Project.create({ id: 'p-ca-old' });
    const base = project.createMission({ id: 'm-old' });
    const snap = base.toSnapshot();
    delete snap.complexityAssessment;
    const restored = Mission.restore(snap, project);
    assert.equal(restored.complexityAssessment, undefined);
    assert.equal(restored.toSnapshot().complexityAssessment, undefined);
  });

  test('合法评估 snapshot round-trip 相等', () => {
    const project = Project.create({ id: 'p-ca-rt' });
    const mission = project.createMission({
      id: 'm-ca-rt',
      complexityAssessment: sampleAssessment({ decidedBy: 'coordinator' }),
    });
    const restored = Mission.restore(mission.toSnapshot(), project);
    assert.deepEqual(restored.complexityAssessment, mission.complexityAssessment);
    assert.deepEqual(
      restored.toSnapshot().complexityAssessment,
      mission.toSnapshot().complexityAssessment,
    );
    assert.ok(Object.isFrozen(restored.complexityAssessment));
    assert.ok(Object.isFrozen(restored.complexityAssessment?.reasons));
  });

  test('restore 畸形整段 undefined，不抛、不逐维 clamp', () => {
    const project = Project.create({ id: 'p-ca-bad' });
    const base = project.createMission({
      id: 'm-ca-bad',
      complexityAssessment: sampleAssessment(),
    });
    const good = base.toSnapshot();

    const cases: Array<{ label: string; patch: (ca: Record<string, unknown>) => void }> = [
      {
        label: 'score=3',
        patch: (ca) => {
          ca.goalUncertainty = 3;
        },
      },
      {
        label: '缺一个维度',
        patch: (ca) => {
          delete ca.recoveryDifficulty;
        },
      },
      {
        label: '非法 decidedBy',
        patch: (ca) => {
          ca.decidedBy = 'agent';
        },
      },
      {
        label: 'reasons 含非 string',
        patch: (ca) => {
          ca.reasons = ['ok', 1];
        },
      },
      {
        label: 'assessedAt 非 string',
        patch: (ca) => {
          ca.assessedAt = 12345;
        },
      },
      {
        label: '非对象',
        patch: () => {
          /* replaced wholesale below */
        },
      },
    ];

    for (const { label, patch } of cases) {
      const snap = structuredClone(good);
      if (label === '非对象') {
        (snap as { complexityAssessment?: unknown }).complexityAssessment = 'nope';
      } else {
        patch(snap.complexityAssessment as unknown as Record<string, unknown>);
      }
      const restored = Mission.restore(snap, project);
      assert.equal(
        restored.complexityAssessment,
        undefined,
        `${label} should fail-closed to undefined`,
      );
    }
  });

  test('complexityAssessment 只读，无 setter；赋值失败', () => {
    const mission = Project.create({ id: 'p-ca-ro' }).createMission({
      id: 'm-ca-ro',
      complexityAssessment: sampleAssessment({ decidedBy: 'rule' }),
    });
    assert.throws(() => {
      (mission as unknown as Record<string, unknown>).complexityAssessment = undefined;
    }, TypeError);
    assert.equal(mission.complexityAssessment?.decidedBy, 'rule');
  });

  test('complexityAssessment 不改变 executionMode / runKind / status / isMutating', () => {
    const project = Project.create({ id: 'p-ca-side' });
    const mission = project.createMission({
      id: 'm-ca-side',
      complexityAssessment: sampleAssessment(),
      executionMode: 'lightweight',
      runKind: 'query',
    });
    assert.equal(mission.executionMode, 'lightweight');
    assert.equal(mission.runKind, 'query');
    assert.equal(mission.status, 'investigating');
    assert.equal(mission.isMutating, false);
    mission.startExecuting();
    assert.equal(mission.status, 'executing');
    assert.equal(mission.isMutating, true);
    assert.ok(mission.complexityAssessment);
  });

  test('生产代码无 complexityAssessment 路由分支、无 semantic_risk 映射', () => {
    const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts')) files.push(full);
      }
    };
    walk(srcRoot);

    for (const full of files) {
      const rel = full.slice(srcRoot.length).replaceAll('\\', '/');
      const source = readFileSync(full, 'utf8');
      // kernel 载荷合同允许声明字段；禁止把评估当路由条件或映射 semantic_risk。
      if (rel.startsWith('kernel/')) {
        assert.doesNotMatch(
          source,
          /semantic_risk/,
          `${rel}: kernel 不得映射 semantic_risk`,
        );
        assert.doesNotMatch(
          source,
          /if\s*\([^)]*complexityAssessment|complexityAssessment\s*[=!]=|switch\s*\([^)]*complexityAssessment/,
          `${rel}: 不得按 complexityAssessment 路由`,
        );
        continue;
      }
      assert.doesNotMatch(
        source,
        /complexityAssessment/,
        `${rel}: 本单 scope 外不得引用 complexityAssessment`,
      );
      // 非 kernel 允许既有 semantic_risk（Decision），但禁止与 complexityAssessment 同现映射。
    }
  });
});

function sampleBudget(overrides: Partial<ExecutionBudget> = {}): ExecutionBudget {
  return {
    maxAttempts: 3,
    maxRounds: 5,
    maxWallClockMs: 60_000,
    maxInputTokens: 100_000,
    maxOutputTokens: 20_000,
    maxTotalTokens: 120_000,
    maxCost: 1.25,
    maxChangedFiles: 12,
    maxCommands: 40,
    ...overrides,
  };
}

describe('Mission: executionBudget', () => {
  test('新建默认 undefined，快照不产生默认预算', () => {
    const mission = freshMission();
    assert.equal(mission.executionBudget, undefined);
    assert.equal(mission.toSnapshot().executionBudget, undefined);
  });

  test('完整合法对象含零值与小数 maxCost：frozen；未知 key 丢弃；snapshot/restore 相等', () => {
    const raw = {
      ...sampleBudget({
        maxAttempts: 0,
        maxRounds: 0,
        maxWallClockMs: 0,
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxTotalTokens: 0,
        maxCost: 0.5,
        maxChangedFiles: 0,
        maxCommands: 0,
      }),
      unknownPolicy: 'manual',
      source: 'classifier',
    };
    const mission = Project.create({ id: 'p-eb-ok' }).createMission({
      id: 'm-eb-ok',
      executionBudget: raw as ExecutionBudget,
    });

    const got = mission.executionBudget;
    assert.ok(got);
    assert.deepEqual(got, {
      maxAttempts: 0,
      maxRounds: 0,
      maxWallClockMs: 0,
      maxInputTokens: 0,
      maxOutputTokens: 0,
      maxTotalTokens: 0,
      maxCost: 0.5,
      maxChangedFiles: 0,
      maxCommands: 0,
    });
    assert.equal('unknownPolicy' in got, false);
    assert.equal('source' in got, false);
    assert.ok(Object.isFrozen(got));
    assert.throws(() => {
      (got as { maxAttempts: number }).maxAttempts = 9;
    }, TypeError);

    const snap = mission.toSnapshot().executionBudget;
    assert.deepEqual(snap, got);

    const restored = Mission.restore(mission.toSnapshot(), Project.create({ id: 'p-eb-ok' }));
    assert.deepEqual(restored.executionBudget, got);
    assert.deepEqual(restored.toSnapshot().executionBudget, snap);
    assert.ok(Object.isFrozen(restored.executionBudget));
  });

  test('老快照缺字段 / null restore -> undefined，不抛、不填默认', () => {
    const project = Project.create({ id: 'p-eb-old' });
    const base = project.createMission({ id: 'm-old' });
    const snapMissing = base.toSnapshot();
    delete snapMissing.executionBudget;
    const restoredMissing = Mission.restore(snapMissing, project);
    assert.equal(restoredMissing.executionBudget, undefined);
    assert.equal(restoredMissing.toSnapshot().executionBudget, undefined);

    const snapNull = base.toSnapshot();
    (snapNull as { executionBudget?: unknown }).executionBudget = null;
    const restoredNull = Mission.restore(snapNull, project);
    assert.equal(restoredNull.executionBudget, undefined);
  });

  test('缺任一 required => 整段 undefined', () => {
    const project = Project.create({ id: 'p-eb-req' });
    const base = project.createMission({
      id: 'm-eb-req',
      executionBudget: sampleBudget(),
    });
    const good = base.toSnapshot();

    for (const key of ['maxAttempts', 'maxRounds', 'maxWallClockMs'] as const) {
      const snap = structuredClone(good);
      delete (snap.executionBudget as Record<string, unknown>)[key];
      const restored = Mission.restore(snap, project);
      assert.equal(
        restored.executionBudget,
        undefined,
        `missing ${key} should fail-closed`,
      );
    }
  });

  test('optional-only 无 required => undefined', () => {
    const project = Project.create({ id: 'p-eb-opt' });
    const base = project.createMission({ id: 'm-eb-opt' });
    const snap = base.toSnapshot();
    (snap as { executionBudget?: unknown }).executionBudget = {
      maxInputTokens: 10,
      maxCost: 1,
    };
    const restored = Mission.restore(snap, project);
    assert.equal(restored.executionBudget, undefined);
  });

  test('malformed 表：整段 undefined，不 clamp、不 partial', () => {
    const project = Project.create({ id: 'p-eb-bad' });
    const base = project.createMission({
      id: 'm-eb-bad',
      executionBudget: sampleBudget(),
    });
    const good = base.toSnapshot();

    const cases: Array<{ label: string; apply: (snap: Record<string, unknown>) => void }> = [
      {
        label: 'negative maxAttempts',
        apply: (s) => {
          (s.executionBudget as Record<string, unknown>).maxAttempts = -1;
        },
      },
      {
        label: 'NaN maxRounds',
        apply: (s) => {
          (s.executionBudget as Record<string, unknown>).maxRounds = Number.NaN;
        },
      },
      {
        label: 'Infinity maxWallClockMs',
        apply: (s) => {
          (s.executionBudget as Record<string, unknown>).maxWallClockMs = Number.POSITIVE_INFINITY;
        },
      },
      {
        label: 'integer field 1.5',
        apply: (s) => {
          (s.executionBudget as Record<string, unknown>).maxCommands = 1.5;
        },
      },
      {
        label: "string '1'",
        apply: (s) => {
          (s.executionBudget as Record<string, unknown>).maxAttempts = '1';
        },
      },
      {
        label: 'boolean true',
        apply: (s) => {
          (s.executionBudget as Record<string, unknown>).maxRounds = true;
        },
      },
      {
        label: 'boxed Number',
        apply: (s) => {
          (s.executionBudget as Record<string, unknown>).maxWallClockMs = Object(10);
        },
      },
      {
        label: 'negative maxCost',
        apply: (s) => {
          (s.executionBudget as Record<string, unknown>).maxCost = -0.01;
        },
      },
      {
        label: 'NaN maxCost',
        apply: (s) => {
          (s.executionBudget as Record<string, unknown>).maxCost = Number.NaN;
        },
      },
      {
        label: 'Infinity maxCost',
        apply: (s) => {
          (s.executionBudget as Record<string, unknown>).maxCost = Number.POSITIVE_INFINITY;
        },
      },
      {
        label: 'string maxCost',
        apply: (s) => {
          (s.executionBudget as Record<string, unknown>).maxCost = '1.25';
        },
      },
      {
        label: '非普通对象 array',
        apply: (s) => {
          s.executionBudget = [1, 2, 3];
        },
      },
      {
        label: '非对象 string',
        apply: (s) => {
          s.executionBudget = 'nope';
        },
      },
    ];

    for (const { label, apply } of cases) {
      const snap = structuredClone(good) as unknown as Record<string, unknown>;
      apply(snap);
      const restored = Mission.restore(snap as never, project);
      assert.equal(
        restored.executionBudget,
        undefined,
        `${label} should fail-closed to undefined`,
      );
    }
  });

  test('仅 required 合法、optional 缺席 => omit optional',
    () => {
      const mission = Project.create({ id: 'p-eb-min' }).createMission({
        id: 'm-eb-min',
        executionBudget: {
          maxAttempts: 1,
          maxRounds: 2,
          maxWallClockMs: 3,
        },
      });
      assert.deepEqual(mission.executionBudget, {
        maxAttempts: 1,
        maxRounds: 2,
        maxWallClockMs: 3,
      });
      assert.equal('maxCost' in (mission.executionBudget as object), false);
      assert.equal('maxInputTokens' in (mission.executionBudget as object), false);
    },
  );

  test('executionBudget 只读，无 setter；赋值失败', () => {
    const mission = Project.create({ id: 'p-eb-ro' }).createMission({
      id: 'm-eb-ro',
      executionBudget: sampleBudget({ maxAttempts: 7 }),
    });
    assert.throws(() => {
      (mission as unknown as Record<string, unknown>).executionBudget = undefined;
    }, TypeError);
    assert.equal(mission.executionBudget?.maxAttempts, 7);
  });

  test('executionBudget 不改变 executionMode / runKind / status / isMutating / complexityAssessment', () => {
    const project = Project.create({ id: 'p-eb-side' });
    const assessment: ComplexityAssessment = {
      goalUncertainty: 1,
      changeScope: 1,
      operationalRisk: 1,
      verificationDifficulty: 1,
      coordinationNeed: 1,
      recoveryDifficulty: 1,
      reasons: ['side'],
      decidedBy: 'rule',
      assessedAt: '2026-03-21T00:00:00.000Z',
    };
    const mission = project.createMission({
      id: 'm-eb-side',
      executionBudget: sampleBudget(),
      complexityAssessment: assessment,
      executionMode: 'high_assurance',
      runKind: 'query',
    });
    assert.equal(mission.executionMode, 'high_assurance');
    assert.equal(mission.runKind, 'query');
    assert.equal(mission.status, 'investigating');
    assert.equal(mission.isMutating, false);
    assert.deepEqual(mission.complexityAssessment?.reasons, ['side']);
    mission.startExecuting();
    assert.equal(mission.status, 'executing');
    assert.equal(mission.isMutating, true);
    assert.ok(mission.executionBudget);
  });

  test('生产代码无 executionBudget 路由/gating 分支', () => {
    const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts')) files.push(full);
      }
    };
    walk(srcRoot);

    for (const full of files) {
      const rel = full.slice(srcRoot.length).replaceAll('\\', '/');
      const source = readFileSync(full, 'utf8');
      if (rel.startsWith('kernel/')) {
        assert.doesNotMatch(
          source,
          /if\s*\([^)]*executionBudget|executionBudget\s*[=!]=|switch\s*\([^)]*executionBudget/,
          `${rel}: 不得按 executionBudget 路由/gating`,
        );
        continue;
      }
      // 允许类型名出现在“不实现 ExecutionBudget”类否定注释；禁止字段接入。
      assert.doesNotMatch(
        source,
        /executionBudget/,
        `${rel}: 本单 scope 外不得引用 executionBudget 字段`,
      );
    }
  });
});

describe('Mission: 合法流转', () => {
  test('investigating -> planning -> executing -> awaiting_review -> completed', () => {
    const mission = freshMission();
    mission.startPlanning();
    assert.equal(mission.status, 'planning');
    mission.startExecuting();
    assert.equal(mission.status, 'executing');
    assert.equal(mission.isMutating, true);
    // 交卷只到 awaiting_review：没经过 L3 检视不算完成，改动也还没落地。
    mission.submitForReview();
    assert.equal(mission.status, 'awaiting_review');
    assert.equal(mission.isMutating, true, '等检视时名额仍然握着');
    mission.complete();
    assert.equal(mission.status, 'completed');
    assert.equal(mission.isMutating, false);
  });

  test('investigating 可以直接 executing', () => {
    const mission = freshMission();
    mission.startExecuting();
    assert.equal(mission.status, 'executing');
  });

  test('executing 可以退回 planning，但名额不放', () => {
    const mission = freshMission();
    mission.startExecuting();
    mission.startPlanning();
    assert.equal(mission.status, 'planning');
    // 动过代码就一直占着名额，直到落地或放弃：分支上的改动还在。
    assert.equal(mission.isMutating, true);
  });

  test('investigating / planning / executing 都能 block', () => {
    for (const path of [
      [],
      ['startPlanning'],
      ['startPlanning', 'startExecuting'],
      ['startExecuting'],
    ] as const) {
      const mission = freshMission();
      for (const step of path) mission[step]();
      mission.block();
      assert.equal(mission.status, 'blocked');
      assert.equal(mission.isMutating, false);
    }
  });
});

describe('Mission: 非法流转', () => {
  test('调查/规划阶段可以直接交给 L3 检视：查完发现不用改代码是正常结局', () => {
    // 这条在 2026-09-15 建平台时改过。原先禁止 investigating/planning ->
    // completed，理由是「complete 表示改动完成」。但 Mission 是一次用户目标，
    // 交出一个有据可依的结论也算达成；强迫它先走一遍 executing 只会制造假的
    // 改动阶段。关键不变式仍在：这种 Mission 从不占用不变量 C 的名额。
    const direct = freshMission();
    direct.submitForReview();
    assert.equal(direct.status, 'awaiting_review');
    direct.complete();
    assert.equal(direct.status, 'completed');
    assert.equal(direct.isMutating, false, '没改过代码的 Mission 不该占用改动名额');

    const afterPlanning = freshMission();
    afterPlanning.startPlanning();
    afterPlanning.submitForReview();
    afterPlanning.complete();
    assert.equal(afterPlanning.status, 'completed');
  });

  test('终态没有任何出边', () => {
    const done = freshMission();
    done.submitForReview();
    done.complete();
    assert.throws(() => done.startPlanning(), illegal('Mission', 'completed', 'planning'));
    assert.throws(() => done.startExecuting(), illegal('Mission', 'completed', 'executing'));
    assert.throws(() => done.block(), illegal('Mission', 'completed', 'blocked'));

    const stopped = freshMission();
    stopped.block();
    assert.throws(() => stopped.complete(), illegal('Mission', 'blocked', 'completed'));
  });

  test('planning -> planning 非法', () => {
    const mission = freshMission();
    mission.startPlanning();
    assert.throws(() => mission.startPlanning(), illegal('Mission', 'planning', 'planning'));
  });

  test('executing -> executing 非法（且优先于不变量 C）', () => {
    const mission = freshMission();
    mission.startExecuting();
    assert.throws(() => mission.startExecuting(), illegal('Mission', 'executing', 'executing'));
  });

  test('completed 是终态：任何状态操作都抛 IllegalTransitionError', () => {
    const mission = freshMission();
    mission.startExecuting();
    mission.submitForReview();
    mission.complete();

    assert.throws(() => mission.startPlanning(), illegal('Mission', 'completed', 'planning'));
    assert.throws(() => mission.startExecuting(), illegal('Mission', 'completed', 'executing'));
    assert.throws(() => mission.complete(), illegal('Mission', 'completed', 'completed'));
    assert.throws(() => mission.block(), illegal('Mission', 'completed', 'blocked'));
    assert.throws(
      () => mission.startCoordinatorAttempt(),
      illegal('Mission', 'completed', 'startCoordinatorAttempt'),
    );
    assert.throws(
      () => mission.createWorkItem({ id: 'w-late', title: 't' }),
      illegal('Mission', 'completed', 'createWorkItem'),
    );
    assert.deepEqual(mission.workItems, []);
  });

  test('blocked 是终态', () => {
    const mission = freshMission();
    mission.block();
    assert.throws(() => mission.startPlanning(), illegal('Mission', 'blocked', 'planning'));
    assert.throws(() => mission.startExecuting(), illegal('Mission', 'blocked', 'executing'));
    assert.throws(() => mission.complete(), illegal('Mission', 'blocked', 'completed'));
    assert.throws(() => mission.block(), illegal('Mission', 'blocked', 'blocked'));
    assert.throws(
      () => mission.startCoordinatorAttempt(),
      illegal('Mission', 'blocked', 'startCoordinatorAttempt'),
    );
    assert.throws(
      () => mission.createWorkItem({ id: 'w-late', title: 't' }),
      illegal('Mission', 'blocked', 'createWorkItem'),
    );
  });
});

describe('Mission: createWorkItem', () => {
  test('建出的 WorkItem 挂到本 Mission 上，初始 created', () => {
    const mission = freshMission();
    const item = mission.createWorkItem({ id: 'w-7', title: '跑通测试' });
    assert.equal(item.id, 'w-7');
    assert.equal(item.missionId, mission.id);
    assert.equal(item.status, 'created');
    assert.equal(mission.workItems.length, 1);
    assert.equal(mission.workItems[0], item);
  });

  test('investigating / planning / executing 上都能建 WorkItem', () => {
    const mission = freshMission();
    mission.createWorkItem({ id: 'w-a', title: 'a' });
    mission.startPlanning();
    mission.createWorkItem({ id: 'w-b', title: 'b' });
    mission.startExecuting();
    mission.createWorkItem({ id: 'w-c', title: 'c' });
    assert.equal(mission.workItems.length, 3);
  });

  test('同一 Mission 内 workItem id 重复抛 DUPLICATE_ID', () => {
    const mission = freshMission();
    mission.createWorkItem({ id: 'w-dup', title: 'a' });
    assert.throws(
      () => mission.createWorkItem({ id: 'w-dup', title: 'b' }),
      invariant('DUPLICATE_ID'),
    );
    assert.equal(mission.workItems.length, 1);
  });

  test('不同 Mission 的 workItem id 互不影响', () => {
    const project = Project.create({ id: 'p-wi-scope' });
    const m1 = project.createMission({ id: 'm1' });
    const m2 = project.createMission({ id: 'm2' });
    m1.createWorkItem({ id: 'w-shared', title: 'a' });
    m2.createWorkItem({ id: 'w-shared', title: 'b' });
    assert.equal(m1.workItems[0].missionId, 'm1');
    assert.equal(m2.workItems[0].missionId, 'm2');
  });
});

describe('Mission: coordinator attempt 归属', () => {
  test('startCoordinatorAttempt 记录到 coordinatorAttempts，不影响 workItems', () => {
    const mission = freshMission();
    const attempt = mission.startCoordinatorAttempt();
    assert.equal(mission.coordinatorAttempts.length, 1);
    assert.equal(mission.coordinatorAttempts[0], attempt);
    assert.deepEqual(mission.workItems, []);
    assert.equal(mission.status, 'investigating');
  });

  test('executor attempt 不会出现在 coordinatorAttempts 里', () => {
    const mission = freshMission();
    mission.startExecuting();
    const item = mission.createWorkItem({ id: 'w-x', title: 't' });
    item.dispatch();
    item.startAttempt();
    assert.deepEqual(mission.coordinatorAttempts, []);
    assert.equal(item.attempts.length, 1);
  });
});
