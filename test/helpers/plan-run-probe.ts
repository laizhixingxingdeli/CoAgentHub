/**
 * 探针：站在**另一个进程**里读方案运行记录、写回检视者的决定。
 *
 * 升级握手的全部意义在于跨进程：驱动方和检视者是两个进程。同一进程里开两个
 * store 实例读写同一个文件，验不出「另一个进程真的读得到、写得回」，也验不出
 * 两边抢同一把锁时谁等谁。
 *
 *   node test/helpers/plan-run-probe.ts decide <记录路径> '<参数 JSON>'
 *
 * 参数：escalationId / action / reason / decidedBy / at / dropFeatures?
 *       holdMs?：拿着锁多待一会儿（在锁内打印 LOCKED 再忙等），造出抢锁的现场
 *       lockWaitMs?：等锁的上限
 *
 * 最后一行输出 JSON：{ ok, seen?, code?, message? }。
 */

import { FilePlanRunStore } from '../../src/application/plan-run-store.ts';

const [command, path, argJson] = process.argv.slice(2);
// `node --test` 会把 test/ 下的每个文件都当测试跑一遍；那时没有参数，什么都不做。
if (command === undefined) process.exit(0);
const args = JSON.parse(argJson ?? '{}') as {
  escalationId: string;
  action: string;
  reason: string;
  decidedBy: string;
  at: string;
  dropFeatures?: string[];
  holdMs?: number;
  lockWaitMs?: number;
};

const store = new FilePlanRunStore(path, { lockWaitMs: args.lockWaitMs ?? 5000 });

try {
  if (command !== 'decide') throw new Error(`不认识的命令：${command}`);
  const seen = await store.update((run) => {
    const open = run.currentEscalation;
    if (args.holdMs) {
      process.stdout.write('LOCKED\n');
      const until = Date.now() + args.holdMs;
      while (Date.now() < until) {
        // 忙等：拿着锁不放，逼另一边真的去等。
      }
    }
    run.decide(
      args.escalationId,
      {
        action: args.action,
        reason: args.reason,
        decidedBy: args.decidedBy,
        ...(args.dropFeatures ? { dropFeatures: args.dropFeatures } : {}),
      },
      args.at,
    );
    return open;
  });
  process.stdout.write(`${JSON.stringify({ ok: true, seen })}\n`);
} catch (error) {
  const code = (error as { code?: string }).code;
  process.stdout.write(
    `${JSON.stringify({ ok: false, code, message: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 3;
}
