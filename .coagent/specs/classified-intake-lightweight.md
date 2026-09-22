# Classified intake 与 Lightweight Fast Lane

入口把**结构化 facts / assessment** 交给确定性 classifier，再按推荐路由创建 Mission（或拒绝）。caller **不得**自填 route。

## Intake 不变量

- `parseTaskFactsStrict` / `parseComplexityAssessmentStrict` 只校验 schema；**不分类**。路由唯一来源：`classifyTask()`（`task-classifier.ts`）。
- 根键 `executionMode` / `runKind` / `recommended` / `classification` / `route` 等 → `BAD_ROUTING_INPUT`（`ClassifiedMissionInputError`）。
- `Platform.createClassifiedMission` 顺序：assert override → strict parse → classify → **route guards（先于 ensureProject / 分配 id）** → 创建 → 单次 save → `mission.created` + `mission.routed`。
- 拒绝路径不留空 Project。

## 路由结果（当前阶段）

| classifier 推荐 | 行为 |
| --- | --- |
| `runKind=query` | `QUERY_ROUTE_REQUIRED`，不建 Mission；走 Query 路径 |
| `executionMode=high_assurance` | `HIGH_ASSURANCE_NOT_AVAILABLE`，不建 Mission |
| `standard` | 建 Standard Mission；**禁止**带 `workOrder` |
| `lightweight` | 原子 Mission + 恰好一个 Frozen WorkItem；**必须**显式 `workOrder` |

- HTTP：`POST /api/missions/classified`（控制面）。**无** agent tool / `/api/agent/*classified*`。
- Legacy `POST /api/missions` 仍走 `createMission`，不读 `executionMode`。

## Lightweight 执行面（进程内）

Orchestrator Fast Lane 只调 Platform trusted 方法（不暴露 HTTP/tools）：

1. `createLightweightWorkItem` — 零 Coordinator、恰好一 WorkItem；不占 mutation slot。
2. `dispatchLightweightWorkItem` — 与 Standard 同序：mutation-slot → PRE_DISPATCH shadow → dispatch。
3. Executor hop → submitted 后 `validateAndAcceptLightweightWorkItem`（先持久化 ValidationReport，再 validator accept）。
4. `submitLightweightMissionForReview` → `awaiting_review`（**不 complete**）。
5. 仍须 **L3 `finalizeMission`** 才能 completed / merge（见 ADR-0004）。

校验失败保持 submitted / stall；**不**回退 Coordinator。trusted 方法名不得出现在 `api/` 或 tool 面（`source-constraints` 钉死）。

## Classifier 要点

- Query 仅当 `readOnlyProven=true` ∧ `mutationSideEffect=false` ∧ 无 HA true ∧ 无 critical unknown。
- HA true → 至少 `high_assurance`；critical unknown → 至少 `standard`；score 只可抬升不可降档；无 assessment 时无 floor → fail-closed `standard`。

## 权威源 / 测试

- 源：`classified-mission-intake.ts`、`task-classifier.ts`、`platform.ts`（`createClassifiedMission` / Lightweight 方法）、`orchestrator.ts`（lightweight 分支）
- 测试：`classified-mission-intake.test.ts`、`task-classifier.test.ts`、`orchestrator-lightweight.test.ts`、`platform-lightweight.test.ts`、`source-constraints.test.ts`
