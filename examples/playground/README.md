# playground：第一次跑通整条链用的小项目

```bash
cp -r examples/playground ~/coagent-playground       # 复制到仓库外面
cd ~/coagent-playground
git init -b main && git add -A && git commit -m "init"
git worktree add ../coagent-playground-integration -b coagent/integration
```

之后所有 Mission 的 `--cwd` 都用 `../coagent-playground-integration`（集成 worktree）。完整步骤见 [docs/getting-started.md](../../docs/getting-started.md)。

`mission.json` 是一份现成的契约：加一个 `lastN` 函数。
