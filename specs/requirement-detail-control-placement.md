# Spec: 任务详情顶部控制条下沉到任务卡片

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-23

## 背景

任务详情右栏最上方是一条独立的「控制」栏
(`components/layout/context-panel/requirement-control-bar.tsx`),带标题 + 每个任务
一行停止/回滚按钮。

**它占掉了详情区最显眼的位置,而它承载的不是信息、是操作。** 用户打开详情是为了看
「这条需求现在到哪一步了」,最先撞见的却是一排按钮和一列裸 `executorKey`。

同时它把**控制与它所控制的对象拆开了**:按钮在顶部,对应的任务卡片在下方时间线里,
两者之间没有视觉关联,任务多时要靠 id 前缀对号入座。

## 决策

**删除顶部控制条,把停止/回滚下沉到时间线里每条任务自己的卡片上。**

控制仍在详情页内,只是**跟着任务走**,不再另起一栏。左栏(需求列表)不加任何东西。

## 要求

### R1. 删除 `requirement-control-bar.tsx`

连同 `requirement-control-bar.test.tsx` 一并删除。
`requirement-workspace.tsx` 的 `detailPane` 不再渲染它。

### R2. 控制移入时间线的任务卡片

`RequirementTimeline.tsx` 的任务卡片(渲染 `task.id` 的那一支)增加停止/回滚控制:

- **判定逻辑照搬,不要改**:
  - 可停止 = `status === "queued" || status === "running"`
  - 可回滚 = `(status === "done" || status === "failed") && Boolean(checkpointRef)`
- 复用现有 `ControlButton`(含 `canControl` / `readOnly` 的禁用与提示),
  **不要新写一个按钮组件**
- 保留 `commandSending` / `rollbackStates` 驱动的「发送中…」「回滚中…」「已恢复」态
- 现有 `data-testid`:`task-stop-${task.id}` / `task-rollback-${task.id}` **保持不变**
  (测试与外部引用按此定位)

### R3. 历史任务的控制能力不得丢失

原控制条的注释写明「历史任务同样可在此操作」。历史任务本来就在时间线里有卡片,
控制跟着卡片走即自然保留。**验收时要实际确认一条历史任务仍可回滚。**

### R4. 控制不得喧宾夺主

卡片内控制的视觉权重要**低于**任务状态与内容:放在卡片底部或右侧,小尺寸、
次要样式。**不要**因为搬了家就把它做得更醒目。

### R5. TaskPanel 回退路径不受影响

`requirement-workspace.tsx` 在「无 specRef 分组需求」时回退到 `TaskPanel`,
后者有自己的一套控制。**本票不碰 TaskPanel。**

## 验收标准

- [ ] `requirement-control-bar.tsx` 与其测试文件已删除
- [ ] 详情区顶部不再有「控制」栏,首屏第一眼是需求内容而非按钮
- [ ] 时间线的任务卡片上能停止 `running` 任务(实测一次)
- [ ] 时间线的任务卡片上能回滚带 `checkpointRef` 的 `done`/`failed` 任务(实测一次)
- [ ] **历史任务**(非最新那条)的回滚仍可用
- [ ] `data-testid` `task-stop-*` / `task-rollback-*` 保持不变
- [ ] 无 `canControl` 权限 / 归档群只读时,按钮仍按原规则禁用并提示
- [ ] 左栏需求列表**未新增任何控制元素**
- [ ] **未改动** `TaskPanel.tsx`
- [ ] 前端测试全绿,贴出用例数与删除的用例

## 不涉及

- 阶梯进度条的语义(`requirement-stepper-semantics`)
- 展开/折叠机制(`fold-affordance-and-length-cap`)
- 任务状态的显示样式(`task-status-legibility`)
- `TaskPanel` 回退路径

## 执行环境提示

- 前端 `http://localhost:5173`
- **必须肉眼确认**:打开一条有多个任务的需求,顶部无控制栏,每张任务卡片上有自己的控制
