# 质量同步到 Langfuse（本机回环）

这份文档讲三件事：怎么**启用**、怎么**关闭**、以及同步器到底发了什么、不做什么。

先看清楚适用范围：本仓库里的测试用的是**本地 mock**（临时平台 + 临时 Langfuse），
证明的是「投影、去重、进度、有界退出」这几件机器可验证的事。**真实 Langfuse v4 与
真实模型调用的端到端效果，必须由 L3 配好凭据后另行执行；在拿到真实回执之前，
任何人不得声称「已验证真实端到端」。**

## 1. 默认关闭，且关闭是彻底的

没有配置文件、配置坏了、或者 `enabled` 不是 `true`，同步器都当作**完全关闭**：

- 不请求平台（一个 GET 都不发）
- 不请求 Langfuse
- 不写进度文件

这时 `node scripts/langfuse-sync.mjs ...` 退出码是 `0`，stdout 只有一行：

```
langfuse disabled
```

要关掉一个已经启用的部署，把配置文件里的 `enabled` 改成 `false`（或删掉配置文件），
不用卸载任何东西、不用改系统代理、也不用停平台。

## 2. 启用：用户本地配置文件

配置放**用户自己机器上的** `~/.coagent/langfuse.json`，**不进仓库、不进工单、不进简报**。
仓库里也不要放示例明文密钥——下面示例里的密钥一律写 `REPLACE_ME`。

```json
{
  "enabled": true,
  "baseUrl": "http://127.0.0.1:3300",
  "publicKey": "REPLACE_ME",
  "secretKey": "REPLACE_ME",
  "captureContent": false
}
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `enabled` | 只有显式 `true` 才启用；缺省、`false`、字符串 `"true"` 都等于关闭。 |
| `baseUrl` | **仅限**本机回环（`127.0.0.1` / `localhost` / `[::1]`），且 `http(s)`、不带用户名密码、不带查询串。建议 `http://127.0.0.1:3300`（Langfuse 默认端口）。写远程地址会被判为非法配置，于是整体关闭。 |
| `publicKey` / `secretKey` | Langfuse 项目密钥。两者任一为空即整体关闭。**不会**出现在任何日志、错误或 stdout 里。 |
| `captureContent` | 默认 `false`：只发结构（有没有、是否被截断），不发正文。开成 `true` 才会带出评审理由/证据正文，且先脱敏再按 `maxContentChars` 截断。 |

可选字段（都有安全缺省）：`maxContentChars`（默认 2000）、`requestTimeoutMs`（默认 5000）、
`flushTimeoutMs`（默认 5000）、`maxQueueSize`（默认 100）。

## 3. 单次运行

```bash
node scripts/langfuse-sync.mjs --mission <missionId> --once --platform-url http://127.0.0.1:3101
```

- `--mission <id>` 与 `--project <id>` **必须且只能给一个**。
  - `--mission`：只读这一个 Mission，连 `/api/missions` 列表都不调。
  - `--project`：先读 `/api/missions` 列表，只保留 `projectId` 相等的 Mission。超过 50 条时
    这一轮不同步任何 Mission，stdout 输出 `project scope truncated`，退出码 `1`。
- `--platform-url` 默认 `http://127.0.0.1:3101`；同样只接受本机回环。
- `--config <file>` 默认 `~/.coagent/langfuse.json`。
- `--progress <file>` 默认 `~/.coagent/langfuse-progress/<scope>.json`（**不在仓库里**）。
- `--control-token-file <file>`：可选。读文件全文当控制面凭据，只放进 `Authorization: Bearer`
  请求头；文件读不到或为空就退 `2`，且不会回显路径内容或文件内容。
  **不读 `process.env` 里的任何密钥**，也不扩大 agent 子进程的环境透传名单。

退出码：

| 退出码 | 条件 |
| --- | --- |
| `2` | 参数错误（scope 不是恰好一个、运行模式不合法、地址不是回环、凭据文件不可读等） |
| `0` | 关闭状态，或这一轮全部记录都已确认 |
| `1` | 有平台读取失败，或存在未确认记录（`unconfirmed > 0`），或项目范围被截断 |

stdout 一行形如：

```
mission M-q-synthetic ok=true sent=42 skipped=0 unconfirmed=0 missing=1
```

`missing` 是「按 id 取不到的那几跳」（404 等）：它不影响退出码，但留在计数里，
便于事后判断「这条记录为什么只出了 missing 观察」。

stdout 只写计数与 missionId（项目范围被截断时只有一句固定提示）。**不输出**评审理由、
证据正文、`outputTail`、Langfuse 密钥或 Authorization。

## 4. 持续模式（有界）

持续模式必须同时给出 `--interval-ms` 与 `--iterations`，不接受「一直跑」：

