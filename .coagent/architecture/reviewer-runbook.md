# 平台运行流程（检视者手册）

用户 2026-10-02：「步骤都要作为平台的流程，保存下来」。这里记的是检视者（L3）驱动平台时的固定步骤；三层分工见 ADR-0007，检视者规则见仓库根目录 `CLAUDE.md`。其中「合 master 简报与合并前检查」「值守」等以后由平台自己做（RV2、RV5），做之前按这里人工执行。

## 1. 冻结票

1. 照 to-spec 的结构过一遍：要解决什么、方案、实现决定（改动落在哪一层、接口和数据形状怎么变）、测试接缝（在哪一层验证、参照哪个已有测试）、会碰到哪些既有测试与不变量、不做什么。
2. 核实票里的事实：要改的文件在哪；提到的输入（文件、接口、别的仓库的代码、规格）确实存在；新增事件要在 `src/web/narrate.js` 补翻译；新增协调者工具要由适配器（coagent-pi）先注册。
   - 纯搬家 / 重构票：先找出所有读源码文本的测试（`grep -rln "readFileSync" test/`，看哪些读 `src/`），分两类在票里写明怎么适配——钉死文件路径的、钉死调用写法的（如只认 `this.#event(`）。REF1 因这两类各返工一次（契约 r2、r4）。
   - 票里或升级答复里规定具体做法之前，先核平台允不允许。例：已验收的工作项不能修订，只能新建工单补做（REF1 的 E-2）。
   - 新代码守工程规范（`engineering-standards.md`）；数值目标写成建议值，写明「什么情况下算收尾」。
3. 写进方案文件（`missions/PLAN-*.json`，本地文件、不进 git）：why、acceptance、constraints、nonGoals、allowedScope（到目录级，全量测试命令里的路径要被范围覆盖）；会触发分类器禁止副作用的措辞（删、迁移、真实外部调用）配上副作用声明。
4. 开跑前把票单给用户确认。

## 2. 开跑

1. 只读检查：`node src/run-plan.ts … --check`。**只在常驻服务停着时跑**——它整份读状态文件。
2. 常驻服务：`node src/main.ts`（端口 3101）；平台代码有新合入就先重启（见第 4 节）。**要脱离检视者会话单独起**——会话的后台任务约 30 分钟会被收、会话重启也会把它们一起结束（10-01、10-02 服务都这样退出过，退出码 4）：`powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList 'src/main.ts' -WorkingDirectory 'C:\program1\coagenthub-v5' -WindowStyle Hidden -RedirectStandardOutput '<日志>' -RedirectStandardError '<日志>'"`。守候脚本用 `--max-minutes 25`，赶在后台时限前自己醒。
3. 开跑：`node C:/program1/coagent-experiments/run-plan-platform.mjs <标签> [--project coagent-pi] --max-rounds <n>`。
   - 轮次：按「预计工作项数 × 2.5」给，最多 100。多组搬家这类大票每个工作项约耗 2.4 轮，REF1 先后撞了 30、60 两次上限。撞上限而仍在推进时：升级单选「停」→ `l3 pause` → 重开，平台续跑同一 Mission。
   - 一次只放一张 pending：方案运行开跑时读一次方案、把所有 pending 都选进来，而平台代码合入后要在票与票之间重启服务。其余票用 `C:/program1/coagent-experiments/roles/hold-queue.mjs hold <id,…>` 暂改 planned，下一张开跑前 `release <id>`。
   - 协调者与执行者的候选在开跑时定死，换模型要等下一次开跑。执行者用 pi 的 workbuddy 提供方（用户 2026-10-02）：白天 cn:hy3 → cn:deepseek-v4.1-flash（exec-wb-hy3、exec-wb-ds-flash），23:00–08:00 在两者之间加 cn:hy4-preview（exec-wb-hy4）；启动脚本按开跑时的本地时间自动选，跨过边界的运行在票与票之间重开。
4. coagent-pi 的票要 `--worktrees`，常驻服务托管不支持（#26）：用 coagent-pi 自己的独立状态 `C:/program1/coagent-experiments/roles/state-pi/.coagent-state.json` 独立运行，可与主线并行。独立运行不发布端口，值守用只看日志的 `C:/program1/coagent-experiments/roles/log-watch.mjs --log <运行日志> --max-minutes 25`。适配器按每次派发现读，合入 coagent-pi 集成分支后下一次派发就生效：改协调者 / 执行者提示词或简报的票放到 Mission 之间跑。

## 3. 值守

