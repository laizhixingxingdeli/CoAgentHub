import type { UsedProfile, IndependentReviewBlockReason, IndependentReviewL2Ref, IndependentReviewRecord, IndependentReviewVerdict, Mission, Attempt, ValidationReport } from '../../kernel/index.ts';
import type { QueueClaimIdentity } from './types.ts';
import { PlatformContext, PlatformRuleError, ATTEMPT_STARTED_KIND } from './context.ts';
import { queuedAttemptStartedData } from './attempts.ts';

export async function startIndependentReviewerAttempt(ctx: PlatformContext, 
    missionId: string,
    candidates: readonly UsedProfile[],
    claim?: QueueClaimIdentity,
  ): Promise<
    | { ok: true; attemptId: string; profileId: string }
    | { ok: false; code: string; detail: string }
  > {
    const { mission } = await ctx.locate(missionId);
    const blocked = independentReviewOpenBlock(ctx, mission, candidates);
    if (blocked) {
      mission.recordIndependentReviewBlock(blocked.reason, blocked.detail);
      await ctx.event(mission, 'independent_review.blocked', blocked);
      return { ok: false, code: blocked.code, detail: blocked.detail };
    }

    const excluded = participantProfileIds(ctx, mission);
    if (!excluded) {
      const detail =
        '本 Mission 有历史协调者或执行者 Attempt 缺 profileId，无法证明独立，拒绝开检视。';
      mission.recordIndependentReviewBlock('history_missing_profile', detail);
      await ctx.event(mission, 'independent_review.blocked', {
        reason: 'history_missing_profile',
        detail,
      });
      return { ok: false, code: 'INDEPENDENT_REVIEW_HISTORY_MISSING_PROFILE', detail };
    }

    const picked = candidates.find(
      (row) => row.profileId && !excluded.has(row.profileId),
    );
    if (!picked) {
      const hasAny = candidates.some((row) => typeof row.profileId === 'string' && row.profileId.trim() !== '');
      const reason: IndependentReviewBlockReason = hasAny ? 'all_candidates_conflict' : 'no_candidates';
      const detail = hasAny
        ? '独立检视候选全部与本 Mission 历史协调者或执行者 profileId 冲突，拒绝自审。'
        : '候选池没有 independent_reviewer 候选，拒绝开检视。';
      mission.recordIndependentReviewBlock(reason, detail);
      await ctx.event(mission, 'independent_review.blocked', { reason, detail });
      return {
        ok: false,
        code: hasAny ? 'INDEPENDENT_REVIEW_ALL_CONFLICT' : 'INDEPENDENT_REVIEW_NO_CANDIDATES',
        detail,
      };
    }

    let reviewedCommit: string;
    try {
      reviewedCommit = await missionReviewedCommit(ctx, mission);
    } catch (error) {
      const detail =
        error instanceof PlatformRuleError
          ? error.message
          : '读不到 Mission worktree 的 HEAD，拒绝开检视。';
      mission.recordIndependentReviewBlock('reviewed_commit_unavailable', detail);
      await ctx.event(mission, 'independent_review.blocked', {
        reason: 'reviewed_commit_unavailable',
        detail,
      });
      return { ok: false, code: 'REVIEWED_COMMIT_UNAVAILABLE', detail };
    }
    const l2 = l2ReviewSnapshot(ctx, mission);
    let validationReportId = l2.validationReportId;
    if (mission.executionMode === 'high_assurance') {
      const fromHa = await currentHaValidationReport(ctx, 
        mission.id,
        reviewedCommit,
        l2.fingerprint,
        mission.contractRevision,
      );
      // 开审不得回退 L2 validator 报告：没有当前 HA 报告就 fail-closed，不建 Attempt。
      if (!fromHa || !fromHa.passed) {
        const detail =
          '当前 HEAD、契约与 L2 没有通过的 HA 确定性验证报告，拒绝开检视。';
        return { ok: false, code: 'INDEPENDENT_REVIEW_HA_REPORT_MISSING', detail };
      }
      validationReportId = fromHa.id;
    }
    const attempt = mission.startIndependentReviewerAttempt({
      contractRevision: mission.contractRevision,
      reviewedCommit,
      l2Fingerprint: l2.fingerprint,
      l2ReviewRefs: l2.refs,
      ...(validationReportId !== undefined ? { validationReportId } : {}),
    });
    attempt.recordProfile(picked);
    await ctx.event(
      mission,
      ATTEMPT_STARTED_KIND,
      queuedAttemptStartedData({ kind: 'independent_reviewer', profile: picked }, claim),
      undefined,
      attempt.id,
    );
    return { ok: true, attemptId: attempt.id, profileId: picked.profileId };
  }

