import { existsSync } from "node:fs";
import { zValidator } from "@hono/zod-validator";
import {
  type CoordinationPayload,
  normalizeReviewRequestDiffSummary,
  parseKnownCoordinationPayload,
  REVIEW_REQUEST_EXAMPLE,
  TASK_STATUSES,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import type { DataBase } from "@server/lib/database";
import {
  getDetachedTaskLiveness,
  isDetachedTask,
} from "@server/lib/detached-task-liveness";
import {
  judgeTwoPartyDegradation,
  type TwoPartyDegradation,
} from "@server/lib/executor-availability";
import { findRepoRoot, gitExec } from "@server/lib/executor-runner";
import {
  adjudicatedRecipientsOfTask,
  createTaskDispatchWarnings,
  dispatcherRecipients,
  findTaskDetail,
  getL3ResponseMinutesMs,
  groupHasReviewerMember,
  inferSupersedesTaskId,
  isExecutorProcessAlive,
  isResumeTask,
  isTerminalTaskStatus,
  mergePlatformTokenFields,
  notifyTaskStatusChanged,
  postStatus,
  readTaskDetail,
  recordCoordinationActivity,
  resolveTaskRepo,
  reviewRequestCarryAllowed,
  reviewRequestRecipients,
  sameRecipients,
  taskOutputTail,
} from "@server/lib/executor-task";
import {
  type ClaimVerificationMode,
  hasCommitInTaskWindow,
  verifyCommitExists,
  verifyReportedCommit,
} from "@server/lib/executor-task/claim-verification";
import { EXECUTOR_COOLDOWN_END_MS_FIELD } from "@server/lib/executor-task/cooldown-store";
import {
  enterCooldown,
  MIN_EFFECTIVE_COOLDOWN_MS,
  normalizeCooldownEnd,
} from "@server/lib/executor-task/queue";
import {
  classifyQuotaFailure,
  formatEta,
  getRateLimitCooldownMs,
} from "@server/lib/executor-task/state";
import { getExecutorTaskLiveness } from "@server/lib/executor-task-liveness";
import {
  findExecutorByKey,
  parseRateLimitRecoveryMs,
} from "@server/lib/executors";
import { deriveL1Aggregate } from "@server/lib/l1-aggregate";
import { hasReviewResult } from "@server/lib/l3-overdue-reminder";
import { getRuntimeStatus } from "@server/lib/runtime-status";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { assertGroupWritable, assertSupersededTaskInGroup } from "./helpers";

/**
 * 群任务子路由:创建(按 message_id 幂等)/ 列表(分页 + 可选 outputTail)/
 * 详情 / 状态回写(执行器 PATCH)。server 为单一状态源,桥是纯执行器客户端。
 * 挂在 /api/groups 下(路径 /:id/tasks...),与拆分前完全一致。
 */

type TaskRow = typeof taskTable.$inferSelect;

/** 存活信号(R6,specs/orphan-tasks-only-reconcile-on-restart.md):pid 为 null
 * 时返回 null(无 pid 可核验),否则以 process.kill(pid, 0) 探测进程是否存在。 */
function pidAliveOf(pid: number | null): boolean | null {
  return pid === null ? null : isExecutorProcessAlive(pid);
}

/** diffSummary 是否携带 review_request 交接载荷(顶层 type 或嵌套键两种形式)。 */
function summaryHasReviewRequest(diffSummary: unknown): boolean {
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
 * 需表态的提交核实结论集合(specs/l2-must-read-claim-verification.md R1)。
 * - not_found / outside_window → 必须显式表态
 * - verified / skipped → 无需表态(skipped 为环境限制,非执行器过错)
 */
const NEEDS_CLAIM_ADJUDICATION = new Set<string>([
  "not_found",
  "outside_window",
]);

interface AlreadySatisfiedClaim {
  commits: string[];
  verification: string;
}

function coordinationCloseError(message: string): BizError {
  const runtime = getRuntimeStatus();
  if (!runtime.stale) {
    return new BizError(BizCodeEnum.InvalidRequest, message);
  }
  return new BizError(
    BizCodeEnum.InvalidRequest,
    `${message} 注意:当前运行时为陈旧构建(staleReason: ${runtime.staleReason}),本次拒绝可能来自旧版守卫;若已在源码中修改结案规则,请在发起方重启后重试回写。`,
  );
}

function parseAlreadySatisfiedClaim(
  summary: Record<string, unknown> | undefined,
): AlreadySatisfiedClaim | undefined {
  const raw = summary?.alreadySatisfied;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const claim = raw as Record<string, unknown>;
  const commits = claim.commits;
  const verification = claim.verification;
  if (
    !Array.isArray(commits) ||
    commits.length === 0 ||
    !commits.every((commit): commit is string => typeof commit === "string") ||
    typeof verification !== "string" ||
    verification.trim() === ""
  ) {
    return undefined;
  }
  return { commits, verification };
}

async function validateAlreadySatisfiedClaim(
  repoRoot: string,
  claim: AlreadySatisfiedClaim,
): Promise<"verified" | "unavailable"> {
  for (const hash of claim.commits) {
    const existence = await verifyCommitExists(hash, repoRoot);
    if (existence === "not_found") {
      throw coordinationCloseError(
        `alreadySatisfied.commits 中的提交 ${hash} 在仓库中不存在。`,
      );
    }
    if (existence === undefined) return "unavailable";
  }
  return "verified";
}

/** 从子任务自身的 diffSummary 提取 claimVerification.status(读子任务,不读协调任务)。 */
function childClaimVerificationStatus(raw: unknown): string | undefined {
  const summary =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  const cv = summary?.claimVerification;
  if (typeof cv !== "object" || cv === null || Array.isArray(cv)) {
    return undefined;
  }
  const status = (cv as Record<string, unknown>).status;
  return typeof status === "string" ? status : undefined;
}

/**
 * 查找任务窗口内的提交。git/仓库不可用时返回 undefined,表示按 R2 放行;
 * 空数组表示 git 可用且窗口内没有提交。
 */
async function commitsInTaskWindow(
  repoRoot: string,
  windowStartedAt: string | undefined,
): Promise<string[] | undefined> {
  if (!windowStartedAt) return undefined;
  const startMs = Date.parse(windowStartedAt);
  if (!Number.isFinite(startMs)) return undefined;

  try {
    const repository = await gitExec(
      ["rev-parse", "--is-inside-work-tree"],
      repoRoot,
    );
    if (repository.status !== 0 || repository.stdout.trim() !== "true") {
      return undefined;
    }

    const log = await gitExec(
      [
        "log",
        "--exclude=refs/coagenthub-cp/*",
        "--all",
        `--since=${windowStartedAt}`,
        "--format=%H%x00%cI",
      ],
      repoRoot,
    );
    if (log.status !== 0) return undefined;

    const nowMs = Date.now();
    const hashes: string[] = [];
    for (const line of log.stdout.split("\n")) {
      const [hash, commitAt] = line.trim().split("\0");
      if (!hash || !commitAt) continue;
      const commitMs = Date.parse(commitAt);
      if (
        Number.isFinite(commitMs) &&
        commitMs >= startMs &&
        commitMs <= nowMs
      ) {
        hashes.push(hash);
        if (hashes.length === 5) break;
      }
    }
    return hashes;
  } catch {
    return undefined;
  }
}

/** Resolve the same repository used by executor commit verification. */
async function resolveTaskRepoRoot(
  db: DataBase,
  task: TaskRow,
): Promise<string> {
  const group = await db.query.groups.findFirst({
    where: (g, { eq }) => eq(g.id, task.groupId),
  });
  const declaredRoot = resolveTaskRepo(
    task.brief ?? "",
    group?.projectPath ?? null,
  );
  return declaredRoot && existsSync(declaredRoot)
    ? declaredRoot
    : findRepoRoot();
}

/** 协调任务落终态时平台回写的结案载荷(l1Bypass + R4 降级留痕)。 */
interface CloseIntegrityResult {
  l1Bypass?: { commits: string[]; windowStartedAt: string };
  degradedToTwoParty?: TwoPartyDegradation;
}

/**
 * 协调任务落终态的完整性校验(R1/R2,见 specs/coordination-close-integrity.md)。
 * done 分支:仅当目标状态为 done 且任务为协调任务(detached)时生效,失败返回 400;
 * failed/cancelled 分支(l1-bypass-must-be-visible R1):零执行子任务时返回平台写入
 * diffSummary 的 l1Bypass 载荷(窗口内无提交或 git 不可用时返回 undefined,不写字段)。
 * 协调任务判定必须复用 lib/detached-task-liveness 的 isDetachedTask(),不另写一套。
 *
 * R4(specs/dispatching-should-be-the-default.md v1.1):零执行子任务 = 协调者兼任
 * 执行(降级为两方)的信号。是否真降级由**平台**判定——复用 executor-task-liveness
 * 与 executors 的额度冷却状态,不采信协调者自述「无人可派」。平台判定无可用执行器
 * → 返回 degradedToTwoParty 载荷;判定有可用执行器 → 不写(调用方伪造不足以触发)。
 */
async function assertCoordinationCloseIntegrity(
  db: DataBase,
  task: TaskRow,
  targetStatus: string | undefined,
  diffSummary: unknown,
): Promise<CloseIntegrityResult | undefined> {
  // R2:done 分支逐字不变;failed/cancelled 走 l1Bypass 检测(R3 不再直接返回)。
  if (
    targetStatus !== "done" &&
    targetStatus !== "failed" &&
    targetStatus !== "cancelled"
  ) {
    return;
  }
  // 协调任务判定复用 isDetachedTask()(显式 ReplyMode 或目标含 coordinator 角色)。
  if (!(await isDetachedTask(db, task))) return;

  const summary =
    typeof diffSummary === "object" &&
    diffSummary !== null &&
    !Array.isArray(diffSummary)
      ? (diffSummary as Record<string, unknown>)
      : undefined;

  const repoRoot = await resolveTaskRepoRoot(db, task);
  const alreadySatisfied = parseAlreadySatisfiedClaim(summary);
  const alreadySatisfiedStatus = alreadySatisfied
    ? await validateAlreadySatisfiedClaim(repoRoot, alreadySatisfied)
    : undefined;
  const commits = await commitsInTaskWindow(
    repoRoot,
    task.attempts[0]?.startedAt,
  );
  const hasAlreadySatisfied =
    summary !== undefined && Object.hasOwn(summary, "alreadySatisfied");

  // R2b:已存在的实现由协调者指名提交并提供验证摘要时,平台核实提交
  // 真实存在后认可该声明。git 不可用时不能把未核实的 alreadySatisfied
  // 当成有效声明。
  const canUseAlreadySatisfied = alreadySatisfiedStatus === "verified";

  // 读取本协调任务的执行子任务(L1 层)列表,供结案路径的终态检查与 l1Bypass 检测使用。
  const children = await db.query.task.findMany({
    where: (t, { eq }) => eq(t.parentTaskId, task.id),
    columns: {
      id: true,
      status: true,
      updatedAt: true,
      attempts: true,
      diffSummary: true,
    },
  });
  const effectiveChildren = children.filter((child) => !isResumeTask(child));

  // R4 降级判定(specs/dispatching-should-be-the-default.md v1.1):零执行子任务 =
  // 协调者兼任执行(降级为两方)的信号。是否真降级由**平台**判定——复用
  // executor-task-liveness 与 executors 的额度冷却状态,不采信协调者自述
  // 「无人可派」。有任一可用执行器 → undefined(不写,调用方伪造不足以触发);
  // 全部候选不可用 → 平台写入载荷(降级时刻 + 每个候选执行器的 name/reason)。
  const degradedToTwoParty =
    effectiveChildren.length === 0
      ? ((await judgeTwoPartyDegradation(db, task)) ?? undefined)
      : undefined;

  // l1-bypass-must-be-visible R1:协调任务落 failed/cancelled 且零执行子任务时,
  // 平台执行与 R1 守卫相同的窗口提交检测并返回 l1Bypass 载荷;有执行子任务(R3)、
  // 窗口内无提交或 git 不可用(R1)时不写字段。done 分支行为不受影响(R2)。
  if (targetStatus === "failed" || targetStatus === "cancelled") {
    if (effectiveChildren.length === 0 && commits && commits.length > 0) {
      const windowStartedAt = task.attempts[0]?.startedAt;
      if (windowStartedAt) {
        return {
          l1Bypass: { commits, windowStartedAt },
          degradedToTwoParty,
        };
      }
    }
    return degradedToTwoParty !== undefined
      ? { degradedToTwoParty }
      : undefined;
  }

  if (effectiveChildren.length === 0 && !canUseAlreadySatisfied) {
    if (hasAlreadySatisfied) {
      throw coordinationCloseError(
        "alreadySatisfied 不合法: commits 中的提交必须真实存在,且 verification 必须为非空字符串。",
      );
    }
  }

  // R1:done 的协调任务若已有有效执行子任务,所有子任务必须先到终态。
  // allTerminal 复用 L1 聚合的派生口径,避免在结案路径另写终态集合。
  if (effectiveChildren.length > 0) {
    const l1 = await deriveL1Aggregate(db, task);
    if (!l1.allTerminal) {
      const nonTerminal = effectiveChildren.filter(
        (child) => !isTerminalTaskStatus(child.status),
      );
      throw coordinationCloseError(
        `L1 层未完成:存在非终态执行子任务: ${nonTerminal
          .map((child) => `${child.id} (${child.status})`)
          .join(", ")}`,
      );
    }
  }

  // R2:应走 L3(三方在场且 dispatchKind 非 fix)时,review_request 不得缺失。
  if (await shouldWalkL3(db, task)) {
    if (!summaryHasReviewRequest(diffSummary)) {
      throw coordinationCloseError(
        "本协调任务应走 L3 三方检视,但 diffSummary 缺少 review_request 交接载荷(群内 reviewer 与 coordinator 同时在场且非 fix 票)。",
      );
    }
  }

  // R3:反向守卫——不该走 L3 时不得产出 review_request。
  // fix 票复用冻结 spec,不产生新架构面;无 reviewer 时两层编制不跑 L3。
  // dispatchKind 为 null 的历史行保守按 requirement 处理,不拒绝。
  // 判定与任务书 buildReportSection 共用(review-request-policy),两处不漂移。
  if (summaryHasReviewRequest(diffSummary)) {
    const groupHasReviewer = await groupHasReviewerMember(db, task.groupId);
    if (!reviewRequestCarryAllowed(task.dispatchKind, groupHasReviewer)) {
      throw coordinationCloseError(
        task.dispatchKind === "fix"
          ? "fix 票复用已过 L3 的冻结 spec,不产生新的架构面。"
          : "群内无 reviewer 成员,不得携带 review_request。",
      );
    }
  }

  // L2 必须直面提交核实结论(specs/l2-must-read-claim-verification.md):
  // 任一执行子任务的 claimVerification.status 属需表态集合(not_found /
  // outside_window)时,协调任务 diffSummary.claimAdjudication[childTaskId]
  // 必须提供 accepted(布尔)与非空 reason,否则 400 且点明子任务与其核实结论。
  // claimVerification 读自子任务自身 diffSummary,而非协调任务的。
  const claimChildren = await db.query.task.findMany({
    where: (t, { eq }) => eq(t.parentTaskId, task.id),
    columns: { id: true, diffSummary: true },
  });
  const adjudication =
    summary !== undefined &&
    typeof summary.claimAdjudication === "object" &&
    summary.claimAdjudication !== null &&
    !Array.isArray(summary.claimAdjudication)
      ? (summary.claimAdjudication as Record<string, unknown>)
      : undefined;
  for (const child of claimChildren.filter(
    (candidate) => !isResumeTask(candidate),
  )) {
    const status = childClaimVerificationStatus(child.diffSummary);
    if (status === undefined || !NEEDS_CLAIM_ADJUDICATION.has(status)) {
      continue;
    }
    const entry = adjudication?.[child.id];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw coordinationCloseError(
        `子任务 ${child.id} 的提交核实结论为 ${status},必须在 diffSummary.claimAdjudication["${child.id}"] 中显式表态(accepted 布尔 + 非空 reason)。`,
      );
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.accepted !== "boolean") {
      throw coordinationCloseError(
        `子任务 ${child.id} 的 claimAdjudication.accepted 缺失或非布尔,必须显式给出 true 或 false。`,
      );
    }
    const reason = typeof e.reason === "string" ? e.reason : "";
    if (reason.trim() === "") {
      throw coordinationCloseError(
        `子任务 ${child.id} 的 claimAdjudication.reason 为空,必须填写非空理由。`,
      );
    }
  }

  // R4:done 分支结束时同样携带平台判定的降级载荷(零执行子任务 + 平台判定
  // 无可用执行器时才有;有可用执行器时为 undefined,不写字段)。
  return degradedToTwoParty !== undefined ? { degradedToTwoParty } : undefined;
}

/**
 * 应走 L3 ⟺ 群内 reviewer 与 coordinator 同时在场 AND 本票 dispatchKind != 'fix'。
 * dispatchKind 为 null(历史/未走新字段)按 requirement 处理,保守要求 review_request。
 */
async function shouldWalkL3(db: DataBase, task: TaskRow): Promise<boolean> {
  if (task.dispatchKind === "fix") return false;
  const members = await db.query.groupMember.findMany({
    where: (t, { eq }) => eq(t.groupId, task.groupId),
    columns: { roles: true },
  });
  const presentRoles = new Set<string>(members.flatMap((m) => m.roles));
  return presentRoles.has("reviewer") && presentRoles.has("coordinator");
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
function platformBlockOf(
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
function reviewRequestPayloadOf(
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
async function resolveL3RequestMergeOwner(
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
async function appendL3ConclusionToOwner(
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
      diffSummary: {
        ...normalized,
        review_request: {
          ...ownerRequest,
          diffSummary: mergedText,
        },
      },
    })
    .where(eq(taskTable.id, owner.id));
}

/** 本任务不再携带独立 review_request,改挂 platform.l3MergedInto 指向属主。 */
function markL3MergedInto(
  summaryToWrite: Record<string, unknown>,
  existingDiffSummary: unknown,
  ownerId: string,
): Record<string, unknown> {
  const { review_request: _dropped, ...rest } = summaryToWrite;
  const incomingPlatform = platformBlockOf(rest) ?? {};
  const existingPlatform = platformBlockOf(existingDiffSummary) ?? {};
  return {
    ...rest,
    platform: {
      ...existingPlatform,
      ...incomingPlatform,
      [L3_MERGED_INTO_KEY]: ownerId,
    },
  };
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
async function deriveL3Answer(
  db: DataBase,
  task: TaskRow,
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
  if (!(await isDetachedTask(db, task))) return undefined;
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

  // 在本群消息中找 taskId 指向属主任务的 review_result 载荷。历史消息在 R1 校验
  // 落地前未校验形状,解析失败的行跳过(不影响 answered 判定)。
  let answered = false;
  let verdict: "pass" | "findings" | null = null;
  const candidates = await db.query.groupMessage.findMany({
    where: (t, { and: andFn, eq: eqFn, ilike: ilikeFn }) =>
      andFn(
        eqFn(t.groupId, resolved.groupId),
        ilikeFn(t.body, "%review_result%"),
      ),
    columns: { body: true },
  });
  for (const message of candidates) {
    let parsed: CoordinationPayload | undefined;
    try {
      parsed = parseKnownCoordinationPayload(message.body);
    } catch {
      continue;
    }
    if (parsed?.type === "review_result" && parsed.taskId === resolved.id) {
      answered = true;
      verdict = parsed.verdict;
      break;
    }
  }
  const overdue =
    !answered &&
    Date.now() - Date.parse(awaitingSince) > getL3ResponseMinutesMs();
  return { answered, verdict, awaitingSince, overdue };
}

const app = new Hono<{ Variables: { db: DataBase; participantId: string } }>();

app
  .post(
    "/:id/tasks",
    describeRoute({
      description:
        "Create a task for the group (idempotent by message_id — the same message only ever creates one task; duplicates return the existing row)",
      responses: {
        200: {
          description: "Task created or existing task returned",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    zValidator(
      "json",
      z.object({
        messageId: z.string().uuid(),
        executorParticipantId: z.string().uuid(),
        checkpointRef: z.string().optional(),
        // 规范驱动下发 (Spec-Driven Task Dispatch):可选字段,任务行写入
        // specRef/specHash(详情/WS 事件透传);不传 = 指令驱动任务。
        specRef: z.string().max(500).optional(),
        specHash: z.string().max(64).optional(),
        dispatchKind: z.enum(["requirement", "fix"]).optional(),
        // 替代关系(executor-switch-task-identity R2):本任务替代
        // supersedesTaskId 所指的那次尝试(同一工作项的先后尝试);指向的任务
        // 必须属于同一群组(否则 400,见 assertSupersededTaskInGroup),不校验
        // 其是否已终态。不传 = null。
        supersedesTaskId: z.string().uuid().optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const callerId = c.get("participantId");
      const { id } = c.req.valid("param");
      const {
        messageId,
        executorParticipantId,
        checkpointRef,
        specRef,
        specHash,
        dispatchKind,
        supersedesTaskId,
      } = c.req.valid("json");

      // 归档/软删群组只读:不能发新任务(与消息/成员同款守卫)。
      await assertGroupWritable(db, id);
      // 与其它群路由一致的边界:调用者必须是群成员(participant 注册是公开的,
      // 不校验会泄漏任意群的任务数据)。
      const membership = await db.query.groupMember.findFirst({
        where: (t, { and, eq }) =>
          and(eq(t.groupId, id), eq(t.participantId, callerId)),
      });
      if (!membership) {
        throw new BizError(BizCodeEnum.Forbidden);
      }
      const executor = await db.query.participant.findFirst({
        where: (t, { eq }) => eq(t.id, executorParticipantId),
      });
      if (!executor) {
        throw new BizError(BizCodeEnum.ParticipantNotFound);
      }
      // 替代关系(R2):被替代的任务必须属于同一群组,否则 400;不校验其终态。
      // L2 重发路径安全网:调用方未显式传 supersedesTaskId 时,平台根据当前
      // 续跑上下文自动指向刚结束/被替代的子任务(首次派发不补、跨父任务不串链)。
      let finalSupersedesTaskId: string | null | undefined = supersedesTaskId;
      if (finalSupersedesTaskId == null) {
        finalSupersedesTaskId = await inferSupersedesTaskId(
          db,
          id,
          callerId,
          executorParticipantId,
        );
      }
      await assertSupersededTaskInGroup(db, id, finalSupersedesTaskId);

      // 任务书快照:从触发消息取 body 原文写入 brief(消息后续编辑/软删除
      // 不影响已触发任务语义);消息不存在时留空(可空列)。
      const triggerMessage = await db.query.groupMessage.findFirst({
        where: (t, { eq }) => eq(t.id, messageId),
      });

      // Idempotent create: message_id is UNIQUE, so a repeated POST with the
      // same message id returns the existing task instead of a duplicate.
      // ON CONFLICT DO NOTHING keeps the check race-free (concurrent duplicate
      // deliveries fall back to re-reading the winning row, never a 500).
      const [created] = await db
        .insert(taskTable)
        .values({
          groupId: id,
          messageId,
          executorParticipantId,
          checkpointRef: checkpointRef ?? null,
          // 规范驱动下发:task 行写入 specRef/specHash(null = 指令驱动任务)。
          specRef: specRef ?? null,
          specHash: specHash ?? null,
          dispatchKind: dispatchKind ?? null,
          // 替代关系(R2):本任务替代 supersedesTaskId 所指的那次尝试;不传为 null。
          supersedesTaskId: finalSupersedesTaskId ?? null,
          brief: triggerMessage?.body ?? null,
          // 显式置 queued:不依赖 DB 默认值(旧库默认值可能仍是 running)。
          status: "queued",
        })
        .onConflictDoNothing({ target: taskTable.messageId })
        .returning();
      if (created) {
        return c.json(created);
      }
      const existing = await db.query.task.findFirst({
        where: (t, { eq }) => eq(t.messageId, messageId),
      });
      if (!existing) {
        throw new BizError(
          BizCodeEnum.Conflict,
          "Task for messageId already exists but could not be reloaded",
        );
      }
      const conflicts = [
        specRef !== undefined && specRef !== existing.specRef
          ? "specRef"
          : null,
        specHash !== undefined && specHash !== existing.specHash
          ? "specHash"
          : null,
        dispatchKind !== undefined && dispatchKind !== existing.dispatchKind
          ? "dispatchKind"
          : null,
        supersedesTaskId !== undefined &&
        finalSupersedesTaskId !== existing.supersedesTaskId
          ? "supersedesTaskId"
          : null,
      ].filter((field): field is string => field !== null);
      if (conflicts.length > 0) {
        throw new BizError(
          BizCodeEnum.Conflict,
          `Task for messageId already exists with conflicting fields: ${conflicts.join(", ")}`,
        );
      }
      return c.json(existing);
    },
  )
  .get(
    "/:id/tasks",
    describeRoute({
      description: "List the group's tasks, newest first (createdAt desc)",
      responses: {
        200: {
          description: "Task list",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator("param", z.object({ id: z.string().uuid() })),
    zValidator(
      "query",
      z.object({
        // 实时输出:仅 includeOutput=1 时返回 outputTail(控制响应大小)。
        includeOutput: z.enum(["1", "0", "true", "false"]).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const { includeOutput } = c.req.valid("query");
      const rawLimit = c.req.query("limit");
      const rawOffset = c.req.query("offset");
      const limit =
        rawLimit === undefined
          ? 50
          : Math.min(Math.max(Number(rawLimit) || 50, 1), 100);
      const offset =
        rawOffset === undefined ? 0 : Math.max(Number(rawOffset) || 0, 0);
      const wantOutput = includeOutput === "1" || includeOutput === "true";

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      // LAN trust model(与 GET /messages 一致):读任务列表不需要成员身份,
      // 仅要求群存在;写操作(POST/PATCH)仍走各自权限边界。
      const tasks = await db.query.task.findMany({
        where: (t, { eq }) => eq(t.groupId, id),
        columns: {
          id: true,
          groupId: true,
          parentTaskId: true,
          messageId: true,
          executorParticipantId: true,
          executorKey: true,
          // 存活信号(R6,specs/orphan-tasks-only-reconcile-on-restart.md):
          // 列表透出 executorPid,并派生 pidAlive 供看门狗等外部消费方判断。
          executorPid: true,
          brief: true,
          status: true,
          checkpointRef: true,
          retryCount: true,
          diffSummary: true,
          attempts: true,
          // A2A 上下文延续依赖读取上一任务的 contextId,列表必须返回该列。
          a2aContextId: true,
          // 任务下发者信息(Part A):透传给插件(定向通知用);老任务为 null。
          dispatcherParticipantId: true,
          dispatcherSessionId: true,
          // callback 路由信息(Part B):透传 opaque 路由 { platform?,
          // endpointRef?, sessionRef? };老任务为 null。
          callbackRef: true,
          // 下发目标审计:按 task 可回查下发者、目标、候选状态与可选理由。
          dispatchAudit: true,
          // 规范驱动下发:列表透出 specRef/specHash,UI 按 specRef 分组任务需要该
          // 字段(老任务为 null)。
          specRef: true,
          specHash: true,
          dispatchKind: true,
          // 替代关系(R3):列表透出 supersedesTaskId(老任务为 null)。
          supersedesTaskId: true,
          createdAt: true,
          updatedAt: true,
        },
        limit: limit ?? 50,
        offset: offset ?? 0,
        orderBy: (t, { desc }) => desc(t.createdAt),
      });
      // 存活信号(R6):列表每行派生 pidAlive(null = 无 pid 可核验,与
      // executorPid 为 null 一一对应);与详情同源,供看门狗等外部消费方判断。
      const withPidAlive = tasks.map((task) => ({
        ...task,
        pidAlive: pidAliveOf(task.executorPid),
      }));
      // 实时进度:includeOutput=1 时给每个任务附 outputTail(running 任务 =
      // 内存缓冲;已完成任务 = diffSummary.outputTail 回填或留空)。
      if (!wantOutput) {
        return c.json(withPidAlive);
      }
      const withOutput = withPidAlive.map((task) => {
        const buffered = taskOutputTail(task.id);
        const summary =
          typeof task.diffSummary === "object" && task.diffSummary !== null
            ? (task.diffSummary as Record<string, unknown>)
            : undefined;
        const backfilled =
          summary && typeof summary.outputTail === "string"
            ? summary.outputTail
            : undefined;
        const outputTail = buffered ?? backfilled ?? undefined;
        return outputTail === undefined ? task : { ...task, outputTail };
      });
      return c.json(withOutput);
    },
  )
  .get(
    "/:id/tasks/:taskId",
    describeRoute({
      description:
        "Get a single task's full details (optionally with outputTail via ?includeOutput=1)",
      responses: {
        200: {
          description: "Task details",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({ id: z.string().uuid(), taskId: z.string().uuid() }),
    ),
    zValidator(
      "query",
      z.object({
        // 实时输出:仅 includeOutput=1 时返回 outputTail(控制响应大小)。
        includeOutput: z.enum(["1", "0", "true", "false"]).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id, taskId } = c.req.valid("param");
      const { includeOutput } = c.req.valid("query");
      const wantOutput = includeOutput === "1" || includeOutput === "true";

      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      const task = await db.query.task.findFirst({
        where: (t, { and, eq }) => and(eq(t.id, taskId), eq(t.groupId, id)),
      });
      if (!task) {
        throw new BizError(BizCodeEnum.TaskNotFound);
      }
      const liveness = await getDetachedTaskLiveness(db, task);
      const executorLiveness = await getExecutorTaskLiveness(db, task);
      const runtime = getRuntimeStatus();
      // 只返回任务详情约定字段(不泄露 attempts/a2aContextId 等内部列)。
      const detail: Record<string, unknown> = {
        id: task.id,
        groupId: task.groupId,
        parentTaskId: task.parentTaskId ?? null,
        messageId: task.messageId,
        executorParticipantId: task.executorParticipantId,
        executorKey: task.executorKey,
        // 存活信号(R6):详情透出 executorPid 与 pidAlive(null = 无 pid 可核验),
        // 供看门狗等外部消费方判断执行器进程是否仍在运行。
        executorPid: task.executorPid ?? null,
        pidAlive: pidAliveOf(task.executorPid),
        brief: task.brief,
        status: task.status,
        checkpointRef: task.checkpointRef,
        retryCount: task.retryCount,
        diffSummary: task.diffSummary,
        // 规范驱动下发:详情透出 specRef/specHash(老任务为 null)。
        specRef: task.specRef ?? null,
        specHash: task.specHash ?? null,
        dispatchKind: task.dispatchKind ?? null,
        // 替代关系(R3):详情透出 supersedesTaskId(老任务为 null)。
        supersedesTaskId: task.supersedesTaskId ?? null,
        // 任务下发者信息(Part A):透传给插件(定向通知用);老任务为 null。
        dispatcherParticipantId: task.dispatcherParticipantId ?? null,
        dispatcherSessionId: task.dispatcherSessionId ?? null,
        // callback 路由信息(Part B):透传 opaque 路由 { platform?,
        // endpointRef?, sessionRef? };老任务为 null。
        callbackRef: task.callbackRef ?? null,
        dispatchAudit: task.dispatchAudit ?? null,
        livenessWarning: liveness.livenessWarning,
        lastSignalAt: liveness.lastSignalAt,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      };
      const summary =
        typeof task.diffSummary === "object" &&
        task.diffSummary !== null &&
        !Array.isArray(task.diffSummary)
          ? (task.diffSummary as Record<string, unknown>)
          : undefined;
      if (
        task.status === "failed" &&
        typeof summary?.error === "string" &&
        summary.error.trim() !== "" &&
        summary.staleBuildSuspected === true
      ) {
        detail.staleBuildSuspected = true;
      }
      // 实时进度:includeOutput=1 时附 outputTail(running 任务 = 内存缓冲;
      // 已完成任务 = diffSummary.outputTail 回填或留空)。
      if (wantOutput) {
        const buffered = taskOutputTail(task.id);
        const summary =
          typeof task.diffSummary === "object" && task.diffSummary !== null
            ? (task.diffSummary as Record<string, unknown>)
            : undefined;
        const backfilled =
          summary && typeof summary.outputTail === "string"
            ? summary.outputTail
            : undefined;
        detail.outputTail = buffered ?? backfilled ?? null;
      }
      // L3 应答状态(R3):协调任务 done + 带 review_request 时派生 l3 字段;
      // 不满足触发条件不输出(不是空对象),其余载荷保持逐字不变。
      const l3 = await deriveL3Answer(db, task);
      if (l3) {
        detail.l3 = l3;
      }
      // 执行器任务存活探测(R1,specs/executor-task-liveness.md):仅对
      // running 且非协调任务派生 liveness 字段(协调任务走既有
      // livenessWarning/lastSignalAt);不满足条件不输出(不是空对象),
      // 判定不修改 task.status。阈值复用 stallTimeoutMinutes,不新增配置。
      if (executorLiveness) {
        detail.liveness = executorLiveness;
      }
      // L1 聚合(R1,specs/reviewer-needs-no-executor-visibility.md):目标是协调
      // 任务(isDetachedTask)时派生 l1 字段(子任务数/聚合态/是否全终态),供
      // 检视者验收 L1 层是否发生;不含执行器身份。非协调任务不输出 l1(不是
      // 空对象),其余载荷保持逐字不变。
      if (await isDetachedTask(db, task)) {
        detail.l1 = await deriveL1Aggregate(db, task);
        detail.runtime = runtime;
      }
      return c.json(detail);
    },
  )
  .get(
    "/:id/tasks/:taskId/output",
    describeRoute({
      description:
        "整份任务明细(?detail=1,spec two-tier-output-summary-and-detail R5):返回该任务明细 JSONL 的全部条目,供事后排障按需展开",
      responses: {
        200: {
          description: "Task detail entries",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({ id: z.string().uuid(), taskId: z.string().uuid() }),
    ),
    zValidator(
      "query",
      z.object({
        // 整份明细必须显式带 detail=1(与 includeOutput 同款枚举口径,不放宽)。
        detail: z.enum(["1", "0", "true", "false"]).optional(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id, taskId } = c.req.valid("param");
      const { detail } = c.req.valid("query");
      // 群/任务存在性校验与任务详情路由一致(includeOutput 同授权口径,不放宽)。
      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      const task = await db.query.task.findFirst({
        where: (t, { and, eq }) => and(eq(t.id, taskId), eq(t.groupId, id)),
      });
      if (!task) {
        throw new BizError(BizCodeEnum.TaskNotFound);
      }
      if (detail !== "1" && detail !== "true") {
        throw new BizError(
          BizCodeEnum.InvalidRequest,
          "整份明细需显式携带 ?detail=1",
        );
      }
      const rows = readTaskDetail(taskId);
      if (rows === null) {
        // R5:404 并说明原因,不得静默返回空。
        throw new BizError(
          BizCodeEnum.TaskNotFound,
          "任务明细文件不存在(可能已被 14 天清理,或该任务无明细记录)",
        );
      }
      return c.json({ taskId, entries: rows });
    },
  )
  .get(
    "/:id/tasks/:taskId/output/:entryId",
    describeRoute({
      description:
        "单条任务明细(spec two-tier-output-summary-and-detail R5):按摘要行 #id 展开完整原文;找不到返回 404 并说明原因",
      responses: {
        200: {
          description: "Single detail entry",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({
        id: z.string().uuid(),
        taskId: z.string().uuid(),
        entryId: z.string(),
      }),
    ),
    async (c) => {
      const db = c.get("db");
      const { id, taskId, entryId } = c.req.valid("param");
      // 群/任务存在性校验与任务详情路由一致(includeOutput 同授权口径,不放宽)。
      const group = await db.query.groups.findFirst({
        where: (t, { eq }) => eq(t.id, id),
      });
      if (!group) {
        throw new BizError(BizCodeEnum.GroupNotFound);
      }
      const task = await db.query.task.findFirst({
        where: (t, { and, eq }) => and(eq(t.id, taskId), eq(t.groupId, id)),
      });
      if (!task) {
        throw new BizError(BizCodeEnum.TaskNotFound);
      }
      const row = findTaskDetail(taskId, entryId);
      if (row === undefined) {
        // R5:明细文件不存在(已被清理 / 任务无明细),404 说明原因。
        throw new BizError(
          BizCodeEnum.TaskNotFound,
          "明细文件不存在(可能已被 14 天清理,或该任务无明细记录)",
        );
      }
      if (row === null) {
        // R5:id 不存在,404 说明原因,不得静默返回空。
        throw new BizError(
          BizCodeEnum.TaskNotFound,
          `条目 ${entryId} 不存在(摘要行里的 #id 无对应明细)`,
        );
      }
      return c.json(row);
    },
  )
  .patch(
    "/:id/tasks/:taskId",
    describeRoute({
      description:
        "Update a task (status/diffSummary by the owning executor; brief by the group's coordinator/human while the task is queued)",
      responses: {
        200: {
          description: "Task updated",
          content: { "application/json": {} },
        },
      },
    }),
    zValidator(
      "param",
      z.object({ id: z.string().uuid(), taskId: z.string().uuid() }),
    ),
    zValidator(
      "json",
      z
        .object({
          status: z.enum(TASK_STATUSES).optional(),
          diffSummary: z.unknown().optional(),
          checkpointRef: z.string().optional(),
          // 任务书快照:仅群 coordinator/human 可在任务 queued 时修改
          // (角色/状态判断在 handler,此处只做格式约束;执行器本人保持只读)。
          brief: z.string().min(1).max(4000).optional(),
        })
        .passthrough()
        .refine(
          (v) =>
            v.status !== undefined ||
            v.diffSummary !== undefined ||
            v.checkpointRef !== undefined ||
            v.brief !== undefined,
          {
            message:
              "至少提供 status / diffSummary / checkpointRef / brief 之一",
          },
        ),
    ),
    async (c) => {
      const db = c.get("db");
      const participantId = c.get("participantId");
      const { id, taskId } = c.req.valid("param");
      const { status, diffSummary, checkpointRef, brief } = c.req.valid("json");
      // R3:分流权归检视者,下游 PATCH 不得改写已落库 dispatchKind —— 任何携带的
      // dispatchKind 字段静默丢弃,不参与 update(c.req.valid("json") passthrough 亦忽略).
      let normalizedDiffSummary = diffSummary;
      if (
        typeof diffSummary === "object" &&
        diffSummary !== null &&
        !Array.isArray(diffSummary) &&
        ((diffSummary as Record<string, unknown>).type === "review_request" ||
          Object.hasOwn(diffSummary, "review_request"))
      ) {
        try {
          normalizedDiffSummary =
            normalizeReviewRequestDiffSummary(diffSummary);
        } catch (error) {
          const detail =
            error instanceof z.ZodError ? error.message : String(error);
          throw new BizError(
            BizCodeEnum.InvalidRequest,
            `diffSummary.review_request 形状无效: ${detail}。期望示例: ${JSON.stringify(REVIEW_REQUEST_EXAMPLE)}`,
          );
        }
      }

      // 归档/软删群组只读:不能改任务状态(与 POST /tasks 同款守卫)。
      await assertGroupWritable(db, id);
      const task = await db.query.task.findFirst({
        where: (t, { and, eq }) => and(eq(t.id, taskId), eq(t.groupId, id)),
      });
      if (!task) {
        throw new BizError(BizCodeEnum.TaskNotFound);
      }
      const isExecutor = task.executorParticipantId === participantId;
      const wantsBrief = brief !== undefined;
      const wantsLifecycle =
        status !== undefined ||
        diffSummary !== undefined ||
        checkpointRef !== undefined;

      if (wantsBrief) {
        // 任务书快照对执行器本人保持只读(与旧 superRefine 行为一致)。
        if (isExecutor) {
          throw new BizError(
            BizCodeEnum.InvalidRequest,
            "brief 为只读字段,不可通过 PATCH 修改",
          );
        }
        // 仅群 coordinator/human 可在任务排队中修改任务书。
        const membership = await db.query.groupMember.findFirst({
          where: (t, { and, eq }) =>
            and(eq(t.groupId, id), eq(t.participantId, participantId)),
        });
        const roles = membership?.roles ?? [];
        if (!roles.includes("coordinator") && !roles.includes("human")) {
          throw new BizError(BizCodeEnum.Forbidden);
        }
        if (task.status !== "queued") {
          throw new BizError(
            BizCodeEnum.Conflict,
            "仅排队中的任务可修改任务书",
          );
        }
      }
      // 生命周期字段(status/diffSummary/checkpointRef)仍仅执行器本人可改。
      if (wantsLifecycle && !isExecutor) {
        throw new BizError(BizCodeEnum.Forbidden);
      }
      // Terminal state changes are an audited interruption of the task
      // lifecycle. Require the caller to persist the explanation in the
      // existing diffSummary.error field so a failed/cancelled task never
      // becomes an unexplained terminal event. Internal server paths write
      // directly to the database and already provide their own reasons.
      if (
        status !== undefined &&
        status !== task.status &&
        (status === "failed" || status === "cancelled")
      ) {
        const summary =
          typeof normalizedDiffSummary === "object" &&
          normalizedDiffSummary !== null &&
          !Array.isArray(normalizedDiffSummary)
            ? (normalizedDiffSummary as Record<string, unknown>)
            : undefined;
        if (typeof summary?.error !== "string" || summary.error.trim() === "") {
          throw new BizError(
            BizCodeEnum.InvalidRequest,
            `status=${status} 必须在 diffSummary.error 中提供失败原因`,
          );
        }
      }
      // 协调任务落终态的完整性校验(R1/R2):仅 done + 协调任务触发;
      // 复用 isDetachedTask() 判定协调任务,不另写一套。
      // l1-bypass-must-be-visible R1:failed/cancelled + 零执行子任务时返回
      // l1Bypass 载荷,由平台写入 diffSummary。
      const closeIntegrity = await assertCoordinationCloseIntegrity(
        db,
        task,
        status,
        diffSummary,
      );
      // 汇报 commit 核实(spec verify-agent-claims v1.1):任何写入
      // diffSummary.hash 的入口都要核实——CLI 完成 / detached PATCH / a2a 完成
      // 共用 claim-verification 同一套逻辑。核实是尽力而为:仓库不可达 / 非 git /
      // git 失败 → 跳过(不写核实字段);a2a 执行器本地无仓库 → 留下
      // status=skipped 的「未核实」痕迹。核实失败只标记、绝不把任务判 failed。
      let summaryToWrite = normalizedDiffSummary;
      if (
        diffSummary !== undefined &&
        typeof normalizedDiffSummary === "object" &&
        normalizedDiffSummary !== null &&
        !Array.isArray(normalizedDiffSummary)
      ) {
        const raw = normalizedDiffSummary as Record<string, unknown>;
        const reportedHash =
          typeof raw.hash === "string" && raw.hash.trim() !== ""
            ? raw.hash
            : undefined;
        if (reportedHash) {
          try {
            const executorConfig = task.executorKey
              ? await findExecutorByKey(db, task.executorKey)
              : undefined;
            const mode: ClaimVerificationMode =
              executorConfig?.kind === "a2a" ? "a2a" : "cli";
            // 与派发时 spawn cwd 同源的仓库:任务书声明 → 群 project_path →
            // findRepoRoot 兜底(与 queue.ts 派发路径一致)。
            const repoRoot = await resolveTaskRepoRoot(db, task);
            const verification = await verifyReportedCommit(
              reportedHash,
              repoRoot,
              task.attempts,
              mode,
            );
            if (verification) {
              summaryToWrite = { ...raw, claimVerification: verification };
            }
          } catch (e) {
            // 核实绝不拖垮完成路径:任何异常都跳过核实,任务照常落终态。
            console.warn(`[tasks] commit 核实跳过(${taskId}): ${e}`);
          }
        }
      }
      // l1-bypass-must-be-visible R1 + R4(dispatching-should-be-the-default):
      // 平台把 l1Bypass / degradedToTwoParty 分键并入 diffSummary(与
      // claimVerification 同款写入模式),不覆盖执行器自报的其它字段。两个键
      // 各自独立:仅当对应载荷存在时才写,避免把降级载荷误塞进 l1Bypass 键。
      if (
        closeIntegrity &&
        typeof summaryToWrite === "object" &&
        summaryToWrite !== null &&
        !Array.isArray(summaryToWrite)
      ) {
        summaryToWrite = {
          ...(summaryToWrite as Record<string, unknown>),
          ...(closeIntegrity.l1Bypass !== undefined
            ? { l1Bypass: closeIntegrity.l1Bypass }
            : {}),
          ...(closeIntegrity.degradedToTwoParty !== undefined
            ? { degradedToTwoParty: closeIntegrity.degradedToTwoParty }
            : {}),
        };
      }
      // R3: staleBuildSuspected is a platform-owned snapshot of the runtime
      // at the failed transition, not a live property of every detail read.
      // Strip client-provided values so a later read cannot manufacture the
      // signal, then persist it only for a non-terminal -> failed transition.
      if (
        diffSummary !== undefined &&
        typeof summaryToWrite === "object" &&
        summaryToWrite !== null &&
        !Array.isArray(summaryToWrite)
      ) {
        const summaryWithoutStaleMarker = {
          ...(summaryToWrite as Record<string, unknown>),
        };
        delete summaryWithoutStaleMarker.staleBuildSuspected;
        const shouldPersistStaleBuildSuspected =
          status === "failed" &&
          status !== task.status &&
          !isTerminalTaskStatus(task.status) &&
          typeof summaryWithoutStaleMarker.error === "string" &&
          summaryWithoutStaleMarker.error.trim() !== "" &&
          getRuntimeStatus().stale;
        summaryToWrite = shouldPersistStaleBuildSuspected
          ? {
              ...summaryWithoutStaleMarker,
              staleBuildSuspected: true,
            }
          : summaryWithoutStaleMarker;
      }
      // token-fields-clobbered-by-close R1:平台已采集的 token 字段不得被调用方
      // PATCH 整体替换冲掉。复用 l1Bypass 的平台补写模式:载荷不含该键时写回
      // 平台原值;载荷显式提供(含 null)时以调用方为准(R2)。
      //
      // 平台原值有两个来源:任务结束路径的完成回填(diffSummary)与采集结果
      // (attempts)。真实 detached 协调链路走后者 —— 任务由协调者 PATCH 落终态,
      // 平台完成回填从未跑过,diffSummary 里根本没有这两个键。取值口径与
      // queue.ts 完成路径逐字一致(sumAttemptToken* + undefined 不写),两处共用
      // mergePlatformTokenFields。
      // R2 缺省留痕跨终态保留:任何 diffSummary 覆盖不得丢失 dispatchKindNote
      if (
        diffSummary !== undefined &&
        typeof summaryToWrite === "object" &&
        summaryToWrite !== null &&
        !Array.isArray(summaryToWrite)
      ) {
        const prevNote =
          task.diffSummary && typeof task.diffSummary === "object" && !Array.isArray(task.diffSummary)
            ? (task.diffSummary as Record<string, unknown>).dispatchKindNote
            : undefined;
        if (prevNote && !Object.hasOwn(summaryToWrite as Record<string, unknown>, "dispatchKindNote")) {
          (summaryToWrite as Record<string, unknown>).dispatchKindNote = prevNote;
        }
      }
      if (
        diffSummary !== undefined &&
        typeof summaryToWrite === "object" &&
        summaryToWrite !== null &&
        !Array.isArray(summaryToWrite)
      ) {
        summaryToWrite = mergePlatformTokenFields(
          summaryToWrite as Record<string, unknown>,
          {
            existing: task.diffSummary,
            attempts: Array.isArray(task.attempts) ? task.attempts : [],
          },
        );
      }
      // R1(specs/l3-request-delivery-and-scope.md):完成事件的投递对象由**载荷**
      // 决定,不由下发者决定 —— 终态 diffSummary 带 review_request 时收件人是群内
      // reviewer 成员,其余完成事件仍是下发者。裁定只发生在应用层,trigger 仅搬运
      // task.recipient_participant_ids(它不查 group_members、不理解角色)。
      // 非终态的 PATCH 不裁定:trigger 不会触发,列保持上一次裁定的原值。
      const terminalTransition =
        status !== undefined &&
        isTerminalTaskStatus(status) &&
        !isTerminalTaskStatus(task.status);
      let ownRecipients: string[] | undefined;
      if (status !== undefined && isTerminalTaskStatus(status)) {
        ownRecipients = summaryHasReviewRequest(summaryToWrite)
          ? await reviewRequestRecipients(db, id, task.dispatcherParticipantId)
          : dispatcherRecipients(task.dispatcherParticipantId);
      }
      // L3 请求按 spec 去重(specs/l3-is-per-spec-not-per-task.md R1-R4):
      // 结案 done 且带 review_request 时,同 specRef+specHash 已存在未应答请求
      // 则不新增第二条——新的 L2 结论并入既有请求(追加,先前结论保留),本任务
      // 改挂 platform.l3MergedInto 标记指向属主(R4 裁决对全部并入任务生效);
      // 续跑任务(resumeOf)并入父任务请求,不新起一条(R3)。
      if (
        status === "done" &&
        typeof summaryToWrite === "object" &&
        summaryToWrite !== null &&
        !Array.isArray(summaryToWrite)
      ) {
        const incomingRequest = reviewRequestPayloadOf(summaryToWrite);
        if (incomingRequest) {
          const owner = await resolveL3RequestMergeOwner(
            db,
            id,
            task,
            incomingRequest,
            ownRecipients ?? [],
          );
          if (owner) {
            await appendL3ConclusionToOwner(
              db,
              owner,
              taskId,
              incomingRequest.diffSummary,
            );
            summaryToWrite = markL3MergedInto(
              summaryToWrite as Record<string, unknown>,
              task.diffSummary,
              owner.id,
            );
          }
        }
      }
      // 并入后本任务不再携带 review_request → 收件人回落下发者(R1 缺省语义);
      // 未并入时保留上面按载荷裁定的收件人。仅终态转换写入:trigger 只在这一刻
      // 读 NEW.recipient_participant_ids。
      const recipientsToWrite =
        ownRecipients === undefined
          ? undefined
          : summaryHasReviewRequest(summaryToWrite)
            ? ownRecipients
            : dispatcherRecipients(task.dispatcherParticipantId);
      // R8(v1.1):PATCH failed 终态时复用 classifyQuotaFailure 判定额度失败,
      // 命中后同口径进入执行器冷却并留痕(与 queue 进程退出/超时/孤儿收敛三条
      // 路径一致)。
      let quotaCooldownEnd: number | undefined;
      let quotaEx: Awaited<ReturnType<typeof findExecutorByKey>> | undefined;
      let quotaErrorText = "";
      if (
        status === "failed" &&
        status !== task.status &&
        typeof summaryToWrite === "object" &&
        summaryToWrite !== null &&
        !Array.isArray(summaryToWrite)
      ) {
        const rawSummary = summaryToWrite as Record<string, unknown>;
        const errorText =
          typeof rawSummary.error === "string" ? rawSummary.error : "";
        if (errorText.trim() !== "") {
          const quotaVerdict = classifyQuotaFailure([errorText], {
            taskBook: task.brief,
          });
          if (quotaVerdict.isQuota) {
            // R6 主闸(quota-failure-on-clean-exit v1.1):PATCH failed 同样先以
            // 任务窗口内是否产生提交为闸 —— 有提交 → 不判额度、不冷却(有产出即
            // 非耗尽);无提交 → 保留 R8 既有额度语义。探测尽力而为:仓库/git
            // 不可达按「无提交证据」处理,不改变既有判定。
            let commitInWindow: boolean | undefined = false;
            try {
              commitInWindow = await hasCommitInTaskWindow(
                await resolveTaskRepoRoot(db, task),
                task.attempts,
                task.checkpointRef,
              );
            } catch {
              commitInWindow = undefined;
            }
            if (commitInWindow === true) {
              // 匹配到但被提交闸掉:diffSummary 留可读说明,便于事后区分
              // 「没匹配到」与「匹配到但被闸掉」(spec 验收 5/6)。
              summaryToWrite = {
                ...rawSummary,
                quotaMatchedButCommitFound: {
                  matchedLine: quotaVerdict.matchedLine,
                  note: "error 命中额度关键词,但任务窗口内存在提交(本次运行有产出),按 quota-failure-on-clean-exit v1.1 R6 不判额度、不进入冷却",
                },
              };
            } else {
              const parsedMs = parseRateLimitRecoveryMs(errorText);
              const cooldownEnd = normalizeCooldownEnd(
                parsedMs ?? Date.now() + getRateLimitCooldownMs(),
              );
              const extra: Record<string, unknown> = {
                [EXECUTOR_COOLDOWN_END_MS_FIELD]: cooldownEnd,
                ...(quotaVerdict.matchedLine !== null
                  ? { quotaMatchedLine: quotaVerdict.matchedLine }
                  : {}),
              };
              if (
                parsedMs !== null &&
                parsedMs <= Date.now() + MIN_EFFECTIVE_COOLDOWN_MS
              ) {
                extra.cooldownFallbackReason =
                  "解析所得时刻不可用,已回退固定冷却";
                extra.discardedCooldownEndMs = parsedMs;
              }
              summaryToWrite = { ...rawSummary, ...extra };
              quotaCooldownEnd = cooldownEnd;
              quotaErrorText = errorText;
              quotaEx = task.executorKey
                ? await findExecutorByKey(db, task.executorKey)
                : undefined;
            }
          }
        }
      }
      const [updated] = await db
        .update(taskTable)
        .set({
          ...(status !== undefined ? { status } : {}),
          ...(diffSummary !== undefined ? { diffSummary: summaryToWrite } : {}),
          ...(checkpointRef !== undefined ? { checkpointRef } : {}),
          ...(brief !== undefined ? { brief } : {}),
          ...(terminalTransition && recipientsToWrite !== undefined
            ? { recipientParticipantIds: recipientsToWrite }
            : {}),
        })
        .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, id)))
        .returning();
      // 外部执行器客户端通过 PATCH 推进状态 → 同样推送 task_status_changed
      // (仅当 status 实际变更时;否则订阅者会收到无变化的重复事件)。
      if (updated && status !== undefined && updated.status !== task.status) {
        await notifyTaskStatusChanged(
          db,
          updated.id,
          updated.groupId,
          status,
          updated,
        );
        if (isTerminalTaskStatus(status)) {
          try {
            const activity = await recordCoordinationActivity(db, updated);
            if (activity?.childTaskCount === 0) {
              await createTaskDispatchWarnings(
                db,
                updated.groupId,
                updated.id,
                updated.executorParticipantId,
              );
            }
          } catch (error) {
            console.warn(
              `[coordination] activity audit failed (${updated.id}), task remains terminal:`,
              error,
            );
          }
        }
      }
      // R8(v1.1):额度冷却与群内留痕在落库后触发(与 queue 路径同口径)。
      if (quotaCooldownEnd !== undefined && quotaEx) {
        enterCooldown(quotaEx, quotaCooldownEnd, { db, taskId });
        const eta = formatEta(quotaCooldownEnd);
        void postStatus(
          db,
          id,
          task.executorParticipantId,
          quotaEx,
          `❌ [${quotaEx.label}] 任务失败 (执行器额度限制,预计 ${eta} 恢复)\n${quotaErrorText}`,
        );
      }
      return c.json(updated);
    },
  );

export default app;
