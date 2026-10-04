# COM3 运行中需求变更闭环：接线调查报告与分仓实现草案

- 文档性质：**设计调查报告 + 实现草案**。本文不代表任何功能已实现，也不宣称运行闭环已跑通。
- 本票范围：仅本文件。未改任何生产源码、测试、`.coagent/` 或其他文档。
- 证据等级约定：
  - **【已核实】** 在本跳里直接读过源码/类型声明/配置得到的签名与行号，可回指定位。
  - **【历史证据】** 由上一跳（L2）产出、本跳**不重复运行**的结论。
  - **【proposed】** 方案建议，尚未有实现或运行证据。
  - **【未验证】** 无证据支撑、不应当被当成事实的部分。

> **一句话结论：** 一个正在跑的 agent 子进程，无法通过"把新工单写回 Hub"就当场知道工单变了。当前 `SpawnRuntime` 的 stdin 是**一次性写入后立即 EOF**，`coagent-pi` 的适配器**从不调用 SDK 的 steer**。因此"在途变更"必须新增一条显式接线；本票只**设计**它，不实现它。

---

## 0. 本票边界与阅读方式

- 本文落实 L3 已答复的技术通路：**HTTP 唯一持状态 Hub，无 IPC**；生产 Hub 托管的 pi Attempt 绑定该唯一 Hub；pi 自身开发票保留独立状态，**不迁 3101、不开第二 writer**。
- 五条 acceptance 对应 Contract 1–5，映射见 §5.1。
- 章节目录：§1 源码事实 · §2 最小方案 · §3 数据与恢复 · §4 实施草案 · §5 可行性与未验证。
- 所有涉及改变运行行为的接线都标 **【proposed】**，实施前须由 L3 冻结成实现票。

---

## 1. 源码事实

> 对应 Contract 1。本章只记录**读到的**接口事实，并明确一条红线：**单纯写入修订 ≠ 在途 agent 收到或应用**。

### 1.1 Contract 修订与 pause：不是 abort

【已核实】

- `src/kernel/mission.ts:722 reviseContract()`：终态上抛 `IllegalTransitionError`；否则覆盖 `#contract`、`#contractRevision += 1` 并返回新修订号。**它只改 Mission 上的字段，没有任何"通知在途运行"的语义。**
- `src/application/platform/mission-lifecycle.ts:5 reviseContract()`（用例层）：写契约后
  - 当 `mission.status === 'executing' || 'awaiting_review'` 时调 `mission.sendBackToPlanning(...)`；
  - 记 `contract.revised` 事件（载荷 `{ contractRevision, status }`）。
  - 注释明确：早先只在 `awaiting_review` 退回，实测中途改需求时**工单已派出、调度器照样先跑执行者**，等 L2 被叫醒时按旧契约做的东西已经做完。这就是本 Mission（COM3）要解决的那个故障。
- `src/kernel/mission.ts:310 sendBackToPlanning()`：`#goto('planning')` 并冻结 `#finalReview`。这是**状态回退**，不是杀进程。
- `src/kernel/mission.ts:368 pause()`：仅 `#paused = true`（终态抛错）；`src/application/platform/mission-lifecycle.ts:55 pauseMission()` 只记 `mission.paused` 事件。
- 因此：**revise / pause 都不断开、不 kill 任何在途 `AgentRun`。** 平台此刻能做的只是改状态与记事件；正在跑的子进程照旧跑完它手里那份 spec。
- 编排器侧确实有一处"旧队列项不启动 Agent"的护栏：`src/application/orchestrator.ts:2437`（`live.status === 'completed' || 'blocked'` → `cancelled_by_user`）与 `src/application/orchestrator.ts:2444`（`live.contractRevision !== view.contractRevision` → `target_changed`）。**但这两条只挡"下一跳要不要启动"，挡不住"已经启动、正在跑"的那一跳。**

### 1.2 冻结的 WorkOrder 不能在途 revise

【已核实】

- `src/application/platform/work-orders.ts:42 reviseWorkOrder()`：
  - `ctx.requireAttempt(missionId, attemptId, 'coordinator')` —— **只有协调者身份**能改工单。
  - 命中 `REVISE_BLOCKED_HINT[item.status]` 即抛 `WORK_ITEM_NOT_REVISABLE`。
- `src/application/platform/work-order-helpers.ts:10 REVISE_BLOCKED_HINT`：
  - `dispatched`: 正在执行中，改不了：等执行者交卷（或报告卡住）后再修订，或先作废重建。
  - `submitted`: 已有执行结果待验收，先 review 再决定是否修订。
  - `accepted` / `retired`: 不可修订，须 L3 打回后重建。
- kernel 侧同样挡：`src/kernel/work-item.ts:250 reviseOrder()` 只在 `created | rejected | blocked` 允许，其它状态抛 `IllegalTransitionError`；`orderRevision` 由 `nextOrderRevision()` 机械递增（`r1 → r2 …`）。
- **结论（关键）：** 一旦工作项进入 `dispatched`，**平台上没有任何一条"改这张在途工单"的现成路径**。这正是为什么"运行中需求变更"不能靠 `reviseWorkOrder` 达成——它必须形成**新的差异**并交回 L2 判断，而不是就地改字段。这也决定了本方案只能走"新增 change 记录 + 新增监督 hop"这类**叠加**路径。

### 1.3 AgentRuntime / AgentRun：有 on/abort/wait，没有 steer

【已核实】

- `src/application/ports.ts:130 AgentRuntime`，`start(spec: AgentRunSpec): Promise<AgentRun>`（`ports.ts:140`）。
- `src/application/ports.ts:143 AgentRunSpec` 字段：`role`、`attemptId`、`missionId`、`workItemId?`、`cwd`、`profile`、`instruction`（**已渲染好的首轮输入**）、`tools`、`resumeRef?`、`endpoint: { baseUrl, token }`（`ports.ts:176`）。
- `src/application/ports.ts:196 AgentRun` 只有三个方法：`on(handler)`、`abort(reason)`、`wait()`，外加 `resumeRef`。
  - **没有 `steer`、没有 `send`、没有第二输入通道。** `on` 只往外发 `RuntimeEvent`（`output` / `runtime.capabilities` / `tool.started` / `tool.completed` / `usage`，见 `ports.ts` 中 `RuntimeEvent` 联合），是**单向观测**，不是双向。
- `instruction` 在 spec 里是字符串、一次性，平台没有"替换 instruction 后重发"的接口。
- **结论：** 平台与在途 run 之间**当前不存在下行数据通道**。任何"让在途 agent 知道契约变了"的方案，都必须**新增**这条通道——要么改 runtime 端口形状，要么在适配层内部另开一条轮询通路（§2 选后者，理由见 §2.1）。

### 1.4 SpawnRuntime：stdin 一次写入后立即 EOF

【已核实】

- `src/runtime/spawn.ts:291 async start(spec)`：
  - `spawn(command, args, { stdio: ['pipe','pipe','pipe'], shell: win32, detached: !win32, env: filterSpawnEnv(...) })`。
  - `src/runtime/spawn.ts:321`：`child.stdin?.end(JSON.stringify(spec));` —— **写入整份 spec 后立刻 `end()`**。
- `src/runtime/spawn.ts` 超时是**静默超时**（`timeoutMs` 是"多久没输出"，不是总时长），`abort()` → `killTree(child)`（Windows `taskkill /T /F`，POSIX 负 pid 杀进程组）。
- `src/runtime/spawn.ts` 解析 stdout 行：`__COAGENT_OUTCOME__ ` 结果行、`__COAGENT_EVENT__ ` 结构化事件行；`outcome` 里 `endedBy` 由适配器给出。
- **结论：** stdin 在 `start()` 同步阶段就关闭了，**运行期间平台无法再往子进程 stdin 写一个字节**。这直接否掉了"通过 stdin 追加消息"的廉价方案。

### 1.5 coagent-pi：EOF 启动 + subscribe 观测 + 单次 prompt

【已核实，路径 `C:/program1/coagent-pi/.coagent-worktrees/integration/`】

- `src/agent-entry.ts:18 readStdin()` 读到 EOF；`src/agent-entry.ts:25` `const raw = await readStdin();` —— 入口**读完 stdin 直到 EOF 才解析 spec 并 `startRun`**。与 1.4 的 `stdin.end()` 正好配对：平台写完整份 spec 就关，适配器读到 EOF 就知道 spec 到齐了。
- `src/runtime.ts:705`：`const { session } = await createAgentSession({ cwd, model, thinkingLevel, modelRuntime, resourceLoader, sessionManager, tools: toolAllowlist(spec.role) });`
- `src/runtime.ts:758`：`const unsubscribe = session.subscribe((event) => { … })` —— 订阅 `message_update` / `tool_execution_start` / `tool_execution_end` / `agent_end`，转成 `__COAGENT_EVENT__` 行写 stdout。这是**观测**，不是注入。
- `src/runtime.ts:833`：`await session.prompt(spec.instruction);` —— **一次首轮 prompt**。
- `src/runtime.ts:844`：PI-END1 的第二次 `session.prompt(reminder)`：执行者没做终结提交时，在**同一会话**再问一次（每程最多一次）。**这是现有代码里唯一一处"运行中追加消息"的形态，但它是固定触发、固定内容的补救轮，不是平台可驱动的新输入通道。**
- `grep steer|streamingBehavior|message_start` 在集成 worktree 的 `src/runtime.ts` 里**零命中** —— 适配器**从不**调用 SDK 的 steer / streamingBehavior。
- 结论：**pi 适配器自己没有"运行中收变更"的能力，也没有用上 SDK 已有的 steer。**

