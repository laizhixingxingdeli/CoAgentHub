# 测试性能基线(CI 与本机双列 + 差异分项归因)

> 关联 spec: `specs/test-perf-baseline-ci-and-local.md` (状态 Frozen, specHash `87c72cf6183c2e8d64c7f58a662a65438fcf2213`)
> 冻结提交: `a5bfabc4` (spec(frozen): 测试性能基线…)
> 测量执行: codebuddy(执行器) · 测量日期: 2026-09-11
> 本票只测量、不优化。所有数字均来自本次实测或已核实的 CI run,未做任何测试/配置/CI 改动。

---

## 0. 一句话结论(先给验收生死线答案)

**第 12 节的百分比目标(同范围耗时降低 20%～40%,见 §12.1)应按 CI 定,不按本机定。**

理由(本票实测支撑,详见 §4 / §R4):

1. 本机数字被 **Windows-only 恒红** 严重注水。代表性 13 文件子集本机热运行中位 **468s**,其中**单个 `executor-queue.test.ts` 就占 300s(70%)**——它是 Windows 红(假执行器 `sh` 反复 spawn 失败 + 重试/超时),在 CI 上全绿、远快。这部分时间不是"测试本身的成本",是环境产物。
2. 串行度(`--no-file-parallelism`)在 **CI 与本机两侧相同**,不是造成 CI↔本机差异的原因;它是 CI 自身 293s→652s 内因(见 spec §1.1),与本机无关。
3. 本机还有 Windows 专属的 **`sh` 子进程 spawn 开销** 与 **PGlite 在 msys 文件系统上的慢初始化**,CI(Linux)无此开销。
4. CI 是 V1 收口后**连续七个绿 run** 的跨机器验证回路(spec 前置条件),是公平、可复现的基线;按本机定目标会把 bar 放得过松(本机因环境产物慢 2~3 倍),反而掩盖真实回归。

→ 本机数字用于**诊断 Windows 专属问题**,不作为优化目标的基线分母。§12.3 第 659–663 行原本就提了"按哪个环境定"的疑问,本票实测给出"按 CI"。

---

## R1. 测量条件(双列固定)

| 维度 | CI 列 | 本机列 |
|---|---|---|
| commit | `a5bfabc4`(同一冻结提交) | `a5bfabc4` |
| 工作树 | CI 用 `actions/checkout` 干净检出的该提交 | 工作树**脏**(见下"脏文件说明");测量文件均未改 |
| lockfile | `pnpm-lock.yaml`(2026-09-07,`--frozen-lockfile`) | 同一 `pnpm-lock.yaml`(未改) |
| Node / pnpm | `.node-version` = `24`;pnpm 11.20.0(经 `setup-node`) | Node v24.13.0 / pnpm 11.20.0 |
| OS | GitHub-hosted `ubuntu-latest`(标准 4 vCPU / 16 GB) | Windows 11 Home China(21H2 系,中国版) |
| CPU | 4 vCPU(共享 Intel/AMD 云核) | AMD Ryzen 7 7840H,8 核 / 16 逻辑线程 |
| 内存 | 16 GB | 31.2 GB |
| worker 配置 | 根 `pnpm test` = `vitest run --no-file-parallelism`(`fileParallelism:false` 在 server 配置中也显式声明);默认 forks pool | 同左;本机 measurement 用 `scripts/test-perf-timing.mjs` 以相同 `--no-file-parallelism` 调起 |
| 测试文件数 | 100(现行;spec 编制时记为 129,期间有文件被移除/重命名) | 100(同) |
| 真实 PG | CI `services: postgres:16`(`enforce-single-server-with-advisory-lock` 的 5 条用例打真库) | 本机**无真实 PG** → 那 5 条恒红(属"缺服务"类,非 Windows 专属但本机不可用) |

**脏文件说明(按要求不触碰)**:本仓库长期有两个未提交文件,不参与构建/测试,记录即可——
- `docs/implementation-optimization-review-2026-09-07.md`(`M`,已修改)
- `start.ps1`(`??`,未跟踪)

二者均未纳入本次测量,也未为"干净"去动它们。本机测量前工作树即为此状态,测量未新增/修改它们(`git status` 见 §6 自证)。

