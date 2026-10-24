# 平台运行流程（检视者手册）

用户 2026-10-02：「步骤都要作为平台的流程，保存下来」。这里记的是检视者（L3）驱动平台时的固定步骤；三层分工见 ADR-0007，检视者规则见仓库根目录 `AGENTS.md`。其中「合 master 简报与合并前检查」「值守」等以后由平台自己做（RV2、RV5），做之前按这里人工执行。

## 0. 检视者能直接写什么，什么必须开 Mission（用户 2026-10-08 认可）

`AGENTS.md` 说检视者不写功能代码。划线如下，出线的一律开 Mission：

- **可以直接做**：①`.coagent/` 下的文档（在两个 Mission 之间提交）；②运维——重启服务、改服务启动器与隐藏启动 VBS、经插件配置执行池、登记 pi 的模型路由、跑全量测试做合前验证；③合入集成分支（经插件，我签）与用户说「合」之后合 master；④调用**已批准工具**的胶水脚本，放在维护者本机的 L3 工具包里（不在本仓）：只许调用现有插件 / MCP / HTTP 路由、读取并整理它们的返回，不新增平台能力。
- **必须开 Mission**：产品仓库（v5、coagent-pi 等）里的任何代码与测试；已批准工具面的任何新增或改动（新增 MCP 工具、插件工具、HTTP 路由）；规格要求的行为变化。例：10-08 的候选熔断复位工具走 L3MCP1；`rmcp.mjs` 只是既有 reviewer MCP 的客户端，属于胶水，直接写。
- 拿不准归哪边就开 Mission；胶水脚本一旦长出判断逻辑（不再只是转发和整理），也改走 Mission。

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
   - 解析外部数据的票（读别的服务的返回：账户额度、日志、第三方接口）：夹具必须取真实返回的形状（匿名化后），契约里写明真实形状的要点（桶的标记、数值怎么配平、各上游的差异），不凭想象造样例。合入前 L3 用只读脚本对真实数据跑一次修复前后对比：只放行对本机服务的 GET、凭据读取注入成空、输出只含白名单字段、不印账号信息。PI-COM1 反例：虚构样例全绿，真实 CodeBuddy 每账号 26 个桶（总池 Total Points + 每月礼包 + Bonus Pack 1…24，没有 detailOnly / aggregate 标记）被取最小，整个 cbcn 报「剩余 0%、恢复时间 11-02（其实是小包过期日）」，平台据此给 3 个协调者候补开了额度熔断；PI-COM2 改用真实形状夹具修好，合入前后对比 cbcn 0% → 64.82%。
   - 工单 `validation.commands` 的 argv 不得是 cmd / sh / bash / powershell / pwsh 的壳层包装：校验引擎判 `invalid_argv`，永远红，而验证简版只显示一个没有输出的红（`ValidationReportCommandView` 丢了原因，读完整 VR 才看得到）。全量命令直接写 `["node","--import","tsx","--test","src/*.test.ts"]`（pi）或 `["node","--test"]`（本仓），glob 由 Node 自己展开。PI-COM2 的 W-520 因协调者写了 `bash -lc` 白烧一个执行者来回和一个协调者跳，契约里要点明。COM13 上线后（合 master 并重启服务后）冻结与修订工单时平台直接拒绝这类 argv（错误码 `WORK_ORDER_VALIDATION_ARGV`，消息给出命令下标与改法）；在那之前仍要在契约里点明。
   - 凡是把「词法路径」和 realpath / git 打印的路径 / `import.meta.url` 放在一起比较的票（含：入口判断、包含检查、worktree 定位、状态文件定位），以及票里新增的涉路径测试：冻结时就把「临时目录是别名」当作一种必测环境——TEMP / TMP / TMPDIR 设成指向真实目录的联接点（`fs.symlinkSync(real, link, 'junction')`，免管理员；对应 macOS 的 `/var`→`/private/var`），再设成 8.3 短名（`dir /x` 查，对应 Windows 运行机的 `RUNNER~1`），各跑一遍相关测试甚至全量。REL3 的教训：首轮 GitHub CI 三平台全红（Windows 12 条、macOS 13 条），原因全是运行机的临时目录是别名，而作者机器的用户名短、没有短名，一直是绿的；REL3 冻结时只核了入口判断，漏核 `test/start-server.test.ts` 的期望值也按别名写法拼，被全量验证单撞出来，多了一份契约 r2。路径口径要点明：对齐 Node 加载器（`import.meta.url`）用 JS 版 `realpathSync`（不展开 8.3 短名），对齐 git 的输出与 `fs/promises` 的 `realpath` 用 native 版（展开短名）；两者别混。
   - 「先写红测试再修」的拆法要考虑平台只认退出码 0：红测试不能单独成一张验证命令是它自身的工单（REL3 的 W-581 因此被机器退回过，协调者自己改成静态检查才解开）。契约里写成「执行者先跑一次确认红，作为证据提交，再改代码」，由同一张或最后一张带全量验证的工单收口。
   - 新代码守工程规范（`engineering-standards.md`）；数值目标写成建议值，写明「什么情况下算收尾」。
