# Spec: 定向到检视者的消息被当成派发,平台 spawn 了检视者的 CLI

> **状态**: Landed(`68ad401b`,2026-09-08 检视者 L3 通过)
> **版本**: 1.0
> **日期**: 2026-09-08
>
> **L3 收口记录(检视者独立复核)**:
> - **基线自行复跑**:`8 failed | 42 passed (50)`,与汇报逐字一致;
>   改前 `8 failed | 39 passed (47)` —— 失败数未增加,新增 3 条用例全绿。
> - **「改前红」证据**:执行者给出实际报错
>   `expected 'SPEC_HASH_MISSING' to contain 'REVIEWER_TARGET_NOT_DISPATCHABLE'`,
>   并附**缺陷本体的真实 spawn 日志**
>   (`[executor] server 侧 spawn: codex exec …` → `spawn codex ENOENT`) ——
>   即本缺陷在测试里被复现了。
> - **判据单一出处(R2)**:`isReviewerNotDispatchableTarget` 只读
>   `group_members.roles`,不看执行器配置、不看名字。
>   `"reviewer"` 字面量与仓库既有写法一致
>   (`completion-recipient.ts:31`、`queue.ts:1756`),未引入新风格。
> - **双闸**:消息路由层拦一道 + `maybeDispatchExecutorTask` 派发层第二道,
>   避免其它入口漏过。
> - **R3 多角色**:`roles` 含 `reviewer` 即不可派;`resolveRoleTarget` 亦
>   `continue` 跳过该成员 —— 符合「宁可少派一次」。
> - **提交边界**:6 个文件全在票面范围;`DISPATCH_ALLOWED_ROLES` /
>   `findExecutorByParticipant` 未改(仅注释提及);
>   用户未提交的报告与未跟踪 `start.ps1` **未被夹带**。
>
> ⚠️ **尚未做的验证**:运行中的 server 是 18:19 构建,**不含本修复**。
> 端到端实盘验证(真发一条定向到检视者的消息,确认不建 task)
> 留到最终重建重启时做。
> **来源**: 2026-09-08 检视者监督平台运行时实测捕获,**当天发生两次**
> (`01a0804b-5f7b` failed、`01a08048-7377` cancelled)。
> **连带**: 它是 [rollback-puts-checkpoint-commit-on-head.md](rollback-puts-checkpoint-commit-on-head.md)
> 那次数据吞噬的**触发源** —— 两个缺陷连环才造成实际损失。

## 1. 背景与目标

### 1.1 现状证据

`packages/backend/server/src/routes/group/messages.ts` 的派发门判定
(第 306–322 行附近)只问一个问题:**目标 participant 是否命中执行器配置**

```ts
const isExecutorTarget =
  targetParticipant !== undefined &&
  (await findExecutorByParticipant(db, targetParticipant));
```

**它不看目标在群内的角色。**

本机实测:

| 事实 | 值 |
|---|---|
| `claude` 在群内角色 | **仅 `reviewer`** |
| `claude` 的执行器配置 | 存在(`key=claude, type=custom, bin=claude.cmd`) |
| 协调者发「已交回 L3 完整档,请查收 review_request」定向到检视者 | → 平台**建 task + spawn `claude.cmd`** |
| 结果 | `任务失败: executor pid 32712 no longer exists`(耗时 20s) |

前端因此显示「**L1 执行 ● 未通过**」——一次本该是 **L3 交接**的动作,被记成了一次
**失败的 L1 执行**。

### 1.2 这与既有约定直接冲突

`skills/coordinator/SKILL.md` §4.2 明文:

> ⚠️ **不要设置 `EXECUTOR_BIN_REVIEWER`,也不要向内置 `reviewer` 执行器下发任务。**
> 该条目存在的唯一理由是 `canDispatch`,它的 `bin` 是占位标识、**永远不该被 spawn**。
> 就算配上真实 CLI,spawn 出来的也是个**没有 spec 讨论上下文的新实例**,
> 做不了有意义的架构检视。

**约定写在 skill 里,平台却没有对应的守卫。** 只要检视者身份同时有一份执行器配置
(本机 `claude` 就是),这条约定就形同虚设 —— 协调者哪怕只是发一条说明性的定向消息,
都会触发 spawn。

### 1.3 危害

1. **无意义的 spawn**:起一个没有 spec 讨论上下文的新实例,做不了 L3;
2. **失败被记成 L1 未通过**:污染需求的检视链路展示,用户看到的是「执行失败」;
3. **连环损坏**:该失败任务进入重试 → 回滚 →
   `git reset --hard <checkpoint>` → **把用户未提交的工作变成提交**
   (见 [rollback-puts-checkpoint-commit-on-head.md](rollback-puts-checkpoint-commit-on-head.md));