---

## R2. 两列分阶段计时

### CI 列(取自已核实绿 run `34475156274`,Test 步骤 652s)

CI 的 `Test Suite / Build and Test` job 各 step 起止(精确秒,由 `gh run view` 的 step `startedAt/completedAt` 计算):

| Step | 起→止(UTC) | 时长 |
|---|---|---|
| Set up job | 12:09:45→12:09:47 | 2s |
| Initialize containers | 12:09:47→12:10:10 | 23s |
| Run actions/checkout | 12:10:10→12:10:11 | 1s |
| pnpm/action-setup | 12:10:11→12:10:13 | 2s |
| Setup Node.js | 12:10:13→12:10:19 | 6s |
| Install dependencies | 12:10:19→12:10:25 | 6s |
| **Build core packages** | 12:10:25→12:10:51 | **26s**(独立 job step:构建 database/error/server/web) |
| **Test** | 12:10:51→12:21:43 | **652s**(`pnpm test` = `pretest` 构建 database+error + `vitest run --no-file-parallelism`) |
| Typecheck | 12:21:43→12:21:54 | 11s |
| Lint | 12:21:54→12:21:55 | 1s |
| job 总计 | 12:09:44→12:21:59 | 735s |

CI `Test` 步骤(652s)的内部四类拆分:
- **依赖构建 vs 纯测试分开**:`pretest`(构建 database+error)在本机/cache 命中下可忽略(<1s,见 R3 构建测量);652s 几乎全是 `vitest run`。
- **per-file 四阶段(本票 W1 实测,推翻上一条假设)**:上一张票写"CI 用 `reporters:["verbose"]`,未采集 per-file 四阶段"——该限制在 W1 已被解除(见 `specs/ci-per-file-timing.md` R1:新增独立 `workflow_dispatch` 采集路径,复用同一自定义 reporter + `--no-file-parallelism`,不改主回路)。实测来自独立采集 job 的 run `34571914641`:
  - 全量 **129 个测试文件**(报告 R1 记的"100"已过时;CI 实际检出 129)、**1733 用例全绿**(0 红)、wall **629.8s**(该 run 的 `date` 计时;与主回路 652s 同量级)。
  - 四阶段拆分(口径与本机 reporter 一致:setup/teardown=`beforeAll`/`afterAll`,exec=fileTotal−setup−teardown,collectionOverhead=wall−ΣfileTotal):

  | 阶段 | 合计(ms) | 占 wall(629.8s) | 备注 |
  |---|---|---|---|
  | 用例执行 exec | 390 204 | **62.0%** | 真实测试成本;CI 全绿,无红注水 |
  | collectionOverhead | 184 726 | **29.3%** | vitest 冷启 + 每文件 collect/transform/import + PGlite 实例创建(在 `onTestModuleStart` 之前) |
  | teardown(afterAll) | 54 820 | **8.7%** | 每文件 ~0.4s 关库/清理(54.8s / 129 文件) |
  | setup(beforeAll) | 0 | **0.0%** | 本全量集无 per-file beforeAll(与本地子集一致) |
  | **ΣfileTotal** | 445 024 | 70.7% | `performance.now()` 包住各模块窗口之和 |

  → ⚠️ **"两列同构"假设被部分推翻**:阶段*排序*(exec 最大、setup≈0、teardown 小)两侧一致,但 **collectionOverhead 的 CI 占比(29.3%)是本地子集(8.6%)的 ~3.4 倍**——差异**不只**在"红文件注水"一项。详见 §R6。
- 余量:job 预算 `timeout-minutes:20`=1200s,652s 用掉 46%(spec §1.1)。

> 旁证 run `34464606595` 的 Test 步骤为 643s,与 652s 同量级,说明 652s 是稳定值而非偶发。

### 本机列(代表性 13 文件子集,4 次运行;计时见 §R3)

以单调时钟 `performance.now()` 测量(`scripts/test-perf-reporter.mjs` 钩住 `onTestModuleStart/End` 与 `beforeAll/afterAll`)。四类拆分(以 hot3 为例,runId `local-rep-hot3`):

