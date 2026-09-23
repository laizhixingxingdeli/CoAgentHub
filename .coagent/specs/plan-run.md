# 方案运行（PlanRun）：无人值守驱动、升级握手与停止条件

按一份方案（`missions/PLAN-*.json`）无人值守地逐个推进功能点。`node src/run-plan.ts` 是驱动方（睡前启动）；方案这一层的事实——哪个功能走到哪、夜里升级了什么、检视者怎么定的、为什么停——记在一份**独立的方案运行记录**里。它与 Mission 并列，不在 Mission 里；与 Mission 内协调者写的 `PlanBody` 无关。

**权限分得很死**：检视者只能在四个动作里选；合进集成分支只凭机器 L3 的确定性证据（见 `machine-final-review`）；high_assurance 永远要人。驱动方自己不做判断，只把各方的结论按规则串起来。

## 驱动（run-plan）

- **开跑前，任何副作用之前**：透传名单已声明；方案文件严格可读（缺检视者、缺集成验证、停止条件不是正整数、功能重名、范围或验收为空 → `PLAN_SPEC_INVALID`；备注类的额外键照留）；项目仓在方案的集成分支上且工作区干净（未跟踪文件也算，被忽略的不算）。拿到主状态锁之后再查一次——锁目录自己也可能落在仓库里。任何一项不过就一个功能都不跑。
- 同样在开跑前：本项目里有没有动过代码、没到终态的 Mission 占着改动名额——上一晚停下时原样留给人的那条就是这种。有就点名它、一个功能都不跑：否则每个功能都会先调查规划一遍再撞上 PROJECT_BUSY。
- 只跑方案里没标 `done` 的功能，按方案顺序，同一时刻一个。Mission id 为 `<runId>-<featureId>`，隔离重跑依次 `-r2`、`-r3`；origin 的 clientType 为 `plan-run`。功能点转成契约时，范围写成约束、其余功能点写成非目标、合并归平台。
- **现做分类**：开跑前用只读 QueryRun（工具表 read / grep / find / ls，由 QueryRunner 强制）读集成分支现状，交回**事实**（不交路由）；`classifyTask` 按事实定路由。Fast Lane 必须附冻结工单，且工单范围落在方案声明内（语义同 validator 的 changed-paths）；分到 Standard 丢掉工单；分到 high_assurance **不建 Mission**，直接 ⏸ 写明要你定什么；判成只读、读不懂、越界、缺工单一律回落 Standard。解析取最后一个 json 块，多键（尤其 route / executionMode）拒绝，评估必须署名 coordinator。每次分类留一条 QueryRun，source 为 `plan-run:<runId>:<featureId>`。
- **每个功能开跑前**：分类出错不拖垮整晚（回落 Standard）；分类本身跑过墙钟就不再建 Mission（功能保持没轮到）；再核一次项目仓——分支被切走或工作区变脏就停在 `unsafe`，不先花一整条 Mission 的钱。
- **落地**：交卷了走机器 L3。绿 → ✓。红且已退回、合并失败、编排器的其余结局（卡住 / 等人 / 协调者升级 / blocked）→ 开升级单，失败写明卡在哪，问题带上四个动作。**红且回滚失败、项目仓被切离集成分支 → 立刻停在 `unsafe`，不开单**：检视者修不了 git 状态，再往上叠只会越错越多。
- **等决定**：每 15 秒读一次记录；截止到点判过期；墙钟到点就停。
- **收尾失败的 Mission**：方案还要往下跑 → 方案放弃（放名额、留分支）；方案停了（叫停 / 未解决到顶 / 墙钟）→ 原样留给人，第二天还能看一眼再合；已终结的不重复放弃。
- **墙钟**：开跑前与等决定时都看；在途 Mission 到点即暂停（编排器在下一轮开头停下，不打断正在写的那一跳，所以实际停下会晚最多一跳）；到点后失败的不再开单，直接停、挂起写明要你定什么。
- **崩溃**：记下原因停在 `crashed` 再往外抛，不猜着续跑。
- **被人中断**（Ctrl+C / SIGTERM）：记下原因停在 `crashed`、落盘、放锁再退；在途 Mission 原样留给人。检视者的「停」恰好撞上驱动方判过期，照常停下，不当崩溃。

