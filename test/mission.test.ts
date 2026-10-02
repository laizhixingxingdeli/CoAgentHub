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
  PromotionRecord,
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
      'promotions',
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

    // M3D-2：classified intake 可把 assessment 持久到 Mission 载荷；
    // classifier 消费 assessment 分数。仍禁止 if/switch 直接按字段路由。
    const ALLOW_PERSIST = new Set([
      'application/platform.ts',
      'application/classified-mission-intake.ts',
      'application/task-classifier.ts',
    ]);
    const routeBranch =
      /if\s*\([^)]*complexityAssessment|complexityAssessment\s*[=!]=|switch\s*\([^)]*complexityAssessment/;
    // 平台子模块：入口 platform.ts + platform/ 下实际 .ts 文件，受同一套护栏约束。
    const isPlatform = (rel: string) =>
      rel === 'application/platform.ts' ||
      (rel.startsWith('application/platform/') && rel.endsWith('.ts'));

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
          routeBranch,
          `${rel}: 不得按 complexityAssessment 路由`,
        );
        continue;
      }
      if (ALLOW_PERSIST.has(rel) || isPlatform(rel)) {
        assert.doesNotMatch(
          source,
          routeBranch,
          `${rel}: 不得按 complexityAssessment 字段做 if/switch 路由`,
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

  test('executionBudget 仅 kernel 持有 + budget/platform/orchestrator 权威消费；其它 src 不接入', () => {
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

    // BUDGET-001-S5: Platform + Orchestrator may consume Mission.executionBudget
    // via evaluateMissionBudget. Kernel still must not branch on it for routing.
    const allowedField = new Set([
      'kernel/mission.ts',
      'kernel/project.ts',
      'kernel/snapshot.ts',
      'kernel/payloads.ts',
      'kernel/index.ts',
      'application/budget-usage.ts',
      'application/platform.ts',
      'application/orchestrator.ts',
    ]);
    // 平台子模块：入口 platform.ts + platform/ 下实际 .ts 文件，拥有与旧 platform 相同的 executionBudget 权限。
    const isPlatform = (rel: string) =>
      rel === 'application/platform.ts' ||
      (rel.startsWith('application/platform/') && rel.endsWith('.ts'));

    for (const full of files) {
      const rel = full.slice(srcRoot.length).replaceAll('\\', '/');
      const source = readFileSync(full, 'utf8');
      if (rel.startsWith('kernel/')) {
        // Mission holds the field; no kernel-level routing/gating on it.
        if (rel === 'kernel/mission.ts' || rel === 'kernel/project.ts' || rel === 'kernel/snapshot.ts') {
          continue;
        }
        assert.doesNotMatch(
          source,
          /if\s*\([^)]*executionBudget|executionBudget\s*[=!]=|switch\s*\([^)]*executionBudget/,
          `${rel}: 不得按 executionBudget 路由/gating`,
        );
        continue;
      }
      if (allowedField.has(rel) || isPlatform(rel)) continue;
      assert.doesNotMatch(
        source,
        /executionBudget/,
        `${rel}: 不得引用 executionBudget 字段（权威消费仅 budget-usage/platform/orchestrator）`,
      );
    }
  });
});

function samplePromotion(
  overrides: Partial<PromotionRecord> = {},
): PromotionRecord {
  return {
    id: 'promo-test-1',
    fromMode: 'lightweight',
    toMode: 'standard',
    triggerCode: 'design_decision',
    triggerRule: 'needs design review',
    at: '2026-06-01T12:00:00.000Z',
    fromStatus: 'investigating',
    toStatus: 'investigating',
    consumedUsage: {
      attemptCount: 0,
      dimensionsUnknown: [
        'tokens',
        'cost',
        'wallClockMs',
        'rounds',
        'changedFiles',
        'commands',
        'budgetRemaining',
      ],
      budgetAuthoritative: false,
    },
    evidenceIds: [],
    validationReportIds: [],
    workspaceRevision: { kind: 'unknown' },
    workItemIdsSnapshot: [],
    ...overrides,
  };
}

