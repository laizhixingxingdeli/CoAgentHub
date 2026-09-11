# Spec: 采集 CI 侧 per-file 计时 —— 把「同构」这个假设变成实测

> **状态**: Frozen
> **版本**: 1.0
> **日期**: 2026-09-11
> **来源**: [test-perf-baseline-ci-and-local.md](test-perf-baseline-ci-and-local.md)
> 的 L3 —— 该票验收第 2 条只算**部分满足**,执行者已显式标注限制。
> 本票专门补齐那一半。
> **阻塞**:报告 §12 **T1**(按真实依赖分类测试)在本票落地前不应开工,
> 理由见 §1.2。

## 1. 背景与目标

### 1.1 缺的是什么

基线报告 `docs/test-perf-baseline-ci-and-local.md` 的 CI 列只有 **step 级**
计时(Build 26s / Test 652s / Typecheck 11s / Lint 1s),**没有 per-file
四阶段拆分**。原文写明了原因:

> CI 现行 workflow 用 `reporters:["verbose"]`,**不输出 per-file JSON 计时**,
> 故 CI 的 per-file 四阶段未在本票采集(给 CI 加 json reporter 需改 workflow,
> 属红线①,不动)。

红线是上一张票自己设的(那票只测量、不改被观测对象),**设得对**。本票就是
来解除它的。

### 1.2 为什么这挡住了 T1

报告接着写:

> 其 per-file 阶段结构与本机列**同构**(同一 `--no-file-parallelism`、同一
> 文件集),差异仅在「本机红文件的注水」一项。

**这是假设,不是实测。** 而它恰好建立在最不该假设的地方:

- 本机阶段排名是 **exec 86.8% / collectionOverhead 8.6% / teardown 4.6%**;
- 但这个分布被 `executor-queue.test.ts` 的 **300 秒**(子集 70%)严重扭曲,
  而那 300 秒是 Windows 专属的 `sh` spawn 重试/超时注水 —— **CI 上不存在**;
- 去掉注水后,collection 与 teardown 的占比会显著上升,可能从 13% 变成主导项。

T1 的全部产出是「先迁移哪一组代表性测试」。选错组 = 白做。而上一张票的结论
是**按 CI 定目标** —— 那就必须知道 CI 把时间花在哪,不能拿一个被 Windows
扭曲的分布去推。

### 1.3 目标

在 CI 上跑一次带计时的全量测试,产出 per-file 四阶段数据,补进基线报告的
CI 列,并**重算阶段排名**。

## 2. 改动范围

允许触碰:

- `.github/workflows/` —— 新增采集路径
- `docs/test-perf-baseline-ci-and-local.md` —— 补 CI 列 + 重算排名
- 计时脚本(`scripts/test-perf-timing.mjs` / `test-perf-reporter.mjs`)
  仅在确需适配 CI 环境时改动,且不得改变其本机行为

**不允许**:

- ⚠️ **不改现有 `Build and Test` job 的 `Test` 步骤**。那是刚稳下来的验证
  回路(连续 11 个绿 run),一旦把计时挂进主路径,计时开销或 reporter 故障
  会表现为 CI 红,而归因会极难。采集必须走**独立路径**。
- 不改任何测试代码、不改 `vitest.config.ts`、不改 `scripts/test-baseline.mjs`。
- 不做任何优化 —— 本票仍然只测量。

## 3. 详细改动

### R1. 独立采集路径,不碰主验证回路

新增**手动触发**(`workflow_dispatch`)的 job 或 workflow 来跑计时版全量测试,
把结果作为 artifact 上传。

⚠️ **不要挂 `on: push`**。基线是按需测量,不是每次推送都跑 —— 全量一轮在 CI
上就是 ~11 分钟,挂 push 会让每次提交的反馈变慢一倍,而收益为零。

⚠️ **允许失败**。CI 上也有既有红(本机那批 Windows-only 在 Linux 上是绿的,
但不排除有别的)。计时 job **不得**因测试失败而丢失已采集的数据 ——
`if: always()` 上传 artifact,并在报告里注明该轮的红绿数。

### R2. 采集 per-file 四阶段

与本机列**同口径**:setup(beforeAll)/ 用例执行 / teardown(afterAll)/
collectionOverhead。复用既有的 `test-perf-reporter.mjs`(它已按 PID 写文件、
避免 worker 互覆盖)。

若该 reporter 在 CI 上因环境差异不可用,**先报告差异再改**,不要静默调整口径 ——
两列口径不同,这张表就白做了。

### R3. 补进基线报告并**重算**阶段排名

把 CI per-file 数据补进 `docs/test-perf-baseline-ci-and-local.md` 的 CI 列,
并据此:

1. **重算 CI 侧的阶段排名**(而不是沿用本机的 86.8/8.6/4.6);
2. **重算 CI 侧的文件排名**;
3. 明确回答:**去掉 Windows 注水后,collection / teardown 在 CI 上占多少?**
   这是 T1 的直接输入。

⚠️ 若实测结果**推翻**了报告里「两列同构」那句话,**照实改掉它并说明** ——
这正是本票存在的意义。不要为了维护上一张票的措辞而修饰数据。

### R4. 给 T1 一个可执行的结论

在报告里写清:按 CI 数据,T1 应优先啃哪一组文件、预期动的是哪个阶段。
若结论是「T1 在 CI 上收益有限」,**也照实写** —— 那同样是有价值的结论,
能省下一整张票的工。

## 4. 验收标准

1. 新增的采集路径是 `workflow_dispatch` 手动触发,**未挂 `on: push`**。
2. 现有 `Build and Test` job 的 `Test` 步骤**一行未改**(`git diff` 自证)。
3. CI 跑出一轮 per-file 四阶段数据并作为 artifact 可下载;该轮的红绿数在
   报告里注明。
4. 基线报告的 CI 列补齐四阶段;**阶段排名与文件排名按 CI 数据重算**,不是
   沿用本机数。
5. 明确给出「去掉 Windows 注水后 collection / teardown 在 CI 上的占比」。
6. 对「两列同构」那句话给出**实测结论**:成立 / 不成立 / 部分成立,并说明。
7. 给 T1 的可执行结论(R4),含「收益有限」这个可能的结论。
8. 测试代码、`vitest.config.ts`、`scripts/test-baseline.mjs` 一行未改。

## 5. 不涉及的改动

- **不做任何优化**。T1 仍是后续票。
- 不改主验证回路的执行方式。
- 不修任何既有红(无论本机还是 CI)—— 它们是测量对象。

## 6. 兼容性

新增 workflow 为手动触发,不影响既有 CI 行为。若改动计时脚本,需说明本机
行为是否逐字不变(上一张票的本机数据要能继续对照)。
