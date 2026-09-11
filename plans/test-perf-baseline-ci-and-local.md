# Plan: 测试性能基线(CI 与本机双列 + 差异分项归因)

> 配套 `specs/test-perf-baseline-ci-and-local.md`。spec 已冻结；`specHash` 作验收锚点。
> 路径规则：`specs/<name>.md` → `plans/<name>.md`。平台不解析本文件。
> **本票只测量、不优化**；工作树里用户未提交的报告与 `start.ps1` 原样保留。

## 元信息

| 字段 | 值 |
|---|---|
| specRef | `specs/test-perf-baseline-ci-and-local.md` |
| specHash | `87c72cf6183c2e8d64c7f58a662a65438fcf2213` |
| 冻结提交 | `a5bfabc4` |
| 编制 | 三方（reviewer + coordinator + executor） |
| dispatchKind | `requirement`（完整档 L3） |
| 更新 | 2026-09-11 |
| 来源 | 报告 §12.3 T0 + §13.3 V3；检视者协调票 `01a08c2d-…` |

## 先做哪一步、为什么

整张 spec 是**一个内聚产物**：一张可被 T1–T6 引用的双列基线表 + 分项归因。
拆成「脚本」与「报告」两票会让第一票无法对照 R4 验收（没有数字就没有归因），
第二票又会重做测量条件。**只设 W1 一次做完。**

不允许的动作（下发时写进任务书红线）：

- 改测试代码 / vitest 配置 / CI workflow 执行方式
- 改 `scripts/test-baseline.mjs`（票级 pass/fail 基线，禁止改造成性能工具）
- 修 Windows-only 恒红（它们是测量对象）
- 改 `--no-file-parallelism`
- 任何「顺手优化」

## 现状摘要（编制时已核实）

| 事实 | 证据 |
|---|---|
| CI Test 步骤现约 652s（报告旧值 293s） | run `34475156274`；余量 46%/20min |
| 主因串行 | `b06f1a4f` 根命令加 `--no-file-parallelism`；文件数 +8% 时间 +122% |
| `scripts/test-baseline.mjs` 只数 pass/fail | 文件头注释 + spec §1.2 |
| 本机不可直接比 CI | HEAD 上 `executor-queue.test.ts` 15 failed / 18 passed ~186s；另有 Windows-only 恒红 |
| 工作树长期脏文件 | `docs/implementation-optimization-review-2026-09-07.md`（M）、`start.ps1`（??）；不参与构建测试，记录即可 |
| CI 入口 | `.github/workflows/test-suite.yml` → Build core packages 后 `pnpm test`；`timeout-minutes: 20` |
| server vitest | `packages/backend/server/vitest.config.ts` 注释已记录串行实测 |

## 工作项

### W1 — 产出双列基线报告（测量 + 分项归因 + 排名）

| 字段 | 内容 |
|---|---|
| 稳定编号 | W1 |
| 目标 | 落下一份可被后续 T1–T6 引用的基线报告：CI 列 + 本机列、分阶段计时、≥3 次热运行+中位数+1 次冷启动、R4 分项归因（含「百分比目标按哪个环境定」的明确结论）、耗时最高文件/阶段排名；可选新建**独立**计时脚本。 |
| 范围 | **允许**：新建 `docs/` 下基线报告（路径建议 `docs/test-perf-baseline-ci-and-local.md`）；若需计时，新建独立脚本（如 `scripts/test-perf-timing.mjs`），**不**进 CI。**禁止**：改任何测试、vitest 配置、CI workflow 执行方式、`scripts/test-baseline.mjs`、修 Windows 恒红、做任何性能优化。 |
| 前置依赖 | 无（V1 已收口，CI 连续绿） |
| 预期产物 | 1) 基线报告（R1–R5 全覆盖）；2) 可选计时脚本；3) `git diff --stat` 自证未改测试/vitest/CI 执行方式/test-baseline.mjs；4) commit（`git commit -- <明确路径>`） |
| 测量方法要点 | **R1** 记录 commit、工作树指纹（说明那两个长期脏文件）、lockfile、Node/pnpm、OS/CPU/内存、worker 配置；CI 侧从 workflow + runner/run 日志取。**R2** 依赖构建 vs 纯测试分开；setup（PGlite/迁移/Git init）、teardown（drain/关库/清理）、用例执行；单调时钟（`performance.now()` / `hrtime.bigint`）；按进程/测试文件隔离输出。**R3** ≥3 热 + 1 冷；成本过高可先代表性文件但**必须写明取样口径**。**R4 必拆**：失败早退、串行度、真实子进程 spawn、PGlite init/迁移、剩余 CPU；回答「§12 百分比目标按 CI 还是本机」。**R5** 文件排名 + 阶段排名。**R 恒红**：本机 Windows-only 恒红逐条列明并说明是否计入耗时。 |
| CI 列取数 | 优先用已绿 run 的 job/step 时长（如 `34475156274`）+ 若可复现则 gh run 日志分步；不要为取基线改 workflow。本机列在本机实测。 |
| 验收方法 | 对照 spec §4 八条：报告落库含 R1；两列含 R2 四类；三次热+中位+冷；**分项归因非两总数**且回答环境选择；排名；`git diff --stat` 无测试/vitest/CI 执行/baseline 工具改动；新脚本则 baseline.mjs 未改；恒红逐条。票级回归基线（若跑测）：`node scripts/test-baseline.mjs` 仅作「失败数不增加」对照，**不是**本票性能数字来源。 |
| 测试文件清单 | 本票以文档/可选脚本为主；**不要**为「修红」去跑或改测试。若执行器为验证未改测试行为而抽样，只跑既有文件且失败数不增加；**禁止**全量 `pnpm test`（本机 ~24min）。 |
| specRef | `specs/test-perf-baseline-ci-and-local.md` |
| specHash | `87c72cf6183c2e8d64c7f58a662a65438fcf2213` |
| taskId | `01a08c30-bffc-70ef-9b56-7eb82dd735dc`（codebuddy） |
| 状态 | L2 pass → L3（父任务 done + review_request）|

## 依赖图

```
W1（单票闭环）
```

## 派发后动作（协调者）

1. 派发 W1 → 退出本轮（不轮询）。
2. 续跑后 L2：逐条对照 spec §4；不通过则按 §4.1.1 两段式重发。
3. L2 通过 → PATCH 父协调任务 `done` + `review_request` 完整档（不带 `lite`）交 L3。

## 诊断

（需求票，无诊断段。）
