# 方案运行（PlanRun）：无人值守驱动、升级握手与停止条件

按一份方案（`missions/PLAN-*.json`）无人值守地逐个推进功能点。`node src/run-plan.ts` 是驱动方（睡前启动）；方案这一层的事实——哪个功能走到哪、夜里升级了什么、检视者怎么定的、为什么停——记在一份**独立的方案运行记录**里。它与 Mission 并列，不在 Mission 里；与 Mission 内协调者写的 `PlanBody` 无关。

**权限分得很死**：检视者只能在四个动作里选；合进集成分支只凭机器 L3 的确定性证据（见 `machine-final-review`）；high_assurance 合进集成分支永远要人。E4a 让合格 HA 建单并跑到独立检视后的 `pending_release`，然后安全挂起——**本项不开放方案级放行 / approve**。驱动方自己不做判断，只把各方的结论按规则串起来。

## 驱动（run-plan）

- **开跑前，任何副作用之前**：透传名单已声明；方案文件严格可读（缺检视者、缺集成验证、停止条件不是正整数、功能重名、未知或类型错误的 `status` → `PLAN_SPEC_INVALID`；备注类的额外键照留）。**资格筛选**在分类、建 Mission、建运行记录之前完成，按源文件顺序只纳入：无 `status` 的旧写法或显式 `pending`，且有非空的 `why`，且 `allowedScope` / `acceptance` 均为非空字符串列表，且 `dependsOn` 每一项在源方案里明确标 `done`，且未声明 `repo` 或 `repo` resolve 后的绝对路径与 `--cwd` 相同（Windows 上大小写不敏感）。未知依赖、未完成依赖（含 skipped / split / 本次待跑）、split 父项、人工流程中的 planned / implementing / review / rework、非本仓或仓库归属不能确认的条目均不建 Mission。不从 `routing` / `workOrder` / `childrenDone` 决定资格或路由。历史非候选可以缺 `why`、范围和验收（手动流程记下的 done 条目就有缺 `why` 的）；`why` 写了就必须是字符串。项目仓在方案的集成分支上且工作区干净（未跟踪文件也算，被忽略的不算）。拿到主状态锁之后再查一次——锁目录自己也可能落在仓库里。任何一项不过就一个功能都不跑。
- 同样在开跑前：本项目里有没有动过代码、没到终态的 Mission 占着改动名额——上一晚停下时原样留给人的那条就是这种。有就点名它、一个功能都不跑：否则每个功能都会先调查规划一遍再撞上 PROJECT_BUSY。
- 只跑资格筛选后的候选，按方案顺序，同一时刻一个。`done` 不重跑。Mission id 为 `<runId>-<featureId>`，隔离重跑依次 `-r2`、`-r3`；origin 的 clientType 为 `plan-run`。功能点转成契约时，范围写成约束、其余功能点写成非目标、合并归平台。
- **源状态与交接说法**（未知状态整份 `PLAN_SPEC_INVALID`）：`done` 不入选「源方案标 done（已合入）」；`skipped` 不入选「源方案标 skipped；查看 skipReason…」；`split` 父项不入选；`pending` / 无 status 可入选但仍须过范围、验收、仓库、依赖；`planned` / `implementing` / `review` / `rework` 不接管；候选缺 `why`、范围或验收，依赖未明确 done、显式 repo 不是本次 `--cwd` 或无法确认 → 不入选并写明原因。
- **只读检查**：`node src/run-plan.ts --plan <方案文件> --cwd <项目仓> --reviewer <检视者> --check`（`--plan` 是位置参数的别名；旧写法 `node src/run-plan.ts <方案文件> …` 仍可用）。`--check` 必须同时给 `--cwd` 和 `--reviewer`，缺了非零退出。它只做解析 + 资格筛选 + 适用的仓库预检（只读 git），打印入选条目及逐项未纳入原因，并列出三项停止条件与两道夜跑闸的生效值（缺字段标「缺省」）；**不**拿主状态锁、不打开或创建状态文件、不建 PlanRun、不起 HTTP 监听、不建 worktree、不跑分类、不派 agent。有入选条目且预检通过 → 退出 0，并写明未开跑。预检不过 → 非零退出，不把失败说成可以开跑。**没有任何入选条目时退出 0**，并写明「没有可跑的候选」——那是筛选结果不是预检失败，也不跑仓库预检。
- **现做分类**：开跑前用只读 QueryRun（工具表 read / grep / find / ls，由 QueryRunner 强制）读集成分支现状，交回**事实**（不交路由）；`classifyTask` 按事实定路由。Fast Lane 必须附冻结工单，且工单范围落在方案声明内（语义同 validator 的 changed-paths）；分到 Standard 丢掉工单。四类禁止副作用（`productionDeployRelease` / `externalPaidOp` / `destructiveData` / `unrecoverableExternalSideEffect`）任一不是明确 `false`（`true` 或 unknown）→ **不建 Mission**，⏸ 并列明命中字段与要你定什么。四项都是 `false` 的 high_assurance 以**原始** facts、assessment 走 `createClassifiedMission`（不带 Lightweight 工单）；平台拒绝时**不得**回落普通 Standard。判成只读、读不懂、越界、缺工单一律回落 Standard。解析取最后一个 json 块，多键（尤其 route / executionMode）拒绝，评估必须署名 coordinator。每次分类留一条 QueryRun，source 为 `plan-run:<runId>:<featureId>`。
- **每个功能开跑前**：分类出错不拖垮整晚（回落 Standard）；分类本身跑过墙钟就不再建 Mission（功能保持没轮到）；再核一次项目仓——分支被切走或工作区变脏就停在 `unsafe`，不先花一整条 Mission 的钱。
- **落地**：lightweight / standard 交卷了走机器 L3。绿 → ✓。红且已退回、合并失败、编排器的其余结局（卡住 / 等人 / 协调者升级 / blocked）→ 开升级单，失败写明卡在哪，问题带上四个动作。**红且回滚失败、项目仓被切离集成分支、验证绿但目标被推进 / checkout 被切换 → 立刻停在 `unsafe`，不开单**：后一种不得误报成验证红。检视者修不了 git 状态，再往上叠只会越错越多。合格 HA 跑完独立检视、`haReviewHold === pending_release` 时功能 ⏸，`needsDecision` 写明「HA 待放行：需人工决定（E4b 起可在 PlanRun 里放行 / 打回）」并带 Mission id、所审提交、检视结论引用；**不开升级单、不合并、不调任何终审**。E4a 只停在待放行。HA 检视 `fault` 与其它失败进入原故障升级路径，计入 P1 总额。挂起的功能不阻塞后续功能点。
- **等决定**：每 15 秒读一次记录；截止到点判过期；墙钟到点就停。
- **收尾失败的 Mission**：方案还要往下跑 → 方案放弃（放名额、留分支）；方案停了（叫停 / 未解决到顶 / 墙钟 / 升级单到上限）→ 原样留给人，第二天还能看一眼再合；已终结的不重复放弃。
- **墙钟**：开跑前与等决定时都看；在途 Mission 到点即暂停（编排器在下一轮开头停下，不打断正在写的那一跳，所以实际停下会晚最多一跳）；到点后失败的不再开单，直接停、挂起写明要你定什么。
- **崩溃**：记下原因停在 `crashed` 再往外抛，不猜着续跑。
- **被人中断**（Ctrl+C / SIGTERM）：记下原因停在 `crashed`、落盘、放锁再退；在途 Mission 原样留给人。检视者的「停」恰好撞上驱动方判过期，照常停下，不当崩溃。
- **内部入口与旧 CLI 生命周期**：`src/application/plan-runtime.ts` 导出 `runPlanOnPlatform(plan, selection, deps)`，由**调用方已经握着的**平台实例跑一份已筛选方案：内部按原字段建 PlanRun 再 `drivePlan`。它不建第二份平台、不 listen、不拿主状态锁。常驻 `startServer` **不会**自动跑方案，也不因此改生产归属——无人值守驱动仍是 `node src/run-plan.ts`。旧 CLI 只做装配与生命周期：仅用 `selectPlanCandidates` 筛选 → 首次预检（平台 / 记录创建之前）→ 原 file/PG 装配/锁与周期修复 → 锁后二次预检与名额复检 → 回环 API 与 runner → 入口建记录/驱动（建 `MissionRunner({ platform, live, tokens: issuer, baseUrl, workspace, coordinator, executor, independentReviewer })`（独立检视候选取 `independent_reviewer` 池，空池不得用 coordinator 顶替），把绑定的 `run` 交给内部入口，每条 Mission 用 `runner.run` 的 outcome）→ 信号停记与 finally 停周期 / persist / 放锁。主状态只有这一份 file/PG 平台实例，无额外锁与 API。记录改由内部入口创建，CLI 在调用前挂上信号，避免刚落盘就被杀却停在「还在跑」。

