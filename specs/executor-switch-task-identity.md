# Spec: 换执行器产生的多条任务,与「一次工作」的关系没有被记录

> **状态**: Landed — L3 通过(2026-08-24),实现 `2bb6a961`
> **版本**: 1.0
> **日期**: 2026-08-24
> **发现于**: 用户提问「换执行器不是应该在同一个任务里吗,为什么新开了一个任务」

## 背景:两条重试路径,行为不一致

执行器不可用(限额、挂死、失败)时,平台有两条完全不同的处置路径:

| 路径 | 机制 | 结果 |
|---|---|---|
| **平台自动重试** | `retry.maxRetries` + `resetWorkspace`,`switchExecutor: false` | **同一条 task 行**,`retryCount++`,**不换执行器** |
| **协调者按 skill §2.2 换人** | 协调者判断后重新调下发接口 | **新建一条 task 行**,与原任务**无任何关联字段** |

协调者 skill §2.2 写的是「有空闲的就把**同一张票**原样交给它 —— 任务书内容、
`specRef`、`specHash` 全不变,只换执行目标」。

但「同一张票」是**工作项**意义上的同一张,落到数据上是**互不相识的两条 task 行**。
它们之间没有 `supersedes`、没有 attempt 分组键,只能靠 `specRef` 相同来猜 ——
而同一个 spec 本来就可能有多张合法的票(拆票、修正票、返工票)。

## 为什么这是问题,不只是不优雅

### ① 它污染刚落地的 L1 聚合

`specs/reviewer-needs-no-executor-visibility.md` 落地的 `l1.childCount` 数的是
子任务条数。换过一次执行器 → `childCount: 2`,但**实际只有一次成功执行**。

而 `specs/coordination-close-integrity.md` 的 R1 只检查「有没有子任务」,
不检查「有几次是真跑成的」。**检视者看到 `childCount: 2` 无法判断这是
「拆成两个子任务并行做」还是「换了一次执行器」** —— 两者的验收含义完全不同。

### ② 排障时看不出因果

本轮真实发生过:CodeBuddy 卡死 → 被清理 → 同一工作换 AtomCode 重跑。事后翻库
只能看到两条孤立的 task,谁是谁的替代、为什么换,全在群消息里靠人读。

### ③ `attempts` 字段已经是「多次尝试」的概念,却只覆盖了自动重试

task 表已有 `attempts: TaskAttempt[]`,记录同一条 task 内的多次尝试。
**换执行器这种"更换执行方的尝试"落在它之外**,同一个概念被切成两半。

## 决策:保留多行,但记录它们的关系

**不采用「换执行器复用同一 task 行」的方案。** 理由:

- 每次尝试的 `outputTail`、`checkpointRef`、时间线、`claimVerification` 都是独立的
  排障材料,复用一行会把它们覆盖掉;
- 本轮排障多次依赖「那次卡死的执行留下了什么」,这是真实价值;
- `executor_participant_id` 是 task 的核心身份之一,原地改会让历史记录失真。

改为**记录替代关系**,让消费方能把多条尝试收敛成一次工作。

### R1. task 新增 `supersedesTaskId`

```ts
supersedesTaskId: uuid("supersedes_task_id").references((): AnyPgColumn => task.id),
```

- 可空。缺省 `null` = 这不是任何任务的替代。
- 新建迁移。**不加索引**(当前无按此列查询的需求)。
- 语义:**本任务替代 `supersedesTaskId` 所指的那次尝试**,两者是同一工作项的
  先后尝试。

### R2. 下发接口接受该字段

`POST /groups/:id/tasks` 与消息自动派发路径(`maybeDispatchExecutorTask`)
均接受可选 `supersedesTaskId`,**照抄 `dispatchKind` 的现有实现**
(zod 可选 → 解构 → 落库 → 列表/详情透出),不要另造模式。

被指向的任务必须**属于同一群组**,否则 400。**不校验**它是否已终态 ——
协调者可能在原任务仍 running 时就决定替代(例如已确认执行器挂死)。

### R3. `l1` 聚合按「有效尝试」计数

`lib/l1-aggregate.ts` 的 `childCount` 改为**排除已被替代的子任务**:
若子任务 A 被子任务 B 以 `supersedesTaskId = A` 替代,则 A 不计入 `childCount`。

同时新增 `supersededCount`,如实透出被替代的次数:

```json
"l1": { "childCount": 1, "supersededCount": 1, "status": "done", "allTerminal": true }
```

理由:检视者需要知道「这次工作实际由几个子任务完成」(childCount),
也需要知道「中途换过几次」(supersededCount)——后者是质量信号,不该被抹掉。

**仍不含执行器身份**(`reviewer-needs-no-executor-visibility` R1 不变)。

### R4. 协调者 skill 补一句用法

`skills/coordinator/SKILL.md` 的 §2.2 限额处置段,在「把同一张票原样交给它」
之后补充:**下发时带 `supersedesTaskId` 指向被替代的那条任务**。

⚠️ **这是本轮唯一一处允许改 skill 的地方**,因为新增了一个协调者必须主动使用的
下发参数 —— 结构层给了字段,说明层必须告诉它怎么用。其余段落不动。

### R5. 不做这些

- **不改** `attempts` 字段的语义与写入逻辑
- **不改**平台自动重试(`switchExecutor: false` 保持)
- **不回填**历史数据
- **不改**前端
- **不**基于 `supersedesTaskId` 做任何拦截或强制

## 验收标准

- [ ] `task` 表有 `supersedes_task_id` 列,可空,外键指向 `task.id`
- [ ] 迁移文件存在,且**已对本地运行中的库执行**并贴出输出
- [ ] `POST /tasks` 与消息自动派发路径均接受 `supersedesTaskId` 并落库
- [ ] 指向**跨群**任务 → **400**
- [ ] 指向仍 `running` 的同群任务 → **放行**(R2 明确不校验终态)
- [ ] 不传时落 `null`,列表与详情均透出该字段
- [ ] `l1.childCount` **排除**被替代的子任务
- [ ] `l1.supersededCount` 如实反映被替代次数
- [ ] `l1` 仍**不含**任何执行器身份字段(回归,必测)
- [ ] 无替代关系时 `l1` 行为**与改动前完全一致**(回归,必测)
- [ ] 协调者 skill §2.2 补充了 `supersedesTaskId` 的用法,**其余段落未改动**
- [ ] 后端测试全绿,贴出用例数
- [ ] **未改动**前端、`attempts` 逻辑、自动重试策略

## 不涉及

- 换执行器复用同一 task 行(已否决,理由见「决策」)
- 基于替代关系的任何强制或拦截(R5)
- 前端展示 `supersededCount`(另开票)
- 历史数据回填(R5)

## 执行环境提示

- 本仓 pnpm 项目,后端 `:3001`
- 迁移命令需要 `DATABASE_URL` 已导出
- 改完重启后端;重启前确认无 running/queued 任务;验收前用 `ps -o lstart=`
  确认监听进程启动时间晚于本次提交
