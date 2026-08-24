# Spec: 任务书模板对角色视而不见 —— 协调者收到的是执行器任务书

> **状态**: Landed — L3 通过(2026-08-24),实现 `94721245`
> **版本**: 1.0
> **日期**: 2026-08-24
> **严重度**: 阻断性 —— **三层协作模型从未真正运行过**

## 背景:一条从来没跑通过的链路

用户观察到前端需求列表里「没有一条走完三层」。查证后确认属实,而且根因不在前端。

### 现象

对全部 29 条任务查询三层状态,`[L1, L2, L3]`:

```
dispatch-kind-field          → pending, done, done
身份修复票                    → done,    pending, pending
后续 11 张串行票              → pending, pending, done
```

**L1 恒为 pending。** 数据库确认:`parent_task_id` **全部为 null** —— 从来没有
任何执行任务子行被创建过。

### 根因

`lib/executor-task/queue.ts:2049` 的任务书模板**硬编码**:

```ts
`## 执行方式`,
`本任务按 \`coagenthub-executor\` skill 执行。`,
`- 已安装:直接按 skill 流程执行(读规范→写代码→测试→Code Review 自检→汇报)。`,
`- 未安装:先 GET /api/skills/executor 获取 skill 内容,安装到 skills 目录后执行。`,
```

**它不读目标参与方在本群的角色。** 于是群内角色为 `coordinator` 的 Codex,
每次收到的都是一张**执行器任务书**,被明确告知「读规范→写代码→测试→自检→汇报」。

它照做了 —— **它没有违反纪律,它在正确执行平台给它的指令。**

### 证据

协调者最近一次执行的 36KB `outputTail` 全文检索:

| 关键词 | 命中 |
|---|---|
| `dispatch` | **0** |
| `AtomCode` | **0** |
| `CodeBuddy` | **0** |
| `执行器` | **0** |

它从头到尾没有**考虑过**派发。`coagenthub_dispatch_task` MCP 工具是可用的
(`~/.codex/config.toml` 有 `[mcp_servers.coagenthub]`),不是能力缺失。

**反证**:第一张票(`dispatch-kind-field`)的 `diffSummary` **带了**
`review_request` 结构化载荷,因为检视者在任务书正文里手写了
「PATCH 本任务为 done,`diffSummary` 带 `review_request` 载荷(skill §4.2)」。
**任务书正文里写了的它就做,写在 skill 里没在任务书重复的它就不做** ——
因为模板告诉它自己是执行器,它没有理由去读协调者 skill。

### 后果

三层模型的实际形态与设计完全不同:

| 层 | 设计 | 实际 |
|---|---|---|
| **L1 执行** | 执行器实现 + 自检 | **不存在**(无子任务,永远 pending) |
| **L2 协调** | 协调者对照 spec 做功能检视 | 协调者检视**自己刚写的代码** |
| **L3 检视** | 检视者做架构检视 | 唯一真实发生的一层 |

「协调者检视自己写的代码」正是 §3.14.6 花大力气论证要消灭的**自审** ——
它以另一种形式一直在发生。AtomCode 与 CodeBuddy 自接入以来**从未执行过任何任务**。

---

## 要求

### R1. 任务书模板按目标参与方的群内角色选择 skill

`buildTicket`(`queue.ts:2030` 附近)已经能拿到 `groupPrompt`(含
`groupPrompt.roles`,见同函数末尾「本群分工」段)。据此选择:

| 目标在本群的角色 | 任务书写什么 |
|---|---|
| 含 `coordinator` | `coagenthub-coordinator` skill + `GET /api/skills/coordinator` |
| 含 `executor`(且不含 coordinator) | `coagenthub-executor` skill(现状不变) |
| 两者都不含 | **保持现状的 executor 措辞**,并在汇报格式段前加一行提示说明角色不匹配 |

⚠️ **`groupPrompt` 当前只在成员有 `prompt` 时才被传入**(见该段的 `if`)。
本票需要让角色信息**无条件可得** —— 角色是任务书的必需输入,不能依赖分工提示词
是否填写。改动 `groupPrompt` 的取数逻辑或另取一次成员角色皆可,由执行者判断,
但**不得**让「成员没填 prompt」导致任务书退回硬编码 executor。

### R2. 协调者任务书要带上它必须回写的契约

协调者任务书的「汇报格式要求」段与执行器不同。协调者必须:

- PATCH 自己这条 detached 任务为终态
- `diffSummary` 带 `review_request` 结构化载荷(spec §3.10 / coordinator skill §4.2)

**这两条要写进模板**,不能指望每次由检视者在任务书正文里手写 —— 本次事故
证明了「写在 skill 里但没在任务书里重复」等于不存在。

### R3. 不改 skill 文件本身

四个 skill 的内容**不动**。本票只修「平台发给谁哪份任务书」。

### R4. 不改前端

L1/L2/L3 的前端判定逻辑是对的 —— 它如实反映了「没有子任务 = L1 未发生」。
修好本票后前端会自然显示正确状态。**不要为了让界面好看去改前端判定。**

---

## 验收标准

- [ ] 向群内角色含 `coordinator` 的参与方下发任务,生成的任务书写的是
      `coagenthub-coordinator` skill,不是 executor
- [ ] 向群内角色为 `executor` 的参与方下发,任务书与改动前**完全一致**(回归)
- [ ] 目标成员**没有填写 `prompt`** 时,角色判定仍然正确(不退回硬编码 executor)
- [ ] 协调者任务书的汇报要求段包含「PATCH 自身任务为终态」与
      「`diffSummary` 带 `review_request` 载荷」两条
- [ ] 单元测试覆盖:coordinator 角色 / executor 角色 / 无 prompt 的 coordinator /
      两者都不含的兜底,**四条都要有**
- [ ] 后端测试全绿,贴出用例数
- [ ] **未改动** `skills/` 下任何文件
- [ ] **未改动**前端

## 不涉及

- skill 文件内容(R3)
- 前端三层判定(R4)
- 让协调者「必须有子任务才能结案」的强制校验 —— 那是另一张票
  (`specs/coordination-requires-execution.md`),本票先让它**收到正确的指令**,
  再谈强制

## 执行环境提示

- 本仓 pnpm 项目,后端 `:3001`
- 改完需重启后端;重启前确认无 running/queued 任务
- **本票由协调者自己执行时会遇到一个尴尬**:它现在收到的仍是旧模板(执行器任务书)。
  这是可接受的 —— 改好之后**下一张**票才会生效。不要试图在本票内自举
