/**
 * 开跑前检查项目仓。**失败必须发生在任何副作用之前**：夜里开跑之后才发现，
 * 就是每个功能都白跑一遍再被拒。
 *
 * - 必须在方案声明的集成分支上：合并目标取自「当时 checkout 的分支」，在错的
 *   分支上开跑，第一次合并就合错地方（机器 L3 在门口还会再核一次）；
 * - 工作区必须干净，**未跟踪文件也算**：机器 L3 合并前看 `git status --porcelain`，
 *   非空就拒绝——一个忘了处理的日志文件能让整晚的每一次合并都失败。被
 *   .gitignore / .git/info/exclude 忽略的不算。
 *
 * 返回问题清单（空 = 可以开跑），由调用方决定怎么报。
 */

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function preflightPlanRepo(projectRoot: string, integrationBranch: string): Promise<string[]> {
  const cwd = resolve(projectRoot);
  const problems: string[] = [];

  const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })).stdout.trim();
  if (branch === 'HEAD') {
    problems.push(`项目仓 ${cwd} 处在 detached HEAD，不在集成分支 ${integrationBranch} 上。`);
  } else if (branch !== integrationBranch) {
    problems.push(
      `项目仓 ${cwd} 现在在 ${branch}，不是方案声明的集成分支 ${integrationBranch}。` +
        `先 git checkout ${integrationBranch}。`,
    );
  }

  const dirty = (await run('git', ['status', '--porcelain'], { cwd })).stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (dirty.length > 0) {
    problems.push(
      `项目仓工作区不干净（机器 L3 见到任何一项都会拒绝合并）：\n` +
        dirty.map((line) => `    ${line}`).join('\n') +
        '\n  提交、挪走，或把只在本机用的文件写进 .git/info/exclude。',
    );
  }
  return problems;
}

/**
 * 项目的改动名额被谁占着。返回问题清单（空 = 名额是空的）。
 *
 * 方案停下时（叫停 / 未解决到顶 / 墙钟 / 集成分支不安全 / 崩溃），失败或在途的
 * 那条 Mission 是**故意原样留给人的**——它动过代码、没到终态，一直占着名额。
 * 不先处理它就开下一晚，每个功能的协调者都会先调查规划一遍、派发时撞上
 * PROJECT_BUSY，然后开单、等过期、再换下一个——一整晚白烧。
 */
export function slotHolders(
  missions: readonly { missionId: string; projectId: string; status: string; isMutating: boolean }[],
  projectId: string,
): string[] {
  return missions
    .filter((mission) => mission.projectId === projectId && mission.isMutating)
    .map(
      (mission) =>
        `Mission ${mission.missionId}（${mission.status}）正占着项目 ${projectId} 的改动名额：` +
        `先处理它（node src/l3.ts show ${mission.missionId}，再 merge 或 abandon），` +
        '否则今晚每个功能都派发不了。',
    );
}
