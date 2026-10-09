# 常见问题

先跑 `node scripts/coagent.mjs doctor`，它逐项告诉你还差什么。

## 启动

**`node src/main.ts` 报“默认状态文件不存在…拒绝静默新建”**
这是有意的保护：直接运行 `main.ts` 时不会悄悄新建一份空状态，免得换了目录启动就把平台分裂成两份。首次运行用 `node scripts/coagent.mjs start`，它会显式指定状态文件；或者自己设 `COAGENT_STATE=<路径>`（指向不存在的文件是允许的，启动后新建）。

**报“SpawnRuntime 拒绝启动：未声明子进程环境变量透传列表”**
设 `COAGENT_AGENT_ENV_PASSTHROUGH`：`-` 表示一个变量都不额外透传，或者逗号列出要交给 agent 的变量名。PowerShell 里 `$env:X = ""` 会**删掉**变量，所以空串算“没声明”，必须写 `-`。用 `scripts/coagent.mjs start` / `run` 不用管，它们替你设了缺省。

**提示端口被占用，或“占锁但未发布端口”“LockBusy”**
同一个状态文件同一时间只允许一个平台进程写它。先看是不是已经启动过一个（`GET http://127.0.0.1:3101/api/health`）。进程被杀后重启，平台会等锁的心跳过期（约 120 秒）、确认端口空闲后自动接管残锁并写审计；不要手工删锁目录，更不要编辑状态文件。

**全新克隆里 `node --test` 一片红，报 `Cannot find package 'pg'`**
平台本体应该零依赖，只有 Postgres 存储需要 `pg`。如果你看到这个错，说明用的是旧版本；更新到最新，或临时 `npm ci`。

## 模型与适配层

**资源池页的模型下拉是空的，或提示“运行时不可用”**
适配层没装好，或者 pi 里没有任何已登录的 provider。`node scripts/coagent.mjs setup`，再 `npx pi` 用 `/login` 登录，`doctor` 应该能列出模型数。

**候选建好了，派发几秒钟就失败**
provider 或模型名没在 pi 里登记，或上游改了名。先单独在 `npx pi` 里用 `/model` 确认能选到它。

**我的 key 在环境变量里，却报没有凭据**
忘了 `--passthrough`，见 [models.md](models.md#1b-用环境变量里的-api-key)。

**`ERR_UNSUPPORTED_DIR_IMPORT`，首选候选被熔断了几分钟**
`--adapter` / `start_mission` 的 `adapter` 传成了目录。它必须是**入口文件** `…/adapters/pi/src/agent-entry.ts`。

**Windows 上执行者的 bash 工具起不来，或进了 WSL**
需要安装 Git for Windows（Git Bash）。pi 靠 `ProgramFiles` 一类变量定位它，这些在基线里；如果装在非标准位置，把路径放进 `PATH`。

**在代理后面，agent 连不上平台，或模型调用超时**
`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 在基线里，会传给子进程。**把 `127.0.0.1,localhost` 加进 `NO_PROXY`**，否则 agent 访问本机平台的请求会被代理吞掉。curl 调接口时加 `--noproxy '*'`。

## Mission

**验证每轮都红，`invalid_argv`**
工单的验证命令写成了壳层包装（`bash -c …`、`cmd /c …`、`powershell -Command …`）或用了 `npm` / `npx`。验证命令是 argv 数组，平台不经 shell 执行；写 `["node","--test"]` 这类。

**Mission 停在 `awaiting_review`**
协调者已经交卷，在等检视者终审，什么都不会自己继续——这是设计：任何状态都不能直接跳到 `completed`。让检视者读证据，`merge` / `send_back` / `abandon`。

**Mission 停住了，状态里有 `waitReason`**
常见几种：升级单等检视者答复；`mission_cost_cap_reached`（累计标价花费到 $10，`budget raise` 放行）；`work_item_checkpoint`（开到第 15 个工作项，批准检查点放行）；所有候选都被熔断或额度用尽（看资源池页，修好再复位熔断）。网页任务页顶部会用中文写原因。

**托管运行自己退出了**
遇到升级、待终审、候选退避它就退出，这是正常的。答复完（或发了新契约）再 `start` 一次；答复后等约 20 秒再启动。

**执行者交了活，但 Mission 合不进集成分支**
合入要求集成分支的 HEAD 等于 Mission 开工时的提交、集成 worktree 工作区干净。Mission 在跑时别往集成分支提交任何东西，别在集成 worktree 里留未提交的改动。

**执行者的改动提交不上，报范围外**
工单的 `allowedScope` 必须写成精确的文件路径，写成目录会让检查点失败。让协调者修订工单。

## 其他

**Linux / macOS**
代码按跨平台写，但没有真机验证。遇到问题请开 issue，附上 `doctor` 的输出。