describe('Mission: promoteToStandard (PROMO-001)', () => {
  test('lightweight investigating promote => standard + investigating + 1 promotion；旧状态原样保留', () => {
    const project = Project.create({ id: 'p-promo-inv' });
    const mission = project.createMission({
      id: 'm-promo-inv',
      executionMode: 'lightweight',
      runKind: 'mutation',
    });
    mission.reviseContract({
      intent: 'keep me',
      acceptance: ['a'],
      constraints: [],
      nonGoals: [],
      guardrails: [],
    });
    mission.updatePlan({
      findings: 'f',
      rejectedHypotheses: [],
      decisions: [],
      direction: 'd',
      risks: [],
    });
    const wi = mission.createWorkItem({ id: 'w-1', title: 't', order: ATOMIC_ORDER });
    wi.dispatch();
    const attempt = wi.startAttempt();
    attempt.addEvidence({
      id: 'E1',
      attemptId: attempt.id,
      kind: 'test',
      summary: 'ok',
    });
    attempt.recordUsage({
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      total: 3,
      quality: 'reported',
    });
    wi.submit(
      {
        outcome: 'completed',
        summary: 'done',
        changedFiles: ['src/foo.ts'],
        evidenceIds: ['E1'],
        notes: 'n',
      },
      attempt.id,
    );
    mission.recordWorkspace({
      projectRoot: '/p',
      branch: 'mission/m',
      baseRevision: 'base-old',
    });
    mission.recordResult({
      outcome: 'delivered',
      summary: 's',
      acceptanceEvidence: ['E1'],
      memoryDelta: [],
      openRisks: [],
    });
    mission.setWaitReason('waiting_l3', 'detail');

    const before = {
      workItemIds: mission.workItems.map((i) => i.id),
      attemptIds: mission.workItems.flatMap((i) => i.attempts.map((a) => a.id)),
      evidence: attempt.evidence.map((e) => e.id),
      result: mission.result,
      workspaceRef: mission.workspaceRef,
      waitReason: mission.waitReason,
      waitDetail: mission.waitDetail,
      planRevision: mission.planRevision,
      contractRevision: mission.contractRevision,
      itemStatus: wi.status,
      executionResult: wi.executionResult,
    };

    const record = samplePromotion({
      fromStatus: 'investigating',
      toStatus: 'investigating',
      workItemIdsSnapshot: ['w-1'],
      evidenceIds: ['E1'],
    });
    const out = mission.promoteToStandard(record);
    assert.equal(out.changed, true);
    assert.equal(mission.executionMode, 'standard');
    assert.equal(mission.status, 'investigating');
    assert.equal(mission.promotions.length, 1);
    assert.equal(mission.promotions[0]!.triggerCode, 'design_decision');
    assert.equal(out.promotion, mission.promotions[0]);

    assert.deepEqual(
      mission.workItems.map((i) => i.id),
      before.workItemIds,
    );
    assert.deepEqual(
      mission.workItems.flatMap((i) => i.attempts.map((a) => a.id)),
      before.attemptIds,
    );
    assert.deepEqual(attempt.evidence.map((e) => e.id), before.evidence);
    assert.deepEqual(mission.result, before.result);
    assert.deepEqual(mission.workspaceRef, before.workspaceRef);
    assert.equal(mission.waitReason, before.waitReason);
    assert.equal(mission.waitDetail, before.waitDetail);
    assert.equal(mission.planRevision, before.planRevision);
    assert.equal(mission.contractRevision, before.contractRevision);
    assert.equal(wi.status, before.itemStatus);
    assert.deepEqual(wi.executionResult, before.executionResult);
  });

  test('lightweight planning promote => planning；executing promote => planning 且 isMutating 仍 true', () => {
    const p1 = Project.create({ id: 'p-promo-plan' });
    const m1 = p1.createMission({ id: 'm-plan', executionMode: 'lightweight' });
    m1.startPlanning();
    const r1 = samplePromotion({
      fromStatus: 'planning',
      toStatus: 'planning',
    });
    m1.promoteToStandard(r1);
    assert.equal(m1.status, 'planning');
    assert.equal(m1.executionMode, 'standard');
    assert.equal(m1.isMutating, false);

    const p2 = Project.create({ id: 'p-promo-exec' });
    const m2 = p2.createMission({ id: 'm-exec', executionMode: 'lightweight' });
    m2.startExecuting();
    assert.equal(m2.isMutating, true);
    const r2 = samplePromotion({
      fromStatus: 'executing',
      toStatus: 'planning',
      triggerCode: 'executor_ambiguity',
      triggerRule: 'ambiguous',
    });
    m2.promoteToStandard(r2);
    assert.equal(m2.status, 'planning');
    assert.equal(m2.executionMode, 'standard');
    assert.equal(m2.isMutating, true, '已有改动名额不能因回 planning 释放');
    assert.equal(m2.hasMutated, true);
  });

  test('awaiting_review/completed/blocked/standard/high_assurance/runKind=query 拒绝且零 mutation', () => {
    const cases: Array<{ label: string; setup: () => Mission }> = [
      {
        label: 'awaiting_review',
        setup: () => {
          const m = Project.create({ id: 'p-ar' }).createMission({
            id: 'm-ar',
            executionMode: 'lightweight',
          });
          m.submitForReview();
          return m;
        },
      },
      {
        label: 'completed',
        setup: () => {
          const m = Project.create({ id: 'p-c' }).createMission({
            id: 'm-c',
            executionMode: 'lightweight',
          });
          m.submitForReview();
          m.complete({ verdict: 'merge', reasons: ['ok'] });
          return m;
        },
      },
      {
        label: 'blocked',
        setup: () => {
          const m = Project.create({ id: 'p-b' }).createMission({
            id: 'm-b',
            executionMode: 'lightweight',
          });
          m.block();
          return m;
        },
      },
      {
        label: 'standard',
        setup: () =>
          Project.create({ id: 'p-s' }).createMission({
            id: 'm-s',
            executionMode: 'standard',
          }),
      },
      {
        label: 'high_assurance',
        setup: () =>
          Project.create({ id: 'p-ha' }).createMission({
            id: 'm-ha',
            executionMode: 'high_assurance',
          }),
      },
      {
        label: 'query',
        setup: () =>
          Project.create({ id: 'p-q' }).createMission({
            id: 'm-q',
            executionMode: 'lightweight',
            runKind: 'query',
          }),
      },
    ];

    for (const { label, setup } of cases) {
      const mission = setup();
      const snap = mission.toSnapshot();
      const record = samplePromotion({
        fromStatus:
          mission.status === 'planning' || mission.status === 'executing'
            ? mission.status
            : 'investigating',
        toStatus:
          mission.status === 'executing'
            ? 'planning'
            : mission.status === 'planning'
              ? 'planning'
              : 'investigating',
      });
      assert.throws(() => mission.promoteToStandard(record), (err: unknown) => {
        assert.ok(
          err instanceof InvariantViolationError || err instanceof IllegalTransitionError,
          `${label}: ${String(err)}`,
        );
        return true;
      });
      assert.equal(mission.executionMode, snap.executionMode, label);
      assert.equal(mission.status, snap.status, label);
      assert.equal(mission.promotions.length, 0, label);
      assert.deepEqual(mission.toSnapshot().promotions, []);
    }
  });

  test('malformed record 拒绝且 mode/status/promotions 不变', () => {
    const mission = Project.create({ id: 'p-mal' }).createMission({
      id: 'm-mal',
      executionMode: 'lightweight',
    });
    const good = samplePromotion();
    const badCases: unknown[] = [
      { ...good, fromMode: 'standard' },
      { ...good, toMode: 'lightweight' },
      { ...good, triggerCode: 'not_a_code' },
      { ...good, triggerRule: '' },
      { ...good, at: '' },
      { ...good, fromStatus: 'completed' },
      { ...good, fromStatus: 'planning', toStatus: 'investigating' },
      { ...good, toStatus: 'executing' },
      {
        ...good,
        consumedUsage: { ...good.consumedUsage, attemptCount: -1 },
      },
      {
        ...good,
        consumedUsage: { ...good.consumedUsage, attemptCount: 1.5 },
      },
      {
        ...good,
        consumedUsage: { ...good.consumedUsage, budgetAuthoritative: true },
      },
      {
        ...good,
        consumedUsage: {
          ...good.consumedUsage,
          tokenUsage: {
            input: -1,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
            quality: 'reported',
          },
        },
      },
      { ...good, evidenceIds: [1] },
      { ...good, validationReportIds: null },
      { ...good, workItemIdsSnapshot: 'w' },
      { ...good, workspaceRevision: { kind: 'head', revision: '' } },
      { ...good, workspaceRevision: { kind: 'other' } },
    ];

    for (const bad of badCases) {
      assert.throws(
        () => mission.promoteToStandard(bad as PromotionRecord),
        (err: unknown) => {
          assert.ok(err instanceof InvariantViolationError);
          assert.equal(err.code, 'INVALID_PROMOTION_RECORD');
          return true;
        },
      );
      assert.equal(mission.executionMode, 'lightweight');
      assert.equal(mission.status, 'investigating');
      assert.equal(mission.promotions.length, 0);
    }
  });

  test('same exact record second call idempotent；different trigger 拒绝', () => {
    const mission = Project.create({ id: 'p-idemp' }).createMission({
      id: 'm-idemp',
      executionMode: 'lightweight',
    });
    const record = samplePromotion();
    const first = mission.promoteToStandard(record);
    assert.equal(first.changed, true);
    const second = mission.promoteToStandard(record);
    assert.equal(second.changed, false);
    assert.equal(second.promotion, mission.promotions[0]);
    assert.equal(mission.promotions.length, 1);

    const different = samplePromotion({
      triggerCode: 'new_dependency',
      triggerRule: 'package.json changed',
    });
    assert.throws(() => mission.promoteToStandard(different), (err: unknown) => {
      assert.ok(err instanceof InvariantViolationError);
      assert.equal(err.code, 'PROMOTION_ALREADY_APPLIED');
      return true;
    });
    assert.equal(mission.promotions.length, 1);
    assert.equal(mission.promotions[0]!.triggerCode, 'design_decision');
  });

  test('input record/nested arrays 后续 mutation 不污染；promotion deep frozen', () => {
    const mission = Project.create({ id: 'p-freeze' }).createMission({
      id: 'm-freeze',
      executionMode: 'lightweight',
    });
    const evidenceIds = ['E-a'];
    const dimensionsUnknown = [
      'tokens',
      'cost',
      'wallClockMs',
      'rounds',
      'changedFiles',
      'commands',
      'budgetRemaining',
    ] as const;
    const dims = [...dimensionsUnknown];
    const record: PromotionRecord = {
      id: 'promo-freeze-1',
      fromMode: 'lightweight',
      toMode: 'standard',
      triggerCode: 'changed_files_gt_3',
      triggerRule: 'files>3',
      at: '2026-06-01T12:00:00.000Z',
      fromStatus: 'investigating',
      toStatus: 'investigating',
      consumedUsage: {
        attemptCount: 1,
        dimensionsUnknown: dims,
        budgetAuthoritative: false,
      },
      evidenceIds,
      validationReportIds: [],
      workspaceRevision: { kind: 'head', revision: 'abc' },
      workItemIdsSnapshot: ['w'],
    };
    const out = mission.promoteToStandard(record);
    evidenceIds.push('E-mutated');
    dims.push('tokens');
    (record as { triggerRule: string }).triggerRule = 'mutated';

    assert.deepEqual(out.promotion.evidenceIds, ['E-a']);
    assert.equal(out.promotion.triggerRule, 'files>3');
    assert.equal(out.promotion.consumedUsage.dimensionsUnknown.length, 7);
    assert.ok(Object.isFrozen(out.promotion));
    assert.ok(Object.isFrozen(out.promotion.evidenceIds));
    assert.ok(Object.isFrozen(out.promotion.consumedUsage));
    assert.ok(Object.isFrozen(out.promotion.consumedUsage.dimensionsUnknown));
    assert.ok(Object.isFrozen(out.promotion.workspaceRevision));
    assert.throws(() => {
      (out.promotion as { triggerRule: string }).triggerRule = 'x';
    }, TypeError);

    const copy = mission.promotions;
    (copy as PromotionRecord[]).pop();
    assert.equal(mission.promotions.length, 1);
  });

  test('snapshot roundtrip preserves promotion + standard mode；legacy/malformed restore 安全', () => {
    const project = Project.create({ id: 'p-snap' });
    const mission = project.createMission({
      id: 'm-snap',
      executionMode: 'lightweight',
    });
    mission.promoteToStandard(
      samplePromotion({
        id: 'promo-snap-1',
        triggerCode: 'diff_intent_unprovable',
        triggerRule: 'intent',
        evidenceIds: ['E1', 'E2'],
        validationReportIds: ['VR1'],
        workItemIdsSnapshot: ['w1'],
        workspaceRevision: { kind: 'head', revision: 'deadbeef' },
        consumedUsage: {
          attemptCount: 2,
          tokenUsage: {
            input: 10,
            output: 20,
            cacheRead: 1,
            cacheWrite: 2,
            total: 33,
            quality: 'estimated',
          },
          dimensionsUnknown: [
            'cost',
            'wallClockMs',
            'rounds',
            'changedFiles',
            'commands',
            'budgetRemaining',
          ],
          budgetAuthoritative: false,
        },
      }),
    );

    const snapOut = mission.toSnapshot();
    // toSnapshot fail-closed：只发出 normalize 后的可信记录（无 raw freezeDeep fallback）。
    assert.equal(snapOut.promotions.length, 1);
    assert.deepEqual(snapOut.promotions[0], mission.promotions[0]);
    assert.ok(Object.isFrozen(snapOut.promotions[0]));
    assert.equal(snapOut.promotions[0]!.id, 'promo-snap-1');
    assert.deepEqual(snapOut.promotions[0]!.validationReportIds, ['VR1']);

    const restored = Mission.restore(snapOut, Project.create({ id: 'p-snap2' }));
    assert.equal(restored.executionMode, 'standard');
    assert.equal(restored.promotions.length, 1);
    assert.deepEqual(restored.promotions[0], mission.promotions[0]);
    assert.equal(restored.promotions[0]!.id, 'promo-snap-1');
    assert.ok(Object.isFrozen(restored.promotions[0]));

    const legacy = mission.toSnapshot();
    delete legacy.promotions;
    const fromLegacy = Mission.restore(legacy, Project.create({ id: 'p-leg' }));
    assert.equal(fromLegacy.executionMode, 'standard');
    assert.deepEqual(fromLegacy.promotions, []);

    // standard + 1 valid + junk => 仅保留合法一条
    const malformed = mission.toSnapshot();
    (malformed as { promotions?: unknown }).promotions = [
      mission.promotions[0],
      { fromMode: 'lightweight' },
      null,
      'nope',
      {
        ...samplePromotion(),
        triggerCode: 'bogus',
      },
      {
        ...samplePromotion({ id: '' }),
      },
    ];
    const fromMalformed = Mission.restore(malformed, Project.create({ id: 'p-mf' }));
    assert.equal(fromMalformed.executionMode, 'standard');
    assert.equal(fromMalformed.promotions.length, 1);
    assert.equal(fromMalformed.promotions[0]!.triggerCode, 'diff_intent_unprovable');
    assert.equal(fromMalformed.promotions[0]!.id, 'promo-snap-1');

    // 缺 id / 空 id => 丢弃
    const noId = mission.toSnapshot();
    const withoutId = { ...mission.promotions[0]! } as Record<string, unknown>;
    delete withoutId.id;
    (noId as { promotions?: unknown }).promotions = [withoutId];
    const fromNoId = Mission.restore(noId, Project.create({ id: 'p-noid' }));
    assert.equal(fromNoId.executionMode, 'standard');
    assert.deepEqual(fromNoId.promotions, []);

    const emptyId = mission.toSnapshot();
    (emptyId as { promotions?: unknown }).promotions = [
      { ...mission.promotions[0]!, id: '' },
    ];
    const fromEmptyId = Mission.restore(emptyId, Project.create({ id: 'p-eid' }));
    assert.deepEqual(fromEmptyId.promotions, []);

    // >1 条合法 => 整表不可信
    const twoValid = mission.toSnapshot();
    (twoValid as { promotions?: unknown }).promotions = [
      samplePromotion({ id: 'promo-a' }),
      samplePromotion({ id: 'promo-b', triggerCode: 'new_dependency', triggerRule: 'dep' }),
    ];
    const fromTwo = Mission.restore(twoValid, Project.create({ id: 'p-two' }));
    assert.equal(fromTwo.executionMode, 'standard');
    assert.deepEqual(fromTwo.promotions, []);

    // standard + 空/全 malformed list => promotions []，mode 不变
    const emptyList = mission.toSnapshot();
    (emptyList as { promotions?: unknown }).promotions = [];
    const fromEmptyList = Mission.restore(emptyList, Project.create({ id: 'p-el' }));
    assert.equal(fromEmptyList.executionMode, 'standard');
    assert.deepEqual(fromEmptyList.promotions, []);

    const allBad = mission.toSnapshot();
    (allBad as { promotions?: unknown }).promotions = [
      null,
      { fromMode: 'lightweight' },
      samplePromotion({ id: '' }),
    ];
    const fromAllBad = Mission.restore(allBad, Project.create({ id: 'p-ab' }));
    assert.equal(fromAllBad.executionMode, 'standard');
    assert.deepEqual(fromAllBad.promotions, []);

    // lightweight + nonempty promotions => 丢 promotions，不改 mode
    const light = Project.create({ id: 'p-light' }).createMission({
      id: 'm-light',
      executionMode: 'lightweight',
    });
    const lightSnap = light.toSnapshot();
    (lightSnap as { promotions?: unknown }).promotions = [samplePromotion({ id: 'should-drop' })];
    const fromLight = Mission.restore(lightSnap, Project.create({ id: 'p-light2' }));
    assert.equal(fromLight.executionMode, 'lightweight');
    assert.deepEqual(fromLight.promotions, []);
  });

  test('malformed missing id rejected on promote', () => {
    const mission = Project.create({ id: 'p-noid-p' }).createMission({
      id: 'm-noid-p',
      executionMode: 'lightweight',
    });
    const bad = { ...samplePromotion() } as Record<string, unknown>;
    delete bad.id;
    assert.throws(
      () => mission.promoteToStandard(bad as PromotionRecord),
      (err: unknown) => {
        assert.ok(err instanceof InvariantViolationError);
        assert.equal(err.code, 'INVALID_PROMOTION_RECORD');
        return true;
      },
    );
    assert.equal(mission.executionMode, 'lightweight');
    assert.equal(mission.promotions.length, 0);
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
