# Spec: 任务的 token 消耗与耗时可见

> **状态**: Landed — L2 + L3 均通过(2026-08-23)
> **版本**: 1.0
> **日期**: 2026-08-23
> **协作模式**: 三层

## 背景

用户要求每个任务能看到 token 消耗与耗时。查下来管线**本来就修了一半**:

- **token**:`skills/executor/SKILL.md:132` 早就要求执行器汇报带 `Token: <count>` 一行,
  `report.ts` 也早就在解析、存进 `diffSummary.tokenUsage`(纯数字字符串,已清洗千分位逗号)。
  **但前端从未渲染过它**——全仓搜索 `tokenUsage`,只有一处类型注释提到,零组件显示。
- **耗时**:`task.attempts[]`(`TaskAttempt`)每次尝试都记了 `startedAt`/`endedAt`
  (`packages/backend/database/src/schema/task.ts:35-50`),**数据在,但没有任何地方
  算过 `endedAt - startedAt`**,`AttemptTimeline`(`TaskPanel.tsx:150`)只画状态和 hash。

## 设计决策(已与用户确认)

**token 按 attempt 记,任务级显示总和,不是只看最后一次成功的那次。**

理由:重试正是最容易让 token 消耗失控的地方。若任务重试一次,第一次失败前烧了
5000、第二次成功烧了 3000,只显示 3000 会把重试的隐藏成本藏起来——而"token 消耗
可见"这个需求的意义很大程度上就是防这个。

⚠️ **这不需要 SQL 迁移**:`attempts` 是 `jsonb` 类型(`task.ts:77-80`),
给 `TaskAttempt` TypeScript 接口加一个可选字段是纯类型层改动,drizzle 不对 jsonb
做运行时 shape 校验。**不要为此写迁移脚本**,那是不必要的工作量。

---

## 要求

### R1. 每个 attempt 各自记 token

- `TaskAttempt`(`packages/backend/database/src/schema/task.ts:35-50`)新增可选字段
  `tokenUsage?: string`(格式与现有任务级字段一致:纯数字字符串,不带千分位逗号)
- `endAttempt`(`queue.ts:1471`)的 `patch` 类型
  `Partial<Pick<TaskAttempt, "status" | "error" | "summary" | "hash">>`
  需要把 `tokenUsage` 也加进 `Pick` 列表
- 调用 `endAttempt` 时,若本次完成有解析到的 `report.tokenUsage`(`report.ts` 已经在解析),
  一并传入。**失败路径不强求**:执行器崩溃前不一定来得及吐出格式规范的 token 行,
  解析不到就不写这个字段,不要因为拿不到而报错或重试

### R2. 任务级 `diffSummary.tokenUsage` 改为跨 attempt 总和

- 任务终态时,`diffSummary.tokenUsage` 写入**该任务所有 attempt 的 `tokenUsage` 之和**
  (逐个转 int 相加,任一 attempt 缺失该字段则跳过,不视为 0 也不视为报错)
- 全部 attempt 都没有 `tokenUsage` 时,`diffSummary.tokenUsage` 不写入
  (维持现有"没数据就不写"的风格,不要写 `"0"` 制造假精确)
- **既有字段名不变**:消费方(如果以后有)按 `diffSummary.tokenUsage` 取的仍是任务级总数,
  只是语义从"最后一次"变成"总和"——这是本票的核心变化

### R3. 耗时:每次 attempt 自己的用时 + 任务整体总耗时

**不需要新增任何存储**,`startedAt`/`endedAt` 已经有了,纯前端计算:

- **单次 attempt 耗时**:`endedAt - startedAt`。`endedAt` 缺省(该 attempt 仍在 running)时,
  用当前时间实时算,格式与其余「运行中」状态一致(比照 `RequirementTimeline` 里
  running 任务已有的实时更新模式,不要另起一套)
- **任务整体耗时**:从 `task.createdAt` 到终态时刻(`task.updatedAt`,任务转
  done/failed/cancelled 时会更新)。这个口径**包含排队等待与重试之间的间隔**,
  不是单纯把各 attempt 耗时相加——用户想知道的是"这个任务从发起到有结果花了多久",
  不是"cpu 时间"
