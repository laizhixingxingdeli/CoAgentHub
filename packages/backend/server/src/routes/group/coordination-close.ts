/**
 * 协调任务结案完整性校验(从 routes/group/tasks.ts 抽出)。
 * 依赖 l3-answer 的 L3 判定 helper;不得反向依赖 tasks。
 */

import { existsSync } from "node:fs";
import type { task as taskTable } from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import type { DataBase } from "@server/lib/database";
import { isDetachedTask } from "@server/lib/detached-task-liveness";
import {
  judgeTwoPartyDegradation,
  type TwoPartyDegradation,
} from "@server/lib/executor-availability";
import {
  findRepoRoot,
  gitExec,
  pathsReferToSameDir,
} from "@server/lib/executor-runner";
import {
  applyDiffSummaryPatch,
  groupHasReviewerMember,
  isResumeTask,
  isTerminalTaskStatus,
  registerCloseGuardResume,
  resolveTaskRepo,
  reviewRequestCarryAllowed,
  writeTaskStatus,
} from "@server/lib/executor-task";
import { verifyCommitExists } from "@server/lib/executor-task/claim-verification";
import { deriveL1Aggregate } from "@server/lib/l1-aggregate";
import { getRuntimeStatus } from "@server/lib/runtime-status";
import {
  clearWritebackRejections,
  formatWritebackRejectionTripError,
  getWritebackRejectionLimit,
  recordWritebackRejection,
} from "@server/lib/writeback-rejection";
import {
  reviewRequestLiteFlag,
  shouldWalkL3,
  summaryHasReviewRequest,
} from "./l3-answer";

type TaskRow = typeof taskTable.$inferSelect;

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

/**
 * 结案拒绝文案。陈旧运行时提示只在「群绑定项目路径 = 平台自身仓库」时追加:
 * runtime.stale 是进程全局状态,对其他项目的执行器是错误排查方向。
 * 在 rejectCoordinationClose 入口查群路径,避免改 9 处调用点签名。
 */
export function coordinationCloseError(
  message: string,
  groupProjectPath: string | null,
): BizError {
  const runtime = getRuntimeStatus();
  if (!runtime.stale || !isPlatformOwnProjectPath(groupProjectPath)) {
    return new BizError(BizCodeEnum.InvalidRequest, message);
  }
  return new BizError(
    BizCodeEnum.InvalidRequest,
    `${message} 注意:当前运行时为陈旧构建(staleReason: ${runtime.staleReason}),本次拒绝可能来自旧版守卫;若已在源码中修改结案规则,请在发起方重启后重试回写。`,
  );
}

/** 群 project_path 是否就是平台仓库根(findRepoRoot / COAGENTHUB_REPO_ROOT)。 */
export function isPlatformOwnProjectPath(
  groupProjectPath: string | null | undefined,
): boolean {
  if (!groupProjectPath) return false;
  return pathsReferToSameDir(groupProjectPath, findRepoRoot());
}

/**
 * 结案守卫拒绝的唯一出口包装:按任务累加连续被拒次数,触顶则平台主动
 * 把该任务判 failed(diffSummary 含次数与最后一次拒绝原文),再抛原 400。
 * 已终态任务只抛错、不再计数/改写(避免 done 后误伤)。
 */
export async function rejectCoordinationClose(
  db: DataBase,
  task: TaskRow,
  message: string,
): Promise<never> {
  const group = await db.query.groups.findFirst({
    where: (g, { eq }) => eq(g.id, task.groupId),
  });
  const err = coordinationCloseError(message, group?.projectPath ?? null);
  if (!isTerminalTaskStatus(task.status)) {
    const streak = recordWritebackRejection(task.id, message);
    const limit = getWritebackRejectionLimit();
    if (streak.count >= limit) {
      await forceFailWritebackRejectionLoop(db, task, streak.count, message);
      clearWritebackRejections(task.id);
    }
  }
  throw err;
}

/**
 * 连续回写被拒触顶 → 任务 failed。error 必含次数与最后原文;platform 块
 * 附结构化字段便于排障。通知与普通终态路径同口径。
 */
export async function forceFailWritebackRejectionLoop(
  db: DataBase,
  task: TaskRow,
  count: number,
  lastMessage: string,
): Promise<void> {
  const limit = getWritebackRejectionLimit();
  const error = formatWritebackRejectionTripError(count, limit, lastMessage);
  const diffSummary = applyDiffSummaryPatch(task.diffSummary, {
    error,
    platform: {
      writebackRejectionTrip: {
        count,
        limit,
        lastMessage,
      },
    },
  });
  // 原路径 where 含 groupId;notify 默认 true。
  // notifyTaskStatusChanged 内部已吞异常;外层 try/catch 原本也捕不到它抛出。
  await writeTaskStatus(db, {
    taskId: task.id,
    groupId: task.groupId,
    status: "failed",
    diffSummary,
  });
}