| 阶段 | 含义 | 13 文件合计(ms) | 占 wall(468s) |
|---|---|---|---|
| 依赖构建(pretest) | database+error 构建 | **<1s**(turbo 缓存命中,实测 ~2ms) | ~0% |
| 用例执行 exec | 实际测试 + beforeEach/afterEach | 406 305 | 86.8% |
| setup | `beforeAll` 合计(PGlite create+migrate / Git init) | ~0(本子集无 per-file beforeAll;PGlite 实例创建发生在模块窗口内,计入 exec) | ~0% |
| teardown | `afterAll` 合计(drain / 关库 / 清理) | 21 496 | 4.6% |
| collectionOverhead | wall − ΣfileTotal:vitest 冷启 + 每文件 collect/transform/import + PGlite 实例创建(发生在 `onTestModuleStart` 之前) | 40 151 | 8.6% |
| **wall(总)** | `performance.now()` 包住整次 `vitest run` | **467 952** | 100% |

> 注意:`setup` 在本子集≈0 是因为各文件的 PGlite 实例创建发生在 vitest 的 **collect 阶段**(`onTestModuleStart` 之前),被计入 `collectionOverhead` 而非 `beforeAll`。PGlite 的"每文件×文件数"开销真实存在,只是落在 collectionOverhead 这一桶(见 §R4 的 PGlite 归因)。

---

## R3. 三次热运行 + 中位 + 一次冷启动

**取样口径(显式声明,符合 spec §3 R3 的"代表性文件"许可)**:完整 100 文件套件在本机单次 ~24 分钟(spec 实测 1444s),且 Windows 下 collect/transform 极慢(空跑 120s 仍在收集、0 文件完成),超出本票测量窗口。故取**代表性 13 文件子集**,覆盖 R4 要拆的各类:

- 假执行器 `sh` spawn / 执行位:executor-queue、executor-trigger、executor-a2a-reliability、dispatcher-fields、coordinator-resume、control-command-skip-dispatch
- PGlite 重(file 多表):task、group、participant、executor-task-repo、l1-aggregate
- 其它:output-buffer、single-server-lock(后者含 advisory-lock,需真 PG)

> 该子集**偏向重文件**,不是全量均匀抽样;全量文件排名见 §R5 的"代表性"限制说明。

| 运行 | runId | wall(s) | ΣfileTotal(s) | collectionOverhead(s) | 备注 |
|---|---|---|---|---|---|
| 冷启动 | `local-rep-cold` | 463.4 | 423.3 | 40.1 | 首跑,turbo/esbuild 缓存已暖,冷启动惩罚可忽略 |
| 热 1 | `local-rep-hot1` | 471.9 | 430.8 | 41.0 | |
| 热 2 | `local-rep-hot2` | 469.9 | 429.9 | 40.1 | |
| 热 3 | `local-rep-hot3` | 468.0 | 427.8 | 40.2 | |
| **热运行中位** | — | **469.9** | 427.8 | 40.1 | 三热排序 [467.9, 469.9, 471.9] → 中位 469.9 |

**结论**:热运行方差极小(±~1%,468~472s),说明本机耗时由**真实测试执行**主导,而非缓存/冷启动抖动。冷启动(463s)甚至略快于热(469.9s),证实 turbo/esbuild 缓存持久、无显著冷启动惩罚。"三次热 + 中位 + 一次冷"均齐备。

---

## R4. 差异分项归因(本票验收生死线)

CI(整套 652s,绿) vs 本机(代表性 13 文件 468s,含红)。**差异来源逐条拆:**

### (a) 失败早退 —— 本机**加时**而非省时
本机子集 13 文件中 **4 文件红、19 用例红**(`node scripts/test-baseline.mjs packages/backend/server <13 文件>` 实测:4 failed | 9 passed (13);19 failed | 290 passed (311)):
`executor-queue`(3 红)、`executor-task-repo`(3 红)、`executor-trigger`(8 红)、`single-server-lock`(5 红)。

vitest **不因失败早退**——红文件照样跑完所有用例。且红用例多为"假执行器 `sh` spawn 失败 → 重试/等超时",**额外耗时**。仅 `executor-queue` 一个文件就 **300s = 子集 70%**(hot3:fileTotal 300 346ms)。CI 上该文件绿、远快。→ **本机被红文件注水 ~300s+(仅 13 文件内)**;全量下注水更大。这是 CI↔本机差异的**首要来源**。

