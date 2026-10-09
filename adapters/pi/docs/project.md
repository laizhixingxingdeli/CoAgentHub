# coagent-pi

## Purpose

CoAgentHub 平台的 pi 适配器。平台按角色起 pi 会话（协调者、执行者、分类用的只读查询、独立检视），适配器负责把角色说明、开跑简报和平台工具交给模型，再把结果按平台的进程协议交回。平台仓库在 `<本机>/coagenthub-v5`；三层分工见那边的 ADR-0007。

## 结构

- `src/agent-entry.ts`：平台起子进程的入口。读 stdin 的运行规格，跑 pi 会话，stdout 写事件行与最后的结果行。
- `src/runtime.ts`：会话运行与结果汇总。
- `src/roles.ts`：各角色的系统提示词与工具白名单。
- `src/tools.ts`：`coagent_*` 平台工具的名字、说明与参数（调平台 `/api/agent/<工具>`）。
- `src/extension.ts`：每轮注入角色提示词与开跑简报；拦截越界写入与危险 git 命令。
- `src/platform-client.ts`、`src/http.ts`：带 run token 调平台 HTTP。
- `src/failure-classify.ts`：上游失败分类（额度、鉴权、限流、网络等）。
- `src/cli.ts`：命令行（模型清单等）。
- `src/profiles.ts`、`src/profile-audit.ts`：模型配置与核对。
- `src/reviewer-*.ts`：pi 检视者（暂缓启用）。

## 与平台的边界

- 规则写在平台里。适配器只把平台给的东西交给模型、把模型的调用原样交回平台，不在适配器里另立一套规则；能在平台工具层挡住的，就不靠提示词。
- 平台 HTTP 接口、进程协议（stdin 运行规格、`__COAGENT_EVENT__` 事件行、`__COAGENT_OUTCOME__` 结果行）要改时，两边一起改，一边先改会让另一边静默失效。

## 执行者红线

写代码时必须遵守。

### 写法

- ESM + TypeScript，经 tsx 运行；本仓内的相对 import 写 `.js` 后缀。
- 缩进用 tab，与现有文件一致。
- 注释写为什么，不写代码在做什么。

### 依赖

- 不新增依赖，不改 `package.json` 与锁文件。依赖变更由用户决定。

### 测试

- 全量：`node --import tsx --test src/*.spec.ts`；定向：`node --import tsx --test src/<名字>.spec.ts`。不用 npm / npx 跑测试。
- 新增的测试不调真实模型、不读真实凭据；需要平台时用测试里自建的假服务。
- 「已修复 / 已完成」必须有可验证证据；没跑过的命令不要写成跑过。

### 仓库

- 提交进仓库的内容（blob）一律是 LF，同一个文件里不要混用 LF 和 CRLF。
- 不碰 `.idea/`；不读凭据文件（例如 `~/.pi/agent/auth.json`），不在输出、日志、提交里打印 key。
- 只按显式路径 `git add` / commit。
