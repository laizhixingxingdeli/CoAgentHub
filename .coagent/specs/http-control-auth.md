# HTTP 控制面可选鉴权（SEC-002 / AUTH-002）

`createApi` 可注入 `resolveControlPrincipal`。**不注入**时控制面保持历史免 control 凭据行为；注入后，敏感读与控制写在进入业务逻辑前按 Principal 门禁。**当前 `startServer` 控制写未鉴权，仅绑定 127.0.0.1**；它保留可替换的 resolver 注入入口，D1d 尚未实施。

**认证与授权分开**：入口先解析可信身份（本文件的 resolver），再求 `PolicyEngine`（`src/application/policy-engine.ts`）。引擎是纯判定，不读时钟、不碰存储。控制面身份映射为 Principal `user`（`operator` / `viewer`）；Run Token 映射为 `coordinator` / `executor`。另有 `reviewer`、`runner`，不从 HTTP 控制头或请求体自述产生。

与 `/api/agent/*` 和 `/api/run/brief` 的 `x-coagent-run` Run Token **正交**：control 凭据不能替代 Run Token，Run Token 也不能替代控制面身份。agent 请求不采信请求体自述的身份。

控制面 Principal 形状仍为 `{ id, role }`，`role` 为 `operator | viewer`。凭据如何从请求取出、何时过期由调用方 resolver 决定，本能力不拥有 TTL 或凭据时长策略。

resolver 允许三类结果：
- `undefined`：缺失或未知凭据 → `401 CONTROL_UNAUTHORIZED`。
- `{ status: 'expired' }`：已识别但过期 → `401 CONTROL_EXPIRED`。
- `{ id, role }`：已认证 Principal。

所有认证错误都不得回显原始控制凭据。

## 权限矩阵

| 路径类别 | viewer | operator |
| --- | --- | --- |
| 敏感 GET | 允许 | 允许 |
| 控制写 / ACK | 403 | 允许 |
| `/api/health`、`/api/version` | 公开 | 公开 |
| `/api/agent/*`、`/api/run/brief` | 只看 Run Token | 只看 Run Token |

resolver 若返回当前契约之外的角色，服务端 fail-closed 为 `403 CONTROL_FORBIDDEN`。
## 受保护的敏感读

注入 resolver 后，下列 GET 要求 viewer 或 operator：
- `/api/usage`、`/api/runtime/models`、`/api/projects`、`/api/pools`、`/api/missions`。
- Mission 详情、activity、live、attempt detail、diff。
- `/api/inbox`。

这些接口会暴露任务意图、等待原因、用量、运行时资源、事件、输出、证据或投递信息，因此不再作为匿名观测面。

## 受保护的写

写路径继续要求 operator：
- Mission create / classified / contract / pause / resume / cancel / finalize / escalation answer。
- Coordinator / Executor attempt start 与 attempt finish。
- Pool POST。
- `POST /api/deliveries/:id/ack`。

Inbox read 与 acknowledge 成对受保护；viewer 可查看 Inbox，但不能确认投递。

## 公开与 Run Token 路径

- `/api/health`、`/api/version` 保持公开。
- 静态 Web 资源本身保持公开；其敏感 API 请求受上述门禁。
- `/api/agent/*` 与 `/api/run/brief` 仍只认 Run Token，不叠加 control auth。

## PolicyEngine

判定已收拢到 `evaluatePolicy({ principal, action, context, state })`。五类 Principal：`user`、`reviewer`、`runner`、`coordinator`、`executor`。六类动作范围：Mission、WorkItem、Attempt、Pool、Inbox、Finalize。未知角色、未知动作、绑定不匹配默认拒绝。允许 / 错误角色 / 缺身份 / 过期身份矩阵见 `test/policy-engine.test.ts`。

**读写口径不在本项改。** 现网注入 resolver 后仍是「敏感读允许 viewer/operator，写只允许 operator」。D1d 按用户已定口径落地：只对控制写开鉴权，敏感读在本机回环维持匿名（`decisions.d1dWebAuth`）。

拒绝时的错误体与日志不回显凭据。D1d 未合入前不得假定生产已启用控制面鉴权。

## Non-goals

- `startServer` strict auth wiring / Web 端凭据 UX。
- Run Token expiry / scope / audience（规格与代码都不得声称已强制执行）。
- 通用 RBAC、Sandbox、Jev 执行权威。
- 开放 HA 路由或机器 HA 放行。
