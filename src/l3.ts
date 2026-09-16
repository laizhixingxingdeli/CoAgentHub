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
    console.log(`Mission ${view.missionId}   ${view.status}${view.isMutating ? '（占着改动名额）' : ''}`);
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
  node src/l3.ts ack <deliveryId>             确认收到

公共参数：--state <状态文件>  --repo <项目仓库>`);
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