### 1.6 本地 SDK：steer / prompt streamingBehavior / subscribe / message_start 的声明与版本

【已核实，仅本地只读解析，无网络】

- 解析路径（本地 node_modules）：`C:/program1/coagent-pi/node_modules/@earendil-works/pi-coding-agent/`。
- 版本：`package.json` → `"name": "@earendil-works/pi-coding-agent"`，`"version": "0.87.1"`；`coagent-pi/package.json:11` 依赖锁定 `"@earendil-works/pi-coding-agent": "0.87.1"`。
- `dist/core/agent-session.d.ts`：
  - `prompt(text: string, options?: PromptOptions): Promise<void>`；
  - `PromptOptions.streamingBehavior?: "steer" | "followUp"`（`agent-session.js:1245` 未指定时 `throw new Error("Agent is already processing. Specify streamingBehavior …")`；指定了则走 `_queueSteer` / `_queueFollowUp`）；
  - `steer(text, images?, options?: { source? }): Promise<void>`（`agent-session.js:1415` → `_queueUserInput(..., "steer", ...)` → `_queueSteer`，进 `this._steeringMessages.push(text)` 并 `this.agent.steer({...})`）；
  - `subscribe(listener: AgentSessionEventListener): () => void`（`agent-session.d.ts:305`）；
  - `message_start` 事件类型声明在 `dist/core/extensions/types.d.ts:659`（`type: "message_start"`），订阅入口 `types.d.ts:1006`；`agent-session.js:1523` 在 `sendUserMessage` 后 emit `message_start`，`agent-session.js:559` 在 `message_start && role === "user"` 处有消费逻辑。
- **语义边界（必须写清）：** steer 的注释是 "Delivered after the current assistant turn finishes executing its tool calls, before the next LLM call." —— 它证明的是**排队 + 消费**：SDK 会把它塞进队列，并在下一个 LLM 调用前消费。它**不证明**模型读懂了内容、也不证明执行者按新契约改了做法。
- **结论：** SDK 具备能力，适配器未使用。**SDK 的排队承诺 ≠ 应用。** 报告后续一律区分「排队/消费」与「应用」。

### 1.7 修订快照与简报：只有"读路径"

【已核实】

- `src/application/platform/startup-brief.ts`：
  - `contractRevision?`（`:39`）、`planRevision?`；
  - `:145 contractRevision: mission.contractRevision` 进 `ContextBundle`；
  - `:134` 找 `contract_check.submitted` 事件时要求其 `contractRevision === mission.contractRevision`，即**只把"对应当前修订"的核对结论放进简报**，旧修订的核对被跳过（旧简报形状不变）。
- 也就是说：**简报在每次 `start` 时一次性渲染**（`AgentRunSpec.instruction` 由它产出），中途契约变了，**已跑起来那一跳手里的 `instruction` 不会变**。

### 1.8 历史证据与本次不重复项

- 【历史证据】上一跳（L2）做过一次 **EOF 离线实验**：确认 `stdin.end()` 后适配器读到 EOF 即启动，进程**退出码 0**。本跳**不重复运行**该实验（见 doNot「不要为本票执行草案中的部署、测试或启动命令」）。
- 本次未运行任何代码测试、未启动服务、未联网、未跑真实 agent（符合本票 verification 只含文档检查）。

### 1.9 §1 的净结论

1. 平台→在途 run **没有下行通道**（1.3 + 1.4）。
2. 在途用 `reviseWorkOrder` 就地改工单**被状态机与用例层双重禁止**（1.2）。
3. 契约修订/pause **不 abort 在途**（1.1）。
4. SDK **有能力**（steer/queue），**适配器没用**（1.5/1.6）；且即便用上，也只证明排队/消费。
5. 因此："**写入修订** → **runtime 送达** → **执行者开始按更新运行**"是三个**必须分开陈述、分开取证**的阶段，绝不可以用第一个冒充第三个。

### 1.10 接口输入输出结构示例（源码形状，非调用记录）

> 本节**不新增任何事实**，只把 §1.1–§1.7 已核实的签名落到可复制的结构上，供实施票直接引用。
> **下面每一段都是「源码结构示例，非实际调用记录」**：`id` / `hash` / `endpoint` / `token` 一律占位；本票
> **没有**发起任何真实调用，也没有任何生产运行证据。凡标 **【proposed】** 的是本设计新造的协议形状，平台与
> SDK 目前都不存在它——**不得**与上面已核实的源码结构混读。

#### 1.10.1 `reviseContract`：入参契约 + 返回新修订号

引用位置：`src/application/platform/mission-lifecycle.ts:5-25`（签名与 return）、`src/kernel/mission.ts:722`（真正的字段改写与 `#contractRevision += 1`）。

```ts
// 源码结构示例，非实际调用记录 —— mission-lifecycle.ts:5
reviseContract(
  ctx: PlatformContext,
  answerEscalation: AnswerEscalation,
  missionId: 'M-PLACEHOLDER',
  contract: { /* MissionContract，例：{ goal: '…', criteria: [...] } */ },
): Promise<{ contractRevision: number }>

// return 形状（同函数 `return { contractRevision }`）
{ contractRevision: 3 }   // 数字，来自 kernel `#contractRevision += 1`
```

- 平台侧可观测的只有两条：`mission.reviseContract()` 改了字段；同函数内 `ctx.event(mission, 'contract.revised', { contractRevision, status })`。
- **它不返回、也不携带任何「在途 run 是否收到」的信息。** 见 §1.1、§1.9。

#### 1.10.2 `reviseWorkOrder`：dispatched 时的错误形状

引用位置：`src/application/platform/work-orders.ts:42-108`（函数体）、`src/application/platform/work-order-helpers.ts:10-15`（`REVISE_BLOCKED_HINT`）、`src/kernel/work-item.ts:250`（kernel 侧第二道）。

```ts
// 源码结构示例，非实际调用记录 —— work-orders.ts:42
reviseWorkOrder(
  ctx, missionId: 'M-PLACEHOLDER', attemptId: 'A-PLACEHOLDER',
  workItemId: 'W-PLACEHOLDER', order: { /* WorkOrder，占位 */ },
): Promise<{ workItemId: string; revision: string; changedFields: readonly string[]; warnings: readonly WorkOrderStandardWarning[] }>

// 成功形状（直接调用不带 viaCoordinatorTool 时无 warnings 键）
{ workItemId: 'W-PLACEHOLDER', revision: 'r2', changedFields: ['acceptance'] }

// dispatched 时的失败：先撞 REVISE_BLOCKED_HINT，抛 PlatformRuleError
throw new PlatformRuleError(
  'WORK_ITEM_NOT_REVISABLE',
  `工作项 W-PLACEHOLDER 正在执行中，改不了：等执行者交卷（或报告卡住）后再修订，或先作废重建。`,
)
```

- hint 文案逐字取自 `work-order-helpers.ts` 的 `REVISE_BLOCKED_HINT.dispatched`；`revision` 由 kernel `nextOrderRevision()` 机械递增（`r1 → r2 …`），不是协调者填的。
- 即便绕过用例层，kernel `reviseOrder()` 也只在 `created | rejected | blocked` 放行（§1.2）。两道门合起来就是「冻结工单不能在途 revise」的字面形状。

#### 1.10.3 `AgentRunSpec` 与 `start()` 返回的 Run

引用位置：`src/application/ports.ts:130`（`AgentRuntime`）、`:140`（`start`）、`:143-176`（`AgentRunSpec`）、`:196-201`（`AgentRun`）。

```ts
// 源码结构示例，非实际调用记录 —— ports.ts:140
start(spec: AgentRunSpec): Promise<AgentRun>

