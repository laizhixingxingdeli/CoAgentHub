/**
 * L3 的命令行入口：取件、检视、放行/打回/放弃。
 *
 *   node src/l3.ts inbox [--recipient X]
 *   node src/l3.ts show <missionId>
 *   node src/l3.ts merge <missionId> --reason "..." [--as <检视者> --confirmed-by <确认人>]
 *   node src/l3.ts send-back <missionId> --reason "..." [--as <检视者> --confirmed-by <确认人>]
 *   node src/l3.ts abandon <missionId> --reason "..." [--as <检视者> --confirmed-by <确认人>]
 *   node src/l3.ts ack <deliveryId>
 *   node src/l3.ts plan [--run <方案运行记录>]
 *   node src/l3.ts plan decide <E-n> --action <动作> --reason "..." [--drop F7,F8] --as <检视者>
 *   node src/l3.ts plan decide <E-n> --action answer --answer "..." --as <检视者> [--reason "..."]
 *
 * 文件模式主状态写命令先探测本机写者：活着的同状态服务持锁时回环转发给
 * 唯一写者；无锁时沿用独占装配。其他锁状态 fail-closed，不离线再写一份。
 * PG 不走文件锁探测。plan decide/approve 只写方案运行记录，不碰主锁。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { API_VERSION } from './api/server.ts';
import { LockBusyError, probeLocalWriter, type LockInfo } from './application/lock.ts';
import {
  LoopbackHttpError,
  loopbackControlRequest,
} from './application/loopback-control-client.ts';
import { renderPlanHandoff, type HandoffCosts } from './application/plan-handoff.ts';
import type { PlanRun } from './application/plan-run.ts';
import { FilePlanRunStore } from './application/plan-run-store.ts';
import { buildPersistentPlatform, buildPgPlatform } from './main.ts';

const MAIN_STATE_WRITES = new Set([
  'merge',
  'send-back',
  'abandon',
  'answer',
  'revise',
  'cancel',
  'pause',
  'resume',
  'park',
  'retire',
  'rerun',
  'ack',
]);

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

type ReviewerSignature =
  | { readonly mode: 'human' }
  | { readonly mode: 'reviewer'; readonly reviewerId: string; readonly confirmedBy: string };

/**
 * 终审三命令专用：下一个是另一个 `--` 开头的参数也算缺值。
 * 别的命令继续用 `arg()`——`rerun --as` 与 `plan decide --as` 的原义不能动。
 */
function reviewFlag(name: string): { present: boolean; value?: string } {
  const index = process.argv.indexOf(name);
  if (index < 0) return { present: false };
  const next = process.argv[index + 1];
  if (next === undefined || next.startsWith('--')) return { present: true };
  return { present: true, value: next };
}

function parseReviewerSignature(): ReviewerSignature {
  const asFlag = reviewFlag('--as');
  const confirmed = reviewFlag('--confirmed-by');
  if (!asFlag.present && !confirmed.present) return { mode: 'human' };
  if (asFlag.present !== confirmed.present) {
    throw new Error(
      asFlag.present
        ? '给了 --as 就必须同时给 --confirmed-by：检视者签名要记下是谁确认的。'
        : '给了 --confirmed-by 就必须同时给 --as：确认记录要签检视者的名字。',
    );
  }
  if (asFlag.value === undefined) {
    throw new Error('--as 缺参数值：要写成 --as <检视者>。');
  }
  if (confirmed.value === undefined) {
    throw new Error('--confirmed-by 缺参数值：要写成 --confirmed-by <确认人>。');
  }
  const reviewerId = asFlag.value.trim();
  const confirmedBy = confirmed.value.trim();
  if (reviewerId.length === 0) {
    throw new Error('--as 的值不能只是空白。');
  }
  if (confirmedBy.length === 0) {
    throw new Error('--confirmed-by 的值不能只是空白。');
  }
  if (reviewerId.length > 128) {
    throw new Error('--as 经 trim 后不能超过 128 字符。');
  }
  if (confirmedBy.length > 128) {
    throw new Error('--confirmed-by 经 trim 后不能超过 128 字符。');
  }
  return { mode: 'reviewer', reviewerId, confirmedBy };
}

function line(char = '─', n = 72): string {
  return char.repeat(n);
}

