/**
 * BUDGET-001-S1/S2: pure authoritative budget snapshot + evaluator +
 * durable orchestration.round.started projection.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUDGET_DIMENSIONS,
  buildBudgetUsageSnapshot,
  countAuthoritativeRounds,
  evaluateExecutionBudget,
  verdictFor,
  type BudgetActivityEventFact,
  type BudgetAttemptFact,
  type BudgetUsageSnapshot,
} from '../src/application/budget-usage.ts';
import type { ExecutionBudget, TokenUsage } from '../src/kernel/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcPath = join(root, 'src', 'application', 'budget-usage.ts');

function reported(over: Partial<TokenUsage> = {}): TokenUsage {
  return {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    total: 15,
    cost: 0.01,
    quality: 'reported',
    ...over,
  };
}

function sampleBudget(over: Partial<ExecutionBudget> = {}): ExecutionBudget {
  return {
    maxAttempts: 3,
    maxRounds: 5,
    maxWallClockMs: 60_000,
    maxInputTokens: 100,
    maxOutputTokens: 50,
    maxTotalTokens: 150,
    maxCost: 1,
    maxChangedFiles: 10,
    maxCommands: 20,
    ...over,
  };
}

function snap(
  attempts: readonly BudgetAttemptFact[],
  over: Partial<BuildOver> = {},
): BudgetUsageSnapshot {
  const input: {
    missionId: string;
    capturedAt: string;
    attempts: readonly BudgetAttemptFact[];
    roundCount?: number;
    changedFiles?: readonly string[];
  } = {
    missionId: over.missionId ?? 'm-1',
    capturedAt: over.capturedAt ?? '2020-01-01T00:00:00.000Z',
    attempts,
  };
  if (over.roundCount !== undefined) {
    input.roundCount = over.roundCount;
  }
  if (over.changedFiles !== undefined) {
    input.changedFiles = over.changedFiles;
  }
  return buildBudgetUsageSnapshot(input);
}

type BuildOver = {
  missionId?: string;
  capturedAt?: string;
  roundCount?: number;
  changedFiles?: readonly string[];
};

function roundStarted(schemaVersion: unknown = 1): BudgetActivityEventFact {
  return { kind: 'orchestration.round.started', data: { schemaVersion } };
}

function attemptStarted(): BudgetActivityEventFact {
  return { kind: 'attempt.started', data: { kind: 'coordinator' } };
}

function attemptEnded(): BudgetActivityEventFact {
  return { kind: 'attempt.ended', data: { endedBy: 'structured_submit' } };
}

describe('buildBudgetUsageSnapshot', () => {
  test('records missionId, capturedAt, exact attemptCount; no invented round/wall/command fields', () => {
    const s = snap([{ kind: 'coordinator', usage: reported() }]);
    assert.equal(s.missionId, 'm-1');
    assert.equal(s.capturedAt, '2020-01-01T00:00:00.000Z');
    assert.equal(s.attemptCount, 1);
    assert.equal('roundCount' in s, false);
    assert.equal('wallClockMs' in s, false);
    assert.equal('commandCount' in s, false);
    assert.equal('changedFileCount' in s, false);
  });

  test('roundCount only when trusted known count supplied (incl. honest 0)', () => {
    const without = snap([{ usage: reported() }]);
    assert.equal('roundCount' in without, false);

    const zero = snap([], { roundCount: 0 });
    assert.equal(zero.roundCount, 0);

    const n = snap([], { roundCount: 3 });
    assert.equal(n.roundCount, 3);
  });

  test('coordinator + executor shapes both count', () => {
    const s = snap([
      { kind: 'coordinator', usage: reported({ input: 1, output: 1, total: 2, cost: 0.125 }) },
      { kind: 'executor', usage: reported({ input: 3, output: 4, total: 7, cost: 0.25 }) },
      { kind: 'executor', usage: reported({ input: 5, output: 6, total: 11, cost: 0.5 }) },
    ]);
    assert.equal(s.attemptCount, 3);
    assert.deepEqual(s.tokenAggregate, {
      inputTokens: 9,
      outputTokens: 11,
      totalTokens: 20,
    });
    assert.equal(s.costAggregate, 0.875);
  });

  test('all-reported token aggregation', () => {
    const s = snap([
      { usage: reported({ input: 10, output: 20, total: 30, cost: 1 }) },
      { usage: reported({ input: 1, output: 2, total: 3, cost: 0.5 }) },
    ]);
    assert.deepEqual(s.tokenAggregate, {
      inputTokens: 11,
      outputTokens: 22,
      totalTokens: 33,
    });
  });

  test('empty attempts: vacuous aggregates are zero, not omitted as unknown', () => {
    const s = snap([]);
    assert.equal(s.attemptCount, 0);
    assert.deepEqual(s.tokenAggregate, {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    assert.equal(s.costAggregate, 0);
  });

  test('one estimated usage => no tokenAggregate (never fake 0)', () => {
    const s = snap([
      { usage: reported() },
      { usage: reported({ quality: 'estimated' }) },
    ]);
    assert.equal(s.attemptCount, 2);
    assert.equal('tokenAggregate' in s, false);
    assert.equal('costAggregate' in s, false);
  });

  test('one unknown usage => no tokenAggregate', () => {
    const s = snap([
      { usage: reported() },
      { usage: reported({ quality: 'unknown' }) },
    ]);
    assert.equal('tokenAggregate' in s, false);
  });

  test('malformed usage (negative / non-finite / missing fields) => no tokenAggregate', () => {
    const cases: unknown[] = [
      undefined,
      null,
      { quality: 'reported', input: -1, output: 1, cacheRead: 0, cacheWrite: 0, total: 0 },
      { quality: 'reported', input: 1, output: NaN, cacheRead: 0, cacheWrite: 0, total: 1 },
      { quality: 'reported', input: 1, output: 1, cacheRead: Infinity, cacheWrite: 0, total: 2 },
      { quality: 'reported', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, // missing total
      { quality: 'reported', input: '1', output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      'not-an-object',
    ];
    for (const usage of cases) {
      const s = snap([{ usage }, { usage: reported() }]);
      assert.equal('tokenAggregate' in s, false, `usage=${JSON.stringify(usage)}`);
    }
  });

  test('missing cost on one reported attempt => cost unknown; tokens still aggregate', () => {
    const withCost = reported({ cost: 0.5 });
    const noCost: TokenUsage = {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
      quality: 'reported',
    };
    const s = snap([{ usage: withCost }, { usage: noCost }]);
    assert.deepEqual(s.tokenAggregate, {
      inputTokens: 11,
      outputTokens: 6,
      totalTokens: 17,
    });
    assert.equal('costAggregate' in s, false);
  });

  test('non-finite or negative cost => cost unknown', () => {
    for (const cost of [NaN, Infinity, -0.01] as const) {
      const s = snap([{ usage: reported({ cost }) }]);
      assert.ok(s.tokenAggregate);
      assert.equal('costAggregate' in s, false, `cost=${cost}`);
    }
  });

  test('all finite costs => costAggregate sum', () => {
    const s = snap([
      { usage: reported({ cost: 0.25 }) },
      { usage: reported({ cost: 0.75 }) },
    ]);
    assert.equal(s.costAggregate, 1);
  });

  test('changedFileCount only when trusted changedFiles provided (incl. empty)', () => {
    const without = snap([{ usage: reported() }]);
    assert.equal('changedFileCount' in without, false);

    const empty = snap([], { changedFiles: [] });
    assert.equal(empty.changedFileCount, 0);

    const files = snap([], { changedFiles: ['a.ts', 'b.ts', 'c.ts'] });
    assert.equal(files.changedFileCount, 3);
  });

  test('input arrays are not mutated', () => {
    const attempts: BudgetAttemptFact[] = [
      { kind: 'executor', usage: reported() },
      { kind: 'coordinator', usage: reported({ input: 2, output: 2, total: 4, cost: 0.02 }) },
    ];
    const files = ['x.ts', 'y.ts'];
    const attemptsCopy = attempts.map((a) => ({ ...a, usage: { ...(a.usage as object) } }));
    const filesBefore = [...files];

    const s = buildBudgetUsageSnapshot({
      missionId: 'm',
      capturedAt: 't',
      attempts,
      changedFiles: files,
    });

    assert.equal(s.attemptCount, 2);
    assert.equal(s.changedFileCount, 2);
    assert.equal(attempts.length, 2);
    assert.deepEqual(files, filesBefore);
    // identity of attempt entries preserved
    assert.equal(attempts[0], attempts[0]);
    assert.deepEqual(
      attempts.map((a) => a.usage),
      attemptsCopy.map((a) => a.usage),
    );
  });
});

describe('evaluateExecutionBudget', () => {
  test('no budget => every dimension not_in_force; anyAuthoritativeExceeded=false', () => {
    const s = snap([
      { usage: reported({ input: 999, output: 999, total: 1998, cost: 99 }) },
    ], { changedFiles: ['a', 'b', 'c'] });
    const ev = evaluateExecutionBudget(undefined, s);
    assert.equal(ev.dimensions.length, BUDGET_DIMENSIONS.length);
    for (const dim of BUDGET_DIMENSIONS) {
      const v = verdictFor(ev, dim);
      assert.equal(v.status, 'not_in_force', dim);
      assert.equal('limit' in v, false, dim);
      assert.equal('used' in v, false, dim);
    }
    assert.equal(ev.anyAuthoritativeExceeded, false);
  });

  test('zero required limits: attempts 0 is exceeded (at-limit exhausted); attempts >0 exceeded', () => {
    const zeroRequired: ExecutionBudget = {
      maxAttempts: 0,
      maxRounds: 0,
      maxWallClockMs: 0,
    };

    const zeroAttempts = evaluateExecutionBudget(zeroRequired, snap([]));
    assert.equal(verdictFor(zeroAttempts, 'attempts').status, 'exceeded');
    assert.equal(verdictFor(zeroAttempts, 'attempts').used, 0);
    assert.equal(verdictFor(zeroAttempts, 'attempts').limit, 0);
    assert.equal(zeroAttempts.anyAuthoritativeExceeded, true);

    const someAttempts = evaluateExecutionBudget(
      zeroRequired,
      snap([{ usage: reported() }, { usage: reported() }]),
    );
    assert.equal(verdictFor(someAttempts, 'attempts').status, 'exceeded');
    assert.equal(verdictFor(someAttempts, 'attempts').used, 2);
    assert.equal(someAttempts.anyAuthoritativeExceeded, true);

    // rounds/wall still unknown even at zero limit when roundCount absent
    assert.equal(verdictFor(zeroAttempts, 'rounds').status, 'unknown');
    assert.equal(verdictFor(zeroAttempts, 'rounds').limit, 0);
    assert.equal(verdictFor(zeroAttempts, 'wallClockMs').status, 'unknown');
    assert.equal(verdictFor(zeroAttempts, 'wallClockMs').limit, 0);
  });

  test('attempts ok when used < limit; exceeded when used >= limit', () => {
    const budget: ExecutionBudget = { maxAttempts: 2, maxRounds: 1, maxWallClockMs: 1 };
    const under = evaluateExecutionBudget(budget, snap([{ usage: reported() }]));
    assert.equal(verdictFor(under, 'attempts').status, 'ok');
    assert.equal(verdictFor(under, 'attempts').used, 1);
    assert.equal(under.anyAuthoritativeExceeded, false);

    const at = evaluateExecutionBudget(
      budget,
      snap([{ usage: reported() }, { usage: reported() }]),
    );
    assert.equal(verdictFor(at, 'attempts').status, 'exceeded');
    assert.equal(at.anyAuthoritativeExceeded, true);

    const over = evaluateExecutionBudget(
      budget,
      snap([{ usage: reported() }, { usage: reported() }, { usage: reported() }]),
    );
    assert.equal(verdictFor(over, 'attempts').status, 'exceeded');
    assert.equal(verdictFor(over, 'attempts').used, 3);
  });

  test('all-reported tokens: ok and exceeded per dimension; zero token limits valid', () => {
    const budget = sampleBudget({
      maxInputTokens: 100,
      maxOutputTokens: 50,
      maxTotalTokens: 150,
      maxCost: undefined,
      maxChangedFiles: undefined,
      maxCommands: undefined,
    });
    const okSnap = snap([
      { usage: reported({ input: 40, output: 10, total: 50, cost: 0.1 }) },
      { usage: reported({ input: 40, output: 10, total: 50, cost: 0.1 }) },
    ]);
    const ok = evaluateExecutionBudget(budget, okSnap);
    assert.equal(verdictFor(ok, 'inputTokens').status, 'ok');
    assert.equal(verdictFor(ok, 'inputTokens').used, 80);
    assert.equal(verdictFor(ok, 'outputTokens').status, 'ok');
    assert.equal(verdictFor(ok, 'totalTokens').status, 'ok');
    assert.equal(ok.anyAuthoritativeExceeded, false);

    const exceeded = evaluateExecutionBudget(
      budget,
      snap([{ usage: reported({ input: 100, output: 50, total: 150, cost: 0 }) }]),
    );
    assert.equal(verdictFor(exceeded, 'inputTokens').status, 'exceeded');
    assert.equal(verdictFor(exceeded, 'outputTokens').status, 'exceeded');
    assert.equal(verdictFor(exceeded, 'totalTokens').status, 'exceeded');
    assert.equal(exceeded.anyAuthoritativeExceeded, true);

    const zeroTok: ExecutionBudget = {
      maxAttempts: 10,
      maxRounds: 1,
      maxWallClockMs: 1,
      maxInputTokens: 0,
      maxOutputTokens: 0,
      maxTotalTokens: 0,
    };
    const zeroEval = evaluateExecutionBudget(zeroTok, snap([]));
    assert.equal(verdictFor(zeroEval, 'inputTokens').status, 'exceeded');
    assert.equal(verdictFor(zeroEval, 'inputTokens').used, 0);
    assert.equal(zeroEval.anyAuthoritativeExceeded, true);
  });

  test('estimated/unknown/malformed => token dimensions unknown when limits in force', () => {
    const budget = sampleBudget({
      maxCost: undefined,
      maxChangedFiles: undefined,
      maxCommands: undefined,
    });
    for (const bad of [
      reported({ quality: 'estimated' }),
      reported({ quality: 'unknown' }),
      {
        quality: 'reported',
        input: -1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    ]) {
      const ev = evaluateExecutionBudget(budget, snap([{ usage: bad }, { usage: reported() }]));
      assert.equal(verdictFor(ev, 'inputTokens').status, 'unknown');
      assert.equal(verdictFor(ev, 'outputTokens').status, 'unknown');
      assert.equal(verdictFor(ev, 'totalTokens').status, 'unknown');
      assert.equal(verdictFor(ev, 'inputTokens').limit, 100);
      assert.equal('used' in verdictFor(ev, 'inputTokens'), false);
      // attempts still authoritative
      assert.equal(verdictFor(ev, 'attempts').status, 'ok');
      assert.equal(ev.anyAuthoritativeExceeded, false);
    }
  });

  test('missing optional token limits => not_in_force even with aggregate', () => {
    const budget: ExecutionBudget = {
      maxAttempts: 5,
      maxRounds: 1,
      maxWallClockMs: 1,
    };
    const ev = evaluateExecutionBudget(
      budget,
      snap([{ usage: reported({ input: 999, output: 999, total: 1998, cost: 50 }) }]),
    );
    assert.equal(verdictFor(ev, 'inputTokens').status, 'not_in_force');
    assert.equal(verdictFor(ev, 'outputTokens').status, 'not_in_force');
    assert.equal(verdictFor(ev, 'totalTokens').status, 'not_in_force');
    assert.equal(verdictFor(ev, 'cost').status, 'not_in_force');
    assert.equal(verdictFor(ev, 'changedFiles').status, 'not_in_force');
    assert.equal(verdictFor(ev, 'commands').status, 'not_in_force');
  });

  test('cost: all finite => ok/exceeded; missing cost => unknown; unknown does not trip anyAuthoritativeExceeded', () => {
    const budget: ExecutionBudget = {
      maxAttempts: 10,
      maxRounds: 1,
      maxWallClockMs: 1,
      maxCost: 1,
    };
    const ok = evaluateExecutionBudget(
      budget,
      snap([{ usage: reported({ cost: 0.25 }) }, { usage: reported({ cost: 0.5 }) }]),
    );
    assert.equal(verdictFor(ok, 'cost').status, 'ok');
    assert.equal(verdictFor(ok, 'cost').used, 0.75);
    assert.equal(ok.anyAuthoritativeExceeded, false);

    const exceeded = evaluateExecutionBudget(
      budget,
      snap([{ usage: reported({ cost: 1 }) }]),
    );
    assert.equal(verdictFor(exceeded, 'cost').status, 'exceeded');
    assert.equal(exceeded.anyAuthoritativeExceeded, true);

    const noCost: TokenUsage = {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
      quality: 'reported',
    };
    const unknown = evaluateExecutionBudget(budget, snap([{ usage: noCost }]));
    assert.equal(verdictFor(unknown, 'cost').status, 'unknown');
    assert.equal(verdictFor(unknown, 'cost').limit, 1);
    assert.equal(unknown.anyAuthoritativeExceeded, false);
  });

  test('changedFiles limit with/without trusted files', () => {
    const budget: ExecutionBudget = {
      maxAttempts: 10,
      maxRounds: 1,
      maxWallClockMs: 1,
      maxChangedFiles: 2,
    };
    const noFiles = evaluateExecutionBudget(budget, snap([]));
    assert.equal(verdictFor(noFiles, 'changedFiles').status, 'unknown');
    assert.equal(verdictFor(noFiles, 'changedFiles').limit, 2);

    const under = evaluateExecutionBudget(budget, snap([], { changedFiles: ['a.ts'] }));
    assert.equal(verdictFor(under, 'changedFiles').status, 'ok');
    assert.equal(verdictFor(under, 'changedFiles').used, 1);

    const at = evaluateExecutionBudget(budget, snap([], { changedFiles: ['a', 'b'] }));
    assert.equal(verdictFor(at, 'changedFiles').status, 'exceeded');
    assert.equal(at.anyAuthoritativeExceeded, true);

    const zeroFilesBudget: ExecutionBudget = {
      maxAttempts: 10,
      maxRounds: 1,
      maxWallClockMs: 1,
      maxChangedFiles: 0,
    };
    const emptyTrusted = evaluateExecutionBudget(
      zeroFilesBudget,
      snap([], { changedFiles: [] }),
    );
    assert.equal(verdictFor(emptyTrusted, 'changedFiles').status, 'exceeded');
    assert.equal(verdictFor(emptyTrusted, 'changedFiles').used, 0);
  });

  test('rounds unknown without roundCount; wallClockMs / commands still unknown', () => {
    const budget = sampleBudget();
    const ev = evaluateExecutionBudget(
      budget,
      snap([{ usage: reported() }], { changedFiles: ['a.ts'] }),
    );
    assert.equal(verdictFor(ev, 'rounds').status, 'unknown');
    assert.equal(verdictFor(ev, 'rounds').limit, 5);
    assert.equal('used' in verdictFor(ev, 'rounds'), false);

    assert.equal(verdictFor(ev, 'wallClockMs').status, 'unknown');
    assert.equal(verdictFor(ev, 'wallClockMs').limit, 60_000);

    assert.equal(verdictFor(ev, 'commands').status, 'unknown');
    assert.equal(verdictFor(ev, 'commands').limit, 20);

    // snapshot itself must not invent those usage fields
    const s = snap([{ usage: reported() }]);
    assert.equal('roundCount' in s, false);
    assert.equal('wallClockMs' in s, false);
    assert.equal('commandCount' in s, false);
  });

  test('rounds ok/exceeded when snapshot.roundCount present (used >= limit => exceeded)', () => {
    const budget: ExecutionBudget = { maxAttempts: 10, maxRounds: 2, maxWallClockMs: 1 };

    const under = evaluateExecutionBudget(budget, snap([], { roundCount: 1 }));
    assert.equal(verdictFor(under, 'rounds').status, 'ok');
    assert.equal(verdictFor(under, 'rounds').used, 1);
    assert.equal(verdictFor(under, 'rounds').limit, 2);
    assert.equal(under.anyAuthoritativeExceeded, false);

    const at = evaluateExecutionBudget(budget, snap([], { roundCount: 2 }));
    assert.equal(verdictFor(at, 'rounds').status, 'exceeded');
    assert.equal(verdictFor(at, 'rounds').used, 2);
    assert.equal(at.anyAuthoritativeExceeded, true);

    const over = evaluateExecutionBudget(budget, snap([], { roundCount: 5 }));
    assert.equal(verdictFor(over, 'rounds').status, 'exceeded');
    assert.equal(verdictFor(over, 'rounds').used, 5);

    const zeroLimit = evaluateExecutionBudget(
      { maxAttempts: 10, maxRounds: 0, maxWallClockMs: 1 },
      snap([], { roundCount: 0 }),
    );
    assert.equal(verdictFor(zeroLimit, 'rounds').status, 'exceeded');
    assert.equal(verdictFor(zeroLimit, 'rounds').used, 0);
  });

  test('unknown never contributes to anyAuthoritativeExceeded alone', () => {
    const budget = sampleBudget({
      maxAttempts: 100,
      maxInputTokens: 1,
      maxOutputTokens: 1,
      maxTotalTokens: 1,
      maxCost: 0.001,
      maxChangedFiles: 0,
      maxCommands: 0,
    });
    // no trusted tokens/cost/files — all those unknown; attempts ok
    const ev = evaluateExecutionBudget(budget, snap([{ usage: reported({ quality: 'estimated' }) }]));
    assert.equal(verdictFor(ev, 'attempts').status, 'ok');
    assert.equal(verdictFor(ev, 'inputTokens').status, 'unknown');
    assert.equal(verdictFor(ev, 'cost').status, 'unknown');
    assert.equal(verdictFor(ev, 'changedFiles').status, 'unknown');
    assert.equal(verdictFor(ev, 'commands').status, 'unknown');
    assert.equal(verdictFor(ev, 'rounds').status, 'unknown');
    assert.equal(ev.anyAuthoritativeExceeded, false);
  });
});

describe('countAuthoritativeRounds', () => {
  test('trusted event counting: only schemaVersion===1 round.started', () => {
    const events: BudgetActivityEventFact[] = [
      { kind: 'mission.created', data: {} },
      roundStarted(1),
      { kind: 'orchestration.round.started', data: { schemaVersion: 2 } },
      { kind: 'orchestration.round.started', data: {} },
      { kind: 'orchestration.round.started', data: null },
      { kind: 'work_item.created', data: {} },
      roundStarted(1),
      attemptStarted(),
      attemptEnded(),
    ];
    assert.deepEqual(countAuthoritativeRounds(events), { status: 'known', count: 2 });
  });

  test('honest zero when no round-start and no attempt trace', () => {
    assert.deepEqual(countAuthoritativeRounds([]), { status: 'known', count: 0 });
    assert.deepEqual(
      countAuthoritativeRounds([
        { kind: 'mission.created', data: {} },
        { kind: 'plan.updated', data: {} },
      ]),
      { status: 'known', count: 0 },
    );
  });

  test('legacy unknown: attempt.started/ended without any authoritative round-start', () => {
    assert.deepEqual(
      countAuthoritativeRounds([attemptStarted(), attemptEnded()]),
      { status: 'unknown' },
    );
    assert.deepEqual(
      countAuthoritativeRounds([
        { kind: 'mission.created', data: {} },
        attemptEnded(),
      ]),
      { status: 'unknown' },
    );
  });

  test('mixed-history unknown: attempt trace before first authoritative round-start', () => {
    assert.deepEqual(
      countAuthoritativeRounds([attemptStarted(), roundStarted(1), roundStarted(1)]),
      { status: 'unknown' },
    );
    assert.deepEqual(
      countAuthoritativeRounds([
        { kind: 'mission.created', data: {} },
        attemptEnded(),
        roundStarted(1),
      ]),
      { status: 'unknown' },
    );
  });

  test('known count when attempts only after first authoritative round-start', () => {
    assert.deepEqual(
      countAuthoritativeRounds([
        roundStarted(1),
        attemptStarted(),
        attemptEnded(),
        roundStarted(1),
        attemptStarted(),
      ]),
      { status: 'known', count: 2 },
    );
  });

  test('never infers rounds from work-item events, maxRounds, or attempt count alone', () => {
    const noisy: BudgetActivityEventFact[] = [
      { kind: 'work_item.created', data: { title: 'x' } },
      { kind: 'work_item.dispatched', data: { ids: ['W1'] } },
      { kind: 'mission.waiting', data: { reason: 'no_available_agent' } },
    ];
    assert.deepEqual(countAuthoritativeRounds(noisy), { status: 'known', count: 0 });
    // attempt-only still unknown — not inferred as round count === attempt count
    assert.equal(countAuthoritativeRounds([attemptStarted(), attemptStarted()]).status, 'unknown');
  });
});

describe('budget-usage source boundaries', () => {
  test('does not import orchestrator / platform / promotion / wait-reason policy numbers', () => {
    const body = readFileSync(srcPath, 'utf8');
    assert.doesNotMatch(body, /from ['\"][^'\"]*orchestrator/i);
    assert.doesNotMatch(body, /from ['\"][^'\"]*platform/);
    assert.doesNotMatch(body, /RolePool|sumUsage|toolActivity|BudgetPolicy|budget_exceeded/);
    assert.doesNotMatch(body, /WaitReason/);
    assert.doesNotMatch(body, /\bPromotionRecord\b|\bpromoteMission\b/);
  });
});