// AgentRunSpec 形状（ports.ts:143-176；endpoint / instruction 是重点）
{
  role: 'executor',                    // 'coordinator' | 'executor' | 'independent_reviewer' | 'query'
  attemptId: 'A-PLACEHOLDER',
  missionId: 'M-PLACEHOLDER',
  workItemId: 'W-PLACEHOLDER',         // 可选
  cwd: '…/worktrees/PLACEHOLDER',
  profile: { endpoint: 'https://profile-endpoint.invalid', profileId: 'profile-PLACEHOLDER' },
  instruction: '【已渲染好的首轮输入】（简报正文，占位）',
  tools: ['read', 'grep', 'bash'],
  endpoint: { baseUrl: 'https://hub.invalid', token: 'TOKEN-PLACEHOLDER' },
  // resumeRef?: string（续跑句柄，可选）
}
```

- `instruction` 是**一次性字符串**：平台没有「替换 instruction 后重发」的接口（§1.3 / §1.7）。
- `endpoint` 指唯一 Hub，运行时只拿到 token、**不自述身份**（`ports.ts` 该字段注释）。

```ts
// AgentRun 形状（ports.ts:196-201）—— start 解析出来的 Run
{
  resumeRef: undefined,                              // string | undefined
  on(handler: (event: RuntimeEvent) => void): () => void,
  abort(reason: string): Promise<void>,
  wait(): Promise<RuntimeOutcome>,
}
```

- **没有 `steer`、没有 `send`、没有第二输入通道**——这是 §1.3 结论的字面形状。

#### 1.10.4 `on` 的 `RuntimeEvent` 与 `wait` 的 `RuntimeOutcome`

引用位置：`src/application/ports.ts:204-234`（`RuntimeEvent` 联合）、`:287-326`（`RuntimeOutcome`）。

```ts
// 源码结构示例，非实际调用记录 —— on(handler) 收到的 RuntimeEvent（单向观测）
{ kind: 'output', text: '…' }
{ kind: 'runtime.capabilities', commandActivityClassification: 'v1' }
{ kind: 'tool.started', name: 'bash', callId: 'call-PLACEHOLDER', detail: 'node --test …', activityClass: 'command' }
{ kind: 'tool.completed', name: 'bash', callId: 'call-PLACEHOLDER' }
{ kind: 'usage', usage: { /* TokenUsage，占位 */ } }
// 没有 kind 表示「平台下行注入」——on 只往外发，不能往里写。

// wait() 的 RuntimeOutcome（ports.ts:287-326）
{
  endedBy: 'completed',                // AttemptEndReason：上游失败与「没交结构化结果」分开
  usage: { /* TokenUsage，占位 */ },
  resumeRef: 'resume-PLACEHOLDER',     // 可选
  failureMessage: undefined,           // 仅 endedBy === 'upstream_failure' 时的原文
  output: '…尾部输出…',                // 可选，Timeline 第三层用
  toolCalls: ['read', 'bash'],         // 可选，Timeline 第二层用
  resolvedProfile: { revision: 'rev-PLACEHOLDER', resolved: [{ key: 'k', value: 'v' }] }, // 可选
}
```

- **`RuntimeOutcome` 里没有「契约已变」这类信号**——这正是 §2.2 所说的、编排这一跳阻塞在 `run.wait()` 时拿不到变更的原因。
- `RuntimeEvent` 是**单向观测**、不是双向；平台没有下行通道（§1.3）。

#### 1.10.5 `SpawnRuntime.start`：stdin 一次写入后立即 EOF

引用位置：`src/runtime/spawn.ts:291`（`start`）、`:321`（`child.stdin?.end(...)`）。

```ts
// 源码结构示例，非实际调用记录
const child = spawn(options.command, [...options.args], {
  cwd: options.cwd,
  env: filterSpawnEnv(envSource, envPassthrough),
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
  detached: process.platform !== 'win32',
});
child.stdin?.end(JSON.stringify(spec));   // spawn.ts:321 —— 写完整份 spec 立刻 end()
```

- 配对侧：coagent-pi `…/integration/src/agent-entry.ts:18`（`readStdin()`）/ `:25`（`await readStdin()`）读到 **EOF** 才解析 spec 并启动。
- 因此**运行期平台无法再往子进程 stdin 写一个字节**（§1.4）。

#### 1.10.6 当前 SDK（`@earendil-works/pi-coding-agent@0.87.1`）的 prompt / steer / subscribe

引用位置（本地只读，无网络）：`C:/program1/coagent-pi/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts:152-163`（`PromptOptions`）、`:305`（`subscribe`）、`:417`（`prompt`）、`:427-437`（`steer` 注释与签名）；`dist/core/agent-session.js:1245`（streaming 未指定 behavior 时抛错）、`:1415`（`steer` → `_queueUserInput(..., "steer", ...)`）。适配器侧本节未改：`…/integration/src/runtime.ts:705`（`createAgentSession`）/ `:758`（`session.subscribe`）/ `:833`（`session.prompt(spec.instruction)`）。

```ts
// 源码结构示例，非实际调用记录 —— agent-session.d.ts
prompt(text: string, options?: PromptOptions): Promise<void>                       // :417
// PromptOptions（:152）
{ expandPromptTemplates?: boolean; images?: ImageContent[];
  streamingBehavior?: 'steer' | 'followUp'; source?: InputSource }

steer(text: string, images?: ImageContent[], options?: { source?: InputSource }): Promise<void>   // :435

subscribe(listener: AgentSessionEventListener): () => void                         // :305，返回解绑函数

