import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 回归测试:L2 重发协议(协调者 skill §4.1.1 + 续跑任务书注入)必须稳定存在。
 *
 * 根因(l2 重试未消费证据):续跑任务书已提供上一次子任务的 status、完整 diffSummary
 * 与全部子任务状态(buildResumeBrief),但 SKILL.md 的 L2 失败分支只要求「直接重下发
 * 修正任务」,协议没有强制先把现有事实归纳为「上次失败的判定」、没有强制写「本次要
 * 避开什么」、也没有比较新旧任务书 → 同一输入可被原样重发。
 *
 * 修复 = 把两段式重发任务书(上次失败的判定 + 本次要避开什么)、可见差异(逐字相同 =
 * 不合格)、「未能判定失败原因」兜底、retries 计数与三次上限(停止重试 → 交回检视者)
 * 写进协议,并注入每轮必读的续跑任务书。
 *
 * 直接锁定 SKILL.md 与 coordinator-resume.ts 源码(与 coordinator-exit-after-dispatch
 * 同款做法),避免启动真实 CLI 与端到端测试共享临时 git 仓库造成竞态。
 */

const SKILL = readFileSync(
  path.resolve(import.meta.dirname, "../../../../skills/coordinator/SKILL.md"),
  "utf8",
);
const RESUME_SOURCE = readFileSync(
  path.resolve(
    import.meta.dirname,
    "../src/lib/executor-task/coordinator-resume.ts",
  ),
  "utf8",
);

describe("协调者 L2 重发协议(重试任务书两段式 + 可见差异 + 三次上限)", () => {
  it("SKILL.md 强制两段式重发任务书:上次失败的判定 + 本次要避开什么", () => {
    expect(SKILL).toContain("上次失败的判定");
    expect(SKILL).toContain("本次要避开什么");
  });

  it("SKILL.md 强制可见差异,逐字相同 = 不合格重试", () => {
    expect(SKILL).toContain("逐字相同");
    expect(SKILL).toContain("不合格重试");
  });

  it("SKILL.md 兜底「未能判定失败原因」:如实说明已查过什么,不得编造、不得跳过", () => {
    expect(SKILL).toContain("未能判定失败原因");
    expect(SKILL).toContain("不得编造");
  });

  it("SKILL.md 三次上限:连续三次重发仍失败 → 停止重试并交回检视者,不得无限重试", () => {
    expect(SKILL).toContain("停止重试");
    expect(SKILL).toContain("交回检视者");
    expect(SKILL).toContain("不得无限重试");
  });

  it("SKILL.md 红线:验收标准与红线逐字保持、不因重试放宽验收、失败分析不下推执行器", () => {
    expect(SKILL).toContain("逐字保持");
    expect(SKILL).toContain("不得因重试而放宽验收");
    expect(SKILL).toContain("不得下推给执行器");
  });

  it("续跑任务书注入重试上下文与协议(每轮必读):第几次尝试 + 两段式强制 + 三次上限", () => {
    expect(RESUME_SOURCE).toContain("重试上下文");
    expect(RESUME_SOURCE).toContain("上次失败的判定");
    expect(RESUME_SOURCE).toContain("本次要避开什么");
    expect(RESUME_SOURCE).toContain("三次");
  });
});
