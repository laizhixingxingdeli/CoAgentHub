# 单仓发布布局：适配层与 L3 接入并入本仓，依赖走 npm workspaces

用户 2026-10-09：「尽量做到开箱即用，且能够 L3 能接入不同的 agent，L2、L1 能接入不同的模型」，并准备把仓库公开。

## 取舍

把原本散在三个本地目录里的组件放进本仓：

- `adapters/pi/`：pi 适配层（原 coagent-pi 仓库，2026-10-09 并入时取其 master 61ebe21）；
- `integrations/codex/`：L3 的 MCP 服务器（`mcp-server/`，宿主中立的 stdio MCP）、Codex 的 `SessionStart` 钩子与插件清单（原 coagenthub-codex 仓库的**工作区**，其 git 里只有 v4 时代的提交）；
- `integrations/claude-code/`：Claude Code 的技能与 MCP 配置示例。

根 `package.json` 用 npm workspaces 管 `adapters/pi` 与 `integrations/codex/mcp-server` 两个子包的依赖，一次 `npm ci` 装进根 `node_modules`。**平台本体仍然零第三方依赖**（`pg` 只在 `src/application/pg-store.ts`，且按需加载）。

不采用：

- 继续三个仓库。新人要拼三份；平台靠“同级目录叫 coagent-pi”的约定找适配器；插件仓库里 v5 版本的代码从未提交，只存在于一台机器的工作区。
- git submodule。多一层克隆失败模式，对只想跑起来的人是负担。
- 让两个子包各装各的 `node_modules`。见下一节。

## 为什么用 workspaces

Mission 的 worktree 在 `<项目根>/.coagent-worktrees/<id>/`（`workspace.ts` 顶部写明：放在项目内部，Node 沿父目录就能找到**项目根的** `node_modules`，所以平台不建 junction——曾经建过，`git worktree remove --force` 顺着链接把真实依赖树删了）。`adapters/pi/node_modules` 不在这条向上查找的路径上，改适配层的 Mission 会在 worktree 里解析不到 `tsx`、pi。workspaces 把依赖提升到根，不需要任何链接。

## 约定

- 子包的测试文件叫 `*.spec.ts`，不叫 `*.test.ts`：根目录的 `node --test` 会捡走任何位置的 `*.test.ts`，而子包的测试需要 tsx / vitest，混进平台的零依赖全量会红。验证命令写成不经 shell 的 argv（见 `project.md`）。
- 适配器的缺省位置是仓内 `adapters/pi`；`COAGENT_ADAPTER_DIR` 与 `--adapter` 仍可指向别处。平台不 import 任何 agent SDK 的性质不变：适配层通过 stdin / stdout 协议被拉起。
- 适配层每跳现读、合入即生效；平台代码要重启才生效。两者相互依赖的改动，适配层后合。
- 改适配层的票与改平台的票走同一个项目、同一个集成分支，不再有独立的 coagent-pi 状态。
- L3 的接口三层并存：HTTP、命令行（`scripts/coagent.mjs`、`src/l3.ts`）、MCP；平台里没有任何某个 agent 专属的代码，Codex 专属的只有 `integrations/codex/` 里的钩子与投递桥。

## 后果

- 并入前的 coagent-pi 与 coagenthub-codex 两个仓库不再是事实来源，保留为历史。
- 适配层测试里有一条联网的 DNS 失败测试，在有代理的机器上会红（并入前的原仓库同样）；CI 里单独跑，不挡平台全量。
- 子包的依赖提升到根之后，版本冲突要在根锁文件里解决。

## 什么时候该推翻它

- 适配层或 MCP 服务器要独立发版、被别的项目当依赖安装 → 拆回独立包（或发布到 npm）；
- 子包依赖的版本冲突越来越多、workspaces 提升带来的麻烦超过一次克隆的好处；
- 平台本体需要引入第三方依赖 → 先回头改“零依赖”这条性质，再谈布局。
