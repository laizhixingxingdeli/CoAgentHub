/**
 * Decision Shadow Runner —— 离线审计原语。
 *
 * buildDecisionState → toDecisionRequest → provider.decide，
 * 再以 kind=decision.shadow 写入 ActivityLog。
 * 不写 kernel、不接生产 dispatch；provider / append 失败不向调用方抛。
 */

import {
  DECISION_STATE_SCHEMA_VERSION,
  buildDecisionState,
  toDecisionRequest,
  type DecisionStateInput,
} from './decision-state-builder.ts';
import { PRE_DISPATCH_V1 } from './decision-question-registry.ts';
import type {
  ActivityLog,
  Clock,
  DecisionAnswerMeta,
  DecisionAnswerSet,
  DecisionProvider,
} from './ports.ts';

export const DECISION_SHADOW_EVENT_KIND = 'decision.shadow' as const;

export type DecisionShadowQuality = 'success' | 'provider_error';

export interface DecisionShadowIds {
  readonly projectId: string;
  readonly missionId: string;
  readonly workItemIds: readonly string[];
  readonly workItemId?: string;
  readonly attemptId?: string;
}

/** Shadow 阶段 effective === baseline 的 dispatch 动作（冻结副本）。 */
export interface DecisionShadowDispatchAction {
  readonly kind: 'dispatch';
  readonly workItemIds: readonly string[];
}

export type DecisionShadowEventData =
  | {
      readonly schemaVersion: typeof DECISION_STATE_SCHEMA_VERSION;
      readonly hook: DecisionStateInput['hook'];
      readonly providerKind: string;
      readonly ids: DecisionShadowIds;
      readonly quality: 'success';
      readonly mode: 'shadow';
      readonly questionSetId: typeof PRE_DISPATCH_V1.id;
      readonly latencyMs: number;
      readonly baselineAction: DecisionShadowDispatchAction;
      readonly effectiveAction: DecisionShadowDispatchAction;
      readonly answers: DecisionAnswerSet['answers'];
      readonly resolvedModel?: string;
      readonly usage?: DecisionAnswerMeta['usage'];
    }
  | {
      readonly schemaVersion: typeof DECISION_STATE_SCHEMA_VERSION;
      readonly hook: DecisionStateInput['hook'];
      readonly providerKind: string;
      readonly ids: DecisionShadowIds;
      readonly quality: 'provider_error';
      readonly mode: 'shadow';
      readonly questionSetId: typeof PRE_DISPATCH_V1.id;
      readonly latencyMs: number;
      readonly baselineAction: DecisionShadowDispatchAction;
      readonly effectiveAction: DecisionShadowDispatchAction;
    };

export type DecisionShadowOutcome =
  | { readonly recorded: true; readonly quality: DecisionShadowQuality }
  | {
      readonly recorded: false;
      readonly quality: DecisionShadowQuality;
      readonly reason: 'activity_append_failed';
    };

export interface RunDecisionShadowArgs {
  readonly provider: DecisionProvider;
  readonly activity: ActivityLog;
  readonly clock: Clock;
  readonly stateInput: DecisionStateInput;
  readonly workItemIds: readonly string[];
}

function freezeDispatchAction(workItemIds: readonly string[]): DecisionShadowDispatchAction {
  return Object.freeze({
    kind: 'dispatch' as const,
    workItemIds: Object.freeze([...workItemIds]) as readonly string[],
  });
}

/**
 * 一次 shadow 决策审计。失败吞没；返回很小的只读 outcome。
 */
export async function runDecisionShadow(
  args: RunDecisionShadowArgs,
): Promise<DecisionShadowOutcome> {
  const { provider, activity, clock, stateInput, workItemIds } = args;
  const workItemIdsCopy = Object.freeze([...workItemIds]) as readonly string[];
  const baselineAction = freezeDispatchAction(workItemIdsCopy);
  const effectiveAction = freezeDispatchAction(workItemIdsCopy);

  const state = buildDecisionState(stateInput);
  const request = toDecisionRequest(state);

  let quality: DecisionShadowQuality = 'success';
  let answers: DecisionAnswerSet['answers'] | undefined;
  let resolvedModel: string | undefined;
  let usage: DecisionAnswerMeta['usage'] | undefined;

  const start = clock.now();
  try {
    const result = await provider.decide(request);
    answers = result.answers;
    if (result.meta?.resolvedModel !== undefined) {
      resolvedModel = result.meta.resolvedModel;
    }
    if (result.meta?.usage !== undefined) {
      usage = result.meta.usage;
    }
  } catch {
    quality = 'provider_error';
    answers = undefined;
    resolvedModel = undefined;
    usage = undefined;
  }
  const end = clock.now();
  const latencyMs = Math.max(0, Math.round(end.getTime() - start.getTime()));

  const ids: DecisionShadowIds = Object.freeze({
    projectId: stateInput.projectId,
    missionId: stateInput.missionId,
    workItemIds: workItemIdsCopy,
    ...(stateInput.workItemId !== undefined ? { workItemId: stateInput.workItemId } : {}),
    ...(stateInput.attemptId !== undefined ? { attemptId: stateInput.attemptId } : {}),
  });

  const data: DecisionShadowEventData =
    quality === 'success' && answers !== undefined
      ? Object.freeze({
          schemaVersion: DECISION_STATE_SCHEMA_VERSION,
          hook: stateInput.hook,
          providerKind: provider.kind,
          ids,
          quality: 'success' as const,
          mode: 'shadow' as const,
          questionSetId: PRE_DISPATCH_V1.id,
          latencyMs,
          baselineAction,
          effectiveAction,
          answers,
          ...(resolvedModel !== undefined ? { resolvedModel } : {}),
          ...(usage !== undefined ? { usage } : {}),
        })
      : Object.freeze({
          schemaVersion: DECISION_STATE_SCHEMA_VERSION,
          hook: stateInput.hook,
          providerKind: provider.kind,
          ids,
          quality: 'provider_error' as const,
          mode: 'shadow' as const,
          questionSetId: PRE_DISPATCH_V1.id,
          latencyMs,
          baselineAction,
          effectiveAction,
        });

  try {
    await activity.append({
      kind: DECISION_SHADOW_EVENT_KIND,
      projectId: stateInput.projectId,
      missionId: stateInput.missionId,
      ...(stateInput.workItemId !== undefined ? { workItemId: stateInput.workItemId } : {}),
      ...(stateInput.attemptId !== undefined ? { attemptId: stateInput.attemptId } : {}),
      data,
    });
    return Object.freeze({ recorded: true, quality });
  } catch {
    return Object.freeze({
      recorded: false,
      quality,
      reason: 'activity_append_failed' as const,
    });
  }
}
