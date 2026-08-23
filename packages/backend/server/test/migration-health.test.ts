import {
  assertNoPendingMigrations,
  type MigrationJournal,
} from "@server/lib/migration-health";
import { describe, expect, it, vi } from "vitest";

const journal: MigrationJournal = {
  entries: [
    { tag: "0019_add_executor_prompt", when: 1_787_363_826_368 },
    { tag: "0020_add_task_parent_link", when: 1_787_364_000_000 },
  ],
};

describe("启动迁移检查", () => {
  it("有未应用迁移时拒绝启动并列出迁移与操作命令", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ created_at: 1_787_363_826_368 }],
      }),
    };

    await expect(assertNoPendingMigrations(db, journal)).rejects.toThrow(
      "0020_add_task_parent_link",
    );
    await expect(assertNoPendingMigrations(db, journal)).rejects.toThrow(
      "pnpm --filter @laizhixingxingdeli/database migrate",
    );
  });

  it("所有迁移已应用时允许启动", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          { created_at: 1_787_363_826_368 },
          { created_at: 1_787_364_000_000 },
        ],
      }),
    };

    await expect(
      assertNoPendingMigrations(db, journal),
    ).resolves.toBeUndefined();
  });

  it("按 Drizzle 的最新账本时间判定，兼容历史倒序时间戳", async () => {
    const historicalJournal: MigrationJournal = {
      entries: [
        { tag: "0005_earlier_release", when: 20 },
        { tag: "0006_backdated_entry", when: 10 },
        { tag: "0007_next_release", when: 30 },
      ],
    };
    const db = {
      execute: vi.fn().mockResolvedValue({ rows: [{ created_at: 20 }] }),
    };

    await expect(
      assertNoPendingMigrations(db, historicalJournal),
    ).rejects.toThrow("0007_next_release");
    await expect(
      assertNoPendingMigrations(db, historicalJournal),
    ).rejects.not.toThrow("0006_backdated_entry");
  });
});
