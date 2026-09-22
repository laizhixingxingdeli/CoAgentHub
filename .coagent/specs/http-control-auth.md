# HTTP 控制面可选鉴权（SEC-002 / AUTH-002）

`createApi` 可注入 `resolveControlPrincipal`。**不注入**时控制面保持历史免 control 凭据行为；注入后，敏感读与控制写在进入业务逻辑前按 Principal 门禁。

与 `/api/agent/*` 和 `/api/run/brief` 的 `x-coagent-run` Run Token **正交**：control 凭据不能替代 Run Token，Run Token 也不能替代控制面身份。

Principal 形状仍为 `{ id, role }`，`role` 为 `operator | viewer`。凭据如何从请求取出、何时过期由调用方 resolver 决定，本能力不拥有 TTL 或凭据时长策略。

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

## Non-goals

- `startServer` strict auth wiring / Web 端凭据 UX。
- Run Token expiry / scope / audience。
- 完整 PolicyEngine / 通用 RBAC、Sandbox、Jev。
