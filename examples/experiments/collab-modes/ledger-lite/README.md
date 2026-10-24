# ledger-lite

零依赖的命令行记账小工具。

```bash
node src/cli.js import 账单.csv      # 导入 CSV（表头：date,amount,category,note）
node src/cli.js report               # 按月、按分类汇总
node src/cli.js report --month 2026-01
```

数据保存在当前目录的 `ledger.json`，基准币种在 `config.json`。

测试：`node --test`。项目约定见 [docs/CONVENTIONS.md](docs/CONVENTIONS.md)。
