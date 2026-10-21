# Pi 运行时版本与隔离安装

共同目标版本是 `@earendil-works/pi-coding-agent@1.3.0`，精确版本，不是 `latest`，也不是 `^1.3.0`。声明在 `adapters/pi/package.json`，锁在仓库根 `package-lock.json`。

## 隔离安装与回退

只在要升级的 Mission 工作区根安装，不要动正在跑服务的主工作区 `node_modules`、用户全局 Pi，或祖先仓库的依赖树。

```text
npm install --workspace adapters/pi @earendil-works/pi-coding-agent@1.3.0 --save-exact
```

装完后必须能从该工作区自己的 `node_modules/@earendil-works/pi-coding-agent/package.json` 读到 `1.3.0`。能从祖先目录解析到旧版，不等于这里已经装上目标版。

回退同样只在隔离工作区做：把 `adapters/pi/package.json` 的依赖改回精确旧版（本票之前是 `0.87.1`），再对同一工作区执行 `npm install`。不要在主工作区里删装依赖来“顺便回退”。

## 已验证

- 适配层装配仍走 `ModelRuntime.create` / `getModel` / `registerProvider` / `refresh`、`DefaultResourceLoader.reload`、`createAgentSession`、`SessionManager.create|open`、`subscribe` / `getSessionStats`。
- 托管 loader 保持 `noExtensions` / `noSkills` / `noPromptTemplates` / `noContextFiles`，并显式 `disabledBuiltinExtensions`：`mcp`、`tool-search`、`codemode`、`llama.cpp`。
- `createAgentSession` 的 `tools` 仍是角色 `toolAllowlist`。另外带 `excludeTools`（`mcp__*`、MCP 资源工具、`codemode`、`tool_search`）。1.3.0 里普通名字白名单不能证明 MCP 不可调用。
- query 的最终 active / callable / all 工具闭包是 `read` / `grep` / `find` / `ls`。执行者平台工具仍在，不因上述关闭而消失。
- provider 仍只走既有 allowlist 注册接缝。检视者 CLI 增加 `--no-mcp` 与同一 `excludeTools`。
- Langfuse observer 默认关闭、旁路失败隔离、逐调用事件和 sidecar 高水位沿用既有 spec，本票不改观测协议。

## 未验证 / 尚未做

- PIU2 的 provider 配置还没做。CodeBuddyIntl、Qoder 不能写成已可用，本票也不改它们的来源或模型池。
- 综合测试用的是隔离目录里的假 provider 与假 MCP 注册，不是真实模型调用，也不是 Langfuse 已收到事件。
- 平台全量与全部 Pi specs 由平台 validation 跑。本票不把没跑过的全量写成通过。
