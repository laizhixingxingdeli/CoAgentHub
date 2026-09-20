/**
 * Remote Decision input projection —— default-deny facts for remote providers.
 *
 * This is a remote default-deny boundary, not a general DLP/PII scanner.
 * Only `candidate_executor_id` facts may leave the process on the wire, and
 * narrow secret-like shapes are dropped entirely (no redaction/pass-through).
 */

import { CANDIDATE_EXECUTOR_FACT_KEY } from './decision-question-registry.ts';
import {
  EMPTY_DECISION_STATE_FACTS,
  type DecisionState,
  type DecisionStateFact,
} from './decision-state-builder.ts';

const PREFERRED_NONE_LITERAL = 'none';

/**
 * Narrow secret-like patterns. Case-insensitive where sensible.
 * Hit ⇒ drop the whole fact (no masking).
 */
function isSecretLikeValue(value: string): boolean {
  if (/-----BEGIN\s+[A-Z0-9][A-Z0-9\s-]*PRIVATE KEY-----/i.test(value)) return true;
  if (/-----BEGIN\s+CERTIFICATE-----/i.test(value)) return true;
  if (/-----BEGIN\s+/i.test(value) && /PRIVATE KEY-----/i.test(value)) return true;
  if (/\bBearer\s+\S+/i.test(value)) return true;
  // JWT-like: three base64url segments starting with eyJ
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return true;
  if (/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value)) return true;
  if (/api[_-]?key\s*=/i.test(value)) return true;
  if (/\btoken\s*=/i.test(value)) return true;
  if (/\bcookie\s*=/i.test(value)) return true;
  return false;
}

function projectFact(fact: DecisionStateFact): DecisionStateFact | undefined {
  if (fact.key !== CANDIDATE_EXECUTOR_FACT_KEY) return undefined;

  const trimmed = fact.value.trim();
  if (trimmed === '' || trimmed === PREFERRED_NONE_LITERAL) return undefined;
  if (isSecretLikeValue(trimmed)) return undefined;

  return { key: CANDIDATE_EXECUTOR_FACT_KEY, value: trimmed };
}

/**
 * Project DecisionState for remote wire use.
 *
 * - identity fields copied as-is
 * - facts: default-deny; only non-empty, non-`none`, non-secret-like
 *   `candidate_executor_id` values (trimmed)
 * - does not mutate `state` or its facts array
 */
export function sanitizeDecisionStateForRemote(state: DecisionState): DecisionState {
  const projected: DecisionStateFact[] = [];
  for (const fact of state.facts) {
    const kept = projectFact(fact);
    if (kept !== undefined) projected.push(kept);
  }

  const facts: readonly DecisionStateFact[] =
    projected.length === 0 ? EMPTY_DECISION_STATE_FACTS : Object.freeze(projected);

  return {
    schemaVersion: state.schemaVersion,
    hook: state.hook,
    projectId: state.projectId,
    missionId: state.missionId,
    ...(state.workItemId !== undefined ? { workItemId: state.workItemId } : {}),
    ...(state.attemptId !== undefined ? { attemptId: state.attemptId } : {}),
    facts,
  };
}
