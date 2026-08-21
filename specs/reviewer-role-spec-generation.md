# Spec: 三角色三层检视流程（检视者出 spec / 协调者派发 / 执行者实现）

> **状态**: Ready for Implementation
> **版本**: 3.4（在 3.3 基础上：新增协作模式——三层 / 两层，模式由群成员构成
> 推导，平台零改动；两层下协调者兼任写 spec 职责并跳过 L3）
> **日期**: 2026-08-21
> **依赖**: 服务端 specRef/specHash 透传、Skill 安装 API、durable task-completion events、
> executor 任务通道（spawn/回调）、coordinator/executor/bugfix skills、Matt 协议 v1.2 对齐
> **取代**: 本文件 v2.1（架构不变，实现细节按下文调整；v2.1 的 A2A 相关表述在 Phase 1 不实现）

## 0. 与 v2.1 的差异（决策记录）

本次实现范围经过讨论确定，与 v2.1 草稿相比有以下调整：

1. **不引入/依赖 A2A**：Phase 1 的下发者会话延续（detached 模式）只对 `kind=cli`
   执行器开放，不要求 A2A gateway 支持。
2. **"停止"语义收窄**：只能取消**排队中**任务；运行中任务不可中断，只能等其终态后
   下发修正任务（fix-forward）。原「kill 运行中任务进程组」的能力保留在代码里，仅
   用于服务端自身的静默/超时兜底，不再由用户指令触发。
3. **停止/回滚按群隔离**：`stopRunningTask` / `queuedExecutorTaskCount` /
   `currentRunningTask` 修正为按 `groupId` 过滤，消除跨群误伤（v2.1 未提及，
   属于本次发现的既有缺陷，一并修复）。
4. **下发者角色区分为"下发门"与"控制门"两个判据**：`DISPATCH_ALLOWED_ROLES`
   （coordinator/human/reviewer）控制谁能下发任务；`CONTROL_ALLOWED_ROLES`
   （coordinator/human/reviewer）控制谁能发停止/回滚指令——human 禁言后，
   紧急停止只能由检视者代发，因此两份角色表相同但语义不同，分开维护。
5. **下发者身份判据从"是否在执行器配置表中"改为显式 `canDispatch` 标记**：
   协调者、检视者要注册为可被下发的执行器（用于被下发任务唤醒），但同时它们自己
   也要能下发任务并携带 `callbackRef`；原判据 `sender 命中执行器配置 → 视为执行器,
   丢弃 callback` 会连累协调者/检视者自己发消息时的路由信息，改为按显式标记区分
   "纯执行器"与"可下发的下发者"。
6. **会话延续需求明确为三条**（详见 §3.5）：
   - 检视者的上下文由用户/检视者自己的 runtime 决定，平台不管；只需保证协调者
     结案时，回传能送达检视者**下发时**的那个会话（`sessionRef`）。
   - 协调者下发任务与收到执行者回调，必须落在同一个会话里。
   - 执行者每次执行与其 L1 code review 自检落在同一个会话里（现状已满足，
     零改动）。
7. **移除弱验收钩子**（本次讨论追加，见 §3.4）：done 判定不再对工作区做
   `verifyTaskCommitted` 之类的旁路 git 检查，只看执行器进程 exit code + 结构化
   汇报解析结果；早期草案里配套的 `commitMode` 配置项因此作废，不再需要。
8. **Dispatch 纪律：任务书按单一关注点拆细**（本次讨论追加，见 §3.11、§7）：
   实测发现打包多个小节/多个文件的大任务书，执行器中途中断（额度/环境问题）后
   留下的半成品状态难以诊断；改为一票一个内聚关注点，源码+配套测试+提交在同一
   张票里一次完成，不分阶段。§7 的建议批次从4大批拆为12张更细的票。
9. **执行器限额处理纪律**（本次讨论追加，见 §3.11）：执行器命中使用量限额
   （429 / rate limit / quota）时，协调者应**等待限额重置时间过后重新下发同一
   张票**，而不是换执行器或放弃该票。平台侧已有对应机制
   （`scripts/dispatch-policy.json` 的 `rateLimit.detectPatterns` 探测 +
   `cooldownMinutes` 冷却 + `parseRateLimitRecoveryMs` 从失败输出解析恢复时间），
   skill 侧的纪律与之对齐；`rateLimit.fallbackExecutor` 保持 `null`
   （不自动切换执行器）。
10. **协作模式：三层 / 两层，由成员构成推导**（v3.4 追加，见 §3.14）：并非所有
    工作都值得走满三层。群内**有** `reviewer` 角色成员 = 三层；**无** = 两层
    （协调者兼任检视者的写 spec 职责，跳过 L3）。**不新增 `groups.mode` 列或
    任何平台配置项**——平台不需要知道模式（两模式的唯一差异是协调者要不要
    再下发一个 L3 检视任务，而检视任务在平台眼里只是普通 task），且冗余标记
    会与成员表漂移。两层模式下协调者**按需加载 reviewer skill** 承担其职责 A，
    严禁把 Grill/To-Spec 复制回 coordinator skill。

## 1. 背景与目标

当前 coordinator skill 集"对齐需求（Grill）→ 写 spec（To-Spec）→ 下发（Dispatch）→
验收（Verify）"于一身，spec 生成与下发/验收耦合在单一角色内。平台角色目录
（`GROUP_ROLES`）已预留 `reviewer` 且能力映射（`code-review → reviewer`）已存在，
但既无对应 skill，也无对应逻辑落地。

目标：形成严格的三角色职责分离 + 三层检视闭环：

**角色（每个参与者在一个群内只能持有一种角色 —— 单角色约束，见 §3.7）**

1. **检视者（reviewer）**：**与用户直接对话（用户侧唯一入口）**，对齐需求（grill），
   结合代码架构生成并冻结 spec；执行需求分流判断（大需求 vs 小 bug）；执行者完成后做
   **第三层架构检视**；发现实现与预期有出入时**修订 spec**
2. **协调者（coordinator）**：据检视者冻结的 spec 下发任务；执行者完成后做
   **第二层功能检视**（对照 spec 验收标准），裁决检视发现项是否采纳并重下发
3. **执行者（executor）**：按任务书 + 关联规范实现；每次写完代码做**第一层自检**
   （Matt code-review 双轴纪律）

**三层检视**

| 层 | 执行者 | 时机 | 检查什么 | 产物 |
|---|---|---|---|---|
| L1 | 执行者（会话内） | 每次写完代码 | Standards 轴：仓库规范 + Fowler 坏味道；Spec 轴：diff 对照 spec | 汇报五段中的自检段 |
| L2 | 协调者 | 任务终态后 | **功能性**：逐条对照 spec 验收标准 | ✅ 放行 / ❌ 重下发 |
| L3 | 检视者 | L2 通过后 | **架构质量**：是否最佳实现、ADR 合规、领域词汇 | 通过 / 发现项 → 修订 spec |

