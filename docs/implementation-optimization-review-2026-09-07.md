# CoAgentHub 实现优化建议与验收清单

> 日期：2026-09-07  
> 性质：实现分析与优化规划；不是 Frozen spec，不可直接据此下发实现 task。  
> 范围：Server、Database、Web、Callback Agent、执行器接入、运维与文档。  
> 本文仅记录建议，不表示以下改动已实施。

## 1. 结论

项目已经具备消息路由、task 调度、检视、completion event 和宿主回调的完整功能骨架。业务源码规模本身不是主要问题，复杂度主要来自：

1. 同一个 task 有多个状态写入入口，数据库状态与内存状态之间缺少统一转换约束。
2. `diffSummary` 同时承载执行汇报、调度事实、检视结果和续跑标记，各路径需要额外保留字段。
3. 队列、孤儿收敛、queued 回收和协调者续跑分别推导活动事实，容易出现互相补偿的特殊分支。
4. 执行器适配、前后端检视规则以及前端数据加载存在重复实现。
5. 部分可靠性保证只覆盖单个函数，没有覆盖消息入库到执行、事件消费到确认、API 到页面的完整链路。

建议先修复已确认的可靠性缺口，再收敛状态和数据归属，最后拆分大文件、删除失效代码。目标不是单纯减少行数，而是让一条领域规则只有一个权威实现，让正常路径与恢复路径使用相同的状态转换。

## 2. 分析依据与边界

本次分析阅读了领域文档、ADR、主要模块及关键调用链，统计了 Git 跟踪文件。没有运行完整测试套件、真实 CLI/A2A task、生产数据库并发测试或浏览器验收。

进行了两项不落盘的隔离验证，直接转译当前源码并替换外部依赖：

- Callback Agent 去重命中分支：返回 `true`，`claimEvent` 和 `ackEvent` 调用次数均为 0。
- Callback command driver 未配置 `env`：传给 spawn 的 `env` 为 `undefined`，`shell` 为 `false`。未读取或输出真实环境变量。

其余发现为源码链路确认或待验证风险，不能等同于生产事故复现。文中路径和行为以分析当日工作区为准。

| 模块 | 规模 |
| --- | --- |
| Server | 65 个源码文件，约 20,068 个物理行 |
| Database | 11 个源码文件、31 份 SQL 迁移 |
| Web | 80 个非测试 TS/TSX 文件，约 15,469 个物理行 |
| Callback Agent | 10 个源码文件，约 1,090 个物理行 |
| 测试 | Server 77、Web 33、Callback Agent 5、脚本 4、E2E 4 个文件 |

物理行包含注释和空行；测试文件数不代表测试通过率或覆盖率。

## 3. 优先级与总体安排

本文优先级用于安排后续讨论，不代表已创建 issue。

| 阶段 | 编号 | 优化项 | 优先级 |
| --- | --- | --- | --- |
| A：可靠性 | R1 | Callback Agent 去重后重新确认 | 高 |
| A：可靠性 | R2 | completion event fail 的原子 lease 校验 | 高 |
| A：可靠性 | R3 | callback 校验前置，避免失败请求留下消息 | 高 |
| A：可靠性 | R4 | 消息到 task 的持久化交接 | 高 |
| A：数据完整性 | R5 | 历史消息分页与断线恢复 | 高 |
| B：执行隔离 | R6 | task 数据库认领与重复执行防护 | 中高 |
| B：执行隔离 | R7 | checkpoint 使用独立 Git index | 中高 |
| B：接入契约 | R8 | 配置字段与执行行为一致 | 中 |
| B：回调运行 | R9 | 环境继承策略、lease 与 timeout 协调 | 中 |
| B：输入及平台 | R10 | 请求流量限制与 Windows 运行契约 | 中 |
| C：结构收敛 | S1–S5 | 状态入口、数据归属、适配与前端复用 | 中 |
| D：清理 | D1–D2 | 文档同步、失效代码核对 | 低至中 |

阶段可按独立边界拆票；不得将整份文档作为一次大重构下发。先修缺陷并建立结果验收，再迁移结构，避免同时改变业务语义和模块边界。

## 4. 可靠性与执行边界优化

