# Spec: Plugin & Skill Adaptation for Spec-Driven Task Dispatch

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-18
> **依赖**: 服务端 Spec-Driven Task Dispatch（specs/spec-driven-task-dispatch.md）已完成

## 1. 背景与目标

服务端已新增 `specRef` / `specHash` 字段到消息和任务的 API 中。
现在需要适配 dsh-coagenthub 插件（MCP 工具层）和协调者 Skill（工作流约束），
使协调者在下发任务时能够携带 Spec 引用，并在任务完成后看到 Spec 信息。

## 2. 插件修改（dsh-coagenthub）

### 2.1 `coagenthub_dispatch_task` 工具参数扩展

在 `coagenthub_dispatch_task` 工具的参数定义中新增两个可选字段：

```typescript
specRef: {
  type: "string",
  description: "规范文档路径（如 specs/feature-x.md）。传入后服务端任务书自动插入「关联规范」段，执行器按此规范执行。不传时行为不变。",
  maxLength: 500,
}  // optional

specHash: {
  type: "string",
  description: "规范文档的 Git Hash（版本快照）。可选，用于审计和版本锁定。",
  maxLength: 64,
}  // optional
```

### 2.2 派发逻辑修改

在 `coagenthub_dispatch_task` 的实现中，当调用 `POST /api/groups/:id/messages` 时：
- 如果用户传了 `specRef`，将其加入请求体 `specRef` 字段
- 如果用户传了 `specHash`，将其加入请求体 `specHash` 字段
- 不传时请求体不包含这两个字段（向后兼容）

### 2.3 `planOnly` 预览渲染

当 `planOnly=true` 时，任务书预览中如果包含 Spec 引用段（`## 📜 关联规范`），
在预览输出中高亮显示，让协调者确认 Spec 引用是否正确。

### 2.4 任务展示增强

`coagenthub_get_task` 和 `coagenthub_list_tasks` 返回的任务对象中，
服务端已包含 `specRef` / `specHash` 字段。插件侧无需额外代码，
这些字段会自动出现在 JSON 返回中。

但建议在插件的 TaskWatcher（任务监听面板）中：
- 当任务有 `specRef` 时，在任务行显示一个 📜 图标标记
- 点击可展开查看 Spec 路径

### 2.5 新增工具：`coagenthub_validate_spec`（可选，P1）

新增一个轻量工具，帮助协调者在下发前快速校验 Spec 是否完备：

```typescript
// 工具定义
coagenthub_validate_spec: {
  description: "校验 Spec 文档是否包含必要的章节（验收标准、改动范围等）",
  parameters: {
    specPath: { type: "string", description: "Spec 文件路径" }
  }
}
// 返回: { valid: boolean, missingSections: string[], suggestions: string[] }
```

校验规则（纯文本检查，不引入 LLM）：
- 必须包含 `## 验收标准` 或 `Acceptance Criteria` 章节
- 必须包含 `## 改动范围` 或 `## 范围` 章节
- 建议包含 `## 背景` 章节
- 文件必须实际存在于工作区

## 3. Skill 修改（协调者工作流）

### 3.1 更新 AGENTS.md

在 `AGENTS.md` 的 "Domain docs" 章节后新增 "Spec-Driven Dispatch" 段落：

```markdown
## Spec-Driven Dispatch (规范驱动任务下发)

CoAgentHub 采用 Spec-Driven 工作流：协调者在完全确定实现方案前不允许下发任务。

### 下发前检查清单（Pre-Flight Grill）

在调用 `coagenthub_dispatch_task` 之前，协调者必须：

1. **编写或更新 Spec 文档**：在 `specs/` 目录下创建或修改 `.md` 文件，
   包含以下章节：
   - `## 背景`：为什么需要这个改动
   - `## 改动范围`：涉及哪些文件/模块，不涉及什么
   - `## 验收标准`：可验证的完成条件（checklist 格式）
   - `## 不涉及的改动`：明确排除项

2. **自检**：问自己三个问题：
   - 我是否已经明确了所有的输入输出？
   - 验收标准是否可验证（不是"优化性能"而是"响应时间 < 200ms"）？
   - 如果我是执行器，仅凭这份 Spec + 任务书我能一次性写对吗？
   **如果任何一个答案是"否"，不要下发任务，继续完善 Spec。**

3. **传入 specRef**：调用 `coagenthub_dispatch_task` 时传入 `specRef` 参数，
   指向刚才编写的 Spec 文件路径。

### 完成后验收（Post-Flight Grill）

当执行器回传结果后，协调者必须：

1. **拉取任务详情**：`coagenthub_get_task`，检查 `diffSummary` 和 `outputTail`
2. **对照 Spec 验收**：逐项检查 Spec 中的验收标准是否全部满足
3. **文档同步检查**：代码改动是否需要同步更新文档（ADR、architecture.md 等）
4. **裁决**：
   - 全部通过：在群内发 `✅ 验收通过` 并标记任务 done
   - 部分失败：在群内发 `❌ 验收未通过：<原因>` 并要求重试或人工介入
```

### 3.2 协调者 System Prompt 约束

在协调者（如 Hermes / Win Hermes）的群内分工提示词（`group_members.prompt`）中
加入以下约束：

```
你是协调者。你的职责是确保任务在下发前有清晰的规范（Spec），在完成后有严格的验收。
- 不允许在 Spec 未确定前下发任务
- 下发任务时必须传入 specRef
- 任务完成后必须对照 Spec 验收
```

### 3.3 `coagenthub_dispatch_task` 工具描述更新

更新工具的 `description` 字段，提醒协调者 Spec-First 原则：

```typescript
description: "Dispatch a task to a CoAgentHub executor... 
  Spec-Driven workflow: before dispatching, ensure a Spec document exists in specs/ 
  and pass specRef to link it. The executor will see the Spec reference in the task ticket 
  and must follow it. If specRef is not provided, the task runs in legacy mode (no Spec约束)."
```

## 4. 验收标准

### 插件侧
- [ ] `coagenthub_dispatch_task` 接受可选的 `specRef` / `specHash` 参数
- [ ] 派发时请求体包含 specRef/specHash（当传入时）
- [ ] `planOnly` 预览中显示 Spec 引用段
- [ ] 不传 specRef 时行为与现有完全一致（向后兼容）
- [ ] （P1）`coagenthub_validate_spec` 工具可校验 Spec 文件完备性

### Skill 侧
- [ ] AGENTS.md 包含 Spec-Driven Dispatch 章节
- [ ] 协调者 prompt 包含 Pre-Flight Grill 检查清单
- [ ] 协调者 prompt 包含 Post-Flight Grill 验收流程
- [ ] `coagenthub_dispatch_task` 工具描述提醒 Spec-First 原则

## 5. 不涉及的改动

- 不修改 CoAgentHub 服务端代码（服务端改动由独立任务完成）
- 不修改前端 React 代码
- 不引入新的 npm 依赖
- 不修改执行器配置

## 6. 兼容性

- specRef/specHash 均为可选，不传时完全兼容现有行为
- AGENTS.md 新增段落不影响现有 agent 工作流（增量信息）
- 工具描述更新不影响参数 schema（仅 description 文案变化）
