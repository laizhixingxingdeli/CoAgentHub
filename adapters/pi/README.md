# adapters/pi：L2 / L1 的 pi 适配层

把 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)（一个 coding agent 的 SDK）变成受控的协调者和执行者。平台不 import 任何 agent SDK，它拉起这里的 `src/agent-entry.ts`，通过 stdin / stdout 协议和它说话（协议见 [docs/adapter-protocol.md](../../docs/adapter-protocol.md)）；**适配层不含任何平台领域逻辑**，规则都在平台一侧。

怎么给 L2 / L1 接模型：[docs/models.md](../../docs/models.md)。

## 常用命令

在仓库根先 `node scripts/coagent.mjs setup`（依赖经 npm workspaces 装在根 `node_modules`），然后在本目录：

```bash
npx tsx src/cli.ts models     # 把 pi 此刻能用的模型清单打成 JSON（平台的资源池页就是读它；没登录任何 provider 时是 []）
npx tsx src/cli.ts usage      # 各 provider 的额度用量行（xAI、本机 10Router；没有就是 no_auth / error，无害）
npm test                      # 适配层测试（*.spec.ts）
```

登录 provider、登记兼容端点用 pi 自己的界面：在仓库根 `npx pi`，输入 `/login`。

## 文件

| 文件 | 负责什么 |
|---|---|
| `src/agent-entry.ts` | 子进程入口：stdin 收 spec，stdout 最后一行吐结果。49 行，最小的协议实现 |
| `src/runtime.ts` | 把一次 pi 会话接到协议上：建会话、挂工具、收集用量、判断这一跳怎么结束 |
| `src/tools.ts` | `coagent_*` 工具面：每个工具 = 面向模型的 schema 与说明 + 一次平台 HTTP 调用，规则不在这里重复 |
| `src/roles.ts` | 协调者 / 执行者 / 独立检视者的 system prompt 与工具表（中文）。想改角色的行为，改这里 |
| `src/extension.ts` | 逐轮注入角色提示与开跑简报（压缩后仍生效）、工具调用的策略闸（例如拦下执行者的 `git commit`） |
| `src/profiles.ts` | `profileId → provider/model/reasoning`。**平台传下来的 `facts` 优先**，这张静态表只是没带 facts 时的回退 |
| `src/failure-classify.ts` | 上游失败分类（模型不存在 / 限流 / 凭据 / 网络 / 内容被拦），平台据此决定换候选还是等 |
| `src/usage.ts` | 用量查询：xAI 与本机 10Router 的额度行。与你无关的 provider 会超时返回，无害 |
| `src/http.ts` | 让 Node 的 `fetch` 读 `HTTP_PROXY` / `HTTPS_PROXY`（pi 的 SDK 内嵌时需要自己装） |
| `src/cli.ts` | 诊断 CLI：`models`、`usage`、`audit` 等 |
| `docs/` | 适配层各部分的规格（工具安全、用量、失败分类、提供方扩展……） |

## 想接别的 agent 运行时

写一个同样协议的入口，用 `--adapter` 指过去，不需要改平台。见 [docs/adapter-protocol.md](../../docs/adapter-protocol.md)。