export async function getMissionReviewBundle(ctx: PlatformContext, 
    missionId: string,
    attemptId: string,
  ): Promise<{
    missionId: string;
    contractRevision: number;
    reviewedCommit: string;
    l2ItemResults: readonly {
      workItemId: string;
      submittedAttemptId?: string;
      reviewAttemptId?: string;
      verdict?: string;
      acceptanceResults?: unknown;
    }[];
    validationReportRefs: readonly { id: string }[];
  }> {
    const { mission } = await ctx.requireAttempt(missionId, attemptId, 'independent_reviewer');
    const l2 = l2ReviewSnapshot(ctx, mission);
    const reviewedCommit =
      mission.independentReviewOpen?.attemptId === attemptId
        ? mission.independentReviewOpen.reviewedCommit
        : await missionReviewedCommit(ctx, mission);
    const reportIds = new Set<string>();
    if (l2.validationReportId) reportIds.add(l2.validationReportId);
    if (mission.independentReviewOpen?.validationReportId) {
      reportIds.add(mission.independentReviewOpen.validationReportId);
    }
    return {
      missionId: mission.id,
      contractRevision: mission.contractRevision,
      reviewedCommit,
      l2ItemResults: l2.items,
      validationReportRefs: [...reportIds].map((id) => ({ id })),
    };
  }

