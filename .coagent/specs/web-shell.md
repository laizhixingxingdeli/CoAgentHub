# 正式 Web 端外壳与项目页

无构建的浏览器原生 ES module，由 `src/api/static.ts` 按扁平文件名吐出（见 ADR-0001）。

## 文件

`src/web/` 一层扁平小写名，静态服务 `SAFE_NAME` 不认斜杠和大写：

- `index.html` — 外壳 DOM + 布局样式
- `tokens.css` — 色彩令牌
- `app.js` — hash 路由、导航高亮、面包屑、主题
- `projects.js` — 项目页数据与渲染

后续页面（任务详情、资源池）复用同一套外壳与令牌，不要另起目录。

## GET /

`serveStatic` 先于内置观测面。有 `src/web/index.html` 就发它；没有则回退 `src/api/web.ts` 的 `WEB_PAGE`。**不要删 WEB_PAGE**—`src/web/` 缺失时平台还得能自证活着。

## 令牌

`tokens.css` 的 `:root` / `:root[data-theme="dark"]` 从 `WEB_PAGE` 逐字复制，oklch 值不许就地调。改颜色走 v4 `index.css` 再两处一起搬。chip 底/边公式与观测面 `.badge` 相同：`color-mix(in oklch, var(--status-*) 14%/35%, transparent)`。

## 路由

`location.hash`，不是 History API（静态层给不出 `/projects/<id>` 的 index.html）。

- `#/projects` · `#/projects/<projectId>` — 项目页
- `#/resources` — 占位（资源池页后续 Mission）
- 空 / 未知 → `#/projects`

## 项目页数据（只读 /api/*）

| 界面 | 来源 |
|---|---|
| 左栏列表 | `GET /api/projects`（`projectId` / `mutating` / `missions`） |
| 任务表 | `GET /api/missions` 客户端按 `projectId` 过滤 |
| 代码仓库 / 目标分支 | 该项目任一 Mission 的 `GET /api/missions/:id` → `workspaceRef.projectRoot` / `branch`；没有就 —。**不要往内核加字段** |
| 变更中槽位 | `mutating` 有值 1/1，否则 0/1 |
| 最新更新时间 | 列表 API 无时间戳，显示 — |

阶段 chip 映射内核 `MissionStatus`（investigating/planning/executing/awaiting_review/completed/blocked），中文：调查中/规划中/执行中/等你检视/已完成/已中止。**不要用设计稿的 investigation / execution / technical_review。**

状态是第二轴（paused / waitReason / 终态），不要和阶段揉成一个 chip。

写操作（放行/打回/取消）不在 Web 上做—规则只该有一份实现（`src/l3.ts`）。
