# 平台运行流程（检视者手册）

用户 2026-10-02：「步骤都要作为平台的流程，保存下来」。这里记的是检视者（L3）驱动平台时的固定步骤；三层分工见 ADR-0007，检视者规则见仓库根目录 `AGENTS.md`。其中「合 master 简报与合并前检查」「值守」等以后由平台自己做（RV2、RV5），做之前按这里人工执行。

## 1. 冻结票

1. 照 to-spec 的结构过一遍：要解决什么、方案、实现决定（改动落在哪一层、接口和数据形状怎么变）、测试接缝（在哪一层验证、参照哪个已有测试）、会碰到哪些既有测试与不变量、不做什么。
2. 核实票里的事实：要改的文件在哪；提到的输入（文件、接口、别的仓库的代码、规格）确实存在；新增事件要在 `src/web/narrate.js` 补翻译，新增等待原因还要补 `src/api/web.ts` 的 WAIT_REASON 表（`test/wait-reason-coverage.test.ts` 钉死，AC3 漏过）；新增协调者工具要由适配器（coagent-pi）先注册。
   - 对照架构决定与规格（`.coagent/architecture/decisions/`、`.coagent/specs/`）：票的做法不能和 ADR 冲突（AC3 先写了「复用 ExecutionBudget 硬停」，与 ADR-0005 冲突，r2 改成独立门禁）。
   - 验收要改接口时先核它现在的返回形状（RS1 要给列表加计数，可列表是裸数组）。
   - 纯搬家 / 重构票：先找出所有读源码文本的测试（`grep -rln "readFileSync" test/`，看哪些读 `src/`），分两类在票里写明怎么适配——钉死文件路径的、钉死调用写法的（如只认 `this.#event(`）。REF1 因这两类各返工一次（契约 r2、r4）。
   - 票里或升级答复里规定具体做法之前，先核平台允不允许。例：已验收的工作项不能修订，只能新建工单补做（REF1 的 E-2）。
   - 新代码守工程规范（`engineering-standards.md`）；数值目标写成建议值，写明「什么情况下算收尾」。
3. 写进方案文件（`missions/PLAN-*.json`，本地文件、不进 git）：why、acceptance、constraints、nonGoals、allowedScope（到目录级，全量测试命令里的路径要被范围覆盖）；会触发分类器禁止副作用的措辞（删、迁移、真实外部调用）配上副作用声明。
4. 开跑前把票单给用户确认。

## 2. 开跑

1. 只读检查：`node src/run-plan.ts … --check`。**只在常驻服务停着时跑**——它整份读状态文件。
2. 常驻服务：`node src/main.ts`（端口 3101）；平台代码有新合入就先重启（见第 4 节）。Windows 使用现有隐藏 VBS 包装器经 `explorer.exe` 启动 cmd，包装器采用窗口样式 0，避免弹出终端；不用 WMI 或 Start-Process。启动前核实持锁进程退出、端口空闲，显式设置原 `COAGENT_STATE`、工作目录及日志；不得重复启动。已核实的包装器是 `C:/Users/echo/AppData/Local/Temp/coagenthub-start-service-hidden.vbs`，路径失效时先核实既有启动器，不盲目替换状态路径。派发设置 `COAGENT_AGENT_ENV_PASSTHROUGH=-`；本会话不使用定时任务。
3. 开跑：`node C:/program1/coagent-experiments/run-plan-platform.mjs <标签> [--project coagent-pi] --max-rounds <n>`。
   - 轮次：按「预计工作项数 × 2.5」给，最多 100。多组搬家这类大票每个工作项约耗 2.4 轮，REF1 先后撞了 30、60 两次上限。撞上限而仍在推进时：升级单选「停」→ `l3 pause` → 重开，平台续跑同一 Mission。
   - 按批放票：方案运行开跑时读一次方案、把所有 pending 都选进来，跑完一张直接接下一张。互不依赖的票放进同一批，一批只在开跑前重启一次；后面的票要用前面票的新平台行为、或前面的票挪动了代码位置（如 REF1）时才分批。不在本批的票用 `C:/program1/coagent-experiments/roles/hold-queue.mjs hold <id,…>` 暂改 planned，下一批开跑前 `release <id,…>`（用户 2026-10-03 要求提速，原来一次只放一张）。
   - 协调者与执行者的候选在开跑时定死，换模型要等下一次开跑。执行者用 pi 的 workbuddy 提供方：全天 cn:hy4-preview 排第一（exec-wb-hy4），cn:hy3、cn:deepseek-v4.1-flash 顶替（exec-wb-hy3、exec-wb-ds-flash）——用户 10-02 23:0x「改hy4执行者」、10-03 白天「也用」。