```bash
node scripts/langfuse-sync.mjs --project <projectId> \
  --interval-ms 30000 --iterations 10 --platform-url http://127.0.0.1:3101
```

- CLI 拒绝 `--interval-ms < 1000`，`--iterations` 必须在 `1..50`。
- 收到 `SIGINT` / `SIGTERM` 时不再开始下一轮，对当前传输做一次**有界 flush**，然后退出；
  只把已经确认的 id 写进进度。信号处理不会挂住进程。
- 库函数 `runBounded()` 允许测试用更小的正间隔，但 `iterations` 同样必须有限。

## 5. 只读：它到底请求了什么

只发 `GET`，且路径只允许这五个：

```
/api/missions
/api/missions/<id>
/api/missions/<id>/activity
/api/missions/<id>/attempts/<attemptId>
/api/missions/<id>/validation-reports/<reportId>
```

其它路径、`POST`、以及任何带 `.coagent-state.json` 或 `delivery` 的路径都在**发请求之前**
直接拒绝。具体来说：

- **不读** `.coagent-state.json`，也不读它的锁目录（平台服务一直在写那个文件）。
- **不消费** Delivery，不请求 `/live`、`/diff`。
- 不把 `output` / `toolActivity` 写进进度或日志。
- 404 或读取失败的那一跳，把该 id 当作**缺失**（不放进 `reports`/`attempts`），
  **不拿别的 Attempt 顶上**。

## 6. 只连回环、不碰系统代理

平台读取用 `node:http`/`node:https` 直连回环地址，**不用 `fetch`**。原因是 `fetch` 会吃
`HTTP_PROXY` / `HTTPS_PROXY`，本地回环被代理转走时，错误会伪装成「网络故障」，
事后极难判断到底是平台没起还是代理挡了。传输层写 Langfuse 同样是 `node:http` 直连。

两处都**不修改系统代理设置**，也不要求用户改环境变量。

## 7. 进度：已捕获 ≠ 已确认

进度文件形状：

```json
{ "version": 1, "acked": ["<已确认 id>"], "capturedReviews": [] }
```

两者的区别是这份设计的关键：

- `capturedReviews`：同步器**已经捕获到的完整评审记录**。在发送之前就原子写入磁盘，
  所以 Langfuse 短时间不可用、甚至进程被杀，这些原始事实也不会丢，下一轮可以继续投影。
- `acked`：**传输层真的确认过**的 span/score id。只有 `enqueueSpan`/`enqueueScore`
  返回 `true` 才写进来；返回 `false`、抛错、队列满，都不写。`flush()` 返回 `false`
  也不会把未解析为 `true` 的 id 标成已同步。

于是：

- **断网 / Langfuse 挂掉**：这一轮的记录都是 `unconfirmed`，`acked` 不变，退出码 `1`。
  重跑会重新发送（稳定 ID 去重，不会在 Langfuse 里造出重复记录）。
- **重跑同一份输入**：第二次 `sent` 为 0，不重复 POST。
- **进度文件坏 JSON / 形状不对**：当作空进度处理且**不覆盖**它，返回失败（退出码 `1`）。
  这是在保护「用户可能只是手改坏了一行」的场景。

原子写：同目录临时文件写完再 `rename`。Windows 上目标已存在导致 `rename` 失败时，
先删目标再 `rename` 一次。

## 8. 关联规则（不猜）

- L2 逐条结果只与 HTTP 实际给出的 `submittedAttemptId`（受评 Attempt）关联；
  评审者自己的 Attempt **绝不**当受评者用——两个 trace 在 Langfuse 里看起来一样正常，
  挂错了看不出来。
- `review.recorded` 是历史事件，没有受评者字段也没有逐条原文：只落 Mission trace 上的
  观察记录，**不产生** `coagent.l2.verdict` 之类的 L2 分数，也不拿当前 `lastReview`
  去补它的身份。
- 受评 Attempt 或逐条结果缺失时，明确标 `unknown` / `missing`，不生成相应评分，
  也不声称覆盖了完整历史。
- L3 终审属于 Mission 层，只落 Mission trace，不会被摊到每个 Attempt 上。
- 测试跳过 / 未知不算成功；机器通过不算 L2/L3 接受；基础设施故障不算模型能力差。

## 9. 复跑验证

在本仓库里，这一层可复跑的验证是（不需要任何真实 Langfuse、不需要凭据）：

```bash
node --test test/langfuse-sync.test.ts
node --test test/langfuse-quality-records.test.ts test/langfuse-transport.test.ts
```

再往上的全量 `node --test` 与适配层定向测试由平台 VR 跑。

再次强调：**上面这些测试的 Langfuse 是进程内的临时 mock。** 真实 Langfuse v4 与真实模型
调用需要 L3 配置凭据后单独执行；在拿到真实回执之前，「已验证真实端到端」这个说法不成立。
