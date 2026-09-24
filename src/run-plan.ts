/**
 * 按方案无人值守地逐个推进功能点。睡前启动，早上看交接面。
 *
 *   node src/run-plan.ts <PLAN.json> --cwd <项目仓> [--reviewer <谁>] [--adapter <agent-entry.ts>]
 *        [--state <状态文件>] [--run-dir <方案运行记录目录>] [--store pg]
 *        [--coordinator <profileId,...>] [--executor <profileId,...>]
 *
 * 与 run-mission 并列：run-mission 跑完一条就退；这里一个功能点一条 Mission，
 * 交卷了走机器 L3 合进集成分支，没合进去就开升级单等检视者（另一个会话，定时
 * 醒来，经 `node src/l3.ts plan` 读单、写回决定）。停下的原因写进方案运行记录。
 *
 * 顺序要紧：透传名单、方案文件、项目仓检查都在**任何副作用之前**——开跑之后才
 * 发现，就是每个功能都白跑一遍再被拒。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApi } from './api/server.ts';
import { loadPoolOrSeed } from './application/agent-pool.ts';
import type { AgentPoolCandidate } from './application/agent-pool.ts';
import { Orchestrator } from './application/orchestrator.ts';
import { drivePlan, runWithDeadline } from './application/plan-driver.ts';
import { preflightPlanRepo, slotHolders } from './application/plan-preflight.ts';
import { buildRoutingPrompt, parseRoutingProposal } from './application/plan-routing.ts';
import { renderPlanHandoff } from './application/plan-handoff.ts';
import { PlanRun } from './application/plan-run.ts';
import { FilePlanRunStore } from './application/plan-run-store.ts';
import { parsePlanSpec } from './application/plan-spec.ts';
import type { ExecutionProfile } from './application/ports.ts';
import { GitWorktreeManager } from './application/workspace.ts';
import { buildDecisionDeps, buildPersistentPlatform, buildPgPlatform, makeIssuer } from './main.ts';
import {
  parseAgentEnvPassthrough,
  SPAWN_ENV_UNDECLARED_MESSAGE,
  SpawnRuntime,
} from './runtime/spawn.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function toProfile(candidate: AgentPoolCandidate): ExecutionProfile {
  return {
    endpoint: candidate.endpoint,
    profileId: candidate.profileId,
    ...(candidate.facts.length > 0 ? { facts: candidate.facts } : {}),
  };
}

/** 运行 id 的时间戳：本地时间到分钟，文件名里好认。 */
function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