**演进策略（本期 = Phase 1）**：检视编排由三个 skill 的纪律承载，平台不建编排引擎；
检视请求/结论复用**任务通道**（L3 = 检视任务），载荷用结构化 JSON（字段名对齐未来的
`review_requests` 表），单角色约束落平台校验——保证 Phase 2 到来时是机械迁移而非重写。

### 1.1 沟通架构（三通道模型）

**用户不进群发言**：群是 agent 协作空间；前端网页只读展示 agent 间沟通与任务进度。
用户与检视者的对话发生在**检视者 runtime 的原生会话**（本机 CLI / IDE agent 会话），
不经平台群。

| 流量 | 通道 | 状态 |
|---|---|---|
| 用户 ↔ 检视者（grill/反馈/bug 报告） | 检视者 runtime 原生会话（不经平台；检视者以自身 participant 身份把结论落回群/代码库） | 🆕 纪律约定，平台零改动 |
| 协调者 → 检视者（L3 架构检视请求） | **检视任务**：检视者注册为 reviewer 执行器（executor config），L3 请求=下发 review 任务，复用任务通道（队列/spawn/完成回调/durable events/前端任务面板） | 🆕 复用 executor 基础设施 |
| 检视者 → 协调者（L3 结论） | 检视任务的完成回调 + 结构化汇报（`review_result` 载荷） | 🆕 复用完成回调 |
| 检视者 → 群（spec 冻结/修订公布） | 群消息 + 结构化 JSON 载荷 | 🆕 公布格式约定 |
| 协调者 → 执行者（任务下发） | 定向消息→task（specRef/specHash 透传） | ✅ 已有 |
| 执行者 → 协调者（完成） | durable inbox + WS hint | ✅ 已有 |
| 前端 | **只读**：群消息流（agent 消息）+ 任务面板（含检视任务）；移除用户发言入口 | 🆕 前端改造 |

诊断（为什么原"群消息总线"方案不够）：① 检视者无收件通道（非 spawn 执行器）；
② 用户移出群后 grill 对话无落点；③ 群消息 4000 字上限且无线程聚合，多轮检视对话
散乱；④ 前端混流。三通道模型逐一化解：对话→runtime 原生；请求-结论→任务通道
（平台最可靠的异步通信）；公布→群消息。

## 2. 改动范围

- `packages/backend/server/src/lib/executor-task/types.ts` — 拆分角色门槛常量
- `packages/backend/server/src/lib/control.ts` — 控制门槛常量、防回环判据、
  停止/回滚语义重写（按群隔离 + 只取消排队）
- `packages/backend/server/src/lib/executor-task/queue.ts` — dispatcher 判据、
  停止只作用排队任务、detached 模式放开到 cli、移除弱验收钩子
- `packages/backend/server/src/lib/executors.ts` — `canDispatch` 配置字段、
  内置 reviewer 执行器
- `packages/backend/server/src/routes/group/messages.ts` — 下发门槛改用
  `DISPATCH_ALLOWED_ROLES`、dispatcher 判据改用 `canDispatch`、human 角色 403
- `packages/backend/server/src/routes/group/members.ts` — 单角色校验、reviewer
  加群自动安装引导
- `packages/backend/database/src/schema/group.ts` — 注释更正（去掉"一人可多角色"）
- `packages/backend/server/src/routes/skills.ts` — `SKILL_NAMES` 增加 `"reviewer"`
- `packages/backend/server/src/lib/participant-capabilities.ts` —
  `COAGENTHUB_SKILL_CAPABILITIES` 增加 `reviewer: "coagenthub-reviewer"`
- `skills/reviewer/SKILL.md` — **新增**
- `skills/coordinator/SKILL.md` — 移除 Grill/To-Spec，新增取 spec + Dispatch
  纪律 + 限额处理 + 三层编排 + **协作模式分支（v3.4：两层时按需加载 reviewer
  skill 自行写 spec、跳过 L3）**
- `skills/executor/SKILL.md` — L1 自检闭环约束
- `skills/bugfix/SKILL.md` — 诊断/分流迁给检视者，方案与下发/验收并入协调者三层编排
- `packages/frontend/web` — Composer 按身份（human）禁用
- 新增/更新单测
- 文档同步：`CONTEXT.md`、`docs/architecture.md`、README（如含角色描述）

## 3. 详细改动

### 3.1 拆分角色门槛：下发门 vs 控制门

现状：`EXEC_ALLOWED_ROLES` 在 `executor-task/types.ts` 和 `control.ts` 各定义一份
相同的值 `["coordinator", "human"]`，语义不同（前者管下发任务，后者管停止/回滚）却
共享一个名字，容易在改一处忘改另一处。

拆开为两个独立常量，都加入 `reviewer`（human 禁言后，用户的紧急停止/需求下发只能
由检视者代为发出）：

```ts
// executor-task/types.ts
export const DISPATCH_ALLOWED_ROLES = ["coordinator", "human", "reviewer"] as const;

// control.ts
const CONTROL_ALLOWED_ROLES = ["coordinator", "human", "reviewer"] as const;
```

消费点：
- `queue.ts` 的 `maybeDispatchExecutorTask` 角色门槛
- `messages.ts` 的下发门槛校验（定向到执行器 participant 时）
- `control.ts` 的控制指令角色门槛（已有，改常量名与取值）

### 3.2 修正 dispatcher 判据：`canDispatch` 标记取代"是否在执行器配置表中"

**问题**（既有缺陷，本次发现）：协调者/检视者要被下发任务唤醒，必须注册为执行器
配置（`executor_config` 或内置 `DEFAULT_EXECUTORS`）。但 `messages.ts` 判定"发送者
是否可携带 dispatcher/callback 路由信息"时，用的是"发送者是否命中执行器配置"——
一旦协调者自己也是执行器，它下发任务时的 `callbackRef` 会被当作"执行器伪造
metadata"整个丢弃，导致完成事件缺少 `endpointRef`，callback-agent 直接 `fail`，
重试 10 次后进 `dead`（`packages/callback-agent/src/callback-agent.ts:157`）。
这条链路在协调者/检视者需要"下发任务 + 会话延续"时是硬阻断，必须先修（详见
§3.5 会话延续需求）。

**修正**：`ExecutorConfig` 新增可选字段：

