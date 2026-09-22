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
import type { AddressInfo } from 'node:net';
import { createApi } from './api/server.ts';
import { loadPoolOrSeed } from './application/agent-pool.ts';
import type { AgentPoolCandidate } from './application/agent-pool.ts';
import { Orchestrator } from './application/orchestrator.ts';
import {
  parseAgentEnvPassthrough,
  SPAWN_ENV_UNDECLARED_MESSAGE,
  SpawnRuntime,
} from './runtime/spawn.ts';
import { GitWorktreeManager, InPlaceWorkspaceManager } from './application/workspace.ts';
import { buildPersistentPlatform, buildPgPlatform, makeIssuer } from './main.ts';
import type {
  ComplexityAssessment,
  MissionContract,
  WorkOrder,
} from './kernel/index.ts';
import type { ExecutionProfile } from './application/ports.ts';
import type { TaskFacts } from './application/task-classifier.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
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
  const missionFile = process.argv[2];
  if (!missionFile) {
    console.log(
      '用法：node src/run-mission.ts <mission.json> --cwd <worktree> [--adapter <agent-entry.ts>]\n' +
        '     [--store pg] [--in-place] [--accept-stale-base：已知分叉基线过期，照跑]\n' +
        '     [--coordinator <profileId,...>] [--executor <profileId,...>：这一跑只用这些候选]\n' +
        '\n' +
        'mission.json：projectId / missionId / contract 必填。\n' +
        '可选 routing: { facts, assessment?, workOrder? } —— 走 classified intake\n' +
        '（平台 TaskClassifier 决定 lightweight/standard；禁止顶层 executionMode）。\n' +
        'routing 缺省则 legacy createMission（Standard）。',
    );
    return;
  }

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

  // 在 createMission / listen 之前就确认透传名单：名单未声明时不应留下「半截
  // Mission + 已监听端口」——失败必须发生在任何副作用之前。空字符串是合法封锁。
  const envPassthrough = parseAgentEnvPassthrough(
    process.env.COAGENT_AGENT_ENV_PASSTHROUGH,
  );
  if (envPassthrough === undefined) {
    throw new Error(SPAWN_ENV_UNDECLARED_MESSAGE);
  }

  // 持久化：进程退了结果还得在收件箱里等人来取。
  //
  // 存 Postgres 时**不取文件锁**：单写者锁是文件版的补偿手段，数据库那边
  // 由版本号挡并发写，再加一把进程锁只会挡住合法的并行 Mission。
  const statePath = resolve(arg('--state') ?? '.coagent-state.json');
  const usePg = (arg('--store') ?? process.env.COAGENT_STORE ?? 'file') === 'pg';
  // Platform validator 与 Orchestrator 必须共享同一个 WorkspaceManager 实例。
  const missionWorkspace = process.argv.includes('--in-place')
    ? new InPlaceWorkspaceManager()
    : new GitWorktreeManager(arg('--worktrees'));
  const built = usePg
    ? await buildPgPlatform({
        workspace: missionWorkspace,
        // 只收敛自己接手的这条：对别的 Mission 没有「没人在跑」这个认知。
        reconcileMissionId: spec.missionId,
      })
    : await buildPersistentPlatform(statePath, {
        workspace: missionWorkspace,
        exclusive: { what: `跑 Mission ${spec.missionId}` },
      });
  const { platform, tokens, activity, deliveries, persist, reconciled, agentPool } = built;
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
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
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
  function pick(role: 'coordinator' | 'executor', flag: string): AgentPoolCandidate[] {
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
  if (arg('--coordinator') || arg('--executor')) {
    console.log(
      `本次候选：协调者 ${coordinatorPool.map((c) => c.profileId).join('、')} / ` +
        `执行者 ${executorPool.map((c) => c.profileId).join('、')}\n`,
    );
  }

  const orchestrator = new Orchestrator({
    platform,
    // 一边跑一边把输出送进实时通道，观测面那个进程才看得到。
    live,
    tokens: makeIssuer(platform, tokens),
    baseUrl,
    workspace: missionWorkspace,
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
  });

  const result = await orchestrator.runMission(spec.missionId, { projectRoot: cwd });

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
  for (const hop of orchestrator.hops) {
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
  if (orchestrator.workspace) {
    console.log(
      `工作区：${orchestrator.workspace.cwd}（分支 ${orchestrator.workspace.branch}，基线 ${orchestrator.workspace.baseRevision.slice(0, 8)}）`,
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