// 运行中（isStreaming）不指定 streamingBehavior → 抛（agent-session.js:1245）
new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.")
```

- **返回语义按字面读：** `prompt` / `steer` 都返回 `Promise<void>`——**只承诺「已入队 / 已受理」，不返回任何「模型已读 / 已应用」的凭据**。`steer` 的注释（`agent-session.d.ts:427-437`）是 "Delivered after the current assistant turn finishes executing its tool calls, before the next LLM call."，即排队 + 在下一个 LLM 调用前消费。
- **`subscribe` 是观测**：适配器 `…/integration/src/runtime.ts:758` 用它把事件转成 stdout 行，**不是注入**。
- 现状对照：适配器从不调用 `steer`（§1.5，`grep steer` 在集成 worktree 零命中）。**SDK 的排队承诺 ≠ 应用**（§1.6 / §1.9）。

#### 1.10.7 【proposed】本设计新增的协议形状（当前不存在）

> 以下**不是**源码事实，是本设计**建议**的、平台与 SDK 现在都没有的形状；单列在此以便与上面已核实结构区分，**须由 L3 冻结后才可实施**。

```ts
// 【proposed｜待实现】ChangeRecord —— §3.1 的形状（字段名未经 L3 冻结）
{
  changeId: 'CH-PLACEHOLDER', purpose: 'impact',
  missionId: 'M-PLACEHOLDER', workItemId: 'W-PLACEHOLDER',
  targetAttemptId: 'A-PLACEHOLDER', claimGeneration: 7, seq: 12,
  source: 'L3 确认',
  baseSnapshotHash: 'HASH-PLACEHOLDER', targetSnapshotHash: 'HASH-PLACEHOLDER2',
  diff: '（L2 形成的明确工单差异正文）',
  receipt: {
    saved: true,                 // 平台保存
    adapter_received: false,     // runtime 送达（弱证据）
    session_consumed: false,     // SDK 消费（≠ 应用）
    executor_started: false,     // 执行者开始按更新运行（自述）
    verified: false,             // 独立证据
  },
}
```

- receipt 分层见 §2.6 / §3.5：`adapter_received` ≠ `session_consumed` ≠ `executor_started` ≠ `verified`，每层只承认自己的证据。
- **不得**把 `receipt.saved`、SDK 的排队承诺、或一次 Delivery ACK 当作「已应用」；更不得用只读查询（如 `coagent_get_validation_report` 这类读路径）反过来证明变更已在在途 run 上生效。

---

## 2. 最小方案

> 对应 Contract 2。设计由 L2 定，本章只做**证据化的落地描述**，不另选架构。

### 2.1 通路：HTTP/run-token 持久 inbox，pi 在 prompt 运行时 poll 并 steer

【proposed，但接口面全部基于 §1 的已核实事实】

- 载体：**Hub 侧新增一个持久变更 inbox**，按 run token（即 `RunTokenRegistry` 里那张牌）寻址，见 `src/api/run-tokens.ts`（`RunContext` 已有 `token/missionId/attemptId/role/workItemId?/claim?`）。
- pi 侧在 `session.prompt(spec.instruction)` **运行期间**轮询该 inbox：轮询命中"本 attempt 的变更未消费"，就 `await session.steer(renderedDiff)`（`agent-session.d.ts` 的 steer）。
- **不改 stdin 协议**：`agent-entry.ts` 仍旧 EOF 读 spec；`spawn.ts:321` 的 `stdin.end()` 原样保留。理由是 §1.4——stdin 已在 start 阶段关闭，且"进程边界即依赖边界"是现有设计前提，改它代价最大、收益最小。
- **为什么是"poll + steer"而不是"push + abort/restart"**：
  - 重启动代价 = 杀掉一个**可能已经做对大半**的 run，还要重算预算、重走 worktree 回滚；
  - steer 是 SDK 已声明的运行时能力，**不需要改平台 runtime 端口形状**（`AgentRun` 保持只有 on/abort/wait）；
  - 失败面可控：轮询拿不到东西就是没变更，不改变正常一跳的行为。
- **必须标注的语义缺口（不掩饰）：** steer 只保证"排队并在下一次 LLM 调用前消费"。**它不等于执行者应用。** 因此 §3 的分层状态里，`session_consumed` 与 `executor_started`（更别说 `verified`）是**不同层**，且 `executor_started` 的模型 ACK 依旧是**自述**。
- 新增接线全部标 **【proposed｜待实现】**。

### 2.2 L1 正在运行、Orchestrator 卡在 run.wait 时，变更怎么走

场景还原（基于 §1 已核实事实）：`src/application/orchestrator.ts:2033` 起 `heartbeat = setInterval(...)`，`src/application/orchestrator.ts:2076` `outcome = await run.wait();` —— **编排这一跳此刻阻塞在 `run.wait()`，它拿不到"契约已变"的返回值**（`RuntimeOutcome` 里没有这个信号）。

因此最小方案把"变更的接收与判断"放在**Hub 侧、同 writer 监督**，而不是放在阻塞中的 `run.wait()` 里：

1. **L3 确认原始需求**（§2.3）：产出一份 `changeId` 变更记录，绑定目标 `missionId`。
2. **Hub 同 writer 监督**：【proposed】在 Mission 处于 `executing`、且存在在途 run 时，允许一个**监督 hop**在**同一写者**下运行——它只做两件事：
   - 把变更**投影**成"对当前在途工单的明确差异"；
   - 决定"是否需要影响当前这一次运行"。
3. **唯一 L2 impact Attempt**：对每份变更，只允许**一个** in_progress 的"影响判断"协调者 Attempt（沿用 kernel 不变量 B：`src/kernel/mission.ts:521 startCoordinatorAttempt()`，同一 Mission 同一时刻只能有一个 in_progress coordinator Attempt）。
   - 它的职权是**只读/判断**：读 Mission/工单/变更事实，产出一份**明确差异**结论；
   - **它不得派发、不得验收、不得合入**（见 2.4 的互斥与验收禁令）。
4. **明确差异交给 L1**：只有 L2 形成的"明确工单差异"才下发给正在跑的运行（§2.5 的 inbox）。
5. **L1 不自行解释目标**：执行者收到的是差异正文，不是"用户想干什么"的原始需求——原始需求由 L3 确认，避免执行者自行重解释目标（红线：不重新定义目标）。

**三阶段必须分开陈述：**

| 阶段 | 事实来源 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| 平台保存 | Hub 持久库（`changeId` 记录） | Hub 已收到并留存变更 | 在途 run 是否知道 |
| runtime 送达 | inbox 投递 + pi 轮询命中（`adapter_received/queued`） | 适配器已把内容交给 SDK 队列 | 模型是否读到 |
| 执行者开始按更新运行 | `session_consumed` / `executor_started` / `verified` | 见 §3.5 分层，逐层加证据 | 单靠前者不可外推 |

**特别禁令：** **不得**把 steer 的排队承诺（"会被消费"）或一次 Delivery ACK（收件箱 `status: 'acknowledged'`）当作"已应用"。`src/application/delivery.ts` 的 inbox 现有 v1 只有 `pending → acknowledged` 两态、没有租约/死信 —— 它连"runtime 送达"都只能算弱证据，更不能当"应用"。

### 2.3 原始需求由 L3 确认

- **原始用户需求由 L3 确认**，L1（执行者）不得自行解释目标。
- 变更记录里 `source` 必须是"L3 确认"，而不是 agent 从上下文里推断出来的意图。
- 平台只负责把"L3 确认过的变更"变成"对某个在途工单的**可判定差异**"；判断"这算 compatible 还是 replan 还是 cancel-replace"仍是 L2 职责（`src/application/platform/mission-lifecycle.ts` 注释明确写了 S14.6：compatible / replan / cancel-replace 是 L2 的判断，不是平台的）。

### 2.4 kernel 唯一 coordinator + 持久唯一槽 + 限权 token

【proposed，接口沿用现有机制】

- **kernel 唯一 coordinator 保留**：`src/kernel/mission.ts:521 startCoordinatorAttempt()` 的"同一 Mission 同时只允许一个 in_progress coordinator"不变量不动。impact 监督 hop 也必须是 coordinator 身份，因此受同一不变量约束。
- **用 purpose/changeId 持久唯一槽**：【proposed】变更判断 hop 的队列槽（idempotency key）在现有 key 形状上加 `purpose` / `changeId` 维度。现有形状见 `src/application/durable-scheduler.ts:587 hopIdempotencyKey()`：`${missionId}:${role}:${workItemId}:r${contractRevision}:n${attemptCycle}`；`nextLogicalHopCycle()`（`:615`）保证未完成的逻辑 hop 复用同一 open 行（`retry_wait` / `dead_letter` 保留槽位，只有 `completed` 才释放）。新增维度必须**并列加在 key 里**，不能改现有字段含义，否则会污染普通 hop 的幂等。
- **带候选 hop claim 与 generation 发限权 token**：领到 hop 后按 `src/application/orchestrator.ts:1889`（`#trustedQueueClaim(claimedHop)` → `startCoordinator`）发放 claim 冻结的 token（`src/api/run-tokens.ts` 的 `issue` 冻结 `claim { id, owner, claimGeneration }`）。impact hop 的 token 必须是**限权**的——它的 `PolicyAction` 集合应剔除派发/验收/合入类动作（现有动作名清单见 `src/application/policy-engine.ts` 的 `POLICY_ACTION`）。
- **普通 L2 互斥**：impact 监督 hop 与普通协调者验收互斥（同一 coordinator 不变量 + 限权 token 双重保证）。**普通 L2 的验收/合入路径不为本能力开门**：`src/application/platform/work-item-review.ts:8 reviewExecutionResult` 的 accept 语义、`finalize*` 动作都不因本能力新增授权格。
- **不因 revision 全停**：`src/application/orchestrator.ts:2444` 的 `target_changed`（contractRevision 变化 → 恰好在"下一跳启动前"挡住旧队列项，**不杀在途**）保持原样。**修订号只用于来源追踪**；修订号变化**不等于**全局停机。

### 2.5 必须保留的既有机制（不改动）

- **心跳 / 双租约续租**：`orchestrator.ts:2033` 的 `heartbeat` 同时 `beatAttempt` 与 `#renewHopLease`；`#renewHopLease`（`:2567`）用 `claimGeneration` 判"租约是否还在我手上"，同毫秒续租视为 no-op 不误判丢失。
- **五维 capacity**：`src/application/durable-scheduler.ts:226 CAPACITY_DIMENSIONS = ['global','project','role','runtime','profile']`；`decideCapacityClaim()`（`:543`）；默认上限 `DEFAULT_HOP_CAPACITY_LIMITS`（fail-closed，非无限）。
- **公平性**：`orchestrator.ts` 的 `#capacityEligible` / `compareHopFairness` 只把"已有身份的未完成行 + 本 hop"放进预检，避免后到 runner 插队；`claimAvailable` 的 eligible 只能是本 hop。
- **预算 PRE/POST 及流式用量**：`orchestrator.ts:1619 #enforceAuthoritativeBudget()`（PRE/POST 合一入口，硬超 → lightweight 自检晋升或 standard wait；软超只记事件）；流式用量 `streamedUsage`（被杀进程也记账）。
- **容量不足 pending 不能跳过限额**：`orchestrator.ts:1855` 起若 `queued.wait === 'capacity'` 记 `capacityBlocked` 并 **continue/等**，绝不退回单 id claim（注释：否则会 silently 绕过五维上限）。

### 2.6 分层语义（proposed，与 §3.5 一致）

`saved` → `adapter_received`/`queued` → `session_consumed` → `executor_started` → `verified`

- `saved`：Hub 持久记录已落库（**平台保存**）。
- `adapter_received` / `queued`：pi 轮询命中共把内容交 SDK 队列（**runtime 送达**；steer 的排队承诺就在这一层）。
- `session_consumed`：SDK 消费事件（如 `message_start`，`types.d.ts:659`）表明消息被会话吸收（**消费**，不是应用）。
- `executor_started`：执行者开始按更新运行；采用**结构化模型工具 ACK + hash**，但**仍是自述**（模型说"我看到了"，不等于真的改了做法）。
- `verified`：由独立证据（如后续验收/验证报告）确认行为已符合新契约。

每层只承认自己的证据；**不得**用低层证据外推高层结论。

### 2.7 §2 的"待实现"清单

**【proposed｜待实现】**
1. Hub：持久 change inbox（按 run token 寻址）。
2. Hub：run.wait 期间的同 writer 监督 + 唯一 impact Attempt + 限权 token + 持久唯一槽。
3. Hub：对 `validation.reported` / 提交快照的归属检查（§3.7）。
4. pi：运行期轮询 inbox，命中即 `session.steer`；ACK 上报（`adapter_received/queued` / `session_consumed` / `executor_started`）。
5. 分层状态与 receipt 的持久形状（§3）。
6. 能力协商与空档部署（§4.6）。

---

## 3. 数据与恢复

> 对应 Contract 3。以下数据形状全部【proposed】，字段名未经 L3 冻结；但**行为约束**（幂等、乱序、安全边界、验收恢复）是硬要求。

### 3.1 变更记录（change record）数据形状

【proposed】核心字段：

| 字段 | 含义 | 约束 |
|---|---|---|
| `changeId` | 变更唯一 id | **幂等键**：相同 id 同内容幂等，异内容拒绝 |
| `purpose` | 用途（区分"普通工单变更"与"impact 监督"） | 参与持久唯一槽 |
| 目标 | `missionId` / `workItemId` / `targetAttemptId` / `claimGeneration` | 指向**具体在途运行**，非泛化 Mission |
| `seq` | 单调序号 | 乱序时缺口补齐 |
| `source` | 来源 = **L3 确认** | 非 L3 确认不得入库 |
| `baseSnapshotHash` | 变更前基线 snapshot 的 hash | 用于重连/漂移检测 |
| `targetSnapshotHash` | 变更后目标 snapshot 的 hash | 同上 |
| `diff` | **明确差异**（L2 形成的工单差异正文） | 非"请理解用户意图"式描述 |
| `impact` | 影响判断记录 | 指向唯一 L2 decision Attempt |
| `receipt` | 回执（分层状态） | 见 §3.5 |

