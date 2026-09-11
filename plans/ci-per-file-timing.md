# Plan: 采集 CI 侧 per-file 计时 —— 把「同构」这个假设变成实测

> 配套 `specs/ci-per-file-timing.md`。spec 已冻结；`specHash` 作验收锚点。
> 路径规则：`specs/<name>.md` → `plans/<name>.md`。平台不解析本文件。
> **本票只测量、不优化**；主验证回路（Build and Test / Test 步骤）一行不改。

## 元信息

| 字段 | 值 |
|---|---|
| specRef | `specs/ci-per-file-timing.md` |
| specHash | `2d61cfef3348dda8c3dda83c84b6736be8bdf44d` |
| 冻结提交 | `a877a05d` |
| 编制 | 三方（reviewer + coordinator + executor） |
| dispatchKind | `requirement`（完整档 L3） |
| 更新 | 2026-09-11 |
| 来源 | 上一张 test-perf-baseline L3 部分满足 → 本票补 CI per-file；阻塞 T1 |
| 父协调任务 | `01a08f26-b195-7308-8273-3bc040846c59` |

## 先做哪一步、为什么

整张 spec 是**一个内聚产物**：独立 `workflow_dispatch` 采集路径 → 一轮 CI per-file
四阶段数据（artifact）→ 基线报告 CI 列补齐 + **按 CI 数据重算**阶段/文件排名 →
同构结论 + T1 可执行结论。

拆成「只加 workflow」与「只改报告」两票会让第一票无法对照 R3–R7 验收（没有数字就
没有排名与 T1 结论），第二票又会卡在 artifact 缺失。**只设 W1 一次做完。**

不允许的动作（下发时写进任务书红线）：

- 改现有 `Build and Test` job 的 `Test` 步骤（一行都不行）
- 把计时 job 挂 `on: push` / `pull_request`
- 改测试代码、`vitest.config.ts`、`scripts/test-baseline.mjs`
- 静默改 `test-perf-reporter.mjs` / `test-perf-timing.mjs` 的本机口径
  （CI 环境差异须先报告再改）
- 任何优化 / 修既有红
- 为维护「两列同构」措辞而修饰数据（R3 授权照实改）

## 现状摘要（编制时已核实）

| 事实 | 证据 |
|---|---|
| spec Frozen，hash 与冻结提交一致 | `git hash-object specs/ci-per-file-timing.md` = `2d61cfef…`；HEAD `a877a05d` |
| 主回路 Test 步骤现为 `pnpm test` | `.github/workflows/test-suite.yml` L≈61 |
| 既有计时工具 | `scripts/test-perf-timing.mjs` + `scripts/test-perf-reporter.mjs`（按 PID 写 `.perf-runs/<runId>/`） |
| 基线报告 CI 列仅 step 级 | `docs/test-perf-baseline-ci-and-local.md` R2：Test 652s；「同构」为假设 |
| 本机阶段被 Windows 注水扭曲 | 同报告：exec 86.8% / collection 8.6% / teardown 4.6%；`executor-queue` 300s≈子集 70% |
| CI 全量约 11min | 上一张票；故**禁止**挂 push |

## 工作项

### W1 — 独立 CI 计时路径 + 一轮实测 + 报告重算与 T1 结论

| 字段 | 内容 |
|---|---|
| 稳定编号 | W1 |
| 目标 | 在不碰主验证回路的前提下，用 `workflow_dispatch` 跑出与本机**同口径**的 CI per-file 四阶段数据，写入 artifact；补进基线报告 CI 列；**按 CI 数据**重算阶段排名与文件排名；给出「去掉 Windows 注水后 collection/teardown 占比」；对「两列同构」给实测结论；给 T1 可执行结论（含「收益有限」可能）。 |
| 范围 | **允许**：`.github/workflows/` 新增独立 job/workflow（仅 `workflow_dispatch`）；改 `docs/test-perf-baseline-ci-and-local.md`；仅当 CI 环境差异导致既有 reporter **不可用**时，在**先报告差异**后最小改动 `scripts/test-perf-*.mjs`（本机行为须逐字可对照，说明是否不变）。**禁止**：见上方红线。 |
| 前置依赖 | 无（spec 已 Frozen；上一张基线报告已 Landed） |
| 预期产物 | 1) 独立 workflow（`workflow_dispatch` only；`if: always()` 上传 artifact；失败不丢数据）；2) 至少一轮 CI run 的 per-file JSON（artifact 可下载；报告注明红绿数与 run id）；3) 更新后的基线报告（CI 四阶段 + 重算排名 + 同构结论 + T1 结论）；4) `git diff` 自证主回路 Test 步骤与测试/`vitest`/`test-baseline.mjs` 未改；5) commit（`git commit -- <明确路径>`） |
| 实现要点 | **R1** 新 workflow 或同文件新 job：`on: workflow_dispatch` only；复用与主 job 相近的 setup（Node/pnpm/build/postgres service）但 Test **不得**改主 job 那一行；计时调用复用 `node scripts/test-perf-timing.mjs <runId>`（或等价：同一 reporter + `--no-file-parallelism`）；artifact 含 `run.json`（或 `.perf-runs/**`）。**R2** 口径：setup / exec / teardown / collectionOverhead，与本机 reporter 一致。**R3** 报告 CI 列补齐；阶段%、文件排名**只用 CI 数字**重算。**R4** 写清 T1 优先组与预期阶段；若 CI 上 collection/teardown 不主导或优化空间小，照实写「收益有限」。触发：`gh workflow run` + `gh run watch` + `gh run download`（需网络/权限；若权限不足在 diffSummary 写明阻塞，勿伪造数字）。 |
| 验收方法 | 对照 spec §4 八条：①仅 workflow_dispatch ②主 Test 步骤 `git diff` 一行未改 ③artifact + 红绿数 ④CI 四阶段 + **CI 重算**排名 ⑤collection/teardown CI 占比 ⑥同构结论 成立/不成立/部分成立 ⑦T1 结论 ⑧测试/vitest/baseline 未改。 |
| 测试文件清单 | 本票以 workflow + 文档 +（条件）计时脚本为主；**不要**为修红跑/改测试。若抽样「未改测试行为」：`node scripts/test-baseline.mjs` 单文件，失败数不增加；**禁止**根 `pnpm test` 全量（~24min 本机 / CI 另有独立计时 job）。 |
| specRef | `specs/ci-per-file-timing.md` |
| specHash | `2d61cfef3348dda8c3dda83c84b6736be8bdf44d` |
| taskId | `01a08f29-4103-749c-b9a6-13fe052ae56c`（codebuddy） |
| 状态 | dispatched |

## 依赖图

```
W1（单票闭环）
```

## 派发后动作（协调者）

1. 派发 W1 → **立即退出本轮**（不轮询、不 sleep 等子任务终态）。
2. 续跑后 L2：逐条对照 spec §4；不通过则按 §4.1.1 两段式重发（最多 3 次）。
3. L2 通过 → PATCH 父协调任务 `done` + `review_request` 完整档（不带 `lite`）交 L3。

## 诊断

（需求票，无诊断段。）
