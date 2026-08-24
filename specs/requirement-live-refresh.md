# Spec: 需求列表与详情不实时刷新

> **状态**: Landed — L3 通过(2026-08-24),实现 `cedcea61`
> **版本**: 1.0
> **日期**: 2026-08-23

## 背景

检视者下发任务后,前端的需求列表**不动**,详情面板也不动,必须手动刷新页面才看得到
新需求和状态变化。

根因在 `components/layout/context-panel/requirement-workspace.tsx`:它只订阅了两种
WS 事件:

```
181: if (event.type === "task_output")
191: if (event.type === "task_stall_alert")
```

而服务端(`ws-hub.ts`)一共推 **8 种**:

```
group_message / group_message_updated / group_message_deleted
task_output / task_stall_alert
task_status_changed / task_completion_available / task_dispatch_warning_available
```

**缺 `task_status_changed`** —— 新任务创建、queued→running、running→done/failed
全部收不到,于是列表与详情都停在页面加载那一刻。

`requirement-workspace.tsx` 同时是列表(master)与详情(detail)的父组件,任务数据
在它这里持有,**一处订阅缺口同时影响两个面**,所以是一张票。

## 要求

### R1. 订阅 `task_status_changed`

在现有 WS 事件处理里增加该分支,更新组件持有的任务集合:

- **新任务**(集合里没有该 id)→ 追加
- **已有任务**→ 就地更新其 `status` / `updatedAt` / 及事件带回的其它字段

**不要整表重拉。** 已有 `loadTasks` 的全量拉取路径保留给首屏与错误恢复,
`task_status_changed` 走增量合并——群里任务多时整表重拉会把详情面板的展开态、
滚动位置全部打断。

### R2. 增量合并要幂等且不丢序

- 同一 `taskId` 重复到达(重连后补发)不得产生重复行。
- 合并后仍满足 `group-tasks-by-spec.ts` 的顺序约定(组内按 `createdAt` 升序、
  分组按最新任务 `createdAt` 正序)。**复用现有排序,不要在合并处另写一套。**

### R3. 选中态不得被刷新打断

用户正看着某条需求的详情时,列表更新**不得**改变 `selectedRequirementId`:

- 选中的需求仍在 → 保持选中
- 选中的需求消失(理论上不会,但要防)→ 回落到「未选中」,**不要**自动跳到别的需求

### R4. 不改后端

服务端已经在推 `task_status_changed`,本票纯前端。

## 验收标准

- [ ] `requirement-workspace.tsx` 订阅 `task_status_changed`
- [ ] 新任务到达时需求列表**自动出现新行**,无需刷新页面
- [ ] 任务 queued→running→done 时,列表行与详情面板的状态**自动更新**
- [ ] 同一 taskId 的事件重复到达不产生重复行(测试覆盖)
- [ ] 合并后排序仍符合 `group-tasks-by-spec` 的约定(测试覆盖)
- [ ] 刷新期间用户的选中需求不变(测试覆盖)
- [ ] 详情面板已展开的内容在增量更新后**不被折叠回去**
- [ ] 未走整表重拉(`loadTasks` 不在 `task_status_changed` 分支里被调用)
- [ ] 前端测试全绿,贴出用例数
- [ ] **未改动**任何后端文件

## 不涉及

- 其余 5 种未订阅事件(`group_message*` / `task_completion_available` /
  `task_dispatch_warning_available`)—— 本票只补 `task_status_changed`。
  若实测发现其中某种也影响本页可见性,**写进汇报,不要自行扩张范围**
- 后端 WS 推送逻辑
- 需求列表的分组算法

## 执行环境提示

- 前端 `http://localhost:5173`,后端 `:3001`
- **实测方法**:开着群页面不刷新,用另一个终端 `POST /api/groups/:id/tasks`
  造一条任务,肉眼确认列表自动出现新行。这是本票真正的验收信号
