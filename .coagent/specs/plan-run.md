# 方案运行（PlanRun）：无人值守驱动、升级握手与停止条件

按 `missions/PLAN-*.json` 的资格候选顺序逐项推进；`node src/run-plan.ts` 驱动，独立 JSON PlanRun 记录方案层状态、升级、决定和停止原因，与 Mission 和 Mission 内 `PlanBody` 并列。普通 Mission 交机器 L3，检视者无「通过/合并」权；普通失败只能选 `rerun_isolated` / `skip` / `rescope` / `stop`。**协调者提问特例**只允许检视者提供文字答复，仍不赋予合并权。HA `approve` / `send-back` 是另一条独立流程；受控放行仍须有效独立 pass、绑定的签名确认和平台现读的外置授权。

## 开跑与筛选

- 副作用之前解析严格方案：检视者、集成验证、正整数停止条件、功能唯一性及合法 status；未知/类型错误为 `PLAN_SPEC_INVALID`，备注键保留。仅筛选无 status 或 `pending`，且非空 why、非空字符串列表 allowedScope/acceptance、依赖在源方案中明确 done、无 repo 或 repo resolve 后等于 --cwd（Windows 不区分大小写）的条目，按源顺序跑。done、skipped、split、planned、implementing、review、rework、非本仓、依赖未明确完成和缺契约者不建 Mission。历史非候选允许缺 why/范围/验收，写了 why 必须是字符串。不用 routing/workOrder/childrenDone 决定资格。项目仓须在集成分支且干净（含未跟踪、忽略项除外）；主状态锁后再检查一次。已有未终态代码 Mission 占改动名额 → PROJECT_BUSY，整晚不跑。
- 仅对已通过原有状态、仓库、契约和依赖资格门的候选做条目契约机器检查，正式开跑与 `--check` 共用 `selectPlanCandidates`。allowedScope 中含以 `.coagent/` 开头的路径或名为 `VIBE.md` 的路径时排除：L1 不得改 Project Truth，规格走交卷 memoryDelta；含绝对路径（盘符或 `/` 开头）或 `..` 路径段时也排除。排除项仍按原格式列在「未纳入」。验收文字中出现以 `src/`、`test/`、`scripts/`、`docs/` 开头的仓内文件路径或根点文件（如 `.gitattributes`），若未被 allowedScope 中的同名文件或以 `/` 结尾的目录覆盖，则产生含条目 id 和路径的警告；行号后缀（如 `:12`）按文件判断，常见句末标点不算路径。`constraints` 和 `nonGoals` 不参与；警告只提示，绝不排除或阻止开跑。入选/未纳入列表后打印全部警告，没有警告时不打印警告段。非候选状态不受新增检查影响。
- `node src/run-plan.ts --plan <方案> --cwd <仓> --reviewer <人> --check`（也接受位置方案路径）只解析、筛选与适用的只读 git 预检，打印入选项、逐项排除理由及生效停止条件/缺省，绝不建运行记录/Mission、拿主状态锁、启动 HTTP/agent。--check 必须有 cwd/reviewer；无候选退出 0 并说明「没有可跑的候选」，不跑仓库预检；有候选且预检通过退出 0、说明未开跑；预检失败非零。
- 对候选先以只读 QueryRun（工具 read/grep/find/ls）采集事实，`classifyTask` 决定路由，source 为 `plan-run:<runId>:<featureId>`。Fast Lane 工单须冻结且范围在方案内，Standard 不带该工单。四类禁止副作用必须各严格为 false，否则不建 Mission、挂起并列命中项；取最后一个可解析 json 对象检查字段，无结构化对象或分类员失败才回退 Standard。HAOFF1 暂将 high_assurance 按普通 Standard 跑，但仍要求四类严格 false；恢复 HA 时须撤掉 decideRoute 的 HA 回落并恢复 HA 分类条件。HA 恢复后以原始 facts/assessment 建 classified Mission、失败不退回普通 Standard。只读、读不懂、越界、缺工单回落 Standard；多 route/executionMode 键拒绝，评估署名 coordinator。分类出错可退 Standard，分类后墙钟过期不建 Mission；开功能前仓库分支/工作区再检查，不安全则停 unsafe。
- 一次只跑一个功能。Mission id `<runId>-<featureId>`，隔离重跑 `-r2` 等，origin clientType=plan-run。功能契约包含范围约束与其余条目的非目标。`done` 不重跑；源状态和不纳入原因在交接面明确标注，源 `skipped` 不冒充本次检视者跳过。

## 驱动、答复与收尾