1. 挂守候脚本：`node C:/program1/coagent-experiments/roles/duty-watch.mjs --log <运行日志> [--base <端口>]`；有升级单、合入、挂起、超限（单票 $10、15 个工作项、单项执行 4 次）或运行结束就醒。答复升级后等 20 秒再挂，避开答复还没生效的空档。
2. 服务开着时看进度只用 HTTP：`/api/missions/<id>`、`/api/missions/<id>/activity`、`/api/missions/<id>/attempts/<attemptId>`、`/api/plan-runs`、`/api/pools`。不跑 `l3 show` / `l3 plan`。
3. 升级单：
   - 协调者问契约问题——先核实；票有缺口就 `l3 revise` 发新契约，再 `l3 plan decide <E-n> --action answer`；答复写清做法，不只说「同意」。
   - 平台停在 project_busy / no_available_agent / runaway_suspected 且只给「隔离重跑 / 跳过 / 重划 / 停」——选「停」（reviewer_stop），必要时 `l3 pause` 该 Mission、`l3 retire` 卡死的工作项并写明原因，再开跑，平台续跑同一 Mission（PLAT2 / PLAT5）。
   - 不在方案运行里的 Mission：`l3 answer`，答完重跑 `run-mission`。
4. 到线（15 个工作项、单项 4 次）时看原因：在推进就放开那一条线继续，在空转就作废、改票或停。

## 4. 票与票之间

1. 方案运行里的 Mission 由机器 L3 在集成分支验证后自动合入；`run-mission` 跑的由检视者合入（第 5 节）。
2. 合入的票改了平台代码（`src/`）：立刻停服务、清锁、标方案源为 done、`--check`、重启服务、再开跑，让下一张票用上新代码。只改测试或文档的不用重启。
3. 平台新增的协调者工具要等适配器注册（coagent-pi）合入后，服务才重启到依赖它的代码。
4. 文档（`.coagent/`、`CLAUDE.md`）只在没有 Mission 在跑时提交，只 `git add` 明确的路径。
5. Mission 在跑时集成分支上不许有任何新提交、主工作区不许留未提交改动——平台合入要求目标 HEAD 等于 Mission 开工时的提交、工作区干净。别的会话（如前端会话）的改动在单独的 worktree / 分支上做，在两个 Mission 之间合入。

## 5. 合入集成分支（检视者签）

1. 看交卷：逐条验收的证据、Mission worktree 全量测试结果行（0 fail，只允许 HAOFF1 既有的 7 条 skip）。
2. 核对随交卷落地的规格（memoryDelta）：平台按 slug 整文件覆盖——改既有规格只许改相关段落，原文不得被截短；与现有文件逐行比对。
3. 合入：`node src/l3.ts merge <missionId> --as "检视者（<模型名>）" --confirmed-by "用户常设授权：集成分支合入由检视者签，仅合入 master 需用户签名（2026-09-28）" --reason "…"`。
4. 方案源里把该票标 done，并记下合入提交、用时、花费。
5. 平台合不进去时（集成分支在交卷后被推进、或工作区不干净，平台没有换基线再合的通路）：先查两边改动的文件有没有重叠、Mission 有没有规格改动要落地，再请用户批准手动合入——`git merge --no-ff <Mission 分支>`，对合并结果跑全量 `node --test`；绿了再 `l3 merge` 留签名（预期被基线校验拒、Mission 转 blocked，同时释放改动名额），方案源标 done 并写明手动合入的提交（AC1 25903aa、REF1 25eea70）。

## 6. 合入 master（用户签）

1. 前置：集成分支最新提交上跑全量 `node --test` 全绿（偶发一次红就整轮复跑；同一条再红才算真红）；没有在跑的 Mission。
2. 简报给用户：按票 / 主题一行、接口与文档变化、风险、花费、领先 master 的提交数。
3. 用户说「合」之后：在临时 worktree 合并，主工作区不切分支——
   `git worktree add <临时目录> master`，
   `git -C <临时目录> merge --no-ff auto/harness-remaining -m "合并 auto/harness-remaining → master：<n> 张票（<m> 个提交）——用户 <日期> 签字合入 …"`，
   核对与集成分支内容一致（`git diff auto/harness-remaining HEAD` 为空），再 `git worktree remove <临时目录>`。
4. 本仓没有远端，不推送。记录：fb14039（09-30）、83d5877（10-02）。

## 7. 停服务与清锁

1. 停之前确认没有在跑的 agent（查 node 进程命令行里的 agent-entry / run-plan / run-mission）。
2. Windows 上只能强停：`taskkill //F //PID <持锁 pid>`。
3. 核实持锁进程已不存在、端口 3101 没人监听，再删 `.lock-.coagent-state.json`。PLAT5 之后，进程已死、心跳超过 2 分钟、端口空闲三条件都满足时平台会自动接管。

## 8. 换模型

1. 用户指定模型（UI1 之前由检视者代改）：在 pi 的模型清单里确认提供方与型号（`pi --list-models <词>`）。
2. 经适配器实测一次（query 角色读一个文件，确认工具调用正常）。
3. 加候选：服务开着用 `POST /api/pools`；coagent-pi 独立状态用 `C:/program1/coagent-experiments/roles/pool-pi-state.ts`。候选池只增不删。
4. 改启动脚本 `run-plan-platform.mjs` 的 `--coordinator` / `--executor`；下一次开跑生效。
