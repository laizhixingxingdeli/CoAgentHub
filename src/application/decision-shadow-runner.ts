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
import type { ActivityLog, DecisionProvider, DecisionSignal } from './ports.ts';

export const DECISION_SHADOW_EVENT_KIND = 'decision.shadow' as const;

export type DecisionShadowQuality = 'success' | 'provider_error';

export interface DecisionShadowIds {
  readonly projectId: string;
  readonly missionId: string;
  readonly workItemIds: readonly string[];
  readonly workItemId?: string;
  readonly attemptId?: string;
}

export type DecisionShadowEventData =
  | {
      readonly schemaVersion: typeof DECISION_STATE_SCHEMA_VERSION;
      readonly hook: DecisionStateInput['hook'];
      readonly providerKind: string;
      readonly ids: DecisionShadowIds;
      readonly quality: 'success';
      readonly signal: DecisionSignal;
    }
  | {
      readonly schemaVersion: typeof DECISION_STATE_SCHEMA_VERSION;
      readonly hook: DecisionStateInput['hook'];
      readonly providerKind: string;
      readonly ids: DecisionShadowIds;
      readonly quality: 'provider_error';
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
  readonly stateInput: DecisionStateInput;
  readonly workItemIds: readonly string[];
}

/**
 * 一次 shadow 决策审计。失败吞没；返回很小的只读 outcome。
 */
export async function runDecisionShadow(
  args: RunDecisionShadowArgs,
): Promise<DecisionShadowOutcome> {
  const { provider, activity, stateInput, workItemIds } = args;
  const workItemIdsCopy = Object.freeze([...workItemIds]) as readonly string[];

  const state = buildDecisionState(stateInput);
  const request = toDecisionRequest(state);

  let quality: DecisionShadowQuality = 'success';
  let signal: DecisionSignal | undefined;

  try {
    signal = await provider.decide(request);
  } catch {
    quality = 'provider_error';
    signal = undefined;
  }

  const ids: DecisionShadowIds = {
    projectId: stateInput.projectId,
    missionId: stateInput.missionId,
    workItemIds: workItemIdsCopy,
    ...(stateInput.workItemId !== undefined ? { workItemId: stateInput.workItemId } : {}),
    ...(stateInput.attemptId !== undefined ? { attemptId: stateInput.attemptId } : {}),
  };

  const data: DecisionShadowEventData =
    quality === 'success' && signal !== undefined
      ? {
          schemaVersion: DECISION_STATE_SCHEMA_VERSION,
          hook: stateInput.hook,
          providerKind: provider.kind,
          ids,
          quality: 'success',
          signal,
        }
      : {
          schemaVersion: DECISION_STATE_SCHEMA_VERSION,
          hook: stateInput.hook,
          providerKind: provider.kind,
          ids,
          quality: 'provider_error',
        };

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
