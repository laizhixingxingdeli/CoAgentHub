# Spec: Skill 加载强化 + 任务书精简 + 项目初始化检查

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-18
> **依赖**: 服务端 specRef/specHash（465658f）、Skill 安装 API（e3d9a28）、coordinator/executor/bugfix skills（5b2cb6c）

## 1. 背景与目标

当前实现存在三个需要调整的问题：

1. **任务书过度固化**：buildTicket 包含完整"执行流程"和"Code Review 自检"段，
   但具体方法论应由 skill 承载。任务书只需触发 skill 即可。
2. **skill 安装依赖 agent 主动拉取**：不可靠。应在 agent 加入群组时由服务端
   自动发送安装指令，并在 agent 确认后更新 capabilities，实现一次性安装。
3. **新项目缺少 Matt 初始化检查**：首次下发任务时应检查项目文档脚手架，
   缺失则提示协调者先初始化。

## 2. 改动范围

- `packages/backend/server/src/lib/executor-task/queue.ts` — 任务书精简
- `packages/backend/server/src/routes/group/members.ts` — 加群自动发 skill 安装指令
- `packages/backend/server/src/lib/participant-capabilities.ts` — 识别 skill 安装确认消息
- `packages/backend/server/src/routes/group/messages.ts` — 首次任务初始化检查
- `packages/backend/server/src/lib/executor-task/notify.ts` — skill 安装确认处理（如适用）
- 新增测试覆盖

## 3. 详细改动

### 3.1 任务书精简（回退过度固化）

**文件**: `packages/backend/server/src/lib/executor-task/queue.ts`

在 `buildTicket` 函数中：

1. **移除**「执行流程（必读）」段（commit d8bc934 加入的 8 行）
2. **移除**「Code Review 自检（完成前必做）」段（commit 28c4757 加入的 15 行）
3. **替换**为「执行方式」段：

```markdown
## 执行方式
本任务按 `coagenthub-executor` skill 执行。
- 已安装：直接按 skill 流程执行（读规范→写代码→测试→Code Review 自检→汇报）。
- 未安装：先 GET /api/skills/executor 获取 skill 内容，安装到 skills 目录后执行。
```

**保留**：📜 关联规范段、任务内容、汇报格式要求、本群分工、执行与测试要求、默认约束。

### 3.2 加群自动发 skill 安装指令

**文件**: `packages/backend/server/src/routes/group/members.ts`

在添加成员成功的 handler 中，成员添加成功后 fire-and-forget 自动发一条
`audience=participant` 的定向消息：

```typescript
// 添加成功后
const skillMessages: Record<string, string> = {
  executor: `请先安装 coagenthub-executor skill：
1. GET /api/skills/executor 获取内容
2. 写入你的 skills 目录（如 ~/.hermes/skills/coagenthub-executor/SKILL.md）
3. 安装完成后回复「✅ skill 已安装」
未安装前不要领取任务。`,
  coordinator: `请先安装 coagenthub-coordinator skill：
1. GET /api/skills/coordinator 获取内容
2. 写入你的 skills 目录（如 ~/.hermes/skills/coagenthub-coordinator/SKILL.md）
3. 安装完成后回复「✅ skill 已安装」
未初始化前不要下发任务。`,
};

for (const role of roles) {
  if (skillMessages[role]) {
    await insertGroupMessage(db, {
      groupId: id,
      senderId: /* 服务端系统身份，可用 Local User */,
      audience: "participant",
      audienceRef: participantId,
      body: skillMessages[role],
      contentType: "text/plain",
    });
  }
}
```

注意：消息发送者建议用 Local User（或系统身份），避免需要额外权限。

### 3.3 skill 安装确认 → 更新 capabilities

**文件**: `packages/backend/server/src/lib/participant-capabilities.ts`

新增函数 `handleSkillInstallConfirmation(db, senderId, body)`：

