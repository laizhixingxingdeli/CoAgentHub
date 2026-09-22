# 子进程环境过滤（Spawn env filter）

`SpawnRuntime` 拉起的 agent / query 子进程**不得**继承整份宿主 `process.env`。未声明透传名单时 fail-closed；已声明空名单时只留 OS/代理基线。

## 可观察边界

- **未声明** `COAGENT_AGENT_ENV_PASSTHROUGH`（键缺失）→ 构造 `SpawnRuntime` / 生产接线直接抛错，文案点名该变量与「空串 = 只要基线」。**绝不**回落到整份 `process.env`，也绝不 warn-and-continue。
- **已声明空**（`''` 或纯空白）→ 子进程只得 `SPAWN_ENV_BASE_ALLOWLIST`（PATH/PATHEXT/系统根/临时目录/home/代理等 19 项）。
- **已声明名字**（逗号分隔）→ 基线 ∪ 这些名字；匹配**大小写不敏感**，拷贝源里的**原始键名**（Windows `Path`、POSIX `http_proxy` 都要活）。无通配：`*` 是字面量。
- 源里没有的名字直接省略，不造空字符串。
- **Query 路径同样过滤**：`createPiQueryRuntime` 在真正要构造时从**注入 env**读同一变量；未声明 throw。query 未启用时仍返回 `undefined`，不为透传抛错（观测-only `startServer` 不起 agent）。
- 接线层解析变量（`run-mission` / `createPiQueryRuntime`）；`SpawnRuntime` 本身不读该 env 键，只接受 `envPassthrough: string[]`（权威是 `Array.isArray`）。

## 非目标

本能力**只**管 spawn 出去的 agent 子进程环境过滤。

不是：文件系统隔离、网络 allowlist、CPU/内存/进程限额、日志/事件/产物里的凭证打码。那些属 Phase 6 / 其它票。

不是：kernel、Decision/Jev、budget、validation、promotion、HTTP query 面、Mission sandbox。

## 权威源 / 测试

- 源：`src/runtime/spawn.ts`（allowlist / `filterSpawnEnv` / 构造闸）、`src/runtime/pi-query.ts`、`src/run-mission.ts`
- 测试：`test/spawn-env.test.ts`；回归：`test/runtime-events.test.ts`、`test/query-run.test.ts`、`test/pi-query-runtime.test.ts`、`test/start-server.test.ts`
