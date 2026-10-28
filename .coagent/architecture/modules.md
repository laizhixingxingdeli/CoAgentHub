# 模块地图

读代码前先看这张表：每个目录负责什么、从哪进、不能越过什么线。检视者维护；协调者交卷里「动了哪些目录、对外接口变化」有新东西时更新。**不随每一跳发送**，按需读。

大文件按方法名搜索定位，别整份读：`orchestrator.ts` 约 3,550 行、`platform.ts` 约 2,700 行（入口外壳，实质用例体在 `platform/` 下）、`web/task.js` 约 2,100 行、`api/server.ts` 约 2,700 行。

## 源码（`src/`）

| 目录 / 文件 | 负责什么 | 关键入口 | 边界 |
|---|---|---|---|
| `src/kernel/` | 纯领域：Mission / WorkItem / Attempt 状态机，契约、工单、结论等载荷类型 | `mission.ts`、`work-item.ts`、`attempt.ts`、`payloads.ts` | 不 import 任何东西（`test/kernel-imports.test.ts` 钉死） |
| `src/application/platform.ts` | 所有写命令的唯一用例入口：`Platform` 类的公开方法、构造与字段、context 装配；方法体转调 `platform/` 下的职责模块（REF1，2026-10-02） | `Platform` 的公开方法（`createClassifiedMission`、`reviewExecutionResult`、`finalizeMissionByMachine`…） | 规则写在 `platform.ts` 与 `platform/`，不写在 HTTP handler 或 prompt 里；外部只从 `platform.ts` 引用（各模块的名字由它再导出） |
| `src/application/platform/` | `Platform` 的实质用例体，按职责分 60 个模块（见下节） | 各模块导出 `(ctx, 原参数)` 形式的函数，`ctx` 是 `context.ts` 的共用状态 / 事务 / 事件 | 只由 `platform.ts` 调用；写事件走 `ctx.event(…)`（与 `#event` 等价，护栏测试两种写法都认） |
| `src/application/orchestrator.ts` | 每一跳的调度：唤醒协调者 / 执行者、换候选、检查点、快车道分支、协调者唤醒指令；候选额度读取每次筛选单读、Orchestrator 实例缓存 60 秒（PERF1，缓存只在实例上、失败不缓存）；Standard 执行者 `no_structured_result` 按工作项局部换人、尾部连续 4 次带原因交回协调者（COM8，`#noResultRotation`，不写全局熔断）；上游网络中断命中时（`upstreamOutageStop`）不换候选、不报队列失败，释放租约后以 `no_available_agent` + resumeAt 返回（RESUME2）；平台放弃重跑（无结果到顶 / 局部排除后无候选）与墙钟强杀后，调平台可信收尾把 dispatched 收成 blocked（COM12，`#blockStalledNoResultLimit`、`#blockStalledOnRunaway`，只对执行者跳、尽力而为，失败不改交回 / 停机语义）；每一跳前后的工作区守卫与状态恢复拆在 `hop-guards.ts`（验证后收口、开跑前核对工作区、检查点失败记录、叫协调者前恢复「带结果被机器续派回 dispatched」的工单，可靠性加固 2026-10-13）；Mission 级模型约束在 `#runHop` 里派发前强制（指定模式匹配候选都不可用即停 `model_unavailable`，绝不改派别的模型）；退避 / 候选冷却把到期时刻随停机原因写进 Mission（`waitResumeAt`） | `Orchestrator.runMission` | 只调 Platform，不直接改状态；执行者路径只调一次 `run.wait()`，finally 先 `stopAndJoin` |
| `src/application/change-request*.ts`、`change-impact*.ts`、`change-receipt*.ts`、`change-coverage*.ts` | 运行中变更：L3 确认的原始请求（B1）、L2 影响判断的 append-only 记录（B2b）、执行者读差异的分层回执（B3：adapter_received / session_consumed / executor_started）、交卷快照与平台 verified（B4：交卷事件带 appliedChanges / snapshotHash，验收门挡未覆盖的 compatible 变更，verified 只经 `recordVerified`）、重派后的工单覆盖声明（COM4-C：`change-coverage*.ts`，L2 把旧 Attempt 的差异并入修订后工单并记录，快照相符才算覆盖） | `ChangeRequestRepository`、`ChangeImpactRepository`、`ChangeReceiptRepository`、`ChangeCoverageRepository` | 只保存判断与回执，不应用；执行侧写不到 verified；pi 轮询与生产入口未接线（见 `specs/runtime-change.md`） |
| `src/application/contract-history*.ts` | 契约原文留档（COM4-A）：契约验收原文按修订 append-only 留档（有契约的建 Mission 记 r1、reviseContract 每次 +1，与 Mission 状态同一事务）。验收处置与交卷门禁已于 2026-10-24 移除 | `ContractHistoryRepository`（内存与 File 两种实现） | 见 `specs/acceptance-evidence.md` |
| `src/application/time-attribution.ts` | 时间归因（COM5）：把活动、验证报告起止与本 Mission 的 hop 投影成阶段耗时（排队、退避、选候选、运行、工具、验证、评审、等待决定、暂停、搁置、未分类），工具取区间并集、验证与运行重叠不双计 | `projectTimeAttribution`（纯函数，无 I/O） | 测不到的一律 null / 未知，不用当前时间、token 或 `hop.updatedAt` 补算；只读展示，不影响调度（见 `specs/time-attribution.md`） |
| `src/application/plan-run*.ts`、`plan-handoff.ts`、`mission-runner.ts` | 历史方案记录的只读与决定：运行记录与升级单（`plan-run`、`plan-run-store`）、交接面（`plan-handoff`）；单 Mission 运行与轮次上限（`mission-runner`）。方案的解析、路由、驱动、预检与 `run-plan` 入口已于 2026-10-24 移除，只剩历史记录兼容 | `FilePlanRunStore`、`MissionRunner.run` | 方案记录是独立 JSON，不进主状态；不新建 PlanRun |
| `src/application/scope-paths.ts` | 工单范围（`allowedScope`）路径语义的唯一一份纯函数：规范化、绝对 / 穿越 / 目录 / 通配符判定、给出原因与改法；建单 / 修订 / 派发、机器验证、检查点三处共用（可靠性加固） | `exactFileScopeIssues`、`scopeMatches` | 零依赖；范围可写精确文件或以 / 结尾的目录，通配符、绝对路径、.. 前置拒绝；杂文件判定 isJunkPath 也在这里（GATE1） |
| `src/application/hop-guards.ts` | 编排器每一跳前后的守卫（从 `orchestrator.ts` 拆出）：验证后收口（`settleValidationResidue`）、开跑前核对（`preflightWorkspace`，核对自己出错放行）、检查点失败结构化记录、叫协调者前的状态恢复 | `HopGuards` | 只依赖 Platform 与 WorkspaceManager；对平台的写都经 Platform 公开方法 |
| `src/application/retry-wake.ts`、`platform/auto-resume.ts` | 退避 / 候选冷却 / 额度重置 / 平台不可达、上游网络中断（多家候选连续断网类失败：不换候选、不进死信，同一档位 1、5、15 分钟以 `no_available_agent` 退避，RESUME2）到点自动接着跑；执行者死信与打转先由 `prepareAutoResume` 收成 blocked、写 `mission.coordinator_handoff` 交回协调者；L3 答复、修订契约、加预算、批准检查点、恢复工作项后写 `mission.resume_requested`，托管 Mission 自动续跑。启动时对被杀时在跑的托管 Mission 请求续跑（`service_interrupted`，两路并集：启动收敛判 interrupted + 接管旧锁后按上一服务最后心跳 D 的 [D−20 分钟, D+2 分钟] 活动窗口选出，`platform/heartbeat-continuation.ts`）；半开探测名额无活租约连续 2 分钟则走既有 reset 回收（`platform/probe-reclaim.ts`，挂在同一 tick）；复用持久的托管启动参数（`mission.run_requested`）；节流、并发上限、不重复启动（可靠性加固、RESUME1） | `RetryWakeScheduler`、`listAutoResumeDue`、`isAutoResumable` | 不绕过暂停 / 挂起 / 未答复升级 / 费用上限 / 检查点；协调者连续两次打转、平台连续 4 次不可达即停下等人；入过 Mission 队列的归队列 worker；`COAGENT_AUTO_RESUME=0` 整体关闭（探测回收也不跑）；`COAGENT_RESUME_INTERRUPTED=0` 只关启动续跑 |
| `src/application/model-policy.ts`、`platform/model-policy.ts` | Mission 级模型约束：优先（可替代）/ 指定（不可替代），选择器匹配候选，版本化事件留全部历史，派发时留可追溯记录 | `applyRolePolicy`、`Platform.setMissionModelPolicy` | 约束只管这条 Mission，不改资源池；不从契约正文猜；目前只管协调者与执行者，独立检视不在内 |
| `src/application/durable-scheduler.ts`、`candidate-circuit.ts`、`agent-pool.ts`、`runtime-catalog.ts` | 持久队列（租约、代次、五维容量、重试、死信）、候选熔断、候选池、模型清单；用量行匹配 `findUsageRow`（provider + modelPrefix，最长前缀、无前缀兜底，编排器与网页健康投影共用，PERF1）；常驻服务启动时按当前池清掉不在任何角色配置里的孤儿熔断记录（`pruneAbsent`，2026-10-25；单命令排他装配不清） | 队列是纯函数 `claimHop` / `renewHop` / `reportHopFailure`；候选池 `AgentPoolRepository` | 候选按平台当前角色有序配置读取；整角色替换核对 revision，在途身份不变 |
| `src/application/context-builder.ts`、`project-memory.ts`、`context-attribution-report.ts` | 给协调者 / 执行者的简报打包；读 `.coagent/`、生成 VIBE.md、写 memoryDelta；用量归因 | `buildContextBundle`、`readProjectMemory`、`generateVibe` | 简报只放白名单来源 |
| `src/application/validation/`、`promotion/`、`task-classifier.ts`、`classified-mission-intake.ts`、`query-run.ts`、`query-promotion.ts` | 机器验证（跑命令、查改动范围、改动量；改动量文本行数与二进制文件分开计量，二进制只记路径 / 大小 / 哈希，可选 `maxChangedBinaryFiles` / `maxChangedBinaryBytes`；验证命令的子进程带 `PYTHONDONTWRITEBYTECODE=1`）；快车道晋升判定；确定性分类；只读问答 | `ValidationEngine`、`classifyTask` | 验证命令不经 shell（判据 `invalidArgvReason` 由 `validation/engine.ts` 导出，冻结 / 修订工单时平台也用它前置拒绝，COM13）；分类只认事实，不认 caller 自填路由 |
| `src/application/ports.ts`、`in-memory.ts`、`file-store.ts`、`activity-index.ts`、`artifact-store.ts`、`live.ts`、`delivery.ts` | 仓储接口与内存 / 文件两种实现、大输出外置、实时输出、投递收件箱；遥测两类事件外置 `.coagent-events/` 边车（NDJSON，list/all 归并拼接，ADR-0009）；活动日志按 Mission 建索引（`ActivityIndex`，QUEUE1：`list(missionId)` 不再对全部事件 filter，端口不变） | `FileStateStore`、`FileActivityLog` | 零第三方依赖；索引只存事件引用，事件数组只许经 append 的 push、事务快照、归档过滤、重载这几处改写 |
| `src/application/reconcile.ts`、`lock.ts`、`loopback-*.ts`、`token-issuer.ts` | 启动与周期修复、主锁（单写者）、常驻服务本机回环、run token；启动还重试已合入 Mission 分支的清理、归档超 30 天的已合入 Mission（`archiveEligibleMissions`，ADR-0009）、迁移遥测事件进边车（均排他启动、失败不阻断） | `acquireLock`、`probeLocalWriter` | 单机单写者；重试只动 `mission/<id>` 分支，祖先核对与 `-d` 的安全判断在 `deleteMergedBranch` |
| `src/application/policy-engine.ts`、`ha-authority-config.ts`、`redact.ts` | 主体 × 动作的授权表、高保证放行授权、凭据脱敏 | `PolicyEngine` | 引擎不读时钟、不碰存储 |
| `src/application/workspace.ts` | git worktree：建、合并、回滚、检查点（拒绝时抛带原因码与路径的 `CheckpointRejectedError`）、验证后收口 `settle`（只提交授权范围内的脏路径，范围外原样保留）、`dirtyPaths`、改动摘要；`release` 失败上抛不吞（调用方记 `workspace.branch_cleanup_failed`）；`deleteMergedBranch` 删已合入的 `mission/<id>` 分支（祖先核对 + `-d`）、`listMissionBranches` 列现存 mission 分支 | `GitWorktreeManager`（实现 `WorkspaceManager`） | master 不动；合并只进集成分支 |
| `src/application/code-metrics.ts`、`platform/code-metrics-files.ts` | 零依赖近似源码告警、src 文件读取；交卷附件与离线脚本共用 | `analyzeCodeMetrics`、`collectCodeMetrics` | 仅读源码，告警不参与验收判定 |
| `src/api/` | HTTP：路由表、agent 工具表、托管运行（`server.ts`）；网页后端视图（`web.ts`）；静态文件、run token、控制面鉴权；`GET /api/pools` 的池健康有短缓存与 single-flight（`poolsHealthCacheMs`，服务装配 15 秒，写池 / 复位熔断后失效，`?fresh=1` 强制重算；扫描每个 Mission 让出一次事件循环，POOLS1，见 `specs/pools-health.md`） | `createApi` | 只调 Platform 公开方法，不写规则 |
| `platform/reviewer-todos.ts`、`reviewer-duty.ts`、`master-brief.ts` | 权威源待办投影、持久值守租约、真实 Git 合 master 简报 | Platform 的 reviewer 方法 | 读不 ACK；确认不解门禁；master 只读，不执行合并 |
| `platform/document-queue.ts`、`application/document-files.ts` | 文档精确差异、持久提议状态、批准后的空档提交及重入恢复 | `listDocumentProposals`、`decideDocument`、`flushDocumentQueue` | 代码合入不自动落文档；基线漂移重审；隔离检出提交后核对目标，master 不动 |
| `src/api/reviewer-wait.ts`、`reviewer-mcp.ts`；`scripts/reviewer-watch.ts`、`reviewer-mcp.ts` | 有界守候、零依赖 stdio MCP（十三个工作流工具，含候选熔断复位 L3MCP1、工单状态恢复、Mission 模型约束）、显式客户端 | HTTP 与 MCP 入口 | 所有状态经服务；不自动启动、不创建定时任务、不改已安装插件 |
| `src/runtime/` | 起 agent 子进程与协议（stdin 规格、stdout 事件行与结果行）；静默超时对命令执行中让路：command 类工具调用在跑时不按静默掐，自命令开始超过 `commandGraceMs`（默认 20 分钟）才判死，挂死的最终兜底是 runaway 墙钟（2026-10-25，一个月 43 次 killed_idle 发生在命令启动后 5 分钟整）；只读查询运行时；测试用脚本运行时 | `spawn.ts`、`pi-query.ts`、`scripted.ts` | 不依赖任何 agent SDK |
| `src/web/` | 无构建前端：路由（`app.js`）、项目页（`projects.js`、`project-catalog.js`、`project-spec.js`）、任务页（`task.js`）、收件箱（`inbox.js`）、角色与模型（`agents.js`）、设置（`settings.js`）、方案运行页、平台页、资源池页、事件叙事（`narrate.js`，含 `modelLabel`：任务页环节头与详情显示每一跳实际模型，COM11）、样式（`ui.css`） | `index.html` | 只走 `/api/*` |
| `src/main.ts` | 常驻服务与两种装配（内存 / 文件） | `startServer`、`buildPersistentPlatform` | 状态文件路径必须显式 |
| `src/l3.ts`、`src/run-queue.ts`、`src/run-mission.ts` | 检视者命令、已确认 Mission 队列提交、单 Mission 运行 | 各文件顶部用法说明 | 写命令在持锁服务里执行 |

