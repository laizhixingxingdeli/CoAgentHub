# Spec: 服务端固化执行器流程协议 (Executor Protocol in Task Ticket)

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-18
> **依赖**: buildTicket Code Review 自检段已存在（commit 28c4757）

## 1. 背景与目标

当前执行器 Skill（skills/executor/SKILL.md）包含完整执行流程：
读 Spec → 写代码 → 测试 → Code Review 自检 → 汇报。

但 Skill 需要预先加载到执行器 agent 上。如果执行器没有加载 skill，
仅靠任务书中的 Code Review 自检段，缺少"先读 Spec、再测试、再自检"的流程引导。

**目标**：把 executor skill 的核心流程固化为任务书模板的一部分。
执行器只要读任务书，就能按完整协议执行，不需要预先加载任何 skill 文件。

## 2. 改动范围

**文件**: `packages/backend/server/src/lib/executor-task/queue.ts`
**函数**: `buildTicket`

在任务书模板中，新增「## 执行流程（必读）」段，
插入位置：在「## 任务内容」之后、「## 汇报格式要求」之前。

## 3. 详细改动

### 3.1 新增「执行流程」段

在 buildTicket 的 lines.push 序列中，任务内容 push 之后、汇报格式要求 push 之前，
插入以下内容：

```markdown
## 执行流程（必读）
请严格按以下顺序执行：
1. **读规范**：如任务书含「📜 关联规范」段，先读取该 Spec 文档，理解验收标准后再动手。
2. **写代码**：按 Spec 和任务内容实现。遵循项目代码规范（.cursorrules / biome.json / AGENTS.md）。
3. **跑测试**：运行项目测试套件（pnpm test / check-types / build），确保全部通过。
4. **自检**：完成下方「Code Review 自检」段，逐项检查后再提交。
5. **提交**：测试全绿 + 自检通过后，git add + commit，commit message 按功能写。
6. **汇报**：按「汇报格式要求」输出结果，包含 Code Review 自检结果。
```

### 3.2 实现方式

在 buildTicket 函数中，找到现有代码：

```typescript
lines.push(
  `## 任务内容`,
  body,
  `## 汇报格式要求(stdout 请按此输出)`,
  ...
);
```

改为：

```typescript
lines.push(
  `## 任务内容`,
  body,
  `## 执行流程（必读）`,
  `请严格按以下顺序执行：`,
  `1. **读规范**：如任务书含「📜 关联规范」段，先读取该 Spec 文档，理解验收标准后再动手。`,
  `2. **写代码**：按 Spec 和任务内容实现。遵循项目代码规范（.cursorrules / biome.json / AGENTS.md）。`,
  `3. **跑测试**：运行项目测试套件（pnpm test / check-types / build），确保全部通过。`,
  `4. **自检**：完成下方「Code Review 自检」段，逐项检查后再提交。`,
  `5. **提交**：测试全绿 + 自检通过后，git add + commit，commit message 按功能写。`,
  `6. **汇报**：按「汇报格式要求」输出结果，包含 Code Review 自检结果。`,
  `## 汇报格式要求(stdout 请按此输出)`,
  ...
);
```

### 3.3 不修改其他部分

- 不修改 Code Review 自检段（已存在）
- 不修改 Spec 引用段（已存在）
- 不修改执行与测试要求段（已存在）
- 不修改默认约束段（已存在）

## 4. 验收标准

- [ ] buildTicket 输出包含「## 执行流程（必读）」段
- [ ] 执行流程段包含 6 步：读规范→写代码→跑测试→自检→提交→汇报
- [ ] 插入位置正确（任务内容之后、汇报格式要求之前）
- [ ] 不传 specRef 时行为不变（执行流程段始终输出）
- [ ] pnpm test 全绿、check-types 通过、build 通过

## 5. 不涉及的改动

- 不修改 executor skill 文件（skill 仍保留，作为增强）
- 不修改协调者/bugfix skill
- 不修改插件
- 不引入新依赖

## 6. 兼容性

- 任务书模板新增一个段落，对所有任务生效（包括旧任务重试）
- 执行器如果已加载 skill，流程一致，无冲突
- 纯 CLI 执行器忽略该段，不影响执行
