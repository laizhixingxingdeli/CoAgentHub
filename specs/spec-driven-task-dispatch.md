# Spec: Spec-Driven Task Dispatch (规范驱动任务下发)

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-18

## 1. 背景与目标

CoAgentHub 当前的任务下发模式是"指令驱动"：协调者发一条消息，执行器执行。
缺少"先定规范、再执行"的约束，导致需求模糊时执行器反复返工。

本 Spec 将 CoAgentHub 升级为"规范驱动"：协调者必须先确定 Spec（含验收标准），
才能下发任务；执行器在任务书中看到 Spec 引用，严格按规范实现。

## 2. 改动范围

### 2.1 数据库 Schema 扩展

**文件**: `packages/backend/database/src/schema/task.ts`

在 `task` 表中新增两列：

| 列名 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `spec_ref` | `text` | 可空 | 规范文档路径，如 `specs/login-v2.md` |
| `spec_hash` | `text` | 可空 | 规范文档的 Git Hash（版本快照，用于审计） |

### 2.2 新迁移文件

**文件**: `packages/backend/database/drizzle/migrations/0017_add_task_spec_fields.sql`

```sql
ALTER TABLE "task" ADD COLUMN "spec_ref" text;
ALTER TABLE "task" ADD COLUMN "spec_hash" text;
```

同时在 `meta/_journal.json` 中追加条目。

### 2.3 类型定义扩展

**文件**: `packages/backend/server/src/lib/executor-task/types.ts`

在 `DispatchExecutorInput` 接口中新增：
```typescript
specRef: string | null;
specHash: string | null;
```

### 2.4 调度核心修改

**文件**: `packages/backend/server/src/lib/executor-task/queue.ts`

#### 2.4.1 `maybeDispatchExecutorTask` — 透传 spec 字段

在 `dispatchTask(db, {...})` 调用中新增 `specRef` 和 `specHash` 透传。

#### 2.4.2 `dispatchTask` — 写入 task 行

在 `db.insert(taskTable).values({...})` 中新增：
```typescript
specRef: input.specRef,
specHash: input.specHash,
```

#### 2.4.3 `buildTicket` — 任务书模板增加 Spec 引用段

函数签名新增 `specRef: string | null` 参数。

在任务书模板中，当 `specRef` 非空时插入：
```markdown
## 📜 关联规范 (Spec Reference)
- **文档路径**: {{specRef}}
{{#if specHash}}- **版本哈希**: {{specHash}}{{/if}}
- **指令**: 请严格遵循上述文档中的定义进行开发。如有冲突，以 Spec 为准。
```

插入位置：在 `## 任务内容` 之前（Spec 优先于任务内容）。

### 2.5 消息路由修改

**文件**: `packages/backend/server/src/routes/group/messages.ts`

在 POST `/:id/messages` 的 zod schema 中新增可选字段：
```typescript
specRef: z.string().max(500).optional(),
specHash: z.string().max(64).optional(),
```

在 `maybeDispatchExecutorTask` 调用中透传这两个字段。

### 2.6 任务路由修改

**文件**: `packages/backend/server/src/routes/group/tasks.ts`

在 POST `/:id/tasks` 的 zod schema 中新增可选字段：
```typescript
specRef: z.string().max(500).optional(),
specHash: z.string().max(64).optional(),
```

在 `db.insert(taskTable).values({...})` 中写入这两个字段。

### 2.7 任务详情 API 返回

**文件**: `packages/backend/server/src/routes/group/tasks.ts`

在 GET `/:id/tasks/:taskId` 的返回体中包含 `specRef` 和 `specHash` 字段。
（由于是直接返回 task 行，新增列会自动出现在 JSON 中，无需额外代码。）

### 2.8 任务状态响应扩展

**文件**: `packages/backend/server/src/lib/ws-hub.ts`

在 `TaskStatusChangedTask` 接口中新增：
```typescript
specRef: string | null;
specHash: string | null;
```

在 `notify.ts` 的 `notifyTaskStatusChanged` 中透传这两个字段。

## 3. 验收标准

- [ ] `task` 表存在 `spec_ref` 和 `spec_hash` 列
- [ ] 迁移 0017 可正常执行
- [ ] POST `/api/groups/:id/messages` 接受 `specRef` / `specHash` 可选字段
- [ ] POST `/api/groups/:id/tasks` 接受 `specRef` / `specHash` 可选字段
- [ ] 定向消息命中执行器时，task 行写入 `specRef` / `specHash`
- [ ] 任务书（buildTicket 输出）在 specRef 非空时包含"关联规范"段
- [ ] GET `/api/groups/:id/tasks/:taskId` 返回体包含 `specRef` / `specHash`
- [ ] WS `task_status_changed` 事件的 task 载荷包含 `specRef` / `specHash`
- [ ] 现有测试全部通过（`pnpm test` 后端 264 个 + 前端 254 个）
- [ ] 类型检查通过（`pnpm check-types`）
- [ ] 构建通过（`pnpm build`）

## 4. 不涉及的改动

- 不修改前端代码（Spec 引用在前端展示是后续迭代）
- 不修改 `dispatch-policy.json`（调度策略不变）
- 不修改执行器配置（执行器侧不需要知道 Spec 格式变化）
- 不引入新的 npm 依赖
- 不修改 MCP 插件（插件侧修改是独立迭代）

## 5. 兼容性

- `specRef` / `specHash` 均为可选字段，不传时行为与现有完全一致
- 旧任务行的新列为 null，不影响现有数据
- API 向后兼容：不传 specRef 的请求与当前行为完全相同
