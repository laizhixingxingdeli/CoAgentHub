# 平台运行流程（检视者手册）

用户 2026-10-02：「步骤都要作为平台的流程，保存下来」。这里记的是检视者（L3）驱动平台时的固定步骤；三层分工见 ADR-0007，检视者规则见仓库根目录 `AGENTS.md`。其中「合 master 简报与合并前检查」「值守」等以后由平台自己做（RV2、RV5），做之前按这里人工执行。

## 1. 冻结票

1. 照 to-spec 的结构过一遍：要解决什么、方案、实现决定（改动落在哪一层、接口和数据形状怎么变）、测试接缝（在哪一层验证、参照哪个已有测试）、会碰到哪些既有测试与不变量、不做什么。
2. 核实票里的事实：要改的文件在哪；提到的输入（文件、接口、别的仓库的代码、规格）确实存在；新增事件要在 `src/web/narrate.js` 补翻译，新增等待原因还要补 `src/api/web.ts` 的 WAIT_REASON 表（`test/wait-reason-coverage.test.ts` 钉死，AC3 漏过）；新增协调者工具要由适配器（coagent-pi）先注册。
   - 对照架构决定与规格（`.coagent/architecture/decisions/`、`.coagent/specs/`）：票的做法不能和 ADR 冲突（AC3 先写了「复用 ExecutionBudget 硬停」，与 ADR-0005 冲突，r2 改成独立门禁）。
   - 验收要改接口时先核它现在的返回形状（RS1 要给列表加计数，可列表是裸数组）。
   - 要推翻或改变既有行为的票：先按行为词、状态词、错误码、候选 id、事件名 grep `test/`，找出钉着旧行为的断言；契约里点名文件与行号并授权改写，把这些测试文件放进允许范围，把「为保持绿而缩小新规则」列入非目标；钉着别的性质的测试变红就是实现错了，不许改测试迁就。COM8 漏过一次（`orchestrator.test.ts:729` 钉着「no_structured_result 不换候选」，执行者做完才发现，白花一轮并发了契约 r2），同类还有 VR1（`docs/http-api.md` 路由文档）、COM3-B4（web-narrate 叙事测试）。
   - 契约不要写协调者读不到的证据（如「绑定最终提交的完整平台 VR」）：它会为此升级，白占一个来回（PI-COM1 的 W-512 就多了一轮）。写成「交卷带 VR 编号与摘要，完整 VR 由 L3 终审核对」。
   - 两张票改同一份规格时（COM8、PERF1 都改 candidate-circuit），一张合入并批文档、确认集成分支出现「docs(project): 批准文档提议」之后，再建下一张：同项目有未结束的 Mission（含已建未跑的）会挡文档空档提交，后一张的 memoryDelta 也会对着旧基线。
   - 纯搬家 / 重构票：先找出所有读源码文本的测试（`grep -rln "readFileSync" test/`，看哪些读 `src/`），分两类在票里写明怎么适配——钉死文件路径的、钉死调用写法的（如只认 `this.#event(`）。REF1 因这两类各返工一次（契约 r2、r4）。
   - 票里或升级答复里规定具体做法之前，先核平台允不允许。例：已验收的工作项不能修订，只能新建工单补做（REF1 的 E-2）。
   - 新代码守工程规范（`engineering-standards.md`）；数值目标写成建议值，写明「什么情况下算收尾」。
3. 写进方案文件（`missions/PLAN-*.json`，本地文件、不进 git）：why、acceptance、constraints、nonGoals、allowedScope（到目录级，全量测试命令里的路径要被范围覆盖）；会触发分类器禁止副作用的措辞（删、迁移、真实外部调用）配上副作用声明。
4. 开跑前把票单给用户确认。

## 2. 开跑