- `baseSnapshotHash`/`targetSnapshotHash` 用于**关联工单变更与提交的实际 snapshot**（§3.7）。
- **`diff` 必须是明确差异**：L1 拿到的是差异，不是原始需求（§2.3），防止执行者自行解释目标。

### 3.2 冻结基线与 amendment：不放开 reviseWorkOrder

- 对 `dispatched/submitted/accepted` 的工单，**不放开 `reviseWorkOrder`**（§1.2 的状态机禁止保留）。
- 变更以 **amendment**（追加）形式落库，**不动已冻结的基线工单**。
- 冻结基线 + amendment 的组合，保证"执行者手上那份是冻结的"这条前提继续成立（这也是 `work-orders.ts` 注释里"按旧工单交的结果对不上新验收标准"要避免的事）。

### 3.3 幂等与乱序

- **相同 `changeId` + 相同内容 → 幂等**（重放不产生第二条）。
- **相同 `changeId` + 不同内容 → 拒绝**（防静默覆写；也防"同一变更被改内容后冒充同一条"）。
- **`seq` 缺口补齐**：收到 `seq = n+2` 而 `n+1` 缺失时，补齐/暂存，不得跳过。
- **旧 generation 拒绝或隔离**：`claimGeneration` 落后者（`orchestrator.ts:2567 #renewHopLease` 的判据同源）不得消费变更；无法判定时**隔离**而不是静默处理。
- **重启不复活旧 token**：`RunTokenRegistry` 是内存表（`src/api/run-tokens.ts`），重启即空；且 `revokeAttempt(missionId, attemptId)` 一次吊销该 Attempt 全部 token。变更记录上的 `targetAttemptId` 必须在重启后**找不到活 token**时显式判为"目标已消失"，**不得**凭旧记录复活。
- **旧适配器显式 pending**：未声明轮询/ACK 能力的适配器，其变更**显式停在 `adapter_received` 缺失的 pending 态**，不得当作已送达。这与 `SpawnRuntime` 的 fail-closed 风格一致（`supportsQuery` 默认不开、`envPassthrough` 未声明即抛）。

### 3.4 关联工单变更与提交实际 snapshot

- 每条变更记录绑 `baseSnapshotHash`/`targetSnapshotHash`；
- 执行者提交时记录**实际 snapshot hash**（`src/application/platform/executor-submissions.ts:26 submitExecutionResult` 已把 `executionResult` 绑到**实际提交它的** executor Attempt，并记 `orderRevision` / `contractRevision` 事件字段——扩展现有事件即可，不新造事件种类）；
- 用 hash 比对判定"这次提交验的是不是当前这次契约/工单"。

### 3.5 分层持久状态（receipt）

- 分层见 §2.6。**每层独立字段**，不允许用一个布尔"已送达"概括。
- `executor_started` 采用结构化模型工具 ACK + hash，**仍是自述**（明确写在图层语义里）。
- `verified` 只能来自独立证据（验收/验证报告），不能来自前四层。

### 3.6 安全边界（工具中兼容等，必须保留）

- **工具中兼容等安全边界继续**：现有 PI 侧拦截（写越界、危险 git 命令）与 Hub 的 policy（`src/application/policy-engine.ts`）不因本能力放宽。
- **互斥仅挡"受影响运行"的下一工具安全 abort**：变更命中某在途运行时，只对**该**运行的在途工具流做安全 abort；不波及其它 Mission/Attempt。
- **abort 前检查子进程/工作区再开**：abort 必须按现有 `killTree`（`src/runtime/spawn.ts`）连同子孙进程收干净，并检查 worktree 状态后再允许重启（`orchestrator.ts` 的 `startRevision` 回滚语义：换候选前回到干净起点）。
- **不能撤销已发生副作用**：如果那次工具已经产生了外部副作用（如已 push、已改远端），abort **不能**声称"已回滚"。回执必须如实说明，由 L2/L3 判断。

### 3.7 按最新有效契约验收并保存旧 submitted

- **按最新有效契约验收**：`reviewExecutionResult` 现有的 `contractRevision` 记在 `review.recorded` 事件上（`work-item-review.ts`）；变更场景下，验收必须对齐**最新有效**契约。
- **旧 `submitted` 不可偷改**：已经被替换的提交（`submittedAttemptId` 变化）在 `validation.report`/`review.recorded` 里的来源匹配上必须可区分（`src/application/platform/validation-report-views.ts:30` 的 `validationReportKey(workItemId, submittedAttemptId)` 正是这个键）；旧的 submittedAttemptId 记录**保留**，不覆写。

### 3.8 恢复路径

| 场景 | 恢复路径 |
|---|---|
| 乱序 | §3.3：`seq` 缺口补齐；`claimGeneration` 落后 → 拒绝/隔离 |
| 重连 | 用 `baseSnapshotHash`/`targetSnapshotHash` 判漂移；不一致 → 不静默套用 |
| 旧适配器 | §3.3：显式 pending，不伪装送达 |
| 重启 | §3.3：不复活旧 token；目标 Attempt 无活 token → 判"目标消失"，不复活 |
| 工具运行安全边界 | §3.6：只 abort 受影响运行的下一工具，检查子进程/工作区再开，副作用如实声明 |
| 关联工单 | §3.4：用 snapshot hash 关联变更与提交 |
| 最终最新验收 | §3.7：对齐最新有效契约，保留旧 submitted |

### 3.9 保持的既有约束

- **单写者**：`src/application/lock.ts` 的主锁语义不变；同 writer 监督不引入第二写者。
- **预算/权限**：既有预算 PRE/POST（`orchestrator.ts:1619`）与 policy（`policy-engine.ts`）不新增放行格（除 impact 监督的**限权**缩减集合）。
- **L2/L3 职责**：compatible/replan/cancel-replace 是 L2 判断；原始需求确认是 L3；执行者只执行明确差异。

---

## 4. 实施草案

> 对应 Contract 4。**本票不执行**以下任何部署/测试/启动命令，只记录为未来计划。所有条目均 **【proposed｜待实现】**。

### 4.0 落实 L3 答复

- **生产 Hub 托管 pi Attempt 绑定该唯一 Hub**：托管运行走 `SpawnRuntime` → `agent-entry.ts`，`AgentRunSpec.endpoint = { baseUrl, token }`（`ports.ts:176`）指向**唯一 Hub**。
- **pi 自身开发票保留独立状态**：pi 仓库里的 `reviewer-extension.ts` / `reviewer-tools.ts` 是**另一条独立状态流程**，不迁 3101，**不开第二 writer**。
- **无端口 unsupported**：不存在"用无端口 CLI 在运行时直接读状态"这条通路能当**权威运行查询**——该形态在本设计中归为 **unsupported**，只能作为本地排查手段，不能作为闭环证据。
- **未来唯一服务暴露**：独立状态 + L3 插件显式 `endpoint` / `stateId` / `instanceId` / `apiVersion` **binding**；操作需**空档冻结**（切服务前须无在途操作）。**本票不执行。**

### 4.1 reviewer hub 是 repo 路径、不是 endpoint

【已核实】

- `C:/program1/coagent-pi/src/reviewer-extension.ts:76` 从环境读 `hub` / `state` / `reviewer` / ... 配置；`reviewerConfigFromEnv` 里 `hub: env[REVIEWER_ENV.hub] ?? ""`、`state: env[REVIEWER_ENV.state] ?? ""`。
- `reviewer-tools.ts:29 L3_SCRIPT = "src/l3.ts"`、`:30 RUN_MISSION_SCRIPT`；工具执行经 `nodeCommand(config, [L3_SCRIPT, ...])` 调 CLI（如 `coagent_get_mission` → `l3 show`、inbox → `l3 inbox --recipient ... --state ...`）。**这里 `hub`/`projectRepo` 是 repo 路径/工作目录语义，不是 HTTP endpoint。**
- **CLI 写转发由 lock 动态端口**：Hub `src/l3.ts:243 forwardWriteCommand(holder, ...)` → `loopbackControlRequest(identity, ...)`，`identity` 来自 `requireLiveIdentity(holder)`（`l3.ts:145`），要求 `holder.port / instanceId / stateId / apiVersion` 齐全且 `apiVersion === API_VERSION`（`src/api/server.ts:74 API_VERSION = 'v1'`）。端口来自**锁文件里的活写者**，**不是硬编码**。
- **CLI 只读直接 state 不是权威运行查询**：`l3.ts:430` 起，`isMainStateWrite = MAIN_STATE_WRITES.has(command)`；**只读命令不抢锁**、直接读 state 文件，与写命令转发到活写者不同。只读直接读文件**绕过了活写者的实时状态**，因此**不是**权威运行查询，也**不能**替代 §4.0 的"唯一服务暴露"。
- **两条禁令**：(a) **不能误说硬编码 3101**（本跳已核实非硬编码，端口来自 lock）；(b) **不能用只读 CLI 直读 state 冒充权威查询**。