```ts
// lib/executors.ts
export interface ExecutorConfig {
  // ...既有字段
  /** 该执行器同时也是下发方（协调者/检视者 runtime），其发出的消息可携带
   *  dispatcher/callback 路由信息。默认 false（纯执行器）。 */
  canDispatch?: boolean;
}

const DISPATCH_CAPABLE_KEYS = new Set(["reviewer"]);
```

`DEFAULT_EXECUTORS` 与 DB 行合并时（`effectiveExecutors` / `rowToConfig`）按 key
在 `DISPATCH_CAPABLE_KEYS` 中则置 `canDispatch: true`（Phase 1 不新增 DB 列，纯
代码派生；协调者本身走 `task-dispatcher` 之类的 REST 直连身份，不需要注册为
executor，除非要用 detached 会话延续——见 §3.5）。

`messages.ts` 判据由：

```ts
const senderIsExecutorForDispatcher =
  sender !== undefined && (await findExecutorByParticipantName(db, sender.name));
```

改为：

```ts
const senderExecutor =
  sender !== undefined ? await findExecutorByParticipantName(db, sender.name) : undefined;
const senderIsPureExecutor = senderExecutor !== undefined && !senderExecutor.canDispatch;
const canCarryDispatcher =
  membership.roles.some((r) => (DISPATCH_ALLOWED_ROLES as readonly string[]).includes(r)) &&
  !senderIsPureExecutor;
```

既有测试「执行器伪造 metadata：不写入（即便执行器持有 coordinator 角色）」
（`test/dispatcher-fields.test.ts`）用的是 CodeBuddy 执行器（无 `canDispatch`），
判据不变，测试原样通过。

同样的判据修正应用到 `control.ts` 的防回环检查（见 §3.3）。

### 3.3 停止/回滚重新设计

**语义变更（Breaking，v2.1 未涉及，本次决策）**：

- **停止（"停止/取消/停一下/stop [taskId]"）只能取消排队中的任务。** 运行中任务
  不可通过用户指令中断，只能等其进入终态（done/failed/cancelled-by-timeout）后由
  协调者下发修正任务（fix-forward）。
- kill 运行中任务进程组的机制（`spawn({ detached: true })` + `process.kill(-pid,
  SIGKILL)`）**代码保留**，但只由服务端自身的静默超时（`stallTimeoutMinutes`）与
  执行超时（`EXECUTOR_TIMEOUT_MS`）触发，不再接受用户指令触发。
- **停止/回滚按 `groupId` 隔离**：`stopRunningTask` 拆分为只处理排队任务的
  `cancelQueuedTasks(groupId, taskId?)`；`currentRunningTask` / 
  `queuedExecutorTaskCount` 加 `groupId` 参数，`handleRollback` 的前置检查
  （"有任务执行中或排队中不可回滚"）改为只看本群。

**实现**：

`executor-task/queue.ts`：

```ts
/** 只取消本群排队中的任务；taskId 缺省 = 本群全部排队任务。运行中任务不受影响。 */
export function cancelQueuedTasks(
  groupId: string,
  taskId?: string,
): Array<{ taskId: string; participantId: string; ex: ExecutorConfig }> {
  // 与原 stopRunningTask 的"排队中"分支逻辑一致，但只遍历
  // groupKey 属于该 groupId 的队列（groupKey = projectPath || `group:${groupId}`
  // 的映射关系需要从 GroupQueue 记录 groupId，若当前结构未记录则补充该字段）。
}

export function currentRunningTask(groupId?: string): {...} | null { /* 加 groupId 过滤 */ }
export function queuedExecutorTaskCount(groupId?: string): number { /* 加 groupId 过滤 */ }
```

> 实现要点：`GroupQueue` 目前以 `project_path`（或默认组）为 key，一个 group 的
> 任务未必独占一个 queue key（多个群可共享 project_path）。`cancelQueuedTasks` /
> `currentRunningTask` / `queuedExecutorTaskCount` 的 `groupId` 过滤要落在
> `QueuedRun.groupId` 字段上（该字段已存在于 `QueuedRun` 类型），而不是 queue key
> 本身——同一 queue 里混有多个群的任务时，只筛选匹配 groupId 的条目。

`control.ts`：

```ts
async function handleStop(db, groupId, taskId) {
  const stopped = cancelQueuedTasks(groupId, taskId);
  if (stopped.length > 0) {
    // 🛑 已取消 N 个排队任务（沿用现有回传格式，文案改"取消"不用"停止"）
    return;
  }
  if (taskId && currentRunningTask(groupId)?.taskId === taskId) {
    // ⛔ 任务 <id> 已在执行，不支持中断；请等待完成后下发修正任务
    return;
  }
  // ⛔ 当前没有排队中的任务
}

async function handleRollback(db, groupId, taskId) {
  if (currentRunningTask(groupId) || queuedExecutorTaskCount(groupId) > 0) {
    // ⛔ 有任务执行中或排队中，请等待完成后再回滚（本群判定）
  }
  // ...其余逻辑不变
}
```

防回环判据（谁的消息不触发控制指令）与 §3.2 同款修正：

```ts
const senderExecutor = sender && (await findExecutorByParticipantName(db, sender.name));
if (senderExecutor && !senderExecutor.canDispatch) {
  // 跳过：发送者是纯执行器（防回环）
  return;
}
```

否则协调者/检视者一旦注册为执行器（§3.5 要求），会连自己发控制指令的权限也被
防回环逻辑挡掉。

### 3.4 移除弱验收钩子（本次决策，取代 v2.1/早期草稿的 commitMode 方案）

**决策**：`verifyTaskCommitted`（done 判定前额外校验 git HEAD 是否变化/工作树是否
干净）与 `hasSkipCommitMarker`（`## Acceptance: skip-verify` / `## CommitMode:
none` 两个任务书标记）**整段移除**，不再用配置项（`commitMode` 等）豁免，直接
删掉这层检查。

**理由**：
- 这层检查原本是为了防止执行器"什么都没做就回报成功"，但它把 done 判定绑在了
  工作区的 git 状态上——检视任务、协调者的编排任务、纯只读排查任务都不产生
  提交，天然会被误判 failed，需要靠标记/配置反复豁免，治标不治本。
- 它假设"进程退出 = 可以立刻检查 git 状态"，但在自举场景（用 CoAgentHub 调度
  任务去修改 CoAgentHub 自身代码）下，这个假设本身就脆弱：执行器写完文件、
  server 端热重载/并发访问 git 状态之间没有隔离保证。
- **验收的真正依据应该是执行器自己的结构化汇报**（`parseTaskReport` 解析的
  "提交/测试/汇报/遗留"四段 + 进程 exit code），不是平台自己再对工作区做一次
  旁路检查。exit code 非 0 本来就会走失败分支（详见 `runOne` 的 `result.code
  === 0` 判断），已经是唯一的"完成"信号来源。