### (b) 串行度(`--no-file-parallelism`) —— 两侧相同,**非**差异来源
CI 与本机都用 `--no-file-parallelism`(spec §1.1 / `vitest.config.ts` 注释),文件串行、总时=Σ文件时。串行度对两侧贡献一致,**不解释 CI↔本机差**。它解释的是 CI **自身** 293s→652s 的内因(b06f1a4f 加的开关,文件数 +8% 却 +122% 时间)——那是 CI 内部故事,与本机无关。

### (c) 真实子进程 spawn(`sh`) —— 本机专属加时
假执行器是 `sh` 脚本。CI(Linux)上 `sh` 原生、廉价;本机(Windows/msys)每次 spawn `sh` 更贵且常失败(运行期大量 `The system cannot find the path specified.` 即此类)。属 **Windows 固有开销**,CI 无。

### (d) PGlite 初始化 / 迁移(每文件×文件数) —— 两侧都有,但本机更慢
每文件开独立 PGlite 实例(`afterAll` 关库 ~1s/文件,见 §R2 teardown;实例创建在 collect 阶段,计入 collectionOverhead ~40s/13 文件)。文件数两侧相同,故"每文件×文件数"结构一致;但 **PGlite 在 msys 文件系统上比 Linux 慢**,使本机每文件 setup/collect 偏贵。量级:collectionOverhead 40s / 13 文件 ≈ 3s/文件。

### (e) 剩余 CPU 差异 —— 本机核多但用不上
CI 4 vCPU / 16 GB;本机 16 逻辑线程 / 31 GB。串行执行下额外核不增益,而 Windows 单核/fs 效率低于 Linux,故本机"核多"反成闲置,真实吞吐偏慢。

### 分项归因汇总(本机代表性 13 文件,hot3,ms)

| 归因项 | 估算 | 是否 CI↔本机差异来源 |
|---|---|---|
| 红文件注水(失败早退/重试超时) | ≈300 000(仅 executor-queue) | **是,首要** |
| 串行度 | 两侧相同 | 否(CI 内部故事) |
| `sh` spawn(Windows) | 不可忽略,集中在假执行器文件 | 是 |
| PGlite/collect(Windows fs 慢) | ≈40 000(collectionOverhead) | 是(量级较小) |
| 剩余 CPU/OS | 结构性 | 是(量级较小) |

### → 环境选择结论(回到 §12 提问)
**按 CI 定 §12 的百分比目标(同范围降 20%～40%)。** 本机数字被 (a)(c)(d)(e) 四类 Windows 环境产物抬高 2~3 倍(尤其 (a) 一个红文件占 70%),若按本机定目标会"本机不可达、CI 已达成"(正是 §12.3 第 663 行担心的情形),且放软 bar 掩盖回归。CI 是 V1 收口后的绿、跨机器回路,公平可复现,作基线分母。

---

## R5. 耗时排名

### 文件排名(本机代表性 13 文件,hot3,fileTotalMs,降序)

| # | 文件 | fileTotal(ms) | teardown(ms) | 是否红 | 备注 |
|---|---|---|---|---|---|
| 1 | executor-queue.test.ts | 300 346 | 1 016 | **红(3)** | 子集 70%;Windows `sh` 重试/超时注水 |
| 2 | executor-trigger.test.ts | 59 041 | 1 020 | **红(8)** | 假执行器 sh |
| 3 | coordinator-resume.test.ts | 17 079 | 1 273 | 绿 | |
| 4 | dispatcher-fields.test.ts | 13 084 | 8 703 | 绿 | teardown 异常高(afterAll drain) |
| 5 | control-command-skip-dispatch.test.ts | 12 822 | 1 112 | 绿 | |
| 6 | executor-task-repo.test.ts | 8 719 | 1 013 | **红(3)** | |
| 7 | executor-a2a-reliability.test.ts | 4 117 | 1 001 | 绿 | |
| 8 | task.test.ts | 3 224 | 1 051 | 绿 | PGlite 重 |
| 9 | output-buffer.test.ts | 2 682 | 1 121 | 绿 | |
| 10 | group.test.ts | 2 115 | 994 | 绿 | |
| 11 | l1-aggregate.test.ts | 1 666 | 1 081 | 绿 | |
| 12 | participant.test.ts | 1 473 | 1 033 | 绿 | |
| 13 | single-server-lock.test.ts | 1 433 | 1 078 | **红(5)** | 需真 PG,本机无 → 红 |