4. coagent-pi 的票要 `--worktrees`，常驻服务托管不支持（#26）：用 coagent-pi 自己的独立状态 `C:/program1/coagent-experiments/roles/state-pi/.coagent-state.json` 独立运行，可与主线并行。独立运行不发布端口，值守用只看日志的 `C:/program1/coagent-experiments/roles/log-watch.mjs --log <运行日志> --max-minutes 25`。适配器按每次派发现读，合入 coagent-pi 集成分支后下一次派发就生效：改协调者 / 执行者提示词或简报的票放到 Mission 之间跑。

## 3. 值守

1. 挂守候脚本：`node C:/program1/coagent-experiments/roles/duty-watch.mjs --log <运行日志> [--base <端口>]`；有升级单、合入、挂起、超限（单票 $10、15 个工作项、单项执行 4 次）或运行结束就醒。答复升级后等 20 秒再挂，避开答复还没生效的空档。
2. 服务开着时看进度只用 HTTP：`/api/missions/<id>`、`/api/missions/<id>/activity`、`/api/missions/<id>/attempts/<attemptId>`、`/api/plan-runs`、`/api/pools`。不跑 `l3 show` / `l3 plan`。
3. 升级单：
   - 协调者问契约问题——先核实；票有缺口就 `l3 revise` 发新契约，再 `l3 plan decide <E-n> --action answer`；答复写清做法，不只说「同意」。
   - 平台停在 project_busy / no_available_agent / runaway_suspected 且只给「隔离重跑 / 跳过 / 重划 / 停」——选「停」（reviewer_stop），必要时 `l3 pause` 该 Mission、`l3 retire` 卡死的工作项并写明原因，再开跑，平台续跑同一 Mission（PLAT2 / PLAT5）。
   - 不在方案运行里的 Mission：`l3 answer`，答完重跑 `run-mission`。
4. 到线（15 个工作项、单项 4 次）时看原因：在推进就放开那一条线继续，在空转就作废、改票或停。
5. runaway 的恢复：先核实真实承载者是 PlanRun 还是 run-mission，不凭历史 origin 选决策口。暂停 Mission，查实际尝试及租约；作废卡住的工单并保留成果，按调用点或用例组重划，写明真实接口、fixture、定向命令与交卷条件。确认旧执行者退出且租约不再有效后才恢复同一 Mission；原样重派不算恢复。技术拆单由 L3 判断，需求变更或超预算交用户。检查点误答使用显式 `checkpoint approve`，必须带真实 reviewer/reason，费用门禁不变；不编辑状态文件。

## 4. 票与票之间

1. 方案运行里的 Mission 由机器 L3 在集成分支验证后自动合入；`run-mission` 跑的由检视者合入（第 5 节）。
2. 一批跑完、且批里有票改了平台代码（`src/`）：停服务、清锁、标方案源为 done、`--check`、重启服务、再开下一批，让下一批用上新代码。批内不重启；只改测试或文档的不用重启。
3. 平台新增的协调者工具要等适配器注册（coagent-pi）合入后，服务才重启到依赖它的代码。
4. 文档（`.coagent/`、`AGENTS.md`）只在没有 Mission 在跑时提交，只 `git add` 明确的路径。
5. Mission 在跑时集成分支上不许有任何新提交、主工作区不许留未提交改动——平台合入要求目标 HEAD 等于 Mission 开工时的提交、工作区干净。别的会话（如前端会话）的改动在单独的 worktree / 分支上做，在两个 Mission 之间合入。

## 5. 合入集成分支（检视者签）

