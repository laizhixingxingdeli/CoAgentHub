# 正式 Web 端外壳、项目页与任务详情

无构建的浏览器原生 ES module，由 `src/api/static.ts` 按扁平文件名吐出（见 ADR-0001）。

## 文件

`src/web/` 一层扁平小写名，静态服务 `SAFE_NAME` 不认斜杠和大写：

- `index.html` — 外壳 DOM + 布局样式（任务页环节/用量卡样式也写在这里的 `<style>`，不新增 .css）
- `tokens.css` — 色彩令牌
- `app.js` — hash 路由、导航高亮、面包屑骨架、主题
- `overview.js` — 首页与统一项目任务列表
- `model-priority.js` — 四角色候选顺序、草稿与版本冲突
- `ui.css` — 正式界面布局与响应式样式
- `projects.js` — 旧项目渲染及共享工具
- `task.js` — 任务详情页
- `pool.js` — 资源池页
- `platform.js` — 只读平台运维页
- `narrate.js` — **唯一可测的人话翻译表**（事件 / 尝试 ID / Token / 内部词 / 阶段与状态 / nowDoing / **环节名 / 角色徒章 / 用量卡文案**）。三页共用，不拼 HTML、不 esc、不碰 DOM。新文案不要散到各渲染分支。

## 叙事层

界面给人看进度叙述，不给开发者看状态转储。**不改 API、不改内核**。

- 事件流每条三部分：角色流转徒章、动作短语、一行细节，出自 `narrateEvent`。机器 kind 不得出现在事件流/环节头/详情第一眼；技术 ID 留在详情区「技术信息」一行。未知 kind：标明「未翻译」并显示 kind 本身，不要空白。
- 平台真实 kind `escalated` 与契约表里的 `escalation.raised` 映同一套文案。
- 平台活动事件由 `test/web-event-coverage.test.ts` 从 `src/application/platform.ts` 的 `#event` 调用以及 `query-promotion.ts`、`reconcile.ts`、`decision-shadow-runner.ts`、`post-execution-shadow.ts` 的 `ActivityLog.append` 写入点收集 kind；不能解析的新表达式和未翻译的非命令 kind 必须使测试失败。`runtime.command.*` / `runtime.command_tracking.*` 不逐条叙述：按所属环节汇总实际命令次数，命令明细在可折叠清单里展示可用的命令文本和退出码。
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

主导航仅「首页、项目任务列表、角色与模型」，分别为 `#/`、`#/projects`、`#/agents`；空路由进入首页。项目选择使用 `#/projects/<projectId>`，任务选择使用 `#/missions/<missionId>?step=<环节键>`，刷新后恢复选中环节。旧 `#/pool`、`#/platform` 等路由保留兼容，但不作为主导航。

## 平台页

`#/platform` 只读，展示 `/api/platform/status` 的实例与回环监听/主锁、队列五态及按时间倒序死信摘要、global/project/role/runtime/profile 占用、环境基线透传及默认适配器；不适用/缺失项明确说明。可见时每 10 秒刷新，离页/换代后不让旧响应写回 DOM；外部字段转义。平台页 HTML 渲染是可在 Node 测试的纯函数，DOM 写入集中于页底。

## 项目页

项目选择器 `GET /api/projects`；统一任务表 `GET /api/missions` 按 projectId 过滤，行带 `data-mission-id`。仓库/分支取任一 Mission 的 `workspaceRef`，没有就解释「还没读到」。任务行按 `updatedAt` 倒序，「最新更新时间」显示本地 MM-DD HH:mm，title 显示完整时间；缺值如实说明，不声称列表接口没有时间戳。

可见时每 5 秒重拉 `/api/projects` 与 `/api/missions`，隐藏时暂停、重新可见时立即补拉；离页停止计时与过期 DOM 写入。`nextRefresh(page,status,visible)` 是可在 Node 测的纯策略：项目页 5000ms；未终态任务页 view/activity 3000ms、live 1000ms；终态与隐藏态停止。

## 任务详情页

不再是「平铺事件 + 五个 tab」。结构是：页头、一条运行时间线、常驻当前实时输出、所选环节沟通与用量、文件改动；累计用量与完整契约放入折叠区。小屏优先呈现当前输出，时间线在自身容器内横向滚动，不使整页溢出。只读，写操作不在 Web 上做（停止按钮 disabled、不绑事件、不发 POST）。

### 环节分组

一个环节 = 同一个 `attemptId` 下的所有事件。`groupActivity(activity)` 按 attemptId **首次出现顺序**成组，不是「一变就新开一组」的连续分段。**没有 attemptId 的事件依角色归属分组，平台与 L3 可辨认；L1/L2 orphan 不得冒充 L3**。任务结束时 L3 收尾组从 `finalReview` 展示终审结论与合入 SHA，不再显示「这一跳还没结束」。

每个环节一个 `<details>`，**默认不写 open**。环节头一行自足：环节名 + 角色徒章 + 具体模型 + 耗时 + 这一跳 token/费用 + 一句话摘要。协调者与执行者的具体模型来源是该环节 `attempt.started` 的 `data.profile`，缺失显示「未记录」；L3 与平台组不显示模型栏。命令族在所属环节头汇总「跑了 N 条命令」，明细可折叠，不作普通事件行。