```typescript
export const COAGENTHUB_SKILL_CAPABILITIES = {
  executor: "coagenthub-executor",
  coordinator: "coagenthub-coordinator",
  bugfix: "coagenthub-bugfix",
} as const;

export async function handleSkillInstallConfirmation(
  db: DataBase,
  senderId: string,
  body: string,
): Promise<void> {
  // 匹配 "✅ skill 已安装" 或 "✅ skill 已安装: executor" 等
  const match = body.match(/^✅\s*(?:skill|技能)?\s*已安装(?:\s*[:：]\s*(\w+))?/i);
  if (!match) return;

  // 推断 skill 类型：显式指定或用默认 executor
  const skillKey = match[1]?.toLowerCase() ?? "executor";
  const capability = COAGENTHUB_SKILL_CAPABILITIES[skillKey];
  if (!capability) return;

  // 更新 participant capabilities（幂等追加）
  const participant = await db.query.participant.findFirst({
    where: (t, { eq }) => eq(t.id, senderId),
  });
  if (!participant) return;

  const current = participant.capabilities ?? [];
  if (!current.includes(capability)) {
    await db.update(participantTable)
      .set({ capabilities: [...current, capability] })
      .where(eq(participantTable.id, senderId));
  }
}
```

**文件**: `packages/backend/server/src/routes/group/messages.ts`

在 POST /:id/messages 的 handler 中，消息发送成功后（fire-and-forget）调用：
```typescript
void handleSkillInstallConfirmation(db, senderId, body ?? "");
```

### 3.4 首次任务初始化检查

**文件**: `packages/backend/server/src/routes/group/messages.ts`

在 POST /:id/messages 中，当消息触发任务（即 `maybeDispatchExecutorTask` 即将被调用）时，
检查群绑定的 projectPath 是否已初始化 Matt 文档脚手架。

```typescript
// 在 maybeDispatchExecutorTask 调用前检查
const group = await db.query.groups.findFirst({
  where: (t, { eq }) => eq(t.id, id),
});
if (group?.projectPath) {
  const missing = await findMissingProjectDocs(group.projectPath);
  if (missing.length > 0) {
    // 返回 warning 给客户端（不阻塞消息发送）
    c.header("X-Project-Init-Warning", `PROJECT_NOT_INITIALIZED:${missing.join(",")}`);
  }
}
```

`findMissingProjectDocs(projectPath)` 检查以下文件/目录是否存在：
- `AGENTS.md`
- `CONTEXT.md`
- `docs/adr/`
- `specs/`
- `.cursorrules`（或等效）

**文件**: `packages/backend/server/src/lib/participant-capabilities.ts` 或新工具文件

新增 `findMissingProjectDocs`：
```typescript
export function findMissingProjectDocs(projectPath: string): string[] {
  const required = ["AGENTS.md", "CONTEXT.md", "docs/adr/", "specs/", ".cursorrules"];
  return required.filter((p) => !existsSync(resolve(projectPath, p)));
}
```

### 3.5 测试

新增/更新测试：
- `executor-task-repo.test.ts`：断言 buildTicket 输出包含「执行方式」段，且**不包含**
  「执行流程（必读）」和「Code Review 自检」完整段
- `group-member-mgmt.test.ts`：添加 executor 成员后自动发 skill 安装消息
- `group-message.test.ts` 或新测试：发送 "✅ skill 已安装" 后 capabilities 更新
- `group.test.ts`：绑定 projectPath 后首次下发任务返回初始化 warning

## 4. 验收标准

- [ ] buildTicket 输出包含「执行方式」段，不含「执行流程（必读）」和「Code Review 自检」段
- [ ] 添加 executor/coordinator 成员后自动发 skill 安装定向消息
- [ ] agent 回复 "✅ skill 已安装" 后 capabilities 更新为含 coagenthub-executor/coordinator
- [ ] 首次下发任务（群有 projectPath）时，缺失文档返回 warning
- [ ] pnpm test 全绿、check-types 通过、build 通过

## 5. 不涉及的改动

- 不修改 skill 文件内容（coordinator/executor/bugfix）
- 不修改 Skill 安装 API（GET /api/skills）
- 不修改前端
- 不引入新的 npm 依赖

## 6. 兼容性

- 任务书精简不影响已有执行器（skill 触发提示替代完整流程）
- 加群自动发消息仅对新增成员生效，不影响既有成员
- capabilities 更新幂等（重复安装不会重复追加）
- 初始化检查不阻塞消息发送（仅返回 warning）
