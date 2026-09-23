# 凭据脱敏（credential-redaction）

agent 产出、要落盘或给人看的文本，进门先过一遍脱敏（优化方案 §7 P0.3 末条、Phase 1 第 4 条）。起因：agent 一句 `env` 或 `cat .env`，本机的 key 就进了证据、失败原文、实时输出，落盘后在 l3 / Web 上谁都看得见。

## 命中什么

`src/application/redact.ts`：

- **已知值**：平台进程环境里名字像凭据（`KEY` / `TOKEN` / `SECRET` / `PASSWORD` / `PASSWD` / `CREDENTIAL` / `AUTH` / `COOKIE` / `SESSION`）、值去空白后 ≥ 8 字符的变量，按值精确替换成 `[REDACTED:变量名]`。长的先换（一个值是另一个值的前缀时不留半截）。第一次用到时读 `process.env`，之后不变——平台启动后新设的变量本来也到不了它派生的 agent。
- **形状**：私钥块 → `[REDACTED:PRIVATE KEY]`；`Bearer <x>` → `Bearer [REDACTED]`；JWT → `[REDACTED:JWT]`；常见前缀 key（`sk-`、`xai-`、`gh?_`、`github_pat_`、`AKIA`、`AIza`、`xox?-`）→ `[REDACTED]`；`*key / secret / token / password* = 值`（含 JSON / YAML 写法）保留名字、只抹值。
- **只换命中的那一段**，保留上下文：这里是给人看的证据，整段丢掉就看不懂了（与 decision-remote-input「往外发、整条丢弃」的取舍不同）。

## 不碰

纯数字值（`tokenCount=12345678`、`total=67360`）、40 位提交号、裸 UUID、路径。赋值形状要求值里至少有一个字母；已经是 `[REDACTED…]` 的不再动（否则 `[REDACTED:变量名]` 会被抹成光秃秃的 `[REDACTED]`）。宁可漏掉一个没前缀的随机串，也不把计数与提交号抹成一片——那样证据就废了。

## 落点

| 入口 | 处理 |
| --- | --- |
| `/api/agent/*`（证据、执行结果、评审、升级、交卷、工单…） | 请求体整体深度脱敏，一个口子覆盖 agent 交进来的一切 |
| `Platform.finishAttempt` | `failureMessage`、`output`（这一跳的输出尾部） |
| `ValidationEngine` command check | `outputTail`：**先脱敏再截尾**（截断点切在 key 中间时，半截对不上任何形状） |
| 机器 L3 集成验证 | 同上，先脱敏再截尾 |
| `QueryRunner` | 回答原文 `output`、`failureMessage` |
| 实时输出（Orchestrator → LiveOutput） | 文本块与工具行的命令详情；**流式逐段，尽力而为**：一个 key 被切在两段之间时抓不到。大段带出凭据的是工具输出，那条路经 API 以证据进来，在入口整段处理 |

不做：历史状态文件的回溯清洗；agent 自己的会话日志（在运行时一侧，不经平台）。

## 权威源 / 测试

- 源：`redact.ts`、`api/server.ts`、`platform.ts`（finishAttempt、机器 L3 验证）、`validation/engine.ts`、`query-run.ts`、`orchestrator.ts`
- 测试：`redact.test.ts`（命中与不误伤两头）、`redaction-api.test.ts`（真实 HTTP 落点、截尾顺序）