1. 只读检查：`node src/run-plan.ts … --check`。**只在常驻服务停着时跑**——它整份读状态文件。
2. 常驻服务：`node src/main.ts`（端口 3101）；平台代码有新合入就先重启（见第 4 节）。Windows 使用现有隐藏 VBS 包装器经 `explorer.exe` 启动 cmd，包装器采用窗口样式 0，避免弹出终端；不用 WMI 或 Start-Process。启动前核实持锁进程退出、端口空闲，显式设置原 `COAGENT_STATE`、工作目录及日志；不得重复启动。已核实的包装器是 `C:/Users/echo/AppData/Local/Temp/coagenthub-start-service-hidden.vbs`，路径失效时先核实既有启动器，不盲目替换状态路径。派发设置 `COAGENT_AGENT_ENV_PASSTHROUGH=-`；本会话不使用定时任务。
3. 新票通过新版 CoAgentHub v5 L3 插件开跑（0.2.2，2026-10-04）：先 `coagenthub_get_platform_status` 核实服务持锁身份、当前占用；冻结完整 Contract 后 `coagenthub_create_mission`，Delivery recipient 使用当前真实 Codex root 会话；再 `coagenthub_start_mission`，指定独立集成 worktree、已验收的 adapter 路径和 maxRounds。启动不直读状态文件，不另起 CLI 写者或终端，环境透传声明固定为 `-`。生产 run-plan 已退役，不对历史 PlanRun 原样续跑。
   - 插件 accepted 只是 HTTP 请求受理；`coagenthub_get_hosted_run` 的 running 表示平台启动输出已确认，ended 提供退出码；Mission 完成以权威视图和交卷证据为准。断流或插件重启后观测为 unknown，先查 Mission/activity 和真实运行者，禁止盲目重试。当前插件同实例抑制重复启动，不承诺跨实例分布式去重。
   - 恢复暂停只清 paused，不负责启动；挂起先走 resume_parked 的目标同步。已有 Mission 的启动读取当前权威 Contract，不用旧本地规格覆盖。历史 origin 不决定承载通路：先核实真实 PlanRun 已停止还是仍运行。
   - 轮次按预计工作量配置，最多100；触顶仍在推进时核实原因再续跑同一 Mission，不能默认新建重跑。互不依赖票可同批验证，改平台源码只在无运行 agent 的空档重启一次；依赖新行为的下一批在服务加载后开跑。
   - `coagenthub_start_mission` 的 adapter 参数是入口文件 `.../coagent-pi/.../src/agent-entry.ts`，不是目录（传目录会让首跳 ERR_UNSUPPORTED_DIR_IMPORT，首选候选被熔断 5 分钟）；命令行里直接写 Windows 反斜杠会被吞，用 node 把参数写成 JSON 文件再传。托管运行在 Mission 等 L3（升级、待终审）或 hop 退避时就退出；答复升级、发契约修订（待终审时 `revise_contract` 会把 Mission 退回规划）之后要重新 start_mission 才继续，答复后等约 20 秒再续。同时跑的 Mission 不超过两条：并行会抬高全量测试偶发率（Windows 子进程 0xC0000142、FileAgentPoolRepository 两个实例交替追加丢行），红了先隔离复跑再下结论。
   - 候选顺序以平台当前角色配置为权威，每次派发读取；start_mission 的 coordinator/executor 参数只作兼容校验，不覆盖当前配置。提示词及适配器更新安排在 Mission 空档。
4. coagent-pi 的票要 `--worktrees`，常驻服务托管不支持（#26）：用 coagent-pi 自己的独立状态 `C:/program1/coagent-experiments/roles/state-pi/.coagent-state.json` 独立运行，可与主线并行。独立运行不发布端口，值守用只看日志的 `C:/program1/coagent-experiments/roles/log-watch.mjs --log <运行日志> --max-minutes 25`。适配器按每次派发现读，合入 coagent-pi 集成分支后下一次派发就生效：改协调者 / 执行者提示词或简报的票放到 Mission 之间跑。

## 3. 值守

1. 挂守候脚本：`node C:/program1/coagent-experiments/roles/duty-watch.mjs --log <运行日志> [--base <端口>]`；有升级单、合入、挂起、超限（单票 $10、15 个工作项、单项执行 4 次）或运行结束就醒。答复升级后等 20 秒再挂，避开答复还没生效的空档。
2. 服务开着时看进度只用 HTTP：`/api/missions/<id>`、`/api/missions/<id>/activity`、`/api/missions/<id>/attempts/<attemptId>`、`/api/plan-runs`、`/api/pools`。不跑 `l3 show` / `l3 plan`。
3. 升级单：
   - 协调者问「已验收的项要补做 / 作废的项怎么办」：不再属于升级范围（ADR-0007 补充，2026-10-07），答复引用那一条并让它直接新建引用原 id 的补修单；执行者被杀后工作项卡在 dispatched 的，等 COM12 的平台收尾，之前只能由我作废并另建（作废只当「不用做了」用，不是重启办法）。
   - 协调者问契约问题——先核实；票有缺口就 `l3 revise` 发新契约，再 `l3 plan decide <E-n> --action answer`；答复写清做法，不只说「同意」。
   - 平台停在 project_busy / no_available_agent / runaway_suspected 且只给「隔离重跑 / 跳过 / 重划 / 停」——选「停」（reviewer_stop），必要时 `l3 pause` 该 Mission、`l3 retire` 卡死的工作项并写明原因，再开跑，平台续跑同一 Mission（PLAT2 / PLAT5）。
   - 不在方案运行里的 Mission：`l3 answer`，答完重跑 `run-mission`。
