/**
 * DecisionProvider port + Noop：钉 Application 边界，不接生产路径。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NoopDecisionProvider } from '../src/application/noop-decision-provider.ts';
import type {
  DecisionAnswerSet,
  DecisionProvider,
  DecisionRequest,
  DecisionSignal,
} from '../src/application/ports.ts';

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

const baseRequest: DecisionRequest = {
  hook: 'PRE_DISPATCH',
  projectId: 'p-1',
  missionId: 'm-1',
};

describe('NoopDecisionProvider', () => {
  test('kind 固定为 noop', () => {
    const provider = new NoopDecisionProvider();
    assert.equal(provider.kind, 'noop');
  });

  test('任意合法 request 恒返回严格 { answers: {} }', async () => {
    const provider = new NoopDecisionProvider();
    const requests: DecisionRequest[] = [
      baseRequest,
      { ...baseRequest, hook: 'POST_EXECUTION' },
      {
        hook: 'PRE_DISPATCH',
        projectId: 'p-2',
        missionId: 'm-2',
        workItemId: 'w-1',
        attemptId: 'a-1',
        facts: [{ key: 'k', value: 'v' }],
      },
    ];
    for (const request of requests) {
      const result = await provider.decide(request);
      assert.deepEqual(result, { answers: {} });
      assert.equal('meta' in result, false);
      assert.deepEqual(Object.keys(result.answers), []);
    }
  });

  test('连续调用确定性、无状态耦合', async () => {
    const provider = new NoopDecisionProvider();
    const first = await provider.decide(baseRequest);
    const second = await provider.decide({
      ...baseRequest,
      hook: 'POST_EXECUTION',
      facts: [{ key: 'x', value: '1' }],
    });
    assert.deepEqual(first, second);
    assert.deepEqual(first, { answers: {} });
  });
});

describe('DecisionProvider 可替换性', () => {
  test('第二个内联 provider 一次返回多个命名 answers，保持不同 question id', async () => {
    const multiProvider: DecisionProvider = {
      kind: 'inline-multi',
      async decide(request: DecisionRequest): Promise<DecisionAnswerSet> {
        if (request.hook === 'PRE_DISPATCH') {
          const answers: Record<string, DecisionSignal> = {
            task_type: { kind: 'choice', option: 'prefer-a' },
            semantic_risk: { kind: 'score', value: 0.9, scale: 'unit' },
            work_order_ambiguous: { kind: 'score', value: 0.2, scale: 'noul' },
          };
          return { answers };
        }
        return {
          answers: {
            post_check: { kind: 'score', value: 0.5, scale: 'unit' },
          },
        };
      },
    };

    assert.equal(multiProvider.kind, 'inline-multi');
    const pre = await multiProvider.decide(baseRequest);
    assert.deepEqual(pre.answers.task_type, { kind: 'choice', option: 'prefer-a' });
    assert.deepEqual(pre.answers.semantic_risk, {
      kind: 'score',
      value: 0.9,
      scale: 'unit',
    });
    assert.deepEqual(pre.answers.work_order_ambiguous, {
      kind: 'score',
      value: 0.2,
      scale: 'noul',
    });
    assert.deepEqual(Object.keys(pre.answers).sort(), [
      'semantic_risk',
      'task_type',
      'work_order_ambiguous',
    ]);

    assert.deepEqual(
      await multiProvider.decide({ ...baseRequest, hook: 'POST_EXECUTION' }),
      {
        answers: {
          post_check: { kind: 'score', value: 0.5, scale: 'unit' },
        },
      },
    );

    // 与 Noop 共用同一静态类型槽位：数组元素类型即 DecisionProvider。
    const providers: DecisionProvider[] = [new NoopDecisionProvider(), multiProvider];
    const results = await Promise.all(providers.map((p) => p.decide(baseRequest)));
    assert.deepEqual(results[0], { answers: {} });
    assert.equal(results[1]?.answers.task_type?.kind, 'choice');
  });
});

describe('Decision 边界守卫', () => {
  test('kernel 源码不泄漏 DecisionProvider / Jev / PRE_DISPATCH / POST_EXECUTION', () => {
    const kernelDir = join(root, 'src', 'kernel');
    const banned = [
      /DecisionProvider/,
      /DecisionRequest/,
      /DecisionSignal/,
      /DecisionAnswerSet/,
      /DecisionHook/,
      /\bJev\b/,
      /PRE_DISPATCH/,
      /POST_EXECUTION/,
    ];
    for (const file of walkTs(kernelDir)) {
      const source = readFileSync(file, 'utf8');
      const rel = file.slice(root.length).replaceAll('\\', '/').replace(/^\//, '');
      for (const re of banned) {
        assert.doesNotMatch(source, re, `${rel}: 出现 ${re}`);
      }
    }
  });

  test('Runtime 类型段不耦合 Decision', () => {
    const ports = readFileSync(join(root, 'src', 'application', 'ports.ts'), 'utf8');
    const runtimeStart = ports.indexOf('/* ------------------------------ 运行时端口');
    const decisionStart = ports.indexOf('/* ------------------------------ 决策信号端口');
    assert.ok(runtimeStart >= 0, '应有运行时端口分段');
    assert.ok(decisionStart > runtimeStart, '决策端口应独立分段且位于运行时之后');

    const runtimeSection = ports.slice(runtimeStart, decisionStart);
    assert.doesNotMatch(runtimeSection, /\bDecision\w*\b/);
    assert.doesNotMatch(runtimeSection, /PRE_DISPATCH|POST_EXECUTION|\bJev\b/);

    // 运行时接口本身仍可按名定位，且正文不含 Decision。
    for (const name of ['AgentRuntime', 'AgentRunSpec', 'RuntimeEvent', 'RuntimeOutcome']) {
      assert.match(runtimeSection, new RegExp(`\\b${name}\\b`));
    }
  });
});
