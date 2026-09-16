# 正式 Web 端外壳、项目页与任务详情

无构建的浏览器原生 ES module，由 `src/api/static.ts` 按扁平文件名吐出（见 ADR-0001）。

## 文件

`src/web/` 一层扁平小写名，静态服务 `SAFE_NAME` 不认斜杠和大写：

- `index.html` — 外壳 DOM + 布局样式
- `tokens.css` — 色彩令牌
- `app.js` — hash 路由、导航高亮、面包屑骨架、主题
- `projects.js` — 项目页
- `task.js` — 任务详情页
- `pool.js` — 资源池页
- `narrate.js` — **唯一可测的人话翻译表**（事件 / 尝试 ID / Token / 内部词 / 阶段与状态 / nowDoing）。三页共用，不拼 HTML、不 esc、不碰 DOM。

## 叙事层（W4）

界面给人看进度叙述，不给开发者看状态转储。**不改 API、不改内核**。

- 事件流每条三部分：角色流转徽章、动作短语、一行细节，出自 `narrateEvent`。机器 kind（`mission.created` 等）不得出现在事件流第一眼，只留在「原始数据」 tab。未知 kind：标明「未翻译」并显示 kind 本身，不要空白。
- 平台真实 kind `escalated` 与契约表里的 `escalation.raised` 映同一套文案。
- `formatAttemptId`：`W-465.exec-1` → 「工作项 W-465 · 执行者第 1 次尝试」；`coord-2` → 「协调者第 2 次尝试」。原始 ID 放括号或 title。
- `usageLine`：拆「新增」（total-cacheRead）与「缓存命中」，给占比与费用；占比≥50% 加「缓存部分计费便宜得多」。项目表、任务页头、资源池用量卡口径一致。资源池走 `GET /api/usage` 的 `total`。
- 内部词标签：attempt→尝试，causationId→由哪一跳引发，profileId→候选，ExecutionProfile→运行时，WorkItem→工作项；`revisionLabel` → 「规划 rN」「契约 rN」。技术 ID 仍可见。
- 阶段 chip 用内核 MissionStatus 中文（调查中/规划中/执行中/等你检视/已完成/已中止）。状态 chip 是第二轴：已暂停/等待中/进行中/已结束/已停止—**不得与阶段显示同一个词**。等待时必须带停机原因。
- 任务页头「现在在干什么」走 `nowDoing(view)`。
- 空态必须解释为什么空，不许只显示 —。
- 视觉：导航项内联 SVG（`fill=currentColor`）；表格行左侧色条走 `--status-*`（`.row-queued` 等）。不新增写死颜色。

文案不要散在各渲染 if 里—散写会漏 kind，漏掉的那条在界面上就是一行机器名。

## GET /

`serveStatic` 先于内置观测面。有 `src/web/index.html` 就发它；没有则回退 `src/api/web.ts` 的 `WEB_PAGE`。**不要删 WEB_PAGE**。

## 令牌

`tokens.css` 的 `:root` / `:root[data-theme="dark"]` 从 `WEB_PAGE` 逐字复制。chip 底/边公式与观测面 `.badge` 相同。侧栏 `--sidebar*` 另起 `:root` 块。

## 路由

`location.hash`：`#/projects` · `#/projects/<projectId>` · `#/missions/<missionId>` · `#/pool`。空/未知 → `#/projects`。

## 项目页

左栏 `GET /api/projects`；任务表 `GET /api/missions` 按 projectId 过滤，行带 `data-mission-id`。仓库/分支取任一 Mission 的 `workspaceRef`，没有就解释「还没读到」。列表 API 无时间戳，写「列表接口不提供时间戳」而不是 —。

## 任务详情页

标题=`contract.intent`；两根 chip + nowDoing + Token 拆项。左栏事件流 `GET .../activity`。实时输出 `GET .../live?cursor=N`，游标按 missionId 记。`shouldFollow` 在**追加之前**量（阈值 32px）。写操作不在 Web 上做。

## 资源池页

表头「候选名称 / 接入点 / 适配层 / 运行时」。只 POST 加一条，不发 DELETE/PATCH/PUT。