### R1. Callback Agent 去重后重新确认

**现状及证据**：[`callback-agent.ts`](../packages/callback-agent/src/callback-agent.ts) 的 `processEvent()` 在 `dedupe.isDelivered(eventId)` 为真时直接返回，日志称“acking only”，但没有 claim/ack 调用。隔离验证已确认。

**影响**：命令成功、本地记录成功而 ack 失败后，事件仍在 inbox；重启或重试持续跳过，不能收敛到 delivered。

**建议**：去重命中后重新领取有效 lease，再 ack；命令不得重复执行。日志和处理计数应反映实际结果。

**验收**：模拟首次 ack 失败与消费者重启，读取最终 event 状态为 delivered；确认宿主命令只执行一次。不要仅断言去重函数返回成功。

### R2. completion event fail 必须原子校验 lease

**现状及证据**：[`task-completion-events.ts`](../packages/backend/server/src/routes/participant/task-completion-events.ts) 的 fail 接口先读取并校验 leaseToken，最终 UPDATE 仅按 eventId 过滤；attempts 自增与 dead 判定也没有基于同一原子状态计算。

**影响**：旧消费者可能覆盖新消费者的 lease，或将已确认事件改回 pending；并发失败计数与 dead 状态可能不一致。

**建议**：更新条件包含 eventId、recipient、leaseToken 和允许的 state，基于更新时的 attempts 计算新状态。明确过期 lease、重复 fail 和 ack/fail 并发的响应契约。

**验收**：构造旧 lease 与重新 claim、ack 与 fail 的交错；旧消费者不能修改新 lease 或 delivered 状态，重试阈值与最终 attempts 一致。读取数据库最终记录。

### R3. callback 语义校验前置

**现状及证据**：[`messages.ts`](../packages/backend/server/src/routes/group/messages.ts) 先通过 `insertGroupMessage()` 提交消息并广播，再检查 callback 非法内容及 sessionRef 冲突。

**影响**：请求返回 400，但消息已存在并可能被其他 participant 收到；调用方重试可能重复发言。

**建议**：在首次写入之前完成 callback 归一化、身份权限判断和冲突检查。后续写入只使用已验证数据。

**验收**：非法 callback 和冲突 sessionRef 均返回 400；数据库消息数不增加、closure 不增加、无 WS 消息广播、无 task 创建。

### R4. 消息到 task 的持久化交接

**现状及证据**：[`messages.ts`](../packages/backend/server/src/routes/group/messages.ts) 对 participant 定向消息采用异步 `maybeDispatchExecutorTask()`；[`queued-task-reclaim.ts`](../packages/backend/server/src/lib/executor-task/queued-task-reclaim.ts) 只能恢复已存在的 queued task。

**影响**：消息提交后、task 创建前发生进程退出或异常，可能永久留下“有消息、无 task”的状态。`message_id UNIQUE` 只能防止重复 task 行，不能补齐未创建记录。

**建议方向**：在消息事务中持久化调度意图，或将必要的 task 创建纳入该事务。目标解析、拒绝派发和重试结果必须可追踪；不得仅靠扫描所有历史消息猜测是否应执行。

**需先决策**：持久化调度意图与事务内创建 task 二选一；明确哪些定向消息属于可调度请求，以及派发失败如何向调用方暴露。

**验收**：在消息提交与后续派发交接位置注入中断；恢复后符合派发条件的请求最终得到一个 task，拒绝派发有明确记录，不重复执行。

### R5. 历史消息分页与断线恢复

**现状及证据**：[`message-service.ts`](../packages/backend/server/src/lib/services/message-service.ts) 默认返回 `id ASC LIMIT 200`；[`use-messages-page.ts`](../packages/frontend/web/src/hooks/use-messages-page.ts) 和 [`requirement-workspace.tsx`](../packages/frontend/web/src/components/layout/context-panel/requirement-workspace.tsx) 请求未消费后续分页。消息页未使用 WS 恢复连接状态触发补拉。

**影响**：已有大量历史消息的 group 新打开时缺少后续消息；断线期间的新增、编辑、删除不能可靠恢复，检视证据可能缺失。