function occupiedMessage(reason: string): string {
  return `无法安全转发到本机写者：${reason}。主状态未改。`;
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

/** 先验失败时不得探测、不得装配。校验顺序与旧命令一致：终审先成对签名。 */
function assertWriteArgs(command: string, target: string | undefined): void {
  if (command === 'merge' || command === 'send-back' || command === 'abandon') {
    if (!target) throw new Error('需要 missionId');
    const reason = arg('--reason');
    if (!reason && command !== 'merge') {
      throw new Error('打回/放弃必须给 --reason —— 不说清楚，协调者只会原样再交一次');
    }
    return;
  }
  if (command === 'answer') {
    if (!target) throw new Error('需要 missionId');
    if (!arg('--answer')) throw new Error('需要 --answer "..."');
    return;
  }
  if (command === 'revise') {
    if (!target) throw new Error('需要 missionId');
    const file = arg('--contract');
    if (!file) throw new Error('需要 --contract <mission.json>');
    JSON.parse(readFileSync(resolve(file), 'utf8'));
    return;
  }
  if (command === 'cancel' || command === 'pause' || command === 'resume') {
    if (!target) throw new Error('需要 missionId');
    if (command === 'resume') {
      const reason = reviewFlag('--reason');
      const reviewer = reviewFlag('--as');
      const answer = reviewFlag('--answer');
      if (answer.present && answer.value === undefined) throw new Error('--answer 缺参数值。');
      if (answer.present && !reason.present && !reviewer.present) {
        throw new Error('--answer 只能与带检视者签名的 Mission resume 一起使用。');
      }
      if ((reason.present || reviewer.present) && (!reason.value?.trim() || !reviewer.value?.trim())) {
        throw new Error('带检视者签名的 resume 必须提供非空 --reason 与 --as。');
      }
    }
    return;
  }
  if (command === 'park') {
    if (!target) throw new Error('需要 missionId');
    if (!arg('--reason')?.trim() || !arg('--as')?.trim()) throw new Error('park 必须提供非空 --reason 与 --as。');
    return;
  }
  if (command === 'retire') {
    if (!target) throw new Error('需要 missionId');
    if (!arg('--item')) throw new Error('需要 --item <workItemId>');
    if (!arg('--reason')) throw new Error('作废必须给 --reason —— 不写清楚，协调者会以为它还该做');
    return;
  }
  if (command === 'rerun') {
    if (!target) throw new Error('需要 missionId');
    return;
  }
  if (command === 'ack') {
    if (!target) throw new Error('需要 deliveryId');
  }
}

async function forwardWriteCommand(holder: LockInfo, command: string, target: string): Promise<void> {
  const identity = requireLiveIdentity(holder);
  const post = (path: string, body: unknown) =>
    loopbackControlRequest(identity, { method: 'POST', path, body });
  const get = (path: string) => loopbackControlRequest(identity, { method: 'GET', path });

  if (command === 'merge' || command === 'send-back' || command === 'abandon') {
    const reason = arg('--reason');
    const signature = parseReviewerSignature();
    const verdict = command === 'send-back' ? 'send_back' : command;
    const review: Record<string, unknown> = {
      verdict,
      reasons: reason ? [reason] : [],
    };
    const projectRoot = arg('--repo');
    if (projectRoot !== undefined) review.projectRoot = projectRoot;
    // HA 合入必须走 /finalize/reviewer，服务端再升到 HA 权威。降到普通 finalize 会拒 HA merge。
    const path =
      signature.mode === 'reviewer'
        ? `/api/missions/${encodeURIComponent(target)}/finalize/reviewer`
        : `/api/missions/${encodeURIComponent(target)}/finalize`;
    const body =
      signature.mode === 'reviewer'
        ? { ...review, reviewerId: signature.reviewerId, confirmedBy: signature.confirmedBy }
        : review;
    const result = (await post(path, body)) as {
      status: string;
      mergedInto?: string;
      reason?: string;
    };
    console.log(`Mission ${target} → ${result.status}`);
    if (result.mergedInto) console.log(`已落地到 ${result.mergedInto.slice(0, 12)}`);
    if (result.reason) console.log(`⚠ ${result.reason}`);
    return;
  }

  if (command === 'answer') {
    const result = (await post(`/api/missions/${encodeURIComponent(target)}/escalations/answer`, {
      answer: arg('--answer'),
    })) as { question: string; answer: string };
    console.log(`已答复 ${target} 的升级：`);
    console.log(`  问题：${result.question}`);
    console.log(`  答复：${result.answer}`);
    console.log('\n下一步：重新跑 run-mission，协调者会看到这条答复。');
    return;
  }

  if (command === 'revise') {
    const file = arg('--contract')!;
    const spec = JSON.parse(readFileSync(resolve(file), 'utf8')) as { contract: unknown };
    const result = (await post(
      `/api/missions/${encodeURIComponent(target)}/contract`,
      spec.contract,
    )) as { contractRevision: number };
    const view = (await get(`/api/missions/${encodeURIComponent(target)}`)) as {
      status: string;
      finalReview?: { verdict?: string };
    };
    console.log(`Contract → r${result.contractRevision}，Mission 现在是 ${view.status}`);
    if (view.finalReview?.verdict === 'send_back') {
      console.log('（原先在等检视，已按新契约退回规划——旧的那份交卷是照着旧契约做的）');
    }
    return;
  }

  if (command === 'cancel') {
    const result = (await post(`/api/missions/${encodeURIComponent(target)}/cancel`, {
      reason: arg('--reason') ?? '',
    })) as { status: string };
    console.log(`Mission ${target} → ${result.status}（已叫停）`);
    console.log('在途的那一跳会正常收尾，之后不再调度。');
    return;
  }

  if (command === 'park') {
    await post(`/api/missions/${encodeURIComponent(target)}/park`, { reason: arg('--reason'), reviewer: arg('--as') });
    return;
  }
  if (command === 'resume' && arg('--reason') !== undefined) {
    await post(`/api/missions/${encodeURIComponent(target)}/parked-resume`, { reason: arg('--reason'), reviewer: arg('--as'), ...(arg('--answer') !== undefined ? { answer: arg('--answer') } : {}) });
    return;
  }
  if (command === 'pause') {
    await post(`/api/missions/${encodeURIComponent(target)}/pause`, {});
    console.log(`Mission ${target} 已暂停。阶段保持原样，resume 之后重跑 run-mission 即可。`);
    return;
  }

  if (command === 'resume') {
    await post(`/api/missions/${encodeURIComponent(target)}/resume`, {});
    console.log(`Mission ${target} 已恢复。重跑 run-mission 继续。`);
    return;
  }

  if (command === 'retire') {
    const workItemId = arg('--item')!;
    const result = (await post(
      `/api/missions/${encodeURIComponent(target)}/work-items/${encodeURIComponent(workItemId)}/retire`,
      { reason: arg('--reason') },
    )) as { status: string };
    console.log(`工作项 ${workItemId} → ${result.status}（已作废）`);
    console.log('协调者下次被唤醒时会看到它，并据此判断要不要重做。');
    return;
  }

  if (command === 'rerun') {
    const body: { newMissionId?: string; baseRevision?: string } = {};
    const as = arg('--as');
    const base = arg('--base');
    if (as !== undefined) body.newMissionId = as;
    if (base !== undefined) body.baseRevision = base;
    const result = (await post(`/api/missions/${encodeURIComponent(target)}/rerun`, body)) as {
      missionId: string;
      rerunOf: string;
      contractRevision: number;
      sourceAlreadyLanded?: boolean;
      baseRevision?: string;
    };
    console.log(`已另起一条：${result.missionId}（${result.rerunOf} 的重跑，契约 r${result.contractRevision}）`);
    console.log('契约一字没改。原来那条的记录一点没动 —— 重跑的意义就是两份都留着好比。');
    if (result.sourceAlreadyLanded) {
      console.log(
        `\n⚠ ${result.rerunOf} 的产出**已经落地进项目了**，这一跑不是干净的对照：\n` +
          '  答案就摆在项目工作区里，agent 读一眼就有 —— 实测上一次对照就是这么毁的\n' +
          '  （它 read 了主仓库里的成品文件、还 git show 了那次交付的提交，不是在解题是在抄）。\n' +
          '  要做对照，用一个**还没合并**的任务，两臂都跑完再决定合哪个。',
      );
    }
    if (result.baseRevision) {
      console.log(`起点钉在 ${result.baseRevision.slice(0, 8)}（与源头同一个版本），两次才可比。`);
    } else {
      console.log(
        '⚠ 源头没记过工作区，起点无法钉住 —— 这一跑会从目标分支当前的 HEAD 分叉，\n' +
          '  和源头不是同一个起点，**跑出来的数不能和它对比**。要比就用 --base <版本> 指定。',
      );
    }
    console.log(`\n下一步：node src/run-mission.ts <mission.json> --cwd <repo>  # missionId 用 ${result.missionId}`);
    console.log(`跑完用 node src/l3.ts runs ${result.missionId} 横着看。`);
    return;
  }

  if (command === 'ack') {
    try {
      await post(`/api/deliveries/${encodeURIComponent(target)}/ack`, {});
      console.log(`${target} 已确认`);
    } catch (error) {
      if (error instanceof LoopbackHttpError && error.status === 404) {
        console.log(`没有这条投递：${target}`);
        return;
      }
      throw error;
    }
  }
}

async function main() {
  const [, , command, target] = process.argv;
  const statePath = resolve(arg('--state') ?? '.coagent-state.json');
  // 只读命令不抢锁：一边跑 Mission 一边 inbox/show/runs 是常态。plan（含 decide）只写方案
  // 运行记录那份独立文件，主状态同样只读——run-plan 整夜握着主状态锁。
  const isMainStateWrite = MAIN_STATE_WRITES.has(command ?? '');
  const readOnly = !isMainStateWrite;
  const usePg = (arg('--store') ?? process.env.COAGENT_STORE ?? 'file') === 'pg';
  // 终审三命令的 --as / --confirmed-by 必须在构建平台之前成对校验：
  // 构建会拿排他锁并跑启动收敛，可能改状态文件。校验失败时状态字节不能动。
  const reviewerSignature =
    command === 'merge' || command === 'send-back' || command === 'abandon'
      ? parseReviewerSignature()
      : undefined;
  if (isMainStateWrite) assertWriteArgs(command!, target);

  if (!usePg && isMainStateWrite) {
    const probe = await probeLocalWriter(statePath);
    if (probe.status === 'live') {
      await forwardWriteCommand(probe.holder, command!, target!);
      return;
    }
    if (probe.status === 'occupied') {
      throw new Error(occupiedMessage(probe.reason));
    }
  }

  let built;
  try {
    built = usePg
      ? // L3 从不接手在途 attempt —— 它只放行/打回。所以**不做启动收敛**：
        // 一个只看结果的命令没有立场判定别的进程死了。PG 不走文件锁假探测。
        await buildPgPlatform()
      : await buildPersistentPlatform(statePath, {
          exclusive: readOnly ? undefined : { what: `l3 ${command} ${target ?? ''}` },
          // 只看结果的命令没有立场判定别的进程死了——见 PersistentOptions.reconcile。
          reconcile: !readOnly,
        });
  } catch (error) {
    if (!usePg && isMainStateWrite && error instanceof LockBusyError) {
      const again = await probeLocalWriter(statePath);
      if (again.status === 'live') {
        await forwardWriteCommand(again.holder, command!, target!);
        return;
      }
      throw new Error(
        again.status === 'occupied'
          ? occupiedMessage(again.reason)
          : '启动竞争：未能成为唯一写者，不得再取锁建第二平台。主状态未改。',
      );
    }
    throw error;
  }
  const { platform, deliveries, persist } = built;
  const reconciled = 'reconciled' in built ? built.reconciled : { interrupted: [] };
  if (reconciled.interrupted.length > 0) {
    console.log(`启动收敛：${reconciled.interrupted.length} 个残留 attempt 判为 interrupted\n`);
  }

  if (command === 'inbox') {
    const pending = await deliveries.pending(arg('--recipient') ?? undefined);
    if (pending.length === 0) {
      console.log('收件箱是空的。');
      return;
    }
    console.log(`收件箱：${pending.length} 条待取\n`);
    for (const item of pending) {
      console.log(`${item.id}  [${item.outcome}]  ${item.missionId}  → ${item.recipient}`);
      console.log(`  ${item.summary.split(/\r?\n/)[0].slice(0, 100)}`);
      console.log(`  ${item.createdAt}\n`);
    }
    const escalated = pending.filter((item) => item.outcome === 'escalated');
    if (escalated.length > 0) {
      console.log(
        `其中 ${escalated.length} 条是升级。方案运行中的升级用 node src/l3.ts plan decide <E-n> --action answer --answer "..." --as <检视者>（AQ1 答复唯一路径；HTTP 不复制续跑）；方案运行之外才用 node src/l3.ts answer <missionId> --answer "..."`,
      );
    }
    console.log('下一步：node src/l3.ts show <missionId>');
    return;
  }

  if (command === 'show') {
    if (!target) throw new Error('需要 missionId');
    const view = await platform.getMissionView(target);
    console.log(line('='));
    console.log(
      `Mission ${view.missionId}   ${view.status}${view.isMutating ? '（占着改动名额）' : ''}` +
        // 「谁挡着我」。没有这一格时，撞上 project_busy 的人只能挨个 Mission
        // 去翻谁还没结束 —— 实测挡住 P2 的是一条早就跑死的测量跑。
        (view.blockedByMission ? `\n           ⚠ ${view.blockedByMission} 正占着本项目的改动名额，这条派发不了` : ''),
    );
    console.log(line('='));
    console.log(`\n【Contract r${view.contractRevision}】${view.contract?.intent ?? '（无）'}`);
    for (const item of view.contract?.acceptance ?? []) console.log(`  验收 · ${item}`);
    for (const item of view.contract?.guardrails ?? []) console.log(`  红线 · ${item}`);

    if (view.plan) {
      console.log(`\n【Plan r${view.planRevision}】`);
      if (view.plan.rootCause) console.log(`  根因：${view.plan.rootCause}`);
      console.log(`  方向：${view.plan.direction}`);
      for (const item of view.plan.rejectedHypotheses) console.log(`  已排除 · ${item}`);
    }

    console.log(`\n【工作项】`);
    for (const item of view.workItems) {
      console.log(`  ${item.id.padEnd(6)}${item.status.padEnd(11)}${item.attempts} 次尝试  ${item.title}`);
      if (item.lastReview) {
        console.log(`      L2 验收：${item.lastReview.verdict} —— ${item.lastReview.reasons[0] ?? ''}`);
        // 方案 §11：没验证的那几条要摆到 L3 眼前，一句总结里看不出来。
        const results = item.lastReview.acceptanceResults ?? [];
        if (results.length > 0) {
          const passed = results.filter((r) => r.status === 'pass').length;
          console.log(`      逐条：${passed}/${results.length} pass`);
          for (const r of results.filter((x) => x.status !== 'pass')) {
            const mark = r.status === 'fail' ? '✗ 未过' : r.status === 'unverified' ? '⚠ 未验证' : '— 不适用';
            console.log(`        ${mark} ${r.criterion}${r.note ? ` —— ${r.note}` : ''}`);
          }
        }
      }
    }

    const diff = await platform.getMissionDiff(target);
    console.log(`\n【改动】${view.workspaceRef?.branch ?? '（无分支）'}`);
    console.log(
      diff.stat
        .split(/\r?\n/)
        .map((l) => `  ${l}`)
        .join('\n'),
    );
    // 上面那份 diff **不含**记忆文件：它们是 merge 那一刻才写进 worktree 的。
    // 不在这里点破，L3 就会把这份清单当成"将要落地的全部"——实测 P1 因此
    // 落了三个没人看过的文件。
    if (diff.pendingMemory.length > 0) {
      console.log(`\n  ⚠ 另有 ${diff.pendingMemory.length} 个文件会随本次落地一并写入项目：`);
      for (const file of diff.pendingMemory) console.log(`      ${file}`);
      console.log('      （正文见下面的「记忆」；VIBE.md 是由它们生成的索引）');
    }

    if (view.result) {
      console.log(`\n【L2 交卷】${view.result.outcome}`);
      console.log(`  ${view.result.summary}`);
      for (const item of view.result.acceptanceEvidence) console.log(`  证据 · ${item}`);
      for (const item of view.result.openRisks) console.log(`  遗留 · ${item}`);
      // 记忆增量跟着落地那次 merge 一起写进项目。**签字之前必须看得见正文**——
      // 只印一行 [object Object] 等于让 L3 盲签，而这些内容会长期影响
      // 后续每一条 Mission 的判断。
      for (const item of view.result.memoryDelta) {
        console.log(`\n  记忆 · [${item.kind}] ${item.slug} —— ${item.title}`);
        for (const line of item.body.split('\n')) console.log(`      ${line}`);
      }
    }

    const usage = view.usage;
    console.log(
      `\n【用量 ${usage.quality}】in=${usage.input} out=${usage.output} ` +
        `cacheRead=${usage.cacheRead} cost=$${(usage.cost ?? 0).toFixed(4)}`,
    );

    if (view.haReviewHold || view.waitDetail || view.independentReviewBlockReason) {
      const holdLabel =
        view.haReviewHold === 'pending_dispatch'
          ? '待派发'
          : view.haReviewHold === 'in_review'
            ? '在审'
            : view.haReviewHold === 'pending_release'
              ? '待放行'
              : view.haReviewHold === 'fault'
                ? '故障'
                : undefined;
      if (holdLabel) console.log(`\n【HA 检视】${holdLabel}`);
      else console.log('');
      if (view.waitDetail) console.log(`  等待：${view.waitDetail}`);
      if (view.independentReviewBlockReason) {
        console.log(`  阻塞：${view.independentReviewBlockReason}`);
        if (view.independentReviewBlockDetail) {
          console.log(`  细节：${view.independentReviewBlockDetail}`);
        }
      }
    }

    if (view.finalReview) {
      console.log(`\n【最终检视】${view.finalReview.verdict}`);
      for (const reason of view.finalReview.reasons) console.log(`  理由 · ${reason}`);
      const authority = view.finalReview.authority;
      // 旧记录没有 authority 就写「未记录」，不推断成 human。
      if (!authority) {
        console.log('  权威：未记录');
      } else if (authority.kind === 'human') {
        console.log('  权威：人');
        if (authority.principalId) console.log(`  主体：${authority.principalId}`);
      } else if (authority.kind === 'machine') {
        console.log('  权威：机器');
        console.log(`  集成报告：${authority.integrationReportId}`);
      } else if (authority.kind === 'plan') {
        console.log('  权威：方案');
        console.log(`  方案运行：${authority.planRunId}`);
        console.log(`  升级单：${authority.escalationId}`);
      } else if (authority.kind === 'reviewer') {
        console.log('  权威：检视者');
        console.log(`  检视者：${authority.reviewerId}`);
        console.log(`  确认人：${authority.confirmedBy}`);
        console.log(`  确认于：${authority.confirmedAt}`);
      }
    }

    if (view.status === 'awaiting_review') {
      console.log(`\n下一步：merge / send-back / abandon`);
    }
    return;
  }

  if (command === 'merge' || command === 'send-back' || command === 'abandon') {
    if (!target) throw new Error('需要 missionId');
    const reason = arg('--reason');
    if (!reason && command !== 'merge') {
      throw new Error('打回/放弃必须给 --reason —— 不说清楚，协调者只会原样再交一次');
    }
    const verdict = command === 'send-back' ? 'send_back' : command;
    const review = {
      verdict: verdict as 'merge' | 'send_back' | 'abandon',
      reasons: reason ? [reason] : [],
      projectRoot: arg('--repo'),
    };
    let result: { status: string; mergedInto?: string; reason?: string };
    if (reviewerSignature?.mode === 'reviewer') {
      // HA merge 只声明身份；授权以每次现读的外置配置为准，不走旧 reviewer 入口。
      const view =
        command === 'merge' ? await platform.getMissionView(target) : undefined;
      result =
        command === 'merge' && view?.executionMode === 'high_assurance'
          ? await platform.finalizeMissionByHaAuthority(target, {
              reviewerId: reviewerSignature.reviewerId,
              confirmedBy: reviewerSignature.confirmedBy,
              projectRoot: review.projectRoot,
              reasons: review.reasons,
            })
          : await platform.finalizeMissionByReviewer(target, {
              ...review,
              reviewerId: reviewerSignature.reviewerId,
              confirmedBy: reviewerSignature.confirmedBy,
            });
    } else {
      result = await platform.finalizeMission(target, review);
    }
    await persist();

    console.log(`Mission ${target} → ${result.status}`);
    if (result.mergedInto) console.log(`已落地到 ${result.mergedInto.slice(0, 12)}`);
    if (result.reason) console.log(`⚠ ${result.reason}`);
    return;
  }

  if (command === 'answer') {
    if (!target) throw new Error('需要 missionId');
    const answer = arg('--answer');
    if (!answer) throw new Error('需要 --answer "..."');
    const result = await platform.answerEscalation(target, answer);
    await persist();
    console.log(`已答复 ${target} 的升级：`);
    console.log(`  问题：${result.question}`);
    console.log(`  答复：${result.answer}`);
    console.log('\n下一步：重新跑 run-mission，协调者会看到这条答复。');
    return;
  }

  if (command === 'revise') {
    if (!target) throw new Error('需要 missionId');
    const file = arg('--contract');
    if (!file) throw new Error('需要 --contract <mission.json>');
    const spec = JSON.parse(readFileSync(resolve(file), 'utf8')) as {
      contract: Parameters<typeof platform.reviseContract>[1];
    };
    const result = await platform.reviseContract(target, spec.contract);
    await persist();
    const view = await platform.getMissionView(target);
    console.log(`Contract → r${result.contractRevision}，Mission 现在是 ${view.status}`);
    if (view.finalReview?.verdict === 'send_back') {
      console.log('（原先在等检视，已按新契约退回规划——旧的那份交卷是照着旧契约做的）');
    }
    return;
  }

  if (command === 'park') {
    if (!target) throw new Error('需要 missionId');
    await platform.parkMission(target, { reason: arg('--reason')!, reviewer: arg('--as')! });
    await persist();
    return;
  }

  if (command === 'cancel' || command === 'pause' || command === 'resume') {
    if (!target) throw new Error('需要 missionId');
    if (command === 'cancel') {
      const result = await platform.cancelMission(target, arg('--reason'));
      await persist();
      console.log(`Mission ${target} → ${result.status}（已叫停）`);
      console.log('在途的那一跳会正常收尾，之后不再调度。');
    } else if (command === 'pause') {
      await platform.pauseMission(target);
      await persist();
      console.log(`Mission ${target} 已暂停。阶段保持原样，resume 之后重跑 run-mission 即可。`);
    } else if (arg('--reason') !== undefined) {
      await platform.resumeParkedMission(target, { reason: arg('--reason')!, reviewer: arg('--as')!, ...(arg('--answer') !== undefined ? { answer: arg('--answer') } : {}) });
      await persist();
    } else {
      await platform.resumeMission(target);
      await persist();
      console.log(`Mission ${target} 已恢复。重跑 run-mission 继续。`);
    }
    return;
  }

  if (command === 'retire') {
    if (!target) throw new Error('需要 missionId');
    const workItemId = arg('--item');
    if (!workItemId) throw new Error('需要 --item <workItemId>');
    const reason = arg('--reason');
    if (!reason) throw new Error('作废必须给 --reason —— 不写清楚，协调者会以为它还该做');
    const result = await platform.retireWorkItem(target, workItemId, reason);
    await persist();
    console.log(`工作项 ${workItemId} → ${result.status}（已作废）`);
    console.log('协调者下次被唤醒时会看到它，并据此判断要不要重做。');
    return;
  }

  if (command === 'rerun') {
    if (!target) throw new Error('需要 missionId');
    const result = await platform.rerunMission(target, {
      newMissionId: arg('--as'),
      baseRevision: arg('--base'),
    });
    await persist();
    console.log(`已另起一条：${result.missionId}（${result.rerunOf} 的重跑，契约 r${result.contractRevision}）`);
    console.log('契约一字没改。原来那条的记录一点没动 —— 重跑的意义就是两份都留着好比。');
    if (result.sourceAlreadyLanded) {
      // 隔离做不到（agent 用绝对路径就能越出 worktree），所以至少要说出来。
      console.log(
        `\n⚠ ${result.rerunOf} 的产出**已经落地进项目了**，这一跑不是干净的对照：\n` +
          '  答案就摆在项目工作区里，agent 读一眼就有 —— 实测上一次对照就是这么毁的\n' +
          '  （它 read 了主仓库里的成品文件、还 git show 了那次交付的提交，不是在解题是在抄）。\n' +
          '  要做对照，用一个**还没合并**的任务，两臂都跑完再决定合哪个。',
      );
    }
    if (result.baseRevision) {
      console.log(`起点钉在 ${result.baseRevision.slice(0, 8)}（与源头同一个版本），两次才可比。`);
    } else {
      console.log(
        '⚠ 源头没记过工作区，起点无法钉住 —— 这一跑会从目标分支当前的 HEAD 分叉，\n' +
          '  和源头不是同一个起点，**跑出来的数不能和它对比**。要比就用 --base <版本> 指定。',
      );
    }
    console.log(`\n下一步：node src/run-mission.ts <mission.json> --cwd <repo>  # missionId 用 ${result.missionId}`);
    console.log(`跑完用 node src/l3.ts runs ${result.missionId} 横着看。`);
    return;
  }

  if (command === 'runs') {
    if (!target) throw new Error('需要 missionId');
    const runs = await platform.listRuns(target);
    if (runs.length <= 1) {
      console.log(`${target} 只跑过一遍，没什么可比的。用 node src/l3.ts rerun ${target} 再跑一次。`);
    }
    const duration = (ms: number | undefined) =>
      ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`;
    const ratio = (n: number, total: number) => total === 0 ? '—' : `${n}/${total}`;
    console.log('运行            lane                 状态           跳数(L2/L1) token       首结果    总耗时    L2拒绝  L3打回  Val失败  升级');
    console.log('─'.repeat(142));
    for (const r of runs) {
      const hops = `${r.coordinatorHops}/${r.executorHops}`;
      const lane = r.entryMode === r.currentMode
        ? r.entryMode
        : `${r.entryMode}→${r.currentMode}`;
      console.log(
        (r.missionId + (r.isOriginal ? ' *' : '')).padEnd(15)
          + lane.padEnd(21)
          + r.status.padEnd(15)
          + hops.padEnd(13)
          + r.usage.total.toLocaleString('en-US').padEnd(12)
          + duration(r.firstExecutionResultMs).padEnd(10)
          + duration(r.totalDurationMs).padEnd(10)
          + ratio(r.l2Rejects, r.l2Reviews).padEnd(8)
          + ratio(r.l3SendBacks, r.l3Reviews).padEnd(8)
          + ratio(r.validatorFailures, r.validatorRuns).padEnd(9)
          + (r.promotionTrigger ?? '—'),
      );
    }
    const bases = new Set(runs.map((r) => r.baseRevision).filter((v): v is string => Boolean(v)));
    const missingBase = runs.some((r) => !r.baseRevision);
    console.log('\n* = 最初那条。比例列是「次数/总次数」，不是自动判定好坏。');
    if (missingBase) {
      console.log('⚠ 至少一条运行没有 baseRevision；这些运行不能证明是同一起点。');
    }
    if (bases.size > 1) {
      console.log('⚠ 这些运行存在多个 baseRevision；起点不同，不能把差异直接归因给 Fast Lane。');
    }
    // A/B 表没有「结束原因」列，但自掐和候选挂掉读法完全不同：前者要改工单或调
    // 策略，换候选只会把同一件事再烧一遍。所以只在真的发生过自掐时才提示，并带上
    // 是哪几条——否则这行就是在解释一个不存在的列。
    const selfKilled = runs
      .map((r) => ({
        missionId: r.missionId,
        n: (r.endedBy.killed_idle ?? 0) + (r.endedBy.killed_wall_clock ?? 0),
      }))
      .filter((r) => r.n > 0);
    if (selfKilled.length > 0) {
      console.log(
        '⚠ killed_idle / killed_wall_clock 是**我们自己掐的**，不是候选挂了：'
          + selfKilled.map((r) => `${r.missionId}×${r.n}`).join(' '),
      );
    }
    return;
  }

  if (command === 'ack') {
    if (!target) throw new Error('需要 deliveryId');
    const delivery = await deliveries.acknowledge(target);
    await persist();
    console.log(delivery ? `${target} 已确认` : `没有这条投递：${target}`);
    return;
  }

  if (command === 'plan') {
    const releaseAction = target === 'approve' || target === 'send-back' ? target : undefined;
    const explicitRun = arg('--run');
    if (releaseAction && !explicitRun) throw new Error('plan approve/send-back 必须指定 --run <记录>。');
    const runPath =
      explicitRun ?? latestPlanRun(resolve(arg('--run-dir') ?? join(dirname(statePath), '.coagent-plans')));
    if (!runPath) throw new Error('没有方案运行记录（先 node src/run-plan.ts 开跑，或用 --run 指定）。');
    const store = new FilePlanRunStore(runPath);

    if (releaseAction) {
      const values = ['--feature', '--commit', '--review', '--report', '--target'];
      const parsed = Object.fromEntries(values.map((key) => [key, reviewFlag(key)])) as Record<string, { present: boolean; value?: string }>;
      for (const key of values) if (!parsed[key].value?.trim()) throw new Error(`${key} 必填且不能为空。`);
      const signature = parseReviewerSignature();
      if (signature.mode !== 'reviewer') throw new Error('--as 与 --confirmed-by 必填。');
      const reason = arg('--reason');
      if (releaseAction === 'send-back' && !reason?.trim()) throw new Error('send-back 必须提供非空 --reason。');
      const feature = parsed['--feature'].value!;
      // CLI 只核对 PlanRun 已冻结的绑定；实时 Mission 与 Git 证据由后续驱动复核。
      const missionId = process.argv[4];
      if (!missionId || missionId.startsWith('--')) throw new Error('要指定 Mission id：plan approve/send-back <missionId> ...');
      await store.update((run) => run.decideHaRelease({
        featureId: feature, missionId, reviewedCommit: parsed['--commit'].value!, attemptId: parsed['--review'].value!,
        validationReportId: parsed['--report'].value!, target: parsed['--target'].value!, as: signature.reviewerId,
        confirmedBy: signature.confirmedBy, action: releaseAction === 'send-back' ? 'send_back' : 'approve',
        ...(releaseAction === 'send-back' ? { reason: reason! } : {}),
      }, new Date().toISOString()));
      console.log(`HA ${releaseAction} 已记录（仅为签字声明，非逐次点击认证）。`);
      return;
    }
    if (target === 'decide') {
      const escalationId = process.argv[4];
      if (!escalationId || escalationId.startsWith('--')) throw new Error('要指定升级单：plan decide <E-n> ...');
      const decidedBy = arg('--as');
      // 只有本次运行指定的检视者作数；不写你是谁，规则就没法核对。
      if (!decidedBy) throw new Error('要写明你是谁（--as <检视者>）：只有本次运行指定的检视者的决定作数。');
      const drop = arg('--drop');
      const answer = arg('--answer');
      const decided = await store.update((run) =>
        run.choose(
          escalationId,
          {
            action: arg('--action'),
            reason: arg('--reason') ?? '',
            decidedBy,
            // 没给就是没给：别的动作夹带一个空名单也会被拒。
            ...(drop !== undefined
              ? { dropFeatures: drop.split(',').map((id) => id.trim()).filter(Boolean) }
              : {}),
            // 交给 choose 校验：空白/过长/不可答复都在规则里拒，这里不预判。
            ...(answer !== undefined ? { answer } : {}),
          },
          new Date().toISOString(),
        ),
      );
      const resolution = decided.resolution;
      const summary =
        resolution?.kind !== 'decided'
          ? '?'
          : resolution.action === 'answer'
            ? `answer —— ${resolution.answer}`
            : `${resolution.action} —— ${resolution.reason}`;
      console.log(`已定 ${decided.id}（${decided.featureId}）：${summary}`);
      console.log('驱动方下次读记录（最多 15 秒）就会照办。');
      return;
    }

    const run = store.read();
    if (!run) throw new Error(`读不到方案运行记录：${runPath}`);
    const costs = await planCosts(run, platform, built.queryRuns);
    for (const text of renderPlanHandoff(run, { now: new Date().toISOString(), costs, recordPath: store.path })) {
      console.log(text);
    }
    return;
  }

  console.log(`用法：
  node src/l3.ts inbox [--recipient X]        列出待取的结果
  node src/l3.ts show <missionId>             看契约、计划、工作项、改动、交卷内容
  node src/l3.ts merge <missionId> [--reason] [--as <检视者> --confirmed-by <确认人>] 放行并落地到目标分支
  node src/l3.ts send-back <missionId> --reason "..." [--as <检视者> --confirmed-by <确认人>]  打回给协调者重做
  node src/l3.ts abandon <missionId> --reason "..." [--as <检视者> --confirmed-by <确认人>]    放弃
  node src/l3.ts answer <missionId> --answer "..."     答复协调者的升级（仅方案运行之外；方案中的升级是 AQ1 唯一路径：plan decide --action answer。HTTP 不复制续跑）
  node src/l3.ts revise <missionId> --contract <file>  发布新契约（在等检视的会退回规划）
  node src/l3.ts cancel <missionId> [--reason] 叫停（终态，释放改动名额）
  node src/l3.ts pause <missionId>            暂停（阶段不变，调度器不碰）
  node src/l3.ts resume <missionId>           恢复
  node src/l3.ts retire <missionId> --item <W-n> --reason "..."  作废一个工作项
  node src/l3.ts rerun <missionId> [--as <id>] 照当前契约再跑一遍（另起一条，原来那条不动）
  node src/l3.ts runs <missionId>             同一任务的历次运行横着比：lane/token/时延/打回/升级
  node src/l3.ts ack <deliveryId>             确认收到
  node src/l3.ts plan [--run <记录>]          方案运行交接面：✓ 已合入 / ⏸ 挂起等你 / ⊘ 检视者跳过 / ○ 没轮到
  node src/l3.ts plan decide <E-n> --action <rerun_isolated|skip|rescope|stop> --reason "..." [--drop F7,F8] --as <检视者>
  node src/l3.ts plan decide <E-n> --action answer --answer "..." --as <检视者> [--reason "..."] [--run <记录>]

公共参数：--state <状态文件>  --repo <项目仓库>`);
}

/** 状态文件旁 .coagent-plans/ 里最新的那份记录（按修改时间）。 */
function latestPlanRun(dir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  // 以点开头的是写入时的临时文件与锁目录，不是记录。
  const records = names.filter((name) => name.endsWith('.json') && !name.startsWith('.'));
  let newest: { path: string; mtime: number } | undefined;
  for (const name of records) {
    const path = join(dir, name);
    const mtime = statSync(path).mtimeMs;
    if (!newest || mtime > newest.mtime) newest = { path, mtime };
  }
  return newest?.path;
}

/**
 * 这一晚花了多少：各条 Mission 报上来的，加上现做分类的只读会话。
 *
 * 没报的**不当 0**：单独计数，交接面上写「另有 N 条没报」——把未知当 0，
 * 用户拿首行去校准阈值时就会低估。
 */
async function planCosts(
  run: PlanRun,
  platform: { getMissionView(missionId: string): Promise<{ usage: { cost?: number; quality: string } }> },
  queryRuns: { list(projectId?: string): Promise<readonly { source: string; usage: { cost?: number; quality: string } }[]> },
): Promise<HandoffCosts> {
  let missions = 0;
  let routing = 0;
  let unknownRuns = 0;
  const tally = (usage: { cost?: number; quality: string }) => {
    if (usage.quality !== 'reported') unknownRuns += 1;
    return usage.quality === 'unknown' ? 0 : (usage.cost ?? 0);
  };
  for (const feature of run.features) {
    for (const missionId of feature.missionIds) {
      const view = await platform.getMissionView(missionId).catch(() => undefined);
      if (!view) {
        unknownRuns += 1;
        continue;
      }
      missions += tally(view.usage);
    }
  }
  for (const query of await queryRuns.list(run.projectId)) {
    if (query.source.startsWith(`plan-run:${run.id}:`)) routing += tally(query.usage);
  }
  return { missions, routing, unknownRuns };
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