**实现**：删除 `queue.ts` 中 `if (result.code === 0)` 分支里调用
`verifyTaskCommitted` 的整段代码（含 `hasSkipCommitMarker` 判断），以及
`hasSkipCommitMarker`/`verifyTaskCommitted` 两个导出函数本身（确认无其他调用点后
一并删除，不留死代码）。`done` 判定简化为：`exit code === 0` → 解析汇报 → 落库
`done`；`exit code !== 0` → 原有失败/重试/额度冷却分支不变。

**连带影响**：`ExecutorConfig` 不再需要 `commitMode` 字段（§3.4 早期草案的
方案作废）；reviewer 执行器配置里也不需要设它。

### 3.5 会话延续（detached 模式放开到 CLI）

**需求**（本次讨论明确的三条，取代 v2.1 对该问题的沉默）：

1. 检视者的上下文由用户/检视者 runtime 自行决定，平台不管；平台只需保证协调者
   结案时的回传，能送达检视者**下发 L3/协调请求时**所在的会话（`sessionRef`）。
2. 协调者下发任务与收到执行者回调，必须落在同一个会话里。
3. 执行者每次执行与其 L1 自检落在同一个会话里（现状已满足，零改动）。

**问题**：`callbackRef.sessionRef` + callback-agent 的 `resume <sessionRef>` 已经
是"回传送达指定会话"的机制，但触发条件是**下发者发起的那个 task 进入终态**。
CLI 执行器的终态判定 = 进程退出。协调者/检视者作为"下发完就退出"的 CLI 进程，
它们发起的 task 会在进程退出的瞬间就变成 done——这只代表"已接单"，不是"链路
真正完成"。

**解法**：`## ReplyMode: detached` 语义（发送即视为已派发，不等结果，task 保持
running，由收件方之后主动 `PATCH` 终态）目前只对 `kind=a2a` 生效
（`queue.ts` 中 `isA2a && /replymode:\s*detached/i`）。放开到 `kind=cli`：

```ts
const detached = /^\s*##\s*replymode\s*:\s*detached\s*$/im.test(body);
// 去掉 isA2a && 前缀；CLI 分支同样识别该标记
```

CLI detached 任务的行为调整（与现有 a2a detached 分支对齐，复用同一套
`detachedTimer` / `handleDetachedTimeout` 兜底）：
- 进程 spawn 后立即视为"已派发"，不等待进程退出决定终态，task 保持 `running`
- **不解析 stdout 汇报**（因为不是终态判定依据）
- 队列槽位照常释放（`group.running = null`，避免占住组队列）
- 弱验收钩子已整体移除（§3.4），本条不再适用
- 终态由收件方（协调者/检视者的下一个会话）通过
  `PATCH /api/groups/:id/tasks/:taskId` 回写；超过 `detachedTimeoutMinutes`
  （默认 1440 分钟）未回写 → 按"结果未确认"处理

**落地方式**：

- 协调者要被检视者唤醒（收 L3 结论前的等待），需注册为 `kind=cli` 的执行器
  配置（`canDispatch: true`），任务书套 detached；具体
  bin/args 指向协调者所用 CLI 的 resume 能力（与 reviewer 同构，业务方部署时
  配置，不在本 spec 固化具体命令）。
- 检视者→协调者的"请求下发/交 spec"任务、协调者→检视者的"L3 检视任务"，
  下发方都要在任务书里带 `## ReplyMode: detached`，并在 `callback.sessionRef`
  中填自己当前会话 id。
- 收件方结案后必须显式 `PATCH status=done`（或 `failed`）——**这是新增的人为
  失误面**：忘记回写，只能等 24 小时 `detachedTimeoutMinutes` 兜底判"结果未
  确认"。skill 层要把"结案先 PATCH 再继续"写成硬约束。

### 3.6 新增检视者 skill（`skills/reviewer/SKILL.md`）

新建 `coagenthub-reviewer` skill，两大职责：

**职责 A：对话用户 + 需求分流 + 生成 spec**

1. **与用户直接对话**——检视者是用户侧唯一对话入口：用户的需求、反馈、bug 报告都
   先到检视者这里。**对话发生在检视者 runtime 的原生会话**，不经平台群（群内
   human 角色只读）；检视者把结论（spec 冻结/修订）以自身 participant 身份公布
   回群。
2. **需求分流（检视者自行判断）**：
   - **大需求 / 新功能**：走完整流程（grill → 写/更新 spec → 冻结公布 → 交协调者
     下发）；
   - **小 bug**：**不新增、不更新 spec**——直接请协调者下发修正任务（可引用相关
     既有 specRef 作为上下文）；
   - **例外**：仅当 bug 或其修复**影响到了 spec 里的描述**（行为、结构、契约与
     spec 所写不一致，或修复需要改写 spec 表述）时，才修订 spec（版本 +1、修订
     记录、公布 `spec_amended`）。
   - 判断权完全在检视者，不依赖协调者或用户裁决。
3. **对齐需求（Grill）**——沿用 grilling 纪律。
4. **检视代码架构**——读取 `CONTEXT.md`、`docs/architecture.md`、`docs/adr/`；
   缺失 Matt 脚手架时提示协调者先初始化。
5. **写 spec**——`specs/<feature>.md`，沿用现有模板。
6. **冻结并公布**——commit 冻结，群内公布 `specRef` + `specHash`。
7. **架构治理入口**（本次讨论新增，v2.1 未提及）：检视者除被动接收 L3 检视任务
   外，也可主动发起架构治理（重构提案、补 ADR）——同样走"写 spec → 公布 → 请
   协调者下发"，不额外开通道。

**职责 B：第三层架构检视（L3，检视任务模式）**

1. **认领检视任务**——收到任务书（含 `review_request` 载荷）。
2. **执行检视**——读 spec + 读实现 diff，检查架构质量；**不检查功能正确性**。
3. **回发结论**——完成回调按汇报契约提交 `review_result` 载荷。
4. **修订 spec**——发现问题属设计层面时：编辑 spec（版本 +1、修订记录）→ commit
   冻结 → 群内公布 `spec_amended`。

**内置约束**：检视者不实现代码、不做功能验收、不直接向执行者发消息（发现项一律
经协调者裁决转发）。检视者**可以**下发任务（给协调者）——这一点与 v2.1 一致，
但要点明：这是 §3.1/§3.2 放开 `DISPATCH_ALLOWED_ROLES`/`canDispatch` 之后才成立
的能力。

