# Spec: 仓库初始化归检视者,不再由协调者代劳

> **状态**: Frozen — 待实现
> **版本**: 1.0
> **日期**: 2026-08-28

## 现状:职责放反了,且两边互相指

```
skills/coordinator/SKILL.md:25   §0 项目初始化 —— 协调者负责创建
                                 AGENTS.md / CONTEXT.md / docs/adr/ / specs/ / .cursorrules
skills/reviewer/SKILL.md:99      「若 Matt 脚手架缺失,请协调者去初始化
                                  —— 不要自己建,不要覆盖既有文档」
```

## 决策:初始化与文档所有权同归检视者

此前已确立**文档归检视者**(三层与两层皆然;协调者与执行器均无文档所有权,
见 `coordinator/SKILL.md` 文档同步检查一节的后续修订)。
仓库初始化产出的正是这批文档 —— `AGENTS.md`(领域词汇/工作规范)、
`CONTEXT.md`(项目上下文/词汇表)、`docs/adr/`(架构决策)、`specs/`(冻结规范)——
**与检视者的日常职责完全重合**,由协调者代劳既割裂所有权,也让「谁该维护」变模糊。

### R1 — 检视者技能:承接初始化职责

`skills/reviewer/SKILL.md` 增加「项目初始化」一节,内容承接
现 `coordinator/SKILL.md` §0 的 `<bootstrap-checklist>` 清单
(AGENTS.md / CONTEXT.md / docs/adr/ / specs/ / .cursorrules 或等效)。

⚠️ 保留原有两条约束,**逐字不放宽**:
- 已存在的文档**不得覆盖**
- 缺失才创建,已齐全则跳过

### R2 — 协调者技能:移除 §0,改为「缺失则回报检视者」

删除 `coordinator/SKILL.md` 的 §0 项目初始化及其 `<bootstrap-checklist>`。
改为:发现脚手架缺失时**回报检视者**,由检视者初始化后再继续,
协调者**不得自行创建**。

⚠️ 不得让协调者「顺手建一个」——那正是当前所有权模糊的来源。

### R3 — 修正 `reviewer/SKILL.md:99` 的反向指向

现文「ask the coordinator to initialize it first — do NOT self-create it」
与本决策直接冲突,**必须改写**为:检视者自行初始化。

### R4 — ⚠️ 冷启动次序必须写清

初始化发生在**任何 spec 与派发之前**。技能文本需明确:
检视者在接到第一个需求时,先确认脚手架齐全,缺则先建、再写 spec。
⚠️ 不得出现「等协调者派一张初始化票给检视者」这类循环依赖 ——
初始化是检视者的**自发动作**,不需要派发。

### R5 — ⚠️ 范围限制

只改两份技能文本(`skills/reviewer/SKILL.md`、`skills/coordinator/SKILL.md`)。
不改服务端代码,不改结案守卫,不改现有文档内容本身。

## 验收要点

- `coordinator/SKILL.md` 中 §0 项目初始化与 `<bootstrap-checklist>` 已移除,
  替换为「回报检视者」的表述(贴出前后片段)
- `reviewer/SKILL.md` 中已有对应的初始化小节,清单条目与原 §0 一致(贴出片段)
- `reviewer/SKILL.md:99` 的「ask the coordinator to initialize」已改写(贴出前后)
- 「不覆盖既有文档」「缺失才创建」两条约束在新位置**逐字保留**(R1)
- 冷启动次序有明确表述,且**不存在**「初始化需先被派发」的循环(R4)
- 两份技能文本之外**无其他文件改动**(R5,贴 `git diff --stat`)

## 注意

⚠️ 本票**必须下发给执行器**完成,**不限定是哪一个**。
⚠️ 本票改的是 `skills/` 下的技能文本,**不是代码**。
⚠️ specHash 不是 commit,汇报时不要混用。
⚠️ 提交前先 `git status` 确认工作树,不要把无关的暂存文件一并提交。
⚠️ 做完记得提交。
