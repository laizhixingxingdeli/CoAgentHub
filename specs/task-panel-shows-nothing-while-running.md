# Spec: 任务在跑,界面上什么都看不到 —— 实时输出与派生块都没有刷新通道

> **状态**: Landed — L3 通过(2026-09-08),实现 `632f9bf1`(Pi 直连实施,
> 检视者完成 L2/L3)。L2:四个定向测试文件 **0 failed | 90 passed**;
> 前端全量 **33 文件 / 377 用例全绿**,零回归。
> 红线全过:未碰 `queue.ts` 的界面流判据、未碰后端、未加依赖、
> **新增 `setInterval` 次数为 0**(禁止全表轮询)。
> R3 选了 (a):前端订阅 `group_message`,识别 `review_result` 后从
> `loadedTaskDetailsRef` 删除该 taskId 强制重拉详情。
> L3 亮点:`use-group-ws` 的 `onReconnect` **明确区分「首次打开」与「真重连」**,
> 且注释写明该形状供 R5 复用 —— 正是本 spec §5 要求的「先落地的定形状,
> 后落地的复用,不得各写一套」。
> 11 个文件里 538 行是测试、约 490 行是实现,不是范围膨胀。
> **版本**: 1.0
> **日期**: 2026-09-07
> **来源**: 用户报告(2026-09-07)「现在网页上没有实时输出」+ 同日「网页上的进度没有更新」。
> **相关**: [live-output-only-agent-narration.md](live-output-only-agent-narration.md)(Frozen v1.3,
> 界面流只显示 `kind=report` —— **本票不改它的判据**,只补它之外的兜底与刷新)、
> 报告 R5(断线恢复)、[live-output-pi-uncovered-shows-thinking-and-tool-results.md](live-output-pi-uncovered-shows-thinking-and-tool-results.md)(同类先例)。

## 1. 背景与目标

### 1.1 现场实测(2026-09-07 18:07–18:14,真实运行中的任务)

被观察对象:`01a07b36-0407`(codebuddy 执行 R2),`status=running`,`pidAlive=true`,已运行约 40 分钟。

| 观测 | 结果 |
|---|---|
| WS 探针(与前端同款 `ws://localhost:3001/api/ws`,以及带 `participantId` 的一条)30 秒 | **0 帧** |
| 同期 `logs/server.log` | 只有 HTTP 请求行,**没有任何执行器原始输出** |
| `GET …/tasks?includeOutput=1` 的 `outputTail` | 恒为 109 字符,25 秒后**一字未变** |
| `outputTail` 全文 | 三行:`[汇报 #t42] Now implementing the route change.` / `[汇报 #t51] Now the fail endpoint:` / `[汇报 #t75] Now the docs update:` |

**结论:WS 链路没坏,`serve.mjs` 的 upgrade 转发也正常(已核 `server.on("upgrade")`)。
那一刻服务端确实没有可推的内容。** 问题是「没有内容可推」这件事本身,以及
「有过的内容页面也拿不到」。

### 1.2 三条独立成因

**C1 —— 界面流只收 `kind=report`,执行器可以几十分钟不产出一条。**
`queue.ts` 的 `liveStreamText()` 只保留 `entry.kind === "report"`,
`tool`/`command`/`result`/`thinking`/`error`/`raw` 全部只进持久化、不进界面
(这是 `live-output-only-agent-narration` R1 的**有意设计**,本票不推翻)。
实测:codebuddy 干了 40 分钟,界面流只有 **3 行**。用户看到的就是一片空白,
且**无法区分「它在思考」和「它挂了」**。

**C2 —— 页面从不补拉已有的 live 缓冲。**
`requirement-workspace.tsx` 挂载时对每个任务发 `GET /tasks/:id`,
**不带 `includeOutput=1`**;历史 live 缓冲只有在用户手动展开任务行时才兜底拉。
于是:页面打开得晚于那 3 行输出 → 在下一条 report 到来之前**永远是空的**。

**C3 —— 派生块(`l1`/`l3`/`liveness`)只拉一次,此后永不刷新。**
同一个 effect 用 `loadedTaskDetailsRef.current.has(task.id)` 去重,**每个任务一辈子只拉一次**。
而 `l1`/`l3`/`liveness` **只在 `routes/group/tasks.ts` 的 HTTP GET 里派生**,WS 载荷里没有;
`mergeTaskStatusChanged` 用 `{...prev, ...incoming}` 展开原始任务行,挂载时那份陈旧
`l3` 原样留存。更彻底的是:检视者公布 `review_result` 是**一条群消息、不改任何任务状态**
→ 不产生任何任务事件,而该组件的 WS 处理器**只认** `task_status_changed` /
`task_output` / `task_stall_alert`,**完全不认 `group_message`**。
实测:任务详情 API 早已返回 `l3={"answered":true,"verdict":"pass"}`,页面仍显示
「L3 未开始 · 已等待 116 分钟」。

### 1.3 目标

