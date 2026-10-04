import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { Project, type MissionContract } from '../../kernel/index.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import { createMission } from './mission-intake.ts';
import { redactSecrets } from '../redact.ts';

export interface ProjectExecutionConfig {
  projectRoot: string;
  adapter: string;
  integrationBranch: string;
  reviewer: string;
  conversationRef: string;
  envPassthrough: string;
  verification: readonly { argv: readonly string[]; timeoutMs: number }[];
}
export interface MissionQueueInput {
  config?: ProjectExecutionConfig;
  expectedRevision: string;
  confirmedBy: string;
  missions: readonly { missionId: string; contract?: MissionContract; dependsOn?: readonly string[] }[];
}
export interface MissionQueueEntry {
  missionId: string;
  position: number;
  dependsOn: readonly string[];
  status: string;
  eligible: boolean;
  blockedBy: readonly string[];
  contract: MissionContract | undefined;
}
export interface MissionQueueView {
  projectId: string;
  config: ProjectExecutionConfig | undefined;
  revision: string;
  entries: readonly MissionQueueEntry[];
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new PlatformRuleError('QUEUE_INPUT_INVALID', `${field} 必须是非空字符串。`);
  return value.trim();
}
export function validateProjectExecutionConfig(input: ProjectExecutionConfig): ProjectExecutionConfig {
  const projectRoot = resolve(text(input?.projectRoot, 'projectRoot'));
  const adapter = resolve(text(input?.adapter, 'adapter'));
  if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory() || !existsSync(adapter) || !statSync(adapter).isFile()) {
    throw new PlatformRuleError('QUEUE_INPUT_INVALID', '项目目录与适配器文件必须真实存在。');
  }
  const integrationBranch = text(input.integrationBranch, 'integrationBranch');
  if (integrationBranch === 'master' || integrationBranch === 'main') throw new PlatformRuleError('QUEUE_MASTER_FORBIDDEN', 'Mission 队列只能使用集成分支。');
  const reviewer = text(input.reviewer, 'reviewer');
  const conversationRef = text(input.conversationRef, 'conversationRef');
  const envPassthrough = text(input.envPassthrough, 'envPassthrough');
  if (!Array.isArray(input.verification) || input.verification.length === 0) throw new PlatformRuleError('QUEUE_INPUT_INVALID', '项目必须配置集成验证命令。');
  const verification = input.verification.map((command) => {
    if (!Array.isArray(command?.argv) || command.argv.length === 0 || command.argv.some((arg) => typeof arg !== 'string')
      || !command.argv[0].trim() || !Number.isFinite(command.timeoutMs) || command.timeoutMs <= 0) {
      throw new PlatformRuleError('QUEUE_INPUT_INVALID', 'verification 必须使用非空 argv 和有限正数 timeoutMs。');
    }
    return { argv: [...command.argv], timeoutMs: command.timeoutMs };
  });
  return { projectRoot, adapter, integrationBranch, reviewer, conversationRef, envPassthrough, verification };
}

export async function readMissionQueue(ctx: PlatformContext, projectId: string): Promise<MissionQueueView> {
  const project = await ctx.projects.get(projectId);
  const settings = (await ctx.activity.list('')).filter((event) => event.projectId === projectId && event.kind === 'project.execution_configured').at(-1);
  const config = (settings?.data as { config?: ProjectExecutionConfig } | undefined)?.config;
  const entries: MissionQueueEntry[] = [];
  for (const mission of project?.missions ?? []) {
    const queued = (await ctx.activity.list(mission.id)).find((event) => event.kind === 'mission.queued');
    if (!queued) continue;
    const data = queued.data as { position: number; dependsOn: string[] };
    const blockedBy = data.dependsOn.filter((id) => project?.missions.find((row) => row.id === id)?.status !== 'completed');
    const status = mission.status;
    const active = [...mission.coordinatorAttempts, ...mission.independentReviewerAttempts, ...mission.workItems.flatMap((item) => item.attempts)]
      .some((attempt) => attempt.status === 'in_progress');
    const waitingGate = mission.waitReason !== undefined && mission.waitReason !== 'no_available_agent' && mission.waitReason !== 'project_busy';
    const holder = project?.missions.find((row) => row.id !== mission.id && row.isMutating);
    entries.push({ missionId: mission.id, position: data.position, dependsOn: data.dependsOn,
      status, blockedBy, contract: mission.contract,
      eligible: blockedBy.length === 0 && !mission.isParked && !mission.isPaused && !active && mission.openEscalations.length === 0
        && status !== 'completed' && status !== 'cancelled' && status !== 'blocked' && status !== 'awaiting_review'
        && !waitingGate && !holder });
  }
  entries.sort((a, b) => a.position - b.position);
  const next = entries.find((entry) => entry.status !== 'completed' && entry.status !== 'cancelled');
  for (const entry of entries) if (entry !== next) entry.eligible = false;
  const revision = createHash('sha256').update(JSON.stringify({ projectId, config,
    entries: entries.map(({ missionId, position, dependsOn }) => ({ missionId, position, dependsOn })) })).digest('hex');
  return { projectId, config, revision, entries };
}

