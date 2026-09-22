import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { RunTokenRegistry } from '../src/api/run-tokens.ts';

describe('Run Token 生命周期', () => {
  test('revokeAttempt 吊销该 Attempt 的全部 token，不误伤别的 Attempt', () => {
    const tokens = new RunTokenRegistry();
    const first = tokens.issue({ missionId: 'M1', attemptId: 'A1', role: 'coordinator' });
    const duplicate = tokens.issue({ missionId: 'M1', attemptId: 'A1', role: 'coordinator' });
    const other = tokens.issue({ missionId: 'M1', attemptId: 'A2', role: 'executor', workItemId: 'W1' });
    const sameAttemptOtherMission = tokens.issue({ missionId: 'M2', attemptId: 'A1', role: 'coordinator' });

    tokens.revokeAttempt('M1', 'A1');

    assert.equal(tokens.resolve(first.token), undefined);
    assert.equal(tokens.resolve(duplicate.token), undefined);
    assert.equal(tokens.resolve(other.token)?.attemptId, 'A2');
    assert.equal(tokens.resolve(sameAttemptOtherMission.token)?.missionId, 'M2');
  });

  test('单 token revoke 语义保持不变', () => {
    const tokens = new RunTokenRegistry();
    const run = tokens.issue({ missionId: 'M1', attemptId: 'A1', role: 'coordinator' });
    tokens.revoke(run.token);
    assert.equal(tokens.resolve(run.token), undefined);
  });
});