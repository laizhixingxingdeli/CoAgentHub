/**
 * 早上的交接面：一屏看完方案这一晚走到哪、为什么停、要你定什么。
 *
 * **唯一的设计原则：每个非成功项都写「要你定什么」**，不只是「哪里错了」——
 * 早上看的人要的是下一步该拍板的那件事，不是再去翻日志还原现场。这一条由
 * PlanRun 在进 ⏸ / ⊘ 的每条路径上强制带 `needsDecision` 兜底，这里照抄。
 *
 * 首行给用时 / 墙钟、总花销、停止原因与未解决计数：阈值是拍脑袋定的（8 小时、
 * 5 次、20 分钟），用户要拿每一晚的这一行去校准它们。
 *
 * 纯函数：数据由调用方（`l3.ts plan`）取好传进来。
 */

import type { PlanFeatureRecord, PlanRun, PlanStopReason } from './plan-run.ts';

export const PLAN_MARKS = Object.freeze({
  merged: '✓',
  suspended: '⏸',
  skipped: '⊘',
  pending: '○',
  running: '▶',
} as const);

const STOP_LABELS: Record<PlanStopReason, string> = {
  unresolved_escalations: '未解决升级到上限',
  wall_clock: '墙钟到点',
  reviewer_stop: '检视者叫停',
  finished: '走完了',
  unsafe: '集成分支不安全',
  crashed: '驱动方出错',
  escalation_limit: '升级单到上限',
};

export interface HandoffCosts {
  /** 这一晚各条 Mission 报上来的花销之和（美元）。 */
  readonly missions: number;
  /** 现做分类的只读会话花销之和（美元）。 */
  readonly routing: number;
  /** 没报花销的运行条数：不把未知当 0。 */
  readonly unknownRuns: number;
}

function duration(ms: number): string {
  if (ms < 3_600_000) return `${Math.max(0, Math.round(ms / 60_000))}m`;
  return `${(ms / 3_600_000).toFixed(1).replace(/\.0$/, '')}h`;
}

function costText(costs: HandoffCosts | undefined): string {
  if (!costs) return '花销未知';
  const total = costs.missions + costs.routing;
  return (
    `花销 $${total.toFixed(2)}（Mission $${costs.missions.toFixed(2)} + 分类 $${costs.routing.toFixed(2)}` +
    `${costs.unknownRuns > 0 ? `，另有 ${costs.unknownRuns} 条没报花销` : ''}）`
  );
}

function featureTail(
  feature: PlanFeatureRecord,
  stopped: boolean,
  pendingRelease?: { missionId: string; deadline: string },
): string {
  const last = feature.missionIds.at(-1);
  switch (feature.status) {
    case 'merged':
      return `合入（${last ?? '?'}）`;
    case 'running':
      return pendingRelease
        ? `HA 待放行，等检视者决定（Mission ${pendingRelease.missionId}，截止 ${pendingRelease.deadline}）`
        : `在跑（${last ?? '?'}）`;
    case 'pending':
      return stopped
        ? '没轮到。要你定：下一轮接着跑它吗（run-plan 只跑没标 done 的）？'
        : '排队中';
    default:
      // ⏸ / ⊘：PlanRun 保证一定带着要人定什么。
      return feature.needsDecision ?? '要你定：（记录里没写原因——这不该发生，去翻升级单）';
  }
}

