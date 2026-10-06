# 模块地图

读代码前先看这张表：每个目录负责什么、从哪进、不能越过什么线。检视者维护；协调者交卷里「动了哪些目录、对外接口变化」有新东西时更新。**不随每一跳发送**，按需读。

大文件按方法名搜索定位，别整份读：`orchestrator.ts` 约 3,000 行、`platform.ts` 约 2,400 行（入口外壳，实质用例体在 `platform/` 下）、`web/task.js` 约 1,850 行、`api/server.ts` 约 2,200 行。

## 源码（`src/`）

| 目录 / 文件 | 负责什么 | 关键入口 | 边界 |
|---|---|---|---|
| `src/kernel/` | 纯领域：Mission / WorkItem / Attempt 状态机，契约、工单、结论等载荷类型 | `mission.ts`、`work-item.ts`、`attempt.ts`、`payloads.ts` | 不 import 任何东西（`test/kernel-imports.test.ts` 钉死） |
| `src/application/platform.ts` | 所有写命令的唯一用例入口：`Platform` 类的公开方法、构造与字段、context 装配；方法体转调 `platform/` 下的职责模块（REF1，2026-10-02） | `Platform` 的公开方法（`createClassifiedMission`、`reviewExecutionResult`、`finalizeMissionByMachine`…） | 规则写在 `platform.ts` 与 `platform/`，不写在 HTTP handler 或 prompt 里；外部只从 `platform.ts` 引用（各模块的名字由它再导出） |
| `src/application/platform/` | `Platform` 的实质用例体，按职责分 48 个模块（见下节） | 各模块导出 `(ctx, 原参数)` 形式的函数，`ctx` 是 `context.ts` 的共用状态 / 事务 / 事件 | 只由 `platform.ts` 调用；写事件走 `ctx.event(…)`（与 `#event` 等价，护栏测试两种写法都认） |
| `src/application/orchestrator.ts` | 每一跳的调度：唤醒协调者 / 执行者、换候选、检查点、快车道分支、协调者唤醒指令；执行者 wait 期间可选的 impact 监督接线（`impactSupervision`，默认关闭） | `Orchestrator.runMission` | 只调 Platform，不直接改状态；执行者路径只调一次 `run.wait()`，finally 先 `stopAndJoin` |
| `src/application/change-request*.ts`、`change-impact*.ts`、`impact-supervisor.ts` | 运行中变更：L3 确认的原始请求（B1）、L2 影响判断的 append-only 记录（B2b）、执行者 wait 期间的有界 impact 监督（B2b） | `ChangeRequestRepository`、`ChangeImpactRepository`、`beginImpactSupervision` | 只保存判断，不投递、不应用；生产入口未接线（见 `specs/runtime-change.md`） |
| `src/application/plan-*.ts`、`mission-runner.ts` | 方案运行：解析与筛选（`plan-spec`）、分类与路由（`plan-routing`）、逐票驱动（`plan-driver`）、运行记录与升级单（`plan-run`、`plan-run-store`）、装配（`plan-runtime`）、预检（`plan-preflight`）、交接面（`plan-handoff`）、单 Mission 运行与轮次上限（`mission-runner`） | `runPlanOnPlatform`、`MissionRunner.run` | 方案记录是独立 JSON，不进主状态 |
| `src/application/durable-scheduler.ts`、`candidate-circuit.ts`、`agent-pool.ts`、`runtime-catalog.ts` | 持久队列（租约、代次、五维容量、重试、死信）、候选熔断、候选池、模型清单 | 队列是纯函数 `claimHop` / `renewHop` / `reportHopFailure`；候选池 `AgentPoolRepository` | 候选按平台当前角色有序配置读取；整角色替换核对 revision，在途身份不变 |
| `src/application/context-builder.ts`、`project-memory.ts`、`context-attribution-report.ts` | 给协调者 / 执行者的简报打包；读 `.coagent/`、生成 VIBE.md、写 memoryDelta；用量归因 | `buildContextBundle`、`readProjectMemory`、`generateVibe` | 简报只放白名单来源 |
| `src/application/validation/`、`promotion/`、`task-classifier.ts`、`classified-mission-intake.ts`、`query-run.ts`、`query-promotion.ts` | 机器验证（跑命令、查改动范围、改动量）；快车道晋升判定；确定性分类；只读问答 | `ValidationEngine`、`classifyTask` | 验证命令不经 shell；分类只认事实，不认 caller 自填路由 |
| `src/application/decision-*.ts`、`jev-*.ts`、`post-execution-*.ts`、`phase2-shadow-exit-evaluator.ts` | Jev 决策引擎接入，只在影子模式记录 | `decision-shadow-runner.ts` | 无执行权威（ADR-0002） |
| `src/application/ports.ts`、`in-memory.ts`、`file-store.ts`、`pg-store.ts`、`artifact-store.ts`、`live.ts`、`delivery.ts` | 仓储接口与三种实现、大输出外置、实时输出、投递收件箱 | `FileStateStore`、`PgStateStore` | 第三方依赖只在 `pg-store.ts` |
| `src/application/reconcile.ts`、`lock.ts`、`loopback-*.ts`、`token-issuer.ts` | 启动与周期修复、主锁（单写者）、常驻服务本机回环、run token | `acquireLock`、`probeLocalWriter` | 单机单写者 |
| `src/application/policy-engine.ts`、`ha-authority-config.ts`、`redact.ts` | 主体 × 动作的授权表、高保证放行授权、凭据脱敏 | `PolicyEngine` | 引擎不读时钟、不碰存储 |
| `src/application/workspace.ts` | git worktree：建、合并、回滚、检查点、改动摘要 | `GitWorktreeManager`（实现 `WorkspaceManager`） | master 不动；合并只进集成分支 |
| `src/application/code-metrics.ts`、`platform/code-metrics-files.ts` | 零依赖近似源码告警、src 文件读取；交卷附件与离线脚本共用 | `analyzeCodeMetrics`、`collectCodeMetrics` | 仅读源码，告警不参与验收判定 |
| `src/api/` | HTTP：路由表、agent 工具表、托管运行（`server.ts`）；网页后端视图（`web.ts`）；静态文件、run token、控制面鉴权 | `createApi` | 只调 Platform 公开方法，不写规则 |
| `platform/reviewer-todos.ts`、`reviewer-duty.ts`、`master-brief.ts` | 权威源待办投影、持久值守租约、真实 Git 合 master 简报 | Platform 的 reviewer 方法 | 读不 ACK；确认不解门禁；master 只读，不执行合并 |
| `platform/document-queue.ts`、`application/document-files.ts` | 文档精确差异、持久提议状态、批准后的空档提交及重入恢复 | `listDocumentProposals`、`decideDocument`、`flushDocumentQueue` | 代码合入不自动落文档；基线漂移重审；隔离检出提交后核对目标，master 不动 |
| `src/api/reviewer-wait.ts`、`reviewer-mcp.ts`；`scripts/reviewer-watch.ts`、`reviewer-mcp.ts` | 有界守候、零依赖 stdio MCP、显式客户端 | HTTP 与 MCP 入口 | 所有状态经服务；不自动启动、不创建定时任务、不改已安装插件 |
| `src/runtime/` | 起 agent 子进程与协议（stdin 规格、stdout 事件行与结果行）；只读查询运行时；测试用脚本运行时 | `spawn.ts`、`pi-query.ts`、`scripted.ts` | 不依赖任何 agent SDK |
| `src/web/` | 无构建前端：路由（`app.js`）、项目页（`projects.js`、`project-catalog.js`、`project-spec.js`）、任务页（`task.js`）、收件箱（`inbox.js`）、角色与模型（`agents.js`）、设置（`settings.js`）、方案运行页、平台页、资源池页、事件叙事（`narrate.js`）、样式（`ui.css`） | `index.html` | 只走 `/api/*` |
| `src/main.ts` | 常驻服务与三种装配（内存 / 文件 / PG） | `startServer`、`buildPersistentPlatform`、`buildPgPlatform` | 状态文件路径必须显式 |
| `src/l3.ts`、`src/run-queue.ts`、`src/run-mission.ts`、`src/run-plan.ts` | 检视者命令、已确认 Mission 队列提交、单 Mission 运行；旧 Plan 入口只作历史预检/兼容 | 各文件顶部用法说明 | 写命令在持锁服务里执行；不新建 PlanRun |