**建议**：统一最新窗口、向前历史分页、向后增量同步三种语义。新增消息使用游标补齐；编辑和删除需要窗口重取或独立变更游标，不能只用创建 ID 判断。

**验收**：建立超过 500 条消息的 group；页面能够展示最新记录并访问完整历史。断网期间新增、编辑、删除，重连后页面与 API 一致；验证重复、乱序、group 切换和搜索清除，不出现跨 group 混合或重复消息。

### R6. task 数据库认领与重复执行防护

**现状及证据**：[`queued-task-reclaim.ts`](../packages/backend/server/src/lib/executor-task/queued-task-reclaim.ts) 使用 30 秒宽限避开登记窗口，注释记录了慢 DB 下串行重复执行的边界；[`queue.ts`](../packages/backend/server/src/lib/executor-task/queue.ts) 的 `runOne()` 主要依赖本进程 activeRuns，进入 running 的 UPDATE 不要求旧状态为 queued。

**建议**：以数据库条件更新作为执行认领依据；内存队列作为缓存。正常派发、恢复与重试共用认领入口，失败认领不得 spawn。

**需先决策**：明确仅支持单 server，还是允许同数据库多实例；若需要跨实例执行，进一步设计 lease、属主标识和失效接管，不能只使用本机 PID。

**验收**：派发延迟超过宽限、重复入队、恢复器交错时，同一执行尝试只能有一个成功认领者；已终态 task 不被过时 run 改回 running。此项不宣称第三方副作用 exactly-once。

### R7. checkpoint 不应修改真实暂存区

**现状及证据**：[`executor-runner.ts`](../packages/backend/server/src/lib/executor-runner.ts) 的 `createCheckpointUnlocked()` 执行 `git add -A`，随后创建树和隐藏 ref，没有恢复真实 index。

**影响**：平台快照本身会暂存其他 participant 的在途修改，改变用户的部分暂存状态。明确路径提交是补偿措施，不是快照隔离。

**建议**：使用独立 Git index 构造 checkpoint，保留隐藏 ref 与现有回滚能力；不要通过修改后恢复真实 index 制造新的并发窗口。

**验收**：含已暂存、未暂存、部分暂存和未跟踪文件的仓库，快照前后真实 index 保持一致；checkpoint 包含约定内容；失败与并发快照不污染 index。回滚对新增文件的处理需保持明确且不扩大删除范围。

### R8. 执行器配置与实际能力一致

**现状及证据**：[`executors.ts`](../packages/backend/server/src/lib/executors.ts) 与执行器 API 保存 `inputMode`、`env`、`outputProfile`；当前 [`queue.ts`](../packages/backend/server/src/lib/executor-task/queue.ts) 的 CLI 调用主要依赖 args 占位符，没有传入 `ex.env`，runner 的 stdin 为 ignore。outputProfile 有“只存不读”的分期背景。

**建议**：明确支持、保留、未实现字段。未实现能力不能以保存成功暗示执行生效；为 inputMode 和 env 建立单一消费入口。

**约束**：[`executor-adapter-registry.md`](../specs/executor-adapter-registry.md) 已决定先做代码适配器注册表，画像暂缓。不得未经决策重新实现另一套画像引擎。

**验收**：从 API 保存配置，经真实 runner 到隔离假执行器，读取实际参数、stdin 与指定环境变量；不能只检查数据库字段。未支持取值有明确响应或能力说明。

### R9. Callback Agent 环境、lease 与超时

**现状及证据**：[`command-driver.ts`](../packages/callback-agent/src/command-driver.ts) 未配置 env 时传入 undefined，与环境白名单注释不一致；[`config.ts`](../packages/callback-agent/src/config.ts) 默认 lease 为 30 秒，命令默认超时为 60 秒，当前未见续租。

**建议**：明确环境继承是默认允许还是显式允许，并同步实现、配置和文档；为长命令提供续租，或限制命令执行时间与 lease 的关系。宿主最终副作用幂等仍按 eventId 负责。

**验收**：仅使用测试环境哨兵变量检查继承；长于初始 lease 的命令在双消费者下不会无保护地重复启动；续租失败有明确处置，不把未知结果直接等同执行失败。

### R10. 输入上限与 Windows 运行契约