### 3.7 单角色校验

`members.ts` 的 POST（添加成员）与 PATCH（改角色）都校验 `roles.length ≤ 1`，
违反返回 400。`schema/group.ts` 注释中"One participant may hold multiple roles"
作废并删除；"同一 participant 在不同群可持不同角色"保留。存量多角色数据不迁移，
仅拦截新增/更新。

### 3.8 human 群内只读

`messages.ts` 的 POST/PATCH/DELETE 消息端点，在成员资格校验通过后追加：

```ts
if (membership.roles.includes("human")) {
  throw new BizError(BizCodeEnum.Forbidden, "群是 agent 协作空间，请与检视者 agent 直接对话");
}
```

GET / WS 订阅不受影响，`isMessageVisibleToMember` 的"human 全可见"规则不变——
用户仍可在网页旁观全部消息，只是不能发言/编辑/删除。Local User（非群成员）不
受本条影响，其 POST 本就过不了成员资格检查。

### 3.9 前端 Composer 按身份禁用

不做全局只读。当前身份在该群持 `human` 角色时隐藏输入框并显示引导文案；其他
身份（含非 human 但已注册的 agent 身份）保留输入能力，用于手动调试定向消息。

### 3.10 检视载荷约定（与 v2.1 一致）

```json
// 协调者 → 检视者：L3 检视任务内容
{"type":"review_request","layer":3,"taskId":"<被检视任务id>","specRef":"specs/x.md","specHash":"...","diffSummary":"..."}

// 检视者 → 协调者：检视任务汇报段中的结论
{"type":"review_result","layer":3,"taskId":"<被检视任务id>","verdict":"pass|findings","findings":[{"severity":"...","note":"..."}]}

// 检视者 → 群：spec 冻结公布（首发）/ 修订公布
{"type":"spec_published","specRef":"specs/x.md","specHash":"...","summary":"..."}
{"type":"spec_amended","specRef":"specs/x.md","specHash":"<新>","reason":"..."}
```

### 3.11 协调者 / 执行者 / bugfix skill 改造

**`skills/coordinator/SKILL.md`**：
1. 移除 Grill 段（归检视者）。
2. 移除 To-Spec 段（不再自写 spec）。
3. 新增「取 spec」段——必须有 `specRef`+`specHash` 才能 Dispatch。
4. Dispatch 保留；`task.specHash` 是验收钉子。**新增「Dispatch 纪律」子段**（本次
   讨论追加，源于实测教训——见下）：单张任务书只对应 spec 里的**一个内聚关注点**
   （通常是一个小节或一组紧密相关的文件），不把 spec 的多个小节/多组不相关文件
   一次性塞进同一张任务书，即使 spec 自己的阶段划分（如某个"批次"）把它们归在
   一起，Dispatch 前也要按文件集合/关注点再拆分成多张任务书，宁可多几轮
   下发-验收，也不要一张票扛太多。任务书越大，执行器执行到一半被打断（额度/
   超时/环境问题）时留下的半成品状态越难收拾，也越难做 L2/L3 检视——检视是
   逐条对照验收标准，任务书关注点越单一，检视越准。
5. **新增「限额处理」子段**（本次讨论追加）：执行器返回限额错误
   （429 / `rate limit` / `quota` /「使用量已超出频率限制」等，探测模式见
   `scripts/dispatch-policy.json` 的 `rateLimit.detectPatterns`）时：
   - **不判该票失败、不换执行器、不缩减范围**——限额是外部资源约束，与任务
     内容无关，换执行器等于用一个未经验证的执行者去接一张已经写好的票，
     反而引入新的不确定性；
   - 从失败输出解析限额重置时间（平台的 `parseRateLimitRecoveryMs` 已实现该
     解析；解析不出则退回 `cooldownMinutes` 固定冷却，缺省 300 分钟）；
   - 等待到重置时间之后，**重新下发同一张票**——任务书内容、`specRef`、
     `specHash` 全部不变；
   - 等待期间在群内说明正在等限额，不要静默停滞（否则旁观者无法区分
     「在等限额」与「链路挂死」）。
   - `rateLimit.fallbackExecutor` 缺省为 `null`（不自动切换到备用执行器）；
     若未来要启用自动切换，需先确认备用执行器与原执行器在该项目上的能力等价。
6. 验收段升级为三层编排：L2 功能检视 → ❌ 重下发 / ✅ 下发 L3 检视任务
   （detached + review_request 载荷）→ 读 `review_result`
   裁决 → 结案（`PATCH` 自己那个来自检视者的 detached 任务为 done，见 §3.5）。

**`skills/executor/SKILL.md`**：
1. 明确「关联规范」段由检视者产出。
2. L1 自检未通过（有未修复的 Standards/Spec 轴发现项）不得发完成回调。
3. 任务书模板 / 汇报五段契约不变。

**`skills/bugfix/SKILL.md`**：
Triage/Diagnose（现 `### 1`/`### 2`）迁移进 reviewer skill 的需求分流职责；
`To-Fix-Spec`（现 `### 3`）改为协调者的"方案描述"，不落 `specs/`，直接进任务书
body；Dispatch/Verify（现 `### 4`/`### 5`）并入 coordinator skill 的三层编排。
该文件精简为指向 reviewer/coordinator 对应段落的索引，或直接删除并在 AGENTS.md
更新引用（视实现时判断，以不产生死链接为准）。

### 3.12 服务端接线（skills 路由 / capabilities / 加群引导）

- `routes/skills.ts`：`SKILL_NAMES` 增加 `"reviewer"`。
- `lib/participant-capabilities.ts`：`COAGENTHUB_SKILL_CAPABILITIES` 增加
  `reviewer: "coagenthub-reviewer"`。
- `routes/group/members.ts`：roles 含 `reviewer` 时自动发 `coagenthub-reviewer`
  安装引导。

### 3.13 文档同步

- `CONTEXT.md`：角色词汇表补检视者职责、「三层检视」「验收钉子」「会话延续
  （detached）」词条。
- `docs/architecture.md`：§9 角色流转图更新为 检视者→协调者→执行者 + 三层检视
  回路；停止/回滚语义按 §3.3 更新（只取消排队 + 按群隔离）；detached 不再限定
  a2a。
- README/README_CN（如含角色/流程描述）同步。

### 3.14 协作模式：三层 / 两层（由成员构成推导，平台零改动）

> **v3.4 新增。** 本节是对 §1「三角色三层检视」的补充——并非所有工作都值得走满
> 三层。本节定义**两层模式**（协调者兼任检视者职责，只有协调者 + 执行者），
> 以及模式如何被识别。

#### 3.14.1 决策：模式由成员构成推导，不落平台字段