async function checkRevision(ctx: PlatformContext, projectId: string, expected: string) {
  const current = await readMissionQueue(ctx, projectId);
  if (expected !== current.revision) throw new PlatformRuleError('QUEUE_STALE', '项目配置或队列已变化，请刷新后提交。');
  return current;
}
export async function configureProjectExecution(ctx: PlatformContext, projectId: string,
  input: { expectedRevision: string; confirmedBy: string; config: ProjectExecutionConfig }) {
  const config = validateProjectExecutionConfig(input.config);
  const confirmedBy = text(input.confirmedBy, 'confirmedBy');
  await checkRevision(ctx, projectId, input.expectedRevision);
  await ctx.ensureProject(projectId);
  await ctx.activity.append({ projectId, missionId: '', kind: 'project.execution_configured', at: ctx.clock.now().toISOString(), data: { config, confirmedBy } });
  return readMissionQueue(ctx, projectId);
}

export async function enqueueMissions(ctx: PlatformContext, projectId: string, input: MissionQueueInput) {
  const confirmedBy = text(input?.confirmedBy, 'confirmedBy');
  const current = await checkRevision(ctx, projectId, input.expectedRevision);
  const config = input.config ? validateProjectExecutionConfig(input.config) : current.config;
  if (!config) throw new PlatformRuleError('QUEUE_CONFIG_REQUIRED', '先配置项目执行目录、适配器、检视者与集成验证。');
  if (!Array.isArray(input.missions) || input.missions.length === 0) throw new PlatformRuleError('QUEUE_INPUT_INVALID', '必须明确确认非空 Mission 列表。');
  const project = await ctx.projects.get(projectId);
  const known = new Set(project?.missions.map((mission) => mission.id));
  const queued = new Set(current.entries.map((row) => row.missionId));
  const allIds = new Set((await ctx.projects.list()).flatMap((row) => row.missions.map((mission) => mission.id)));
  const scratch = Project.create({ id: projectId });
  const pending = input.missions.map((row) => {
    const id = text(row?.missionId, 'missionId');
    if (queued.has(id) || (allIds.has(id) && !known.has(id))) throw new PlatformRuleError('QUEUE_DUPLICATE', `Mission ${id} 已入队或属于另一项目。`);
    const dependsOn = row.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((dependency) => typeof dependency !== 'string' || !known.has(dependency) || dependency === id)) {
      throw new PlatformRuleError('QUEUE_DEPENDENCY_INVALID', '依赖必须是同项目已有或在本批前面入队的 Mission；不允许前向依赖和环。');
    }
    if (!known.has(id)) {
      if (!row.contract) throw new PlatformRuleError('QUEUE_CONTRACT_REQUIRED', '新入队 Mission 必须提供已冻结契约。');
      scratch.createMission({ id, contract: row.contract });
    } else if (!project?.missions.find((mission) => mission.id === id)?.contract) {
      throw new PlatformRuleError('QUEUE_CONTRACT_REQUIRED', '已有 Mission 必须先冻结契约。');
    }
    if (allIds.has(id) && row.contract) throw new PlatformRuleError('QUEUE_CONTRACT_OVERRIDE', '已有 Mission 的契约必须走修票入口，入队不覆盖契约。');
    known.add(id); queued.add(id);
    return { missionId: id, contract: row.contract, dependsOn: [...new Set(dependsOn)] };
  });
  if (input.config) await configureProjectExecution(ctx, projectId, { config, confirmedBy, expectedRevision: current.revision });
  let position = Math.max(-1, ...current.entries.map((row) => row.position));
  for (const row of pending) {
    if (!allIds.has(row.missionId)) await createMission(ctx, { projectId, missionId: row.missionId, contract: row.contract,
      origin: { reviewer: config.reviewer, clientType: 'cli', conversationRef: config.conversationRef } });
    const { mission } = await ctx.locate(row.missionId);
    await ctx.event(mission, 'mission.queued', { position: ++position, dependsOn: row.dependsOn, confirmedBy });
  }
  return readMissionQueue(ctx, projectId);
}

export async function recordQueuedMissionStart(ctx: PlatformContext, missionId: string) {
  const { mission } = await ctx.locate(missionId);
  const queue = await readMissionQueue(ctx, mission.projectId);
  const entry = queue.entries.find((row) => row.missionId === missionId);
  if (!entry?.eligible || !queue.config) throw new PlatformRuleError('QUEUE_NOT_ELIGIBLE', 'Mission 当前依赖或门禁未放行，不能启动。');
  const config = await queuedExecutionConfig(ctx, missionId) ?? queue.config;
  if ((mission.workspaceRef?.projectRoot && resolve(mission.workspaceRef.projectRoot) !== config.projectRoot)
    || (mission.workspaceRef?.targetBranch && mission.workspaceRef.targetBranch !== config.integrationBranch)) {
    throw new PlatformRuleError('QUEUE_WORKSPACE_MISMATCH', '已有 Mission 工作区与项目执行配置不一致，不能改目录或目标分支续跑。');
  }
  await ctx.event(mission, 'mission.queue_started', { config });
  return config;
}

export async function queuedExecutionConfig(ctx: PlatformContext, missionId: string) {
  const events = await ctx.activity.list(missionId);
  if (!events.some((event) => event.kind === 'mission.queued')) return undefined;
  const pinned = events.filter((event) => event.kind === 'mission.queue_started').at(-1);
  if (pinned) return (pinned.data as { config: ProjectExecutionConfig }).config;
  const { mission } = await ctx.locate(missionId);
  return (await readMissionQueue(ctx, mission.projectId)).config;
}

export async function holdQueuedMission(ctx: PlatformContext, missionId: string, reason: string) {
  const { mission } = await ctx.locate(missionId);
  if (mission.status === 'completed' || mission.status === 'cancelled') return;
  const detail = redactSecrets(reason);
  mission.pause();
  mission.setWaitReason('waiting_l3', detail);
  await ctx.event(mission, 'mission.queue_failed', { reason: detail });
}
