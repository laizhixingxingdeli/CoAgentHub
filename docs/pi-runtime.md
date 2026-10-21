# Pi 运行时版本与隔离安装

共同目标版本是 `@earendil-works/pi-coding-agent@1.3.0`，精确版本，不是 `latest`，也不是 `^1.3.0`。声明在 `adapters/pi/package.json`，锁在仓库根 `package-lock.json`。

平台 SDK 会话和独立 Pi MCP 是两条执行链。它们只共享下面这份无密钥声明和仓库里的 1.3.0 安装定位，不共享会话、成功判定或平台协议。

## 无密钥声明

模板：`adapters/pi/pi-runtime.template.json`。形状：`adapters/pi/pi-runtime.schema.json`。

真实文件不进 git。默认路径是 `~/.coagent/pi-runtime.json`。隔离或部署覆盖用环境变量 `COAGENT_PI_RUNTIME_CONFIG`（绝对路径）。不要把本机路径写进仓库。

只允许这些公开字段：

- `version`：必须为 `1`
- `extensions.codebuddy.packageDir`：审核过的 CodeBuddy 包绝对路径。该包的 `pi.extensions` 会同时登记 `codebuddy` 与 `codebuddy-intl`
- `extensions.qoder.packageDir`：审核过的 Qoder 包绝对路径。同时登记 `qoder` 与 `qoder-cn`
- `extensions.antigravity.packageDir` + `providerId`：只有 L3 要接 Antigravity 时才填核心 provider。路径名含 `search` / `image` / `vision` / `imagen` 的入口不会加载，避免把搜索/图像附加工具带进来
- `worker.defaultModel` / `worker.fallbackModel`：只给独立 MCP。省略时分别是 `codebuddy-intl/deepseek-v4.1-flash` 和 `codebuddy/deepseek-v4.1-flash`

不允许 `auth`、`models`、`settings`、密钥、账户池或任意插件列表。平台角色池和 native 候选优先级不读 `worker`。

加载规则：

- 默认路径不存在：原 native 模型仍可用，不假装审核 provider 已装上
- `COAGENT_PI_RUNTIME_CONFIG` 指向缺失文件、JSON 非法、字段不在白名单、`packageDir` 不是绝对路径或不存在、扩展入口跳出包目录、目标 provider 没有 `registerProvider`：失败，诊断里只有配置文件路径和字段名，不打印配置正文
- 这类错误不能被 models 吞成一份「成功」的原生目录

`src/runtime.ts` 的 `startRun` 按选中 provider 加载对应审核包。`tsx src/cli.ts models` 加载整份审核清单。两边都是 `pendingProviderRegistrations` → `runtime.registerProvider` → `refresh({ allowNetwork: false })`。托管 loader 仍是 `noExtensions` / `noSkills` / `noPromptTemplates` / `noContextFiles`，并禁用 builtin `mcp`、`tool-search`、`codemode`、`llama.cpp`。审核扩展不能扩大平台工具闭包：会话仍用角色 allowlist 加 `excludeTools`。

## 仓库 1.3.0 与薄 MCP 启动器

薄启动器：`node adapters/pi/bin/pi-worker-mcp.mjs --server <原 server.mjs>`

也可用 `PI_WORKER_MCP_SERVER`。不要把个人 server 路径写进仓库，也不要改外部 server。

启动器只做三件事：

1. 从自己的 `import.meta.url` 做 `realpath` 后向上查找 `node_modules/@earendil-works/pi-coding-agent@1.3.0`。找不到就失败，不回落 global npm，也不接受其它版本。最近一层已经有这份包、但版本不对或 `package.json` / CLI 入口损坏时立即失败，不再继续向上找祖先里的 1.3.0。某一层根本没有这份安装时才继续向上，因此 Mission 根未安装时仍可用祖先集成的 1.3.0。
2. 把 `PI_CLI_JS` 设为同目录的 `pi-cli-shim.mjs`（同样按 `import.meta.url`，所以 junction 别名启动时 server 拿到的也是别名路径）。
3. 把 `PI_WORKER_DEFAULT_MODEL` / `PI_WORKER_FALLBACK_MODEL` 设为声明里的 worker 模型；声明省略时用上面的 Flash 默认/备用。

