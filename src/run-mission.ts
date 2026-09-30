/**
 * 用真实 agent 跑一条 Mission。
 *
 *   node src/run-mission.ts <mission.json> --cwd <worktree> [--adapter <路径>]
 *
 * 这是 L3（人或上游会话）的入口：交一份 Contract，平台自己走完
 * 规划 → 派发 → 执行 → 验收 → 交卷，最后把结果打出来。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { API_VERSION, createApi } from './api/server.ts';
import { loadPoolOrSeed } from './application/agent-pool.ts';
import type { AgentPoolCandidate } from './application/agent-pool.ts';
import { LockBusyError, probeLocalWriter, type LockInfo } from './application/lock.ts';
import { loopbackRunRequest } from './application/loopback-control-client.ts';
import {
  HOSTED_AGENT_ENV_UNPROVEN_MESSAGE,
  MissionRunner,
  parseMaxRounds,
} from './application/mission-runner.ts';
import {
  parseAgentEnvPassthrough,
  SPAWN_ENV_PASSTHROUGH_VAR,
  SPAWN_ENV_UNDECLARED_MESSAGE,
  SpawnRuntime,
} from './runtime/spawn.ts';
import { GitWorktreeManager, InPlaceWorkspaceManager } from './application/workspace.ts';
import { listenLoopback } from './application/loopback-listen.ts';
import { buildDecisionDeps, buildPersistentPlatform, buildPgPlatform, makeIssuer } from './main.ts';
import type {
  ComplexityAssessment,
  MissionContract,
  WorkOrder,
} from './kernel/index.ts';
import type { ExecutionProfile } from './application/ports.ts';
import type { TaskFacts } from './application/task-classifier.ts';

export function missionRunOptions(projectRoot: string, maxRounds: number | undefined) {
  return {
    projectRoot,
    ...(maxRounds === undefined ? {} : { maxRounds }),
  };
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function occupiedMessage(reason: string): string {
  return `无法安全转发到本机写者：${reason}。主状态未改。`;
}

const INDEPENDENT_RUN_MODE = '无常驻服务，独立运行（本进程持主锁）';
// PG 不探测、不转发、不持文件主锁；再用文件独立句会虚报持锁。
const PG_INDEPENDENT_RUN_MODE = 'PG 存储：独立运行（不经常驻服务转发，不持文件主锁）';

function hostedRunModeLine(instanceId: string, port: number): string {
  return `由常驻服务托管：实例 ${instanceId.slice(0, 8)}、端口 ${port}`;
}

function requireLiveIdentity(holder: LockInfo): {
  port: number;
  instanceId: string;
  stateId: string;
  apiVersion: string;
} {
  if (
    holder.port === undefined ||
    holder.instanceId === undefined ||
    holder.stateId === undefined ||
    holder.apiVersion === undefined
  ) {
    throw new Error('活着的写者元数据不完整，拒绝转发。主状态未改。');
  }
  if (holder.apiVersion !== API_VERSION) {
    throw new Error('API 版本不符，拒绝转发。主状态未改。');
  }
  return {
    port: holder.port,
    instanceId: holder.instanceId,
    stateId: holder.stateId,
    apiVersion: holder.apiVersion,
  };
}

function hostedRunBody(input: {
  spec: unknown;
  cwd: string;
  adapter: string;
  statePath: string;
  store: string;
  inPlace: boolean;
  worktrees?: string;
  coordinator?: string;
  executor?: string;
  independentReviewer?: string;
  maxRounds?: number;
  acceptStaleBase: boolean;
  origin?: string;
  envPassthroughRaw: string | undefined;
}): Record<string, unknown> {
  return {
    spec: input.spec,
    cwd: input.cwd,
    adapter: input.adapter,
    state: input.statePath,
    store: input.store,
    inPlace: input.inPlace,
    ...(input.worktrees !== undefined ? { worktrees: input.worktrees } : {}),
    ...(input.coordinator !== undefined ? { coordinator: input.coordinator } : {}),
    ...(input.executor !== undefined ? { executor: input.executor } : {}),
    ...(input.independentReviewer !== undefined
      ? { independentReviewer: input.independentReviewer }
      : {}),
    ...(input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds }),
    acceptStaleBase: input.acceptStaleBase,
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    env: { [SPAWN_ENV_PASSTHROUGH_VAR]: input.envPassthroughRaw },
  };
}

async function forwardLiveRun(holder: LockInfo, body: Record<string, unknown>): Promise<number> {
  const envBag = body.env;
  const rawPass =
    typeof envBag === 'object' && envBag !== null && !Array.isArray(envBag)
      ? (envBag as Record<string, unknown>)[SPAWN_ENV_PASSTHROUGH_VAR]
      : undefined;
  const names = typeof rawPass === 'string' ? parseAgentEnvPassthrough(rawPass) : undefined;
  if (names !== undefined && names.length > 0) {
    // 取值不能进回环；服务 env 同名键也证明不了跟本进程一致。拒绝发生在 POST 之前。
    throw new Error(`无法安全转发到本机写者：${HOSTED_AGENT_ENV_UNPROVEN_MESSAGE}`);
  }
  const identity = requireLiveIdentity(holder);
  const modeLine = hostedRunModeLine(identity.instanceId, identity.port);
  let announced = false;
  return loopbackRunRequest(identity, { path: '/api/control/run-mission', body }, (channel, line) => {
    if (channel === 'stderr') console.error(line);
    else console.log(line);
    // 探测与争锁后重探测都走这里：开跑行之后才标明托管。
    if (!announced && channel !== 'stderr' && /平台监听 |已存在（/.test(line)) {
      announced = true;
      console.log(modeLine);
    }
  });
}

/**
 * 候选 → 调度器用的 ExecutionProfile。
 *
 * facts 为空时**不写这个键**，而不是写一个空数组：适配层的语义是「不带就走
 * 它自己那张表」，传空数组是对它说「我指定了，一个都不选」。这两者在适配层
 * 眼里可以同义，但那要等适配层改了才知道 —— 而播种出来的缺省候选本来就没有
 * facts，不传就是和今天一模一样。
 */
