/**
 * 探针：站在**另一个进程**里，对着共用的 Postgres 跑一次启动收敛。
 *
 * 这是当初弄坏一条真 Mission 的那一幕的最小复现——那时是重启了一下观测面，
 * 它开机收敛，把另一个进程正在跑的 attempt 判死写回库。
 *
 * 单元测试能验租约的逻辑，但验不了"心跳真的写进了库、另一个进程真的读得到"。
 * 这个探针才验得了。
 *
 *   node --experimental-strip-types test/helpers/reconcile-probe.ts <missionId>
 */

import { PgStateStore } from '../../src/application/pg-store.ts';
import { reconcileInterruptedAttempts } from '../../src/application/reconcile.ts';
import { ensureTestDatabase } from './pg.ts';

const missionId = process.argv[2];
const useTestDb = process.argv.includes('--test-db');

const store = await PgStateStore.open(
  useTestDb ? { connectionString: (await ensureTestDatabase()) as string } : undefined,
);
const projects = [...store.projectsMap().values()];

const inFlight: { missionId: string; attemptId: string; heartbeatAt?: string; owner?: string }[] = [];
for (const project of projects) {
  for (const mission of project.missions) {
    if (missionId && mission.id !== missionId) continue;
    for (const attempt of [
      ...mission.coordinatorAttempts,
      ...mission.workItems.flatMap((w) => w.attempts),
    ]) {
      if (attempt.status !== 'in_progress') continue;
      inFlight.push({
        missionId: mission.id,
        attemptId: attempt.id,
        heartbeatAt: attempt.heartbeatAt,
        owner: attempt.leaseOwner,
      });
    }
  }
}

// **不落盘**：这是探针，只看收敛会怎么判，不真去改库。
const result = await reconcileInterruptedAttempts(projects, undefined, { missionId });

console.log(JSON.stringify({ inFlight, killed: result.interrupted, alive: result.alive }, null, 2));
await store.close();