export async function submitIndependentReview(ctx: PlatformContext, 
    missionId: string,
    attemptId: string,
    input: { readonly verdict: unknown; readonly reasons: unknown },
  ): Promise<{ recorded: IndependentReviewRecord }> {
    const { mission, attempt } = await ctx.requireAttempt(
      missionId,
      attemptId,
      'independent_reviewer',
    );
    if (input.verdict !== 'pass' && input.verdict !== 'send_back') {
      throw new PlatformRuleError(
        'INDEPENDENT_REVIEW_INVALID',
        'verdict 必须是 pass 或 send_back。',
      );
    }
    if (
      !Array.isArray(input.reasons) ||
      input.reasons.length === 0 ||
      input.reasons.some((r) => typeof r !== 'string' || r.trim() === '')
    ) {
      throw new PlatformRuleError(
        'INDEPENDENT_REVIEW_INVALID',
        'reasons 必须是非空字符串数组。',
      );
    }
    const verdict = input.verdict as IndependentReviewVerdict;
    const reasons = input.reasons as readonly string[];
    const open = mission.independentReviewOpen;
    if (!open || open.attemptId !== attemptId) {
      throw new PlatformRuleError(
        'INDEPENDENT_REVIEW_OPEN_MISSING',
        '没有与本次 Attempt 对应的开审对照，拒绝收结论。',
      );
    }

    const headNow = await missionReviewedCommit(ctx, mission);
    const l2Now = l2ReviewSnapshot(ctx, mission);
    const profileId = attempt.profile?.profileId;
    if (!profileId) {
      throw new PlatformRuleError(
        'INDEPENDENT_REVIEW_PROFILE_REQUIRED',
        '本次检视 Attempt 缺 profileId，无法记下独立结论。',
      );
    }

    if (verdict === 'pass') {
      if (mission.contractRevision !== open.contractRevision) {
        throw new PlatformRuleError(
          'INDEPENDENT_REVIEW_REVISION_CHANGED',
          `契约已从 r${open.contractRevision} 变到 r${mission.contractRevision}，旧对照不能 pass。`,
        );
      }
      if (headNow !== open.reviewedCommit) {
        throw new PlatformRuleError(
          'INDEPENDENT_REVIEW_HEAD_CHANGED',
          '被审 HEAD 已变化，拒绝记录 pass。',
        );
      }
      if (l2Now.fingerprint !== open.l2Fingerprint) {
        throw new PlatformRuleError(
          'INDEPENDENT_REVIEW_EVIDENCE_CHANGED',
          '被引用的 L2 逐条结果已变化，拒绝记录 pass。',
        );
      }
      if (!l2RefsBelongToMission(ctx, mission, open.l2ReviewRefs) || open.l2ReviewRefs.length === 0) {
        throw new PlatformRuleError(
          'INDEPENDENT_REVIEW_L2_MISSING',
          'L2 逐条结果引用缺失或不属本 Mission，拒绝 pass。',
        );
      }
      if (mission.executionMode === 'high_assurance') {
        const ha = await currentHaValidationReport(ctx, 
          mission.id,
          headNow,
          l2Now.fingerprint,
          mission.contractRevision,
        );
        // 收 pass 同样只认当前 HA 报告，避免开审后改用 L2 validator 报告凑。
        if (!ha || !ha.passed || open.validationReportId !== ha.id) {
          throw new PlatformRuleError(
            'INDEPENDENT_REVIEW_REPORT_MISSING',
            '当前没有通过且属于本提交的 HA 确定性验证报告，不能 pass。',
          );
        }
        const report = await ctx.validation?.reports.get(ha.id);
        if (!report || report.missionId !== mission.id || report.passed !== true) {
          throw new PlatformRuleError(
            'INDEPENDENT_REVIEW_REPORT_MISSING',
            'HA 确定性验证报告不存在、不属本 Mission 或未通过，不能 pass。',
          );
        }
      } else {
        const reportId = open.validationReportId ?? l2Now.validationReportId;
        if (!reportId) {
          throw new PlatformRuleError(
            'INDEPENDENT_REVIEW_REPORT_MISSING',
            '缺 ValidationReport，不能 pass。',
          );
        }
        const report = await ctx.validation?.reports.get(reportId);
        if (!report || report.missionId !== mission.id) {
          throw new PlatformRuleError(
            'INDEPENDENT_REVIEW_REPORT_MISSING',
            'ValidationReport 不存在或不属本 Mission，不能 pass。',
          );
        }
      }
    }

    const recorded = mission.recordIndependentReview(attemptId, {
      reviewerProfileId: profileId,
      contractRevision: open.contractRevision,
      reviewedCommit: open.reviewedCommit,
      l2ReviewRefs: open.l2ReviewRefs,
      l2Fingerprint: open.l2Fingerprint,
      verdict,
      reasons,
      recordedAt: ctx.clock.now().toISOString(),
      ...(open.validationReportId !== undefined
        ? { validationReportId: open.validationReportId }
        : {}),
    });
    await ctx.event(
      mission,
      'independent_review.recorded',
      {
        verdict: recorded.verdict,
        reviewerAttemptId: recorded.reviewerAttemptId,
        contractRevision: recorded.contractRevision,
        reviewedCommit: recorded.reviewedCommit,
      },
      undefined,
      attemptId,
    );
    return { recorded };
  }

export async function effectiveIndependentReviewPass(ctx: PlatformContext, 
    missionId: string,
  ): Promise<IndependentReviewRecord | undefined> {
    const { mission } = await ctx.locate(missionId);
    let head: string;
    try {
      head = await missionReviewedCommit(ctx, mission);
    } catch {
      return undefined;
    }
    const fingerprint = l2ReviewSnapshot(ctx, mission).fingerprint;
    const currentReport = await currentHaValidationReport(ctx, 
      mission.id,
      head,
      fingerprint,
      mission.contractRevision,
    );
    // HA：没有当前证据下 passed 的 HA 报告就不能认 pass，不能拿别的已通过报告凑。
    if (mission.executionMode === 'high_assurance' && (!currentReport || !currentReport.passed)) {
      return undefined;
    }
    for (let i = mission.independentReviews.length - 1; i >= 0; i -= 1) {
      const row = mission.independentReviews[i]!;
      if (row.contractRevision !== mission.contractRevision) continue;
      if (row.reviewedCommit !== head) continue;
      if (row.l2Fingerprint !== fingerprint) continue;
      if (row.verdict === 'send_back') return undefined;
      if (row.verdict !== 'pass') continue;
      if (!row.validationReportId) return undefined;
      if (mission.executionMode === 'high_assurance') {
        if (!currentReport?.passed || row.validationReportId !== currentReport.id) return undefined;
      } else if (currentReport && (!currentReport.passed || row.validationReportId !== currentReport.id)) {
        return undefined;
      }
      const report = await ctx.validation?.reports.get(row.validationReportId);
      if (!report || report.missionId !== mission.id || report.passed !== true) return undefined;
      return row;
    }
    return undefined;
  }