3. 写进方案文件（`missions/PLAN-*.json`，本地文件、不进 git）：why、acceptance、constraints、nonGoals、allowedScope（到目录级，全量测试命令里的路径要被范围覆盖）；会触发分类器禁止副作用的措辞（删、迁移、真实外部调用）配上副作用声明。
4. 开跑前把票单给用户确认。

## 2. 开跑

1. 只读检查：旧的 `node src/run-plan.ts … --check` 已于 2026-10-24 随 run-plan 入口移除；开跑前只用 v5 L3 插件与 HTTP 只读接口查看。
2. 常驻服务：`node src/main.ts`（端口 3101）；平台代码有新合入就先重启（见第 4 节）。Windows 使用现有隐藏 VBS 包装器经 `explorer.exe` 启动 cmd，包装器采用窗口样式 0，避免弹出终端；不用 WMI 或 Start-Process。启动前核实持锁进程退出、端口空闲，显式设置原 `COAGENT_STATE`、工作目录及日志；不得重复启动。已核实的包装器是维护者本机的隐藏启动 VBS（副本在其 L3 工具包的 ops/ 里）；路径失效时先核实既有启动器，不盲目替换状态路径。不是维护者的部署，直接用 `node scripts/coagent.mjs start` 即可。派发设置 `COAGENT_AGENT_ENV_PASSTHROUGH=-`；本会话不使用定时任务。
3. 新票通过新版 CoAgentHub v5 L3 插件开跑（0.2.2，2026-10-04）：先 `coagenthub_get_platform_status` 核实服务持锁身份、当前占用；冻结完整 Contract 后 `coagenthub_create_mission`，Delivery recipient 使用当前真实 Codex root 会话；再 `coagenthub_start_mission`，指定独立集成 worktree、已验收的 adapter 路径和 maxRounds。启动不直读状态文件，不另起 CLI 写者或终端，环境透传声明固定为 `-`。生产 run-plan 已退役，不对历史 PlanRun 原样续跑。
   - 插件 accepted 只是 HTTP 请求受理；`coagenthub_get_hosted_run` 的 running 表示平台启动输出已确认，ended 提供退出码；Mission 完成以权威视图和交卷证据为准。断流或插件重启后观测为 unknown，先查 Mission/activity 和真实运行者，禁止盲目重试。当前插件同实例抑制重复启动，不承诺跨实例分布式去重。
   - 恢复暂停只清 paused，不负责启动；挂起先走 resume_parked 的目标同步。已有 Mission 的启动读取当前权威 Contract，不用旧本地规格覆盖。历史 origin 不决定承载通路：先核实真实 PlanRun 已停止还是仍运行。
   - 轮次按预计工作量配置，最多100；触顶仍在推进时核实原因再续跑同一 Mission，不能默认新建重跑。互不依赖票可同批验证，改平台源码只在无运行 agent 的空档重启一次；依赖新行为的下一批在服务加载后开跑。
   - `coagenthub_start_mission` 的 adapter 参数是入口文件 `.../coagent-pi/.../src/agent-entry.ts`，不是目录（传目录会让首跳 ERR_UNSUPPORTED_DIR_IMPORT，首选候选被熔断 5 分钟）；命令行里直接写 Windows 反斜杠会被吞，用 node 把参数写成 JSON 文件再传。托管运行在 Mission 等 L3（升级、待终审）或 hop 退避时就退出；答复升级、发契约修订（待终审时 `revise_contract` 会把 Mission 退回规划）之后要重新 start_mission 才继续，答复后等约 20 秒再续。同时跑的 Mission 不超过两条：并行会抬高全量测试偶发率（Windows 子进程 0xC0000142、FileAgentPoolRepository 两个实例交替追加丢行），红了先隔离复跑再下结论。
   - 候选顺序以平台当前角色配置为权威，每次派发读取；start_mission 的 coordinator/executor 参数只作兼容校验，不覆盖当前配置。提示词及适配器更新安排在 Mission 空档。