**模式 = 群成员里有没有 `reviewer` 角色成员。**

| 群内有 `reviewer` 角色成员 | 模式 | 检视层 |
|---|---|---|
| 有 | **三层** | L1 执行者自检 + L2 协调者功能检视 + L3 检视者架构检视 |
| 无 | **两层** | L1 执行者自检 + L2 协调者功能检视（协调者兼任写 spec 职责，不做 L3） |

**不新增 `groups.mode` 列、不新增任何平台配置项、不新增 API 字段。**

理由（三条，按重要性排）：

1. **平台不需要知道模式。**两种模式唯一的行为差异是「协调者 L2 通过后要不要再
   下发一个 L3 检视任务」。而「检视任务」在平台眼里就是一条普通的定向消息 →
   task，body 里带一段 JSON 载荷而已——平台不解析它、不编排它、不因它改变任何
   调度行为。让平台读懂 `mode` 等于开始建编排引擎，与 §5「不建平台编排引擎」
   和 `CONTEXT.md` 的既有取向直接冲突。
2. **存了会漂移。**若同时存在 `mode` 字段与成员表，两者可能不一致（标记为三层
   但群内无 reviewer 成员 → 协调者下发 L3 必然找不到目标而失败）。此时以哪个
   为准？**成员表才是决定「L3 能不能真的下发成功」的唯一事实**，冗余标记只是
   多制造一处可能说谎的地方。
3. **切换模式天然一致。**加/踢一个 reviewer 成员即完成模式切换，不存在「改了
   标记忘了改成员」或反之的窗口。

**前端与展示**：需要展示模式时按上述规则**实时推导**（成员列表已含 `roles`，
`GET /api/groups/:id/members` 一次请求即可判定），不要缓存成状态字段。

#### 3.14.2 两层模式：协调者必须取回写 spec 的能力

**问题**：§3.11（票 11）已从 `skills/coordinator/SKILL.md` 移除 Grill 与 To-Spec
段，并明写「You do NOT write specs」「`specRef` 或 `specHash` 任缺其一：不得
下发」。两层模式下群内无检视者、无人公布 `spec_published`，协调者将**永远拿不到
`specRef`+`specHash`，永远无法下发**——硬卡死。

**解法：按需加载 reviewer skill，不复制内容。**

`skills/coordinator/SKILL.md` 的「取 spec」段增加模式分支：

- **Dispatch 前先判定模式**：读群成员（`GET /api/groups/:id/members`），检查是否
  存在 `roles` 含 `reviewer` 的成员。
- **三层模式（有 reviewer）**：现行流程**完全不变**——向检视者取冻结 spec，
  识别 `spec_published` / `spec_amended` 载荷，缺 `specRef`/`specHash` 不得下发。
- **两层模式（无 reviewer）**：协调者**自行承担检视者的职责 A**——
  `GET /api/skills/reviewer` 取回该 skill，按其「职责 A」执行：与用户对齐需求
  （grill）→ 检视代码架构 → 写 `specs/<feature>.md` → commit 冻结 → 群内公布
  `spec_published`。**冻结与 `specHash` 不可省略**：验收钉子在两层模式下同样是
  L2 检视的对照基准。

**明确禁止把 Grill/To-Spec 段落复制回 coordinator skill**——两份同样的纪律会
各自演化并逐渐不一致，而这正是三角色拆分最初要消除的问题。coordinator skill 里
只写一句指向（「无 reviewer 成员时，按 reviewer skill 的职责 A 自行完成需求对齐
与 spec 冻结」），reviewer skill 是这套纪律的唯一事实来源。

#### 3.14.3 两层模式的验收编排

`### 4. 验收编排` 段增加模式分支：

- **三层**：L2 功能检视 → ❌ 重下发 / ✅ 下发 L3 检视任务（detached +
  `review_request` 载荷）→ 读 `review_result` 裁决 → 结案。**完全不变。**
- **两层**：L2 功能检视 → ❌ 重下发 / ✅ **直接结案**，跳过 L3。结案时若存在
  上游 detached 任务（如由人类或外部触发链路），仍须 `PATCH` 回写终态——该硬
  约束与模式无关。

#### 3.14.4 取舍说明（写进 skill，供协调者与用户判断）

两层模式换来更少的 agent 跳转（省 token、省延迟）与更少的失败环节，代价必须
写明，否则选择是盲目的：

- **L3 变成自审**：协调者刚做完 L2 功能检视，紧接着用同一上下文做架构检视——它
  对「这个实现方案好不好」是有立场的（方案某种程度上由它下发）。L3 单独成角色的
  核心价值是**新鲜的眼睛**，合并后该价值基本归零。
- **写 spec 与验收 spec 变成同一方**：三层设计中「检视者出 spec、协调者按 spec
  验收」构成天然交叉校验；合并后，spec 写得模糊时验收也会照模糊标准放行，无人
  能发现。

**选择建议**（写进 coordinator skill）：小改动、bug 修复、边界明确的小需求走
**两层**；涉及架构决策、新模块、会写进 ADR 的工作走**三层**。这与 §3.6 检视者的
需求分流规则同构——只是把「要不要写 spec」的分流，提升为「要不要开三层」的分流。

#### 3.14.5 部署差异（顺带解决 L3 开箱失败）

内置 reviewer 执行器（§3.12）的 `bin` 是占位标识 `"reviewer"`，**未设
`EXECUTOR_BIN_REVIEWER` 时下发 L3 检视任务会以 `spawn reviewer ENOENT` 失败**
（实测确认）。同理，协调者若要使用 §3.5 的 detached 会话延续，需自行
`POST /api/executors` 注册为可被唤醒的执行器（内置列表不含协调者条目）。

因此：

- **两层模式开箱即用**——不下发 L3，不依赖 `EXECUTOR_BIN_REVIEWER`。
- **三层模式需要额外部署配置**——必须设置 `EXECUTOR_BIN_REVIEWER` 指向检视者
  runtime 的实际 CLI 命令。

该前置条件此前在 `CONTEXT.md` / `docs/architecture.md` / `docs/usage.md` 中**均无
记载**，属文档缺口，随本节一并补齐（见 §3.15）。

### 3.15 文档补充（v3.4 增量）

- `CONTEXT.md`：新增「协作模式（三层 / 两层）」词条——模式由成员构成推导、
  两层下协调者兼任写 spec、两层跳过 L3 及其取舍。
- `docs/architecture.md`：§9 补协作模式说明与推导规则；补
  **`EXECUTOR_BIN_REVIEWER` 是三层模式的部署前置条件**（未设置则 L3 任务
  `spawn reviewer ENOENT`）；补协调者若要用 detached 会话延续需自行注册执行器。
