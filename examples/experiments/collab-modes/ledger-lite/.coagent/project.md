# ledger-lite

零依赖的 Node 命令行记账工具（ESM，`node --test`）。

## 执行者红线

- 改代码前先读 `docs/CONVENTIONS.md`，里面的金额、舍入、错误输出、存储兼容规则是硬约定。
- 不加任何依赖，不改 `package.json` 的依赖与脚本。
- 已有测试不改不删，只能新增。
- 验证命令：`node --test`。