4. `adapters/pi`（pi 适配器）2026-10-09 起并入本仓，它的 Mission 与平台的 Mission 走**同一个项目、同一个集成分支**，不再有独立的 coagent-pi 状态和值守脚本。适配器按每次派发现读，合入集成分支后下一次派发就生效：改协调者 / 执行者提示词或简报的票放到 Mission 之间跑。适配层的依赖经根 `package.json` 的 npm workspaces 装在根 `node_modules`，Mission 的 worktree 沿父目录能解析到；适配层的测试文件叫 `*.spec.ts`（根目录的 `node --test` 会捡走任何位置的 `*.test.ts`），验证命令写 `["node","--import","tsx","--test","adapters/pi/src/*.spec.ts"]`。此前 coagent-pi 是独立仓库，其历史 Mission 仍留在状态里。

## 3. 值守

1. 挂守候脚本：`node scripts/coagent.mjs watch <missionId>`（走 HTTP 读，退出即唤醒）；有升级单、合入、挂起、超限（单票 $10、15 个工作项、单项执行 4 次）或运行结束就醒。答复升级后等 20 秒再挂，避开答复还没生效的空档。
2. 服务开着时看进度只用 HTTP：`/api/missions/<id>`、`/api/missions/<id>/activity`、`/api/missions/<id>/attempts/<attemptId>`、`/api/plan-runs`、`/api/pools`。不跑 `l3 show` / `l3 plan`。
3. 升级单：
   - 协调者问「已验收的项要补做 / 作废的项怎么办」：不再属于升级范围（ADR-0007 补充，2026-10-07），答复引用那一条并让它直接新建引用原 id 的补修单；执行者被杀（墙钟强杀）或平台放弃重跑（无结果到顶、候选排除耗尽）后工作项卡在 dispatched 的：COM12 上线后平台自己把它收成 blocked（事件 `work_item.platform_blocked`，只 Standard、只执行者跳），协调者修订同一张单再派发，不用作废重建；上线前只能由我作废并另建（作废只当「不用做了」用，不是重启办法）。
   - 协调者问契约问题——先核实；票有缺口就 `l3 revise` 发新契约，再 `l3 plan decide <E-n> --action answer`；答复写清做法，不只说「同意」。
   - （停机原因 `retry_backoff` / `checkpoint_failed` / `model_unavailable` 见文末「2026-10-13 补充」，不要再按 project_busy 处理。）
   - 平台停在 project_busy / no_available_agent / runaway_suspected 且只给「隔离重跑 / 跳过 / 重划 / 停」——选「停」（reviewer_stop），必要时 `l3 pause` 该 Mission、`l3 retire` 卡死的工作项并写明原因，再开跑，平台续跑同一 Mission（PLAT2 / PLAT5）。
   - 不在方案运行里的 Mission：`l3 answer`，答完重跑 `run-mission`。
