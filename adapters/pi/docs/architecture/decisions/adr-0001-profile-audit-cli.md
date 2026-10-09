# 档案过期检查独立为 audit 子命令

## 背景

档案表过期的症状像「模型不可用」。需要一条不发真实任务、可重复的对照命令。

## 决策

1. **新增 `tsx src/cli.ts audit`，不改 doctor、不改 models 的 JSON。**
   - doctor 职责是探活，对得上也会 `createAgentSession` + `prompt`，不满足「不跑任务就能查」，且改它会动现有诊断行为。
   - `models` 的 JSON 是给平台资源池解析的协议，改形状会搞坏调用方。
2. **过期判定用目录存在性（getModel / getModels），不用 getAvailable。**
   没配密钥不算过期；运行时抛「模型不可用」走的是 getModel。
3. **查出来不自动改 PROFILES。** 改不改由人决定。

## 后果

- 人读报告里的「可用」清单用 getAvailable（约 49 条）并分组；同名异 provider 只点出相关几条。
- 测试只测纯函数（注入假目录）；真目录对照靠实跑 `tsx src/cli.ts audit`。