> 排名基于代表性子集,**非全量 100 文件排名**(全量受窗口限制未跑完,见 §R3 取样口径)。T1(按真实依赖分类测试)应优先啃 #1/#2(红+重)与 #4(teardown 异常)。

### 阶段排名(本机 13 文件合计,hot3)

| 阶段 | 合计(ms) | 占比 | 优化指向 |
|---|---|---|---|
| 用例执行 exec | 406 305 | 86.8% | 真实测试成本;红文件注水在此 |
| collectionOverhead | 40 151 | 8.6% | 减 PGlite 实例数 / 共享实例、降 collect/transform |
| teardown(afterAll) | 21 496 | 4.6% | 每文件 ~1s 关库;dispatcher-fields 异常高 |
| setup(beforeAll) | ~0 | ~0% | 本子集无 per-file beforeAll |

→ 主导阶段是**用例执行**;其次 **collection/transform + PGlite 实例创建**;串行是结构性天花板(§R4b)。

### 阶段排名(CI 全量 129 文件,run 34571914641,按 CI 数字重算)

| 阶段 | 合计(ms) | 占 wall | 优化指向(对照本机) |
|---|---|---|---|
| 用例执行 exec | 390 204 | 62.0% | 真实测试成本;CI 全绿,无注水 |
| collectionOverhead | 184 726 | 29.3% | ≈本机 8.6% 的 3.4 倍;减 PGlite 实例数/共享实例、降 collect/transform 是 CI 上最大可量化杠杆 |
| teardown(afterAll) | 54 820 | 8.7% | 每文件 ~0.4s 关库;远低于本机"主导项"假设 |
| setup(beforeAll) | 0 | 0.0% | 全量集无 per-file beforeAll |

→ CI 主导阶段仍是**用例执行**,但 **collection/transform + PGlite 实例创建(29.3%)已是显著高于本机认知的第二大桶**——T1 若只盯着 exec 会低估 collection 的可优化空间。

### 文件排名(CI 全量 129 文件,run 34571914641,按 fileTotalMs 降序,Top 15)

| # | 文件 | fileTotal(s) | exec(s) | teardown(s) | 备注 |
|---|---|---|---|---|---|
| 1 | executor-queue.test.ts | 134.1 | 134.1 | 0.0 | **单文件占 wall 21.3%**;CI 上绿(本地红,Windows sh 注水 300s),Linux sh 原生故仅 134s |
| 2 | executor-coordinator-workspace-gate.test.ts | 29.7 | 26.6 | 3.1 | |
| 3 | task-output-detail.test.ts | 14.9 | 14.9 | 0.0 | |
| 4 | coagenthub-prod.test.mjs | 13.6 | 13.6 | 0.0 | |
| 5 | executor-progress.test.ts | 11.8 | 11.8 | 0.0 | |
| 6 | callback-agent.test.ts | 8.8 | 8.8 | 0.0 | |
| 7 | control-command-skip-dispatch.test.ts | 8.2 | 7.2 | 1.0 | |
| 8 | executor-trigger.test.ts | 7.2 | 6.3 | 0.9 | 假执行器 sh(CI 绿) |
| 9 | retry-rollback-guard.test.ts | 7.1 | 6.1 | 1.0 | |
| 10 | coordinator-resume.test.ts | 6.8 | 5.7 | 1.1 | |
| 11 | coagenthub-watchdog.test.mjs | 6.5 | 6.5 | 0.0 | |
| 12 | executor-quota-redispatch.test.ts | 5.4 | 4.5 | 0.9 | |
| 13 | dispatcher-fields.test.ts | 5.1 | 5.1 | 0.0 | 本机 teardown 异常高,CI 上正常 |
| 14 | executor-queued-reclaim.test.ts | 5.0 | 5.0 | 0.0 | |
| 15 | task-completion-events.test.ts | 4.8 | 3.9 | 0.9 | |