4. 到线（15 个工作项、单项 4 次）时看原因：在推进就放开那一条线继续，在空转就作废、改票或停。
5. runaway 的恢复：先核实真实承载者是 PlanRun 还是 run-mission，不凭历史 origin 选决策口。暂停 Mission，查实际尝试及租约；作废卡住的工单并保留成果，按调用点或用例组重划，写明真实接口、fixture、定向命令与交卷条件。确认旧执行者退出且租约不再有效后才恢复同一 Mission；原样重派不算恢复。技术拆单由 L3 判断，需求变更或超预算交用户。检查点误答使用显式 `checkpoint approve`，必须带真实 reviewer/reason，费用门禁不变；不编辑状态文件。
6. 为止损往启动脚本里加环境变量之前，先想它会进哪里：服务拉起的所有子进程都继承，包括平台的校验命令。10-07 为止损设的 `COAGENT_TENROUTER_URL=http://127.0.0.1:9`（让适配器查不到额度、平台当未知放行）使 pi 的 `usage.test.ts` 断言「默认地址」的既有测试在平台校验里红了（VR-228；执行者自己复现，并把那条测试改成不读宿主环境）。先 grep 测试里读该变量的地方；止损用完立刻删，修复合入后重启生效。
7. 复位候选熔断：quota 类熔断由适配器的用量行触发，用量解析改好之后旧熔断不会自己解开，要先用真实数据核对修复、再复位。插件没有复位工具；v5 自带的 reviewer MCP 在 L3MCP1（10-08）之后有 `coagenthub_candidate_reset`，合 master 并重启服务后才可用：经 reviewer MCP（`node scripts/reviewer-mcp.ts`）调用 `coagenthub_candidate_reset '{"profileId":"…","reviewer":"…","reason":"…"}'`，reviewer 署名会前缀进审计里的 reason（生产里审计的 actor 恒为 operator），一次只复位一个已核实的候选。在它可用之前只能 `node src/l3.ts candidate reset <profileId> --reason "…"`（经本机回环转给持锁服务，违反「平台操作只经插件」的约定），那样每次先问用户；10-07 用户一次性同意复位 3 条协调者候补（coordinator-tr-ds-v4-pro / glm53 / kimi-k3），10-08 已复位。
8. 常驻服务是用户会话里的控制台进程：用户关机、注销、睡眠（哪怕关机被别的应用否决后改成睡眠）都会把它杀掉，而且不留崩溃记录。10-08 02:53 用户点了关机，微信否决后系统转入睡眠又恢复，服务当时就没了（心跳停在 02:53:18，`service.err` 无记录，系统事件里是 Kernel-Power 42 / 107 与 User32 1074）；待终审的交卷在状态里没丢，12:52 重启即恢复。长时间等待（待终审、等用户）后每次醒来先核 3101 监听与 `holder.json` 心跳，别只信托管运行的退出码；重启按「2026-10-06 补充」的做法。RESUME2（10-15，合 master 并重启后生效）之后，服务启动会自动请求续跑被杀时在跑的托管 Mission（`mission.resume_requested`，cause `service_interrupted`），不必再手动 start_mission，只要看 `GET /api/missions/<id>` 的 `runner.running` 变 true；`COAGENT_RESUME_INTERRUPTED=0` 可关。10-14 22:13 重启电脑杀掉 RESUME2 自己的 W-684 执行者那次还没有这条，当时手动 start 的。

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
   主工作区本身检出的就是 master 时（同一分支不能在两个 worktree 检出），直接在主工作区 `git merge --no-ff <集成分支>`，同样核对 diff 为空、工作区干净。前置验证要绑定集成分支当前 HEAD：之后哪怕只有文档提交，也要重跑平台全量（有测试读 `.coagent/project.md`）；用零代码验证 Mission 跑，它没有改动，收尾不产生新提交（2026-10-07 的 MASTER-PRECHECK）。没有 Mission 在跑、机器空闲时，也可以由检视者直接在集成 worktree 的该 HEAD 上跑一次全量 `node --test`（2026-10-08 合 da4ab5d 就是这样：145 秒、一次绿；偶发红整轮复跑），把结果行写进简报和合并提交说明。
   合完在没有在跑的 agent 时重启服务加载新代码：核实持锁 pid 与 3101 监听者一致后 `taskkill /F /T /PID`，等心跳超过 120 秒，再用隐藏启动脚本起服务，平台自动接管并写审计；起来后用一个已有 Mission 的 HTTP 视图确认新行为生效。
