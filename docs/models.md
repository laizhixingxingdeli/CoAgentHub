# 给协调者（L2）和执行者（L1）接模型

平台**不认识模型**。它只认“候选”：一个 `profileId` 加一包不透明的 `facts`。模型长什么样、凭据放哪、哪些模型此刻可用，都是**适配层**（`adapters/pi`，基于 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)）的事。所以接一个新模型只有两步，而且都不用改平台代码：

1. **让 pi 认识它**：登录一个 provider，或者在 pi 的 `models.json` 里登记一个兼容端点。
2. **在资源池里加一个候选**：网页上点选，或者调 HTTP 接口。

## 0. 先装好适配层

```bash
node scripts/coagent.mjs setup     # 在仓库根 npm ci（workspaces 一次装好适配层和 MCP 服务器的依赖），只需一次
```

适配层是平台拉起的子进程（`npx tsx adapters/pi/src/agent-entry.ts`），平台通过 stdin / stdout 和它说话，所以平台本体不依赖任何 agent SDK。

## 1. 让 pi 认识模型

pi 的配置和凭据放在 `~/.pi/agent/`（用 `PI_CODING_AGENT_DIR` 可以换目录）：`auth.json` 存登录凭据，`models.json` 登记自定义端点。**这两个文件含密钥，不要提交。**

### 1a. 用 provider 账号登录（推荐）

```bash
npx pi                # 在仓库根运行：进入 pi，输入 /login，选 provider，按提示登录或粘贴 API key
```

pi 内置了大量 provider：Anthropic、OpenAI、Google Gemini、xAI、DeepSeek、OpenRouter、Mistral、Groq、Moonshot、Qwen、MiniMax、智谱（ZAI）、小米 MiMo……完整列表和每家的认证方式见 pi 自带的文档 `node_modules/@earendil-works/pi-coding-agent/docs/providers.md`（`setup` 之后在仓库根的 `node_modules` 里）。

### 1b. 用环境变量里的 API key

平台拉起适配层时**默认不透传你的环境变量**（见 [docs/security.md](security.md)）。如果你的 key 放在环境变量里，要在启动时把变量名明确交出去：

```bash
# OpenAI 与 DeepSeek 的 key 在环境变量里：
export OPENAI_API_KEY=...
export DEEPSEEK_API_KEY=...
node scripts/coagent.mjs start --passthrough OPENAI_API_KEY,DEEPSEEK_API_KEY
```

名字只写变量名，不写值；名单是你声明的，平台不会替你加。用 `/login` 存进 `auth.json` 的凭据不受这条限制（适配层通过你的 home 目录读到它）。

### 1c. 登记一个兼容端点（Ollama、LM Studio、vLLM、llama.cpp、各类网关）

端点只要说 OpenAI / Anthropic / Google 兼容协议，就在 `~/.pi/agent/models.json` 里登记。示例见 [examples/pi-models.example.json](../examples/pi-models.example.json)：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen2.5-coder:7b" }]
    }
  }
}
```

要点：

- `apiKey` 可以写字面值、`$ENV_NAME` / `${ENV_NAME}` 环境变量插值，或者以 `!` 开头的命令（每次请求时执行，输出当 key 用）。
- **新模型必须先登记进 pi，候选才能跑**：否则候选一被选中就失败，报“模型不可用”。
- 本地 GGUF 模型可以直接接 pi 的 llama.cpp 路由，见 pi 文档 `llama-cpp.md`。
- 网关聚合器（一个 provider 下面带很多上游，模型名形如 `上游/模型`）也是这样登记，候选的 `model` 写完整的 `上游/模型`。

### 1d. 核对一下 pi 真的能用它

```bash
node scripts/coagent.mjs doctor      # 会列出适配层能看到多少个模型
```

或者直接问适配层要清单（登录过的 provider 才会出现）：

```bash
cd adapters/pi && npx tsx src/cli.ts models
```

## 2. 在资源池里加候选

先 `node scripts/coagent.mjs start`，再打开 <http://127.0.0.1:3101/#/pool>。

页面分协调者（L2）和执行者（L1）两张表。底下的添加表单里，**模型从下拉清单里选**（清单来自适配层，所以只会出现 pi 此刻能用的模型），选完点添加。选清单而不是手输，是因为模型名打错一个字母就是一个跑不起来的候选，而且要到派发那一刻才暴露。

然后到 <http://127.0.0.1:3101/#/agents> 的“角色与模型”页调整：**上移 / 下移排序、停用、移除**，点保存。顺序就是优先级：平台每次派发都读当前启用的列表，**从上到下取第一个健康的**；某个候选连续失败会被熔断一段时间，自动换下一个。在途的那一跳不受影响，下一跳才用新配置。

### 用接口加（脚本化、批量）

```bash
# 追加一个候选（provider / model 换成 pi 里你实际登记或登录的那个）
curl -sS -X POST http://127.0.0.1:3101/api/pools \
  -H 'Content-Type: application/json' \
  -d '{"role":"executor","profileId":"exec-mymodel","endpoint":"local",
       "facts":[{"key":"provider","value":"<provider>"},
                {"key":"model","value":"<model-id>"},
                {"key":"reasoning","value":"medium"}]}'