export async function currentHaValidationReport(ctx: PlatformContext, 
    missionId: string,
    head: string,
    fingerprint: string,
    contractRevision: number,
  ): Promise<
    | {
        id: string;
        passed: boolean;
        workItemIds?: readonly string[];
        commands?: readonly { argv: readonly string[]; timeoutMs: number }[];
      }
    | undefined
  > {
    const events = await ctx.activity.list(missionId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!;
      if (event.kind !== 'validation.reported') continue;
      const data = event.data;
      if (data == null || typeof data !== 'object' || Array.isArray(data)) continue;
      const row = data as {
        purpose?: unknown;
        reportId?: unknown;
        passed?: unknown;
        reviewedCommit?: unknown;
        l2Fingerprint?: unknown;
        contractRevision?: unknown;
        workItemIds?: unknown;
        commands?: unknown;
      };
      if (row.purpose !== 'ha_deterministic') continue;
      if (row.reviewedCommit !== head) continue;
      if (row.l2Fingerprint !== fingerprint) continue;
      if (row.contractRevision !== contractRevision) continue;
      if (typeof row.reportId !== 'string') return undefined;
      const report = await ctx.validation?.reports.get(row.reportId);
      // 事件对得上但仓储里没有这份报告，不能拿事件自己的 passed 凑。
      if (!report || report.missionId !== missionId) return undefined;
      const workItemIds = parseHaWorkItemIds(ctx, row.workItemIds);
      const commands = parseHaCommands(ctx, row.commands);
      return {
        id: row.reportId,
        passed: report.passed === true,
        ...(workItemIds ? { workItemIds } : {}),
        ...(commands ? { commands } : {}),
      };
    }
    return undefined;
  }

export function parseHaWorkItemIds(ctx: PlatformContext, value: unknown): readonly string[] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    if (value.some((id) => typeof id !== 'string' || id.trim() === '')) return undefined;
    return value as string[];
  }

export function parseHaCommands(ctx: PlatformContext, 
    value: unknown,
  ): readonly { argv: readonly string[]; timeoutMs: number }[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const rows: { argv: readonly string[]; timeoutMs: number }[] = [];
    for (const item of value) {
      if (item == null || typeof item !== 'object' || Array.isArray(item)) return undefined;
      const row = item as { argv?: unknown; timeoutMs?: unknown };
      if (!Array.isArray(row.argv) || row.argv.some((part) => typeof part !== 'string')) {
        return undefined;
      }
      if (typeof row.timeoutMs !== 'number' || !Number.isFinite(row.timeoutMs)) return undefined;
      rows.push({ argv: row.argv as string[], timeoutMs: row.timeoutMs });
    }
    return rows;
  }

export function frozenHaCommands(ctx: PlatformContext, mission: Mission): { argv: string[]; timeoutMs: number }[] {
    return mission.workItems
      .filter((item) => item.status !== 'retired')
      .flatMap((item) =>
        (item.order?.validation?.commands ?? []).map((command) => ({
          argv: [...command.argv],
          timeoutMs: command.timeoutMs,
        })),
      );
  }

export function sameHaCommands(ctx: PlatformContext, 
    left: readonly { argv: readonly string[]; timeoutMs: number }[],
    right: readonly { argv: readonly string[]; timeoutMs: number }[],
  ): boolean {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      const a = left[i]!;
      const b = right[i]!;
      if (a.timeoutMs !== b.timeoutMs || a.argv.length !== b.argv.length) return false;
      if (a.argv.some((part, j) => part !== b.argv[j])) return false;
    }
    return true;
  }