export function renderPlanHandoff(
  run: PlanRun,
  context: { readonly now: string; readonly costs?: HandoffCosts; readonly recordPath?: string },
): string[] {
  const stop = run.stopped;
  const end = stop ? Date.parse(stop.at) : Date.parse(context.now);
  const elapsed = duration(end - Date.parse(run.startedAt));
  const status = stop ? `停了：${STOP_LABELS[stop.reason]}——${stop.detail}` : '还在跑';
  const lines = [
    `方案 ${run.planId}（${run.id}）  ${status}  用时 ${elapsed} / 墙钟 ${duration(run.stopConditions.wallClockMs)}  ` +
      `${costText(context.costs)}  未解决 ${run.unresolvedCount}/${run.stopConditions.unresolvedEscalations}` +
      `  升级单 ${run.escalationsOpened}/${run.stopConditions.maxEscalations}`,
    `  ${PLAN_MARKS.merged} 已合入  ${PLAN_MARKS.suspended} 挂起等你  ${PLAN_MARKS.skipped} 检视者跳过  ${PLAN_MARKS.pending} 没轮到`,
  ];
  const release = run.haReleases.find((item) => !item.decision);
  const open = run.currentEscalation;
  for (const feature of run.features) {
    const title = feature.title ? `${feature.title}  ` : '';
    const used = run.rerunsUsed(feature.featureId);
    // 没重跑过、也没开着单的功能不占这一列，免得六个都绿的晚上刷一排 0/1。
    const rerun =
      used > 0 || open?.featureId === feature.featureId
        ? `  重跑 ${used}/${run.stopConditions.maxRerunsPerFeature}`
        : '';
    const currentMission = feature.missionIds.at(-1);
    const pendingForFeature = run.haReleases.find(
      (item) => item.featureId === feature.featureId && item.missionId === currentMission && !item.decision,
    );
    lines.push(
      `  ${PLAN_MARKS[feature.status]} ${feature.featureId} ${title}` +
        `${featureTail(feature, Boolean(stop), pendingForFeature)}${rerun}`,
    );
  }
  for (const record of run.haReleases) {
    const decision = record.decision;
    if (!decision) continue;
    const feature = run.feature(record.featureId);
    const by = decision.by ? `${decision.by} 经 ${decision.confirmedBy ?? '确认人未知'} 确认` : '';
    const reason = decision.reason ? `；理由：${decision.reason}` : '';
    const result =
      decision.kind !== 'approve'
        ? ''
        : feature?.status === 'merged'
          ? '；已合入'
          : feature?.status === 'running'
            ? '；受控合入进行中'
            : '；未合并（原因见该功能那一行）';
    lines.push(
      `  ⚑ HA 放行记录 ${record.featureId} / Mission ${record.missionId}：${decision.kind}（${decision.at}）` +
        `${by ? `；${by}` : ''}${reason}${result}`,
    );
  }
  if (release && !release.decision && !stop && Date.parse(context.now) < Date.parse(release.deadline)) {
    lines.push(`  ⚑ HA 待放行 ${release.featureId}：Mission ${release.missionId}，提交 ${release.reviewedCommit}，检视 ${release.attemptId}，报告 ${release.validationReportId}，截止 ${release.deadline}`);
    const common = `--feature ${release.featureId} --commit ${release.reviewedCommit} --review ${release.attemptId} --report ${release.validationReportId} --target ${release.integrationBranch} --as ${release.reviewerId} --confirmed-by <确认人> --run "${context.recordPath ?? '<记录路径>'}"`;
    lines.push(`    node src/l3.ts plan approve ${release.missionId} ${common}`);
    lines.push(`    node src/l3.ts plan send-back ${release.missionId} ${common} --reason "…"`);
  }
  if (open && !stop) {
    lines.push(`  ⚑ 升级单 ${open.id}（${open.featureId}，${open.deadline} 截止）：${open.failure}`);
    const rerunLeft = run.rerunsUsed(open.featureId) < run.stopConditions.maxRerunsPerFeature;
    const actions = rerunLeft ? '<rerun_isolated|skip|rescope|stop>' : '<skip|rescope|stop>';
    lines.push(
      `    检视者：node src/l3.ts plan decide ${open.id} --action ${actions} ` +
        `--reason "…" [--drop F7,F8] --as ${run.reviewer}` +
        (context.recordPath ? ` --run "${context.recordPath}"` : ''),
    );
  }
  const excluded = run.sourceExclusions;
  if (excluded && excluded.length > 0) {
    // 单独一段：源 skipped 不是本次运行的检视者跳过，不能用 ⊘。
    lines.push('  本次未纳入（源方案，不是本次运行的检视者跳过）：');
    for (const ex of excluded) {
      const source = ex.sourceStatus ?? '旧格式';
      lines.push(`  · ${ex.featureId} 源状态 ${source}  ${ex.reason}`);
    }
  }
  return lines;
}
