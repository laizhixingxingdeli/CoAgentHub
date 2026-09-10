import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 回归测试:协调者任务书必须稳定注入「派发成功后立即退出本轮、不得轮询子任务
 * 终态」的强制规则(上下文注入,不改 SKILL.md §2.3 文本)。
 *
 * 取证(任务 01a03d87,codex,pid 54731):协调者派发子任务 01a03d88 后,对子任务
 * 连发 30 次 coagenthub_get_task 轮询(空转),而它全程只 `wc -l SKILL.md` 确认
 * 文件存在、从未读取 §2.3 内容;任务书里仅有 soft 的「派发后可退出本次进程」
 * 不足以阻止轮询。修复 = 把强制语义直接写进每轮必读的任务书。
 *
 * 直接锁定 queue.ts 源码(与 R5 同款做法),避免启动真实 CLI 与端到端测试共享
 * 临时 git 仓库造成竞态。
 */

const TEMPLATE_TEXT = (() => {
  // S6(ticket-text-is-workflow-policy-not-scheduler-code)把任务书文案从
  // queue.ts 搬进了 ticket-templates/*.json,所以这里锁的是模板而不是源码。
  // 解析后拼接所有字符串值,避免直接匹配 JSON 转义后的原文。
  const raw = readFileSync(
    path.resolve(
      import.meta.dirname,
      "../../../../ticket-templates/default.json",
    ),
    "utf8",
  );
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(JSON.parse(raw));
  return out.join("\n");
})();

describe("协调者任务书:派发后退出本轮(上下文注入回归)", () => {
  it("协调者分支注入强制退出规则,且明确禁止轮询子任务终态", () => {
    expect(TEMPLATE_TEXT).toContain("### 派发成功后立即退出本轮（强制）");
    expect(TEMPLATE_TEXT).toContain("本轮进程必须立即结束");
    // 取证中观察到的空转行为:用 coagenthub_get_task 轮询子任务终态。
    expect(TEMPLATE_TEXT).toContain(
      "严禁在派发成功后用 `coagenthub_get_task` 轮询自身任务或子任务状态来等待其终态",
    );
    // 解释续跑接管,使协调者知道无需守着。
    expect(TEMPLATE_TEXT).toContain("自动创建续跑任务");
  });

  it("旧的 soft 措辞「派发后可退出本次进程」已移除(不足以阻止空转)", () => {
    expect(TEMPLATE_TEXT).not.toContain("派发后可退出本次进程");
  });
});
