# 运行时状态路径、实时输出与模型清单

直接执行 `node src/main.ts` 且未设 `COAGENT_STATE` 时，状态文件缺省为该 `src/main.ts` 所在仓库根的 `.coagent-state.json`，与调用时的 cwd 无关。缺省路径不存在则拒绝启动并提示通过 `COAGENT_STATE` 显式指定，不静默创建新状态；显式指定路径仍可按原行为新建。

文件存储的常驻服务与无服务独立 `run-plan` / `run-mission` 将同一平台实例的 `InMemoryLiveOutput` 接给运行编排及本机回环 API；`GET /api/missions/:id/live?cursor=N` 可按游标读取 agent 输出，复用现有脱敏及内存上限，不将实时行写入状态文件。PG 保留既有实时输出实现，输出的历史落盘不属于本能力。

`GET /api/runtime/models` 先走原有控制面读鉴权；同一 HTTP 服务实例缓存 `available:true` 的清单 10 分钟，有效期内请求不重复调用适配层，过期重读。失败结果不缓存，不同服务实例不共享缓存；响应结构不变。

源：`src/main.ts`、`src/application/live.ts`、`src/api/server.ts`、`src/application/runtime-catalog.ts`。验证：`test/start-server.test.ts`、`test/live-output.test.ts`、`test/runtime-catalog.test.ts`。
