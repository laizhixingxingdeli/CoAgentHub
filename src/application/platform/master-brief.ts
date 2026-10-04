import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Mission } from '../../kernel/index.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import { sumUsage } from './usage-helpers.ts';

const execute = promisify(execFile);
const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'blocked']);
async function git(root: string, args: string[]): Promise<string> {
  return (await execute('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}

async function currentFullTest(ctx: PlatformContext, missions: readonly Mission[], head: string) {
  if (!ctx.validation) return { verified: false, reason: '没有可信验证报告仓储' };
  for (const mission of missions) {
    const events = await ctx.activity.list(mission.id);
    for (const event of [...events].reverse()) {
      if (event.kind !== 'final_review.integration_verified') continue;
      const data = event.data as { reportId?: string; passed?: boolean; mergedInto?: string };
      if (data?.mergedInto !== head || data.passed !== true || !data.reportId) continue;
      const report = await ctx.validation.reports.get(data.reportId);
      const full = report?.checks.find((check) => check.kind === 'command'
        && check.command?.argv.length === 2 && check.command.argv[0] === 'node' && check.command.argv[1] === '--test');
      if (report?.passed && report.missionId === mission.id && full?.passed
          && full.command?.exitCode === 0 && full.command.timedOut === false) {
        return { verified: true, reportId: report.id, endedAt: report.endedAt };
      }
    }
  }
  return { verified: false, reason: '当前集成 HEAD 缺少可信全量测试报告，旧提交通过不能替代' };
}

/** 只生成简报和前置检查，绝不执行 master merge。 */
export async function getMasterMergeBrief(ctx: PlatformContext, projectId: string) {
  const project = await ctx.projects.get(projectId);
  if (!project) throw new PlatformRuleError('UNKNOWN_PROJECT', '项目不存在。');
  const roots = new Set(project.missions.map((mission) => mission.workspaceRef?.projectRoot).filter(Boolean));
  if (roots.size !== 1) throw new PlatformRuleError('PROJECT_WORKSPACE_AMBIGUOUS', '项目需有唯一可信 Git 工作区才能生成合并简报。');
  const root = [...roots][0]!;
  const [head, master, branch, dirty, commits, paths] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']), git(root, ['rev-parse', 'refs/heads/master']),
    git(root, ['branch', '--show-current']), git(root, ['status', '--porcelain']),
    git(root, ['log', '--format=%H%x09%s', 'refs/heads/master..HEAD']),
    git(root, ['diff', '--name-only', 'refs/heads/master...HEAD']),
  ]);
  const active = project.missions.filter((mission) => !TERMINAL.has(mission.status)
    && (!mission.isPaused && !mission.isParked
      || [...mission.coordinatorAttempts, ...mission.independentReviewerAttempts, ...mission.workItems.flatMap((item) => item.attempts)]
        .some((attempt) => attempt.status === 'in_progress'))).map((mission) => mission.id);
  const verification = await currentFullTest(ctx, project.missions, head);
  const included: Mission[] = [];
  const revisions = new Set((await git(root, ['rev-list', 'refs/heads/master..HEAD'])).split('\n'));
  for (const mission of project.missions) {
    const merged = mission.finalReview?.mergedInto;
    if (!merged || merged === 'in-place') continue;
    try {
      await git(root, ['merge-base', '--is-ancestor', merged, head]);
      if (revisions.has(merged)) included.push(mission);
    } catch { /* 无法证明已包含时不列入本批。 */ }
  }
  const stable = await git(root, ['rev-parse', 'HEAD']) === head && await git(root, ['branch', '--show-current']) === branch;
  const reasons = [...(!stable ? ['生成简报期间目标分支发生变化，请刷新'] : []),
    ...(branch === 'master' || !branch ? ['当前检出不是集成分支'] : []),
    ...(dirty ? ['目标工作区有未提交改动'] : []), ...(active.length ? ['仍有未结束的 Mission 或 Attempt'] : []),
    ...(!verification.verified ? [verification.reason!] : [])];
  return { projectId, integrationBranch: branch, integrationHead: head, masterHead: master,
    ready: reasons.length === 0, requiresUserSignature: true, reasons, activeMissions: active, verification,
    commits: commits ? commits.split('\n').map((line) => ({ revision: line.split('\t')[0], title: line.slice(line.indexOf('\t') + 1) })) : [],
    changedFiles: paths ? paths.split('\n') : [],
    missions: included.map((mission) => ({ missionId: mission.id, intent: mission.contract.intent,
      criteria: mission.result?.criteria ?? [], risks: mission.result?.openRisks ?? [],
      documentation: mission.result?.memoryDelta.map((proposal) => proposal.title) ?? [], cost: sumUsage(mission).cost ?? null })),
  };
}