### 4.2 工单草案 A：VR 权威读取（拆 A1 / A2 两个可分开冻结的范围）

> 拆成两张单的理由：Hub 侧新增是「工具真实实现 + 归属/来源校验」，pi 侧新增是「工具注册面」。两者目录不同、可分别冻结、可分别回滚；合成一张会让 pi 注册被迫跟随 Hub 合入节奏。

#### 4.2-A1 草案 A1：Hub `coagent_get_validation_report` 只读 API 工具（run-token 身份）

- **目录范围**：`src/api/server.ts`（agent 工具表 `agentTools` 起点 `:892`；`AGENT_TOOL_ACTION` 映射在 `src/application/policy-engine.ts:226`）；`src/application/platform/validation-report-views.ts`；复用已存在的 `src/application/platform.ts:1938 getValidationReport`。
- **真实接口 / 数据流**：
  - 拟议工具（**proposed**）：`coagent_get_validation_report({ workItemId, reportId? })`。
  - **身份与 Mission 推导**：只用 `requireRun(req)`（`src/api/server.ts:783`）解析出的 `RunContext`（`src/api/run-tokens.ts:11`，含 `missionId` / `attemptId` / `role` / 可选 `workItemId`）。`missionId` **由 run token 推出**，不读请求体自述——对齐 `coagent_get_work_item` 的 fail-closed 写法（`server.ts:896`）。
  - **只限 coordinator**：`run.role !== 'coordinator'` → 403；只经 `AGENT_TOOL_ACTION` 的 agent 只读格，**不借**控制面 `missionRead` 之外的控制动作。
  - **显式 `reportId` 也必须过来源与归属校验**：`getValidationReport(ctx, missionId, reportId)`（`validation-report-views.ts:7-20`）**只保证 `report.missionId === missionId`**，即只保证 Mission 归属；它**不保证** `report.workItemId` / `report.attemptId` 对得上「本次请求的工作项与当前 submittedAttempt」。因此在 `reportId` 路径上还要补三处：
    - `report.workItemId === workItemId`；
    - `report.attemptId === item.submittedAttemptId`（当前提交 Attempt）；
    - 该 `reportId` 出现在 `validation.reported` 事件里、且该事件匹配**当前** `submittedAttemptId`（键 = `validationReportKey(workItemId, submittedAttemptId)`，`src/application/platform/agent-view-helpers.ts:269`）。
    - 任一处不匹配 → 一律「未找到」（fail-closed），不回显是哪一处不符，避免跨归属探测 `reportId`。
  - **不带 `reportId`** 时：走 `workItemValidationReportViews` 的同一套三处 `continue` 归属检查（`validation-report-views.ts:23-64`）。
- **缺证据语义（必须写死，不是顺手 reject）**：报告缺失 / 来源对不上时，**不得**据此直接判 reject 或替 L2 下结论；应**先升级**（工作项保留 `submitted` 态，不 reject），把「缺哪份证据」交回 L2/L3。只有拿到对得上的证据、再经正常验收路径，才谈 accept。理由：`getValidationReport` 是**只读查询**，不是验收权威；把一次读不到当 reject 依据，会把「查询通道缺证据」误伤成「执行者没做」。
- **依赖**：`PlatformDeps.validation.reports`（`src/application/platform/types.ts:78` / `context.ts:61`）。缺注入时 `getValidationReport` 已抛 `VALIDATION_DEPS_REQUIRED`（`validation-report-views.ts:11-14`，已有），**不新增依赖**；不引入第三方依赖（红线：只在 `pg-store.ts` 用第三方）。
- **真实既有测试接缝（必须有 API run 身份 fixture，不能只用 VR repository）**：
  - 身份接缝：`test/api.test.ts` 的现成 fixture——开 Mission → `POST /api/missions/<id>/coordinator-attempts` 拿 coordToken → 带 token 调 `/api/agent/<tool>`（协调者 run 见 `test/api.test.ts:266-320`；同文件另有「执行者 token 调协调者工具被挡」与「请求体自述身份不被采信」两条可直接照抄）。
  - 归属/来源接缝：`test/validation-report-repository.test.ts:45 sampleReport` 只提供 `ValidationReport` 形状；**只测仓储不够**——Mission 归属与三处来源校验必须在 API run 身份下用真实 HTTP 受审。
- **最少关键测试（1–2 条）**：
  1. 「API run 身份 + 跨归属 fail-closed」：协调者 token 拿 A 工作项的 `reportId` 去查 B 工作项 → 未找到；`reportId` 存在但 `attemptId` 不是当前 `submittedAttemptId` → 未找到。
  2. 「身份」：执行者 token 调 → 拒绝（沿用现有 agent 工具错误形状）。
- **优先级**：最高。Hub 侧无大协议依赖，可先于 pi 与闭环独立合入。

#### 4.2-A2 草案 A2：pi 侧 `coagent_get_validation_report` 注册

- **目录范围**：`C:/program1/coagent-pi/.coagent-worktrees/integration/src/tools.ts`（`coordinator` 的 SPECS，工具名清单见 `:94-268`；`coagentTools` `:519`、`coagentToolNames` `:559`）。**不改** `roles.ts` 的角色集合——`coordinator` 已在 `Role` 联合里，`toolAllowlist` 自动带出。
- **真实接口 / 数据流**：新增一个 `ToolSpec`（**proposed**），`execute` 里与其它工具一样走 `client.call(spec.name, body)`（`tools.ts:534`）→ `PlatformClient.call`（`platform-client.ts:56`）→ `POST /api/agent/coagent_get_validation_report`。pi 侧**不做**归属/角色判断（规则只有 Hub 一份）。
- **不借 control**：不进 `REVIEWER_TOOL_NAMES`、不碰 `reviewer-tools.ts`，只进 `coagent_*` 工具面。
- **依赖**：无新增（`typebox` 已在用）。
- **真实既有测试接缝**：`tools.test.ts`（工具注册面）、`platform-client.test.ts`（HTTP 调用形状）。
- **最少关键测试（1–2 条）**：`coagentToolNames('coordinator')` 含该名、`coagentToolNames('executor')` 不含；失败时平台文案原样回给模型。
- **依赖关系**：A2 需要 A1 端点在线才可用；但**注册可独立冻结/合入**（A1 未部署时调用得 404，不会静默放行）。

### 4.3 工单草案 B：Hub 闭环的四张可分开冻结的草案（B1–B4）

> 四块**依赖是一条链**（模型 ← impact ← 收件 ← 验收恢复），但可**分别冻结、分别实现、分别测试**。合成一张「巨单」会让冻结评审分不清哪块先跑。每块列：目录 / 实际函数 / proposed 新增接口 / 调用数据流 / 依赖 / 真实既有 fixture / 1–2 关键测试。

#### 4.3-B1 草案 B1：持久 amendment 模型与幂等（无上游依赖，先做）

- **目录范围**：新增持久变更模型，建议落在 `src/application/` 下与 `src/application/delivery.ts` 同层；仓储形状按现有风格扩进 `src/application/platform/types.ts` 的 `PlatformDeps`。
- **实际函数（既有，只参照不改语义）**：`src/application/delivery.ts` 的收件箱 v1（`:7` 注释：`pending → acknowledged`，**没有租约、没有死信、没有重投**）——只借形状，不复用其语义；持久读写风格参照 `src/application/file-store.ts`（文件版零依赖）。
- **拟议新增接口（proposed）**：`ChangeRecordRepository.append(change)` / `get(changeId)` / `listByRun(target)`；幂等键 = `changeId` + 内容 hash；`seq` 单调。
- **调用数据流**：L3 确认 → `append` 落 `saved`；同 `changeId` 同内容 → 幂等返回既有；异内容 → 抛 `PlatformRuleError` 拒绝。
- **依赖**：无（不依赖 impact / 收件 / 验收）。
- **真实既有 fixture**：`test/validation-report-repository.test.ts`（`sampleReport` `:45`，以及 append-only / 幂等 / conflict / 跨重启 / legacy 缺键断言）是**同类持久仓储测试的现成模板**（只读参考，本票不运行）。
- **最少关键测试（1–2 条）**：同 `changeId` 同内容 → 一条；同 `changeId` 异内容 → 拒绝；文件仓储跨重启仍幂等。

#### 4.3-B2 草案 B2：impact 监督——purpose/changeId 唯一槽 + 限权 + 租约/容量/预算（依赖 B1）

