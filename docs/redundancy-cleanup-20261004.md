# 冗余代码与测试清理（CLEAN1 / CLEAN3）

直接实施基线为 6d42dfe；按用户 2026-10-03 授权修改，本报告不代表真实平台 Mission/L2/L3 已交卷。旧票的 docs/reports 路径随后续取消 reports 目录的决定改为本文件。

## 代码

盘点方法：遍历全部 src/test 的 TS/JS 文件，提取 export function/class/interface/type/const/enum 声明，对词边界计算引用；再扩查 scripts、规格、文档及相关适配器源码。引用数只作线索，不能证明动态入口、公开类型或功能开关模块已废弃。统计行数采用 split 换行，含注释与末尾空行；基线用 git cat-file --batch，当前使用真实工作树。

|范围|基线文件/行|当前文件/行|
|---|---:|---:|
|源码（不含内核）|142 / 52490|145 / 52601|
|测试|147 / 86790|150 / 86945|
|TS/JS 合计|297 / 142988|303 / 143254|

当前总行数包含 UI1/PL1 新功能；不能把功能净变化当清理收益。清理证据逐项如下：
- agent-pool 的 loadPoolOrSeed 与 DEFAULT_AGENT_POOL：生产路径零调用，只有自身测试和两个历史测试 fixture 使用。移除自动播种及其四个测试，历史候选转到 test/helpers/agent-pool.ts 显式配置。相关播种块约45行；运行入口保持空池停靠。
- withCandidateHealth、AgentPoolSnapshotWithHealth、AgentPoolCandidateWithHealth：src/test/scripts/规格/文档及适配器检索只有自身定义和相互引用；HTTP 健康聚合使用异步正式路径，旧同步辅助函数没有调用方。删除整个25行组，健康响应不变。
- run-plan：PL1 明确退役后 throw 后的离线建平台、API、PlanRun 与清理主体不可达；删除约260行主体及无引用的导入、toProfile/stamp/独立日志常量。保留历史 --check、只读预检和回环兼容，生产服务返回410。此项行为变更属于 PL1，不作为 CLEAN1 的无行为变更宣称。
- run-plan 的 missionRunOptions：生产调用随退役主体消失，只剩自身测试；删除4行辅助函数和该测试。run-mission 同名函数仍真实使用并保持测试。
- mission-intake.createMission：移除未读的 callback 参数，全部生产调用仍使用同一 canonical intake；创建行为不变。
- TODO 扫描未发现可删的过期实现 TODO；deprecated PRE 题规格兼容别名继续保留。

## 测试

CLEAN3 对候选故障语义采用表驱动：保留原14个计费/403输入与预期，减少重复调用，仍只用一个关键场景覆盖“计费可替换、单纯403不可替换”。没有为了压低测试数删除反例。Postgres 查询 fixture 改为显式分类候选，并为 pg-store 使用独立测试库，避免与候选池测试相互清表及后续运行残留。

被删测试只随明确废弃的播种与退役 helper 删除；旧 Plan 独立执行副作用测试改为退役不写状态断言，独立检视与退避接线守卫转向实际 MissionRunner；这些是 PL1 行为变更，不计作 CLEAN3 删除覆盖。HAOFF1 七条 skip 原样保留。

## 保留 / 待用户决定

未删 PG、HAOFF1、预算、Jev OFF/SHADOW、QueryRun/晋升、WEB_PAGE，以及规格描述的任何行为。历史 PlanRun 查询、答复、恢复和显式测试兼容装配保留；彻底删除它们须先有历史数据迁移方案。serveReviewerMcp 虽在 src/test 只出现定义，scripts/reviewer-mcp.ts 有真实调用，已排除死代码判断。

以下静态低引用导出均保留；行号为盘点时位置，后续清理可能移动。类型、常量或公开入口缺少动态/外部调用证明，暂不删除，不阻塞已确认后端完成：