4. 到线（15 个工作项、单项 4 次）时看原因：在推进就放开那一条线继续，在空转就作废、改票或停。
5. runaway 的恢复：先核实真实承载者是 PlanRun 还是 run-mission，不凭历史 origin 选决策口。暂停 Mission，查实际尝试及租约；作废卡住的工单并保留成果，按调用点或用例组重划，写明真实接口、fixture、定向命令与交卷条件。确认旧执行者退出且租约不再有效后才恢复同一 Mission；原样重派不算恢复。技术拆单由 L3 判断，需求变更或超预算交用户。检查点误答使用显式 `checkpoint approve`，必须带真实 reviewer/reason，费用门禁不变；不编辑状态文件。

## 4. 票与票之间

1. 方案运行里的 Mission 由机器 L3 在集成分支验证后自动合入；`run-mission` 跑的由检视者合入（第 5 节）。
2. 一批跑完、且批里有票改了平台代码（`src/`）：停服务、清锁、标方案源为 done、`--check`、重启服务、再开下一批，让下一批用上新代码。批内不重启；只改测试或文档的不用重启。（2026-10-07 更正）服务从主工作区跑，主工作区检出的是 master：集成分支（如 codex/communication-integration）上的平台代码要等合 master 之后重启才加载，**只重启不会加载**（本批 COM6–COM11 与 PERF1 就是这样，10-07 夜白重启了一次）；pi 适配器相反，每跳从它的集成 worktree 现读，合入即生效。所以平台与适配器相互依赖的改动（PERF1 的前缀匹配与 PI-COM1 的 10Router 额度行）适配器后合：master 带上平台这半并重启之后，再合适配器那半，否则现有平台会把 10Router 多行按「第一条同 provider 行」误读，某个上游用尽就可能把整个 tenrouter 池熔断。
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
   主工作区本身检出的就是 master 时（同一分支不能在两个 worktree 检出），直接在主工作区 `git merge --no-ff <集成分支>`，同样核对 diff 为空、工作区干净。前置验证要绑定集成分支当前 HEAD：之后哪怕只有文档提交，也要重跑平台全量（有测试读 `.coagent/project.md`）；用零代码验证 Mission 跑，它没有改动，收尾不产生新提交（2026-10-07 的 MASTER-PRECHECK）。
   合完在没有在跑的 agent 时重启服务加载新代码：核实持锁 pid 与 3101 监听者一致后 `taskkill /F /T /PID`，等心跳超过 120 秒，再用隐藏启动脚本起服务，平台自动接管并写审计；起来后用一个已有 Mission 的 HTTP 视图确认新行为生效。
4. 本仓没有远端，不推送。记录：fb14039（09-30）、83d5877（10-02）、80d098b（10-07，COM1–COM5，用户「先合主干」）。

## 7. 停服务与清锁

1. 停之前确认没有在跑的 agent（查 node 进程命令行里的 agent-entry / run-plan / run-mission）。
2. 先暂停仍在运行的 Mission，再使用 PowerShell 的 `taskkill /F /T /PID <已核实的持锁 pid>`，`/T` 同时停止 agent 子进程。不得凭旧交接里的 PID 杀进程。
3. 核实持锁进程已不存在、端口 3101 没人监听。PLAT5 之后，进程已死、心跳超过 120 秒、端口空闲三条件都满足时平台会自动接管，优先采用该通路。若确需手动删除残锁，先核实绝对路径、锁持有者和三条件；工具自动审批拒绝时报告具体原因，不换工具绕过。绝不直接编辑状态文件。

## 8. 换模型