**任务在跑时,界面必须能回答两个问题:它还活着吗?它进行到哪了?**
并且在 L2/L3 结论产生后,不需要用户手动刷新页面就能看到。

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/frontend/web/src/components/layout/context-panel/requirement-workspace.tsx` | 挂载/重连补拉(C2);去掉派生块的永久去重、建立刷新通道(C3) |
| `packages/frontend/web/src/hooks/use-group-ws.ts` | 重连后的补拉钩子(与 R5 协调,见 §5) |
| 任务行渲染组件 | 无 report 时的进度兜底展示(C1) |
| 后端(**仅当** §3 R1 选了服务端方案时) | 见 R1 |

**不改**:`live-output-only-agent-narration` 的界面流判据 —— 界面流**仍然只显示
`kind=report`**;`liveStreamText` / `summaryStreamText` 的过滤逻辑;
持久化口径与明细 JSONL;WS 帧的种类与扇出范围。

## 3. 详细改动

### R1. 零 report 时也要有可信的「在动」信号(不改界面流判据)

即使一条 `report` 都没有,任务行也必须显示**不依赖解析器识别能力**的进度元信息,
至少包含:

- 已运行时长;
- **最近一次有任何输出**的时间(注意:是任意 kind,不只是 report);
- 静默告警状态(平台已有 `liveness.warning` / `lastSignalAt` 与 `task_stall_alert` 帧)。

⚠️ **这是 ADR-0009「判据推广性」要求的兜底**:`kind=report` 是一张判据,
它对本群实际执行器的覆盖度已经被证伪过一次(`live-output-pi-uncovered-…` 那票补的是 Pi),
现在 codebuddy 虽在判据表里、40 分钟仍只产出 3 条。**判据可以继续收窄界面流,
但不能让「判据没命中」等于「界面上什么都没有」。**

数据来源自选(读时派生的 `liveness` 已有 `lastSignalAt`;或用摘要缓冲的最后写入时刻),
但**不得**把 `tool`/`thinking` 正文塞进界面流来充数 —— 那会推翻 v1.3 的冻结判据。

### R2. 挂载与重连时补拉 live 缓冲(C2)

- 页面挂载时,对**非终态**任务用 `?includeOutput=1` 取回当前 live 缓冲并渲染;
- WS 重连后同样补拉一次(断线期间的 report 只在缓冲里,新帧不会重发);
- 用户展开行时的既有兜底保持不变。

### R3. 派生块必须有刷新通道(C3)

- 去掉「每个任务只拉一次」的永久去重;改为**非终态任务可重复拉取**
  (终态任务可继续缓存,但 `l3` 在任务终态后仍会变化 —— 见下一条,不能因为
  任务已 `done` 就永久冻结它的 `l3`);
- **`l3` 的刷新不能只挂在任务状态变化上**:L3 结论是一条群消息,不改任务状态。
  二选一并说明理由:
  - (a) 前端订阅 `group_message`,识别 `review_result` 后重拉该 `taskId` 的详情;
  - (b) 服务端在 L3 结论落地时补推一个任务级事件(需同时更新 `docs/architecture.md`
    的 WS 帧清单)。
- 无论选哪条,**不得**引入固定轮询把整张任务列表每 N 秒重拉一遍。

### R4. 不得掩盖失败

补拉/刷新失败时保持既有可见信号,不得静默吞掉;
「无输出」与「拉取失败」在界面上必须可区分。

## 4. 验收标准

全部验收**在真实运行的任务上做,且全程不手动刷新页面**。

1. **零 report 也能看出在动**:构造/等待一个连续 5 分钟不产出 report 的运行中任务,
   任务行显示已运行时长与最近活动时间,且该时间随任意输出前进
   (不是恒定不变的挂载时刻)。
2. **迟到打开页面能看到已有输出**:先让任务产出若干 report,**之后**再打开页面 →
   任务行立即显示这些历史 report(证明走了 `includeOutput=1` 补拉),
   不需要手动展开行。
3. **重连补拉**:任务运行中重启 server(或断开 WS)→ 断线期间产生 report →
   重连后界面在 N 秒内出现断线期间的那些行。
4. **L3 结论自动可见**:协调者 PATCH 终态 → 检视者公布 `review_result` →
   **不刷新页面**,L3 卡片在 N 秒内从「未开始/等待中」变为「已检视 · pass」。
   N 由实现给出并写进汇报。
5. **失败可区分**:模拟详情接口 500 → 界面显示拉取失败,而不是显示成「没有输出」。
6. 前端定向测试 + `pnpm --filter @laizhixingxingdeli/web test`(或仓库现行前端测试命令)通过;
   页面完整性用**实际渲染**验证,不接受「hook 返回了正确数组」当作页面验收。

## 5. 不涉及的改动

- **不改 `live-output-only-agent-narration` 的界面流判据**(界面流仍只有 `report`)。
  若实现中认为必须放宽,**停止并退回检视者**做 `spec_amended`(闸二)。
- **不改**持久化口径、明细 JSONL、`?detail=1` 展开。
- **消息流的历史分页与断线补拉属于报告 R5**,与本票分工:R5 管**消息**,
  本票管**任务面板的实时输出与派生块**。两票都会碰 `use-group-ws` 的重连钩子,
  **先落地的那张定钩子形状,后落地的复用,不得各写一套**。
- 不引入新的状态管理框架。

## 6. 兼容性

- 无 schema 变更,无迁移。
- 新增的补拉会增加少量 `?includeOutput=1` 请求;必须限定在**非终态任务**上,
  不得对历史任务全量补拉。
- WS 帧种类若因 R3(b) 增加,须同步 `docs/architecture.md`。
