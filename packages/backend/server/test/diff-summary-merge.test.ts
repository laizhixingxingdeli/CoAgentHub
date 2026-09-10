/**
 * diffSummary 归属表 + mergeDiffSummary 纯函数语义
 * (spec diffsummary-ownership W1 / §4 A2 · B1 与计划 W1 验收)。
 *
 * 不触碰生产写路径——那些是 W2。
 */
import { describe, expect, it } from "vitest";
import {
  DIFF_SUMMARY_KEY_OWNERS,
  type DiffSummaryOwner,
  mergeDiffSummary,
  ownerOfDiffSummaryKey,
  PLATFORM_KEY_OWNERS,
} from "../src/lib/executor-task/diff-summary";

describe("diffSummary ownership registry", () => {
  it("partitions known keys across the seven owners from spec §3.1", () => {
    const byOwner = new Map<DiffSummaryOwner, string[]>();
    for (const [key, owner] of Object.entries(DIFF_SUMMARY_KEY_OWNERS)) {
      const list = byOwner.get(owner) ?? [];
      list.push(key);
      byOwner.set(owner, list);
    }

    expect(byOwner.get("result")?.sort()).toEqual(
      [
        "alreadySatisfied",
        "claimVerification",
        "hash",
        "reportMissingReason",
        "summary",
        "tests",
        "todo",
        "unconfirmed",
      ].sort(),
    );
    expect(byOwner.get("scheduling")).toEqual(
      expect.arrayContaining([
        "queuedBlocked",
        "stallAlerted",
        "noExecutionReason",
        "staleBuildSuspected",
      ]),
    );
    expect(byOwner.get("review")?.sort()).toEqual(
      [
        "claimAdjudication",
        "degradedToTwoParty",
        "l1Bypass",
        "review_request",
        "review_result",
      ].sort(),
    );
    expect(byOwner.get("relation")).toEqual(["platform"]);
    expect(byOwner.get("metrics")?.sort()).toEqual(
      [
        "liveOutputTail",
        "outputTail",
        "outputTailMissing",
        "reconciledAt",
        "reconciledReason",
        "retries",
        "tokenUsage",
        "tokenUsageReason",
      ].sort(),
    );
    expect(byOwner.get("audit")?.sort()).toEqual(
      ["dispatchKindNote", "rollbackSkipped"].sort(),
    );
    expect(byOwner.get("terminal")).toEqual(["error"]);

    expect(PLATFORM_KEY_OWNERS).toMatchObject({
      resumeOf: "relation",
      resumeForChild: "relation",
      closeGuardResume: "relation",
      ownerServerPid: "relation",
      l3MergedInto: "relation",
    });

    expect(ownerOfDiffSummaryKey("hash")).toBe("result");
    expect(ownerOfDiffSummaryKey("dispatchKindNote")).toBe("audit");
    expect(ownerOfDiffSummaryKey("not-a-registered-key")).toBeUndefined();
  });
});

