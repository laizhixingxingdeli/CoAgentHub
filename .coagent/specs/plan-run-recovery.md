# 方案运行等待与叫停后续跑

本能力细化 `plan-run` 的运行内等待资格与开跑前续跑资格，不改变原有升级、停止和决定语义。

当本次 `runMission` 返回 `project_busy`，驱动只在持久 Hop 记录证实属于同一 Mission 的未来 `retry_wait.availableAt`，或有效 `claimed.leaseUntil` 占位时在本次运行内等待并重新运行同一个 Mission。退避等到到期，容量占位仅短轮询并重新检查；其它 Mission 占用、不明来源与队列读取失败仍按原失败/升级路径处理，不凭 detail 文案猜归属。当返回 `no_available_agent`，仅在本次 waiting 明确携带 candidateRole、同一个 MissionRunner 对该角色的候选快照非空且每个候选都明确冷却并有有效未来到期、最早到期在十五分钟内时等待；无角色、空池、可用/未知候选、超长冷却及探针读取失败仍走旧升级路径。hosted 及独立 run-plan 使用同一资格规则。等待期间每轮检查停止条件与墙钟，到期不再启动下一次 runMission，符合资格并到期后在同一运行、同一 Mission 继续，不开升级单。

开跑前若 paused executing Mission 被同一方案/项目历史的多条 `reviewer_stop` 运行记录认领，仅取最近一条同 Mission 记录判断认领；较早记录不再计为冲突。历史损坏、单次多功能认领、本次 selection 非唯一、状态不符及其它占位仍拒绝续跑。

源：`src/application/plan-driver.ts`、`src/application/plan-runtime.ts`、`src/application/plan-preflight.ts`、`src/application/orchestrator.ts`、`src/application/mission-runner.ts`、`src/run-plan.ts`。验证：`test/plan-driver.test.ts`、`test/plan-resume-runtime.test.ts`、`test/plan-preflight.test.ts`、`test/run-plan-wiring.test.ts`。
