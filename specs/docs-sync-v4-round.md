# Spec: 本轮 13 张票的文档同步补齐

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-24

## 背景

本轮(2026-08-24)落地 13 张票,改动涉及数据模型、API、配置与领域概念。协调者
skill 的 doc-sync-checklist 是**逐票检查**的,跨票的整体缺口没人负责 ——
实测确认已经漏了:

| 应记录项 | `docs/architecture.md` | 说明 |
|---|---|---|
| `dispatch_kind` / `dispatchKind` | **0** | 数据模型 + API 均未记录 |
| `l3ResponseMinutes` | **0** | 配置项未记录 |
| `supersedes_task_id` | 1 | 已记录 |
| `skills/:name/digest` | 1 | 已记录 |
| `maxConcurrentPerWorkspace` | 1 | 已记录 |

`CONTEXT.md` 的领域词汇表(§「领域词汇」)**一个本轮新概念都没有**:
「编制」「工作类型」「替代关系」全部缺失。

## 要求

### R1. `docs/architecture.md` §3 数据模型

补齐 task 表本轮新增的两列:

- `dispatch_kind`(`requirement` | `fix`,可空)—— 记录检视者的**工作类型分流结果**
- `supersedes_task_id`(uuid,可空,自引用)—— 已记录则核对描述是否准确

**说明 `dispatch_kind` 不是模式字段**:模式(编制)由群成员构成实时推导、不落字段
(spec §3.14.1);`dispatch_kind` 记录的是逐票的工作类型,与编制正交。
这一条必须写明,否则后来者会以为平台开始持久化模式了。

### R2. `docs/architecture.md` §4 API 全貌

补齐/核对本轮的接口与载荷变化:

- `POST /groups/:id/tasks` 与 `POST /groups/:id/messages` 接受 `dispatchKind`、
  `supersedesTaskId`
- `GET /groups/:id/tasks/:taskId` 派生字段 `l1`(`childCount` / `supersededCount` /
  `status` / `allTerminal`)与 `l3`(`answered` / `verdict` / `awaitingSince` /
  `overdue`)—— 并注明**两者都只在目标是协调任务时输出**,非协调任务不含该字段
- `GET /api/skills/:name/digest`(核对已有记录是否完整)
- `GET /groups/:id/messages` 的 `limit` 参数

### R3. `docs/architecture.md` 配置项

补 `l3ResponseMinutes`(缺省 120),核对 `maxConcurrentPerWorkspace`(缺省 1)。
若 architecture 无配置章节,**放在最合适的既有小节**,不要为此新开一章。

### R4. `CONTEXT.md` 领域词汇表补三个概念

按现有表格格式追加:

| 术语 | 要点 |
|---|---|
| **编制(三方 / 两方)** | 由群成员构成**实时推导**:reviewer 与 coordinator 同时在场 = 三方,否则两方。**不落平台字段**。决定「谁来干」,不决定「跑几层」 |
| **工作类型(需求 / 修复)** | 逐票由检视者分流,落 `dispatchKind`。决定要不要新写 spec、**要不要跑 L3**。与编制**正交** |
| **替代关系** | `supersedesTaskId`:换执行器时新任务指向被替代的那次尝试。多行保留完整现场,`l1.childCount` 只算有效尝试,`supersededCount` 透出换过几次 |

⚠️ **「三层 / 两层」与「三方 / 两方」是两个不同的轴**,词汇表里要说清 ——
前者是检视深度(由工作类型决定),后者是编制(由成员构成决定)。本轮之前
这两个词被混用,正是 §3.14.6 修正的对象。

### R5. 只补文档,不动代码

**不得**改动任何 `.ts` / `.mjs` / `.sql` / `skills/` 文件。本票纯文档。

### R6. 不新增 ADR

本轮的架构决策已写在各自 spec 里(尤其 §3.14.6 / §3.14.7)。**不要**为本票
另写 ADR —— 那会制造第二份会漂移的事实来源。

## 验收标准

- [ ] `architecture.md` §3 含 `dispatch_kind` 与 `supersedes_task_id`,描述准确
- [ ] 明确写明 `dispatch_kind` **不是**模式字段,模式仍由成员构成推导、不落字段
- [ ] `architecture.md` §4 含 `dispatchKind` / `supersedesTaskId` 入参
- [ ] §4 含 `l1` 与 `l3` 派生字段,并注明**仅协调任务输出**
- [ ] §4 含 `GET /groups/:id/messages` 的 `limit` 参数
- [ ] 配置项含 `l3ResponseMinutes`(120)与 `maxConcurrentPerWorkspace`(1)
- [ ] `CONTEXT.md` 词汇表新增「编制」「工作类型」「替代关系」三条
- [ ] 词汇表说清「三层/两层」与「三方/两方」是两个不同的轴
- [ ] **未改动**任何代码文件(`git diff --stat` 只含 `.md`)
- [ ] **未新增** ADR

## 不涉及

- 代码改动(R5)
- 新增 ADR(R6)
- `skills/` 内容

## 执行环境提示

- 纯文档票,无需重启后端,无需跑测试
- `architecture.md` 已有既定小节结构(§0 命名约定 / §1 概览 / §2 代码结构 /
  §3 数据模型 / §4 API 全貌 / …),**按既有结构补,不要重排**
- `CONTEXT.md` 的词汇表在「## 领域词汇(ubiquitous language)」下,是 markdown
  表格,**沿用同款两列格式**
