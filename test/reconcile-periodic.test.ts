/**
 * 周期投递修复：调度函数、文件版 tick、PG tick。
 *
 * 不把 Attempt / worktree 收敛改成定时任务；这里只验「按间隔补可核实投递」。
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireLock, LockBusyError } from '../src/application/lock.ts';
import {
  FileActivityLog,
  FileDeliveryRepository,
  FileProjectRepository,
  FileStateStore,
  PersistentIds,
} from '../src/application/file-store.ts';
import { SystemClock } from '../src/application/in-memory.ts';
import {
  PgActivityLog,
  PgDeliveryRepository,
  PgIds,
  PgProjectRepository,
  PgStateStore,
  PERIODIC_RECONCILE_LOCK_KEY1,
  PERIODIC_RECONCILE_LOCK_KEY2,
  tryPgAdvisoryLock,
} from '../src/application/pg-store.ts';
import {
  cleanupAfterSignal,
  formatErrorForLog,
  parseReconcileIntervalMs,
  repairMissingDeliveries,
  runIndependentCleanup,
  startPeriodicReconcile,
} from '../src/application/reconcile.ts';
import {
  buildFileDeliveryRepairDeps,
  runFileObserverDeliveryRepairTick,
  runHeldFileDeliveryRepair,
  runPgDeliveryRepairTick,
  startPeriodicDeliveryRepair,
  startServer,
} from '../src/main.ts';
import { ensureTestDatabase } from './helpers/pg.ts';
import type { MissionContract } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const RESULT = {
  outcome: 'delivered' as const,
  summary: '交付',
  acceptanceEvidence: [] as string[],
  memoryDelta: [] as never[],
  openRisks: [] as string[],
};

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-periodic-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 等条件成立，而不是固定睡一段再断言：机器一忙计时器就会延后，固定睡几十毫秒就断言
// 「至少跑了两轮」会整轮假红。上限给足 5 秒，条件一满足立刻返回，不拖慢正常情况。
// 只用于「应当发生」的断言；「不应发生」的断言仍用固定睡眠。
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await sleep(5);
}

async function seedFileGap(statePath: string, missionId = 'M-gap'): Promise<void> {
  const store = new FileStateStore(statePath);
  const clock = new SystemClock();
  const projects = new FileProjectRepository(store);
  const activity = new FileActivityLog(store, clock);
  const project = await projects.ensure('P');
  const mission = project.createMission({
    id: missionId,
    contract: CONTRACT,
    origin: { clientType: 'test' },
  });
  const attempt = mission.startCoordinatorAttempt();
  mission.recordResult(RESULT);
  mission.submitForReview();
  projects.persist();
  await activity.append({
    projectId: 'P',
    missionId,
    attemptId: attempt.id,
    kind: 'mission_result.submitted',
    data: { outcome: 'delivered' },
  });
}

async function fileDeliveries(statePath: string, missionId: string) {
  const store = new FileStateStore(statePath);
  const deliveries = new FileDeliveryRepository(store, new SystemClock(), new PersistentIds(store));
  return deliveries.listForMission(missionId);
}

describe('parseReconcileIntervalMs', () => {
  test('未设 = 60000；0 关闭；正整数原样', () => {
    assert.equal(parseReconcileIntervalMs(undefined), 60_000);
    assert.equal(parseReconcileIntervalMs('0'), 0);
    assert.equal(parseReconcileIntervalMs('1500'), 1500);
  });

  test('非法值拒绝', () => {
    for (const raw of ['', '-1', '1.5', 'abc', '01', ' 1', '+1']) {
      assert.throws(() => parseReconcileIntervalMs(raw), /COAGENT_RECONCILE_INTERVAL_MS/);
    }
  });
});

describe('startPeriodicReconcile 调度', () => {
  test('按间隔跑；0 不跑', async () => {
    let n = 0;
    const running = startPeriodicReconcile({
      intervalMs: 25,
      tick: async () => {
        n += 1;
      },
      warn: () => {},
    });
    await waitFor(() => n >= 2);
    await running.stop();
    assert.ok(n >= 2, `应至少跑两轮，实际 ${n}`);

    let zero = 0;
    const off = startPeriodicReconcile({
      intervalMs: 0,
      tick: async () => {
        zero += 1;
      },
      warn: () => {},
    });
    await sleep(60);
    await off.stop();
    assert.equal(zero, 0);
  });

  test('慢 tick 不重叠', async () => {
    let concurrent = 0;
    let max = 0;
    let started = 0;
    const handle = startPeriodicReconcile({
      intervalMs: 15,
      tick: async () => {
        started += 1;
        concurrent += 1;
        max = Math.max(max, concurrent);
        await sleep(50);
        concurrent -= 1;
      },
      warn: () => {},
    });
    // 至少两轮开始过，「不重叠」才有意义；固定睡 140 毫秒时机器一忙可能一轮都没开始，
    // max 为 0 反而假红，只跑一轮时又什么都没证明。
    await waitFor(() => started >= 2);
    await handle.stop();
    assert.ok(started >= 2, `应至少开始两轮，实际 ${started}`);
    assert.equal(max, 1);
  });

  test('tick 抛错只 warn，下一轮照跑', async () => {
    const warns: string[] = [];
    let n = 0;
    const handle = startPeriodicReconcile({
      intervalMs: 20,
      tick: async () => {
        n += 1;
        if (n === 1) throw new Error('boom');
      },
      warn: (message) => {
        warns.push(message);
      },
    });
    await waitFor(() => n >= 2);
    await handle.stop();
    assert.ok(n >= 2, `失败后应继续，实际 ${n}`);
    assert.ok(warns.some((row) => row.includes('boom')));
  });

  test('warn 抛错时调度继续，stop 正常完成', async () => {
    let n = 0;
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const handle = startPeriodicReconcile({
        intervalMs: 20,
        tick: async () => {
          n += 1;
          if (n === 1) throw new Error('tick-boom');
        },
        warn: () => {
          throw new Error('warn-boom');
        },
      });
      await waitFor(() => n >= 2);
      await handle.stop();
      assert.ok(n >= 2, `warn 抛错后应继续，实际 ${n}`);
      assert.ok(lines.some((row) => row.includes('tick-boom')));
    } finally {
      console.warn = original;
    }
  });

  test('stop 等待在途 tick，之后不再跑', async () => {
    let inTick = false;
    let finished = false;
    let n = 0;
    const handle = startPeriodicReconcile({
      intervalMs: 20,
      tick: async () => {
        n += 1;
        inTick = true;
        await sleep(50);
        finished = true;
      },
      warn: () => {},
    });
    await waitFor(() => inTick);
    assert.equal(inTick, true);
    const stopping = handle.stop();
    assert.equal(finished, false);
    await stopping;
    assert.equal(finished, true);
    const after = n;
    await sleep(60);
    assert.equal(n, after);
  });
});

describe('startPeriodicDeliveryRepair 共用装配', () => {
  test('间隔 0 不启动，连传入的 tick 都不跑', async () => {
    let n = 0;
    const handle = startPeriodicDeliveryRepair({
      intervalMs: 0,
      warn: () => {},
      mode: { kind: 'file-observer', statePath: tempState() },
      tick: async () => {
        n += 1;
      },
    });
    assert.equal(handle, undefined);
    await sleep(40);
    assert.equal(n, 0);
  });

  test('正间隔走同一调度：传入 tick 会跑，stop 后不再排', async () => {
    let n = 0;
    const handle = startPeriodicDeliveryRepair({
      intervalMs: 20,
      warn: () => {},
      mode: { kind: 'file-observer', statePath: tempState() },
      tick: async () => {
        n += 1;
      },
    });
    assert.ok(handle, '正间隔应返回可 stop 的句柄');
    await waitFor(() => n >= 1);
    await handle.stop();
    const after = n;
    await sleep(50);
    assert.equal(n, after);
  });

  test('startServer 文件版正间隔在主锁下补可核实投递，无 self lock-busy', async () => {
    const statePath = tempState();
    await seedFileGap(statePath);
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    let built: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      built = await startServer(0, statePath, {
        env: { COAGENT_STORE: 'file', COAGENT_RECONCILE_INTERVAL_MS: '20' },
      });
      assert.throws(() => acquireLock(statePath, 'probe-server-held'), LockBusyError);
      const deadline = Date.now() + 5000;
      while ((await fileDeliveries(statePath, 'M-gap')).length !== 1 && Date.now() < deadline) {
        await sleep(10);
      }
      assert.equal((await fileDeliveries(statePath, 'M-gap')).length, 1);
      assert.equal(
        warns.filter((row) => row.includes('锁忙')).length,
        0,
        '主锁下补投递不得对自己锁忙',
      );
    } finally {
      console.warn = originalWarn;
      if (built) {
        await new Promise<void>((done, fail) => {
          built!.server.close((err) => (err ? fail(err) : done()));
        });
      }
    }
  });

  test('未覆盖 tick 时文件已持锁 mode 仍补可核实投递', async () => {
    const statePath = tempState();
    await seedFileGap(statePath);
    const store = new FileStateStore(statePath);
    const handle = startPeriodicDeliveryRepair({
      intervalMs: 20,
      warn: () => {},
      mode: { kind: 'file-held', store },
    });
    assert.ok(handle);
    try {
      const deadline = Date.now() + 5000;
      while ((await fileDeliveries(statePath, 'M-gap')).length !== 1 && Date.now() < deadline) {
        await sleep(10);
      }
      assert.equal((await fileDeliveries(statePath, 'M-gap')).length, 1);
    } finally {
      await handle.stop();
    }
  });
});

describe('runIndependentCleanup', () => {
  test('stop 拒绝时 persist 与 release 仍被调用，错误被记录', async () => {
    const calls: string[] = [];
    const reports: string[] = [];
    await assert.rejects(
      () =>
        runIndependentCleanup({
          steps: [
            {
              name: 'periodic.stop',
              run: async () => {
                calls.push('stop');
                throw new Error('stop-boom');
              },
            },
            {
              name: 'persist',
              run: async () => {
                calls.push('persist');
              },
            },
            {
              name: 'releaseLock',
              run: () => {
                calls.push('release');
              },
            },
          ],
          report: (message) => {
            reports.push(message);
          },
        }),
      /stop-boom/,
    );
    assert.deepEqual(calls, ['stop', 'persist', 'release']);
    assert.ok(reports.some((row) => row.includes('periodic.stop') && row.includes('stop-boom')));
  });

  test('主流程错误与 stop、persist 都失败：锁仍释放，每个错误可诊断', async () => {
    const calls: string[] = [];
    const reports: string[] = [];
    const primaryErr = new Error('primary-boom');
    const stopErr = new Error('stop-boom');
    const persistErr = new Error('persist-boom');
    await assert.rejects(
      () =>
        runIndependentCleanup({
          primary: { error: primaryErr },
          steps: [
            {
              name: 'periodic.stop',
              run: async () => {
                calls.push('stop');
                throw stopErr;
              },
            },
            {
              name: 'persist',
              run: async () => {
                calls.push('persist');
                throw persistErr;
              },
            },
            {
              name: 'releaseLock',
              run: () => {
                calls.push('release');
              },
            },
          ],
          report: (message) => {
            reports.push(message);
          },
        }),
      (err: unknown) => {
        if (!(err instanceof AggregateError)) {
          assert.fail('应为 AggregateError');
        }
        assert.equal(err.errors[0], primaryErr);
        assert.ok(err.errors.includes(stopErr));
        assert.ok(err.errors.includes(persistErr));
        assert.match(err.message, /主流程失败/);
        assert.match(err.message, /2/);
        assert.match(err.message, /primary-boom/);
        const text = formatErrorForLog(err);
        assert.match(text, /primary-boom/);
        assert.match(text, /stop-boom/);
        assert.match(text, /persist-boom/);
        return true;
      },
    );
    assert.deepEqual(calls, ['stop', 'persist', 'release']);
    assert.ok(reports.some((row) => row.includes('periodic.stop') && row.includes('stop-boom')));
    assert.ok(reports.some((row) => row.includes('persist') && row.includes('persist-boom')));
  });

  test('只有主流程错误、清理全成功：原样抛出，不包装', async () => {
    const calls: string[] = [];
    const primaryErr = new Error('primary-only');
    await assert.rejects(
      () =>
        runIndependentCleanup({
          primary: { error: primaryErr },
          steps: [
            {
              name: 'periodic.stop',
              run: async () => {
                calls.push('stop');
              },
            },
            {
              name: 'persist',
              run: async () => {
                calls.push('persist');
              },
            },
            {
              name: 'releaseLock',
              run: () => {
                calls.push('release');
              },
            },
          ],
          report: () => {},
        }),
      (err: unknown) => {
        assert.equal(err, primaryErr);
        return true;
      },
    );
    assert.deepEqual(calls, ['stop', 'persist', 'release']);
  });

  test('没有主流程错误、清理全成功：正常返回', async () => {
    const calls: string[] = [];
    await runIndependentCleanup({
      steps: [
        {
          name: 'periodic.stop',
          run: async () => {
            calls.push('stop');
          },
        },
        {
          name: 'persist',
          run: () => {
            calls.push('persist');
          },
        },
        {
          name: 'releaseLock',
          run: () => {
            calls.push('release');
          },
        },
      ],
      report: () => {
        throw new Error('不应 report');
      },
    });
    assert.deepEqual(calls, ['stop', 'persist', 'release']);
  });
});

describe('cleanupAfterSignal', () => {
  test('记中断原因、stop、persist 都抛错：仍释锁、exit(130)、函数 resolve', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const calls: string[] = [];
      const reports: string[] = [];
      const exits: number[] = [];
      await cleanupAfterSignal({
        steps: [
          {
            name: 'halt',
            run: async () => {
              calls.push('halt');
              throw new Error('halt-boom');
            },
          },
          {
            name: 'periodic.stop',
            run: async () => {
              calls.push('stop');
              throw new Error('stop-boom');
            },
          },
          {
            name: 'persist',
            run: async () => {
              calls.push('persist');
              throw new Error('persist-boom');
            },
          },
          {
            name: 'releaseLock',
            run: () => {
              calls.push('release');
            },
          },
        ],
        report: (message) => {
          reports.push(message);
        },
        exit: (code) => {
          exits.push(code);
        },
      });
      await new Promise((done) => setTimeout(done, 20));
      assert.deepEqual(calls, ['halt', 'stop', 'persist', 'release']);
      assert.ok(reports.some((row) => row.includes('halt') && row.includes('halt-boom')));
      assert.ok(reports.some((row) => row.includes('periodic.stop') && row.includes('stop-boom')));
      assert.ok(reports.some((row) => row.includes('persist') && row.includes('persist-boom')));
      assert.deepEqual(exits, [130]);
      assert.equal(rejections.length, 0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('releaseLock 自己抛错：仍 exit(130)，错误被 report', async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const reports: string[] = [];
      const exits: number[] = [];
      await cleanupAfterSignal({
        steps: [
          { name: 'halt', run: async () => {} },
          { name: 'periodic.stop', run: async () => {} },
          { name: 'persist', run: async () => {} },
          {
            name: 'releaseLock',
            run: () => {
              throw new Error('lock-boom');
            },
          },
        ],
        report: (message) => {
          reports.push(message);
        },
        exit: (code) => {
          exits.push(code);
        },
      });
      await new Promise((done) => setTimeout(done, 20));
      assert.ok(reports.some((row) => row.includes('releaseLock') && row.includes('lock-boom')));
      assert.deepEqual(exits, [130]);
      assert.equal(rejections.length, 0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('formatErrorForLog', () => {
  test('展开嵌套 AggregateError 与 cause，循环引用不死循环', () => {
    const leaf = new Error('leaf');
    const nested = new AggregateError([leaf], 'inner');
    Object.defineProperty(nested, 'cause', { value: new Error('cause-msg') });
    const outer = new AggregateError([nested], 'outer');
    const text = formatErrorForLog(outer);
    assert.match(text, /outer/);
    assert.match(text, /inner/);
    assert.match(text, /leaf/);
    assert.match(text, /cause-msg/);

    const cycle = new Error('cycle-root');
    Object.defineProperty(cycle, 'cause', { value: cycle });
    const cycled = formatErrorForLog(cycle);
    assert.match(cycled, /cycle-root/);
    assert.match(cycled, /循环引用/);

    const agg = new AggregateError([], 'agg-cycle');
    agg.errors.push(agg);
    const looped = formatErrorForLog(agg);
    assert.match(looped, /循环引用/);
  });
});

describe('文件版 tick', () => {
  test('锁被别人持有时不写；放锁后下一轮补建', async () => {
    const statePath = tempState();
    await seedFileGap(statePath);
    const release = acquireLock(statePath, '测试占锁');
    const warns: string[] = [];
    try {
      await runFileObserverDeliveryRepairTick(statePath, (message) => warns.push(message));
      assert.ok(warns.some((row) => row.includes('锁忙')));
      assert.equal((await fileDeliveries(statePath, 'M-gap')).length, 0);
    } finally {
      release();
    }
    await runFileObserverDeliveryRepairTick(statePath, () => {});
    assert.equal((await fileDeliveries(statePath, 'M-gap')).length, 1);
  });

  test('run-plan 持锁路径注入 hasArchivedMission：归档视为 skipped', async () => {
    const statePath = tempState();
    await seedFileGap(statePath);
    const store = new FileStateStore(statePath);
    const deps = buildFileDeliveryRepairDeps(store);
    assert.equal(typeof deps.isArchivedMission, 'function');
    assert.equal(deps.isArchivedMission!('no-such'), false);
    const skipped = await repairMissingDeliveries({
      ...deps,
      isArchivedMission: () => true,
    });
    assert.equal(skipped.created.length, 0);
    assert.ok(skipped.skipped.some((row) => row.reason.includes('归档')));
    await runHeldFileDeliveryRepair(store, () => {});
    assert.equal((await fileDeliveries(statePath, 'M-gap')).length, 1);
  });

  test('补建单项失败记 warning，不阻断下一轮恢复', async () => {
    const statePath = tempState();
    await seedFileGap(statePath);
    const original = FileDeliveryRepository.prototype.create;
    let failOnce = true;
    FileDeliveryRepository.prototype.create = async function (input) {
      if (failOnce) {
        failOnce = false;
        throw new Error('模拟投递写入失败');
      }
      return original.call(this, input);
    };
    const warns: string[] = [];
    try {
      await runFileObserverDeliveryRepairTick(statePath, (message) => warns.push(message));
      assert.ok(
        warns.some((row) => row.includes('M-gap') && row.includes('模拟投递写入失败')),
        `应告警 Mission 与原因，实际 ${warns.join(' | ')}`,
      );
      assert.equal((await fileDeliveries(statePath, 'M-gap')).length, 0);
      await runFileObserverDeliveryRepairTick(statePath, (message) => warns.push(message));
      assert.equal((await fileDeliveries(statePath, 'M-gap')).length, 1);
      assert.equal(
        warns.filter((row) => row.includes('补建失败')).length,
        1,
        '第二轮成功不应再刷故障 warning',
      );
    } finally {
      FileDeliveryRepository.prototype.create = original;
    }
  });
});

describe('PG tick', () => {
  let dsn = '';
  let available = false;

  before(async () => {
    const target = await ensureTestDatabase('c5bper');
    if (!target) return;
    dsn = target;
    const boot = await PgStateStore.open({ connectionString: dsn });
    await boot.close();
    available = true;
  });

  function skipIfNoPg(t: { skip: (reason?: string) => void }): boolean {
    if (!available) {
      t.skip('没有可用的 Postgres —— 文件版仍是默认存储，这组跳过');
      return true;
    }
    return false;
  }

  async function reset(): Promise<void> {
    const store = await PgStateStore.open({ connectionString: dsn });
    try {
      await store.pool.query(
        'TRUNCATE projects, activity, deliveries, id_counters, query_runs, validation_reports',
      );
    } finally {
      await store.close();
    }
  }

  async function seedPgGap(missionId = 'M-gap'): Promise<void> {
    const store = await PgStateStore.open({ connectionString: dsn });
    try {
      const clock = new SystemClock();
      const projects = new PgProjectRepository(store);
      const activity = new PgActivityLog(store, clock);
      const project = await projects.ensure('P');
      const mission = project.createMission({
        id: missionId,
        contract: CONTRACT,
        origin: { clientType: 'test' },
      });
      const attempt = mission.startCoordinatorAttempt();
      mission.recordResult(RESULT);
      mission.submitForReview();
      await projects.persist();
      await activity.append({
        projectId: 'P',
        missionId,
        attemptId: attempt.id,
        kind: 'mission_result.submitted',
        data: { outcome: 'delivered' },
      });
    } finally {
      await store.close();
    }
  }

  async function pgDeliveries(missionId: string) {
    const store = await PgStateStore.open({ connectionString: dsn });
    try {
      return await new PgDeliveryRepository(store, new SystemClock(), new PgIds(store)).listForMission(
        missionId,
      );
    } finally {
      await store.close();
    }
  }

  test('能看见别的进程先前提交的缺口并补建', async (t) => {
    if (skipIfNoPg(t)) return;
    await reset();
    await seedPgGap();
    assert.equal((await pgDeliveries('M-gap')).length, 0);
    await runPgDeliveryRepairTick({ connectionString: dsn, warn: () => {} });
    assert.equal((await pgDeliveries('M-gap')).length, 1);
  });

  test('两个实例竞争时至多一个执行；锁持有者会让另一轮跳过', async (t) => {
    if (skipIfNoPg(t)) return;
    await reset();
    await seedPgGap();
    const holder = await PgStateStore.open({ connectionString: dsn });
    try {
      const lock = await tryPgAdvisoryLock(
        holder.pool,
        PERIODIC_RECONCILE_LOCK_KEY1,
        PERIODIC_RECONCILE_LOCK_KEY2,
      );
      assert.equal(lock.held, true);
      const warns: string[] = [];
      await Promise.all([
        runPgDeliveryRepairTick({
          connectionString: dsn,
          warn: (message) => warns.push(message),
        }),
        runPgDeliveryRepairTick({
          connectionString: dsn,
          warn: (message) => warns.push(message),
        }),
      ]);
      assert.equal(warns.filter((row) => row.includes('互斥')).length, 2);
      assert.equal((await pgDeliveries('M-gap')).length, 0);
      await lock.release();
    } finally {
      await holder.close();
    }
    await runPgDeliveryRepairTick({ connectionString: dsn, warn: () => {} });
    assert.equal((await pgDeliveries('M-gap')).length, 1);
  });

  test('不把别人正在跑的 Attempt 判死；tick 后锁与连接释放', async (t) => {
    if (skipIfNoPg(t)) return;
    await reset();
    const live = await PgStateStore.open({ connectionString: dsn });
    try {
      const projects = new PgProjectRepository(live);
      const project = await projects.ensure('P-live');
      const mission = project.createMission({ id: 'M-live', contract: CONTRACT });
      const attempt = mission.startCoordinatorAttempt();
      await projects.persist();
      assert.equal(attempt.status, 'in_progress');

      await seedPgGap('M-other');
      await runPgDeliveryRepairTick({ connectionString: dsn, warn: () => {} });

      await live.refresh();
      const still = live.projectsMap().get('P-live')?.missions.find((row) => row.id === 'M-live');
      assert.equal(still?.coordinatorAttempts[0]?.status, 'in_progress');

      const leftover = await live.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND classid = $1 AND objid = $2`,
        [PERIODIC_RECONCILE_LOCK_KEY1, PERIODIC_RECONCILE_LOCK_KEY2],
      );
      assert.equal(leftover.rows[0]?.n, 0);
    } finally {
      await live.close();
    }
  });

  test('补建单项失败记 warning，不阻断下一轮恢复', async (t) => {
    if (skipIfNoPg(t)) return;
    await reset();
    await seedPgGap();
    const original = PgDeliveryRepository.prototype.create;
    let failOnce = true;
    PgDeliveryRepository.prototype.create = async function (input) {
      if (failOnce) {
        failOnce = false;
        throw new Error('模拟投递写入失败');
      }
      return original.call(this, input);
    };
    const warns: string[] = [];
    try {
      await runPgDeliveryRepairTick({
        connectionString: dsn,
        warn: (message) => warns.push(message),
      });
      assert.ok(
        warns.some((row) => row.includes('M-gap') && row.includes('模拟投递写入失败')),
        `应告警 Mission 与原因，实际 ${warns.join(' | ')}`,
      );
      assert.equal((await pgDeliveries('M-gap')).length, 0);
      await runPgDeliveryRepairTick({
        connectionString: dsn,
        warn: (message) => warns.push(message),
      });
      assert.equal((await pgDeliveries('M-gap')).length, 1);
      assert.equal(
        warns.filter((row) => row.includes('补建失败')).length,
        1,
        '第二轮成功不应再刷故障 warning',
      );
    } finally {
      PgDeliveryRepository.prototype.create = original;
    }
  });
});