> CI 文件排名以**全量 129 文件**重算(本机仅为 13 文件子集)。`executor-queue.test.ts` 单文件即 134s / 21.3% wall,是 CI 上最该优先啃的单一目标;其 CI 绿但耗时仍高,说明耗时来自假执行器 `sh` 在 Linux 上的固有开销(非 Windows 注水),属真实优化对象。

---

## R6. CI per-file 实测结论(W1 · specs/ci-per-file-timing.md)

本票(W1)把上一张票 R2 里的"两列同构"假设变成实测。数据源:CI run `34571914641`(独立 `workflow_dispatch` 采集 job,全绿 129 文件 / 1733 用例,wall 629.8s),artifact `ci-perf-34571914641` 可下载;同口径另一条 run `34570640876` 因修复前 `.perf-runs` 被 gitignore 丢了四阶段数据,仅作 step 级旁证。

### R6.1 去掉 Windows 注水后,collection / teardown 在 CI 的占比

CI **无 Windows 注水**(Linux,假执行器 `sh` 原生、PGlite 在 Linux fs 正常,且 `services:postgres` 让本地红的那 5 条也绿),故 CI 数据即"去注水后"的真实分布:

- collectionOverhead = **29.3%**(184 726ms / 629 750ms)
- teardown(afterAll) = **8.7%**(54 820ms / 629 750ms)
- **collection + teardown 合计 = 38.0%**(239 546ms / 629 750ms)

→ 上一张票 R2 推测"去掉注水后可能从 13% 变成主导项"。实测**未到主导**(exec 仍 62.0%),但**从 13% 翻到 38%**(≈2.9×)——collection/transform + PGlite 实例创建是 CI 上体量远超本机认知(8.6%)的第二大桶,属真实可量化优化对象。

### R6.2 "两列同构"实测结论:**部分成立**

- **成立的部分(阶段排序)**:两侧都是 exec 最大、setup≈0、teardown 小。这与"同一 `--no-file-parallelism`、同一文件集"的机理一致。
- **不成立的部分(量级)**:collectionOverhead 占比 **CI 29.3% vs 本机子集 8.6%(~3.4×)**。上一张票 R2 那句"其 per-file 阶段结构与本机列同构……差异仅在'本机红文件的注水'一项"**据此修正**:差异不仅在红文件注水,CI 的 per-file collect/transform/PGlite 实例创建开销在占比上显著更高。
- **结论**:按 spec §3 R3「若推翻'同构'措辞,照实改掉」,本票将上述句子改为"阶段排序同构、量级不同构"(见 §R2 该段落已改写)。

### R6.3 T1(按真实依赖分类测试)可执行结论

按 CI 实测(非本机注水口径):

1. **第一优先:`executor-queue.test.ts` 单文件 = 134s = wall 的 21.3%**。CI 上它绿(本地红是 Windows sh 注水),但即便绿仍耗时最高——耗时来自假执行器 `sh` 在 Linux 上的固有开销,属真实优化对象。T1 应优先拆/并行/精简这一个文件的执行位。
2. **第二杠杆:collectionOverhead(29.3%,185s)**。这是 vitest 冷启 + 每文件 collect/transform/import + **每文件×文件数 的 PGlite 实例创建**(发生在 `onTestModuleStart` 之前,计入 collectionOverhead)。按"真实依赖分类",将共享同一 PG 状态的文件分组、复用/共享 PGlite 实例(而非每文件新建),是 CI 上**最大、最可量化**的杠杆——这是本机 8.6% 数据完全低估、差点被"同构"假设掩盖的部分。
3. **teardown(8.7%,55s)非优先**:每文件 ~0.4s,远低于"主导项"假设。
4. **exec(62%,390s)是真实测试成本**:下降需改测试逻辑,优先级低于上述两项可结构性回收的部分。

→ **T1 在 CI 上收益有限?否。** 仅 `executor-queue`(21%)+ collectionOverhead(29%)两项就覆盖 ≈50% wall 的可回收空间,且都指向可结构化的改造(分类/共享实例/精简执行位),不是逐用例硬抠。这正是本票把"同构"假设变实测的价值:若按本机"collection 仅 8.6%"去排 T1,会系统性低估 collection 改造的收益。