describe("mergeDiffSummary", () => {
  /** A2: result 写入 summary 不得丢掉他所有者既有键。 */
  it("A2: result summary write keeps platform / dispatchKindNote / tokenUsage", () => {
    const existing = {
      platform: { resumeOf: "p" },
      dispatchKindNote: { reason: "defaulted-fix" },
      tokenUsage: 1,
    };

    const next = mergeDiffSummary(existing, { summary: "x" }, "result");

    expect(next.summary).toBe("x");
    expect(next.platform).toEqual({ resumeOf: "p" });
    expect(next.dispatchKindNote).toEqual({ reason: "defaulted-fix" });
    expect(next.tokenUsage).toBe(1);
  });

  /** B1: scheduling 不得写入/覆盖 result 的 hash。 */
  it("B1: scheduling patch with hash does not apply hash", () => {
    const existing = { hash: "alivebeef", queuedBlocked: { code: "old" } };

    const next = mergeDiffSummary(
      existing,
      { hash: "deadbeef", queuedBlocked: { code: "group-slot" } },
      "scheduling",
    );

    expect(next.hash).toBe("alivebeef");
    expect(next.queuedBlocked).toEqual({ code: "group-slot" });
  });

  it("B1b: scheduling cannot introduce hash when existing has none", () => {
    const next = mergeDiffSummary({}, { hash: "deadbeef" }, "scheduling");
    expect(next).not.toHaveProperty("hash");
    expect(next).toEqual({});
  });

  it("same owner may overwrite its own keys", () => {
    const existing = { summary: "old", hash: "aaa" };
    const next = mergeDiffSummary(
      existing,
      { summary: "new", hash: "bbb" },
      "result",
    );
    expect(next).toEqual({ summary: "new", hash: "bbb" });
  });

  it("platform deep-merges: keeps resumeOf while writing ownerServerPid", () => {
    const existing = {
      platform: { resumeOf: "parent-1", resumeForChild: "child-9" },
      summary: "keep-me",
    };

    const next = mergeDiffSummary(
      existing,
      { platform: { ownerServerPid: 4242 } },
      "relation",
    );

    expect(next.platform).toEqual({
      resumeOf: "parent-1",
      resumeForChild: "child-9",
      ownerServerPid: 4242,
    });
    expect(next.summary).toBe("keep-me");
  });

  it("non-relation owner cannot touch platform", () => {
    const existing = { platform: { resumeOf: "p" } };
    const next = mergeDiffSummary(
      existing,
      { platform: { ownerServerPid: 1 }, summary: "x" },
      "result",
    );
    expect(next.platform).toEqual({ resumeOf: "p" });
    expect(next.summary).toBe("x");
  });

  /**
   * 显式 null 作用域:只清本所有者键。若不对所有者设限,一次 null
   * 写入会把他有键也清掉,等价于换一种「整袋替换」。
   */
  it("explicit null clears only the writing owner's keys", () => {
    const existing = {
      hash: "keep-hash",
      summary: "drop-me",
      tokenUsage: 99,
      dispatchKindNote: { reason: "keep-note" },
      platform: { resumeOf: "p" },
    };

    const next = mergeDiffSummary(
      existing,
      {
        summary: null,
        // 试图清他所有者键 —— 必须被忽略
        tokenUsage: null,
        dispatchKindNote: null,
        platform: null,
        hash: null, // 同为 result,允许清
      },
      "result",
    );

    // 显式 null 写入 null 并保留键(token R2 / Object.hasOwn 语义);
    // 他所有者键上的 null 被忽略。
    expect(next.summary).toBeNull();
    expect(next.hash).toBeNull();
    expect(next.tokenUsage).toBe(99);
    expect(next.dispatchKindNote).toEqual({ reason: "keep-note" });
    expect(next.platform).toEqual({ resumeOf: "p" });
  });

  it("explicit null on audit keys only nulls audit keys", () => {
    const existing = {
      dispatchKindNote: { reason: "x" },
      rollbackSkipped: { ref: "abc" },
      hash: "h",
      error: "fail",
    };

    const next = mergeDiffSummary(
      existing,
      {
        dispatchKindNote: null,
        rollbackSkipped: null,
        hash: null,
        error: null,
      },
      "audit",
    );

    expect(next.dispatchKindNote).toBeNull();
    expect(next.rollbackSkipped).toBeNull();
    expect(next.hash).toBe("h");
    expect(next.error).toBe("fail");
  });

  it("unregistered keys belong to the writing owner", () => {
    const existing = { hash: "h", customExecutorField: "old" };

    const asResult = mergeDiffSummary(
      existing,
      { customExecutorField: "new", anotherExt: 1 },
      "result",
    );
    expect(asResult.customExecutorField).toBe("new");
    expect(asResult.anotherExt).toBe(1);
    expect(asResult.hash).toBe("h");

    // 其它所有者不能覆盖 result 已写下的未登记键……等等:
    // 未登记键没有固定所有者,归「本次写入声明的所有者」。
    // 因此 scheduling 再次写 same 未登记键 *会* 应用(它成为 scheduling
    // 视角下的自有扩展)。这与 spec「未登记键归本次写入声明的所有者」
    // 一致:每次写入方都可认领未登记键。已登记他有键仍受保护。
    const asScheduling = mergeDiffSummary(
      asResult,
      { customExecutorField: "sched", hash: "nope" },
      "scheduling",
    );
    expect(asScheduling.customExecutorField).toBe("sched");
    expect(asScheduling.hash).toBe("h");
  });

  it("treats non-object existing as empty object", () => {
    expect(mergeDiffSummary(null, { summary: "x" }, "result")).toEqual({
      summary: "x",
    });
    expect(mergeDiffSummary("bad", { error: "e" }, "terminal")).toEqual({
      error: "e",
    });
    expect(mergeDiffSummary(42, { queuedBlocked: 1 }, "scheduling")).toEqual({
      queuedBlocked: 1,
    });
    expect(mergeDiffSummary([], { summary: "x" }, "result")).toEqual({
      summary: "x",
    });
  });

  it("does not mutate existing or patch inputs", () => {
    const existing = {
      platform: { resumeOf: "p" },
      tokenUsage: 1,
    };
    const patch = { platform: { ownerServerPid: 7 } };
    const existingSnap = structuredClone(existing);
    const patchSnap = structuredClone(patch);

    const next = mergeDiffSummary(existing, patch, "relation");
    expect(next.platform).toEqual({ resumeOf: "p", ownerServerPid: 7 });
    expect(existing).toEqual(existingSnap);
    expect(patch).toEqual(patchSnap);
  });

  it("skips undefined patch values (do not write)", () => {
    const existing = { summary: "keep" };
    const next = mergeDiffSummary(
      existing,
      { summary: undefined, hash: "h" },
      "result",
    );
    expect(next).toEqual({ summary: "keep", hash: "h" });
  });

  it("relation null on platform sub-key nulls only that sub-key", () => {
    const existing = {
      platform: { resumeOf: "p", ownerServerPid: 1 },
    };
    const next = mergeDiffSummary(
      existing,
      { platform: { ownerServerPid: null } },
      "relation",
    );
    expect(next.platform).toEqual({ resumeOf: "p", ownerServerPid: null });
  });

  it("terminal error write preserves foreign owner keys", () => {
    const existing = {
      platform: { resumeOf: "p" },
      dispatchKindNote: { reason: "x" },
      hash: "h",
    };
    const next = mergeDiffSummary(existing, { error: "rollback" }, "terminal");
    expect(next).toEqual({
      platform: { resumeOf: "p" },
      dispatchKindNote: { reason: "x" },
      hash: "h",
      error: "rollback",
    });
  });
});