function toProfile(candidate: AgentPoolCandidate): ExecutionProfile {
  return {
    endpoint: candidate.endpoint,
    profileId: candidate.profileId,
    ...(candidate.facts.length > 0 ? { facts: candidate.facts } : {}),
  };
}

async function main() {
  const maxRoundsFlagIndex = process.argv.indexOf('--max-rounds');
  const maxRounds = parseMaxRounds(
    maxRoundsFlagIndex < 0 || process.argv[maxRoundsFlagIndex + 1]?.startsWith('--')
      ? undefined
      : process.argv[maxRoundsFlagIndex + 1],
    maxRoundsFlagIndex >= 0,
  );
  const missionFile = process.argv[2];
  if (!missionFile) {
    console.log(
      '用法：node src/run-mission.ts <mission.json> --cwd <worktree> [--adapter <agent-entry.ts>] [--max-rounds <1-100>]\n' +
        '     [--store pg] [--in-place] [--accept-stale-base：已知分叉基线过期，照跑]\n' +
        '     [--coordinator <profileId,...>] [--executor <profileId,...>] [--independent-reviewer <profileId,...>]\n' +
        '\n' +
        'mission.json：projectId / missionId / contract 必填。\n' +
        '可选 routing: { facts, assessment?, workOrder? } —— 走 classified intake\n' +
        '（平台 TaskClassifier 决定 lightweight/standard；禁止顶层 executionMode）。\n' +
        'routing 缺省则 legacy createMission（Standard）。',
    );
    return;
  }

  // 读 mission JSON 之前就 fail-closed：shadow 缺 key 不得先 ENOENT。后面建平台复用这份 decision。
  const decision = buildDecisionDeps(process.env);

  const spec = JSON.parse(readFileSync(resolve(missionFile), 'utf8')) as {
    projectId: string;
    missionId: string;
    contract: MissionContract;
    /**
     * 可选 classified intake。存在则走 createClassifiedMission（facts→classifier）；
     * 缺省保持 legacy createMission / Standard。不接受顶层 executionMode。
     */
    routing?: {
      facts: TaskFacts;
      assessment?: ComplexityAssessment;
      workOrder?: WorkOrder;
    };
  };
  const cwd = resolve(arg('--cwd') ?? process.cwd());
  const adapter = resolve(
    arg('--adapter') ?? 'C:/program1/coagent-pi/src/agent-entry.ts',
  );

  // 在 createMission / listen / 探测转发之前就确认透传名单：名单未声明时不应留下「半截
  // Mission + 已监听端口」——失败必须发生在任何副作用之前。空字符串是合法封锁。
  const envPassthroughRaw = process.env.COAGENT_AGENT_ENV_PASSTHROUGH;
  const envPassthrough = parseAgentEnvPassthrough(envPassthroughRaw);
  if (envPassthrough === undefined) {
    throw new Error(SPAWN_ENV_UNDECLARED_MESSAGE);
  }

  // 持久化：进程退了结果还得在收件箱里等人来取。
  //
  // 存 Postgres 时**不取文件锁**：单写者锁是文件版的补偿手段，数据库那边
  // 由版本号挡并发写，再加一把进程锁只会挡住合法的并行 Mission。
  const statePath = resolve(arg('--state') ?? '.coagent-state.json');
  const usePg = (arg('--store') ?? process.env.COAGENT_STORE ?? 'file') === 'pg';
  const storeFlag = arg('--store') ?? (usePg ? 'pg' : 'file');
  const inPlace = process.argv.includes('--in-place');
  const acceptStaleBase = process.argv.includes('--accept-stale-base');
  const forwardBody = hostedRunBody({
    spec,
    cwd,
    adapter,
    statePath,
    store: storeFlag,
    inPlace,
    worktrees: arg('--worktrees'),
    coordinator: arg('--coordinator'),
    executor: arg('--executor'),
    independentReviewer: arg('--independent-reviewer'),
    maxRounds,
    acceptStaleBase,
    origin: arg('--origin'),
    envPassthroughRaw,
  });

  // 文件版：parse/预检之后探测本机写者。live 回环转发，不得因连接不明落回本地。
  // PG 不走文件锁探测，保持旧单实例边界。
  if (!usePg) {
    const probe = await probeLocalWriter(statePath);
    if (probe.status === 'live') {
      const code = await forwardLiveRun(probe.holder, forwardBody);
      process.exit(code);
    }
    if (probe.status === 'occupied') {
      throw new Error(occupiedMessage(probe.reason));
    }
  }

  // Platform validator 与 Orchestrator 必须共享同一个 WorkspaceManager 实例。
  const missionWorkspace = inPlace
    ? new InPlaceWorkspaceManager()
    : new GitWorktreeManager(arg('--worktrees'));
  let built;
  try {
    built = usePg
      ? await buildPgPlatform({
          ...decision,
          workspace: missionWorkspace,
          // 只收敛自己接手的这条：对别的 Mission 没有「没人在跑」这个认知。
          reconcileMissionId: spec.missionId,
        })
      : await buildPersistentPlatform(statePath, {
          ...decision,
          workspace: missionWorkspace,
          exclusive: { what: `跑 Mission ${spec.missionId}` },
        });
  } catch (error) {
    if (!usePg && error instanceof LockBusyError) {
      const again = await probeLocalWriter(statePath);
      if (again.status === 'live') {
        const code = await forwardLiveRun(again.holder, forwardBody);
        process.exit(code);
      }
      throw new Error(
        again.status === 'occupied'
          ? occupiedMessage(again.reason)
          : '启动竞争：未能成为唯一写者，不得再取锁建第二平台。主状态未改。',
      );
    }
    throw error;
  }
  const { platform, tokens, activity, deliveries, persist, reconciled, agentPool, candidateCircuits, queuedHops } = built;
  const releaseLock = 'releaseLock' in built ? built.releaseLock : () => {};
  const live = 'live' in built ? built.live : undefined;
  if (reconciled.interrupted.length > 0) {
    console.log(`启动收敛：${reconciled.interrupted.length} 个上次残留的 attempt 判为 interrupted`);
  }
  const server = createApi({
    platform,
    tokens,
    deliveries,
    onMutation: persist,
    live,
    agentPool,
  });
  // 派出去的 agent 用 fetch 连回这个口：分到 fetch 屏蔽的端口，它们会以 bad port 连不上平台。
  await listenLoopback(server, 0);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const origin = { clientType: 'cli', conversationRef: arg('--origin') ?? 'local-cli' };
  const existing = await platform.getMissionView(spec.missionId).catch(() => undefined);
  if (existing) {
    console.log(`Mission ${spec.missionId} 已存在（${existing.status}），接着往下跑`);
  } else if (spec.routing) {
    // classified opt-in：facts/assessment/workOrder → 平台 classifier；不读顶层 mode。
    await platform.createClassifiedMission({
      projectId: spec.projectId,
      missionId: spec.missionId,
      contract: spec.contract,
      origin,
      facts: spec.routing.facts,
      assessment: spec.routing.assessment,
      workOrder: spec.routing.workOrder,
    });
  } else {
    // legacy Standard：只传 createMission 认识的字段，不把 routing 等杂质 spread 进去。
    await platform.createMission({
      projectId: spec.projectId,
      missionId: spec.missionId,
      contract: spec.contract,
      origin,
    });
  }
  console.log(`Mission ${spec.missionId}；平台监听 ${baseUrl}`);
  console.log(`状态文件: ${statePath}`);
  console.log(`worktree: ${cwd}`);
  console.log(`适配器  : ${adapter}\n`);
  console.log(usePg ? PG_INDEPENDENT_RUN_MODE : INDEPENDENT_RUN_MODE);

  // 静默超时：不再产出任何东西才判卡住，然后连同子孙进程一起杀。
  const runtime = new SpawnRuntime({
    kind: 'pi',
    command: 'npx',
    args: ['tsx', adapter],
    cwd: resolve(adapter, '../..'),
    // **静默** 5 分钟才算卡住，不是总共只能跑 5 分钟。
    // 实测一次正常的 Web 端工作连续产出了 45 分钟——按总时长砍就砍错了人。
    timeoutMs: 5 * 60 * 1000,
    stream: true,
    envPassthrough,
    // 不传 env：child 源保持真实 process.env，再由 SpawnRuntime 按名单过滤。
  });

  // 候选池。空仓时写进缺省候选（与以前那四条硬编码逐字段一致），下一次跑就用
  // 改过的配置 —— 换候选不再需要改代码。这播种放在这里而不是 GET 里：只读
  // 的观测面没立场替别人定默认值。
  const pool = await loadPoolOrSeed(agentPool);

  /**
   * 这一跑只用哪些候选。
   *
   * 候选池是全局的，而「换个配置再跑一遍看是不是更省」要求配置能**按次**指定 ——
   * 不然比较就得在两次运行之间改全局池，既容易忘、也说不清当时到底用的哪个。
   *
   * 只做过滤、不新增：名字必须在池子里，打错立刻报错并把可选项列出来。
   * 悄悄回退到全池会让人以为比的是 A 和 B，实际两次都是 B。
   */
  function pick(
    role: 'coordinator' | 'executor' | 'independent_reviewer',
    flag: string,
  ): AgentPoolCandidate[] {
    const wanted = arg(flag);
    const all = pool[role];
    if (!wanted) return [...all];
    const ids = wanted.split(',').map((s) => s.trim()).filter(Boolean);
    const chosen = ids.map((id) => {
      const found = all.find((c) => c.profileId === id);
      if (!found) {
        throw new Error(
          `${flag} 指定的候选 ${id} 不在${role}池里。可选：${all.map((c) => c.profileId).join('、')}`,
        );
      }
      return found;
    });
    return chosen;
  }

  const coordinatorPool = pick('coordinator', '--coordinator');
  const executorPool = pick('executor', '--executor');
  const independentReviewerPool = pick('independent_reviewer', '--independent-reviewer');
  if (arg('--coordinator') || arg('--executor') || arg('--independent-reviewer')) {
    console.log(
      `本次候选：协调者 ${coordinatorPool.map((c) => c.profileId).join('、')} / ` +
        `执行者 ${executorPool.map((c) => c.profileId).join('、')} / ` +
        `独立检视 ${independentReviewerPool.map((c) => c.profileId).join('、') || '（无）'}\n`,
    );
  }

  const runner = new MissionRunner({
    platform,
    // 一边跑一边把输出送进实时通道，观测面那个进程才看得到。
    live,
    tokens: makeIssuer(platform, tokens),
    baseUrl,
    workspace: missionWorkspace,
    candidateCircuits,
    queuedHops,
    inRunBackoffWaitMs: 120_000,
    // 「我知道基线过期了，照跑」。必须由人显式给：调度器那边原先用一个
    // 进程内布尔量记这件事，而 CLI 一次运行一个进程，它每次都失忆——
    // 于是基线一过期，这条 Mission 每跑一次都被同一句话挡回去。
    acceptStaleBase: process.argv.includes('--accept-stale-base'),
    coordinator: {
      runtime,
      candidates: coordinatorPool.map(toProfile),
    },
    executor: {
      runtime,
      // 有序候选池：**只有上游失败**才往后换。顺序就是仓储里的 order。
      candidates: executorPool.map(toProfile),
    },
    independentReviewer: {
      runtime,
      candidates: independentReviewerPool.map(toProfile),
    },
  });

  const ran = await runner.run(spec.missionId, missionRunOptions(cwd, maxRounds));
  const result = ran.outcome;

  console.log(`\n${'='.repeat(72)}`);
  const detail =
    'detail' in result
      ? ` —— ${result.detail}`
      : 'reason' in result
        ? ` —— ${result.reason}`
        : 'question' in result
          ? ` —— ${result.question}`
          : '';
  console.log(`Mission 结果：${result.kind}${detail}`);
  console.log(`${'='.repeat(72)}`);
  for (const hop of ran.hops) {
    console.log(
      `  ${hop.role.padEnd(12)}${(hop.workItemId ?? '-').padEnd(6)}${hop.profile.profileId.padEnd(18)}` +
        `${hop.endedBy}${hop.failureMessage ? ` —— ${hop.failureMessage.slice(0, 80)}` : ''}`,
    );
  }

  const view = await platform.getMissionView(spec.missionId);
  console.log(`\n工作项：`);
  for (const item of view.workItems) {
    console.log(`  ${item.id.padEnd(6)}${item.status.padEnd(11)}${item.attempts} 次尝试  ${item.title}`);
  }
  const usage = view.usage;
  console.log(
    `\n用量（${usage.quality}）：in=${usage.input} out=${usage.output} cacheRead=${usage.cacheRead} ` +
      `total=${usage.total} cost=$${(usage.cost ?? 0).toFixed(4)}`,
  );
  console.log(`事件：${(await activity.list(spec.missionId)).length} 条`);
  if (ran.workspace) {
    console.log(
      `工作区：${ran.workspace.cwd}（分支 ${ran.workspace.branch}，基线 ${ran.workspace.baseRevision.slice(0, 8)}）`,
    );
  }
  const inbox = await deliveries.pending(origin.conversationRef);
  console.log(`收件箱：${inbox.length} 条待取${inbox.length ? `（${inbox.map((d) => d.id).join(', ')}）` : ''}`);
  persist();
  if (view.result) {
    console.log(`\nMission Result：\n${JSON.stringify(view.result, null, 2)}`);
  }

  server.close();
  releaseLock();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