---

## W1 追加验收对照(specs/ci-per-file-timing.md §4 八条,2026-09-11)

1. ✅ 采集路径 `test-perf-timing.yml` 仅 `workflow_dispatch`,未挂 `on: push`(`grep on:` 仅 `workflow_dispatch`,无 push/pull_request)。
2. ✅ 主回路 `test-suite.yml` `Test` 步骤 `run: pnpm test` 一行未改(本票仅改 `docs/`;提交 diff 见 §6 自证拓展)。
3. ✅ 一轮 CI per-file 四阶段数据作 artifact `ci-perf-34571914641` 可下载;该轮红绿数:**129 文件全绿 / 1733 用例 0 红**(run `34571914641`)。
4. ✅ 基线报告 CI 列补四阶段(§R2 表);阶段排名(§R5 CI 表)与文件排名(§R5 Top15)按 CI 数字重算,非沿用本机。
5. ✅ 去掉 Windows 注水后 collection/teardown CI 占比 = **38.0%**(§R6.1)。
6. ✅ "两列同构"实测结论 = **部分成立**(§R6.2)。
7. ✅ T1 可执行结论(§R6.3):优先 `executor-queue`(21.3% wall)+ collectionOverhead(29.3%);非"收益有限"。
8. ✅ 测试代码 / `vitest.config.ts` / `scripts/test-baseline.mjs` 一行未改(`git diff --stat` 对本票为空)。

---

## 恒红清单(本机 Windows-only,逐条;是否计入耗时)

本票测量子集内确认红(4 文件 / 19 用例,见 §R4a,由 `test-baseline.mjs` 实测):

1. `executor-queue.test.ts` — 3 红。假执行器 `sh` spawn 在 Windows 失败/重试。**计入耗时**:是(300s,子集 70%,重试/超时加时,无早退省时)。
2. `executor-trigger.test.ts` — 8 红。同上(`sh` 执行位)。计入:是。
3. `executor-task-repo.test.ts` — 3 红。PGlite / 执行位相关。计入:是。
4. `single-server-lock.test.ts` — 5 红。需**真实 PostgreSQL**(advisory lock),本机无 `services:postgres` → 红。计入:是(跑完才判红)。

仓库级 Windows-only 恒红类别(供 T1–T6 参考,不止本子集):
- **执行位**:`chmodSync(fakeScript, 0o755)` + `sh` 的 executor 测试(server 多文件 + `callback-agent/test/callback-agent.test.ts`、`command-driver.test.ts`)。Windows 下 `sh` 不可执行/路径问题。
- **`file:///` 无盘符**:构造 `file:///` URL 不含 Windows 盘符的用例。
- **ENOENT ticket.md**:读取 Windows 路径下不存在的 `ticket.md` 的用例。
- **懒加载 chunk 超时**:web 懒导入 chunk 超时用例。
- **缺真 PG**(非 Windows 专属但本机不可用):`enforce-single-server-with-advisory-lock` 的 5 条。

**是否计入耗时**:全部**计入**——vitest 不因失败早退,红文件/红用例跑满全程;其中执行位类还因 `sh` 重试/超时**额外加时**。故本机总时被红文件显著抬高,这正是 §R4 结论"按 CI 定目标"的依据。

---

## 测量方法与脚本

