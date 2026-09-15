# CoAgentHub v5

Agent-First 架构基线的实现。

## 运行环境

Node 24+，靠原生类型剥离直接跑 TypeScript，**没有构建步骤，没有第三方依赖**。

```
node --test
```

测试用 `node:test` + `node:assert/strict`。测试文件命名 `test/*.test.ts`，
从 `src/` 用相对路径带 `.ts` 后缀导入（`import { x } from "../src/kernel/y.ts"`）。

## 分层

- `src/kernel/` —— 纯领域。**不得 import 任何第三方包**，不得出现
  provider / model / session / HTTP / SQL 这类概念。