## 交接面与检视者（l3 plan）

- `node src/l3.ts plan [--run <记录>]`：一屏看完。不给 `--run` 就取状态文件旁 `.coagent-plans/` 里**最新**的一份（按修改时间；以点开头的临时文件与锁目录不算）。
  - **首行**：运行 id、停止原因与细节（或「还在跑」）、用时（算到停下那一刻）/ 墙钟、总花销（Mission + 现做分类，**没报的单独计数，不当 0**）、未解决 N/上限、升级单已开数/上限——用户拿它校准阈值。有过隔离重跑或正开着升级单的功能，行尾加「重跑 k/M」。该功能重跑额度用完时，`plan decide` 命令模板不再列出 `rerun_isolated`。额度导致停止时写明停止原因、失败的 Mission 和人工下一步，不展示已不可执行的 plan decide 命令。
  - 图例一行，之后每个功能一行，记号：`✓` 已合入 / `⏸` 挂起等你 / `⊘` 检视者跳过 / `○` 没轮到（`▶` 在跑）。同一行只有一个记号。
  - **每个非成功项都写「要你定什么」**：⏸ / ⊘ 照抄记录里的 `needsDecision`；方案停了时 ○ 也写（下一轮接着跑它吗）。已合入的不写。
  - 有开着的升级单时多两行：单号、截止时间、失败；以及给检视者照抄就能用的 `plan decide` 命令（带 `--as <指定检视者>` 与 `--run`）。
  - 开跑时把功能标题抄进记录：早上看不用回头翻方案文件（它到早上可能已经改了）；旧记录缺标题照样读。
  - 运行记录可带可选的 `sourceExclusions`（源方案本次未纳入及原因）。旧记录没有它照常读、照常显示。交接面另列「本次未纳入（源方案，不是本次运行的检视者跳过）」；源 `skipped` 不得伪装成运行中的 ⊘。方案源文件字节不变。