export function haReuseMatches(ctx: PlatformContext, 
    meta: {
      workItemIds?: readonly string[];
      commands?: readonly { argv: readonly string[]; timeoutMs: number }[];
    },
    report: ValidationReport,
    activeIds: readonly string[],
    frozen: readonly { argv: readonly string[]; timeoutMs: number }[],
  ): boolean {
    // 复用旧报告时必须核覆盖集合与冻结命令；缺字段视为无法证明，拒绝复用。
    if (!meta.workItemIds || !meta.commands) return false;
    if (meta.workItemIds.length !== activeIds.length) return false;
    const covered = new Set(meta.workItemIds);
    if (covered.size !== activeIds.length) return false;
    if (!activeIds.every((id) => covered.has(id))) return false;
    if (!sameHaCommands(ctx, meta.commands, frozen)) return false;
    const reported = report.checks.filter((check) => check.kind === 'command');
    if (reported.length !== frozen.length) return false;
    for (let i = 0; i < frozen.length; i += 1) {
      const argv = reported[i]?.command?.argv;
      const expected = frozen[i]!.argv;
      if (!argv || argv.length !== expected.length) return false;
      if (argv.some((part, j) => part !== expected[j])) return false;
    }
    return true;
  }

export function independentReviewOpenBlock(ctx: PlatformContext, 
    mission: Mission,
    _candidates: readonly UsedProfile[],
  ): { reason: IndependentReviewBlockReason; code: string; detail: string } | undefined {
    if (mission.status !== 'awaiting_review') {
      return {
        reason: 'not_awaiting_review',
        code: 'INDEPENDENT_REVIEW_NOT_AWAITING',
        detail: `Mission ${mission.id} 现在是 ${mission.status}，只能在 awaiting_review 开独立检视。`,
      };
    }
    if (mission.result?.outcome !== 'delivered') {
      return {
        reason: 'not_delivered',
        code: 'INDEPENDENT_REVIEW_NOT_DELIVERED',
        detail: `Mission ${mission.id} 交卷不是 delivered，不能开独立检视。`,
      };
    }
    const unfinished = mission.workItems.filter(
      (item) => item.status !== 'accepted' && item.status !== 'retired',
    );
    if (unfinished.length > 0) {
      return {
        reason: 'work_items_unfinished',
        code: 'INDEPENDENT_REVIEW_WORK_ITEMS_UNFINISHED',
        detail: `还有未验收的工作项：${unfinished.map((i) => i.id).join(', ')}。`,
      };
    }
    if (mission.independentReviewerAttempts.some((a) => a.status === 'in_progress')) {
      return {
        reason: 'concurrent_attempt',
        code: 'INDEPENDENT_REVIEW_CONCURRENT',
        detail: `Mission ${mission.id} 已有 in_progress 的 independent_reviewer Attempt。`,
      };
    }
    return undefined;
  }

export function participantProfileIds(ctx: PlatformContext, mission: Mission): Set<string> | undefined {
    const ids = new Set<string>();
    const attempts: Attempt[] = [...mission.coordinatorAttempts];
    for (const item of mission.workItems) attempts.push(...item.attempts);
    for (const attempt of attempts) {
      const profileId = attempt.profile?.profileId;
      if (typeof profileId !== 'string' || profileId.trim() === '') return undefined;
      ids.add(profileId);
    }
    return ids;
  }

export function missionWorkspaceCwd(ctx: PlatformContext, mission: Mission): string | undefined {
    const root = mission.workspaceRef?.projectRoot;
    if (typeof root !== 'string' || root.trim() === '') return undefined;
    const viaTree = ctx.workspace?.worktreePath?.(mission.id, root);
    const cwd = viaTree ?? root;
    return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined;
  }

export async function missionReviewedCommit(ctx: PlatformContext, mission: Mission): Promise<string> {
    if (!ctx.workspace) {
      throw new PlatformRuleError(
        'REVIEWED_COMMIT_UNAVAILABLE',
        '没有工作区管理，无法核对被审 HEAD。',
      );
    }
    const cwd = missionWorkspaceCwd(ctx, mission);
    if (!cwd) {
      throw new PlatformRuleError(
        'REVIEWED_COMMIT_UNAVAILABLE',
        'Mission 没有 projectRoot，无法核对被审 HEAD。',
      );
    }
    const head = await ctx.workspace.head(cwd);
    if (typeof head !== 'string' || head.trim() === '') {
      throw new PlatformRuleError(
        'REVIEWED_COMMIT_UNAVAILABLE',
        '读不到 Mission worktree 的 HEAD。',
      );
    }
    return head;
  }

