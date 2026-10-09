# 接入别的 agent 运行时（适配层协议）

默认情况下，协调者和执行者由 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 驱动，pi 本身已经能接几十家模型（见 [models.md](models.md)），多数人不需要读这一页。只有当你想让 L2 / L1 跑在**别的 agent 运行时**上（比如另一个 coding agent 的 SDK、自己写的循环），才需要它。

## 设计：进程边界就是依赖边界

平台**不 import 任何 agent SDK**。它拉起一个子进程，用最笨的协议和它说话：

```
平台 ──拉起子进程──▶ 适配层（任意语言写的可执行入口）
      stdin  ◀── 一份 JSON spec（这一跳的角色、工作目录、候选、首轮指令、可用工具、平台地址与令牌）
      stdout ──▶ 流式输出行 + 结构化事件行 + 最后一行结构化结果
      HTTP   ◀── 适配层里的 agent 调平台的工具端点，干活、交证据、提交结果
```

这样做保住两件事：agent 死循环或 OOM 不会带走平台；平台永远能杀掉它（连同整棵子进程树）。

`src/runtime/scripted.ts` 是同一个端口 `AgentRuntime` 的**第二个实现**，用预设脚本按真实 HTTP 面调工具，测试都跑在它上面。第二个实现一直存在，“可以接别的 agent”才是可证伪的。

## 平台怎么拉起适配层

目前接线固定是 `npx tsx <入口文件>`，工作目录是入口文件往上两层的目录（`adapters/pi/src/agent-entry.ts` → `adapters/pi/`）。入口用 `--adapter <文件>` 指定（`scripts/coagent.mjs run`、`src/run-mission.ts`，或 MCP 的 `coagenthub_start_mission`）。所以接另一个运行时最省事的办法：写一个同样协议的 TS / JS 入口文件，里面想起什么进程都行，再用 `--adapter` 指过去。

子进程的环境**不是**你的整个环境：只有 OS 与代理基线变量，加上你用 `COAGENT_AGENT_ENV_PASSTHROUGH` 明确列出的名字（见 [security.md](security.md)）。

## stdin：spec

一份 JSON（`AgentRunSpec`，见 `src/application/ports.ts`）：

| 字段 | 含义 |
|---|---|
| `role` | `coordinator` / `executor` / `independent_reviewer` / `query` |
| `attemptId`、`missionId`、`workItemId?` | 这一跳的身份 |
| `cwd` | 工作目录（Mission 的 worktree；`query` 是只读上下文） |
| `profile` | `{ endpoint, profileId, reasoning?, facts? }`：这条候选。`facts` 是平台原样转交的不透明键值，约定俗成 `provider` / `model` / `reasoning`，**含义由适配层定** |
| `instruction` | 已渲染好的首轮输入 |
| `tools` | 允许调用的工具名（`query` 路径必须是只读白名单，平台在拉起之前强制） |
| `resumeRef?` | 续跑句柄，平台不解释 |
| `endpoint` | `{ baseUrl, token }`：平台的工具端点地址和这一跳的运行令牌 |

## 调平台：工具端点

适配层里的 agent 通过 HTTP 调平台，**身份只来自令牌**，不来自请求体：

- `GET  {baseUrl}/api/run/brief`：开跑简报（契约或工单、项目红线、环境注记、打回理由）。应在模型第一次开口之前取一次、塞进 system prompt，不要做成让模型自己决定要不要看的工具。
- `POST {baseUrl}/api/agent/<工具名>`：工具调用，请求头 `x-coagent-run: <token>`。协调者、执行者、独立检视者的工具表不同，权限由平台按令牌的角色判定；越权返回 403，不要在适配层里重复判断。工具的入参出参见 [http-api.md](http-api.md#agent-工具接口)。

适配层不做任何领域判断，只负责：把模型的工具调用转成上面的 HTTP 调用，把平台的回答（失败时是“下一步该怎么做”）原样回给模型。

## stdout：三种行

```
普通文本行                                  → 当作进度输出，流到网页（每来一行都会重置静默超时）
__COAGENT_EVENT__ {"t":"tool.started","name":"bash","callId":"c1"}
__COAGENT_EVENT__ {"t":"tool.completed","name":"bash","callId":"c1"}
__COAGENT_EVENT__ {"t":"usage","usage":{"input":…,"output":…,"cacheRead":…,"cacheWrite":…,"total":…,"cost":…,"quality":"reported"}}
__COAGENT_EVENT__ {"t":"runtime.capabilities","commandActivityClassification":"v1"}
__COAGENT_OUTCOME__ {…最后一行…}
```

事件行是结构化观测数据（时间线上的工具芯片、用量），解析失败就当没看见，不影响这一跳。`tool.started` 可带 `detail` 和 `activityClass`（`command` / `other`，**只认适配层的明确声明**，平台不按工具名猜）。

### 最后一行：结果

`__COAGENT_OUTCOME__ ` 之后跟一份 JSON，**这是这一跳怎么结束的唯一依据**，进程退出码不算：

| 字段 | 含义 |
|---|---|
| `endedBy` | `structured_submit`（调了最终提交工具）/ `no_structured_result`（跑完了但没提交）/ `upstream_failure`（模型或服务商失败）/ `platform_unreachable`（连不上平台）/ `cancelled` / `interrupted`。`killed_idle` 与 `killed_wall_clock` 是平台自己掐的，适配层不用报 |
| `usage` | `{ input, output, cacheRead, cacheWrite, total, cost?, quality }`，缺了就报 `quality:"unknown"`，不要补 0 |
| `failureMessage?` | `upstream_failure` 时的原文。平台按原文里的关键特征（限流、额度、账单、网络……）判断这个候选要不要冷却、冷却多久，所以请**原样**带出服务商的报错，不要改写成笼统的“失败了” |
| `resolvedProfile?` | `{ revision, resolved: [{key,value}] }`：这一跳**实际**用的身份。冻在 Attempt 上，事后归因靠它，不靠回查会变的表 |
| `resumeRef?`、`output?`、`toolNames?` | 续跑句柄、输出尾部、调过的工具名序列 |
| `contextMetrics?` | 可选的上下文采集摘要。不可信：平台再校验，不合格整段丢弃 |
| `queryOutcome?` | 仅 `query` 角色：`answered` / `failed` / `needs_mutation` |

**区分 `upstream_failure` 和 `no_structured_result` 很重要**：前者允许平台换候选重试，后者说明模型跑完了却没交活，换一个也未必有用，平台会按另外的规则处理。失败时也要吐出结构化结果，拿不到 outcome 平台只能一律当作后者。

## 静默超时

平台判“卡住”的标准是**多久没有任何输出**（缺省 5 分钟），不是总时长：长任务连续产出 45 分钟是正常的。所以长时间没有输出的步骤要定期打一行进度，否则会被连同子孙进程一起杀掉。

## 可选：模型清单与用量

资源池网页和 `GET /api/runtime/models`、`/api/runtime/usage` 会在适配层目录里执行 `npx tsx src/cli.ts models` 和 `… usage`，把它吐的 JSON 数组原样转出去，平台不解释字段（用量行形状见 `src/application/runtime-catalog.ts`）。适配层没实现这两条也没关系，网页会说明“运行时不可用”，候选仍可通过接口手工添加。

## 参考实现

`adapters/pi/src/agent-entry.ts`（49 行）是最小的入口；`adapters/pi/src/runtime.ts` 是把 pi 会话接到这套协议上的完整实现；`adapters/pi/docs/` 里有它各部分的规格（工具安全、用量、失败分类……）。
