# 正式 Web 端外壳、项目页与任务详情

无构建的浏览器原生 ES module，由 `src/api/static.ts` 按扁平文件名吐出（见 ADR-0001）。

## 文件

`src/web/` 一层扁平小写名，静态服务 `SAFE_NAME` 不认斜杠和大写：

- `index.html` — 外壳 DOM + 布局样式（任务页环节/用量卡样式也写在这里的 `<style>`，不新增 .css）
- `tokens.css` — 色彩令牌
- `app.js` — hash 路由、导航高亮、面包屑骨架、主题
- `projects.js` — 项目页
- `task.js` — 任务详情页
- `pool.js` — 资源池页
- `narrate.js` — **唯一可测的人话翻译表**（事件 / 尝试 ID / Token / 内部词 / 阶段与状态 / nowDoing / **环节名 / 角色徒章 / 用量卡文案**）。三页共用，不拼 HTML、不 esc、不碰 DOM。新文案不要散到各渲染分支。

## 叙事层

界面给人看进度叙述，不给开发者看状态转储。**不改 API、不改内核**。

- 事件流每条三部分：角色流转徒章、动作短语、一行细节，出自 `narrateEvent`。机器 kind 不得出现在事件流/环节头/详情第一眼；技术 ID 留在详情区「技术信息」一行。未知 kind：标明「未翻译」并显示 kind 本身，不要空白。
- 平台真实 kind `escalated` 与契约表里的 `escalation.raised` 映同一套文案。
- `formatAttemptId`：`W-465.exec-1` → 「工作项 W-465 · 执行者第 1 次尝试」；`coord-2` → 「协调者第 2 次尝试」。原始 ID 放括号或 title。
- `usageLine`：拆「新增」（total-cacheRead）与「缓存命中」，给占比与费用；占比≥50% 加「缓存部分计费便宜得多」。项目表、任务页用量卡、资源池用量卡口径一致。资源池走 `GET /api/usage` 的 `total`。
- 内部词标签：attempt→尝试，causationId→由哪一跳引发，profileId→候选，ExecutionProfile→运行时，WorkItem→工作项；`revisionLabel` → 「规划 rN」「契约 rN」。技术 ID 仍可见，只是不再是第一眼。
- 阶段 chip 用内核 MissionStatus 中文（调查中/规划中/执行中/等你检视/已完成/已中止）。状态 chip 是第二轴：已暂停/等待中/进行中/已结束/已停止—**不得与阶段显示同一个词**。等待时必须带停机原因。
- `WAIT_REASON` 含 `runaway_suspected` → 「一跳跑太久，已停下来等人看」。漏了界面会直接露英文键。
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

不再是「平铺事件 + 五个 tab」。结构是：独立用量卡 + 页头 + 左栏按环节折叠的进度 + 右上详情 + 右下常驻实时输出。只读，写操作不在 Web 上做（停止按钮 disabled、不绑事件、不发 POST）。

### 环节分组

一个环节 = 同一个 `attemptId` 下的所有事件。`groupActivity(activity)` 按 attemptId **首次出现顺序**成组，不是「一变就新开一组」的连续分段。**没有 attemptId 的事件全部收成一组，放在最后**（`mission.created` 即使是 activity[0] 也进这组—连续分段会在开头多出一个 L3 组）。

每个环节一个 `<details>`，**默认不写 open**。环节头一行自足：环节名 + 角色徒章 + 耗时 + 这一跳 token/费用 + 一句话摘要。

环节名从组内 kind 推（`stageName` 在 narrate.js），不是硬编码顺序：

- 协调者：`plan.updated`/`work_item.created` → 「调查与规划」；`review.recorded` → 「技术验收」；`work_item.dispatched` → 「派发」；`mission_result.submitted` → 「交卷」。同时有就按这个顺序用顿号连。四种都没有退回「协调」。
- 执行者 → 「执行 · <工作项标题>」
- 无 attemptId → 「L3 检视者」

整块 innerHTML 重画时必须把用户已展开的 attemptId 写回 open（`stageListHtml` 第五参 `expandedIds`）；不传时一个 open 都不写。点环节头那一刻浏览器默认展开还没落到 DOM，不能读 `details.open`，要按集合反转。

### 颜色

每个环节一种色，环节头、左侧色条、角色徒章三处同源（`roleTone`）。只从 tokens.css 现有 `--status-*` 取，不许新增写死颜色，不许用 `--role-*`。与 projects.js `stageTone` 同一套：L2 → `queued`，L1 → `running`，L3 → `unconfirmed`。

### 详情页

选中一个环节（或组内一条事件）时，右上按这一跳的角色渲染实际传递的正文。除证据外全在已取到的 MissionView 上，不为详情新开接口。一个环节同时有多类事件就同时渲染多块。

- 调查规划 → `plan` 的 findings / rootCause / rejectedHypotheses / decisions / direction
- 派发 → 工作项 `order`（objective / allowedScope / verification / acceptance）
- 执行者 → `executionResult` + 诡据清单（kind / summary / command / exitCode）
- 技术验收 → `lastReview` 的 verdict / reasons / requiredChanges
- 升级 → `escalationLog` 的 question / why / answer
- L3 → `finalReview` 的 verdict / reasons / mergedInto

**证据**不在 MissionView 里。选中哪个环节就 `GET /api/missions/<id>/attempts/<attemptId>` 一次（钥匙是环节自己的 attemptId，不是 causationId）。没有 attemptId（L3 组）不发请求。**禁**为算用量把每个 attempt 挬个拉一遍。

旧 tab（文件变更 / 验证结果 / 相关消息 / 原始数据）连函数一起删掉。证据与升级的**内容**搬进详情页，不是丢掉。

### 用量卡

顶部独立一块（`#task-usage`），不再是 `.task-stats` 里的一格。三层：

1. 总计 token 与费用（大字）— `view.usage`
2. **按角色拆**：L2 协调 X（占比 %）、L1 执行 Y（占比 %）— `usageByRole(activity)` 只扫 `attempt.ended` 且带 `data.usage` 的事件：attemptId 以 `coord` 开头算 L2，含 `.exec-` 算 L1。占比分母用 L2+L1 之和（在途 attempt 还没 ended，view.usage.total 可能更大）。
3. 按类型拆：新增 / 缓存命中（占比）

### 实时输出

右下常驻，不是 tab。`GET .../live?cursor=N`，游标按 missionId 记。`shouldFollow` 在**追加之前**量（阈值 32px）。离页停表。

`kind === 'note'` 的行（后端裁剪痕迹，排在末尾）拢成终端**上方**横幅，不混在正文里—混在末尾会被读成「后面还有」，而它说的是「前面没了」。`kind === 'usage'` 不当终端行。

终态空态：有行就正常显示；真没有说「这一跳没有在这里留下输出行」。**不要**说「完整输出在下面的原始输出里」—原始数据 tab 已删。

## 资源池页

表头「候选名称 / 接入点 / 适配层 / 运行时」。只 POST 加一条，不发 DELETE/PATCH/PUT。
