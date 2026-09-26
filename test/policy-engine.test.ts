/**
 * PolicyEngine 矩阵：五类 Principal × 六类动作范围。
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
  return principal.status === 'ok' && (principal.kind === 'coordinator' || principal.kind === 'executor');
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
});

describe('PolicyEngine 五类 × 六类范围抽样（每格都有判定）', () => {
  const principals: { name: string; principal: PolicyPrincipal }[] = [
    { name: 'user', principal: operator },
    { name: 'reviewer', principal: reviewer },
    { name: 'runner', principal: runner },
    { name: 'coordinator', principal: coordinator },
    { name: 'executor', principal: executor },
  ];
  const scopes: { scope: PolicyAction['scope']; action: PolicyAction }[] = [
    { scope: 'mission', action: POLICY_ACTION.missionRead },
    { scope: 'workItem', action: POLICY_ACTION.workItemCreate },
    { scope: 'attempt', action: POLICY_ACTION.attemptGetBrief },
    { scope: 'pool', action: POLICY_ACTION.poolAdd },
    { scope: 'inbox', action: POLICY_ACTION.inboxAck },
    { scope: 'finalize', action: POLICY_ACTION.finalizeHuman },
  ];

  for (const { name, principal } of principals) {
    for (const { scope, action } of scopes) {
      test(`${name} × ${scope} 有明确 allow 或 deny`, () => {
        const verdict = evaluatePolicy({
          principal,
          action,
          context: needsBind(principal) ? bound : undefined,
        });
        assert.ok(verdict.decision === 'allow' || verdict.decision === 'deny');
        assert.equal(typeof verdict.reason.code, 'string');
        assert.ok(verdict.reason.detail.length > 0);
      });
    }
  }
});