|文件|行|导出|src/test 词引用数|
|---|---:|---|---:|
|src/api/control-auth.ts|14|ControlRole|2|
|src/api/control-auth.ts|26|ExpiredControlCredential|2|
|src/api/reviewer-mcp.ts|114|serveReviewerMcp|1|
|src/application/agent-pool.ts|178|agentPoolRevision|2|
|src/application/budget-usage.ts|114|BuildBudgetUsageSnapshotInput|2|
|src/application/budget-usage.ts|160|AuthoritativeRoundCount|2|
|src/application/budget-usage.ts|170|AuthoritativeWallClockMs|2|
|src/application/budget-usage.ts|180|AuthoritativeCommandCount|2|
|src/application/budget-usage.ts|708|SOFT_BUDGET_DIMENSIONS|2|
|src/application/budget-usage.ts|715|HardBudgetDimension|1|
|src/application/budget-usage.ts|716|SoftBudgetDimension|1|
|src/application/budget-usage.ts|728|budgetDimensionClass|2|
|src/application/candidate-circuit.ts|3|CandidateCircuitState|1|
|src/application/candidate-circuit.ts|51|QuotaResetInput|2|
|src/application/candidate-circuit.ts|161|CandidateFailureClassification|2|
|src/application/candidate-circuit.ts|194|CandidateFailureSource|2|
|src/application/candidate-circuit.ts|202|CandidateLastFailureObservation|2|
|src/application/context-attribution-report.ts|14|TOOL_ACTIVITY_TAIL_MAX|2|
|src/application/context-attribution-report.ts|42|ContextAttributionUsageQuality|2|
|src/application/context-attribution-report.ts|60|ContextAttributionTruncation|2|
|src/application/context-attribution-report.ts|126|ContextAttributionReport|2|
|src/application/context-builder.ts|93|ContextBuilderInput|2|
|src/application/context-builder.ts|138|StartupBriefProjection|2|
|src/application/decision-question-registry.ts|39|TaskTypeOption|2|
|src/application/decision-question-registry.ts|43|PreferredExecutorOptionSource|2|
|src/application/decision-question-registry.ts|45|QuestionKind|1|
|src/application/decision-question-registry.ts|53|SEMANTIC_RISK_ORDERED_LEVELS|2|
|src/application/decision-question-registry.ts|60|SemanticRiskLevel|1|
|src/application/decision-shadow-runner.ts|71|DecisionShadowOutcome|2|
|src/application/decision-shadow-runner.ts|79|RunDecisionShadowArgs|2|
|src/application/decision-state-builder.ts|13|DecisionStateSchemaVersion|2|
|src/application/durable-scheduler.ts|4|HopPriority|2|
|src/application/durable-scheduler.ts|83|ClaimableHop|1|
|src/application/durable-scheduler.ts|114|HOP_FAILURE_BACKOFF_BASE_MS|2|
|src/application/durable-scheduler.ts|227|HopCapacityDimension|1|
|src/application/durable-scheduler.ts|268|CapacityClaimDecision|2|
|src/application/durable-scheduler.ts|360|QUEUED_HOP_STATUSES|2|
|src/application/durable-scheduler.ts|419|HopOccupancySnapshot|2|
|src/application/ha-authority-config.ts|346|isMasterBranch|2|
|src/application/jev-decision-provider.ts|40|JevSystemOneQuestion|2|
|src/application/jev-decision-provider.ts|66|JevSystemOneScoreLegend|2|
|src/application/jev-decision-provider.ts|104|JevDecisionProviderOptions|2|
|src/application/jev-post-execution-evaluator.ts|17|JevPostExecutionEvaluatorOptions|2|
|src/application/jev-post-execution-mapper.ts|26|JevPostExecutionQuestion|2|
|src/application/jev-post-execution-mapper.ts|40|JevPostExecutionRequest|2|
|src/application/jev-post-execution-mapper.ts|47|JevPostExecutionScoreLegend|2|
|src/application/jev-system-one-http-transport.ts|16|JevSystemOneHttpTransportOptions|2|
|src/application/lock.ts|40|LocalWriterProbe|2|
|src/application/lock.ts|443|ProbeLocalWriterOptions|2|
|src/application/lock.ts|630|RecoverableLockOptions|2|
|src/application/loopback-control-client.ts|15|LOOPBACK_CONTROL_TIMEOUT_MS|2|
|src/application/loopback-control-client.ts|43|LoopbackControlRequest|2|
|src/application/loopback-control-client.ts|183|LoopbackRunRequest|2|
|src/application/loopback-control-client.ts|188|LoopbackRunLine|2|
|src/application/loopback-listen.ts|30|ListenLoopbackOptions|2|
|src/application/mission-runner.ts|96|MissionRunnerResult|2|
|src/application/orchestrator.ts|96|RoleCooldownAvailability|2|
|src/application/orchestrator.ts|139|OrchestratorDeps|2|
|src/application/pg-store.ts|210|PgOptions|2|
|src/application/pg-store.ts|215|pgConnectionString|2|
|src/application/pg-store.ts|231|PgAdvisoryLock|2|
|src/application/phase2-shadow-exit-evaluator.ts|54|Phase2AnswerLabelValue|2|
|src/application/phase2-shadow-exit-evaluator.ts|90|Phase2ExitCounts|2|
|src/application/phase2-shadow-exit-evaluator.ts|100|Phase2ExitMetrics|2|
|src/application/phase2-shadow-exit-evaluator.ts|119|EvaluatePhase2ShadowExitOptions|2|
|src/application/pipeline.ts|23|PipelineItem|2|
|src/application/pipeline.ts|35|PipelineOptions|2|
|src/application/plan-run-store.ts|148|PlanRunFeatureSummary|2|
|src/application/plan-run-store.ts|173|PlanRunReadResult|2|
|src/application/plan-runtime.ts|69|PlanRuntimeDeps|2|
|src/application/plan-runtime.ts|104|QueuedHopWaitEligibilityDeps|2|
|src/application/plan-runtime.ts|184|PlanWaitEligibilityDeps|2|
|src/application/plan-spec.ts|60|PlanVerificationCommand|2|
|src/application/platform/escalations.ts|151|TicketGateCallbacks|2|
|src/application/platform/reviewer-duty.ts|3|REVIEWER_DUTY_LEASE_MS|2|
|src/application/platform/ticket-budget.ts|230|cleanupResolvedCostGate|2|
|src/application/platform/ticket-budget.ts|294|parseTicketGateAnswer|2|
|src/application/platform/ticket-budget.ts|308|applyTicketGateAnswer|2|
|src/application/policy-engine.ts|23|PolicyReason|2|
|src/application/policy-engine.ts|33|PrincipalKind|1|
|src/application/policy-engine.ts|56|ActionScope|2|
|src/application/policy-engine.ts|76|PolicyState|2|
|src/application/policy-engine.ts|81|PolicyInput|2|
|src/application/ports.ts|258|ContextMetricsBriefV1|2|
|src/application/ports.ts|349|DecisionUsage|2|
|src/application/post-execution-offline-eval.ts|14|GroundTruthReview|2|
|src/application/post-execution-offline-eval.ts|48|OfflineEvalReport|2|
|src/application/post-execution-remote-input.ts|22|PostExecutionRemoteTruncation|2|
|src/application/post-execution-state.ts|26|CheckStatus|2|
|src/application/promotion/lightweight-gate.ts|19|LightweightGateTrigger|2|
|src/application/promotion/new-dependency-detector.ts|10|NewDependencyDetectInput|2|
|src/application/promotion/validator-failure-unrepairable-detector.ts|12|ValidatorFailureUnrepairableDetectInput|2|
|src/application/query-promotion.ts|70|QueryPromotionErrorCode|2|
|src/application/reconcile.ts|157|OrphanWorktreeReconcileResult|2|
|src/application/reconcile.ts|239|RepairMissingDeliveriesOptions|2|
|src/application/reconcile.ts|674|DEFAULT_RECONCILE_INTERVAL_MS|2|
|src/application/reconcile.ts|698|StartPeriodicReconcileInput|2|
|src/application/task-classifier.ts|37|ClassifyTaskInput|2|
|src/application/ticket-budget.ts|22|MissionCostResult|2|
|src/main.ts|552|DecisionDeps|2|
|src/main.ts|651|PgDeliveryRepairTickInput|2|
|src/main.ts|704|StartPeriodicDeliveryRepairInput|2|
|src/main.ts|876|StartServerOptions|2|
|src/runtime/scripted.ts|21|ScriptStep|2|
|src/runtime/scripted.ts|36|Script|2|
|src/web/narrate.js|155|ROLE_TONE|2|
|src/web/narrate.js|1032|PLAN_FEATURE_CN|2|
|src/web/narrate.js|1041|PLAN_STOP_CN|2|
|src/web/narrate.js|1052|PLAN_ACTION_CN|2|
|src/web/narrate.js|1060|PLAN_HA_CN|2|
|src/web/narrate.js|1137|CONTEXT_METRIC_LABEL|2|
|src/web/narrate.js|1146|contextMetricLabel|2|
|src/web/narrate.js|1160|bytesText|2|
|src/web/plan-run.js|64|missionIdsOfRun|2|
|src/web/plan-run.js|83|collectFeatureMissionIds|2|
|src/web/plan-run.js|128|orderMissionIds|2|
|src/web/plan-run.js|424|planRunPageHtml|2|
|src/web/pool.js|211|countCardsHtml|2|
|src/web/pool.js|222|tablesHtml|2|
|src/web/pool.js|258|parseModelValue|2|

## 验证

最终全量测试结果见 backend-remaining-delivery-20261004.md；只允许既有 HAOFF1 7 skip。没有修改 kernel、package.json 或运行期状态、日志、投递、真实工作区数据。
