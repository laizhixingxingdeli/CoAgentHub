# 正式 Web 端外壳、项目页与任务详情

无构建的浏览器原生 ES module，由 `src/api/static.ts` 按扁平文件名吐出（见 ADR-0001）。

## 文件

`src/web/` 一层扁平小写名，静态服务 `SAFE_NAME` 不认斜杠和大写：

- `index.html` — 外壳 DOM + 布局样式
- `tokens.css` — 色彩令牌
- `app.js` — hash 路由、导航高亮、面包屑骨架、主题
- `projects.js` — 项目页数据与渲染
- `task.js` — 任务详情页数据与渲染

后续页面（资源池）复用同一套外壳与令牌，不要另起目录。

## GET /

`serveStatic` 先于内置观测面。有 `src/web/index.html` 就发它；没有则回退 `src/api/web.ts` 的 `WEB_PAGE`。**不要删 WEB_PAGE**—`src/web/` 缺失时平台还得能自证活着。

## 令牌

`tokens.css` 的 `:root` / `:root[data-theme="dark"]` 从 `WEB_PAGE` 逐字复制，oklch 值不许就地调。改颜色走 v4 `index.css` 再两处一起搬。chip 底/边公式与观测面 `.badge` 相同：`color-mix(in oklch, var(--status-*) 14%/35%, transparent)`。

侧栏令牌 `--sidebar` / `--sidebar-foreground` / `--sidebar-accent` **另起** `:root` 块写在复制块之后—塞进现有块会打破与 `WEB_PAGE` 的逐字 includes。侧栏在明暗主题下都是深色，不能复用 `--card`（亮色下是白的）。取值从已有暗色 oklch 借，不发明新色相。`.nav` 引用这三个令牌；正文区域（`.main` / `.topbar` / `.view` / `.card` / `.page`）一个 sidebar 令牌都不用。

## 路由

`location.hash`，不是 History API（静态层给不出 `/missions/<id>` 的 index.html）。

- `#/projects` · `#/projects/<projectId>` — 项目页
- `#/missions/<missionId>` — 任务详情；`#/missions` 无 id 当未知
- `#/resources` — 占位（资源池页后续 Mission）
- 空 / 未知 → `#/projects`

任务页时导航「项目」保持高亮。点任务表行只写 `location.hash`。

## 项目页数据（只读 /api/*）

| 界面 | 来源 |
|---|---|
| 左栏列表 | `GET /api/projects`（`projectId` / `mutating` / `missions`） |
| 任务表 | `GET /api/missions` 客户端按 `projectId` 过滤；行带 `data-mission-id`，点进 `#/missions/<id>` |
| 代码仓库 / 目标分支 | 该项目任一 Mission 的 `GET /api/missions/:id` → `workspaceRef.projectRoot` / `branch`；没有就 —。**不要往内核加字段** |
| 变更中槽位 | `mutating` 有值 1/1，否则 0/1 |
| 最新更新时间 | 列表 API 无时间戳，显示 — |

阶段 chip 映射内核 `MissionStatus`（investigating/planning/executing/awaiting_review/completed/blocked），中文：调查中/规划中/执行中/等你检视/已完成/已中止。**不要用设计稿的 investigation / execution / technical_review。** `stageChip` 只在 `projects.js` 里有一份。

状态是第二轴（paused / waitReason / 终态），不要和阶段揉成一个 chip。

## 任务详情页（只读）

面包屑：`项目` → `#/projects` / `<projectId>` → `#/projects/<id>` / `任务 <missionId>`（当前页，不是链接）。projectId 从 MissionView 来，外壳不读数据。

| 界面 | 来源 |
|---|---|
| 标题 | `GET /api/missions/:id` → `contract.intent` |
| 阶段 / 状态 chip | 同项目页（`stageChip` / `stateChip`） |
| 总消耗 tokens | `view.usage.total` |
| 创建时间 | `GET .../activity` 按序第一条的 `at`。MissionView **没有 createdAt**，不要往内核加 |
| 运行时长 | 终态用 `updatedAt`（或末条 at）- 创建时间；进行中用传入的 nowIso。纯函数里不许 `new Date()` |
| 停止任务 | disabled 占位，`title="API 尚无鉴权，写操作暂不开放"`。**不发 POST** |
| 左栏事件流 | `GET /api/missions/:id/activity`（`at` / `kind` / `workItemId` / `attemptId`） |
| 事件详情 | 选中事件的 kind / at / causationId；有 causationId 才 `GET .../attempts/<causationId>` 取 profile 与 usage。mission.created 没有 causationId（JSON 省略该键） |
| 实时输出 | `GET .../live?cursor=N`，不要每次从头拉。无数据显示说明句。游标按 missionId 记住，离开再回来不重置 |
| 文件变更 | `GET .../diff` → `stat` + `files[]`，不做逐行着色 |
| 验证结果 | 选中 attempt 的 `evidence[]` |
| 相关消息 | `view.escalationLog` |
| 原始数据 | 选中事件 JSON，等宽、转义 |

自动滚动：`shouldFollow({autoScroll, scrollTop, clientHeight, scrollHeight})` 在**追加之前**量（阈值 32px）。勾选且贴底才跟；人手动上滚看历史时不许拽回底部。

写操作（放行/打回/取消）不在 Web 上做—规则只该有一份实现（`src/l3.ts`）。
