/**
 * spec: specs/second-server-instance-sweeps-production-tasks.md(cf0c8258)
 *
 * 2026-09-06 事故:执行器为验证看门狗票起了沙箱 server(:3101,端口隔离但
 * **同一个 DATABASE_URL**),其启动兜底把生产在途任务清了场 —— 其中一条正是
 * 它自己所属工作项的协调任务。生产进程从未重启,却有两条任务被标 `server-restart`。
 */
import { beforeEach, describe, expect, it } from "vitest";
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
  const updated: Array<{ id: string; status: string; diffSummary: unknown }> = [];
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

describe("第二个实例启动兜底(cf0c8258)", () => {
  let alivePid: number;
  beforeEach(() => {
    alivePid = process.pid; // 本进程一定活着
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
