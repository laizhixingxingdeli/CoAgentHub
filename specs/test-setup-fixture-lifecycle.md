# Spec: 拆开 test/setup.ts —— 不需要数据库的测试别再建库(报告 T2)

> **状态**: **Landed — L3 通过(2026-09-12),实现 `268e7143`**
> **版本**: 1.0
> **日期**: 2026-09-12
> **来源**: `docs/implementation-optimization-review-2026-09-07.md` §12.5 步骤 T2
> **前置**: [test-dependency-classification.md](test-dependency-classification.md)
> (T1,已 Landed)—— 它明确把这件事划给 T2 并交付了分类清单

## 1. 问题(T1 已查实)

`vitest.config.ts` 的 `setupFiles: ["./test/setup.ts"]` 对**全部 94 个测试文件**
生效,而 `setup.ts` **第 13 行是模块顶层**:

```ts
import { testClient } from "./db";      // db.ts 顶层就是 new PGlite()
```

于是**每个文件**都要:建 PGlite → `beforeAll` 里跑 32 个迁移 `.sql` → `afterAll`
关库 —— 哪怕它只测一个纯函数。

实测:94 个文件里 **44 个根本不 import `./db`**,其中 **31 个连 `./app` 也不 import**。

⚠️ **不是 `vi.mock` 逼出来的。** 那段 mock 的工厂本来就惰性
(`async () => { await import("./db") }`),只有文件真需要
`@server/lib/database` 时才触发。**是第 13 行。**

## 2. 改法

| | 做法 |
|---|---|
| **R1** | `setup.ts` 去掉顶层 `import ./db`;迁移移进 `db.ts` 的模块初始化(顶层 `await`)。import 了 `./db` 的文件拿到已迁移完毕的库;没 import 的**根本不建** |
| **R2** | 新增极小的 `test/db-state.ts`(一个布尔);`db.ts` 建库时置真;`setup.ts` 的 `afterAll` 未建库则只删临时目录,**跳过排空与关库**(排空还要 `await import("../src/lib/executor-task")`,对纯逻辑文件是纯浪费) |
| **R3** | `sweepStaleTestDirs()` 从每文件一次改为 `globalSetup` 每轮一次(它 `readdirSync` 整个系统临时目录) |

**逐字不变的三处**:`vi.mock` 的位置与写法;排空逻辑(20 秒上限、1 秒 idle 确认
及其长注释——那是修 `PGlite is closed` 竞态时定下的);清扫判据(两种前缀、
6 小时 cutoff、逐项 try/catch)。

## 3. 验收锚点:用例清单必须逐条一致

⚠️ **这是本票唯一可靠的正确性判据。** 本机全量跑的红绿数不可信
(见 [windows-local-test-unreliable](restore-ci-green-and-resume-pushing.md) 的记录),
但「收集到哪些用例」是确定的 —— 而且它恰好能抓住本票最怕的事故:
**某个文件在收集阶段就挂了而没人发现**。

规范化方式:`npx vitest list | grep "^test/" | sort`。

## ✅ L3 收口记录(检视者独立核实)

| 项 | 结果 |
|---|---|
| **用例清单** | **1297 : 1297,`diff` exit 0,内容哈希同为 `e0ba58d52736404663074219704562fdd2dc0383`** |
| **收益(检视者自己 A/B 量的)** | `executor-ansi` + `output-buffer` + `token-usage` 三文件:**改前 11.28s → 改后 1.29s,8.7×** |
| DB 抽样 4 文件 | 71 passed / 0 failed |
| `tsc` / `biome`(仓库根) | exit 0 |
| 改动边界 | 仅 `setup.ts` / `db.ts` / `vitest.config.ts` + 2 个新小模块;**未动任何 `*.test.ts`、未动 `src/`、未动 `database/`** |

A/B 做法:把 `setup.ts` / `db.ts` / `vitest.config.ts` 三个文件单独
`git checkout HEAD~1 --` 回退,跑同一组纯逻辑测试计时,再还原。
**不采信汇报里的数字。**

### 为什么这条验收比「测试全绿」更有力

「跑一遍绿了」只能说明**被执行到的**用例没坏。本票真正的风险是
**某个文件在收集阶段就挂了**(setup 拆分把某个模块的加载时序弄错),
那种情况下它的用例**根本不会出现在结果里**,而「绿」照样成立。

用例标识逐条比对直接盯住这一点:**少一条都会被发现。**

## 4. 不涉及的改动

- 不改任何 `*.test.ts`。
- 不让多个测试文件共用一个 PGlite 实例 —— 报告明确要求本阶段
  **保留独立数据库隔离**。
- 不升级测试框架、不动 `fileParallelism`。
- 报告 T3(以明确完成信号替代固定空闲等待)触及生产主路径,**另立**。