export function l2ReviewSnapshot(ctx: PlatformContext, mission: Mission): {
    fingerprint: string;
    refs: IndependentReviewL2Ref[];
    validationReportId?: string;
    items: {
      workItemId: string;
      submittedAttemptId?: string;
      reviewAttemptId?: string;
      verdict?: string;
      acceptanceResults?: unknown;
    }[];
  } {
    const refs: IndependentReviewL2Ref[] = [];
    const items: {
      workItemId: string;
      submittedAttemptId?: string;
      reviewAttemptId?: string;
      verdict?: string;
      acceptanceResults?: unknown;
    }[] = [];
    let validationReportId: string | undefined;
    const canonical: unknown[] = [];
    for (const item of mission.workItems) {
      if (item.status === 'retired') continue;
      const last = item.reviews.at(-1);
      const ref: IndependentReviewL2Ref = {
        workItemId: item.id,
        ...(item.submittedAttemptId !== undefined
          ? { submittedAttemptId: item.submittedAttemptId }
          : {}),
        ...(last?.attemptId !== undefined ? { reviewAttemptId: last.attemptId } : {}),
      };
      refs.push(ref);
      items.push({
        workItemId: item.id,
        ...(item.submittedAttemptId !== undefined
          ? { submittedAttemptId: item.submittedAttemptId }
          : {}),
        ...(last?.attemptId !== undefined ? { reviewAttemptId: last.attemptId } : {}),
        ...(last?.verdict !== undefined ? { verdict: last.verdict } : {}),
        ...(last?.acceptanceResults !== undefined
          ? { acceptanceResults: last.acceptanceResults }
          : {}),
      });
      canonical.push({
        id: item.id,
        status: item.status,
        submittedAttemptId: item.submittedAttemptId ?? null,
        reviews: item.reviews.map((r) => ({
          attemptId: r.attemptId ?? null,
          submittedAttemptId: r.submittedAttemptId ?? null,
          verdict: r.verdict,
          reasons: r.reasons,
          acceptanceResults: r.acceptanceResults ?? null,
          authority: r.authority ?? null,
        })),
      });
      const authority = last?.authority;
      if (authority && authority.kind === 'validator' && !validationReportId) {
        validationReportId = authority.reportId;
      }
    }
    return {
      fingerprint: JSON.stringify(canonical),
      refs,
      items,
      ...(validationReportId !== undefined ? { validationReportId } : {}),
    };
  }

export function l2RefsBelongToMission(ctx: PlatformContext, mission: Mission, refs: readonly IndependentReviewL2Ref[]): boolean {
    // pass 必须能指回真实 L2：每个非 retired WorkItem 都要有 ReviewRecord、
    // 属于本项/本 Mission 的 submitted 与 review Attempt、以及覆盖工单每条验收的结果。
    // 只查 WorkItem 存在会让缺 review / 缺逐条 / 错 reviewAttemptId 的 pass 混过去。
    const active = mission.workItems.filter((item) => item.status !== 'retired');
    if (refs.length !== active.length) return false;
    for (const item of active) {
      const ref = refs.find((row) => row.workItemId === item.id);
      if (!ref) return false;
      const last = item.reviews.at(-1);
      if (!last) return false;

      const submittedAttemptId = item.submittedAttemptId;
      if (!submittedAttemptId || ref.submittedAttemptId !== submittedAttemptId) return false;
      if (last.submittedAttemptId !== undefined && last.submittedAttemptId !== submittedAttemptId) {
        return false;
      }
      const submitted = item.attempts.find((row) => row.id === submittedAttemptId);
      if (
        !submitted ||
        submitted.kind !== 'executor' ||
        submitted.workItemId !== item.id ||
        (submitted.missionId !== undefined && submitted.missionId !== mission.id)
      ) {
        return false;
      }

      const reviewAttemptId = last.attemptId;
      if (!reviewAttemptId || ref.reviewAttemptId !== reviewAttemptId) return false;
      const reviewAttempt = mission.coordinatorAttempts.find((row) => row.id === reviewAttemptId);
      if (
        !reviewAttempt ||
        reviewAttempt.kind !== 'coordinator' ||
        (reviewAttempt.missionId !== undefined && reviewAttempt.missionId !== mission.id)
      ) {
        return false;
      }

      const required = item.order?.acceptance ?? [];
      const results = last.acceptanceResults;
      if (!Array.isArray(results)) return false;
      for (const criterion of required) {
        if (!results.some((row) => row.criterion === criterion)) return false;
      }
    }
    return true;
  }