原 server 仍是 `node PI_CLI_JS -p --no-session --model <model>`，readOnly 再加 `--tools read,grep,find,ls`。shim 不带 Node `--import`，再拉起仓库里的 1.3.0 `dist/bundle/cli.js`，并加上：

- `--no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files`
- `--exclude-tools`（`mcp__*`、MCP 资源工具、`codemode`、`tool_search`）
- `-e` 每个审核扩展入口

这样同一份 provider 声明会进入真正的 CLI 进程，而不只是平台 `registerProvider`。普通 `--tools` 不是闭包证据。所有 worker 运行都关这些额外入口；非 readOnly 不额外收窄工具，因此内置文件/bash 仍在。readOnly 的最终 active / callable / all 必须是 `read` / `grep` / `find` / `ls`。

shim 不改 server 的成功判定、跨 provider 回退、会话或 540s 取消。认证仍由 Pi 自己的 agent 目录读取；本声明不复制凭据。启动器不设置 `PI_CODING_AGENT_DIR`。

## 隔离安装与回退

只在要升级的 Mission 工作区根安装，不要动正在跑服务的主工作区 `node_modules`、用户全局 Pi，或祖先仓库的依赖树。

```text
npm install --workspace adapters/pi @earendil-works/pi-coding-agent@1.3.0 --save-exact
```

装完后必须能从该工作区自己的 `node_modules/@earendil-works/pi-coding-agent/package.json` 读到 `1.3.0`。能从祖先目录解析到旧版，不等于这里已经装上目标版。当前执行工作区可以复用祖先集成根已有的 1.3.0 做解析，但不得写入那份 `node_modules`。

回退：停止使用薄启动器，把 MCP 的 `PI_CLI_JS` 指回原来的 CLI；把 `~/.coagent/pi-runtime.json` 移走或改名，平台即回到 native-only 目录。不要在主工作区里删装依赖来“顺便回退”。依赖版本回退仍只在隔离工作区把 `adapters/pi/package.json` 改回精确旧版再 `npm install`。

## 已验证（本票，非真实账户）

- SDK `registerReviewedExtensions` 与 `tsx src/cli.ts models` 对同一隔离假 provider 配置给出同一目录；native `openai` 仍在 `getModels()`。
- 非法 JSON、无效 `packageDir`、扩展未登记目标 provider 时，models 以非 0 退出，诊断可定位且不含配置正文。
- 经 junction 别名启动薄启动器，stub 按原 server 的 `node PI_CLI_JS -p --no-session --tools read,grep,find,ls`（无 `--import`）拉起 shim，真实 1.3.0 CLI 进程加载同一声明。只读最终工具闭包由 CLI 内的 `getActiveTools` / `getAllTools` 观察，不是只比对 argv。
- 费用未知，不写 0。没有用真实账户发请求。

## 真实验证（待 L3，本票不算通过）

执行者没有改真实 `~/.coagent/pi-runtime.json`、资源池或全局 Pi，也没有登录、换账号或发付费请求。下面只能在平台 0 活 Agent 时由 L3 做：

1. 按模板写入 `~/.coagent/pi-runtime.json`，只填审核包的公开绝对路径和 worker 两行 Flash。不要复制 `auth.json`、`models.json`、`settings.json` 或账户池。
2. 确认启动器 stderr 出现 `pi-runtime shim cli=... version=1.3.0`，且 `cli=` 不是 global npm。
3. 部署一条入口：`node adapters/pi/bin/pi-worker-mcp.mjs --server <现有 pi-worker-mcp/server.mjs>`。
4. 真实验证必须同时看到真实 prompt 成功和独立 MCP 的实际响应，缺一不可。用同一个显式 CodeBuddy Flash（`codebuddy-intl/deepseek-v4.1-flash`，或当时声明里的默认模型）各做一次：
   - 平台 SDK：`startRun` 发出真实 prompt，并得到模型的实际回复。资源池页的 `models` 命令只证明目录里有这个模型，是目录证据，不是真实验证，不能代替 prompt。
   - 独立 MCP：经薄启动器调用 `delegate_to_pi`，并收到 MCP 的实际响应。
   只跑了 models、只看到目录、或只拼了启动命令，都不能写成真实验证通过。未做这两次真实调用就不得说通过。这两次也不是本票已通过的证据。
5. 若要停用：按上一节移走声明并停用薄启动器，不必改外部 server 源码。