环节名从组内 kind 推（`stageName` 在 narrate.js），不是硬编码顺序：

- 协调者：`plan.updated`/`work_item.created` → 「调查与规划」；`review.recorded` → 「技术验收」；`work_item.dispatched` → 「派发」；`mission_result.submitted` → 「交卷」。同时有就按这个顺序用顿号连。四种都没有退回「协调」。
- 执行者 → 「执行 · <工作项标题>」
- 无 attemptId 且归属 L3 → 「L3 检视者」

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

独立累计折叠块（`#task-usage`），不再是 `.task-stats` 里的一格。三层：

1. 总计 token 与费用（大字）— `view.usage`
2. **按角色拆**：L2 协调 X（占比 %）、L1 执行 Y（占比 %）— `usageByRole(activity)` 只扫 `attempt.ended` 且带 `data.usage` 的事件：attemptId 以 `coord` 开头算 L2，含 `.exec-` 算 L1。占比分母用 L2+L1 之和（在途 attempt 还没 ended，view.usage.total 可能更大）。
3. 按类型拆：新增 / 缓存命中（占比）

### 实时输出

右下常驻，不是 tab。`GET .../live?cursor=N`，游标按 missionId 记。`shouldFollow` 在**追加之前**量（阈值 32px）。离页停表。

可见且未终态时每 3 秒重拉 MissionView 和 activity，有变化才重画且保留展开/选中；实时输出每秒轮询。页面隐藏时暂停全部轮询，恢复可见立即补拉；任务终态停止 view/activity/live 轮询，首屏已终态也不请求 live。离页不写过期结果。

`kind === 'note'` 的行（后端裁剪痕迹，排在末尾）拢成终端**上方**横幅，不混在正文里—混在末尾会被读成「后面还有」，而它说的是「前面没了」。`kind === 'usage'` 不当终端行。

终态空态：有行就正常显示；真没有说「这一跳没有在这里留下输出行」。**不要**说「完整输出在下面的原始输出里」—原始数据 tab 已删。所选历史跳的 attempt detail `output` 仅在环节详情折叠区展示「历史输出末尾」，不补入当前实时输出。历史尾部最多 200 行且存储前由平台现有脱敏规则处理。

### 上下文指标与改动

从各跳 `attempt.ended.data.contextMetrics` 显示简报、读文件、命令输出等分类字节数，以按类别分段横条和图例呈现；未上报明确说明，不能视作零。任务「改动」块读取 `GET /api/missions/:id/diff`，使用现有 git `--stat` 每文件的 changed 总行数及全任务新增/删除总数，展开可查看每文件统计摘要。无改动/读取失败如实提示，路径等外部数据转义。本能力不承诺逐行 patch 或每文件分别精确的新增与删除数。

## 资源池页

表头「候选名称 / 接入点 / 适配层 / 运行时 / 健康」。只 POST 加一条，不发 DELETE/PATCH/PUT。

候选健康格展示熔断状态/到期、最近失败类别和时间、七日尝试/成功/花费，以及无运行时候选的原因；缺健康字段有解释而非伪零，外部值转义。

首屏仅取 `/api/pools` 和 `/api/usage` 即渲染候选与用量；模型清单 `/api/runtime/models` 只在打开「添加候选」表单时读，读取中与失败提示仅影响该表单，不阻塞或清空列表。

## 2026-10-04 接线补充（已确认设计）

本节及上述更新取代旧布局描述，既有事件翻译、平台只读、脱敏、刷新隔离与证据边界继续有效。首页展示服务连接、进行中任务、模型熔断；没有权威接口的检视投递汇总显示未提供，不据握手推断投递成功。任务列表保留所有状态，以最近活动 `updatedAt` 倒序排列，不额外拆出最近完成；后端列表没有创建时间，因此不宣称按创建时间排序。任务详情没有重复工作项步骤列表，不嵌项目任务列表。

环节展示开始、结束或进行中时间、耗时及词元；结束用量来自该尝试的 `attempt.ended`，暂计用量来自带相同 attemptId 的 live usage，并明确标记暂计。未知质量的默认零值、缺失费用和缺失分类字段显示未知，真实上报零值仍显示零。当前实时输出独立于所选环节；展开、横向位置和历史选中保留，数字更新不重建整条时间线。任务终态不继续累计在途耗时。

调查规划、工单、技术验收在 MissionView 中为当前投影，标题明确当前版本或当前记录，不声称是每次流转的不可变历史快照。历史执行尝试不得显示其他尝试最新的 executionResult；优先使用该 attempt 的证据与输出，未保留的正文如实说明。完整 Contract 通过 textContent 全量展示，不截短。

角色与模型使用 `GET /api/pools/config`、`POST /api/pools/<role>/configure` 的 revision CAS。四角色为分类器、协调者、执行者、独立检视者；调整列表顺序即候选优先级，配置 facts、endpoint、enabled 保留。版本冲突保留草稿，用户读取最新配置并比较后才重试；离页与关闭页面提示未保存草稿。保存只影响下一次调度，不干预在途尝试。本页为用户已确认的配置写入例外，任务决策、Delivery 消费/ACK、检视签字仍不在 Web 执行；鉴权 D1d 暂缓不变，现有回环服务边界不扩大。