- `node src/l3.ts plan decide <E-n> --action <rerun_isolated|skip|rescope|stop> --reason "…" [--drop F7,F8] --as <检视者>`：写回决定，规则全在 `PlanRun.choose`（方法不叫 decide：`src/` 里的 `.decide(` 是 Decision provider 的接线，由 ADR-0002 的边界守卫盯着，撞名会让守卫要么误报、要么被迫放宽）。必须 `--as`（不写你是谁就核对不了指定检视者）；只有给了 `--drop` 才带删除名单。规则拒绝的非零退出并说清原因，记录一字不动。
- 两条命令**都不拿主状态锁、不写主状态文件、不做启动收敛**（run-plan 整夜握着主状态锁在写；见 `startup-reconciliation`）。
- run-plan 结束时打印的是同一张交接面（不含花销）。

## 记录与握手

- **记录位置**：一份独立 JSON 文件（路径由驱动方定），**不在主状态文件里**。驱动方跑 Mission 时整夜握着主状态的单写者锁；检视者写回决定只碰这份文件，不需要那把锁。
- **读不加锁**：写入一律「临时文件 + rename」，读到的永远是某次完整写出的内容。读不懂（非 JSON、版本不认识、字段缺失或越界、动作不在闭集里）→ `PLAN_RUN_CORRUPT`，不静默重置、不猜。
- **写 = 锁内读-改-写**：先拿短锁、再读最新、改、写、放锁。锁被别的进程拿着时等（缺省 10 秒）；等不到 → `LockBusyError`，**一个字都不写**。规则拒绝的改动不落盘。同一路径已有记录时拒绝再建（`PLAN_RUN_EXISTS`）。
- **开跑参数**：检视者、至少一个功能点（不重名）、三项停止条件都必须给；停止条件必须是正整数——0、缺省、小数都等于没有这道闸（`PLAN_RUN_INVALID`）。方案文件 `stopConditions` 可选 `maxEscalations`（一次运行最多开这么多张升级单，缺省 5）与 `maxRerunsPerFeature`（每个功能最多接受这么多次 `rerun_isolated`，缺省 1）。缺字段照常解析并按缺省计；**出现了就必须是正整数**（0、负数、小数、字符串、null 都拒绝）。方案文件写错 → `PLAN_SPEC_INVALID`；运行记录写错 → `PLAN_RUN_CORRUPT`。`parsePlanSpec`、`PlanRun.start`、`PlanRun.restore` 用同一把尺子校验、同一个函数补缺省；内存与新建快照都带着两个生效值。旧快照缺这两个字段仍可恢复，按缺省计，不重审、不改写已发生的决定或停止原因；恢复后若还在跑，新动作受生效上限约束。
- **功能点**：同一时刻只跑一个（`PLAN_FEATURE_BUSY`）；只有待跑的能开跑；隔离重跑时 Mission 记录累加。状态与交接面记号：`merged ✓` / `suspended ⏸` / `skipped ⊘` / `pending ○`（`running` 只在跑着时出现）。**进 ⏸ / ⊘ 的每条路径都必须带 `needsDecision`（要人定什么）**，不经升级直接挂起时不给就拒绝（`NEEDS_DECISION_REQUIRED`）。
- **开升级单**：只能开给正在跑的功能，同一时刻只开一张（`ESCALATION_ALREADY_OPEN`）；`deadline = openedAt + escalationTimeoutMs`。等着决定的功能不能被合入或挂起。计数 = 本次运行已开的全部升级单（尚未决定、已决定、已过期都算），不从源方案状态或 Mission id 猜。已开满 `maxEscalations` 张后再有功能失败时**不开单**，同一次写入里把该功能挂起（`needsDecision` 写明这次失败、失败的 Mission id、要人定什么）并以 `escalation_limit` 停止；驱动方据此停下，不等待、不放弃失败的 Mission。上限之内开出的升级单照常可决定、可过期。不得先开单再停——否则会留下一张方案已停、没人能定的升级单。这道闸与 `unresolvedEscalations` 独立：后者只数过期；检视者随叫随到时过期到不了阈值，已开张数才是夜里打扰次数的硬顶。
- **检视者写回决定**：
  - 只有本次运行指定的检视者作数（`NOT_DESIGNATED_REVIEWER`）；
  - 动作闭集：`rerun_isolated` / `skip` / `rescope` / `stop`。**没有「通过」也没有「合并」**（`REVIEWER_ACTION_FORBIDDEN`）——放行只凭合并后的集成验证；
  - 必须写理由（`DECISION_REASON_REQUIRED`）；
  - 截止**含本身**之后不再收（`ESCALATION_DEADLINE_PASSED`）；已了结的单子不再收（`ESCALATION_ALREADY_RESOLVED`）；方案停了什么都不收（`PLAN_RUN_STOPPED`）。