本项包含两个可独立拆票的边界问题。

**上传**：[`file.ts`](../packages/backend/server/src/routes/file.ts) 先按 Content-Length 预检，再 formData，最后检查 file.size。应在实际请求流上限制累计字节，覆盖无 Content-Length 和多 part 请求；验收超限请求提前终止且不留下半成品，不以流式写盘替代解析前限制。

**Windows**：[`queue.ts`](../packages/backend/server/src/lib/executor-task/queue.ts) 硬编码任务书 `/tmp`；Callback Agent 使用负 PID 杀进程组，无平台回退。应先明确 server 本地执行的支持平台，再统一临时目录和进程树终止策略。验收应覆盖启动、停止、超时、子进程退出和文件清理。支持远端 Windows A2A 不等同支持 Windows 本地 server 执行。

## 5. 结构简化方案

### S1. 统一 task 状态转换入口

将队列、PATCH、恢复器直接写状态的方式，逐步收敛为具名领域操作。示意名称如下，最终接口需在 spec 中确定：

```text
createTask → claimTask → completeTask / failTask / cancelTask
```

这些操作统一负责合法前置状态、attempts、结果合并和必要通知；completion event 仍由 DB trigger 在事务内持久化。区分“一个 task 的一次执行尝试”和“替代 task”，避免重试与 supersedesTaskId 混淆。

**验收**：生产状态写入点能够枚举并归属到权威入口；旧状态竞争失败不继续执行副作用；CLI、A2A、PATCH、停止和恢复路径均检查最终 task 与 completion event。

### S2. 明确 diffSummary 的数据归属

先列出全部字段、写入者和消费方，再区分：

| 数据 | 建议归属 |
| --- | --- |
| 执行器汇报 | 经过验证的执行结果 |
| queuedBlocked、属主、冷却等 | 平台调度事实 |
| review_request、review_result、结案证据 | 检视结果 |
| resumeOf 等标记 | 平台续跑关系 |
| token、执行起止、失败原因 | 明确对应的 attempt 或 task 汇总 |

不要求立即全部迁移为新表。先建立有类型的结构、单一合并入口和字段所有权，保持 API 兼容，再按查询和并发需求决定独立列或表。

**验收**：新增字段不再需要在多个终态路径追加 preserve 补丁；不同所有者字段不能互相覆盖；历史 JSON 仍可读取，最终 API 与页面形状有回归检查。

### S3. 收敛活动事实与恢复规则

定义 task status、executorPid、activeRuns、子 task、待续跑 completion event 分别能证明什么。不要用“没有输出”替代“进程死亡”，不要用“进程退出”替代“协调 task 已结束”。

正常调度和恢复模块共用事实查询及转换规则。保留 queued 回收、孤儿收敛、协调者续跑的不同职责，不将它们机械合并成新的大文件。

**验收**：同一事实不在多个模块独立推导；每个豁免标记有创建、消费和失效规则；用协调者退出、子 task 冷却、续跑待创建等交错场景验证最终状态。

### S4. 缩小 queue.ts 与 tasks.ts 的职责

- queue：只负责排队、选择可运行 task、占用和释放槽位。
- runner：CLI/A2A 执行与进程生命周期。
- ticket builder：任务书生成。
- retry/cooldown：处置策略，输出明确决策，由状态入口执行。
- task lifecycle：状态转换和结果写入。
- review policy：结案与检视领域规则。
- route：请求校验、权限上下文、调用领域操作和序列化。

拆分以数据所有权和副作用边界为依据，不以行数平均切割。保持已有导出面稳定，避免循环依赖及各模块直接访问共享可变 Map。

**验收**：队列无需理解汇报格式；HTTP 路由无需直接编排 Git 核实与多层结果合并；模块可用明确输入独立测试，不依赖重置整套全局状态。

### S5. 统一适配器、检视纯函数和前端数据层

三个方向分别落地，不捆绑为一个框架改造：