1. 用户指定模型（UI1 之前由检视者代改）：在 pi 的模型清单里确认提供方与型号（`pi --list-models <词>`）。
2. 经适配器实测一次（query 角色读一个文件，确认工具调用正常）。
3. 三种执行角色的配置后端：先读 `GET /api/pools/config`，保留 revision，再经 `POST /api/pools/<role>/configure` 提交完整有序列表。可编辑模型与思考 facts、停用、排序、删除；旧版本拒绝，失败不部分落库。原 `POST /api/pools` 追加入口保留兼容。网页编辑入口仍待前端设计。
4. 不再通过启动脚本改候选。启动只读配置，不为空池播种；旧 `--coordinator` / `--executor` 参数只做兼容校验，不覆盖实际调度顺序。下一跳重新读取当前启用列表，在途 attempt 保留启动身份。分类用只读角色池尚待独立接线，不能把本阶段标作完整 UI1。

## 9. 检视者值守与统一待办（2026-10-03 后端）

新接口见 `docs/http-api.md`。先读取 `/api/reviewer/todos` 权威投影，再读 Mission/PlanRun 详情和证据；列表不会消费 Delivery。确认通知仅停止重复提醒，不能代替升级答案、检查点签名或交卷审查；等用户会 park，恢复仍走 parked-resume。

值守通过 `/api/projects/:id/reviewer-duty` claim 领取五分钟租约，每分钟 renew。handoff 递增代次，旧会话不能续约或守候；L3 写操作须携带真实 owner 与 generation。值守不是鉴权，D1d 仍暂缓。显式守候脚本 `node scripts/reviewer-watch.ts <projectId> <会话ID>` 只打印变化；不创建定时任务，本会话按用户要求不启动守候。

可选 `node scripts/reviewer-mcp.ts` 提供十个工作流工具，仍通过本机 HTTP 调用，不直接读写状态。现有 L3 插件保持不变，Delivery 仍由原桥接投递；MCP 握手不代表实际 Delivery 已送达。PlanRun decide 必须确认当前服务确实承载该 run；历史 origin 或仅有记录不能作为依据。

`/api/projects/:id/master-brief` 只提供简报，不执行 master 合并。没有当前 HEAD 的可信平台全量报告时 ready=false，直接实施批的终端测试日志不会被伪造为平台报告。用户签名仍是合 master 的前置。

## 10. 文档提议与空档提交（RV4）

协调者用 `memoryDelta.changes:[{before,after}]` 提出精确差异；检视者规则与架构决定可经 `/api/projects/:id/documents` 提出，仍绑定可信项目 Mission。读取详情、核对保留条款后 approve；edit 会取消旧批准并递增版本，withdraw 不写 Git。文档等用户只抑制通知，不 park 已完成代码。

批准先持久保存，再尝试 Git 提交。项目有未结束且未 park 的 Mission，或仍有 in_progress Attempt，就保持队列；paused 未 park 也保护基线。空档在隔离检出生成文档及 VIBE.md，核对集成分支/HEAD/干净工作区后 fast-forward 提交；目标 master、工作区脏、基线已变均拒写，不覆盖第三方条款。服务启动、批准后、Mission 释放工作区时会尝试处理，必要时经 `/documents/flush` 重试。不创建定时任务。

Git 已成功而队列确认丢失时，提交标记与最终文档内容用于重入恢复，不再追加重复提交。源 Mission 尚有未处理文档时禁止归档；先提交或撤回。文档提交推进集成 HEAD 后，旧 HEAD 测试报告不能代替当前 HEAD 的 master 前置验证。

## Mission 队列取代新 Plan 运行（PL1，2026-10-04）

新批次先冻结并确认 Mission 清单，在服务空档配置项目执行目录、适配器、集成分支、检视者、会话引用、透传名单及 argv 验证命令；GET 项目 mission-queue 获取 revision 后，用 run-queue.ts 或对应 HTTP 写入口提交，confirmedBy 使用真实授权。已领取值守时 CLI 携带 reviewer/generation。整批验证与版本核对通过才写入，不直接改状态文件。

服务持有唯一写者并驱动队列；前项等待门禁或 L3 终审时后项不启动。依赖仅在关联 Mission completed 后放行。启动时固定项目配置，后续改配置不影响在途任务和续跑工作区。失败停靠为 Mission 暂停与诊断待办，查明原因后走 resume；费用升级、检查点、挂起、放弃、重试及最终审查继续使用 Mission 入口。standard 由真实检视者签字并执行项目集成验证；lightweight 也须逐条验收和集成验证才完成。

