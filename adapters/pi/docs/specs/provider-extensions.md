# 托管会话提供方扩展

平台 SDK 与 `src/cli.ts models` 共用 `src/pi-runtime-shared.mjs` 的无密钥声明，不读 `auth.json` / `models.json` / `settings.json`，也不再回落 `getAgentDir()/npm/node_modules/pi-codebuddy-oauth`。

声明文件默认 `~/.coagent/pi-runtime.json`。隔离测试用 `COAGENT_PI_RUNTIME_CONFIG` 指向别的文件；该变量指向缺失路径是配置缺失，不是静默成功。文件不存在且未设置该变量时，只保留原 native 模型。

`extensions.codebuddy.packageDir` 的包同时登记 `codebuddy` 与 `codebuddy-intl`。`extensions.qoder.packageDir` 同时登记 `qoder` 与 `qoder-cn`。`extensions.antigravity` 只在 L3 显式填写 `providerId` 时加载，并跳过路径名含 search/image/vision/imagen 的入口。其它键会被拒绝，避免把个人插件整表加载进来。

`resolveProviderExtensionPaths(provider, packageDir?)` 仍供 startRun 与既有隔离测试使用。`packageDir` 仅测试用；省略时按声明解析。models 用 `resolveCatalogExtensionPaths()` 加载整份审核清单。两边都走 `pendingProviderRegistrations` → `registerProvider` → `refresh({ allowNetwork: false })`。显式非法配置、无效路径、目标 provider 未注册会抛出只含路径/字段名的诊断，不把配置正文写进错误。

worker 的默认/备用模型只给独立 MCP 启动器，不改平台角色池或 native 候选优先级。缺省是 `codebuddy-intl/deepseek-v4.1-flash` 与 `codebuddy/deepseek-v4.1-flash`。
