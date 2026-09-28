import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMaxRounds } from '../src/application/mission-runner.ts';

describe('parseMaxRounds', () => {
  test('omitted flag leaves the default to the orchestrator', () => {
    assert.equal(parseMaxRounds(undefined, false), undefined);
  });

  for (const [raw, expected] of [['1', 1], ['30', 30], ['100', 100]] as const) {
    test(`accepts ${raw}`, () => {
      assert.equal(parseMaxRounds(raw, true), expected);
    });
  }

  for (const raw of ['0', '-1', '101', 'abc', '3.5', '1e2', undefined, '--other']) {
    test(`rejects ${String(raw)}`, () => {
      assert.throws(
        () => parseMaxRounds(raw, true),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /--max-rounds/);
          assert.match(error.message, /1–100/);
          return true;
        },
      );
    });
  }
});