## `src/application/platform/` 按职责

改哪类规则先找对应模块，别从 `platform.ts` 顺着读。

| 职责 | 模块 |
|---|---|
| 共用底座 | `context`（共用状态、事务、事件）、`types`（公开视图与依赖类型）、`mutation-lane`（改动名额、快车道校验） |
| Mission 生命周期 | `mission-intake`（创建、分类、重跑）、`mission-lifecycle`（生命周期控制）、`mission-control`（作废、交卷控制）、`planning`（规划更新） |
| Attempt | `attempts`（开跑、收尾、心跳） |
| 工作项与工单 | `work-orders`（建单、修订）、`work-order-helpers`（工单校验；`checkWorkOrderValidationArgv` 在冻结与修订时前置拒绝壳层包装的 validation argv，COM13；`checkWorkOrderScope` 在建单 / 修订 / 派发前拒绝目录、通配符等模糊范围）、`work-item-dispatch`（派发）、`work-item-review`（评审）、`executor-submissions`（执行者证据、结果、blocked）、`standard-redispatch`（Standard 续派）、`redispatch-helpers`（续派纯辅助）、`conflict-dispatch`（冲突派发屏障）、`stranded-work-item`（状态恢复：「已有结果却停在 dispatched、无活执行者」的工单收成 blocked，核实尝试 / 租约 / 修订号，幂等，署名与理由进审计；编排器自动路径只认可证明的机器续派残留）、`stalled-work-item`（平台可信收尾：把已无活执行者的 dispatched 项收成 blocked，一次围栏事务核对最后一次尝试 id 与工单修订号，独立事件 `work_item.platform_blocked`，不计入验收连续失败，COM12） |
| 机器验证 | `standard-validation`（Standard 机器验证）、`workspace-hygiene`（验证后收口记录、开跑前工作区核对、检查点失败的结构化事件与来源归因）、`validation-report-views`（验证报告投影）、`integration-verification`（合并结果验证） |
| 快车道 | `lightweight-dispatch`、`lightweight-submission`、`lightweight-validation`、`promotion`（晋升 Standard） |
| 交卷 | `mission-result-attachments`（平台自采的交卷附件：最后一次全量结果行、diff 统计、验收与工单对应）、`mission-result-criteria`（交卷 criteria 校验与闸门诊断） |
| 终审与合入 | `final-review`（人 / 检视者终审与知识落地；只有队列 Mission 在合入时跑项目集成验证）、`machine-finalization`（机器终审）、`independent-review`（独立检视）、`ha-validation`、`ha-finalization`、`ha-finalization-helpers` |
| 运行中变更 | `change-impact`（专属 impact 开 Attempt、读请求、提交判断、未决请求查询、失租旧 Attempt 收尾，同一事务围栏）、`change-receipt`（执行者读发给自己的 compatible 差异、逐层回执，围栏校验代次与活租约）、`change-coverage`（协调者记录重派后的工单覆盖声明，核对 compatible、可修订状态与当前工单哈希） |
| 时间归因 | `tool-activity`（工具结束事件 `runtime.tool.completed`，与命令开始同一串行队列、按 attemptId+callId 幂等）、`hop-events`（`hop.enqueued` / `hop.claimed` / `hop.backoff`，发生时点在 data，renew 不发）、`time-attribution-view`（`getTimeAttribution` 只读视图：读活动、验证报告起止与本 Mission 的 hop，调用纯投影） |
| 等待与自动恢复 | `auto-resume`（托管启动参数、到期等待的筛选、上游网络中断判定）、`heartbeat-continuation`（接管旧锁后按上一服务心跳窗口选出要续跑的 Mission）、`probe-reclaim`（孤儿半开探测名额回收）、`wait-info`（等待状态统一投影：谁处理、会不会自动恢复、下次重试、有没有活动 Agent、下一步；HTTP / MCP / 网页共用）、`model-policy`（Mission 级模型约束的事件存取） |
| 升级 | `escalations`（升级、契约核对、诊断与答复；同一 Attempt 已有未答复的普通升级时拒绝第二张，`ESCALATION_ALREADY_OPEN`，平台门禁卡与诊断卡不算，COM7） |
| 预算与用量 | `budget-usage`（用量聚合、权威预算）、`usage-helpers`（用量与时间纯辅助）、`ticket-budget`（单票费用上限与每 15 个工作项检查点的门禁） |
| 视图与简报 | `views`（只读视图）、`agent-view-helpers`（agent 视图纯投影）、`startup-brief`（开跑简报与裁剪审计）、`context-metrics`（摘要净化）、`delivery-status`（收件箱每条 pending 的 `stillOpen` 只读补注：不写、不 ACK、不读活动日志，WAKE1） |
| 活动 | `command-tracking`（命令活动事件） |

