/**
 * POST_EXECUTION shadow（Jev 设计 §9，J2）：执行者交卷、确定性验收之后，把按预算投影过的执行摘要交给
 * 评估器，只把答案记进 ActivityLog。SHADOW 非权威：不改任何状态、不改审查级别，出任何错都只记不抛。
 *
 * 输入只取平台可信的数据：工单、那一次提交、那个 attempt 的证据；改动清单优先用平台自己算的 diff。
 * 执行者自报的清单只在拿不到 diff 时才用，并在事件里标明来源——离线评测要知道这一格能不能信。
 *
 * 往外发之前整份输入再脱敏一遍、然后才按预算截断（先脱敏再截尾，见 credential-redaction）：
 * 经 /api/agent 进来的内容进门已脱敏，但 Lightweight 的工单直接来自 mission 文件，不走那个口子。
 */

import type { EvidenceRecord, ExecutionResultBody, WorkOrder } from '../kernel/index.ts';
import { POST_EXECUTION_V1 } from './decision-question-registry.ts';
import { projectPostExecutionStateForRemote } from './post-execution-remote-input.ts';
import type { PostExecutionRemoteBudget } from './post-execution-remote-input.ts';
import { buildPostExecutionState } from './post-execution-state.ts';
import type { PostExecutionStateInput } from './post-execution-state.ts';
import type { ActivityLog, Clock, PostExecutionEvaluator } from './ports.ts';
import { redactSecrets, redactSecretsDeep } from './redact.ts';

export const POST_EXECUTION_SHADOW_EVENT_KIND = 'decision.post_execution' as const;

/**
 * 远端投影的默认预算。E4 实测一次请求约 4–5 KB；16 KB 足够，超了由投影记下截断，不悄悄丢。
 * 平台原先没有默认值（纯函数刻意不给），生产接线必须给一份。
 */
export const DEFAULT_POST_EXECUTION_REMOTE_BUDGET: PostExecutionRemoteBudget = Object.freeze({
  maxTotalBytes: 16_384,
  maxObjectiveBytes: 2_048,
  maxConstraintItems: 20,
  maxConstraintItemBytes: 512,
  maxAcceptanceItems: 20,
  maxAcceptanceItemBytes: 512,
  maxSummaryBytes: 2_048,
  maxEvidenceIds: 20,
  maxEvidenceSummaries: 20,
  maxEvidenceSummaryBytes: 512,
  maxFiles: 50,
});

/** Attempt 的工具记录只留尾部这么多条（recordToolCall 的上限）：记满了就不知道真实次数。 */
const TOOL_ACTIVITY_CAP = 200;

export type ChangedFilesSource = 'workspace_diff' | 'executor_claim';

export function postExecutionInputFrom(args: {
  readonly order: WorkOrder;
  readonly result: ExecutionResultBody;
  readonly evidence: readonly EvidenceRecord[];
  /** 平台自己算的改动清单；拿不到时不传，退回执行者自报。 */
  readonly trustedFiles?: readonly string[];
  readonly toolActivityCount?: number;
}): { input: PostExecutionStateInput; filesSource: ChangedFilesSource } {
  const claimed = new Set(args.result.evidenceIds);
  const knownToolCount =
    args.toolActivityCount !== undefined && args.toolActivityCount < TOOL_ACTIVITY_CAP ? args.toolActivityCount : undefined;
  return {
    filesSource: args.trustedFiles ? 'workspace_diff' : 'executor_claim',
    input: {
      workOrder: {
        objective: args.order.objective,
        constraints: [...args.order.constraints, ...args.order.doNot.map((x) => `不要：${x}`)],
        acceptanceCriteria: [...args.order.acceptance],
      },
      executorResult: {
        status: args.result.outcome,
        summary: args.result.summary,
        claimedEvidence: {
          evidenceIds: [...args.result.evidenceIds],
          summaries: args.evidence
            .filter((e) => claimed.has(e.id))
            .map((e) => ({ id: e.id, kind: e.kind, summary: e.summary })),
        },
      },
      fileChanges: { files: [...(args.trustedFiles ?? args.result.changedFiles)] },
      evidence: args.evidence.map((e) => ({
        id: e.id,
        kind: e.kind,
        ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
        summary: e.summary,
      })),
      // 记满上限就不给：状态里会标成 unavailable，而不是把被截断的数当真。
      ...(knownToolCount !== undefined ? { execution: { toolCount: knownToolCount } } : {}),
    },
  };
}

export async function recordPostExecutionShadow(
  deps: { readonly evaluator: PostExecutionEvaluator; readonly activity: ActivityLog; readonly clock: Clock },
  args: {
    readonly projectId: string;
    readonly missionId: string;
    readonly workItemId: string;
    readonly submittedAttemptId: string;
    readonly input: PostExecutionStateInput;
    readonly filesSource: ChangedFilesSource;
    readonly budget?: PostExecutionRemoteBudget;
  },
): Promise<void> {
  const base = {
    schemaVersion: 1,
    hook: 'POST_EXECUTION' as const,
    providerKind: deps.evaluator.kind,
    // 离线回填标签靠这组键和之后的 review.recorded / final_review.* 对上。
    ids: {
      projectId: args.projectId,
      missionId: args.missionId,
      workItemId: args.workItemId,
      submittedAttemptId: args.submittedAttemptId,
    },
    mode: 'shadow' as const,
    questionSetId: POST_EXECUTION_V1.id,
    filesSource: args.filesSource,
  };
  let data: Record<string, unknown>;
  try {
    const remote = projectPostExecutionStateForRemote(
      buildPostExecutionState(redactSecretsDeep(args.input)),
      args.budget ?? DEFAULT_POST_EXECUTION_REMOTE_BUDGET,
    );
    const start = deps.clock.now();
    try {
      const result = await deps.evaluator.evaluate(remote);
      data = {
        ...base,
        quality: 'success',
        latencyMs: Math.max(0, deps.clock.now().getTime() - start.getTime()),
        truncation: remote.truncation,
        answers: result.answers,
        ...(result.meta?.resolvedModel !== undefined ? { resolvedModel: result.meta.resolvedModel } : {}),
        ...(result.meta?.usage !== undefined ? { usage: result.meta.usage } : {}),
      };
    } catch (error) {
      data = {
        ...base,
        quality: 'provider_error',
        latencyMs: Math.max(0, deps.clock.now().getTime() - start.getTime()),
        truncation: remote.truncation,
        error: shortError(error),
      };
    }
  } catch (error) {
    // 状态建不出来（输入不合法）或塞不进预算：同样只记、不抛。
    data = { ...base, quality: 'state_error', error: shortError(error) };
  }
  try {
    await deps.activity.append({
      kind: POST_EXECUTION_SHADOW_EVENT_KIND,
      projectId: args.projectId,
      missionId: args.missionId,
      workItemId: args.workItemId,
      data,
    });
  } catch {
    // 审计写失败也不能拖垮主流程。
  }
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).slice(0, 200);
}