4. 推送到远端（GitHub）是对外操作，必须用户明确说「推」，合入 master 与推送是两件事。合入记录：fb14039（09-30）、83d5877（10-02）、80d098b（10-07，COM1–COM5，用户「先合主干」）、630656d（10-07 夜，COM6–COM11 与 PERF1，用户「合」）、da4ab5d（10-08，COM9 / COM10 / COM12，用户「按现在的执行池，合master」）、f6cddd2（10-09，REL1 / REL2 与发布整理，用户「合并 master 并推送」；这是**首次公开发布**：`git push --force-with-lease=main:<远端旧 tip> origin master:main`，用 v5 整个替换了 GitHub 上 v4 的 main，旧 tip cb511326 不再可达）。
   推送后看 CI：Actions 页面匿名看不到日志（「Sign in to view logs」），用已登录的 `gh` 只读下载：`gh api repos/<owner>/<repo>/actions/jobs/<jobId>/logs`（jobId 来自 `gh api repos/<owner>/<repo>/actions/runs/<runId>/jobs`）。首轮 CI（ci #1）三平台全红，原因是运行机的临时目录是别名路径，修复见 REL3（合入集成分支 c93dafb）；本机复现方法见 §1 路径别名那条。Windows 是必过项，Linux / macOS 在 `ci.yml` 里标 `continue-on-error`。
5. 〔历史，2026-10-09 之前〕coagent-pi 曾是独立仓库，它的 master 合入流程与本节相同；并入 `adapters/pi` 之后没有这一步。

## 7. 停服务与清锁

1. 停之前确认没有在跑的 agent（查 node 进程命令行里的 agent-entry / run-plan / run-mission）。
2. 先暂停仍在运行的 Mission，再使用 PowerShell 的 `taskkill /F /T /PID <已核实的持锁 pid>`，`/T` 同时停止 agent 子进程。不得凭旧交接里的 PID 杀进程。
3. 核实持锁进程已不存在、端口 3101 没人监听。PLAT5 之后，进程已死、心跳超过 120 秒、端口空闲三条件都满足时平台会自动接管，优先采用该通路。若确需手动删除残锁，先核实绝对路径、锁持有者和三条件；工具自动审批拒绝时报告具体原因，不换工具绕过。绝不直接编辑状态文件。

## 8. 换模型

1. 用户指定模型（UI1 之前由检视者代改）：在 pi 的模型清单里确认提供方与型号（`pi --list-models <词>`）。
2. 经适配器实测一次（query 角色读一个文件，确认工具调用正常）。
3. 三种执行角色的配置后端：先读 `GET /api/pools/config`，保留 revision，再经 `POST /api/pools/<role>/configure` 提交完整有序列表。可编辑模型与思考 facts、停用、排序、删除；旧版本拒绝，失败不部分落库。原 `POST /api/pools` 追加入口保留兼容。网页编辑入口仍待前端设计。
4. 不再通过启动脚本改候选。启动只读配置，不为空池播种；旧 `--coordinator` / `--executor` 参数只做兼容校验，不覆盖实际调度顺序。下一跳重新读取当前启用列表，在途 attempt 保留启动身份。分类用只读角色池尚待独立接线，不能把本阶段标作完整 UI1。
5. 加候选或换通道前先确认它看得见系统提示：把一个假工单号只放进系统提示问一遍（工具包 `ops/system-prompt-canary.mts`）。10-14 实测 10Router 的 qdc / qd（Qoder）与 cbai（CodeBuddy 国际）通道不把客户端系统提示交给模型（cbai 是 10Router 代码写死丢弃，Qoder 是服务端不交给模型，qd 被限流未能实测），cbcn、xai、openai-codex 看得见。适配层按候选 facts 的 `prompt_channel`（缺省按 tenrouter 的 qdc/、qd/、cbai/ 前缀判 user）把角色规则与简报放进一条用户消息（`specs/prompt-channel.md`）；加了新通道或改了判定后，用工具包 `ops/prompt-channel-e2e.mts` 对真实模型再验一遍，不要只信单测。

## 9. 检视者值守与统一待办（2026-10-03 后端）

新接口见 `docs/http-api.md`。先读取 `/api/reviewer/todos` 权威投影，再读 Mission/PlanRun 详情和证据；列表不会消费 Delivery。确认通知仅停止重复提醒，不能代替升级答案、检查点签名或交卷审查；等用户会 park，恢复仍走 parked-resume。

