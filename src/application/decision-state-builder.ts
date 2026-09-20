/**
 * Decision StateBuilder —— 最小、versioned、只接受显式 facts 的只读投影。
 *
 * 不接生产 provider、不读实体、不自动补业务 fact。输出可一一映射到
 * 现有 DecisionRequest；schemaVersion 钉死，便于后续演进时显式升级。
 */

import type { DecisionHook, DecisionRequest } from './ports.ts';

/** 稳定 schema 版本；变更形状时必须显式 bump，不得静默改语义。 */
export const DECISION_STATE_SCHEMA_VERSION = '1' as const;

export type DecisionStateSchemaVersion = typeof DECISION_STATE_SCHEMA_VERSION;

/** 显式 fact：key/value 均为 string；本层不解释语义。 */
export interface DecisionStateFact {
  readonly key: string;
  readonly value: string;
}

/**
 * Builder 唯一合法输入。
 *
 * 只认 hook / ids / 显式 facts。不接收 Mission、WorkItem、Attempt 实体，
 * 也不从其它字段猜业务 fact。
 */
export interface DecisionStateInput {
  readonly hook: DecisionHook;
  readonly projectId: string;
  readonly missionId: string;
  readonly workItemId?: string;
  readonly attemptId?: string;
  readonly facts?: readonly DecisionStateFact[];
}

/**
 * 只读决策状态投影。
 *
 * facts 恒为数组：无显式 facts 时为固定空数组 `[]`（可测试的空表示）。
 */
export interface DecisionState {
  readonly schemaVersion: DecisionStateSchemaVersion;
  readonly hook: DecisionHook;
  readonly projectId: string;
  readonly missionId: string;
  readonly workItemId?: string;
  readonly attemptId?: string;
  readonly facts: readonly DecisionStateFact[];
}

/** 无 facts 时的固定空表示——不要改成 undefined / null / 省略字段。 */
export const EMPTY_DECISION_STATE_FACTS: readonly DecisionStateFact[] = Object.freeze([]);

const ALLOWED_INPUT_KEYS = new Set([
  'hook',
  'projectId',
  'missionId',
  'workItemId',
  'attemptId',
  'facts',
]);

function assertString(label: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`DecisionStateBuilder: ${label} must be a string`);
  }
}

function assertAllowedInputKeys(input: object): void {
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      throw new TypeError(
        `DecisionStateBuilder: unknown or entity payload key "${key}" is not accepted`,
      );
    }
  }
}

function normalizeFacts(raw: unknown): readonly DecisionStateFact[] {
  if (raw === undefined) return EMPTY_DECISION_STATE_FACTS;
  if (!Array.isArray(raw)) {
    throw new TypeError('DecisionStateBuilder: facts must be an array when provided');
  }
  if (raw.length === 0) return EMPTY_DECISION_STATE_FACTS;

  const out: DecisionStateFact[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`DecisionStateBuilder: facts[${i}] must be a {key,value} object`);
    }
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    for (const k of keys) {
      if (k !== 'key' && k !== 'value') {
        throw new TypeError(
          `DecisionStateBuilder: facts[${i}] has unknown field "${k}"`,
        );
      }
    }
    if (!('key' in record) || !('value' in record)) {
      throw new TypeError(`DecisionStateBuilder: facts[${i}] requires key and value`);
    }
    assertString(`facts[${i}].key`, record.key);
    assertString(`facts[${i}].value`, record.value);
    out.push({ key: record.key, value: record.value });
  }
  return out;
}

/**
 * 从显式输入构建只读 DecisionState。
 *
 * - 不自动补业务 fact
 * - facts 顺序与值原样保留
 * - 非 string fact / 额外 unknown·entity 字段直接拒绝（不悄悄吸收）
 */
export function buildDecisionState(input: DecisionStateInput): DecisionState {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('DecisionStateBuilder: input must be an object');
  }
  assertAllowedInputKeys(input);

  assertString('hook', input.hook);
  if (input.hook !== 'PRE_DISPATCH' && input.hook !== 'POST_EXECUTION') {
    throw new TypeError(`DecisionStateBuilder: unsupported hook "${String(input.hook)}"`);
  }
  assertString('projectId', input.projectId);
  assertString('missionId', input.missionId);

  if (input.workItemId !== undefined) assertString('workItemId', input.workItemId);
  if (input.attemptId !== undefined) assertString('attemptId', input.attemptId);

  const facts = normalizeFacts(input.facts);

  return {
    schemaVersion: DECISION_STATE_SCHEMA_VERSION,
    hook: input.hook,
    projectId: input.projectId,
    missionId: input.missionId,
    ...(input.workItemId !== undefined ? { workItemId: input.workItemId } : {}),
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    facts,
  };
}

/**
 * DecisionState → DecisionRequest 一一映射。
 *
 * 不新增 hook、不改 ids、facts 原样带出（含空数组）。
 * schemaVersion 是 state 元数据，不属于 DecisionRequest，故不映射。
 */
export function toDecisionRequest(state: DecisionState): DecisionRequest {
  return {
    hook: state.hook,
    projectId: state.projectId,
    missionId: state.missionId,
    ...(state.workItemId !== undefined ? { workItemId: state.workItemId } : {}),
    ...(state.attemptId !== undefined ? { attemptId: state.attemptId } : {}),
    facts: state.facts,
  };
}