- `docs/usage.md` / `docs/usage_CN.md`：环境变量表补 `EXECUTOR_BIN_REVIEWER`
  （及 `EXECUTOR_BIN_<KEY>` 通用覆盖规则的说明，若尚未记载）。

## 4. 验收标准

- [ ] `DISPATCH_ALLOWED_ROLES`（executor-task/types.ts）与 `CONTROL_ALLOWED_ROLES`
      （control.ts）拆分为独立常量，均含 `coordinator/human/reviewer`
- [ ] `ExecutorConfig` 新增 `canDispatch?: boolean`；`messages.ts` 的
      dispatcher/callback 判据改用 `!canDispatch`（而非"是否命中
      执行器配置"）；既有「执行器伪造 metadata」测试不改断言仍通过
- [ ] `control.ts` 防回环判据同样改用 `!canDispatch`
- [ ] 停止指令只取消排队中任务，不再 kill 运行中任务（单测覆盖：排队任务被取消；
      运行中任务不受影响且回传"不支持中断"提示）
- [ ] `cancelQueuedTasks` / `currentRunningTask` / `queuedExecutorTaskCount` /
      回滚前置检查均按 `groupId` 过滤（单测覆盖：A 群停止指令不影响 B 群排队/
      运行中任务）
- [ ] `verifyTaskCommitted`/`hasSkipCommitMarker` 及其调用点已整体移除；
      `done` 判定仅依据 exit code + `parseTaskReport` 解析结果
- [ ] `## ReplyMode: detached` 对 `kind=cli` 执行器同样生效（不再要求 `isA2a`）；
      CLI detached 任务：spawn 后立即释放队列槽位、task 保持 running、不解析
      stdout 汇报、超时兜底复用现有 `detachedTimer`/`handleDetachedTimeout`
- [ ] 内置 `reviewer` 执行器配置：`canDispatch: true`
- [ ] `skills/reviewer/SKILL.md` 已创建：职责 A + 职责 B + 架构治理入口 + 内置
      "不实现代码/不做功能验收/不直连执行者"约束
- [ ] `skills/coordinator/SKILL.md` 已移除 Grill/To-Spec；含"取冻结 spec"
      "specHash 验收钉子""L2→L3→结案"完整编排，结案步骤含"先 PATCH detached
      任务为 done 再继续"的显式提示
- [ ] `skills/executor/SKILL.md` 明确关联规范段来源为检视者；含"L1 自检通过才可
      发完成回调"
- [ ] `skills/bugfix/SKILL.md` 已按 §3.11 精简/改造，不产生死链接
- [ ] 检视载荷 JSON（review_request/review_result/spec_published/spec_amended）
      格式在 reviewer/coordinator 中一致
- [ ] `routes/skills.ts` SKILL_NAMES 含 `reviewer`；`GET /api/skills/reviewer`
      返回 200
- [ ] `participant-capabilities.ts` 含 `reviewer: "coagenthub-reviewer"`
- [ ] `members.ts`：roles 含 reviewer 触发安装引导；`roles.length > 1` 返回 400；
      `schema/group.ts` 注释已更正
- [ ] `messages.ts`：human 角色 POST/PATCH/DELETE 群消息返回 403；agent 角色不
      受影响（单测覆盖）
- [ ] 前端：human 身份下群消息页无发言入口；其他身份不受影响
- [ ] **（v3.4）协作模式**：`skills/coordinator/SKILL.md` 的「取 spec」段含模式
      判定（读群成员，有无 `reviewer` 角色）；三层分支行为完全不变；两层分支
      指向 `GET /api/skills/reviewer` 的职责 A 自行 grill + 写 spec + 冻结公布，
      **未复制 Grill/To-Spec 段落内容**
- [ ] **（v3.4）** 「验收编排」段含模式分支：三层走 L2→L3→裁决→结案；两层 L2
      通过即结案、跳过 L3；结案 PATCH 上游 detached 任务的硬约束与模式无关
- [ ] **（v3.4）** coordinator skill 写明两层模式的取舍（L3 变自审、写 spec 与
      验收 spec 同一方）与选择建议（小改动/bug 走两层，架构决策走三层）
- [ ] **（v3.4）** 平台零改动：无 `groups.mode` 列、无新增 API 字段/配置项
- [ ] **（v3.4）文档**：`CONTEXT.md` 含「协作模式」词条；`docs/architecture.md`
      §9 含模式推导规则 + **`EXECUTOR_BIN_REVIEWER` 是三层模式部署前置条件**
      （未设置则 L3 任务 `spawn reviewer ENOENT`）+ 协调者用 detached 需自行
      注册执行器；`docs/usage.md` 与 `usage_CN.md` 环境变量表含
      `EXECUTOR_BIN_REVIEWER`
- [ ] pnpm test 全绿、check-types 通过、build 通过（backend + frontend）
- [ ] `CONTEXT.md` 与 `docs/architecture.md` 反映三角色 + 三层检视 + 会话延续 +
      停止/回滚新语义

## 5. 不涉及的改动（Phase 1 边界）

- **不做 A2A gateway 的 `tasks/cancel` 集成**——本次不依赖 A2A，停止只覆盖排队
  任务，运行中任务的 A2A 侧真实中断留待未来需要时再做
- **不建链级中止（chainId + 停止整条链）**——本次的"停止"作用于单个 task；
  要中止一条跨多个 task 的检视链路，需要先给任务加链路标识，这是更大的机制，
  Phase 2 再评估
- **不建 `review_requests` 表 / review 状态列**——Phase 2 再做
- **不做 spec 版本库/多版本存储**——Phase 3；本期用"版本号 +1 + 修订记录"承载
- **不建平台编排引擎**——检视链路编排全部在 skill；平台不解析检视 JSON、不校验
  specHash 一致性
- **不建用户↔检视者的平台私聊会话 API**——对话走检视者 runtime 原生会话
- **不改任务书模板**（buildTicket）与汇报五段契约——检视任务书复用同一模板
- **不改 `GROUP_ROLES`**（reviewer 已存在）
- **不强制全任务走满三层**——检视深度是策略，写在协调者 skill；v3.4 已将该策略
  具体化为「三层 / 两层」两种协作模式（见 §3.14）
- **（v3.4）不新增 `groups.mode` 列或任何模式配置项**——模式由群成员构成实时
  推导（有无 `reviewer` 角色成员），平台不感知模式、不因模式改变任何行为
- 不新增 npm 依赖，不新增数据库迁移（`canDispatch` 为代码派生配置，不落 DB 列）

## 6. 兼容性

