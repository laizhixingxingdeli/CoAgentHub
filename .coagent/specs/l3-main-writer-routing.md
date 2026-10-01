# L3 主状态写者路由与回环控制

文件存储下，`node src/l3.ts` 保留既有命令前缀和参数。`merge`、`send-back`、`abandon`、`answer`、`revise`、`cancel`、`pause`、`resume`、`retire`、`rerun`、`ack` 在装配可写平台前探测同一 statePath 的本机写者：已验证的 live 持锁服务走其 `127.0.0.1` 回环 HTTP，在服务已有 Platform 上执行；确认 empty 才沿用独占锁本地平台路径。竞争中锁变忙则重新验证持有者，不能不拿锁建立第二个可写平台。occupied（包括残锁、不匹配实例、错误版本、不同状态、活 PID 却非匹配服务、端口不可达）直接拒绝；网络探测失败不等于 empty。PG 保留原有入口语义。

回环客户端只向锁探测验证过的 holder.port 发送请求；每次响应核对 API 版本、instanceId、stateId（Windows 同状态身份大小写不敏感，其他系统精确比对）。失败、断线、超时或身份漂移不离线回退；可能已经执行的 merge 不自动重试。CLI 成对检查 `--as` / `--confirmed-by`，reviewer 终审请求走 `/api/missions/{id}/finalize/reviewer`；普通 `/finalize` 仍是 human，HA reviewer merge 在服务端交给 Platform 的 HA 权威方法，不伪装普通终审。

HTTP 控制面补充 reviewer finalize、work-item retire、mission rerun；其它现有 answer/contract/control/ack 接口仍由 Platform 规则约束，不直改文件。POST 在 mutation 持久化成功后才发送成功响应；持久化失败不能向调用方报告 2xx。错误响应含 API 版本与目标实例/state 身份，供 CLI fail-closed。当前文件服务仅监听回环，控制写仍未鉴权、保留可替换 resolver；不引入 Web 写按钮。

方案运行中的 Mission 升级只通过 `node src/l3.ts plan decide <E-n> --action answer --answer "…" --as <检视者> [--run <记录>]` 答复；普通 `l3 answer` 只用于方案运行之外，不取代方案独立决定。PlanRun 的 decide、approve、send-back 继续仅写独立记录/决定短锁，不被主状态锁阻塞；inbox/show/plan/runs 等只读路径不做启动收敛。答复后的续跑仍由方案驱动按既有 AQ1 规则处理，HTTP 入口不复制该规则。详见 `plan-run` capability。

`node src/l3.ts candidate reset <profileId> --reason "…"` 是主状态写命令：无服务时在独占写者平台将存在且 open 的候选复位为 closed，事件记录 actor=`operator`、ISO 时间和非空原因；有已验证 live 持锁服务则经 `/api/pools/:profileId/circuit/reset` 在服务内复位并记录受控主体、时间、原因，不另建写者也不在回环失败时本地回退。缺理由、候选不存在或已 closed 明确失败，不写新审计；审计可经候选 reset-events 接口查询。

源：`src/l3.ts`、`src/application/loopback-control-client.ts`、`src/application/lock.ts`、`src/api/server.ts`、`src/main.ts`。验证：`test/l3-plan.test.ts`、`test/run-mission-wiring.test.ts`、`test/l3-reviewer-signature.test.ts`、`test/lock.test.ts`、`test/api.test.ts`、`test/start-server.test.ts`。
