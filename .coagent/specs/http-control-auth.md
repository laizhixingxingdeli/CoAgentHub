# HTTP 控制面可选鉴权（SEC-002）

`createApi` 可注入 `resolveControlPrincipal`；**不注入**时写路由保持历史匿名可写行为（本地与既有测试零摩擦）。注入后，受保护控制写路径在进入原业务逻辑前按 Principal 角色门禁。

与 `/api/agent/*` 的 `x-coagent-run` Run Token **正交**：控制凭据不能替代 Run Token，Run Token 也不能替代控制面身份。

## 注入后的写门禁

受保护写路由调用 `requireControl`：

| 条件 | HTTP | `error` 码 |
| --- | --- | --- |
| 缺失或未知控制凭据（resolver 返回 `undefined`） | 401 | `CONTROL_UNAUTHORIZED` |
| 已识别但非 operator（如 `viewer`） | 403 | `CONTROL_FORBIDDEN` |
| `role === 'operator'` | 进入原业务路径（业务层仍可返回 4xx，但不是本门禁的 401/403） | — |

错误响应体**不得**回显原始控制凭据（token 字符串等）。

Principal 形状：`{ id, role }`，`role` 为 `operator | viewer`。凭据如何从请求取出由调用方注入的 resolver 决定（测试常用自定义头）；本切片不绑定具体头名到生产接线。

## 本切片受保护的写路由类别

- **Mission create / contract / control / finalize / escalation answer**  
  例如：`POST /api/missions`、`…/contract`、`…/pause`、`…/resume`、`…/cancel`、`…/finalize`、`…/escalations/answer`
- **Attempt start / finish**  
  例如：`POST …/coordinator-attempts`、`…/work-items/:id/executor-attempts`、`…/attempts/:id/finish`
- **Pool POST**  
  例如：`POST /api/pools`

## 读路径与 agent 工具

- 本切片**读路径仍匿名**（如 `/api/health`、`/api/version`、`GET /api/missions`、`GET /api/pools` 等），即使已注入 resolver。
- `/api/agent/*` 仍只认 Run Token；仅带控制凭据、无有效 `x-coagent-run` → `401 UNKNOWN_RUN_TOKEN`。

## Non-goals（本切片未完成）

- 敏感读路径认证
- expired control credential（过期控制凭据语义）
- `startServer` strict auth wiring / Web 端凭据 UX
- Run Token expiry / scope / audience
- 完整 PolicyEngine / RBAC、Sandbox、Jev