- **（v3.4）协作模式为纯增量，非 BREAKING**：现有群若已有 `reviewer` 成员，
  推导为三层模式，行为与 v3.3 完全一致；无 reviewer 成员的群此前本就无法
  完成「取 spec」（协调者会被卡在等待 `specRef`+`specHash`），v3.4 的两层分支
  恰好修复了这一死锁，属能力补齐而非行为变更。无需迁移、无需数据改动。
- **（v3.4）三层模式的部署前置条件被显式化**：内置 reviewer 执行器的 `bin` 是
  占位标识，未设 `EXECUTOR_BIN_REVIEWER` 时 L3 检视任务会以
  `spawn reviewer ENOENT` 失败（实测确认）。该前置条件此前无文档记载，
  §3.15 补齐；两层模式不受影响（不下发 L3）。
- **BREAKING：human 角色群内禁言**（POST/PATCH/DELETE 群消息 403）——存量用户
  若依赖群内发消息触发任务的流程将中断；迁移路径：与检视者 runtime 会话对话，
  由检视者→协调者链路下发。前端 Composer 同步按身份隐藏
- **BREAKING：单角色校验**——存量多角色成员读取不受影响，下次改角色时被拦截，
  需拆分为多个 participant
- **BREAKING：停止指令不再能中断运行中任务**——存量依赖"停止能 kill 正在跑的
  任务"的使用习惯需改为：等待任务终态后下发修正任务；紧急场景下唯一手段是
  直接杀 server 进程（超出平台 API 范围，运维操作）
- **BREAKING（潜在）：dispatcher 判据变更**——若已有部署把某个执行器错误标记为
  `canDispatch`，会导致该执行器的消息不再被"防回环"拦截；本次 `canDispatch`
  默认 `false`，且仅 `DISPATCH_CAPABLE_KEYS`（当前仅 `reviewer`）派生为 `true`，
  不影响现有 CLI 执行器（atomcode/codebuddy/reasonix/codex）
- 既有 coordinator 已产出的 spec 仍有效；仅后续新 spec 由检视者负责
- 任务书解析、汇报五行解析、durable completion events、回滚控制指令均不受影响
  （回滚本身语义不变，只是前置检查改为按群判定）；检视任务本身也可被"取消"
  （排队阶段）
- 已安装旧版 coordinator/executor skill 的参与者需重新拉取
- 与 `specs/spec-driven-task-dispatch.md` 的关系：spec 生成属权移交检视者，
  "实现方案定稿前不得下发"约束不变
- 与 `specs/skill-enforcement-and-ticket-slim.md` 的关系：执行流程仍由 skill
  承载、任务书只触发 skill——检视编排同理进 skill，平台只提供任务/消息/角色
  原语
- 与既有检视流程协议（`review-workflow.test.ts`，草稿可见性模型）的关系：本
  spec 的三层检视替代该草稿-检视-终稿消息流；该测试随实现一并更新

## 7. 建议的实现批次（供执行者/协调者参考，非强制顺序）

**粒度原则**（本次讨论追加，取代早期"四大批"划分——见下方教训）：**一张任务书只
对应一个内聚关注点**，源码改动与它配套的测试改动、提交，在同一张任务书里一次
完成，不要"这一票先把源码全改完，测试留到下一票"——执行器的会话/额度/环境
随时可能中断，改动范围切得越小，中断后留下的半成品状态越容易诊断和丢弃重来，
每一票也更容易做 L2/L3 检视（逐条对照验收标准时，关注点单一的票更准）。

> **教训**：本 spec 最早的"批次1"把 §3.1–§3.5（5 个小节、7 个文件）打包成一张
> 任务书下发，执行器两次尝试都在中途被打断——第一次只改完 1 个文件就撞见热
> 重载崩溃留下语法错误；第二次把全部源码改完、类型检查通过，但"测试留到最后
> 补"的阶段被打断，源码和测试各自处于不同完成度，验收时才发现。拆细之后不会
> 出现这种"进度分散在多个维度、任何一个维度中断都说不清整体状态"的情况。

按以下更细的票拆分（每票源码+测试+提交打包为一次下发-验收循环）：

**通信修正（原批次1，拆为5票，§3.1 是其余各票的前提）**
1. §3.1 角色门拆分：`types.ts` + `control.ts` 常量、消费点、配套测试
2. §3.2 dispatcher 判据：`executors.ts` 的 `canDispatch` 字段 + `messages.ts` +
   `control.ts` 防回环、配套测试
3. §3.3 停止/回滚重设计：`queue.ts` 的 `cancelQueuedTasks`/`groupId` 过滤 +
   `control.ts` + barrel 导出面、配套测试（含跨群隔离用例）
4. §3.4 移除弱验收钩子：`queue.ts` 删除 `verifyTaskCommitted`/
   `hasSkipCommitMarker` 及调用点、删除/改写相关旧测试
5. §3.5 detached 放开到 CLI：`queue.ts` 的 CLI detached 分支、配套测试

**reviewer 接线（原批次2，拆为3票）**
6. §3.6 新增 `skills/reviewer/SKILL.md`（纯文档）
7. §3.7 单角色校验：`members.ts` + `schema/group.ts` 注释、配套测试
8. §3.12 服务端接线：`routes/skills.ts` + `participant-capabilities.ts` +
   `members.ts` 加群引导 + `executors.ts` 内置 reviewer 配置、配套测试

**human 禁言（原批次3，拆为2票，均为 Breaking，需先确认迁移路径已就绪）**
9. §3.8 human 群内只读：`messages.ts` POST/PATCH/DELETE 403、相关测试重写
   （`e2e-acceptance.test.ts`、`review-workflow.test.ts` 等）
10. §3.9 前端 Composer 按身份禁用

**skill 文案与文档（原批次4，风险最低，可合并为2票）**
11. §3.11 coordinator/executor/bugfix 三个 SKILL.md 改造（纯 Markdown）
12. §3.13 文档同步：`CONTEXT.md`、`docs/architecture.md`、README

**协作模式（v3.4 新增，2票；依赖票 11 已完成的 coordinator skill 结构）**
13. §3.14 coordinator skill 增加模式分支：「取 spec」段的模式判定 + 两层分支
    （按需加载 reviewer skill）、「验收编排」段的模式分支（两层跳过 L3）、
    取舍说明与选择建议。纯 Markdown，平台零改动
14. §3.15 文档补充：`CONTEXT.md` 协作模式词条、`docs/architecture.md` §9 模式
    推导规则与 `EXECUTOR_BIN_REVIEWER` 部署前置条件、`docs/usage.md` 与
    `usage_CN.md` 环境变量表。纯 Markdown