## `src/application/platform/` 按职责

改哪类规则先找对应模块，别从 `platform.ts` 顺着读。

| 职责 | 模块 |
|---|---|
| 共用底座 | `context`（共用状态、事务、事件）、`types`（公开视图与依赖类型）、`mutation-lane`（改动名额、快车道校验） |
| Mission 生命周期 | `mission-intake`（创建、分类、重跑）、`mission-lifecycle`（生命周期控制）、`mission-control`（作废、交卷控制）、`planning`（规划更新） |
| Attempt | `attempts`（开跑、收尾、心跳） |
| 工作项与工单 | `work-orders`（建单、修订）、`work-order-helpers`（工单校验）、`work-item-dispatch`（派发）、`work-item-review`（评审）、`executor-submissions`（执行者证据、结果、blocked）、`standard-redispatch`（Standard 续派）、`redispatch-helpers`（续派纯辅助）、`conflict-dispatch`（冲突派发屏障） |
| 机器验证 | `standard-validation`（Standard 机器验证）、`validation-report-views`（验证报告投影）、`integration-verification`（合并结果验证） |
| 快车道 | `lightweight-dispatch`、`lightweight-submission`、`lightweight-validation`、`promotion`（晋升 Standard） |
| 交卷 | `mission-result-attachments`（平台自采的交卷附件：最后一次全量结果行、diff 统计、验收与工单对应）、`mission-result-criteria`（交卷 criteria 校验与闸门诊断） |
| 终审与合入 | `final-review`（人 / 检视者终审与知识落地；只有队列 Mission 在合入时跑项目集成验证）、`machine-finalization`（机器终审）、`independent-review`（独立检视）、`ha-validation`、`ha-finalization`、`ha-finalization-helpers` |
| 运行中变更 | `change-impact`（专属 impact 开 Attempt、读请求、提交判断、未决请求查询、失租旧 Attempt 收尾，同一事务围栏） |
| 升级 | `escalations`（升级、契约核对、诊断与答复） |
| 预算与用量 | `budget-usage`（用量聚合、权威预算）、`usage-helpers`（用量与时间纯辅助）、`ticket-budget`（单票费用上限与每 15 个工作项检查点的门禁） |
| 视图与简报 | `views`（只读视图）、`agent-view-helpers`（agent 视图纯投影）、`startup-brief`（开跑简报与裁剪审计）、`context-metrics`（摘要净化） |
| 活动与影子 | `command-tracking`（命令活动事件）、`post-execution`（执行后影子） |