值守通过 `/api/projects/:id/reviewer-duty` claim 领取五分钟租约，每分钟 renew。handoff 递增代次，旧会话不能续约或守候；L3 写操作须携带真实 owner 与 generation。值守不是鉴权，D1d 仍暂缓。显式守候脚本 `node scripts/reviewer-watch.ts <projectId> <会话ID>` 只打印变化；不创建定时任务，本会话按用户要求不启动守候。

可选 `node scripts/reviewer-mcp.ts` 提供十三个工作流工具（含 L3MCP1 的候选熔断复位 `coagenthub_candidate_reset`，以及 10-13 可靠性加固的工单状态恢复 `coagenthub_work_item_recover`、Mission 模型约束 `coagenthub_model_policy_set`），仍通过本机 HTTP 调用，不直接读写状态。现有 L3 插件保持不变，Delivery 仍由原桥接投递；MCP 握手不代表实际 Delivery 已送达。PlanRun decide 必须确认当前服务确实承载该 run；历史 origin 或仅有记录不能作为依据。

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
- 执行者自己跑全量会和平台 VR 抢同一批全机共用资源，制造 DUPLICATE_ID 之类的假红；看到红就交 partial 时平台又不跑 VR，会原地打转（B3 的 W-487）。验证单的 requiredBehaviour 要写死「只跑一次定向、交证据、立即交 completed」。
- pi 协调者还没有读取完整 VR 的工具，每张单验收前都会升级来要全文。L3 按「报告原文 + 来源事件 + Git 关联 + HAOFF1 静态 skip 核对」答复，然后续跑；要等 pi A2 注册、集成代码部署到服务以后，这一来一回才会消失。
- 2026-10-07 夜：PI-COM1（pi 协调者注册 `coagent_get_validation_report`、契约核对 issues 后不再手动升级、usage 命令报 10Router 各上游额度、`appendXaiQuotaReset` 只认 xAI 行）已在 pi 集成分支的 Mission 里验收完毕，等 master 合入 PERF1 并重启之后再合；合入后协调者可以自读完整 VR，上一条说的那一来一回才真正消失。

## 2026-10-13 补充（可靠性加固，案例 MiRing-V0-probe 暴露）

- **这批是直接实施的一次性例外**：用户 10-13 明确同意「这次例外，把剩下的做完然后合并」，由检视者在隔离 worktree 里实现，没有走 Mission、没有平台出的验证报告，只有本机全量 `node --test` 与自检审查。第 0 节的划线不因此改变：以后同类改动照样开 Mission。
- **新的停机原因，处置各不相同**（`GET /api/missions/:id` 的 `waitInfo` 给出谁处理、会不会自动恢复、下次重试、有没有活动 Agent、下一步；`runner.running` 是服务进程里托管运行是否真在跑——「HTTP 受理」「runner 在跑」「在等」「完成」是四件事）：
  - `retry_backoff`：某一跳失败后在退避，**不是故障也不是名额被占**。`waitResumeAt` 到点由服务自动接着跑（`RetryWakeScheduler`，重启后也会）；`runner.running=false` 是正常的，不要因此手动 start。想关掉整个自动恢复：服务环境变量 `COAGENT_AUTO_RESUME=0`。旧代码留下的退避 Mission 没有 `waitResumeAt` 与托管启动参数，需要手动 start 一次，之后才进入自动恢复。
  - `checkpoint_failed`：GATE1（2026-10-14）起只留给 git 本身出错、范围为空、范围写法无法确定这类真故障；范围外的脏文件不再让检查点失败（见下面「验证与工作区」）。遇到时看事件 `workspace.checkpoint_failed` 的原因，修好再 start。
  - `model_unavailable`：Mission 用 `model-policy` 指定了模型（`required`），而匹配的候选现在都不可用。平台**绝不改派别的模型**；有明确冷却到期时刻就自动重试，没有就要人修候选、调资源池，或改约束。契约正文里写的模型名只是叙述，不是约束（用户后来改授权时，旧限制留在历史里不再生效）。
