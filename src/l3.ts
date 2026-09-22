/**
 * L3 的命令行入口：取件、检视、放行/打回/放弃。
 *
 *   node src/l3.ts inbox [--recipient X]
 *   node src/l3.ts show <missionId>
 *   node src/l3.ts merge <missionId> --reason "..."
 *   node src/l3.ts send-back <missionId> --reason "..."
 *   node src/l3.ts abandon <missionId> --reason "..."
 *   node src/l3.ts ack <deliveryId>
 *
 * 直接操作状态文件，不经过 HTTP —— `run-mission` 的服务器是一次性的，
 * 跑完就退，所以平时没有常驻进程。**别在服务器开着的时候用它**：
 * 两个进程各写各的整份状态，后写的会盖掉先写的。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPersistentPlatform, buildPgPlatform } from './main.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function line(char = '─', n = 72): string {
  return char.repeat(n);
}

async function main() {
  const [, , command, target] = process.argv;
  const statePath = resolve(arg('--state') ?? '.coagent-state.json');
  // 只读命令不抢锁：一边跑 Mission 一边 inbox/show 是常态。
  const readOnly = command === 'inbox' || command === 'show' || command === undefined;
  const usePg = (arg('--store') ?? process.env.COAGENT_STORE ?? 'file') === 'pg';
  const built = usePg
    ? // L3 从不接手在途 attempt —— 它只放行/打回。所以**不做启动收敛**：
      // 一个只看结果的命令没有立场判定别的进程死了。
      await buildPgPlatform()
    : await buildPersistentPlatform(statePath, {
        exclusive: readOnly ? undefined : { what: `l3 ${command} ${target ?? ''}` },
      });
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
      console.log(`其中 ${escalated.length} 条是升级，需要你答复：node src/l3.ts answer <missionId> --answer "..."`);
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
    const result = await platform.finalizeMission(target, {
      verdict: verdict as 'merge' | 'send_back' | 'abandon',
      reasons: reason ? [reason] : [],
      projectRoot: arg('--repo'),
    });
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

  console.log(`用法：
  node src/l3.ts inbox [--recipient X]        列出待取的结果
  node src/l3.ts show <missionId>             看契约、计划、工作项、改动、交卷内容
  node src/l3.ts merge <missionId> [--reason] 放行并落地到目标分支
  node src/l3.ts send-back <missionId> --reason "..."   打回给协调者重做
  node src/l3.ts abandon <missionId> --reason "..."     放弃
  node src/l3.ts answer <missionId> --answer "..."     答复协调者的升级
  node src/l3.ts revise <missionId> --contract <file>  发布新契约（在等检视的会退回规划）
  node src/l3.ts cancel <missionId> [--reason] 叫停（终态，释放改动名额）
  node src/l3.ts pause <missionId>            暂停（阶段不变，调度器不碰）
  node src/l3.ts resume <missionId>           恢复
  node src/l3.ts retire <missionId> --item <W-n> --reason "..."  作废一个工作项
  node src/l3.ts rerun <missionId> [--as <id>] 照当前契约再跑一遍（另起一条，原来那条不动）
  node src/l3.ts runs <missionId>             同一任务的历次运行横着比：lane/token/时延/打回/升级
  node src/l3.ts ack <deliveryId>             确认收到

公共参数：--state <状态文件>  --repo <项目仓库>`);
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