## 其他

| 目录 | 内容 |
|---|---|
| `test/` | `node --test`；`helpers/`（PG 隔离库、探针），`fixtures/`（按字节比对，`-text`） |
| `scripts/` | 离线用量报告 `context-replay-report.mjs`；只告警的源码度量 `code-metrics.ts` |
| `.coagent/` | 本文件、project.md、specs/、architecture/decisions/ |

## 相邻仓库：coagent-pi（pi 适配器）

`C:/program1/coagent-pi`，平台用的是它集成分支上的 `src/agent-entry.ts`。

| 文件 | 负责什么 |
|---|---|
| `src/roles.ts` | 各角色的系统提示词与工具白名单 |
| `src/tools.ts` | `coagent_*` 平台工具的名字、说明、参数 |
| `src/extension.ts` | 每轮注入角色提示词与开跑简报；写入越界、危险 git 命令的拦截 |
| `src/agent-entry.ts`、`src/runtime.ts` | 读 stdin 规格、跑 pi 会话、写结果行；执行者没做终结提交就结束时，在同一会话提醒一次（PI-END1） |
| `src/failure-classify.ts` | 上游失败分类 |

## 后端队列与分类角色（2026-10-04）

mission-queue.ts 负责项目执行配置、已确认 Mission 顺序/依赖的活动投影与启动配置固定；mission-queue-worker.ts 只负责调度和排空。main.ts 在持锁服务中复用 runHostedMission，不创建第二写者。run-queue.ts 只向本机服务提交清单；run-plan.ts 保留历史只读预检与兼容转发，生产执行退役。QueryRunner 使用 classifier 角色池，与 Mission 调度分开；字段、事实、熔断和健康视图沿用原候选仓储。