- **四个动作的效果**：`skip` → 当前功能 ⊘；`rescope` → 当前功能 ⊘，并删掉点名的**还没轮到**的功能（⊘，写明依赖谁）——只能删，不能加或改写工作，名单为空、重复、点到非待跑的功能都拒绝；只有 `rescope` 能带名单，别的动作夹带名单被拒而不是悄悄忽略（`RESCOPE_TARGET_INVALID`）；`stop` → 方案停在 `reviewer_stop`，当前功能 ⏸；`rerun_isolated` → 当前功能退回待跑，下一个该跑的还是它。每功能首次 Mission 不计重跑；已接受 `maxRerunsPerFeature` 次 `rerun_isolated` 后再选该动作 → `RERUN_LIMIT_REACHED`（消息含功能 id、已用数、上限，并提示改选 skip / rescope / stop），记录不变。这条检查在截止、检视者身份、动作合法、理由之后。同一张升级单仍可在截止前改选 skip / rescope / stop，不自动替检视者改选。
- **判过期**：截止（含）之后才能判，之前判 → `ESCALATION_NOT_DUE`。判过期 = 记一次未解决 + 当前功能 ⏸（`needsDecision` 原样带上当时问检视者的那件事）。**未解决累计到阈值（≥，不是 >）在同一次写里停**，原因 `unresolved_escalations`。
- **决定与过期撞在一起**：锁让两边排队，后到的那个被 `ESCALATION_ALREADY_RESOLVED` 明确拒绝，不会两边各以为自己赢了。
- **墙钟**：`checkStop(now)` 到点（含）停在 `wall_clock`，跑着的功能 ⏸。先到者停，停了不改原因。
- **驱动方主动停**：`halt('unsafe' | 'crashed')`（集成分支不能再往上叠东西 / 驱动方自己出错），跑着的功能 ⏸ 并带上原因；功能都走完了用 `finish`（`finished`，不等于全合了）。