- Lightweight/Standard 正常交卷经机器 L3，集成验证绿且状态匹配才标 merged。合并失败、验证红且成功回滚、其余可升级失败开普通四动作升级单。回滚失败、集成目标被推进、checkout 离开目标及持久 HA unsafe 停 `unsafe`，不误报为验证红。合入后状态/记录不明也 unsafe；功能与 Mission 绑定不变式错误停 `crashed` 并抛出，绝不猜着续跑。
- **协调者提问**：仅 runMission 返回 `awaiting_l3` 时，驱动为正在 running 的功能和该 missionId 开 `answerable: true` 升级单，question 存原问题 trim 后的 1–4000 字；超长截断并在上限内注明。原问题空白拒开，记录不变。其他失败（轮次上限、合并后验证红、HA 等）均开不可答复单。可答复单仍允许旧四动作或过期：沿用 settle 的失败 Mission 放弃/名额等原语义。若结论是 answer，驱动先检查墙钟，再通过**同一平台方法** `answerEscalation(missionId, answer)` 交给同一 Mission（运行时 adapter 用 persistAfter），不自行写 Mission 答复逻辑，不调用 abandonMissionForPlan，不新建 Mission、不增 rerun 计数；同 missionId 再次 runMission，并重新按 land() 结果合入、提问或升级。再次提问开递增的新可答复单，也计入 maxEscalations；到上限沿用原处理。墙钟已到不执行答复后续跑。
- HAOFF1 当前关闭 HA 路；恢复时 pending_release 只有有效独立 pass 且带报告才立 HA 记录，绑定 PlanRun/feature/Mission/提交/检视 attempt/报告/检视者/目标/验证摘要/截止。缺 pass/报告走普通故障升级。等待期间不跑下一功能。HA 审批到期为 expired，截止前已签 approve 可在审批截止之后消费，但方案墙钟先行。消费前核对 feature running、最后 Mission 与审批 Mission 同一、Mission 非终态且 awaiting_review/high_assurance/pending_release、目标一致，重取独立 pass 核其提交/attempt/报告。只经 finalizeMissionByHaAuthority 显式传方案集成验证，复读平台 completed、finalReview.mergedInto 和目标一致才 merged。send_back/expired/非 unsafe 失效走旧故障路径；HA 记录不计升级单上限，实际升级单才计。
- 等升级/HA 决定每轮先查停止与墙钟，轮询记录缺省 15 秒；升级单截止到点判过期。墙钟到点不执行待处理决定、不补失败升级；在途 Mission 下一跳开头停（至多晚一跳），running 功能挂起。旧 `skip`/`rescope`/`rerun_isolated` 继续前放弃非终态失败 Mission；stop、墙钟、上限或未解决阈值停时保留 Mission。只有接受 rerun_isolated 计重跑。异常记 crashed 并抛出，Ctrl+C/SIGTERM 记 crashed、落盘放锁，在途 Mission 留人接手。
- 内部入口 `runPlanOnPlatform(plan, selection, deps)` 使用调用方已有平台跑筛选方案并建 PlanRun，不建立第二平台/主锁/listen。常驻 startServer 不自动跑方案。旧 CLI 负责筛选、双重预检、file/PG 平台和锁/周期修复、回环 API 与 runner、信号及 finally 清理；同一主状态平台实例，runner.run 提供每个 Mission 的 outcome。

## 交接与决定

- `node src/l3.ts plan [--run <记录>]` 不给记录则选状态旁 `.coagent-plans/` 最近修改的记录（不含临时/锁）。首行列 id、停止原因/细节、用时/墙钟、含分类的花费及未报数、未解决数/上限、升级已开数/上限；重跑功能显示 k/M，额度用完不列 rerun 模板。图例后每功能一行：✓ merged / ⏸ suspended / ⊘ skipped / ○ pending / ▶ running；非成功项给 needsDecision，停止时 pending 也写人工下一步。当前单显示编号、截止、失败与带 `--as`、`--run` 的可复制命令；仅 answerable 单另显示原问题及「答复」命令 `node src/l3.ts plan decide E-n --action answer --answer "…" --as <检视者> --run <记录>`，与原四选项并列；不可答复的单不列答复。HA 单显示绑定信息与 approve/send-back，已决显示签名、确认与摘要。标题开跑时存记录、旧无标题照读；可选 sourceExclusions 标本次未纳入及原因，不冒充运行内 skipped，源方案字节不改。run-plan 结束打印同一交接面（不含花费）。
- `node src/l3.ts plan decide <E-n> --action <rerun_isolated|skip|rescope|stop> --reason "…" [--drop F7,F8] --as <检视者> [--run <记录>]` 的规则统一在 `PlanRun.choose`；只有 rescope 带 drop，四动作都必须非空 reason。另支持上面的 `--action answer --answer "<文本>"`，reason 可省。仅可答复、未过期未决定的单，本次指定检视者可答复；答复 trim 后需 1–4000 字，结论逐字段记 `{ kind:'decided', action:'answer', answer, reason?, decidedBy, decidedAt }`，功能仍 running，重跑数不变。非法单/身份/期限/空白或超长答复、已决定拒绝，退出非 0、记录字节不变。CLI 仅在 FilePlanRunStore.update 的短锁内写独立方案记录，不拿主状态锁、不改主状态、不做启动收敛；普通 `l3 answer` 主状态路径不能在 run-plan 持锁期间替代此命令。HA 签字也只写绑定的决定声明，不直接平台/Git 合并。