## 其他

| 目录 | 内容 |
|---|---|
| `test/` | `node --test`；`helpers/`，`fixtures/`（按字节比对，`-text`） |
| `scripts/` | 离线用量报告 `context-replay-report.mjs`；只告警的源码度量 `code-metrics.ts`；界面截图与设计稿尺寸比对 `web-shot.mjs`（比对在 `web-shot-compare.mjs`，规格 `specs/web-shot.md`） |
| `.coagent/` | 本文件、project.md、specs/、architecture/decisions/ |

## 适配层：`adapters/pi`（pi 适配器）

原为独立仓库 coagent-pi，2026-10-09 并入本仓 `adapters/pi/`；平台用的是 `adapters/pi/src/agent-entry.ts`。下表的文件路径相对 `adapters/pi/`。

| 文件 | 负责什么 |
|---|---|
| `src/roles.ts` | 各角色的系统提示词与工具白名单 |
| `src/tools.ts` | `coagent_*` 平台工具的名字、说明、参数（协调者另有 `coagent_get_validation_report`：只读平台验证报告全文，PI-COM1） |
| `src/extension.ts` | 按候选通道注入角色提示词与开跑简报（system 通道拼进系统提示，user 通道首跳作为一条用户消息交付一次，见 `specs/prompt-channel.md`）；写入越界、危险 git 命令的拦截 |
| `src/agent-entry.ts`、`src/runtime.ts` | 读 stdin 规格、跑 pi 会话、写结果行；执行者与协调者没做终结提交就结束时，在同一会话按角色提醒一次（PI-END1，2026-10-25 扩到协调者：协调者 no_structured_result 一个月 32 次、$13.54，是最大单点浪费）；xAI 额度失败时取重置时间只认 provider 为 xai 的用量行（`appendXaiQuotaReset`，PI-COM1） |
| `src/failure-classify.ts` | 上游失败分类 |
| `src/usage.ts` | 用量查询：xAI 与本机 10Router 并发（各 5 秒），xAI 行在前、形状不变；10Router `GET <root>/api/usage/quotas`（默认 `http://127.0.0.1:20128`，`COAGENT_TENROUTER_URL` 可覆盖，不带密钥）按上游聚合成 provider=tenrouter 行（upstream codebuddy-cn / antigravity / qoder-cn ↔ modelPrefix cbcn / ag / qdc）：按层级选可服务桶（汇总桶 → 非礼包总池 → 窗口桶），任一可用即可用，全部明确耗尽才 0/100，resetAt 只给会刷新的未来时刻；规格在 coagent-pi 的 `.coagent/specs/usage.md`（PI-COM1、PI-COM2） |

