# Plan: 按真实依赖给测试分类 + 解开 barrel 耦合(T1)

> 配套 `specs/test-dependency-classification.md`。spec 已冻结；`specHash` 作验收锚点。
> 路径规则：`specs/<name>.md` → `plans/<name>.md`。平台不解析本文件。
> **本票交付 T2 的输入**（分类清单 + barrel 解耦）；**不动 setup / db / vitest.config**。

## 元信息

| 字段 | 值 |
|---|---|
| specRef | `specs/test-dependency-classification.md` |
| specHash | `f84aa2f665025bf60692e6a8f221ea0b56c9fd1d` |
| 冻结提交 | `9403ea80`（检视者） |
| 编制 | 三方（reviewer + coordinator + executor） |
| dispatchKind | `requirement`（完整档 L3） |
| 更新 | 2026-09-11 |
| 来源 | 报告 §12.4 T1；前置 `ci-per-file-timing` Landed（CI run 34571914641） |
| 父协调任务 | `01a08f98-fa78-75d8-b467-70b00fdd7627` |
| 靶子口径 | **CI 实测** collectionOverhead 29.3%（185s），非本机 8.6% |

## 先做哪一步、为什么

整张 spec 是**一个内聚产物**：覆盖全量测试文件的依赖分类清单 + 纯逻辑测试的
barrel → 直引解耦。清单是 barrel 改动的判据，barrel 改动清单又要回写；拆成
「只分类」与「只改 import」两票会让第一票无法对照验收 3/6（没有前后基线与改动
列表），第二票又会在分类未完成时盲改。**只设 W1 一次做完。**

不允许的动作（下发时写进任务书红线）：

- 改 `test/setup.ts`、`test/db.ts`、`vitest.config.ts`（一行都不行 —— 那是 T2）
- 改任何断言 / 测试逻辑 / 用例体（diff 只应出现在 import 段）
- 拆混合文件（只在清单标「混合」）
- 新增只为测试存在的转发层 / re-export
- 改生产代码行为
- 修任何既有红
- 根 `pnpm test` 全量（~24min）；只跑票面/改动触及的文件清单

## 现状摘要（编制时已核实）

| 事实 | 证据 |
|---|---|
| spec Frozen，hash 一致 | `git hash-object specs/test-dependency-classification.md` = `f84aa2f…` |
| setup 无条件建 PGlite | `vitest.config.ts` setupFiles → `test/setup.ts` 顶层 import `./db` → `new PGlite()` + 32 迁移 |
| T1 **不能**让纯逻辑测试免建库 | spec §1.3；留给 T2 |
| CI 文件数锚点 129 | 基线报告 run 34571914641；本机 server 包现行约 87–100（期间有移除/重命名）—— 清单须对齐并说明出入 |
| barrel 重点 | `test/output-parser.test.ts` 从 `@server/lib/executor-task` barrel 拉 `createExecutorOutputParser` / `liveStreamText` / `summaryStreamText` / detail-store 等，**不能直接认定为纯解析** |
| 已有直引先例 | 部分测试已从 `../src/lib/executor-task/<module>` 直引（如 `diff-summary-merge`、`claim-verification`） |
| 执行器健康 | 派发时 atomcode=`recently_failed`，codebuddy=`available` → W1 派 **codebuddy** |

## 工作项

### W1 — 全量分类清单 + barrel 解耦（import-only）

| 字段 | 内容 |
|---|---|
| 稳定编号 | W1 |
| 目标 | 产出覆盖 server 包**全部**测试文件的真实依赖分类清单（含判据）；把可安全解耦的纯逻辑测试从 barrel 改为直引实际模块；给出交给 T2 的结论表。 |
| 范围 | **允许**：测试文件 **import 段**；新增分类清单文档（建议 `docs/test-dependency-classification.md`）；仅当纯函数确有独立领域行为才移动且保持公共导出兼容（一般不需要动生产代码）。**禁止**：见上方红线。 |
| 前置依赖 | 无（spec Frozen；ci-per-file-timing Landed） |
| 预期产物 | 1) `docs/test-dependency-classification.md`（或等价路径）：每文件分类 + 判据（import/副作用）+ barrel 列表 + 混合说明 + 未确认原因 + **T2 结论**（可不要 DB / 必须要 DB / 未确认）；文件数与 129 对齐或说明出入。2) 纯逻辑测试 barrel→直引的 import 改动（断言零改）。3) 受影响文件前后基线对照（`node scripts/test-baseline.mjs packages/backend/server <文件...>`）。4) `git diff` 自证 setup/db/vitest.config 未改、断言未改。5) commit（`git commit -- <明确路径>`）。 |
| 实现要点 | **R1** 按导入图与副作用分六类（可多选）：纯内存 / 临时文件 / 数据库 / Git / HTTP-WS / 执行器生命周期；判据可复核。**R2** 列出全部 barrel 导入；对**确认纯逻辑**的改为从实际模块导入；`output-parser.test.ts` 先确认真实依赖再动，不能无脑改。**R3** 混合文件只标记不拆。**R4** 拿不准 →「未确认」+ 原因，保留重环境。**R5** 不新增测试专用转发层；不得不留 barrel 的记入清单。 |
| 验收方法 | 对照 spec §4 八条：①全覆盖+文件数 ②每项判据 ③barrel 列表与已改文件 ④断言仅 import 段 ⑤setup/db/vitest 未改 ⑥基线前后一致（失败数不增加）⑦无测试转发层 ⑧T2 结论表。 |
| 测试文件清单 | 改动触及的测试文件（至少含所有改了 import 的文件）；用 `test-baseline.mjs` 取前后对照。**禁止**根全量。验收口径「失败数不增加」。 |
| specRef | `specs/test-dependency-classification.md` |
| specHash | `f84aa2f665025bf60692e6a8f221ea0b56c9fd1d` |
| taskId | `01a08f9b-95a6-755c-a3b1-0ac90174bf1f`（codebuddy） |
| 状态 | dispatched |
| 执行器 | codebuddy（atomcode 当时 recently_failed） |
| 触发消息 | `01a08f9b-9598-762d-a77e-802fefef20dd` |

## 依赖图

```
W1（单票闭环）→ L2 → L3（完整档）
```

## 派发后动作（协调者）

1. 派发成功拿到子任务 id → 回填本计划 `taskId` / 状态 → **立即结束本轮**（不轮询）。
2. 子任务终态后由平台拉起续跑 → L2 对照 spec §4 → 通过则 PATCH 父任务 `done` + `review_request`（完整档，不带 `lite`）。