生产 run-plan 控制入口已退役返回410，离线执行不再创建平台或 PlanRun。历史 PlanRun 查询、决定与测试恢复逻辑保留；不要重新启动历史 Plan 运行。实际 AC4 仍保留原状态与基线，本次直接实施不伪造其平台交卷。前端另行设计，master 仍待用户说“合”。

## 2026-10-04 插件值守与验证补充
当前会话平台操作只经 v5 L3 插件，不沿用上文历史 HTTP/CLI 写操作。协调者先让执行者跑定向自测，由工单 validation.commands 对实际交付提交执行全量；L3读取完整 ValidationReport，核对 argv/cwd、退出码、计数及提交来源。固定七处 HAOFF1 源码未变且全量 skipped=7 时，不为收集名称重复全量；代码变化、失败、缺失证据或平台对新提交来源的必需验证仍须执行。
协调者当前 get_mission/get_work_item 只提供验证摘要，不能取得完整报告。缺报告先升级索取，保留 submitted；不得仅因读取缺口先 reject。已 rejected 不能直接 accept，必须在合法状态修订后重新派发、提交，再独立验收；不编辑状态，不伪造提交来源。COM2 的实际恢复保留原代码和定向证据，通过新 Attempt 的平台全量重新验证，完整历史保留。
插件 pause 只限制后续调度，不保证打断运行中的 agent；当前没有已验证的在途追加指令/安全中止插件入口。恢复前查真实 hosted 退出状态与 activeLeases，不能把暂停当成已退出。
独立 AC4-platform-closeout-20261004 已完成并合入 a756fc5；原历史 AC4 仍 parked、历史 PlanRun stopped，二者不得混称。COM1 b52973a、文档 e69aa30 和 COM2 36971f0 已合入 codex/communication-integration；服务仍运行 master d4f39c8，这些新改动尚未加载。

## 2026-10-06 补充（B2b 收尾的教训）
- 服务被系统重启带掉时：先核实持锁进程已死、心跳超过 120 秒、端口空闲、没有残留 agent，再用隐藏 VBS 启动；平台会自动隔离接管残锁并写审计，不用手工清锁。
- 换检视者会话（例如从 Codex 换到 Claude）时，先停旧会话的 Delivery 桥接守护进程，否则通知会注入旧会话并被自动 ACK，出现两个 L3 同时决策。没有桥接的会话不手工 ACK，只主动读权威状态。
- 零代码的验证单也要给非空的 allowedScope：执行者交卷后的冻结范围检查点遇到空范围会直接抛错，验证不会跑（`orchestrator.ts` 检查点段）。要保证零改动，就把 diffSize 设成 maxChangedFiles=0、maxChangedLines=0。
- 不走队列的 Mission（create 后用托管 run-mission 运行），检视者合入时平台不会再跑项目集成验证（`final-review.ts` 只对队列配置运行）。所以终审前必须有绑定最终提交的平台全量 VR；中间的单如果只跑定向，最后要补一张验证单。协调者自己跑的全量不能代替。
- 同一条验收连续三个工作项没通过时，平台会自动开验收标准级升级。要强制拆单或改做法，就写进契约修订：只写在退休理由里的拆单建议，协调者不一定照做（B2b 的 r5）。
- 工单 validation 里的 diffSize 只用在零代码验证单（0/0）。实现单不要设行数硬上限：B4 的 W-489、W-491 各因超了几行被平台判失败、白重派一次，这违背工单标准第 7 条。
- 执行者自己跑全量会和平台 VR 抢同一批全机共用的 PG 测试库，制造 DUPLICATE_ID 之类的假红；看到红就交 partial 时平台又不跑 VR，会原地打转（B3 的 W-487）。验证单的 requiredBehaviour 要写死「只跑一次定向、交证据、立即交 completed」。
- pi 协调者还没有读取完整 VR 的工具，每张单验收前都会升级来要全文。L3 按「报告原文 + 来源事件 + Git 关联 + HAOFF1 静态 skip 核对」答复，然后续跑；要等 pi A2 注册、集成代码部署到服务以后，这一来一回才会消失。
- 2026-10-07 夜：PI-COM1（pi 协调者注册 `coagent_get_validation_report`、契约核对 issues 后不再手动升级、usage 命令报 10Router 各上游额度、`appendXaiQuotaReset` 只认 xAI 行）已在 pi 集成分支的 Mission 里验收完毕，等 master 合入 PERF1 并重启之后再合；合入后协调者可以自读完整 VR，上一条说的那一来一回才真正消失。
