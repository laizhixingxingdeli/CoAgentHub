/**
 * L3 应答派生与 review_request 并入(从 routes/group/tasks.ts 抽出)。
 * 路由与结案完整性模块消费本文件;本文件不得反向依赖 tasks / coordination-close。
 */

import {
  type CoordinationPayload,
  normalizeReviewRequestDiffSummary,
  parseKnownCoordinationPayload,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { isDetachedTask } from "@server/lib/detached-task-liveness";
import {
  adjudicatedRecipientsOfTask,
  applyDiffSummaryPatch,
  getL3ResponseMinutesMs,
  mergeDiffSummary,
  sameRecipients,
} from "@server/lib/executor-task";
import { hasReviewResult } from "@server/lib/l3-overdue-reminder";
import { eq } from "drizzle-orm";

type TaskRow = typeof taskTable.$inferSelect;

/** diffSummary 是否携带 review_request 交接载荷(顶层 type 或嵌套键两种形式)。 */
export function summaryHasReviewRequest(diffSummary: unknown): boolean {
  const summary =
    typeof diffSummary === "object" &&
    diffSummary !== null &&
    !Array.isArray(diffSummary)
      ? (diffSummary as Record<string, unknown>)
      : undefined;
  return (
    summary !== undefined &&
    (summary.type === "review_request" ||
      Object.hasOwn(summary, "review_request"))
  );
}

/**
 * 应走 L3(v4.1 spec §3.14.6)⟺ 群内 reviewer 与 coordinator 同时在场。
 * `dispatchKind` 只选择深度(requirement=完整档,fix=精简档),不决定跑不跑;
 * 深度选择落在 review_request 载荷的 `lite` 布尔上(R2 对 fix 票校验)。
 * groupHasReviewer 由调用方查询后传入(R3 反向守卫同一次查询,两处不漂移)。
 */
export async function shouldWalkL3(
  db: DataBase,
  task: TaskRow,
  groupHasReviewer: boolean,
): Promise<boolean> {
  if (!groupHasReviewer) return false;
  const members = await db.query.groupMember.findMany({
    where: (t, { eq }) => eq(t.groupId, task.groupId),
    columns: { roles: true },
  });
  const presentRoles = new Set<string>(members.flatMap((m) => m.roles));
  return presentRoles.has("coordinator");
}

/** review_request 载荷的可选布尔 `lite`(fix 票精简档标记;缺省=false 完整档)。 */
export function reviewRequestLiteFlag(diffSummary: unknown): boolean {
  return reviewRequestPayloadOf(diffSummary)?.lite === true;
}

/**
 * L3 请求按 spec 去重(specs/l3-is-per-spec-not-per-task.md R1-R4):
 * - 结案带 review_request 时,同 specRef+specHash 已存在未应答请求 → 不新增
 *   第二条,新的 L2 结论并入既有请求(属主任务的 review_request.diffSummary
 *   追加,先前的结论保留),本任务以 platform.l3MergedInto 标记指向属主;
 * - R2:既有请求已应答 → 允许新建;R3:续跑任务(resumeOf)并入父任务请求;
 * - R4:并入任务的 l3 派生经由属主(一次裁决使全部并入任务 answered=true)。
 */
const L3_MERGED_INTO_KEY = "l3MergedInto";

/** 取 diffSummary 的平台块(平台自有标记命名空间,如 resumeOf)。 */
export function platformBlockOf(
  diffSummary: unknown,
): Record<string, unknown> | undefined {
  const summary =
    typeof diffSummary === "object" &&
    diffSummary !== null &&
    !Array.isArray(diffSummary)
      ? (diffSummary as Record<string, unknown>)
      : undefined;
  const platform = summary?.platform;
  return typeof platform === "object" &&
    platform !== null &&
    !Array.isArray(platform)
    ? (platform as Record<string, unknown>)
    : undefined;
}

/** 从任务 diffSummary 提取 review_request 载荷(顶层/嵌套两形皆可;坏载荷返回 undefined)。 */
export function reviewRequestPayloadOf(
  diffSummary: unknown,
): Extract<CoordinationPayload, { type: "review_request" }> | undefined {
  try {
    return normalizeReviewRequestDiffSummary(diffSummary)?.review_request as
      | Extract<CoordinationPayload, { type: "review_request" }>
      | undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析结案时应并入的请求属主任务(R1/R2/R3):
 * - R3:本任务为续跑任务(diffSummary.platform.resumeOf 非空)→ 并入父任务请求
 *   (不新起一条,不要求父请求未应答);
 * - R1:同群 done 任务中同 specRef+specHash 且未应答的请求(排除自身)→ 并入;
 * - R2:既有匹配请求已应答 → 跳过,允许新建请求。
 *
 * R4(specs/l3-request-delivery-and-scope.md):候选属主的**收件人**与本任务
 * 不同时不并入 —— 并入是优化,任何情况下都不得把一条能送达的请求搬到送不达
 * 的地方。R1 落地后同群同角色会收敛到同一收件人,本条是防御性的。
 * 无属主 → undefined(正常新增请求)。
 */
export async function resolveL3RequestMergeOwner(
  db: DataBase,
  groupId: string,
  closingTask: TaskRow,
  incomingRequest: Extract<CoordinationPayload, { type: "review_request" }>,
  incomingRecipients: readonly string[],
): Promise<TaskRow | undefined> {
  const { specRef, specHash } = incomingRequest;
  const platform = platformBlockOf(closingTask.diffSummary);
  const resumeOf =
    typeof platform?.resumeOf === "string" ? platform.resumeOf : undefined;

  if (resumeOf !== undefined && resumeOf !== closingTask.id) {
    const parent = await db.query.task.findFirst({
      where: (t, { and: andFn, eq: eqFn }) =>
        andFn(eqFn(t.groupId, groupId), eqFn(t.id, resumeOf)),
    });
    const parentRequest = parent
      ? reviewRequestPayloadOf(parent.diffSummary)
      : undefined;
    if (
      parent &&
      parentRequest?.specRef === specRef &&
      parentRequest?.specHash === specHash &&
      sameRecipients(incomingRecipients, adjudicatedRecipientsOfTask(parent))
    ) {
      return parent;
    }
  }

  const candidates = await db.query.task.findMany({
    where: (t, { eq: eqFn }) => eqFn(t.groupId, groupId),
  });
  for (const candidate of candidates) {
    if (candidate.id === closingTask.id) continue;
    if (candidate.status !== "done") continue;
    const request = reviewRequestPayloadOf(candidate.diffSummary);
    if (
      !request ||
      request.specRef !== specRef ||
      request.specHash !== specHash
    ) {
      continue;
    }
    if (await hasReviewResult(db, groupId, candidate.id)) continue;
    // R4(l3-request-delivery-and-scope):收件人不同的候选属主不并入,各自
    // 独立成请求 —— 并入不得降低可送达性。
    if (
      !sameRecipients(
        incomingRecipients,
        adjudicatedRecipientsOfTask(candidate),
      )
    ) {
      continue;
    }
    return candidate;
  }
  return undefined;
}

/** 把本任务的 L2 结论追加进属主请求(先前结论保留,不覆盖不删除)。 */
export async function appendL3ConclusionToOwner(
  db: DataBase,
  owner: TaskRow,
  closingTaskId: string,
  conclusion: string,
): Promise<void> {
  const normalized = normalizeReviewRequestDiffSummary(owner.diffSummary);
  const ownerRequest = normalized?.review_request as
    | Extract<CoordinationPayload, { type: "review_request" }>
    | undefined;
  if (!normalized || !ownerRequest) return;
  const mergedText = `${ownerRequest.diffSummary}\n\n[并入任务 ${closingTaskId} 的 L2 结论]\n${conclusion}`;
  await db
    .update(taskTable)
    .set({
      diffSummary: mergeDiffSummary(
        owner.diffSummary,
        {
          review_request: {
            ...ownerRequest,
            diffSummary: mergedText,
          },
        },
        "review",
      ),
    })
    .where(eq(taskTable.id, owner.id));
}

/** 本任务不再携带独立 review_request,改挂 platform.l3MergedInto 指向属主。 */
export function markL3MergedInto(
  summaryToWrite: Record<string, unknown>,
  existingDiffSummary: unknown,
  ownerId: string,
): Record<string, unknown> {
  // 先以既有为底并入本次摘要(保留既有 platform.*),再去掉 review_request、
  // 写 l3MergedInto —— 全部经单一合并入口(spec diffsummary-ownership W2)。
  // review_request 用 delete 语义(键不出现),避免下游 summaryHasReviewRequest
  // 因 Object.hasOwn(null) 仍判定「带请求」。
  let next = applyDiffSummaryPatch(existingDiffSummary, summaryToWrite);
  const { review_request: _dropped, ...withoutRequest } = next;
  next = withoutRequest;
  next = mergeDiffSummary(
    next,
    { platform: { [L3_MERGED_INTO_KEY]: ownerId } },
    "relation",
  );
  return next;
}

/**
 * L3 应答状态派生(R3,specs/l3-verdict-observability.md):仅对「协调任务 +
 * 已落 done + 带 review_request」的任务输出 l3 字段;不满足触发条件返回
 * undefined(调用方不输出 l3,保持载荷逐字不变)。
 *
 * R4(l3-is-per-spec-not-per-task):并入任务自身不携带 review_request,经
 * platform.l3MergedInto 解析到请求属主,裁决/等待时间线随属主请求。
 *
 * awaitingSince = 落 done 的时刻:优先取 dispatchAudit.coordinationActivity
 * .endedAt(终态审计时刻),老任务/未记录时兜底 updatedAt。overdue = 超过
 * l3ResponseMinutes 且未应答(只观测不强制,不拒绝任何终态)。
 */
type ReviewResultIndex = Map<string, "pass" | "findings">;
type L3Task = Pick<
  TaskRow,
  | "id"
  | "groupId"
  | "executorParticipantId"
  | "brief"
  | "status"
  | "diffSummary"
  | "dispatchAudit"
  | "createdAt"
  | "updatedAt"
>;

/**
 * 读取本群所有可识别的 review_result,按 taskId 建立索引。
 * 该索引以消息载荷代替逐任务全表扫描;同一任务保留扫描中遇到的第一条,
 * 与详情端点原有判定顺序一致。这个代替在调用方只需要单个任务且不共享
 * 扫描结果时不成立,因此详情路径会按需建立自己的索引。
 */
export async function loadReviewResultIndex(
  db: DataBase,
  groupId: string,
): Promise<ReviewResultIndex> {
  const results: ReviewResultIndex = new Map();
  const candidates = await db.query.groupMessage.findMany({
    where: (t, { and: andFn, eq: eqFn, ilike: ilikeFn }) =>
      andFn(eqFn(t.groupId, groupId), ilikeFn(t.body, "%review_result%")),
    columns: { body: true },
  });
  for (const message of candidates) {
    let parsed: CoordinationPayload | undefined;
    try {
      parsed = parseKnownCoordinationPayload(message.body);
    } catch {
      continue;
    }
    if (parsed?.type === "review_result" && !results.has(parsed.taskId)) {
      results.set(parsed.taskId, parsed.verdict);
    }
  }
  return results;
}

export async function deriveL3Answer(
  db: DataBase,
  task: L3Task,
  reviewResults?: ReviewResultIndex,
): Promise<
  | {
      answered: boolean;
      verdict: "pass" | "findings" | null;
      awaitingSince: string;
      overdue: boolean;
    }
  | undefined
> {
  if (task.status !== "done") return undefined;
  if (!(await isDetachedTask(db, task as TaskRow))) return undefined;
  const summary =
    typeof task.diffSummary === "object" && task.diffSummary !== null
      ? (task.diffSummary as Record<string, unknown>)
      : undefined;
  const hasReviewRequest =
    summary !== undefined &&
    (summary.type === "review_request" ||
      Object.hasOwn(summary, "review_request"));
  const platform = platformBlockOf(task.diffSummary);
  const mergedInto =
    typeof platform?.[L3_MERGED_INTO_KEY] === "string"
      ? (platform[L3_MERGED_INTO_KEY] as string)
      : undefined;
  if (!hasReviewRequest && mergedInto === undefined) return undefined;

  // R4(l3-is-per-spec-not-per-task):并入任务自身无 review_request,解析到
  // 请求属主任务,裁决与等待时间线随属主(一次裁决使全部并入任务 answered=true)。
  const resolved = hasReviewRequest
    ? task
    : mergedInto === undefined
      ? undefined
      : await db.query.task.findFirst({
          where: eq(taskTable.id, mergedInto),
        });
  if (!resolved) return undefined;

  const audit = resolved.dispatchAudit ?? null;
  // updatedAt 可空(旧库行):null 时退回 createdAt,保证 awaitingSince 恒有值。
  const awaitingSince =
    audit?.coordinationActivity?.endedAt ??
    (resolved.updatedAt ?? resolved.createdAt).toISOString();

  // 在本群消息索引中找 taskId 指向属主任务的 review_result 载荷。列表路径
  // 传入批量索引,详情路径按需建立同一索引;解析失败的行已被跳过。
  const indexedResults =
    reviewResults ?? (await loadReviewResultIndex(db, resolved.groupId));
  const verdict = indexedResults.get(resolved.id) ?? null;
  const answered = verdict !== null;
  const overdue =
    !answered &&
    Date.now() - Date.parse(awaitingSince) > getL3ResponseMinutesMs();
  return { answered, verdict, awaitingSince, overdue };
}
