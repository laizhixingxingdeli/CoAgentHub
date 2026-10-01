# 运行时状态路径、实时输出与模型清单

直接执行 `node src/main.ts` 且未设 `COAGENT_STATE` 时，状态文件缺省为该 `src/main.ts` 所在仓库根的 `.coagent-state.json`，与调用时的 cwd 无关。缺省路径不存在则拒绝启动并提示通过 `COAGENT_STATE` 显式指定，不静默创建新状态；显式指定路径仍可按原行为新建。

文件存储的常驻服务与无服务独立 `run-plan` / `run-mission` 将同一平台实例的 `InMemoryLiveOutput` 接给运行编排及本机回环 API；`GET /api/missions/:id/live?cursor=N` 可按游标读取 agent 输出，复用现有脱敏及内存上限，不将实时行写入状态文件。PG 保留既有实时输出实现，输出的历史落盘不属于本能力。

每跳结束时，`Platform.finishAttempt` 从同一 live 通道按 missionId 与 attemptId 读取该跳文本/工具输出的最后不超过 200 行（多行 chunk 按行算），不计 usage/note 或其它跳；分页扫描保持内存尾部有界。与原 outcome.output 合并后复用 `redactSecrets`，在写入状态及 artifact 前脱敏。已结束的重复收尾不重复追加；无 live 通道或无行保留原输出。文件版重启后及 PG 模式可经现有本机回环 attempt detail 的 output 字段读取，不新增历史全文接口；实时游标与内存留存策略不变。

`GET /api/platform/status` 是本机只读运维快照：报告实例 identity（instanceId、API 版本、pid、启动时间、statePath、监听回环地址、主锁是否由本服务持有）、持久队列 queued/claimed/retry_wait/dead_letter/completed 数量与死信原因摘要、有效 claimed 的 global/project/role/runtime/profile 五维容量占用，以及 agent 子进程环境是否仅基线透传、可用的默认适配器；PG/内存不适用项明确标明，不虚构状态。死信按最近时间在前。`GET /api/pools` 原候选及添加语义不变，逐候选附熔断状态和截止、最近失败类别与时间、从近 7 日 attempt 用量汇总的尝试/成功/花费；未配置运行时明确说明原因。两个读取都走已有控制面读鉴权，不公开凭据、不新增写操作。

`GET /api/runtime/models` 先走原有控制面读鉴权；同一 HTTP 服务实例缓存 `available:true` 的清单 10 分钟，有效期内请求不重复调用适配层，过期重读。失败结果不缓存，不同服务实例不共享缓存；响应结构不变。

`GET /api/runtime/usage` 经现有读鉴权调用适配器目录内 `npx tsx src/cli.ts usage`，读取 stdout 的 PI-Q1 顶层 JSON 数组并原样转出；目录依次取 `COAGENT_ADAPTER_DIR`、最近一次运行的 `--adapter` 所在目录、同级缺省目录。有效结果在服务内缓存 10 分钟；失败或不支持返回 `{ available: false, note }`，不阻断其他功能。平台不保存或解释适配器凭据。`GET /api/pools` 的候选 health 关联同 provider 的用量行，携带套餐、remainingPercent、resetAt；额度熔断显示重置时间或待充值人工复位原因和命令，资源池页作相同展示，其他失败类不受影响。

源：`src/main.ts`、`src/application/live.ts`、`src/application/platform.ts`、`src/application/agent-pool.ts`、`src/application/candidate-circuit.ts`、`src/application/durable-scheduler.ts`、`src/api/server.ts`、`src/application/runtime-catalog.ts`。验证：`test/start-server.test.ts`、`test/live-output.test.ts`、`test/redact.test.ts`、`test/api.test.ts`、`test/agent-pool.test.ts`、`test/candidate-circuit.test.ts`、`test/runtime-catalog.test.ts`。