async function main() {
  const planFile = process.argv[2];
  if (!planFile || planFile.startsWith('--')) {
    console.log(
      '用法：node src/run-plan.ts <PLAN.json> --cwd <项目仓> [--reviewer <谁>] [--adapter <agent-entry.ts>]\n' +
        '     [--state <状态文件>] [--run-dir <方案运行记录目录>] [--store pg]\n' +
        '     [--coordinator <profileId,...>] [--executor <profileId,...>]\n' +
        '\n' +
        '项目仓必须 checkout 在方案的 integrationBranch 上且工作区干净（未跟踪文件也算）。\n' +
        '检视者（另一个会话）每 20 分钟：node src/l3.ts plan --run <方案运行记录>',
    );
    return;
  }

  // 决策依赖在读任何输入之前组装：shadow 缺 key 就在这里失败，不留半截 Mission / 状态 / 锁。
  const decision = buildDecisionDeps(process.env);

  const envPassthrough = parseAgentEnvPassthrough(process.env.COAGENT_AGENT_ENV_PASSTHROUGH);
  if (envPassthrough === undefined) throw new Error(SPAWN_ENV_UNDECLARED_MESSAGE);

  const plan = parsePlanSpec(JSON.parse(readFileSync(resolve(planFile), 'utf8')), {
    reviewer: arg('--reviewer'),
  });
  const projectRoot = resolve(arg('--cwd') ?? process.cwd());
  const remaining = plan.features.filter((feature) => feature.status !== 'done');
  if (remaining.length === 0) {
    console.log(`方案 ${plan.planId} 的功能点都已合入，没什么可跑的。`);
    return;
  }
  const problems = await preflightPlanRepo(projectRoot, plan.integrationBranch);
  if (problems.length > 0) {
    console.error(`开跑前检查没过，一个功能都没跑：\n${problems.map((p) => `  ✗ ${p}`).join('\n')}`);
    process.exitCode = 2;
    return;
  }

  const adapter = resolve(arg('--adapter') ?? 'C:/program1/coagent-pi/src/agent-entry.ts');
  const statePath = resolve(arg('--state') ?? '.coagent-state.json');
  const usePg = (arg('--store') ?? process.env.COAGENT_STORE ?? 'file') === 'pg';
  const workspace = new GitWorktreeManager(arg('--worktrees'));
  // 分类员：同一个适配器的只读模式。工具表只有 read / grep / find / ls，由 QueryRunner 强制。
  const queryRuntime = new SpawnRuntime({
    kind: 'pi',
    command: 'npx',
    args: ['tsx', adapter],
    cwd: resolve(adapter, '../..'),
    timeoutMs: 5 * 60 * 1000,
    stream: false,
    supportsQuery: true,
    envPassthrough,
  });
  const built = usePg
    ? await buildPgPlatform({ ...decision, workspace, queryRuntime })
    : await buildPersistentPlatform(statePath, {
        ...decision,
        workspace,
        queryRuntime,
        exclusive: { what: `run-plan ${plan.planId}` },
      });
  const { platform, tokens, deliveries, persist, agentPool } = built;
  const releaseLock = 'releaseLock' in built ? built.releaseLock : () => {};
  const live = 'live' in built ? built.live : undefined;
  const runQuery = built.runQuery;

  try {
    // 状态文件、锁目录落在项目仓里却没被忽略的话，机器 L3 每一次合并都会拒绝。
    // 拿锁之后再看一次，才看得见这把锁自己。
    const afterLock = await preflightPlanRepo(projectRoot, plan.integrationBranch);
    if (afterLock.length > 0) {
      console.error(`拿到状态锁之后项目仓变脏了（状态文件多半就在仓库里且没被忽略）：\n${afterLock.join('\n')}`);
      process.exitCode = 2;
      return;
    }
    // 上一晚停下时原样留给人的 Mission 还占着名额的话，今晚一个都派发不了。
    const holders = slotHolders(await platform.listMissions(), plan.projectId);
    if (holders.length > 0) {
      console.error(`开跑前检查没过，一个功能都没跑：\n${holders.map((h) => `  ✗ ${h}`).join('\n')}`);
      process.exitCode = 2;
      return;
    }

    const started = new Date();
    const runId = `${plan.planId}-${stamp(started)}`;
    const runDir = resolve(arg('--run-dir') ?? join(dirname(statePath), '.coagent-plans'));
    const store = new FilePlanRunStore(join(runDir, `${runId}.json`));
    await store.create(
      PlanRun.start({
        id: runId,
        planId: plan.planId,
        projectId: plan.projectId,
        integrationBranch: plan.integrationBranch,
        reviewer: plan.reviewer,
        stopConditions: plan.stopConditions,
        featureIds: remaining.map((feature) => feature.id),
        // 标题抄进记录：早上看交接面不用回头翻方案文件（它到早上可能已经改了）。
        titles: Object.fromEntries(remaining.map((feature) => [feature.id, feature.title])),
        startedAt: started.toISOString(),
      }),
    );

    const server = createApi({ platform, tokens, deliveries, onMutation: persist, live, agentPool });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const runtime = new SpawnRuntime({
      kind: 'pi',
      command: 'npx',
      args: ['tsx', adapter],
      cwd: resolve(adapter, '../..'),
      timeoutMs: 5 * 60 * 1000,
      stream: true,
      envPassthrough,
    });
    const pool = await loadPoolOrSeed(agentPool);
    const pick = (role: 'coordinator' | 'executor', flag: string): AgentPoolCandidate[] => {
      const wanted = arg(flag);
      if (!wanted) return [...pool[role]];
      return wanted
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((id) => {
          const found = pool[role].find((c) => c.profileId === id);
          if (!found) {
            throw new Error(`${flag} 指定的候选 ${id} 不在${role}池里。可选：${pool[role].map((c) => c.profileId).join('、')}`);
          }
          return found;
        });
    };
    const coordinators = pick('coordinator', '--coordinator').map(toProfile);
    const executors = pick('executor', '--executor').map(toProfile);

    console.log(`方案 ${plan.planId} 开跑：${remaining.map((f) => f.id).join(' → ')}`);
    console.log(`集成分支 ${plan.integrationBranch}，项目仓 ${projectRoot}`);
    console.log(`方案运行记录：${store.path}`);
    console.log(
      `检视者 ${plan.reviewer} 每 ${Math.round(plan.stopConditions.escalationTimeoutMs / 60_000)} 分钟醒一次：` +
        `node src/l3.ts plan --run "${store.path}"\n`,
    );

    // Ctrl+C / 被杀：信号结束的进程不发 exit 事件，锁目录会留下，后面每次写都被挡；
    // 方案运行记录也会停在「还在跑」。先记下原因、落盘、放锁再退。在途 Mission 原样
    // 留给人（它可能占着名额，下一晚开跑前检查会点名它）。
    let interrupted = false;
    const onSignal = (signal: string) => {
      if (interrupted) return;
      interrupted = true;
      console.error(`\n收到 ${signal}：记下原因后退出。在途的 Mission 原样留给人。`);
      void store
        .update((r) => {
          if (!r.stopped) r.halt('crashed', `被人中断（${signal}）`, new Date().toISOString());
        })
        .catch(() => undefined)
        .then(async () => {
          await Promise.resolve(persist()).catch(() => undefined);
          releaseLock();
          process.exit(130);
        });
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));

    const stop = await drivePlan(plan, {
      store,
      projectRoot,
      checkRepo: () => preflightPlanRepo(projectRoot, plan.integrationBranch),
      now: () => new Date().toISOString(),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      log: (line) => console.log(`[${new Date().toLocaleTimeString()}] ${line}`),
      platform: {
        createMission: async (input) => {
          const created = await platform.createMission(input);
          await persist();
          return created;
        },
        createClassifiedMission: async (input) => {
          const created = await platform.createClassifiedMission(input);
          await persist();
          return created;
        },
        getMissionView: (missionId) => platform.getMissionView(missionId),
        finalizeMissionByMachine: async (missionId, input) => {
          const result = await platform.finalizeMissionByMachine(missionId, input);
          await persist();
          return result;
        },
        abandonMissionForPlan: async (missionId, input) => {
          const result = await platform.abandonMissionForPlan(missionId, input);
          await persist();
          return result;
        },
      },
      proposeRoute: async (feature) => {
        if (!runQuery) return { ok: false, reason: '分类员不可用（query runtime 没装上）。' };
        const result = await runQuery({
          projectId: plan.projectId,
          source: `plan-run:${runId}:${feature.id}`,
          prompt: buildRoutingPrompt(plan, feature),
          cwd: projectRoot,
          ...(coordinators[0] ? { profile: coordinators[0] } : {}),
        });
        await persist();
        if (result.outcome !== 'answered') {
          return { ok: false, reason: `分类员没答上来（${result.outcome}，QueryRun ${result.queryRunId}）。` };
        }
        const parsed = parseRoutingProposal(result.record.output ?? '', new Date().toISOString());
        return parsed.ok ? parsed : { ok: false, reason: `${parsed.reason}（QueryRun ${result.queryRunId}）` };
      },
      runMission: async (missionId, { wallClockDeadline }) => {
        // 一条 Mission 一个编排器：它按「上一跳」判连续无提交，跨 Mission 复用会误判。
        const orchestrator = new Orchestrator({
          platform,
          live,
          tokens: makeIssuer(platform, tokens),
          baseUrl,
          workspace,
          coordinator: { runtime, candidates: coordinators },
          executor: { runtime, candidates: executors },
        });
        try {
          return await runWithDeadline(
            () => orchestrator.runMission(missionId, { projectRoot }),
            Date.parse(wallClockDeadline) - Date.now(),
            async () => {
              console.log(`[${new Date().toLocaleTimeString()}] 墙钟到点：暂停在途的 ${missionId}，下一轮开头停下。`);
              await platform.pauseMission(missionId);
              await persist();
            },
          );
        } finally {
          await persist();
        }
      },
    });

    const run = store.read();
    console.log(`\n${'='.repeat(72)}`);
    console.log(`方案 ${plan.planId} 停了：${stop.reason} —— ${stop.detail}`);
    console.log('='.repeat(72));
    // 与早上 l3 plan 看到的是同一张交接面。这里不算花销：要读全部 Mission 的用量，
    // 交给 l3 plan 去算。
    if (run) for (const text of renderPlanHandoff(run, { now: new Date().toISOString() })) console.log(text);
    console.log(`\n早上看（带花销）：node src/l3.ts plan --run "${store.path}"`);
    server.close();
  } finally {
    await persist();
    releaseLock();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