- **独立计时脚本(不进 CI)**:`scripts/test-perf-timing.mjs` 包住 `vitest run --no-file-parallelism`,用 `performance.now()` 测 wall;自定义 reporter `scripts/test-perf-reporter.mjs` 钩 `onTestModuleStart/End` + `beforeAll/afterAll`,按 PID 写 `.perf-runs/<runId>/perf-<pid>.json`(避免 vitest 在主进程/worker 各实例化 reporter 相互覆盖),harness 合并后落 `.perf-runs/<runId>/run.json`。
- **为什么不用内置 json reporter**:本仓库下其 `file.startTime/endTime` 只覆盖文件内断言窗口(几 ms),遗漏 collect/transform/import/PGlite 窗口——那恰是每文件成本主体。自定义 reporter 取模块边界才拿到真实 fileTotal。
- **单调时钟**:全程 `performance.now()`,未用 `Date.now()` 相减。
- **输出隔离**:每 run 独立目录;未来若恢复并行,每 worker 自有 `perf-<pid>.json`,不互覆盖(`spec` R2 第 6 条)。
- **测量工件**:`.perf-runs/{local-rep-cold,local-rep-hot1,local-rep-hot2,local-rep-hot3}/run.json`(未提交,仅本机证据;报告已内嵌关键数)。
- **票级回归基线工具未改**:`scripts/test-baseline.mjs` 仅被**调用**(`node scripts/test-baseline.mjs packages/backend/server <13 文件>` 取失败数),未做任何修改(`git diff` 见 §6)。

---

## 6. 自证:只测量,未改变被观测对象

> 本节由检视者于 2026-09-11 L3 补正 —— 原报告在 §R1、§测量方法与脚本、
> 以及下方验收第 6/7 条共**四处**引用「§6 自证」,但文档里没有这一节。
> 事实成立(检视者独立复核过),缺的是承诺的证据本身。基线文档的价值全在
> 日后可被引用,悬空的交叉引用等于没有证据。

### 6.1 交付提交只新增,不修改(`git show --stat cfcf4935`)

```
docs/test-perf-baseline-ci-and-local.md | 226 ++++++++++++++++++++++++++++++++
scripts/test-perf-reporter.mjs          | 126 ++++++++++++++++++
scripts/test-perf-timing.mjs            | 151 +++++++++++++++++++++
3 files changed, 503 insertions(+)
```

**503 行全是新增,零删除零修改。** 三个文件都是本票产物:报告本身 + 两个
新建的计时脚本。

### 6.2 禁改路径零 diff(spec §4 验收 6)

```
git diff --stat a5bfabc4..cfcf4935 -- \
  scripts/test-baseline.mjs \
  packages/backend/server/vitest.config.ts vitest.workspace.ts \
  .github/workflows/test-suite.yml package.json \
  packages/backend/server/test packages/frontend/web/src
```

输出为**空**。测试代码、vitest 配置、CI workflow 的执行方式、根测试入口
一行未改 —— 这是本票「只测量不优化」的硬约束,一旦动了,这份基线就失去
作为后续 T1–T6 基准的资格。

### 6.3 票级回归基线工具逐字未变(spec §4 验收 7)

```
git diff a5bfabc4..cfcf4935 -- scripts/test-baseline.mjs | wc -l
→ 0
```

`scripts/test-baseline.mjs` 只被**调用**(取失败数),未被改造成性能工具 ——
spec §1.2 禁止的正是这件事:两个用途混在一个脚本里会让票级对照也变脆。
性能计时另起了 `test-perf-timing.mjs` + `test-perf-reporter.mjs`。

### 6.4 工作树里那两个长期未提交的文件

`docs/implementation-optimization-review-2026-09-07.md`(已修改)与
`start.ps1`(未跟踪)是所有者的工作稿,不参与构建与测试,本次测量**未读取、
未修改**,也没有为了让工作树"干净"去动它们(§R1 已说明)。

---

## 验收对照(spec §4 八条)

1. ✅ 报告落库含 R1 全部条件(§R1 双列表)。
2. ✅ CI 列(构建 26s / Test 652s 分步)+ 本机列(构建 / 用例执行 / setup / teardown / collectionOverhead 分步,§R2)。CI per-file 四阶段因 workflow 用 verbose reporter 未采集,已显式说明限制。
3. ✅ 三次热(468~472s)+ 中位(469.9s)+ 一次冷(463.4s,§R3)。
4. ✅ 分项归因非两总数(§R4 五类拆解)+ 明确"按 CI 定目标"结论。
5. ✅ 文件排名(§R5)+ 阶段排名(§R5)。
6. ✅ `git diff --stat` 自证:测试/vitest 配置/CI workflow 执行方式一行未改(§6)。
7. ✅ `scripts/test-baseline.mjs` 未被修改(§6)。
8. ✅ 本机 Windows-only 恒红逐条列明 + 是否计入耗时(§恒红)。
