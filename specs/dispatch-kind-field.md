# Spec: `dispatchKind` —— 记录工作类型分流结果

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-23
> **依据**: `specs/reviewer-role-spec-generation.md` v4.0 §3.14.6

## 背景

§3.14.6 把「模式」拆成两根正交的轴:

| 轴 | 粒度 | 决定什么 |
|---|---|---|
| **工作类型**(需求 / 修复) | **逐项**,由检视者分流 | 要不要新写 spec、**要不要跑 L3** |
| **成员构成**(三方 / 两方) | **群级**,实时推导 | 这些活**谁来干** |

L3 的判定收敛成:

```
跑 L3  ⟺  群内 reviewer 与 coordinator 同时在场  AND  本票 dispatchKind == requirement
```

第二个条件**当前没有任何地方可以记录**。task 表只有 `specRef` / `specHash` /
`parentTaskId` / `dispatchAudit`,没有字段区分「这票是需求还是修复」。协调者与前端
都无从判断。四个 skill 已按 v4.0 改写并开始要求传 `dispatchKind`,**规格已经领先于
实现**,本票补齐。

### 它不是「模式字段」

§3.14.1「模式由成员构成推导,不落平台字段」**不变**。`dispatchKind` 记录的是
**检视者的分流结果**,与成员构成正交——两方编制下同样有需求和修复之分。

### 平台不据此做强制

平台**只负责承载与透出**这个字段,**不据它决定流程**。跑不跑 L3 由协调者按 skill
判断。这与「平台不感知模式」是同一条原则:平台存事实,不执行流程。

---

## 要求

### R1. 数据模型

`packages/backend/database/src/schema/task.ts` 新增列:

```ts
dispatchKind: text("dispatch_kind").$type<"requirement" | "fix">(),
```

- **可空**。历史任务没有这个字段,`null` = 未记录。
- 新建迁移 `drizzle/migrations/0024_add_task_dispatch_kind.sql`。
- **不加 CHECK 约束**,不加索引(当前无按此列查询的需求;别提前优化)。

### R2. `null` 的语义:保守视为 `requirement`

任何**消费方**(协调者、前端)遇到 `null` 时,**按 `requirement` 处理**。

理由:两种默认值都会犯错,但方向不同。默认成 `fix` 会让历史任务**静默跳过 L3**——
一个检视环节凭空消失且无人察觉;默认成 `requirement` 最坏只是多跑一次检视。
**宁可多检,不可漏检。**

> ⚠️ 这条只约束**消费方的解读**。不要为此在写入时把 `null` 回填成
> `"requirement"` —— `null`(未记录)与显式 `"requirement"`(检视者判定过)是
> 两个不同事实,合并就丢掉了「这票没走过分流」这条信息。

### R3. HTTP API

`packages/backend/server/src/routes/group/tasks.ts`:

- **创建任务**:请求体接受可选 `dispatchKind`,zod 校验为
  `z.enum(["requirement","fix"]).optional()`,落库(不传 → `null`)。
- **列表**:`select` 中透出 `dispatchKind`(与 `specRef` 同一处)。
- **详情**:透出 `dispatchKind`。

**与 `specRef` 完全同构** —— 照着 `specRef` 现有的三处改动写,不要另造模式。

### R4. 不做的事

- **不改** MCP 工具 `coagenthub_dispatch_task` 的入参 —— 那是插件仓的事
  (spec §3.18:平台契约是 HTTP API,`coagenthub_*` 是插件实现)。本票只动 HTTP API。
- **不实现**任何基于该字段的流程分支、校验或拦截(见「平台不据此做强制」)。
- **不改**前端分组与列表 —— 归 `specs/requirement-list-kind-tabs.md`,本票不碰。
- **不回填**历史数据。

---

## 验收标准

- [ ] `task` 表有 `dispatch_kind` 列,可空,类型 text
- [ ] 迁移文件 `0024_add_task_dispatch_kind.sql` 存在
- [ ] **迁移已对本地运行中的库执行**(`pnpm --filter @laizhixingxingdeli/database run migrate`),
      并贴出执行输出 —— 曾有一票只写迁移没执行,导致 `/tasks` 全线 500
- [ ] `POST /api/groups/:id/tasks` 接受 `dispatchKind`,值为 `requirement` / `fix` 时落库
- [ ] 传非法值(如 `"bug"`)返回 400,不落库
- [ ] 不传时落 `null`,**不回填成 `"requirement"`**
- [ ] `GET /api/groups/:id/tasks` 列表项含 `dispatchKind`
- [ ] `GET /api/groups/:id/tasks/:taskId` 详情含 `dispatchKind`
- [ ] 新增测试覆盖:落库 / 透出 / 非法值 400 / 不传为 null,**四条都要有**
- [ ] 后端测试全绿,贴出用例数
- [ ] **未改动**任何前端文件
- [ ] **未新增**任何基于 `dispatchKind` 的流程分支或拦截逻辑

## 不涉及

- 插件侧 MCP 工具入参(另仓另票)
- 前端展示与分组(`requirement-list-kind-tabs`)
- 历史数据回填
- 任何强制/拦截行为

## 执行环境提示

- 本仓是 **pnpm** 项目
- 后端在 `:3001` 运行中。**改完需要重启后端**,并在重启前确认没有 running/queued 任务
  (`select count(*) from task where status in ('running','queued')`)—— 曾有一次
  重启打断了协调者的 PATCH 窗口
- 迁移命令需要 `DATABASE_URL` 已导出