## 交接面与检视者（l3 plan）

- `node src/l3.ts plan [--run <记录>]`：一屏看完。不给 `--run` 就取状态文件旁 `.coagent-plans/` 里**最新**的一份（按修改时间；以点开头的临时文件与锁目录不算）。
  - **首行**：运行 id、停止原因与细节（或「还在跑」）、用时（算到停下那一刻）/ 墙钟、总花销（Mission + 现做分类，**没报的单独计数，不当 0**）、未解决 N/上限——用户拿它校准阈值。
  - 图例一行，之后每个功能一行，记号：`✓` 已合入 / `⏸` 挂起等你 / `⊘` 检视者跳过 / `○` 没轮到（`▶` 在跑）。同一行只有一个记号。
  - **每个非成功项都写「要你定什么」**：⏸ / ⊘ 照抄记录里的 `needsDecision`；方案停了时 ○ 也写（下一轮接着跑它吗）。已合入的不写。
  - 有开着的升级单时多两行：单号、截止时间、失败；以及给检视者照抄就能用的 `plan decide` 命令（带 `--as <指定检视者>` 与 `--run`）。
  - 开跑时把功能标题抄进记录：早上看不用回头翻方案文件（它到早上可能已经改了）；旧记录缺标题照样读。
- `node src/l3.ts plan decide <E-n> --action <rerun_isolated|skip|rescope|stop> --reason "…" [--drop F7,F8] --as <检视者>`：写回决定，规则全在 `PlanRun.choose`（方法不叫 decide：`src/` 里的 `.decide(` 是 Decision provider 的接线，由 ADR-0002 的边界守卫盯着，撞名会让守卫要么误报、要么被迫放宽）。必须 `--as`（不写你是谁就核对不了指定检视者）；只有给了 `--drop` 才带删除名单。规则拒绝的非零退出并说清原因，记录一字不动。
- 两条命令**都不拿主状态锁、不写主状态文件、不做启动收敛**（run-plan 整夜握着主状态锁在写；见 `startup-reconciliation`）。
- run-plan 结束时打印的是同一张交接面（不含花销）。

## 记录与握手

- **记录位置**：一份独立 JSON 文件（路径由驱动方定），**不在主状态文件里**。驱动方跑 Mission 时整夜握着主状态的单写者锁；检视者写回决定只碰这份文件，不需要那把锁。
- **读不加锁**：写入一律「临时文件 + rename」，读到的永远是某次完整写出的内容。读不懂（非 JSON、版本不认识、字段缺失或越界、动作不在闭集里）→ `PLAN_RUN_CORRUPT`，不静默重置、不猜。
- **写 = 锁内读-改-写**：先拿短锁、再读最新、改、写、放锁。锁被别的进程拿着时等（缺省 10 秒）；等不到 → `LockBusyError`，**一个字都不写**。规则拒绝的改动不落盘。同一路径已有记录时拒绝再建（`PLAN_RUN_EXISTS`）。
- **开跑参数**：检视者、至少一个功能点（不重名）、三项停止条件都必须给；停止条件必须是正整数——0、缺省、小数都等于没有这道闸（`PLAN_RUN_INVALID`）。
- **功能点**：同一时刻只跑一个（`PLAN_FEATURE_BUSY`）；只有待跑的能开跑；隔离重跑时 Mission 记录累加。状态与交接面记号：`merged ✓` / `suspended ⏸` / `skipped ⊘` / `pending ○`（`running` 只在跑着时出现）。**进 ⏸ / ⊘ 的每条路径都必须带 `needsDecision`（要人定什么）**，不经升级直接挂起时不给就拒绝（`NEEDS_DECISION_REQUIRED`）。
- **开升级单**：只能开给正在跑的功能，同一时刻只开一张（`ESCALATION_ALREADY_OPEN`）；`deadline = openedAt + escalationTimeoutMs`。等着决定的功能不能被合入或挂起。
- **检视者写回决定**：
  - 只有本次运行指定的检视者作数（`NOT_DESIGNATED_REVIEWER`）；
  - 动作闭集：`rerun_isolated` / `skip` / `rescope` / `stop`。**没有「通过」也没有「合并」**（`REVIEWER_ACTION_FORBIDDEN`）——放行只凭合并后的集成验证；
  - 必须写理由（`DECISION_REASON_REQUIRED`）；
  - 截止**含本身**之后不再收（`ESCALATION_DEADLINE_PASSED`）；已了结的单子不再收（`ESCALATION_ALREADY_RESOLVED`）；方案停了什么都不收（`PLAN_RUN_STOPPED`）。