- **状态恢复**：工单「已有执行结果、停在 dispatched、没有活执行者」（案例的 W-621）——编排器在叫协调者前自动收成 blocked（只认可证明的机器续派残留）；自动判不了的由 `coagenthub_work_item_recover`（署名与理由必填，幂等，有活执行者或租约时拒绝）。Mission 不在 executing 时机器不再续派。
- **验证与工作区**（GATE1，2026-10-14）：检查点、验证后收口、开跑前核对都只提交授权范围内的改动；范围外的脏文件、杂文件（`__pycache__`、`.pyc`、`.DS_Store` 等）移出工作树存档到 `.coagent-worktrees/.scope-archive/<missionId>/<workItemId>/`——已跟踪文件存补丁后还原，未跟踪文件原样移走——不提交、不删除、不停机，记事件 `workspace.scope_archived`（路径、来源、存档位置），协调者下一跳简报里能看到。要找回：补丁用 `git apply`，未跟踪文件从存档目录拷回。被 .gitignore 忽略的未跟踪文件（例如签名私钥）不在 git status 里，不会被移动，也不会被提交。验证子进程带 `PYTHONDONTWRITEBYTECODE=1`。
- **工单范围**（GATE1，2026-10-14）：Standard 工单的 `allowedScope` 与 `validation.forbiddenPaths` 可写相对仓库根的精确文件，或以 `/` 结尾的目录（目录下新增、修改、删除都算授权）；通配符、绝对 / 盘符路径、`..`、空段在建单、修订、派发时被 `WORK_ORDER_SCOPE_INVALID` 拒绝并给出改法。Standard 的 diff-size 超限只提醒（报告里 `diff-size advisory:`），`maxChangedFiles: 0` 的零代码验证单仍硬卡。
- **停机自动恢复（RESUME1，2026-10-14，合 master 并重启后生效）**：执行者死信（`attempt_limit_reached`）与执行者打转（`runaway_suspected`）不再等人，服务续跑前先把工作项收成 blocked、写 `mission.coordinator_handoff` 交回协调者；**这类停机不要手动 start**，手动开跑会跳过这步收尾，可能再停一次。额度用完先换候选，都不可用就等已知重置时刻；`platform_unreachable` 按约 1、5、15 分钟自动重试，连续第 4 次才等人；`project_busy` 名额释放后自动续派。L3 答复升级、修订契约、加预算、批准检查点、恢复工作项之后，托管启动过的 Mission 由服务自动接着跑，不必再 start_mission（上文第 2 节「答复后要重新 start」那条到此作废）。仍要人的：真需要判断的升级、费用上限、15 项检查点、检查点真故障、取消、终审合入。
- **断网与启动续跑（RESUME2，2026-10-15，合 master 并重启后生效）**：多家候选连续出现断网类失败（fetch failed / Request timed out / 连不上 / 静默 0 token 被杀）时，不再逐个换候选冻结、也不再进死信：这一跳释放租约，`no_available_agent` + `waitResumeAt`，按约 1、5、15 分钟自动重试，第 5 次才 `attempt_limit_reached` 等人（`waitDetail` 以「上游网络中断」开头，不要当成票的问题去拆单）。半开探测名额被占却无人结算的候选（以前要靠人发现再 `candidate_reset`），连续 2 分钟没有活租约会自动 reset（审计 actor `platform:probe-reclaim`）。
- **池健康有缓存（POOLS1，2026-10-15，合 master 并重启后生效）**：`GET /api/pools` 以前每次都重扫全部历史，单次 1.1–1.4 秒同步 CPU、期间整个服务不响应（网页总览页每 5 秒拉一次，所以开着页面服务就常被卡住）。现在服务装配为 15 秒缓存 + 并发合并，扫描每个 Mission 让出一次事件循环。**我自己写池 / 复位熔断（走 HTTP）后缓存立刻失效，读到的是新值；但编排器自己开熔断不经 HTTP 写路由，最多滞后 15 秒，想立刻看就加 `?fresh=1`**（rmcp / mcp 的池查询工具没有这个参数时，直接 `curl 'http://127.0.0.1:3101/api/pools?fresh=1'`）。缓存关闭是 `createApi` 的缺省，所以直接起 API 的测试不受影响。
- **部署**：合 master 之后服务仍是旧代码，要重启才加载（静态网页文件按磁盘现读，新网页对老接口向后兼容）。重启前提不变——没有在跑的 agent（第 7 节）；合并本身不重启、不推送。