## 记录规则与停止条件

- JSON 文件与主状态并列；读无锁，写临时文件+rename，锁内读最新、改、写、放锁，短锁缺省等 10 秒，失败 LockBusyError 不写；同路径已有记录拒建 PLAN_RUN_EXISTS。损坏 JSON、未知版本、越界/字段缺失、非法动作/HA 绑定等一律 PLAN_RUN_CORRUPT，不静默重置。旧记录无 HA 列表、无 answerable 及新字段兼容；含 answer 的记录须有合法答复且单标 answerable、绑定合法 missionId、非空且长度 <=4000 的 question，否则拒读。含 answer 的记录落盘重读逐字段一致。
- 运行须指定检视者、非空不重复功能、三项正整数停止条件；可选 maxEscalations 缺省 5、maxRerunsPerFeature 缺省 1，出现须正整数（0/小数/负值/字符串/null 不合法）。parsePlanSpec/start/restore 同尺校验并补缺省；旧记录缺两项按缺省恢复，不重审旧决定/停止。方案字段错 PLAN_SPEC_INVALID，记录错 PLAN_RUN_CORRUPT。
- 同时仅一个功能 running；只 pending 可启动，隔离重跑累积 Mission id；⏸/⊘ 的每条路径都须 needsDecision。升级仅对 running，至多一张开放，deadline=openedAt+escalationTimeoutMs；等待单时不能合入或挂起。maxEscalations 数已开全部（已决/过期亦算），满时下一次故障不开单而挂起并记失败、Mission、人工问题，以 escalation_limit 停止，失败 Mission 留人。与只数过期的 unresolvedEscalations 阈值独立。
- REVIEWER_ACTIONS 仍仅四个旧动作，没有「通过」「合并」或 answer（answer 是受限分支）。本次 reviewer 才能决定，截止含本身以后拒绝、已决拒绝、停后拒绝。skip → ⊘；rescope → 当前 ⊘ 并删除指定的未轮到功能，名单不得空/重/非 pending，仅此动作可带名单；stop → reviewer_stop + ⏸；rerun_isolated → pending 并待另一 Mission。超每功能重跑额拒绝 RERUN_LIMIT_REACHED，仍可在截止前选另三动作；规则拒绝不落盘。
- 截止含当刻可判过期，之前 ESCALATION_NOT_DUE；过期记未解决并将功能挂起保留人工问题，累计到 unresolvedEscalations 阈值停。决定和过期由同一文件短锁串行，后者报 ESCALATION_ALREADY_RESOLVED。checkStop 到墙钟含当刻停 wall_clock 并挂起 running；halt unsafe/crashed 挂起且记原因；全部结束 finish 记 finished（不保证全部 merged）。

## 非目标与权威源

不接 HTTP/agent tools、不做逐次点击确认、不由 CLI 合并；源 dependsOn 完成性只在筛选判断，运行中重划范围不改源方案；不做崩溃后续跑或费用硬上限；PG 主存储时 PlanRun 仍是文件；不替 L3 补人工 pending 契约，也不接管人工状态；不自动代答。

源：`src/run-plan.ts`、`src/application/plan-runtime.ts`、`src/application/mission-runner.ts`、`src/l3.ts`、`src/application/plan-handoff.ts`、`src/application/plan-driver.ts`、`src/application/plan-routing.ts`、`src/application/plan-spec.ts`、`src/application/plan-preflight.ts`、`src/application/plan-run.ts`、`src/application/plan-run-store.ts`、`src/application/lock.ts`、`.gitignore`。测试：`test/plan-run.test.ts`、`test/plan-run-store.test.ts`（真子进程 `test/helpers/plan-run-probe.ts`）、`test/plan-routing.test.ts`、`test/plan-spec.test.ts`、`test/plan-driver.test.ts`、`test/run-plan-wiring.test.ts`、`test/plan-handoff.test.ts`、`test/l3-plan.test.ts`（真 CLI 子进程）、`test/lock.test.ts`。