- **四个动作的效果**：`skip` → 当前功能 ⊘；`rescope` → 当前功能 ⊘，并删掉点名的**还没轮到**的功能（⊘，写明依赖谁）——只能删，不能加或改写工作，名单为空、重复、点到非待跑的功能都拒绝；只有 `rescope` 能带名单，别的动作夹带名单被拒而不是悄悄忽略（`RESCOPE_TARGET_INVALID`）；`stop` → 方案停在 `reviewer_stop`，当前功能 ⏸；`rerun_isolated` → 当前功能退回待跑，下一个该跑的还是它。
- **判过期**：截止（含）之后才能判，之前判 → `ESCALATION_NOT_DUE`。判过期 = 记一次未解决 + 当前功能 ⏸（`needsDecision` 原样带上当时问检视者的那件事）。**未解决累计到阈值（≥，不是 >）在同一次写里停**，原因 `unresolved_escalations`。
- **决定与过期撞在一起**：锁让两边排队，后到的那个被 `ESCALATION_ALREADY_RESOLVED` 明确拒绝，不会两边各以为自己赢了。
- **墙钟**：`checkStop(now)` 到点（含）停在 `wall_clock`，跑着的功能 ⏸。先到者停，停了不改原因。
- **驱动方主动停**：`halt('unsafe' | 'crashed')`（集成分支不能再往上叠东西 / 驱动方自己出错），跑着的功能 ⏸ 并带上原因；功能都走完了用 `finish`（`finished`，不等于全合了）。

## 非目标

- 不给检视者任何放行或合并权；不接 HTTP / agent tools。
- 不做依赖声明：依赖由检视者夜里读剩余功能自己判（体现为重划剩余范围）。
- 不做崩溃后续跑；不做费用上限（首行花销是给人校准阈值用的，不是闸）。
- Postgres 存储下方案运行记录仍是文件。

## 权威源 / 测试

- 源：`src/run-plan.ts`（接线）、`src/l3.ts`（`plan` / `plan decide`）、`src/application/plan-handoff.ts`（交接面）、`src/application/plan-driver.ts`（驱动）、`src/application/plan-routing.ts`（现做分类）、`src/application/plan-spec.ts`（方案文件与契约）、`src/application/plan-preflight.ts`（开跑前检查）、`src/application/plan-run.ts`（规则）、`src/application/plan-run-store.ts`（文件存储）、`src/application/lock.ts`（放锁时摘掉 exit 兜底）、`.gitignore`（状态文件旁的运行时产物）
- 测试：`test/plan-run.test.ts`（纯规则，时间外传）、`test/plan-run-store.test.ts`（**真子进程**：`test/helpers/plan-run-probe.ts`）、`test/plan-routing.test.ts`、`test/plan-spec.test.ts`、`test/plan-driver.test.ts`、`test/run-plan-wiring.test.ts`（真平台 + 真 git 跑一份方案）、`test/plan-handoff.test.ts`、`test/l3-plan.test.ts`（**真子进程**跑 l3，含「锁被占着照样能定」「只读不写主状态」）、`test/lock.test.ts`