1. 看交卷：逐条验收的证据、Mission worktree 全量测试结果行（0 fail，只允许 HAOFF1 既有的 7 条 skip）。
2. 文档提议（memoryDelta）经独立队列处理，不阻塞代码合入。查 `/api/projects/:id/documents` 的精确差异，批准时核对 revision/baseHash；只改相关段落，保留未改条款。旧整份正文也必须独立审查，原文不得被截短。
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
2. 先暂停仍在运行的 Mission，再使用 PowerShell 的 `taskkill /F /T /PID <已核实的持锁 pid>`，`/T` 同时停止 agent 子进程。不得凭旧交接里的 PID 杀进程。
3. 核实持锁进程已不存在、端口 3101 没人监听。PLAT5 之后，进程已死、心跳超过 120 秒、端口空闲三条件都满足时平台会自动接管，优先采用该通路。若确需手动删除残锁，先核实绝对路径、锁持有者和三条件；工具自动审批拒绝时报告具体原因，不换工具绕过。绝不直接编辑状态文件。

## 8. 换模型

1. 用户指定模型（UI1 之前由检视者代改）：在 pi 的模型清单里确认提供方与型号（`pi --list-models <词>`）。
2. 经适配器实测一次（query 角色读一个文件，确认工具调用正常）。
3. 加候选：服务开着用 `POST /api/pools`；coagent-pi 独立状态用 `C:/program1/coagent-experiments/roles/pool-pi-state.ts`。候选池只增不删。
4. 改启动脚本 `run-plan-platform.mjs` 的 `--coordinator` / `--executor`；下一次开跑生效。

## 9. 检视者值守与统一待办（2026-10-03 后端）

新接口见 `docs/http-api.md`。先读取 `/api/reviewer/todos` 权威投影，再读 Mission/PlanRun 详情和证据；列表不会消费 Delivery。确认通知仅停止重复提醒，不能代替升级答案、检查点签名或交卷审查；等用户会 park，恢复仍走 parked-resume。

值守通过 `/api/projects/:id/reviewer-duty` claim 领取五分钟租约，每分钟 renew。handoff 递增代次，旧会话不能续约或守候；L3 写操作须携带真实 owner 与 generation。值守不是鉴权，D1d 仍暂缓。显式守候脚本 `node scripts/reviewer-watch.ts <projectId> <会话ID>` 只打印变化；不创建定时任务，本会话按用户要求不启动守候。

可选 `node scripts/reviewer-mcp.ts` 提供十个工作流工具，仍通过本机 HTTP 调用，不直接读写状态。现有 L3 插件保持不变，Delivery 仍由原桥接投递；MCP 握手不代表实际 Delivery 已送达。PlanRun decide 必须确认当前服务确实承载该 run；历史 origin 或仅有记录不能作为依据。

`/api/projects/:id/master-brief` 只提供简报，不执行 master 合并。没有当前 HEAD 的可信平台全量报告时 ready=false，直接实施批的终端测试日志不会被伪造为平台报告。用户签名仍是合 master 的前置。

## 10. 文档提议与空档提交（RV4）

协调者用 `memoryDelta.changes:[{before,after}]` 提出精确差异；检视者规则与架构决定可经 `/api/projects/:id/documents` 提出，仍绑定可信项目 Mission。读取详情、核对保留条款后 approve；edit 会取消旧批准并递增版本，withdraw 不写 Git。文档等用户只抑制通知，不 park 已完成代码。

批准先持久保存，再尝试 Git 提交。项目有未结束且未 park 的 Mission，或仍有 in_progress Attempt，就保持队列；paused 未 park 也保护基线。空档在隔离检出生成文档及 VIBE.md，核对集成分支/HEAD/干净工作区后 fast-forward 提交；目标 master、工作区脏、基线已变均拒写，不覆盖第三方条款。服务启动、批准后、Mission 释放工作区时会尝试处理，必要时经 `/documents/flush` 重试。不创建定时任务。

Git 已成功而队列确认丢失时，提交标记与最终文档内容用于重入恢复，不再追加重复提交。源 Mission 尚有未处理文档时禁止归档；先提交或撤回。文档提交推进集成 HEAD 后，旧 HEAD 测试报告不能代替当前 HEAD 的 master 前置验证。