- **目录范围**：`src/application/durable-scheduler.ts`；`src/application/orchestrator.ts`；`src/api/run-tokens.ts`。
- **实际函数（既有，必须保持语义）**：
  - 唯一槽：`hopIdempotencyKey()`（`durable-scheduler.ts:587`）与 `nextLogicalHopCycle()`（`:615`）——**并列追加** `purpose` / `changeId` 维度，**不改**现有字段含义（否则污染普通 hop 幂等）；未完成逻辑 hop 复用同一 open 行，只有 `completed` 释放槽位。
  - 领取与租约：`#claimEnqueuedHopWithCapacity()`（`orchestrator.ts:2458`）/ `#trustedQueueClaim()`（`:2683`，只抄 id/owner/代次）/ `#renewHopLease()`（`:2567`，用 `claimGeneration` 判活租约，同毫秒续租是 no-op）。
  - 容量与公平：`CAPACITY_DIMENSIONS`（`durable-scheduler.ts:226`，五维 `global/project/role/runtime/profile`）、`decideCapacityClaim()`、`#capacityEligible()`（`orchestrator.ts:2529`）——impact hop 必须走**同一套**五维容量，**不得**退回单 id claim 绕过上限。
  - 预算：`#enforceAuthoritativeBudget()`（`orchestrator.ts:1619`，PRE/POST 合一入口）不变。
  - kernel 不变量：`startCoordinatorAttempt()`（`src/kernel/mission.ts:521`）「同一 Mission 同时只一个 in_progress coordinator」**复用不改**。
- **拟议新增接口（proposed）**：impact hop 的 `purpose='impact'` + `changeId` 维度；**限权 token**——`RunTokenRegistry.issue`（`src/api/run-tokens.ts:28`）发的 claim 冻结不变，但按 impact 身份把 `AGENT_TOOL_ACTION` / `POLICY_ACTION` 里的 `workItemDispatch` / `workItemReview` / `finalize*` 从授权面剔除。
- **调用数据流**：B1 落 `saved` → 同 writer 起 impact hop（唯一槽）→ 唯一 L2 impact Attempt（只读/判断）→ 产出明确 `diff`。
- **依赖**：B1（模型与 `changeId`）。
- **真实既有 fixture**：`test/durable-scheduler-capacity.test.ts`（`hop` `:33` / `active` `:51` / `limits` `:64` / `eligible` `:68` / `memoryCapacityRepo` `:72`，file claimAvailable 五维断言）、`test/durable-scheduler-fencing.test.ts`（`queuedHop` `:40` / `claimedHop` `:59`，陈旧 generation 拒写）、`test/run-token-lifecycle.test.ts`（`:29` issue 冻结 claim，调用方事后改对象不影响已发卡）、`test/orchestrator.test.ts`（`harness` `:88`、`trackExecAStarts` `:162`）。**只读参考，本票不运行。**
- **最少关键测试（1–2 条）**：同 `changeId` 只有一个 in_progress impact 槽（重入复用同一 open 行）；impact token 调派发/验收类动作被拒（普通 L2 路径不为本能力开门）；陈旧 `claimGeneration` 不得消费变更。

#### 4.3-B3 草案 B3：收件 / receipt 的 HTTP 身份与 generation 校验（依赖 B1、B2）

- **目录范围**：Hub 侧新增收件端点（`src/api/server.ts`）；receipt 持久形状（`src/application/`，与 B1 同层）。
- **实际函数（既有，复用）**：`requireRun`（`server.ts:783`）解 run token；`#renewHopLease`（`orchestrator.ts:2567`）的 `claimGeneration` 判据同源。
- **拟议新增接口（proposed）**：pi 轮询用的收件端点；receipt 分层字段 `saved` / `adapter_received` / `session_consumed` / `executor_started` / `verified`（§3.5）。
- **调用数据流**：pi 轮询 → 收件端点；身份**只从 run token** 解出，**不读 body**；投递内容比对 `targetAttemptId` + `claimGeneration`；generation 落后 → 拒绝/隔离，不静默处理。
- **依赖**：B1（变更记录）、B2（run token 与 generation 来源）。
- **真实既有 fixture**：`test/run-token-lifecycle.test.ts`（issue 冻结 claim / revoke 只吊该 Attempt）、`test/orchestrator.test.ts:1040` 起「平台守卫在真实 HTTP 上生效」的真实 HTTP 接缝。
- **最少关键测试（1–2 条）**：无活 token / 陈旧 generation 的收件请求被拒；收到 ACK 只写到 `adapter_received`，**不得**写成 `verified`。

#### 4.3-B4 草案 B4：提交 snapshot 与最新验收恢复（依赖 B1、B3）

- **目录范围**：`src/application/platform/executor-submissions.ts`、`src/application/platform/work-item-review.ts`、`src/application/platform/validation-report-views.ts`。
- **实际函数（既有，扩事件字段，不新造事件种类）**：
  - `submitExecutionResult()`（`executor-submissions.ts:26`）——已把 `executionResult` 绑到**实际提交它的** executor Attempt；扩展记录实际 snapshot hash（**proposed**）。
  - `reviewExecutionResult()`（`work-item-review.ts:8`）——accept/reject 语义与 `contractRevision` 记录不变；变更场景对齐**最新有效契约**。
  - `workItemValidationReportViews()`（`validation-report-views.ts:23`）——保留旧 `submittedAttemptId` 记录，不覆写；靠 `validationReportKey` 区分来源。
- **调用数据流**：执行者提交记实际 snapshot hash → L2 按最新有效契约验收 → 旧 `submitted` 保留为可区分记录。
- **依赖**：B1（模型）、B3（receipt）。
- **真实既有 fixture**：`test/orchestrator-standard-validation.test.ts`（`harness` `:179`、`runStandardChain` `:250`、`liveItem` `:267`）、`test/orchestrator.test.ts:352`「成功 executor 使用冻结 WorkOrder.allowedScope 检查点」、`test/validation-report-repository.test.ts`。
- **最少关键测试（1–2 条）**：提交 snapshot hash 与当前契约/工单对不上时不静默套用；旧 `submittedAttemptId` 的报告在收到新提交后仍可区分、不被覆写。

**B 段共同红线**：impact Attempt 只能产 `diff`，**不派发、不验收、不合入**；普通 L2 的验收/合入路径不为本能力开门；单写者语义（`src/application/lock.ts`）不引入第二写者。

### 4.4 工单草案 C：pi 运行期 poll/steer + ACK（含 platform-client / runtime / extension 实际范围）

- **目录范围（实际文件与函数）**：
  - `src/runtime.ts`：轮询在 `session.prompt(spec.instruction)`（`:833`）**运行期间**起；命中即 `session.steer(...)`。既有观测 `session.subscribe`（`:758`）与 `createAgentSession`（`:705`）不改语义；EOF 入口 `src/agent-entry.ts:25` 原样保留。现有 PI-END1 补救轮（`runtime.ts:844` 第二次 `session.prompt(reminder)`）**不是**可驱动的新输入通道，不并入本能力。
  - `src/platform-client.ts`：收件/ACK 必须走 `PlatformClient.get`（`:43`，适配层取上下文）或 `PlatformClient.call`（`:56`，工具调用）——**这是 adapter↔Hub 的唯一耦合点**，轮询**不得**另开裸 `fetch`。
  - `src/extension.ts`：安全边界由既有 `createCoagentExtension`（`:82`）承担——`pi.registerTool`（`:94`）、`pi.on('tool_call')`（`:128`，Policy Gate）、`pi.on('tool_execution_end')`（`:165`）。本草案**只新增轮询/steer/ACK**，不放宽这些拦截。
- **数据流**：Hub 收件端点 ← `PlatformClient` 轮询 → `session.steer` → SDK 队列 → 消费事件（`subscribe`）→ ACK 分层 → Hub receipt。
- **安全边界（保留）**：写越界 / 危险 git 拦截、policy 门禁不因本能力放宽；ACK 只写自己那一层。
- **ACK 不能证明应用（必须写死）**：`adapter_received` / `queued`（steer 入队）与 `session_consumed`（SDK 消费 `message_start`）**都不等于**执行者已按新差异行动；`executor_started` 是模型自述，仍非应用证据；只有独立证据（`verified`）才认。依据：`steer` 返回 `Promise<void>`，只承诺「已入队 / 已受理」（§1.6 / §1.10.6）。
- **依赖**：`@earendil-works/pi-coding-agent@0.87.1`（本地锁定）；Hub 收件端点（B3）。
- **真实既有 fixture**：`src/runtime.test.ts`、`src/platform-client.test.ts`、`src/extension.test.ts`（只读参考，本票不运行）。
- **最少关键测试（1–2 条）**：无变更时轮询**不改变**正常一跳行为；命中变更时调用 `steer` 且 ACK 逐层分开（`queued` ≠ `consumed` ≠ `started`，且都不冒充 `verified`）。
- **红线**：**不新增第二写者**——pi 只经 HTTP 唯一 Hub 读/ACK。

### 4.5 工单草案 D：L3 插件 binding + reviewer-tools 权威 HTTP read 消费者（另列的必要草案，本票不执行）

> **不能排除 `reviewer-tools.ts`**：现有 CLI 直读 state 只是本地排查，**不是**权威运行查询（§4.1）。要让独立状态流程接上「唯一持状态服务」，必须**同时**改 `reviewer-extension.ts` 的配置/握手与 `reviewer-tools.ts` 的工具消费者。

