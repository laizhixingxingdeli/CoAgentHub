/**
 * spec: specs/second-server-instance-sweeps-production-tasks.md(cf0c8258)
 *
 * 2026-09-06 事故:执行器为验证看门狗票起了沙箱 server(:3101,端口隔离但
 * **同一个 DATABASE_URL**),其启动兜底把生产在途任务清了场 —— 其中一条正是
 * 它自己所属工作项的协调任务。生产进程从未重启,却有两条任务被标 `server-restart`。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverInterruptedTasks } from "../src/lib/executor-task/queue";

type Row = {
  id: string;
  groupId: string;
  status: string;
  executorKey: string | null;
  executorPid: number | null;
  diffSummary: unknown;
};

function makeDb(rows: Row[]) {
  const updated: Array<{ id: string; status: string; diffSummary: unknown }> =
    [];
  return {
    updated,
    rows,
    db: {
      query: { task: { findMany: async () => rows } },
      update: () => ({
        set: (patch: { status: string; diffSummary: unknown }) => ({
          where: () => ({
            returning: async () => {
              updated.push({ id: "?", ...patch });
              return [{ ...rows[0], ...patch }];
            },
          }),
        }),
      }),
    } as never,
  };
}

/** 真实「另一个实例」的最小替身:一个本进程之外、确实存活的 pid。
 *  属主判据只看「那个 pid 是否活着」,所以用 spawn 出来的长驻子进程最贴近真实
 *  (第二个 server 也是一个真实进程)。测试内 spawn,afterEach 统一回收。 */
let owners: ChildProcess[] = [];

async function spawnLiveOwner(): Promise<ChildProcess> {
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  owners.push(child);
  await new Promise((r) => setTimeout(r, 50)); // 确保 pid 已就位,kill(pid,0) 稳过
  return child;
}

describe("第二个实例启动兜底(cf0c8258)", () => {
  let alivePid: number;
  beforeEach(() => {
    alivePid = process.pid; // 本进程一定活着
  });
  afterEach(() => {
    for (const c of owners) {
      try {
        c.kill();
      } catch {
        /* 已退 */
      }
    }
    owners = [];
  });

  it("R2:从未 spawn 的 queued 任务(executorPid=null)不得被判死,原样留队", async () => {
    const { db, updated } = makeDb([
      {
        id: "t-queued",
        groupId: "g",
        status: "queued",
        executorKey: "codex",
        executorPid: null,
        diffSummary: null,
      },
    ]);
    const failed = await recoverInterruptedTasks(db);
    expect(failed).toBe(0);
    expect(updated).toHaveLength(0);
  });

  it("R1 现场复现:另一个实例启动时,生产的 running(pid 存活)与 queued 都不被清场", async () => {
    const { db, updated } = makeDb([
      {
        id: "t-running-alive",
        groupId: "g",
        status: "running",
        executorKey: "pi",
        executorPid: alivePid,
        diffSummary: null,
      },
      {
        id: "t-queued",
        groupId: "g",
        status: "queued",
        executorKey: "codex",
        executorPid: null,
        diffSummary: null,
      },
    ]);
    expect(await recoverInterruptedTasks(db)).toBe(0);
    expect(updated).toHaveLength(0);
  });

  it("R3:只有「有 pid 但进程已不在」才判 server-restart(这才是真被打断)", async () => {
    const { db, updated } = makeDb([
      {
        id: "t-dead",
        groupId: "g",
        status: "running",
        executorKey: "pi",
        executorPid: 2_147_480_000, // 不可能存在的 pid
        diffSummary: null,
      },
    ]);
    expect(await recoverInterruptedTasks(db)).toBe(1);
    expect(updated).toHaveLength(1);
    expect(updated[0].status).toBe("failed");
    expect((updated[0].diffSummary as { error: string }).error).toBe(
      "server-restart",
    );
  });
});

describe("R1 属主实例存活 → 跳过(2026-09-06 根因定向回归)", () => {
  let owner: ChildProcess;
  beforeEach(async () => {
    owner = await spawnLiveOwner();
  });
  afterEach(() => {
    try {
      owner.kill();
    } catch {
      /* 已退 */
    }
  });

  it("running + 属主存活 + executor 进程已消失 → 仍不判死(核心修复)", async () => {
    // 这正是 2026-09-06 现场:第二实例(本测试进程)启动,生产 running 任务的
    // 协调进程 pid 恰已退出,但属主 server 还活着。旧代码只看 executorPid,
    // 会把它判死;新代码看属主实例,跳过。
    const { db, updated } = makeDb([
      {
        id: "t-foreign-dead-exec",
        groupId: "g",
        status: "running",
        executorKey: "pi",
        executorPid: 2_147_480_000, // 已消失的协调进程
        // spawn 出的 ChildProcess.pid 是 number | undefined(进程可能没起来),
        // 断言非空后再用 —— 测试此刻必须已有真实 pid,否则属主判据无从谈起。
        diffSummary: { platform: { ownerServerPid: owner.pid! } },
      },
    ]);
    expect(await recoverInterruptedTasks(db)).toBe(0);
    expect(updated).toHaveLength(0);
  });

  it("属主存活且 executor pid 也存活 → 同样跳过(双活,更保守)", async () => {
    const { db, updated } = makeDb([
      {
        id: "t-foreign-alive",
        groupId: "g",
        status: "running",
        executorKey: "pi",
        executorPid: owner.pid!,
        diffSummary: { platform: { ownerServerPid: owner.pid! } },
      },
    ]);
    expect(await recoverInterruptedTasks(db)).toBe(0);
    expect(updated).toHaveLength(0);
  });

  it("属主 == 本进程 → 不当「外来」,按既有语义处理(executor 死 → 判死)", async () => {
    // 自己 spawn 的任务:属主即本实例,不适用 R1 跳过;executor 进程没了就照
    // 常 server-restart。防止 R1 误把本实例任务也护住。
    const { db, updated } = makeDb([
      {
        id: "t-self-dead-exec",
        groupId: "g",
        status: "running",
        executorKey: "pi",
        executorPid: 2_147_480_000,
        diffSummary: { platform: { ownerServerPid: process.pid } },
      },
    ]);
    expect(await recoverInterruptedTasks(db)).toBe(1);
    expect(updated).toHaveLength(1);
    expect(updated[0].status).toBe("failed");
  });

  it("属主已死(实例已退)→ 不适用 R1,按既有语义判死", async () => {
    // 属主 pid 已不存在 = 那个实例退出了,任务真正失联,本实例接管收敛。
    const { db, updated } = makeDb([
      {
        id: "t-dead-owner",
        groupId: "g",
        status: "running",
        executorKey: "pi",
        executorPid: 2_147_480_000,
        diffSummary: {
          platform: { ownerServerPid: 2_147_480_000 }, // 属主也消失了
        },
      },
    ]);
    expect(await recoverInterruptedTasks(db)).toBe(1);
    expect(updated).toHaveLength(1);
    expect((updated[0].diffSummary as { error: string }).error).toBe(
      "server-restart",
    );
  });

  it("属主缺失(历史/登记失败)→ 保守走既有语义判死", async () => {
    const { db, updated } = makeDb([
      {
        id: "t-no-owner",
        groupId: "g",
        status: "running",
        executorKey: "pi",
        executorPid: 2_147_480_000,
        diffSummary: null,
      },
    ]);
    expect(await recoverInterruptedTasks(db)).toBe(1);
    expect(updated).toHaveLength(1);
  });
});