# 整个角色按顺序整体替换：先读 revision，再提交完整列表
curl -sS http://127.0.0.1:3101/api/pools/config
curl -sS -X POST http://127.0.0.1:3101/api/pools/executor/configure \
  -H 'Content-Type: application/json' \
  -d @examples/pools.example.json
```

`pools.example.json` 的形状见 [examples/pools.example.json](../examples/pools.example.json)。`expectedRevision` 必须是刚读到的 revision，旧页面提交返回 409，不会覆盖别人的改动；错误输入不会部分落库。接口细节见 [http-api.md](http-api.md#候选池)。

## 候选的字段

| 字段 | 含义 |
|---|---|
| `profileId` | 你起的名字，全池唯一。平台只拿它当选择键。 |
| `endpoint` | 缺省写 `local`。 |
| `facts.provider` | pi 里的 provider 名（`deepseek`、`openai`、`ollama`、你在 `models.json` 里起的名字……）。 |
| `facts.model` | 该 provider 下的模型 id。 |
| `facts.reasoning` | 思考档位：`off` / `low` / `medium` / `high`。pi 会按模型实际支持的档位收敛。 |
| `enabled` | `false` 就停用，保留配置。 |

`facts` 里的键值平台原样传给适配层，**平台自己不解释**。换一个运行时（见 [adapter-protocol.md](adapter-protocol.md)），facts 里放什么由那个运行时定。

## 怎么选模型

平台的设计假设是：**协调者读代码、写工单、逐项验收，要用最强的模型；执行者只照冻结工单干活，用便宜快速的模型就够**，因为上两层已经把工单写到“照着做就能完成”。所以：

- **协调者（L2）**放你手上最强、最稳的 1–2 个，思考档位给 `medium` 或 `high`。后面再排几个备胎。**备胎要真的试过**：没跑过的备胎在主力不可用时才第一次上场，出问题就是在最坏的时候。
- **执行者（L1）**放便宜、快的模型，`medium` 左右。相近水平的模型之间，速度比再高一点的智能更值钱；排序时同时看**交卷成功率**和**平均耗时**，别只看榜单。
- 平台记的“花费”是 pi 按自带价目表折算的**标价**，不是账单。pi 没有价目的 provider（自建端点、部分聚合网关）会记成接近 0。订阅、免费额度这类候选真正的约束是它们的额度：有额度信息的 provider，资源池页会显示套餐、剩余百分比和重置时间。
- 单个 Mission 累计的标价花费到 $10 会停下来等检视者决定（可以加额度继续），对没有价目的候选这道闸基本不起作用。

## 常见问题

- **下拉清单是空的 / 提示“运行时不可用”**：适配层没装好，或 pi 里没有任何已登录的 provider。跑 `node scripts/coagent.mjs doctor` 看是哪一项。
- **候选建了但派发立刻失败，几秒就死**：多半是 provider 或模型名没在 pi 里登记（或上游改了名）。先单独在 `npx pi` 里确认 `/model` 里能选到它。
- **key 在环境变量里却报没有凭据**：忘了 `--passthrough`，见上面 1b。
- **整个 provider 被熔断**：连续失败或额度用完会触发，资源池页会显示原因和复位办法；确认已经修好（充了值、改对了名）再复位，别在没修之前复位。