- **D1 配置 / 握手 binding（`reviewer-extension.ts`）**：
  - 实际：`REVIEWER_ENV`（`:31`）、`reviewerConfigFromEnv`（`:71`）、`parseReviewerConfig`（`reviewer-tools.ts:174`）。现有 `hub` / `projectRepo` 是 **repo 路径 / 工作目录**语义，**不是 endpoint**——**不得偷换其含义**。
  - **拟议新增（proposed）**：为 HTTP 连接**另起配置名**（如 `COAGENT_REVIEWER_ENDPOINT` / `..._STATE_ID` / `..._INSTANCE_ID` / `..._API_VERSION`），与既有 `hub` / `state` 并存；握手校验 `endpoint` / `stateId` / `instanceId` / `apiVersion` 齐全且 `apiVersion` 相符，缺失或版本不符 → **fail-closed**（对照 `src/l3.ts:145 requireLiveIdentity` 与 `src/api/server.ts:74 API_VERSION`）。
- **D2 权威 HTTP read 工具消费者（`reviewer-tools.ts`）**：
  - 实际：`L3_SCRIPT`（`:29`）/ `RUN_MISSION_SCRIPT`（`:30`）、`nodeCommand`（`:238`）、`runL3`（`:349`）、`createReviewerTools`（`:378`）、注入面 `ReviewerProcessRuntime`（`:79`）/ `createDefaultReviewerRuntime`（`:196`）。现状这些工具**全走 CLI**（如 `coagent_get_inbox` → `l3 inbox`）。
  - **拟议新增（proposed）**：只读工具新增一条**HTTP 消费者**，连**唯一持状态服务**并校验上面四元 binding；**无 CLI 文件 fallback**——拿不到 HTTP 能力时**显式报错 / 停住**，绝不回退到直读 state 文件（那正是 §4.1 禁止的「冒充权威查询」）。
  - **HTTP 能力缺失标待实现**：pi 侧 HTTP read 通路**尚不存在**，本草案标注 **【待实现】/ 现状 unsupported**，由 L3 冻结后才实施。
- **测试接缝（复用，不写错 fixture）**：
  - `reviewer-tools.test.ts:36 sampleInput` / `:47 recordingRuntime`——把 `runSync` 替身换成**本地 HTTP 桩**（**不得**指向真平台仓）。
  - `reviewer-extension.test.ts:42 sampleInput` / `:55 recordingRuntime`、`createReviewerExtension`（`reviewer-extension.ts:160`）、`ReviewerClock`（`reviewer-extension.ts:51`）。
  - **不要**把 `extension.test.ts`（托管 agent 扩展，`createCoagentExtension`）误当 reviewer fixture——两者是不同工具面（`roles.ts` 的 `Role` vs `ReviewerRole`）。
- **依赖**：无第三方新增。
- **最少关键测试（1–2 条）**：binding 缺失 / `apiVersion` 不符 → fail-closed；HTTP 能力不可用时**不得**回退到 CLI 文件读。
- **运维约束（保留）**：独立状态**不迁 3101、不开第二 writer、本票不启动服务**；运维顺序（唯一服务暴露 + 空档冻结）**仅列为未来冻结草案**，本票不执行。

### 4.6 依赖顺序与空档部署

- **依赖链（与 §4.3 的 B1–B4 对齐）**：
  1. **B1**（持久 amendment 模型 + 幂等）——无上游依赖，先做。
  2. **A1**（Hub VR 只读工具）——与 B1 并行；Hub 侧只读，无大协议依赖。
  3. **B2**（impact 监督：唯一槽 + 限权 + 容量/租约/预算）——依赖 B1。
  4. **A2**（pi VR 工具注册）——依赖 A1 端点存在（可先冻结；端点未上则 404，不静默放行）。
  5. **B3**（收件 / receipt 身份与 generation 校验）——依赖 B1、B2。
  6. **C**（pi poll/steer + ACK）——依赖 B3 端点。
  7. **B4**（提交 snapshot + 最新验收恢复）——依赖 B1、B3。
  8. **D1/D2**（L3 插件 binding + reviewer-tools HTTP read）——依赖「未来唯一服务暴露」，最后且仅草案。
- **能力协商**：适配器**显式声明**「轮询 + steer + ACK」；未声明 → 变更显式 pending（§3.3）。对齐 `runtime.capabilities` 的精确 `'v1'` 风格（`src/runtime/spawn.ts` 的 `commandActivityClassification: 'v1'`，只接受精确 v1，否则丢弃）。
- **全部就绪才启用闭环**：Hub（B1–B4）+ pi（C）+ 限权与 receipt **都在位**后，才允许「变更下发到在途」；任一块缺失，闭环保持 **unsupported / 不启用**。
- **不热改当前 Attempt**：部署**不改变**已在跑的 Attempt（不重启、不替换其 spec）；现有在途运行继续按旧契约跑完，闭环只对**新起**的 hop 生效。
- **空档部署**：涉及独立服务 / binding（D1/D2）的操作须在**无在途操作的空档**冻结后进行（§4.0）；本票只列顺序，不执行。

---

## 5. 可行性与未验证

> 对应 Contract 5。

### 5.1 逐条契约映射

| 契约 | acceptance 主题 | 本文章节 |
|---|---|---|
| Contract 1 | 源码事实：Contract/WorkOrder 修订、`AgentRun.start/on/abort/wait`、stdin EOF、SDK 接口；"写入修订 ≠ 在途收到" | §1（1.1–1.9） |
| Contract 2 | 最小接线方案；L2 如何收到并独立判断；区分平台保存/runtime 送达/执行者应用；原始需求由 L3 确认 | §2（2.1–2.7） |
| Contract 3 | 幂等/持久的数据形状；乱序、重连、旧适配器、安全边界、关联工单、最新验收恢复；单写者与职责 | §3（3.1–3.9） |
| Contract 4 | Hub / pi / VR / L3 插件分开工单草案；真实接口、测试接缝、最少关键测试、空档部署；缺通路则升级 | §4（4.0–4.6） |
| Contract 5 | 逐条可行性审查与五维结论；列出未验证事项 | §5（5.1–5.4） |

### 5.2 五维可行性

1. **设计维度**：可行。通路建立在**已核实**的 SDK 能力（steer/queue/subscribe）与 Hub 唯一的 token/claim 机制上；不新增第二写者，不改 runtime 端口形状（`AgentRun` 保持 on/abort/wait）。风险点是"steer 只保证排队/消费"这一语义天花板——已在 §2.6/§3.5 用分层状态隔离，不夸大。
2. **功能维度**：可行且有明确缺口的诚实标注——闭环的"最后一公里"（模型是否**应用**）在 SDK 层没有强保证，只能靠 `executor_started`（自述）+ 后续**独立证据**（`verified`）逐层加码。这是能力上限，不是实现偷懒。
3. **复杂度维度**：中。新增面集中在 Hub 的一个持久模型 + 一个监督 hop + pi 的一个轮询循环；但**必须与既有五维 capacity/公平性/双租约/预算 PRE-POST 兼容**，这是复杂度主要来源（§2.5 强制保留）。
4. **测试维度**：可控。每张工单只要 1–2 条关键测试（§4.2–4.5），优先复用既有接缝（`orchestrator*.test.ts`、`durable-scheduler-*.test.ts`、`run-token-lifecycle.test.ts`、`validation-report-repository.test.ts`、`runtime/extension/platform-client.test.ts`）。**本票不运行任何代码测试。**
5. **命名与注释维度**：需谨慎。红线要求注释写"为什么"、相对 import 带 `.ts`、不用 `enum`/constructor parameter properties、`src/` 除 `decision-question-registry.ts` 外不出现"题集"。本设计不涉及 kernel 词表违规（kernel 保持零 import），新名词（`changeId`/`purpose`/`amendment`/receipt 分层）**须在 L3 冻结时定名**，避免与既有 `idempotencyKey`/`claim`/`validation.reported` 语义混淆。

### 5.3 未验证事项（必须如实列出）

- **【未验证】** steer 被消费后，模型/执行者是否真的按新差异行动——SDK 不提供该保证；本文只用分层状态区分，**没有**运行证据。
- **【未验证】** 轮询频率与 `run.wait` 的静默超时（`SpawnRuntime.timeoutMs` 是"无输出即判卡"）之间的相互影响：轮询若不产生 stdout 输出，是否影响静默超时判定——需实现票里单独验证。
- **【未验证】** 变更命中在途运行时，安全 abort 后 worktree/子进程状态的实测收尾行为——仅从代码（`killTree`、`startRevision` 回滚）推断，未运行。
- **【未验证】** 旧适配器显式 pending 的实际持有时长与重试策略（尚未定策略）。
- **【未验证】** 未来独立服务 binding（`endpoint`/`stateId`/`instanceId`/`apiVersion`）的具体协议形态——本票只列必要草案。
- **【历史证据，本跳未重跑】** L2 的 EOF 离线实验退出码 0。

### 5.4 交给 L2 审查的清单

1. §2.1 通路是否被认可为"最小"（对比：改 stdin 协议 / 改 `AgentRun` 端口）。
2. §2.4 的限权 token 授权集合是否恰好剔除了派发/验收/合入。
3. §3.3 的"旧 generation 拒绝或隔离"取舍（拒绝 vs 隔离的边界）。
4. §4.2 VR 工具是否**真正**无大协议依赖、可优先独立合入。
5. §4.6 部署顺序是否满足"不热改当前 Attempt"。

---

## 附：本票的验证

本票只含文档检查（见工单 `verification`）；**未运行**代码测试、未启动服务、未联网、未跑真实 agent、未改 `.coagent/`、未迁状态。
