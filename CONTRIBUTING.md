# 参与开发

欢迎提 issue 和 PR。

## 本地开发

```bash
git clone https://github.com/laizhixingxingdeli/CoAgentHub.git && cd CoAgentHub
node --test                       # 平台全量测试，不需要装任何依赖
node --test test/<名字>.test.ts   # 定向跑一个
```

- 平台本体没有构建步骤、没有第三方依赖（`pg` 只出现在 `src/application/pg-store.ts`，并且是按需加载）。
- 适配层和 MCP 服务器的依赖由根 `package.json` 的 npm workspaces 一次装进根 `node_modules`（`npm ci`），测试各自跑：`npm test -w adapters/pi`、`npm test -w integrations/codex/mcp-server`。它们的测试文件叫 `*.spec.ts`，是为了不被根目录的 `node --test`（会发现任何位置的 `*.test.ts`）捡走。
- 需要 Postgres 的测试在连不上数据库时会**跳过**，跳过不算通过。

## 代码约定

细则在 [.coagent/project.md](.coagent/project.md) 的“执行者红线”和 [.coagent/architecture/engineering-standards.md](.coagent/architecture/engineering-standards.md)，要点：

- **分层**：`src/kernel/` 不 import 任何东西（连 `node:` 都不），也不出现 provider / model / session / http / sql 这类词；第三方依赖只允许在 `src/application/pg-store.ts`；规则写在用例层，**能用工具层挡住的就不要指望提示词**。
- **写法**：相对 import 必须带 `.ts` 后缀（Node 原生类型剥离）；不用 `enum`，不用构造函数参数属性；前端不引入构建步骤和框架。
- **注释写“为什么”**，尤其是“不这么做会怎样”。
- **测试尽量少**，只加在关键地方，每条验收一两条；不要为每个分支各写一条。
- 函数 ≤ 40 行、文件 ≤ 400 行、嵌套 ≤ 3 层、参数 ≤ 4 个（预警线，不是硬指标）。
- 换行：提交进仓库的内容一律 LF。
- 提交信息用约定式（`feat:` / `fix:` / `docs:` / `chore:`……）。

## 关于 AGENTS.md 和 `.coagent/`

这个项目**用自己开发自己**：维护者通过 CoAgentHub 的 Mission 来实现功能，[AGENTS.md](AGENTS.md) 是维护者的检视者（L3）规则，`.coagent/` 是项目自己的长期记忆（规格、架构决定、模块地图）。

- 当你的 agent 在这个仓库里扮演**维护者的检视者**时，才需要遵守 AGENTS.md。
- 作为外部贡献者，直接提 PR 即可，不必走 Mission；维护者可能会把它重做成 Mission，或者直接合并。
- 如果你只想**用** CoAgentHub 管你自己的项目，去看 [docs/getting-started.md](docs/getting-started.md)，不用读 AGENTS.md。
