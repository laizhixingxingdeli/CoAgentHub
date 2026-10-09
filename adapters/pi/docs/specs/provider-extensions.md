# 托管会话提供方扩展白名单

`src/provider-extensions.ts` 将唯一允许的扩展限定为 provider `codebuddy` 对应 `getAgentDir()/npm/node_modules/pi-codebuddy-oauth`；读取该包 `package.json` 的单个 `pi.extensions` 入口，并以 realpath 检查入口仍在包内。可选 packageDir 仅用于隔离测试。其他 provider 或未安装的包不产生扩展路径。

`src/runtime.ts` 的资源 loader 用 `additionalExtensionPaths` 加载允许的入口，同时继续设置 `noExtensions/noSkills/noPromptTemplates/noContextFiles` 为 true。loader.reload 后把扩展 runtime 的 pendingProviderRegistrations 注册到 ModelRuntime、清空 pending、`refresh({allowNetwork:false})`，然后取模型；缺失 CodeBuddy 包时模型不可用错误提示在 pi 安装 pi-codebuddy-oauth 和 `/login codebuddy`。

`src/cli.ts models` 沿用同一入口及注册流程，输出可用模型 JSON（provider/model/label）；扩展不存在或加载注册异常时静默输出原清单。测试使用临时假扩展，不调用真实模型。
