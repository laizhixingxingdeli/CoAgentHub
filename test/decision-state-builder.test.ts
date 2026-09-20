/**
 * Decision StateBuilder：versioned 只读投影，只接受显式 facts。
 * 含 HOPT-03-B 离线边界守卫：防隐式实体 dump / 提前生产接线。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DECISION_STATE_SCHEMA_VERSION,
  EMPTY_DECISION_STATE_FACTS,
  buildDecisionState,
  toDecisionRequest,
} from '../src/application/decision-state-builder.ts';
import type { DecisionRequest } from '../src/application/ports.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function relPosix(abs: string): string {
  return relative(root, abs).split('\\').join('/');
}

describe('buildDecisionState', () => {
  test('schemaVersion 稳定为固定常量', () => {
    const state = buildDecisionState({
      hook: 'PRE_DISPATCH',
      projectId: 'p-1',
      missionId: 'm-1',
    });
    assert.equal(state.schemaVersion, DECISION_STATE_SCHEMA_VERSION);
    assert.equal(DECISION_STATE_SCHEMA_VERSION, '1');
  });

  test('回显 hook 与 ids；不自动补业务 fact', () => {
    const state = buildDecisionState({
      hook: 'POST_EXECUTION',
      projectId: 'p-9',
      missionId: 'm-9',
      workItemId: 'w-9',
      attemptId: 'a-9',
    });
    assert.equal(state.hook, 'POST_EXECUTION');
    assert.equal(state.projectId, 'p-9');
    assert.equal(state.missionId, 'm-9');
    assert.equal(state.workItemId, 'w-9');
    assert.equal(state.attemptId, 'a-9');
    assert.deepEqual(state.facts, EMPTY_DECISION_STATE_FACTS);
    assert.equal(state.facts.length, 0);
  });

  test('无 facts 时使用固定可测试的空表示', () => {
    const a = buildDecisionState({
      hook: 'PRE_DISPATCH',
      projectId: 'p',
      missionId: 'm',
    });
    const b = buildDecisionState({
      hook: 'PRE_DISPATCH',
      projectId: 'p',
      missionId: 'm',
      facts: [],
    });
    assert.deepEqual(a.facts, EMPTY_DECISION_STATE_FACTS);
    assert.deepEqual(b.facts, EMPTY_DECISION_STATE_FACTS);
    assert.equal(a.facts, EMPTY_DECISION_STATE_FACTS);
    assert.equal(b.facts, EMPTY_DECISION_STATE_FACTS);
  });

  test('显式 facts 顺序与值原样保留', () => {
    const facts = [
      { key: 'alpha', value: '1' },
      { key: 'beta', value: 'two' },
      { key: 'alpha', value: 'again' },
    ];
    const state = buildDecisionState({
      hook: 'PRE_DISPATCH',
      projectId: 'p',
      missionId: 'm',
      facts,
    });
    assert.deepEqual(state.facts, facts);
    assert.notEqual(state.facts, facts);
  });

  test('可选 ids 缺省时不出现在输出上', () => {
    const state = buildDecisionState({
      hook: 'PRE_DISPATCH',
      projectId: 'p',
      missionId: 'm',
    });
    assert.equal('workItemId' in state, false);
    assert.equal('attemptId' in state, false);
  });
});

describe('buildDecisionState 边界：拒绝非 string fact / 额外 payload', () => {
  test('fact value 非 string 时抛错，不悄悄吸收', () => {
    assert.throws(
      () =>
        buildDecisionState({
          hook: 'PRE_DISPATCH',
          projectId: 'p',
          missionId: 'm',
          // @ts-expect-error 故意非 string
          facts: [{ key: 'k', value: 1 }],
        }),
      /facts\[0\]\.value must be a string/,
    );
  });

  test('fact key 非 string 时抛错', () => {
    assert.throws(
      () =>
        buildDecisionState({
          hook: 'PRE_DISPATCH',
          projectId: 'p',
          missionId: 'm',
          // @ts-expect-error 故意非 string
          facts: [{ key: 1, value: 'v' }],
        }),
      /facts\[0\]\.key must be a string/,
    );
  });

  test('fact 上的额外字段不被吸收', () => {
    assert.throws(
      () =>
        buildDecisionState({
          hook: 'PRE_DISPATCH',
          projectId: 'p',
          missionId: 'm',
          facts: [{ key: 'k', value: 'v', nested: 'x' } as { key: string; value: string }],
        }),
      /unknown field "nested"/,
    );
  });

  test('输入上的 entity / unknown 字段不被吸收', () => {
    assert.throws(
      () =>
        buildDecisionState({
          hook: 'PRE_DISPATCH',
          projectId: 'p',
          missionId: 'm',
          mission: { id: 'm', title: 'nope' },
        } as Parameters<typeof buildDecisionState>[0]),
      /unknown or entity payload key "mission"/,
    );
    assert.throws(
      () =>
        buildDecisionState({
          hook: 'PRE_DISPATCH',
          projectId: 'p',
          missionId: 'm',
          workItem: { id: 'w' },
        } as Parameters<typeof buildDecisionState>[0]),
      /unknown or entity payload key "workItem"/,
    );
    assert.throws(
      () =>
        buildDecisionState({
          hook: 'PRE_DISPATCH',
          projectId: 'p',
          missionId: 'm',
          attempt: { id: 'a' },
        } as Parameters<typeof buildDecisionState>[0]),
      /unknown or entity payload key "attempt"/,
    );
  });

  test('facts 非数组时抛错', () => {
    assert.throws(
      () =>
        buildDecisionState({
          hook: 'PRE_DISPATCH',
          projectId: 'p',
          missionId: 'm',
          // @ts-expect-error 故意非数组
          facts: { key: 'k', value: 'v' },
        }),
      /facts must be an array/,
    );
  });
});

describe('toDecisionRequest', () => {
  test('与 DecisionRequest 一一映射（含空 facts）', () => {
    const state = buildDecisionState({
      hook: 'PRE_DISPATCH',
      projectId: 'p-1',
      missionId: 'm-1',
    });
    const request: DecisionRequest = toDecisionRequest(state);
    assert.deepEqual(request, {
      hook: 'PRE_DISPATCH',
      projectId: 'p-1',
      missionId: 'm-1',
      facts: EMPTY_DECISION_STATE_FACTS,
    });
    assert.equal('schemaVersion' in request, false);
  });

  test('带可选 ids 与 facts 的完整映射', () => {
    const facts = [
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
    ];
    const state = buildDecisionState({
      hook: 'POST_EXECUTION',
      projectId: 'p-2',
      missionId: 'm-2',
      workItemId: 'w-2',
      attemptId: 'a-2',
      facts,
    });
    const request = toDecisionRequest(state);
    assert.deepEqual(request, {
      hook: 'POST_EXECUTION',
      projectId: 'p-2',
      missionId: 'm-2',
      workItemId: 'w-2',
      attemptId: 'a-2',
      facts,
    });
  });

  test('映射结果可直接作为 DecisionRequest 使用（形状兼容）', () => {
    const request = toDecisionRequest(
      buildDecisionState({
        hook: 'PRE_DISPATCH',
        projectId: 'p',
        missionId: 'm',
        facts: [{ key: 'x', value: 'y' }],
      }),
    );
    // 仅验证端口形状字段齐全；不调用任何生产 provider。
    assert.equal(request.hook, 'PRE_DISPATCH');
    assert.equal(request.projectId, 'p');
    assert.equal(request.missionId, 'm');
    assert.deepEqual(request.facts, [{ key: 'x', value: 'y' }]);
  });
});

describe('HOPT-03-B Decision/StateBuilder 离线边界守卫', () => {
  test('kernel 不出现 StateBuilder / Decision / Jev / PRE_DISPATCH / POST_EXECUTION', () => {
    const kernelDir = join(root, 'src', 'kernel');
    const banned = [
      /StateBuilder/,
      /buildDecisionState/,
      /toDecisionRequest/,
      /DecisionState/,
      /DecisionProvider/,
      /DecisionRequest/,
      /DecisionSignal/,
      /DecisionHook/,
      /DecisionRecord/,
      /\bJev\b/,
      /PRE_DISPATCH/,
      /POST_EXECUTION/,
    ];
    for (const file of walkTs(kernelDir)) {
      const source = readFileSync(file, 'utf8');
      const rel = relPosix(file);
      for (const re of banned) {
        assert.doesNotMatch(source, re, `${rel}: 出现 ${re}`);
      }
    }
  });

  test('StateBuilder 模块不 import kernel Mission/WorkItem/Attempt 实体', () => {
    const builderPath = join(root, 'src', 'application', 'decision-state-builder.ts');
    const source = readFileSync(builderPath, 'utf8');

    // 仅允许 ports 类型依赖；禁止任何 kernel / 实体模块 import。
    const fromSpecs = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    assert.deepEqual(fromSpecs, ['./ports.ts']);
    for (const spec of fromSpecs) {
      assert.doesNotMatch(spec, /kernel/i, `import "${spec}" 不得指向 kernel`);
      assert.doesNotMatch(
        spec,
        /(mission|work-item|attempt)\.ts$/i,
        `import "${spec}" 不得拉 kernel 实体`,
      );
    }

    // import 子句本身不得点名实体类型（注释可提及「不接收实体」）。
    const importClauses = [...source.matchAll(/^\s*import\b[^;]*;/gm)].map((m) => m[0]!);
    for (const clause of importClauses) {
      assert.doesNotMatch(clause, /\bMission\b/);
      assert.doesNotMatch(clause, /\bWorkItem\b/);
      assert.doesNotMatch(clause, /\bAttempt\b/);
    }
  });

  test('生产路径除 ports/Noop/StateBuilder 外不得出现实际 provider.decide 接线', () => {
    const allowedDecideFiles = new Set([
      'src/application/ports.ts',
      'src/application/noop-decision-provider.ts',
      'src/application/decision-state-builder.ts',
    ]);
    const srcDir = join(root, 'src');
    for (const file of walkTs(srcDir)) {
      const rel = relPosix(file);
      const source = readFileSync(file, 'utf8');

      // 允许端口声明与 Noop 实现；StateBuilder 本身不应调用 decide。
      if (rel === 'src/application/decision-state-builder.ts') {
        assert.doesNotMatch(
          source,
          /\.decide\s*\(/,
          `${rel}: StateBuilder 不得调用 provider.decide`,
        );
        continue;
      }
      if (allowedDecideFiles.has(rel)) continue;

      assert.doesNotMatch(
        source,
        /\.decide\s*\(/,
        `${rel}: 生产路径不得接线 provider.decide`,
      );
      assert.doesNotMatch(
        source,
        /NoopDecisionProvider/,
        `${rel}: 不得提前装配 NoopDecisionProvider`,
      );
      assert.doesNotMatch(
        source,
        /buildDecisionState|toDecisionRequest/,
        `${rel}: 不得提前接线 StateBuilder`,
      );
      assert.doesNotMatch(
        source,
        /DecisionProvider/,
        `${rel}: 不得提前引用 DecisionProvider`,
      );
    }
  });

  test('全 src 不出现 QuestionRegistry 或 DecisionRecord 持久化 API', () => {
    const banned = [/QuestionRegistry/, /DecisionRecord/];
    for (const file of walkTs(join(root, 'src'))) {
      const source = readFileSync(file, 'utf8');
      const rel = relPosix(file);
      for (const re of banned) {
        assert.doesNotMatch(source, re, `${rel}: 出现 ${re}`);
      }
    }
  });
});
