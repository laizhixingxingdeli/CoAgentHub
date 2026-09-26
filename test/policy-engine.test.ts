/**
 * PolicyEngine 矩阵：六类 Principal × 六类动作范围。
 * 只断言稳定理由码；不读时钟、不碰存储。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePolicy,
  POLICY_ACTION,
  POLICY_REASON,
  principalFromControl,
  principalFromRun,
  type PolicyAction,
  type PolicyPrincipal,
} from '../src/application/policy-engine.ts';

const MISSION = 'M-1';
const ATTEMPT = 'A-1';
const WORK = 'W-1';

const operator: PolicyPrincipal = {
  status: 'ok',
  kind: 'user',
  id: 'op-1',
  role: 'operator',
};
const viewer: PolicyPrincipal = {
  status: 'ok',
  kind: 'user',
  id: 'vw-1',
  role: 'viewer',
};
const reviewer: PolicyPrincipal = { status: 'ok', kind: 'reviewer', id: 'rv-1' };
const runner: PolicyPrincipal = { status: 'ok', kind: 'runner', id: 'platform' };
const coordinator: PolicyPrincipal = {
  status: 'ok',
  kind: 'coordinator',
  id: ATTEMPT,
  missionId: MISSION,
  attemptId: ATTEMPT,
};
const executor: PolicyPrincipal = {
  status: 'ok',
  kind: 'executor',
  id: ATTEMPT,
  missionId: MISSION,
  attemptId: ATTEMPT,
  workItemId: WORK,
};
const independentReviewer: PolicyPrincipal = {
  status: 'ok',
  kind: 'independent_reviewer',
  id: ATTEMPT,
  missionId: MISSION,
  attemptId: ATTEMPT,
};

const bound = { missionId: MISSION, attemptId: ATTEMPT, workItemId: WORK };

function code(
  principal: PolicyPrincipal,
  action: PolicyAction,
  extra?: { context?: typeof bound; state?: Parameters<typeof evaluatePolicy>[0]['state'] },
): string {
  return evaluatePolicy({
    principal,
    action,
    context: extra?.context ?? (needsBind(principal) ? bound : undefined),
    state: extra?.state,
  }).reason.code;
}

function decision(
  principal: PolicyPrincipal,
  action: PolicyAction,
  extra?: { context?: typeof bound; state?: Parameters<typeof evaluatePolicy>[0]['state'] },
): 'allow' | 'deny' {
  return evaluatePolicy({
    principal,
    action,
    context: extra?.context ?? (needsBind(principal) ? bound : undefined),
    state: extra?.state,
  }).decision;
}

function needsBind(principal: PolicyPrincipal): boolean {
  return (
    principal.status === 'ok' &&
    (principal.kind === 'coordinator' ||
      principal.kind === 'executor' ||
      principal.kind === 'independent_reviewer')
  );
}

describe('PolicyEngine 允许矩阵', () => {
  test('user/operator 允许控制面写与敏感读，含 Finalize human', () => {
    const allowed: PolicyAction[] = [
      POLICY_ACTION.missionRead,
      POLICY_ACTION.missionCreate,
      POLICY_ACTION.missionCreateClassified,
      POLICY_ACTION.missionRevise,
      POLICY_ACTION.missionPause,
      POLICY_ACTION.missionResume,
      POLICY_ACTION.missionCancel,
      POLICY_ACTION.missionAnswerEscalation,
      POLICY_ACTION.attemptStartCoordinator,
      POLICY_ACTION.attemptStartExecutor,
      POLICY_ACTION.attemptStartIndependentReviewer,
      POLICY_ACTION.attemptFinish,
      POLICY_ACTION.attemptGetDetail,
      POLICY_ACTION.poolList,
      POLICY_ACTION.poolAdd,
      POLICY_ACTION.inboxRead,
      POLICY_ACTION.inboxAck,
      POLICY_ACTION.finalizeHuman,
    ];
    for (const action of allowed) {
      assert.equal(decision(operator, action), 'allow', `${action.scope}.${action.name}`);
      assert.equal(code(operator, action), POLICY_REASON.ALLOWED);
    }
  });

  test('user/viewer 只允许敏感读', () => {
    for (const action of [
      POLICY_ACTION.missionRead,
      POLICY_ACTION.attemptGetDetail,
      POLICY_ACTION.poolList,
      POLICY_ACTION.inboxRead,
    ]) {
      assert.equal(decision(viewer, action), 'allow', `${action.scope}.${action.name}`);
    }
  });

  test('reviewer 只允许 Finalize reviewer', () => {
    assert.equal(decision(reviewer, POLICY_ACTION.finalizeReviewer), 'allow');
    assert.equal(code(reviewer, POLICY_ACTION.finalizeReviewer), POLICY_REASON.ALLOWED);
  });

  test('runner 允许 Finalize machine / plan（非 HA）', () => {
    assert.equal(decision(runner, POLICY_ACTION.finalizeMachine), 'allow');
    assert.equal(decision(runner, POLICY_ACTION.finalizePlan), 'allow');
  });

  test('coordinator 允许自己 Mission 上的规划与派发', () => {
    for (const action of [
      POLICY_ACTION.missionRead,
      POLICY_ACTION.workItemCreate,
      POLICY_ACTION.workItemRetire,
      POLICY_ACTION.workItemDispatch,
      POLICY_ACTION.workItemReview,
      POLICY_ACTION.attemptGetBrief,
      POLICY_ACTION.attemptUpdateFindings,
      POLICY_ACTION.attemptUpdatePlan,
      POLICY_ACTION.attemptEscalate,
      POLICY_ACTION.attemptSubmitMissionResult,
      POLICY_ACTION.attemptGetContext,
    ]) {
      assert.equal(decision(coordinator, action), 'allow', `${action.scope}.${action.name}`);
    }
  });

  test('independent_reviewer 只允许读证据包与交检视结论', () => {
    assert.equal(decision(independentReviewer, POLICY_ACTION.attemptGetReviewBundle), 'allow');
    assert.equal(decision(independentReviewer, POLICY_ACTION.attemptSubmitIndependentReview), 'allow');
    assert.equal(code(independentReviewer, POLICY_ACTION.missionRead), POLICY_REASON.ACTION_DENIED);
    assert.equal(code(independentReviewer, POLICY_ACTION.finalizeReviewer), POLICY_REASON.ACTION_DENIED);
    assert.equal(code(independentReviewer, POLICY_ACTION.finalizeHuman), POLICY_REASON.ACTION_DENIED);
    assert.equal(code(independentReviewer, POLICY_ACTION.attemptUpdatePlan), POLICY_REASON.ACTION_DENIED);
    assert.equal(code(independentReviewer, POLICY_ACTION.workItemGetOrder), POLICY_REASON.ACTION_DENIED);
  });

  test('executor 允许自己 WorkItem 上的执行提交', () => {
    for (const action of [
      POLICY_ACTION.missionRead,
      POLICY_ACTION.workItemGetOrder,
      POLICY_ACTION.attemptGetBrief,
      POLICY_ACTION.attemptGetContext,
      POLICY_ACTION.attemptSubmitEvidence,
      POLICY_ACTION.attemptSubmitExecutionResult,
      POLICY_ACTION.attemptReportBlocked,
    ]) {
      assert.equal(decision(executor, action), 'allow', `${action.scope}.${action.name}`);
    }
  });
});

describe('PolicyEngine 错误角色', () => {
  test('viewer 写控制面 → ACTION_DENIED', () => {
    for (const action of [
      POLICY_ACTION.missionCreate,
      POLICY_ACTION.missionRevise,
      POLICY_ACTION.missionPause,
      POLICY_ACTION.poolAdd,
      POLICY_ACTION.inboxAck,
      POLICY_ACTION.finalizeHuman,
      POLICY_ACTION.attemptStartCoordinator,
    ]) {
      assert.equal(code(viewer, action), POLICY_REASON.ACTION_DENIED, `${action.scope}.${action.name}`);
    }
  });

  test('executor 动别人的 WorkItem → BINDING_MISMATCH', () => {
    assert.equal(
      code(executor, POLICY_ACTION.workItemGetOrder, {
        context: { missionId: MISSION, attemptId: ATTEMPT, workItemId: 'W-other' },
      }),
      POLICY_REASON.BINDING_MISMATCH,
    );
  });

  test('executor 做协调者动作 → ACTION_DENIED', () => {
    assert.equal(code(executor, POLICY_ACTION.attemptUpdatePlan), POLICY_REASON.ACTION_DENIED);
    assert.equal(code(executor, POLICY_ACTION.workItemCreate), POLICY_REASON.ACTION_DENIED);
    assert.equal(code(executor, POLICY_ACTION.workItemReview), POLICY_REASON.ACTION_DENIED);
  });

  test('coordinator 做 Finalize → ACTION_DENIED', () => {
    assert.equal(code(coordinator, POLICY_ACTION.finalizeHuman), POLICY_REASON.ACTION_DENIED);
    assert.equal(code(coordinator, POLICY_ACTION.finalizeReviewer), POLICY_REASON.ACTION_DENIED);
    assert.equal(code(coordinator, POLICY_ACTION.finalizeMachine), POLICY_REASON.ACTION_DENIED);
  });

  test('reviewer 不能做控制面写或机器终审', () => {
    assert.equal(code(reviewer, POLICY_ACTION.missionCreate), POLICY_REASON.ACTION_DENIED);
    assert.equal(code(reviewer, POLICY_ACTION.finalizeHuman), POLICY_REASON.ACTION_DENIED);
    assert.equal(code(reviewer, POLICY_ACTION.finalizeMachine), POLICY_REASON.ACTION_DENIED);
  });

  test('runner 不能做 human / reviewer 终审', () => {
    assert.equal(code(runner, POLICY_ACTION.finalizeHuman), POLICY_REASON.ACTION_DENIED);
    assert.equal(code(runner, POLICY_ACTION.finalizeReviewer), POLICY_REASON.ACTION_DENIED);
  });
});

describe('PolicyEngine 缺身份与过期身份', () => {
  test('缺身份对六类范围一律 PRINCIPAL_MISSING', () => {
    const missing: PolicyPrincipal = { status: 'missing' };
    const samples: PolicyAction[] = [
      POLICY_ACTION.missionRead,
      POLICY_ACTION.workItemCreate,
      POLICY_ACTION.attemptGetBrief,
      POLICY_ACTION.poolList,
      POLICY_ACTION.inboxRead,
      POLICY_ACTION.finalizeHuman,
    ];
    for (const action of samples) {
      assert.equal(code(missing, action), POLICY_REASON.PRINCIPAL_MISSING);
      assert.equal(decision(missing, action), 'deny');
    }
  });

  test('过期身份对六类范围一律 PRINCIPAL_EXPIRED', () => {
    const expired: PolicyPrincipal = { status: 'expired' };
    const samples: PolicyAction[] = [
      POLICY_ACTION.missionCreate,
      POLICY_ACTION.workItemReview,
      POLICY_ACTION.attemptFinish,
      POLICY_ACTION.poolAdd,
      POLICY_ACTION.inboxAck,
      POLICY_ACTION.finalizeReviewer,
    ];
    for (const action of samples) {
      assert.equal(code(expired, action), POLICY_REASON.PRINCIPAL_EXPIRED);
    }
  });

  test('principalFromControl 把 resolver 的缺失 / 过期 / 已认证分开', () => {
    assert.equal(principalFromControl(undefined).status, 'missing');
    assert.equal(principalFromControl({ status: 'expired' }).status, 'expired');
    const ok = principalFromControl({ id: 'op-1', role: 'operator' });
    assert.equal(ok.status, 'ok');
    if (ok.status === 'ok') {
      assert.equal(ok.kind, 'user');
      assert.equal(ok.role, 'operator');
    }
  });
});

describe('PolicyEngine 未知角色与未知动作', () => {
  test('未知 Principal kind → PRINCIPAL_UNKNOWN_ROLE', () => {
    assert.equal(
      code({ status: 'ok', kind: 'auditor', id: 'x' }, POLICY_ACTION.missionRead),
      POLICY_REASON.PRINCIPAL_UNKNOWN_ROLE,
    );
  });

  test('未知控制面 role → PRINCIPAL_UNKNOWN_ROLE', () => {
    assert.equal(
      code({ status: 'ok', kind: 'user', id: 'x', role: 'auditor' }, POLICY_ACTION.missionRead),
      POLICY_REASON.PRINCIPAL_UNKNOWN_ROLE,
    );
  });

  test('未知动作 → ACTION_UNKNOWN', () => {
    assert.equal(
      code(operator, { scope: 'mission', name: 'explode' }),
      POLICY_REASON.ACTION_UNKNOWN,
    );
    assert.equal(
      code(operator, { scope: 'finalize', name: 'jev' }),
      POLICY_REASON.ACTION_UNKNOWN,
    );
  });
});

describe('PolicyEngine 绑定不匹配', () => {
  test('coordinator 的 Mission 不一致 → BINDING_MISMATCH', () => {
    assert.equal(
      code(coordinator, POLICY_ACTION.missionRead, {
        context: { missionId: 'M-other', attemptId: ATTEMPT, workItemId: WORK },
      }),
      POLICY_REASON.BINDING_MISMATCH,
    );
  });

  test('coordinator 的 Attempt 不一致 → BINDING_MISMATCH', () => {
    assert.equal(
      code(coordinator, POLICY_ACTION.attemptUpdatePlan, {
        context: { missionId: MISSION, attemptId: 'A-other', workItemId: WORK },
      }),
      POLICY_REASON.BINDING_MISMATCH,
    );
  });

  test('independent_reviewer 的 Mission 不一致 → BINDING_MISMATCH', () => {
    assert.equal(
      code(independentReviewer, POLICY_ACTION.attemptGetReviewBundle, {
        context: { missionId: 'M-other', attemptId: ATTEMPT, workItemId: WORK },
      }),
      POLICY_REASON.BINDING_MISMATCH,
    );
  });

  test('executor 缺 WorkItem 绑定 → BINDING_MISMATCH', () => {
    const unbound: PolicyPrincipal = {
      status: 'ok',
      kind: 'executor',
      id: ATTEMPT,
      missionId: MISSION,
      attemptId: ATTEMPT,
    };
    assert.equal(code(unbound, POLICY_ACTION.workItemGetOrder), POLICY_REASON.BINDING_MISMATCH);
  });

  test('independent_reviewer 的 Mission / Attempt 不一致 → BINDING_MISMATCH', () => {
    assert.equal(
      code(independentReviewer, POLICY_ACTION.attemptGetReviewBundle, {
        context: { missionId: 'M-other', attemptId: ATTEMPT, workItemId: WORK },
      }),
      POLICY_REASON.BINDING_MISMATCH,
    );
    assert.equal(
      code(independentReviewer, POLICY_ACTION.attemptSubmitIndependentReview, {
        context: { missionId: MISSION, attemptId: 'A-other', workItemId: WORK },
      }),
      POLICY_REASON.BINDING_MISMATCH,
    );
  });
});

describe('PolicyEngine HA 与副作用', () => {
  test('机器终审 HA → HA_MACHINE_FINALIZE_DENIED', () => {
    const verdict = evaluatePolicy({
      principal: runner,
      action: POLICY_ACTION.finalizeMachine,
      state: { executionMode: 'high_assurance' },
    });
    assert.equal(verdict.decision, 'deny');
    assert.equal(verdict.reason.code, POLICY_REASON.HA_MACHINE_FINALIZE_DENIED);
  });

  test('lightweight / standard 机器终审仍允许', () => {
    assert.equal(
      code(runner, POLICY_ACTION.finalizeMachine, { state: { executionMode: 'lightweight' } }),
      POLICY_REASON.ALLOWED,
    );
    assert.equal(
      code(runner, POLICY_ACTION.finalizeMachine, { state: { executionMode: 'standard' } }),
      POLICY_REASON.ALLOWED,
    );
  });

  test('带外部副作用的 HA 一律 HA_SIDE_EFFECT_DENIED', () => {
    const flags = [
      { productionDeployRelease: true },
      { externalPaidOp: true },
      { unrecoverableExternalSideEffect: true },
      { destructiveData: true },
    ] as const;
    for (const haSideEffects of flags) {
      assert.equal(
        code(reviewer, POLICY_ACTION.finalizeReviewer, { state: { haSideEffects } }),
        POLICY_REASON.HA_SIDE_EFFECT_DENIED,
      );
      assert.equal(
        code(operator, POLICY_ACTION.finalizeHuman, { state: { haSideEffects } }),
        POLICY_REASON.HA_SIDE_EFFECT_DENIED,
      );
    }
  });
});

describe('PolicyEngine 不声称 Run Token TTL / audience', () => {
  test('没有 expired 输入时不会给出 PRINCIPAL_EXPIRED', () => {
    const verdict = evaluatePolicy({
      principal: coordinator,
      action: POLICY_ACTION.missionRead,
      context: bound,
    });
    assert.notEqual(verdict.reason.code, POLICY_REASON.PRINCIPAL_EXPIRED);
    assert.equal(verdict.decision, 'allow');
  });

  test('principalFromRun 用 attempt 绑定，不把 token 当身份', () => {
    const principal = principalFromRun({
      role: 'executor',
      missionId: MISSION,
      attemptId: ATTEMPT,
      workItemId: WORK,
    });
    assert.equal(principal.status, 'ok');
    if (principal.status === 'ok') {
      assert.equal(principal.id, ATTEMPT);
      assert.equal(principal.kind, 'executor');
      assert.equal('token' in principal, false);
    }
  });

  test('principalFromRun 认 independent_reviewer，不与终审 reviewer 混用', () => {
    const principal = principalFromRun({
      role: 'independent_reviewer',
      missionId: MISSION,
      attemptId: ATTEMPT,
    });
    assert.equal(principal.status, 'ok');
    if (principal.status === 'ok') {
      assert.equal(principal.kind, 'independent_reviewer');
      assert.equal(principal.id, ATTEMPT);
      assert.equal(principal.missionId, MISSION);
      assert.equal(principal.attemptId, ATTEMPT);
    }
  });
});

describe('PolicyEngine 六类 × 六类范围：逐格固定预期', () => {
  // 预期是手写的，不从 ALLOWED 矩阵推导——推导出来的预期改矩阵时跟着变，测不出越权。
  // 每格一个真实存在的代表动作：该 Principal 在这个范围里有允许的动作就取它（证明允许），
  // 没有就取一个它不该做的（证明错误角色被拒）。coordinator / executor 带自己的绑定。
  type Expected = { readonly decision: 'allow' | 'deny'; readonly code: string };
  const ALLOW: Expected = { decision: 'allow', code: POLICY_REASON.ALLOWED };
  const WRONG_ROLE: Expected = { decision: 'deny', code: POLICY_REASON.ACTION_DENIED };
  const MISSING: Expected = { decision: 'deny', code: POLICY_REASON.PRINCIPAL_MISSING };
  const EXPIRED: Expected = { decision: 'deny', code: POLICY_REASON.PRINCIPAL_EXPIRED };

  const cells: [string, PolicyPrincipal, PolicyAction, Expected][] = [
    ['user(operator) × mission：pause', operator, POLICY_ACTION.missionPause, ALLOW],
    ['user(operator) × workItem：create', operator, POLICY_ACTION.workItemCreate, WRONG_ROLE],
    ['user(operator) × attempt：finish', operator, POLICY_ACTION.attemptFinish, ALLOW],
    ['user(operator) × pool：add', operator, POLICY_ACTION.poolAdd, ALLOW],
    ['user(operator) × inbox：ack', operator, POLICY_ACTION.inboxAck, ALLOW],
    ['user(operator) × finalize：human', operator, POLICY_ACTION.finalizeHuman, ALLOW],
    ['reviewer × mission：read', reviewer, POLICY_ACTION.missionRead, WRONG_ROLE],
    ['reviewer × workItem：review', reviewer, POLICY_ACTION.workItemReview, WRONG_ROLE],
    ['reviewer × attempt：getBrief', reviewer, POLICY_ACTION.attemptGetBrief, WRONG_ROLE],
    ['reviewer × pool：add', reviewer, POLICY_ACTION.poolAdd, WRONG_ROLE],
    ['reviewer × inbox：read', reviewer, POLICY_ACTION.inboxRead, WRONG_ROLE],
    ['reviewer × finalize：reviewer', reviewer, POLICY_ACTION.finalizeReviewer, ALLOW],
    ['runner × mission：cancel', runner, POLICY_ACTION.missionCancel, WRONG_ROLE],
    ['runner × workItem：dispatch', runner, POLICY_ACTION.workItemDispatch, WRONG_ROLE],
    ['runner × attempt：finish', runner, POLICY_ACTION.attemptFinish, WRONG_ROLE],
    ['runner × pool：list', runner, POLICY_ACTION.poolList, WRONG_ROLE],
    ['runner × inbox：ack', runner, POLICY_ACTION.inboxAck, WRONG_ROLE],
    ['runner × finalize：machine（非 HA）', runner, POLICY_ACTION.finalizeMachine, ALLOW],
    ['coordinator × mission：read', coordinator, POLICY_ACTION.missionRead, ALLOW],
    ['coordinator × workItem：retire', coordinator, POLICY_ACTION.workItemRetire, ALLOW],
    ['coordinator × attempt：escalate', coordinator, POLICY_ACTION.attemptEscalate, ALLOW],
    ['coordinator × pool：add', coordinator, POLICY_ACTION.poolAdd, WRONG_ROLE],
    ['coordinator × inbox：read', coordinator, POLICY_ACTION.inboxRead, WRONG_ROLE],
    ['coordinator × finalize：human', coordinator, POLICY_ACTION.finalizeHuman, WRONG_ROLE],
    ['executor × mission：read', executor, POLICY_ACTION.missionRead, ALLOW],
    ['executor × workItem：getOrder', executor, POLICY_ACTION.workItemGetOrder, ALLOW],
    ['executor × attempt：submitEvidence', executor, POLICY_ACTION.attemptSubmitEvidence, ALLOW],
    ['executor × pool：list', executor, POLICY_ACTION.poolList, WRONG_ROLE],
    ['executor × inbox：ack', executor, POLICY_ACTION.inboxAck, WRONG_ROLE],
    ['executor × finalize：machine', executor, POLICY_ACTION.finalizeMachine, WRONG_ROLE],
    ['independent_reviewer × mission：read', independentReviewer, POLICY_ACTION.missionRead, WRONG_ROLE],
    ['independent_reviewer × workItem：review', independentReviewer, POLICY_ACTION.workItemReview, WRONG_ROLE],
    ['independent_reviewer × attempt：getReviewBundle', independentReviewer, POLICY_ACTION.attemptGetReviewBundle, ALLOW],
    ['independent_reviewer × pool：add', independentReviewer, POLICY_ACTION.poolAdd, WRONG_ROLE],
    ['independent_reviewer × inbox：read', independentReviewer, POLICY_ACTION.inboxRead, WRONG_ROLE],
    ['independent_reviewer × finalize：reviewer', independentReviewer, POLICY_ACTION.finalizeReviewer, WRONG_ROLE],
  ];

  function check(principal: PolicyPrincipal, action: PolicyAction, expected: Expected, label: string): void {
    const verdict = evaluatePolicy({
      principal,
      action,
      context: needsBind(principal) ? bound : undefined,
    });
    assert.equal(verdict.decision, expected.decision, `${label}：decision`);
    assert.equal(verdict.reason.code, expected.code, `${label}：reason.code`);
  }

  test('表本身覆盖六类 Principal × 六类范围，恰好 36 格', () => {
    const seen = new Set(
      cells.map(([, principal, action]) => {
        const kind = principal.status === 'ok' ? principal.kind : principal.status;
        return `${kind}|${action.scope}`;
      }),
    );
    assert.equal(cells.length, 36);
    assert.equal(seen.size, 36);
  });

  for (const [label, principal, action, expected] of cells) {
    test(label, () => check(principal, action, expected, label));
  }

  test('user(viewer) 同一批范围：读允许、写与确认一律错误角色', () => {
    const rows: [string, PolicyAction, Expected][] = [
      ['mission：read', POLICY_ACTION.missionRead, ALLOW],
      ['mission：pause', POLICY_ACTION.missionPause, WRONG_ROLE],
      ['workItem：create', POLICY_ACTION.workItemCreate, WRONG_ROLE],
      ['attempt：getDetail', POLICY_ACTION.attemptGetDetail, ALLOW],
      ['attempt：finish', POLICY_ACTION.attemptFinish, WRONG_ROLE],
      ['pool：list', POLICY_ACTION.poolList, ALLOW],
      ['pool：add', POLICY_ACTION.poolAdd, WRONG_ROLE],
      ['inbox：read', POLICY_ACTION.inboxRead, ALLOW],
      ['inbox：ack', POLICY_ACTION.inboxAck, WRONG_ROLE],
      ['finalize：human', POLICY_ACTION.finalizeHuman, WRONG_ROLE],
    ];
    for (const [label, action, expected] of rows) check(viewer, action, expected, `viewer × ${label}`);
  });

  test('缺身份：六类范围各一格，一律 deny + PRINCIPAL_MISSING', () => {
    const missing: PolicyPrincipal = { status: 'missing' };
    const rows: [string, PolicyAction][] = [
      ['mission：pause', POLICY_ACTION.missionPause],
      ['workItem：create', POLICY_ACTION.workItemCreate],
      ['attempt：finish', POLICY_ACTION.attemptFinish],
      ['pool：add', POLICY_ACTION.poolAdd],
      ['inbox：ack', POLICY_ACTION.inboxAck],
      ['finalize：human', POLICY_ACTION.finalizeHuman],
    ];
    for (const [label, action] of rows) check(missing, action, MISSING, `missing × ${label}`);
  });

  test('过期身份：六类范围各一格，一律 deny + PRINCIPAL_EXPIRED', () => {
    const expired: PolicyPrincipal = { status: 'expired' };
    const rows: [string, PolicyAction][] = [
      ['mission：read', POLICY_ACTION.missionRead],
      ['workItem：review', POLICY_ACTION.workItemReview],
      ['attempt：getDetail', POLICY_ACTION.attemptGetDetail],
      ['pool：list', POLICY_ACTION.poolList],
      ['inbox：read', POLICY_ACTION.inboxRead],
      ['finalize：reviewer', POLICY_ACTION.finalizeReviewer],
    ];
    for (const [label, action] of rows) check(expired, action, EXPIRED, `expired × ${label}`);
  });
});