## 后端队列与分类角色（2026-10-04）

mission-queue.ts 负责项目执行配置、已确认 Mission 顺序/依赖的活动投影与启动配置固定；mission-queue-worker.ts 只负责调度和排空。main.ts 在持锁服务中复用 runHostedMission，不创建第二写者。run-queue.ts 只向本机服务提交清单；run-plan 入口已移除，`POST /api/control/run-plan` 返回 410。QueryRunner 使用 classifier 角色池，与 Mission 调度分开；字段、事实、熔断和健康视图沿用原候选仓储。

## L3 MCP 服务器：`l3-mcp-server`

Codex 插件与 Claude 工具（`agents/claude-code/tools/mcp.mjs`）共用的 stdio MCP 服务器，只经本机 HTTP 访问平台，不读平台状态文件。测试是 `*.spec.ts`（vitest），验证命令见 `project.md` 的「测试」一节。投递桥的行为见 `specs/l3-delivery-bridge.md`，平台侧收件箱语义见 `specs/delivery-inbox.md`。下表路径相对 `l3-mcp-server/`。

| 文件 | 负责什么 |
|---|---|
| `src/index.ts` | stdio 入口；握手之后开投递桥看护（`startBridgeSupervision`） |
| `src/tools.ts`、`src/widget-bridge.ts` | Mission / L3 的读写工具（读 Mission、答复升级、批准检查点、终审签字……）与 dashboard 小部件 |
| `src/mission-launch.ts` | `get_platform_status`（附只读 `deliveryBridge`）、`create_mission` / `start_mission`（recipient 必须显式；UUID v7 收件人建票即登记）、托管运行观测 |
| `src/reviewer-operations.ts`、`src/direct-control.ts` | Attempt / live、资源池、文档提议；direct 模式的主控操作 |
| `src/l3-bridge.ts`、`src/l3-daemon.ts` | 投递一轮（按收件人拉收件箱 → `codex queue` → ACK；`stillOpen: false` 直接 ACK；单条排队失败不堵同轮其他人）与守护进程（pid 单例、每秒轮询、失败退避） |
| `src/bridge-supervisor.ts`、`src/session-hook.ts`、`src/session-binding.ts` | 看护（钩子与 MCP 共用 `ensureBridge`，60 秒一查）、SessionStart 钩子（登记会话、写数据目录指针）、会话绑定与提示文案 |
| `src/l3-state.ts`、`src/coagenthub-client.ts` | 插件本地状态（数据目录解析：PLUGIN_DATA → COAGENTHUB_PLUGIN_DATA → 指针 → 默认；绑定登记表；健康文件）与本机 HTTP 客户端 |