export function parseAlreadySatisfiedClaim(
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

export async function validateAlreadySatisfiedClaim(
  db: DataBase,
  task: TaskRow,
  repoRoot: string,
  claim: AlreadySatisfiedClaim,
): Promise<"verified" | "unavailable"> {
  for (const hash of claim.commits) {
    const existence = await verifyCommitExists(hash, repoRoot);
    if (existence === "not_found") {
      await rejectCoordinationClose(
        db,
        task,
        `alreadySatisfied.commits 中的提交 ${hash} 在仓库中不存在。`,
      );
    }
    if (existence === undefined) return "unavailable";
  }
  return "verified";
}

/** 从子任务自身的 diffSummary 提取 claimVerification.status(读子任务,不读协调任务)。 */
export function childClaimVerificationStatus(raw: unknown): string | undefined {
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
export async function commitsInTaskWindow(
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
export async function resolveTaskRepoRoot(
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
export async function assertCoordinationCloseIntegrity(
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
    ? await validateAlreadySatisfiedClaim(db, task, repoRoot, alreadySatisfied)
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
      await rejectCoordinationClose(
        db,
        task,
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
      // R1(specs/detached-close-deadlock-guard-vs-no-poll.md):拒绝的同时登记
      // 一次待续跑 —— 协调者按 skill 规则不得轮询等待,退出后靠续跑任务被重新
      // 拉起。守卫本身(子任务非终态不得结案)逐字不变,本处只补交接。
      // R3:登记内容写进 diffSummary.platform.closeGuardResume(被谁挡住的
      // id + 当时状态、是否已登记),不再只留在 error 自由文本里。
      // blockedBy 与拒绝文案取同一个数组,两者不漂移。
      const blockedBy = nonTerminal.map((child) => ({
        id: child.id,
        status: child.status,
      }));
      const resumeRegistered = await registerCloseGuardResume(
        db,
        task,
        blockedBy,
      );
      await rejectCoordinationClose(
        db,
        task,
        `L1 层未完成:存在非终态执行子任务: ${nonTerminal
          .map((child) => `${child.id} (${child.status})`)
          .join(", ")}` +
          (resumeRegistered
            ? ";平台已为本次拒绝登记待续跑:子任务落终态时会创建续跑任务把协调者重新拉起,无需轮询等待"
            : ";平台登记待续跑失败,协调者需自行安排续跑(见 diffSummary.platform.closeGuardResume.registrationError)"),
      );
    }
  }

  // R2:应走 L3(v4.1 spec §3.14.6:三方在场,任何 dispatchKind)时,
  // review_request 不得缺失;fix 票另要求带 lite:true(精简档)。
  const groupHasReviewer = await groupHasReviewerMember(db, task.groupId);
  if (await shouldWalkL3(db, task, groupHasReviewer)) {
    if (!summaryHasReviewRequest(diffSummary)) {
      await rejectCoordinationClose(
        db,
        task,
        "本协调任务应走 L3 三方检视,但 diffSummary 缺少 review_request 交接载荷(群内 reviewer 与 coordinator 同时在场)。",
      );
    }
    if (task.dispatchKind === "fix" && !reviewRequestLiteFlag(diffSummary)) {
      await rejectCoordinationClose(
        db,
        task,
        'fix 票的 review_request 必须带 "lite": true(L3 精简档:免 spec 对照,只检 diff 架构质量)。',
      );
    }
  }

  // R3:反向守卫——不该走 L3 时不得产出 review_request。
  // v4.1:携带与否只由群成员构成裁定(无 reviewer 时两层编制不跑 L3);
  // dispatchKind 只选择深度(lite),不决定是否携带。
  // dispatchKind 为 null 的历史行保守按 requirement 处理,不拒绝。
  // 判定与任务书 buildReportSection 共用(review-request-policy),两处不漂移。
  if (summaryHasReviewRequest(diffSummary)) {
    if (!reviewRequestCarryAllowed(task.dispatchKind, groupHasReviewer)) {
      await rejectCoordinationClose(
        db,
        task,
        "群内无 reviewer 成员,不得携带 review_request。",
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
      await rejectCoordinationClose(
        db,
        task,
        `子任务 ${child.id} 的提交核实结论为 ${status},必须在 diffSummary.claimAdjudication["${child.id}"] 中显式表态(accepted 布尔 + 非空 reason)。`,
      );
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.accepted !== "boolean") {
      await rejectCoordinationClose(
        db,
        task,
        `子任务 ${child.id} 的 claimAdjudication.accepted 缺失或非布尔,必须显式给出 true 或 false。`,
      );
    }
    const reason = typeof e.reason === "string" ? e.reason : "";
    if (reason.trim() === "") {
      await rejectCoordinationClose(
        db,
        task,
        `子任务 ${child.id} 的 claimAdjudication.reason 为空,必须填写非空理由。`,
      );
    }
  }

  // 一次成功通过结案守卫 → 连续被拒计数清零(否则历史失败会拖死长活跃任务)。
  clearWritebackRejections(task.id);

  // R4:done 分支结束时同样携带平台判定的降级载荷(零执行子任务 + 平台判定
  // 无可用执行器时才有;有可用执行器时为 undefined,不写字段)。
  return degradedToTwoParty !== undefined ? { degradedToTwoParty } : undefined;
}