1. **执行器适配器**：输出解析、token 采集、最终汇报提取在一个注册位置声明。保留未知输出兜底；依据现有 Frozen spec 实施。
2. **检视纯函数**：抽出无 React/Hono/DB 依赖的共享规则，优先消除 [`l1-aggregate.ts`](../packages/backend/server/src/lib/l1-aggregate.ts) 与前端镜像规则；UI 文案和组件状态留在前端。
3. **group 数据层**：消息页和需求面板复用加载、分页、WS 合并和重连恢复，页面只选择需要的数据。可以复用现有依赖，不必新增状态管理框架。

**验收**：新增执行器不必修改三处分支；相同检视事实只有一份计算实现；重连、乱序响应和 group 切换不会覆盖新数据或混入旧 group 数据。

## 6. 文档同步与代码清理

### D1. 同步当前架构描述

需要核对的已知演进差异：

- ADR-0003 的全局串行描述与当前 projectPath 分组及并发上限。
- CONTEXT 中 completion event 的 task_id 唯一描述与 0030 迁移后的 `(task_id, recipient_participant_id)` 唯一。
- ADR-0008 输出画像方向与后续适配器注册表 Frozen spec。
- “只做文件信令”限定为 group fileRef 路径；独立 `/api/file` 仍实际传输文件字节。
- 历史 bridge、自动注册执行器和运行方式相关注释。

ADR 保留历史背景，通过明确的后续决策引用说明演进，不抹去旧决策。影响工作流的变更按 AGENTS.md 同步 CONTEXT、architecture、相关 ADR 和 skill；本规划文档不提前改写现有契约。

### D2. 删除候选必须先查引用

候选包括已移出路由的文件页面、未使用兼容壳、重复载荷识别、过期配置注释。删除前检查源码引用、构建入口、外部 API 使用和测试用途。

旧 `/agents` API 等兼容入口成本较低，不应为减少行数贸然删除。测试文件多不构成臃肿证据；只有确定测试锁定过时契约时才调整。

## 7. 应保留的设计

- 消息与 closure 的事务写入，以及服务端 audience 过滤。
- participant、群内角色和执行器配置的概念区分。
- DB trigger 持久化 completion event；WS 仅作为低延迟提示。
- brief、attempts、dispatchAudit、specRef/specHash 与 supersedesTaskId 的审计能力。
- 真实迁移/PGlite 测试、真实 PostgreSQL E2E 和事故回归用例。
- 运行时 stale 检测、迁移检查、受控重启与备份机制。
- LAN 全信边界。不将无认证误判为当前定位下的实现缺陷；改变部署信任边界应单独决策。

## 8. 测试与交付要求

1. 单个可靠性修复先建立能暴露旧行为的定向测试，最终检查数据库、API 或页面产物。
2. 改动 done 分支、聚合函数、渲染入口等主干路径时，按 AGENTS.md 跑全量回归，不只跑新增用例。
3. 定向后端测试使用仓库约定命令：`cd packages/backend/server && npx vitest run test/<文件>.test.ts`。
4. 非平凡 TypeScript 改动运行 check-types；数据库迁移需验证旧数据升级和新安装两条路径。
5. server 实现改动验收时重新构建，并按受支持部署环境的受控流程重启，读取 health 的 stale 状态。不得在本次仅文档工作中执行。
6. 并发问题用可控交错验证；崩溃恢复用故障注入；页面完整性用实际渲染验证，不以辅助函数通过替代。
7. 每票交付列出变更、验证结果、未覆盖边界。只有完成检视才将关联 spec 更新为 Landed。

## 9. 优化完成的衡量标准

不预设“减少多少行”或性能提升百分比。使用以下可验证结果衡量：

- 一条 task 状态规则只有一个权威写入入口。
- 一份执行结果不会因其他模块回写而丢失字段。
- 消息到 task、task 到 completion event、event 到宿主确认均有明确恢复语义。
- 新增执行器的适配点集中，配置成功与运行生效一致。
- 页面历史完整，断线后能与服务端重新收敛。
- checkpoint 不改变用户真实暂存区。
- 删除特殊补偿分支时，有等价或更强的不变量和回归证据支撑。
- 文档中的当前行为与代码一致，历史决策和未落地计划可区分。

下一步应先选取 R1、R2、R3、R5 这类边界清楚的项目形成独立 spec；R4、R6、S1、S2 需要先确定状态与事务设计，再冻结实施方案。
