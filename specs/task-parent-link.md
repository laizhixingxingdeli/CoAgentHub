# Spec: 任务图缺一条边 —— `parentTaskId`

> **状态**: Landed — L2 + L3 均通过(2026-08-23)
> **版本**: 1.0
> **日期**: 2026-08-23
> **上游**: `specs/reviewer-role-spec-generation.md` v3.9
> **下游**: 消息归属改造依赖本票，先做本票再做那票

## 背景

`task` 表(`packages/backend/database/src/schema/task.ts`)有 `groupId`、`messageId`、
`specRef`、`dispatcherParticipantId`,**但没有任何父子链接字段**。

于是:**协调者那条 detached 任务,与它派出去的执行器任务之间,数据库里没有关联。**

### 这不是洁癖,是实测吃过的亏

- 做 L3 时,我只能靠**时间接近 + 内容相似**去猜「哪几张票是这一轮派的」
- 前端 L3 虚拟节点的推导(`RequirementDetailPanel.tsx` 的 `deriveL3State`)
  要靠「找一个执行者是 coordinator 且 diffSummary 含 review_request 的任务」
  这种间接特征去认亲
- 需求时间线的消息归属(`merge-requirement-timeline.ts`)退化成
  「触发消息 + 回复子树 + **时间窗兜底**」,代码注释自己写明了局限:
  「多条需求在同一时间窗内并行推进时,别的需求的广播消息可能被误归」——
  实测三个群并行时确实会串

**这些都是在绕过同一条缺失的边。** 补上它,上述推导从启发式变成查询。

---

## 要求

### R1. `task` 表新增 `parentTaskId`

- 字段名 `parentTaskId` / 列名 `parent_task_id`,`uuid`,**可空**
  (顶层任务无父;历史数据全为 null)
- 自引用外键指向 `task.id`(参考同表 `groupMessage.parentId` 的自引用写法:
  `references((): AnyPgColumn => task.id)`)
- **需要 SQL 迁移**(与 `attempts` 那种 jsonb 加字段不同,这是真的加列)
- 加索引:按 `parentTaskId` 查子任务是本票的主要查询模式

### R2. 下发时自动填充

任务由「定向消息触发」创建(`routes/group/messages.ts` 的任务创建路径)。
发送者若**自身正在执行某个任务**,则新任务的 `parentTaskId` = 发送者那条任务的 id。

- 判定方式自行设计。可用信号:发送者 participant 在本群有 `status = running`
  的任务(协调者的 detached 任务正是这个状态——见 v3.9 §3.18.3,
  协调任务 spawn 后保持 running 直到显式 PATCH)
- 有多条 running 时的取舍自行判断并**在汇报里说明**
  (正常情况下 `maxConcurrency: 1` 保证只有一条)
- 判定不出来时 `parentTaskId` 留 null,**不要猜、不要报错**——
  顶层任务本来就该是 null

### R3. 查询与响应

- `GET /groups/:id/tasks` 与 `GET /groups/:id/tasks/:taskId` 的响应带上 `parentTaskId`
- **不要**在本票里改前端(前端改造是下游独立票)
- **不要**新增「查子树」的专用端点——前端拿到全量任务列表后自己组树即可,
  本票只保证边存在

---

## 验收标准

- [ ] `task` 表有 `parent_task_id` 列,可空,自引用外键,有索引
- [ ] 迁移脚本存在且可正向执行;历史数据 `parentTaskId` 为 null,不受影响
- [ ] 协调者下发的执行器任务,`parentTaskId` 指向协调者自己那条 detached 任务
- [ ] 检视者直接下发的任务(检视者不在执行任务中)`parentTaskId` 为 null
- [ ] 两个 GET 端点响应含 `parentTaskId`
- [ ] 判定策略与多条 running 时的取舍已在汇报中说明
- [ ] 新增测试覆盖:有父的情况、无父的情况、历史数据不受影响
- [ ] `pnpm --filter server test` 全绿(先跑一次确认基线,不得减少)
- [ ] `docs/architecture.md` §3 数据模型表同步(新增列)

## 不涉及

- **不改**前端(下游独立票)
- **不改** `messageId` 的既有语义(那是「触发消息」锚点,与父任务是两件事)
- **不做**跨群父子关系(父任务必与子任务同群)
- **不做**任务树的循环检测(下发路径天然不产生环:父必然先于子存在)
- 不引入新依赖

## 执行环境提示

- 本仓是 **pnpm** 项目,迁移用 drizzle
- 后端以 `pnpm --filter server start`(无 watch)运行中:改完需手动 build + restart
- ⚠️ 本票需要跑迁移。**先确认迁移在本地库可正向执行**再提交
- 沙箱执行器注意:需监听本地端口的测试会报 `listen EPERM`,那是环境限制不是回归


---

## L3 检视记录(2026-08-23)

**verdict: pass**，commit `6cfc84e`。L2 由协调者完成（430/430 用例），检视者复核采纳：parentTaskId 列 + 迁移 0020 + GET 暴露均在位。

⚠️ 该实现与另两票合在同一个提交里落地，违反后来立的「一票一提交」（`fc04c89`）——迁移遗漏导致 `/tasks` 全线 500 正是这次捆绑的直接后果。规则已补，历史提交不追溯拆分。