4. 消耗执行器额度与工作树占用。

### 1.4 目标

**群内角色为 `reviewer` 的目标,永远不产生执行任务、永远不被 spawn** ——
无论它是否恰好也有一份执行器配置。

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/backend/server/src/routes/group/messages.ts` | 派发门增加角色守卫 |
| 或 `packages/backend/server/src/lib/executor-task/` 下的派发入口 | 若实现者判断守卫更适合放在派发层,可放那里(说明理由) |
| 对应测试文件 | 新增用例 |

**不改**:`findExecutorByParticipant` 本身;执行器配置 API;
`DISPATCH_ALLOWED_ROLES`(那管的是**谁能发**,本票管的是**谁能被派**);
`review_result` / `spec_published` 等载荷校验;控制指令通道。

## 3. 详细改动

### R1. 目标角色为 reviewer → 不建任务、不 spawn

定向消息(`audience: participant` 或 `role`)解析出的目标,若其**群内角色含
`reviewer`**,则:

- **不创建执行任务**,**不 spawn**;
- 消息本身**正常写入并广播**(它是一条正常的群内说明,不是错误);
- 在响应头 warning 里给出**可见信号**(命名自定,例如
  `REVIEWER_TARGET_NOT_DISPATCHABLE`),**不得静默跳过** ——
  静默跳过会让协调者以为交接成功。

### R2. 角色判定以群成员关系为准

判据是 `group_members.roles`,**不是**执行器配置、不是 participant 名字。
同一个 participant 在别的群里若是 executor,不受本守卫影响。

### R3. 多角色的处置

若某成员同时持有 `reviewer` 与 `executor`(当前单角色校验下不会出现,
但不要依赖这一点),**以不可派发为准** —— 宁可少派一次,也不要 spawn 检视者。
在汇报中说明你如何处理这种组合。

### R4. L3 交接不受影响

L3 的真正通道是「协调者 PATCH 自己那条 detached 任务为终态 → DB trigger 写完成
事件到检视者收件箱」,**与群消息无关**。本票**不得**改动该通道。

⚠️ 顺带记录一条**本次暴露但不在本票范围**的问题:2026-09-08 那次交接,协调者
PATCH 终态时 **`diffSummary` 里没有 `review_request` 载荷**(检视者读收件箱确认),
它是靠群消息说「已交回 L3」的。按 skill §4.2 这不构成合规的 L3 请求。
**另票处理**,本票只管不再 spawn 检视者。

## 4. 验收标准

**基线先用工具取**:

```
node scripts/test-baseline.mjs packages/backend/server test/executor-trigger.test.ts test/executor-task-role-dispatch.test.ts test/dispatcher-fields.test.ts
```

口径:**失败数不增加**。

1. **核心**:群内角色为 `reviewer` 的 participant,即使**有**执行器配置,
   定向消息给它 → **不创建任务**、**不 spawn**;消息本身正常写入;
   响应头带 warning。
   断言:请求前后 `task` 行数**不变**;消息行数 +1;warning 头存在。
   ⚠️ **改动前该用例必须是红的**(改前会建任务),给出「改前红、改后绿」对照。
2. **executor 角色不受影响**:定向到 `executor` 角色成员 → 照常建任务(回归)。
3. **coordinator 角色不受影响**:定向到 `coordinator` → 照常建任务(回归)。
4. **role 定向**:`audience: role` + `audienceRef: reviewer` → 同样不建任务 + warning。
5. **无执行器配置的 reviewer**:行为与现状一致(本来就不会建任务),不产生新错误。
6. 定向测试前后对照,失败数不增加。
7. `npx tsc --noEmit -p tsconfig.json` 通过。

## 5. 不涉及的改动

- **不删除任何执行器配置**(本机 `claude` 那条由用户自行决定去留;
  本票的守卫使它即使存在也无害)。
- **不改 L3 交接通道**(R4)。
- **不改 `review_request` 载荷缺失**的问题(另票)。
- 不改 `DISPATCH_ALLOWED_ROLES`、不改控制指令通道。

## 6. 兼容性

- 无 schema 变更,无迁移。
- 行为变更:此前会 spawn 检视者的定向消息现在只写消息 + 给 warning。
  依赖「给检视者派任务」的用法属于依赖缺陷,不予兼容(skill 本来就禁止)。