## 非目标

- 不给检视者任何放行或合并权；E4a 单独合并后 HA 仍无方案级 approve 命令。不接 HTTP / agent tools。
- 开跑前按源方案 `dependsOn` 是否明确 `done` 筛选；运行中仍由检视者重划剩余范围。不把 `childrenDone` 等叙述当完成证明，不在运行中改写源方案的 done。
- 不做崩溃后续跑；不做费用上限（首行花销是给人校准阈值用的，不是闸）。
- Postgres 存储下方案运行记录仍是文件。
- 不替 L3 给 pending 条目补范围和验收；不接管 planned / implementing / review / rework。

## 权威源 / 测试

- 源：`src/run-plan.ts`（旧 CLI 接线与生命周期）、`src/application/plan-runtime.ts`（内部可注入入口）、`src/application/mission-runner.ts`（单条 Mission 内部编排）、`src/l3.ts`（`plan` / `plan decide`）、`src/application/plan-handoff.ts`（交接面）、`src/application/plan-driver.ts`（驱动）、`src/application/plan-routing.ts`（现做分类）、`src/application/plan-spec.ts`（方案文件与契约）、`src/application/plan-preflight.ts`（开跑前检查）、`src/application/plan-run.ts`（规则）、`src/application/plan-run-store.ts`（文件存储）、`src/application/lock.ts`（放锁时摘掉 exit 兜底）、`.gitignore`（状态文件旁的运行时产物）
- 测试：`test/plan-run.test.ts`（纯规则，时间外传）、`test/plan-run-store.test.ts`（**真子进程**：`test/helpers/plan-run-probe.ts`）、`test/plan-routing.test.ts`、`test/plan-spec.test.ts`、`test/plan-driver.test.ts`（含内部入口注入）、`test/run-plan-wiring.test.ts`（真平台 + 真 git；CLI 副作用次序与 `--check`）、`test/plan-handoff.test.ts`、`test/l3-plan.test.ts`（**真子进程**跑 l3，含「锁被占着照样能定」「只读不写主状态」）、`test/lock.test.ts`