- 格式化规则自定,但要求:秒级用 `Xs`,分钟级用 `Xm Ys`,不要出现裸毫秒数或
  ISO 时间戳直接展示给用户

### R4. 前端两处展示位置都要接

这两处是同一份数据的两个消费面,都得接,不要只做一处:

- **`RequirementTimeline.tsx`**(主路径,需求详情时间线里的任务卡片):
  在现有 `测试`/`遗留` 那几行旁边加 token 与耗时,折叠态/展开态的呈现层级
  自行判断,但**不要占据比 `测试` 那行更显眼的位置**——这是补充信息,不是主角
- **`AttemptTimeline`**(`TaskPanel.tsx:150`,无需求回退路径复用的同一组件,
  `requirement-workspace.tsx:374` 仍在渲染 `<TaskPanel>`,**不是死代码**):
  每次 attempt 旁边加上该次的耗时,格式与上面一致

### R5. 没有数据时不占位

- 任务/attempt 没有 `tokenUsage` 时,**不显示该字段**,不要显示"token: -"这类占位符
- 耗时理论上总是能算(只要有 `startedAt`),不会缺失,不需要处理"无耗时数据"的情况

---

## 验收标准

- [ ] `TaskAttempt` 新增 `tokenUsage?: string`,无 SQL 迁移
- [ ] `endAttempt` 能把解析到的 token 写进对应 attempt
- [ ] 任务终态时 `diffSummary.tokenUsage` 是所有 attempt 之和,不是最后一次的值
- [ ] 全部 attempt 都无 token 数据时,`diffSummary.tokenUsage` 不写入
- [ ] `RequirementTimeline.tsx` 展示 token(有数据时)与耗时(每次都有)
- [ ] `AttemptTimeline`(`TaskPanel.tsx`)同样展示,两处口径一致
- [ ] running 中的 attempt 耗时会实时更新,不是定格在 spawn 那一刻
- [ ] 任务整体耗时 = createdAt 到终态时刻,不是各 attempt 相加
- [ ] 新增测试覆盖:多 attempt 求和、部分 attempt 缺 token、全部缺 token 不写字段、
      running 中 attempt 的耗时计算
- [ ] `pnpm --filter server test` 全绿(先跑一次确认基线,不得减少)
- [ ] `pnpm --filter @laizhixingxingdeli/web test` 全绿
- [ ] `pnpm --filter @laizhixingxingdeli/web build` 通过

## 不涉及

- **不改** `skills/executor/SKILL.md` 的汇报格式——`Token:` 那行早就在要求了,
  本票是把已经在收集的数据接到前端,不是新增汇报字段
- **不改** `report.ts` 的 token 解析规则(`cleanTokenValue` 已经在用)
- **不做**输入/输出 token 拆分显示(现状是单一总数,拆分是另一个更大的话题,
  执行器汇报格式目前也只有一个数字)
- **不做** SQL 迁移(见背景说明)
- 不引入新依赖

## 执行环境提示

- 本仓是 **pnpm** 项目
- 后端当前以 `pnpm --filter server start`(无 watch)运行中:
  改完后端代码需手动 build + restart 才生效,跑测试不受影响
- 前端可实测:`http://localhost:5173/groups/01a029c4-b67f-737d-837e-e49933fd3e38`
  (有真实任务数据;但历史任务大概率没有 `tokenUsage`,只能验证「不占位」这条,
  验证有数据的展示需要真跑一次新任务或用测试 mock)
- 沙箱执行器注意:需监听本地端口的测试会报 `listen EPERM`,那是环境限制不是回归;
  全量由协调者代跑


---

## L3 检视记录(2026-08-23)

**verdict: pass**,commit `0f97532`。

检视者独立核实 `sumAttemptTokenUsage`(`types.ts`)与 `test/executor-report-quota.test.ts:348-351`:

```
[5000, 无, 3000] → "8000"      求和,跳过缺失的 attempt
[无, 无]         → undefined    省略字段,**不是写 "0"**
```

这正是 spec 的两条关键要求:任务级 tokenUsage 是**所有 attempt 之和**(不是最后一次),全部缺失时**不制造假精确**。耗时展示与运行中实时更新的测试也在位。
