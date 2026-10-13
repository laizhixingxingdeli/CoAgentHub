# 2026-10-13 可靠性加固交付

执行依据：案例 Mission `MiRing-V0-probe-20261012`（项目 minavigate-ring）暴露了七类执行可靠性问题，用户要求基于真实源码、活动记录与验证报告修复并交付；随后明确同意「这次例外，把剩下的做完然后合并」。本批由检视者在隔离 worktree `claude/mission-reliability-20261013`（基于 master `cbc4ce4`）直接实现——**没有走 Mission，没有协调者检视，没有平台出的验证报告**，只有本机全量 `node --test` 与检视者自检审查。这是一次性例外，[检视者手册](../.coagent/architecture/reviewer-runbook.md) 第 0 节的划线不变：以后同类改动照样开 Mission。

案例 Mission 的现场、常驻服务与状态文件、MiNavigateRing 的产品代码都没有碰，也没有替代真机验收；没有推送 GitHub，服务没有重启，仍运行旧代码，要重启才加载（第六节是等授权的部署步骤）。

## 一、根因与修复

| # | 现象与证据 | 根因 | 修在哪（提交） | 验收（用例） |
|---|---|---|---|---|
| 1 | 验证副作用污染后续工单：RPK 构建改写 `docs/rpk-build.md`，W-620 的安装脚本追加 `docs/honor-win-probe.md`，W-621 的检查点因而失败；VR-339 报范围、forbidden、文件数失败 | 验证命令在 Mission 的 worktree 里跑，发生在执行者检查点**之后**，没人收口，也没人说得清脏改动是谁留的；下一张不相关的工单交卷时才被检查点以「越界」拒掉，一跳执行者白跑 | `GitWorktreeManager.settle` 只提交授权范围内的脏路径，范围外原样保留不删不提交；`HopGuards.settleValidationResidue` / `preflightWorkspace`：来源记进事件，下一张工单开跑前对着来源核对，不属于它的改动让工单在**花钱之前**收成 blocked；验证子进程带 `PYTHONDONTWRITEBYTECODE=1`（`577be43`、`c932301`） | `test/workspace-hygiene.test.ts`：真 git worktree 上授权副作用被收口、范围外副作用被保留并点名来源、开跑前拦下、范围内残留并入 |
| 2 | W-621 有 completed 结果和 VR-339，状态却是 `dispatched`；`reject` 报 `dispatched -> rejected is not allowed` | 机器续派（reject + dispatch）发生在契约修订把 Mission 退回 planning 之后，而调度器只在 executing 阶段跑执行者，没人会去跑它；协调者又无法对 dispatched 工单 reject 或修订 | Mission 不在 executing 时不再自动续派（`mission_not_executing`）；`recoverStrandedWorkItem`：核实尝试、租约、修订号后收成 blocked，幂等；编排器叫协调者前自动恢复可证明的残留，L3 经 HTTP / MCP 显式恢复须署名写理由；有 in_progress 尝试或有效租约一律拒绝（`e2152c3`） | `test/stranded-work-item.test.ts` 6 条：不再续派、自动恢复后协调者可修订再派、真正在执行的不动、快照过期拒绝且不留事件、署名、HTTP 入口、`runMission` 面对的是 blocked |
| 3 | `hop.backoff` 之后托管运行退出，退避早已过期仍无人接手，要 L3 手动 start | 退避时刻只在队列行里，没有任何组件周期性扫描；托管启动参数只有发起方知道 | `Mission.waitResumeAt`（快照可选字段）、事件 `mission.run_requested`（启动参数，不含环境变量值）、`RetryWakeScheduler`（服务内；节流、并发上限、不重复启动、重启后第一个周期就找回）、`isAutoResumable` 门禁（`63e5ce7`） | `test/retry-wake.test.ts` 8 条；`test/auto-resume-service.test.ts` 真服务端到端 2 条：退避后托管运行退出，服务到点自己重新启动一次 Agent，审计一条、不重复派发；`COAGENT_AUTO_RESUME=0` 时不自己跑 |
| 4 | 契约要求协调者是 `xai/grok-4.7`，Grok 冷却后候选池自动换成 `openai-codex/gpt-6.1-sol`，靠 Sol 自己发现身份不符才升级（用户后来明确授权改用 Sol） | 契约正文只是叙述，没有任何地方强制；候选池按冷却自动顺延 | Mission 级模型约束：`preferred`（优先，可替代）/ `required`（指定，不可替代），选择器匹配 provider / model / reasoning / profileId；派发前在 `#runHop` 里强制；指定而匹配者不可用 → `model_unavailable`，有冷却到期时刻则自动重试，**绝不改派别的模型**；版本化、署名、事件留全部历史；每次派发留 `attempt.profile_selected`（`352042b`） | `test/model-policy.test.ts` 7 条：指定不改派、优先才替代并标明、其它 Mission 不受影响、改约束按新版本、旧限制留在历史里、HTTP；`test/orchestrator.test.ts`：指定 + 局部排除交回协调者 |
| 5 | 目录写法 `app/` 的 `allowedScope` 一路畅通，执行者整跳跑完才被检查点以「授权路径不确定」拒掉 | 建单什么都收，验证器认目录前缀，检查点只认精确文件，三处各写一套 | `scope-paths.ts` 一份共用判据；建单、修订、派发前拒绝并给出原因与例子（`WORK_ORDER_SCOPE_INVALID`）；只在装了检查点的工作区生效，保留绝对 / 穿越 / 盘符 / 通配符保护（`63fc3ac`、`babba89`） | `test/work-order-scope.test.ts` 3 条 |
| 6 | AAR / JAR / `__pycache__` 等二进制让 `changedLines` 整体变成笼统的 unknown | numstat 里出现一个 `-` 就把整份行数判为量不出 | 文本行数与二进制分开计量；二进制只记路径 / 大小 / 哈希并标出是否在授权范围内，可选 `maxChangedBinaryFiles` / `maxChangedBinaryBytes`；未授权的二进制仍由 changed-paths 判失败；量不出的文件点名路径与原因（`c932301`） | `test/validation-engine.test.ts`：授权二进制不破坏行数、二进制上限单独生效、量不出的文件被点名；未授权二进制仍失败 |
| 7 | 误导的等待原因：检查点失败显示 `no_available_agent`，退避显示 `project_busy` | 一个枚举借给了几种不同的情形 | 新停机原因 `retry_backoff`、`checkpoint_failed`、`model_unavailable`；`waitInfo` 统一投影（谁处理、会不会自动恢复、下次重试、第几次、有没有活动 Agent、下一步）与 `runner`（服务进程里托管运行是否真在跑）——「HTTP 受理」「runner 在跑」「在等」「完成」分得开；详情、列表、reviewer MCP、网页同源（`63e5ce7`、`f370e6c`、`0edf56b`） | `test/wait-info.test.ts` 4 条；`test/web-narrate.test.ts`、`test/web-task.test.ts`；`test/reviewer-workflow.test.ts`；真服务端到端里列表与详情说的一致，开关关着时如实说「不会自动恢复」 |

## 二、提交（`master..HEAD`，代码与文档共 11 个，不含本文档的提交；67 个文件，+5072 / −354）

| 提交 | 内容 |
|---|---|
| `63fc3ac` | fix(scope)：工单范围语义统一，模糊授权在执行前拒绝 |
| `c932301` | feat(validation)：文本与二进制独立计量，验证命令不再留字节码缓存 |
| `577be43` | feat(workspace)：验证后收口与开跑前工作区核对，检查点失败单独成因 |
| `e2152c3` | fix(work-item)：Mission 不在 executing 时不自动续派，并提供受控、幂等的状态恢复 |
| `63e5ce7` | feat(runtime)：退避到期由服务自动接着跑，等待原因单独成因 `retry_backoff` |
| `352042b` | feat(model)：Mission 级模型约束，由平台在派发前强制 |
| `f370e6c` | feat(observability)：等待状态统一投影，HTTP / 插件 / 网页读同一份 |
| `deda7b3` | refactor：守卫与恢复逻辑拆出编排器（`hop-guards.ts`），几处超线函数拆小 |
| `babba89` | fix(review)：自审发现的三处问题——盘符相对路径、指定模型与局部排除、开跑前核对出错放行 |
| `b4e9b5e` | docs(project)：同步模块地图、检视者手册与方案恢复规格 |
| `0edf56b` | test(runtime)：服务级端到端钉住自动续跑；waitInfo 如实反映调度开关 |

## 三、测试与验证

- 全量 `node --test`：改动前基线 tests 2452 / pass 2355 / fail 0 / skipped 97；最终代码 HEAD `0edf56b` 上 tests **2491** / pass **2394** / fail **0** / skipped 97 / cancelled 0，耗时 164.8 秒，退出码 0（97 条 skip 与基线相同，没有新增 skip）。
- 新增测试文件 7 个：`work-order-scope`、`workspace-hygiene`、`stranded-work-item`、`retry-wake`、`model-policy`、`wait-info`、`auto-resume-service`；既有测试只改了钉着旧行为的断言（检查点失败 `no_available_agent` → `checkpoint_failed`，退避 `project_busy` → `retry_backoff`，二进制不再令行数 unknown），没有为保持绿而缩小新规则。
- 变异检查（去掉修复，对应用例必须变红）：验证后收口接线、状态恢复接线、指定模型与局部排除，三处都做过且变红。
- 隔离故障注入：`test/auto-resume-service.test.ts` 真起服务（`startServer` + 托管 `run-mission` + 假 Agent），不手工 tick 调度器；没有重复安装 APK，没有重绑手环，没有动运行中的服务。
- `git diff --check` 无告警；变更文件在索引里全是 LF。`node scripts/code-metrics.ts --changed master` 只告警：新文件里还剩 12 条近似告警（参数个数 5–6、一个 62 行的读取函数、两处嵌套 4 层、一处 44 行），按「数值目标是建议值」没有为消除告警继续改动。

## 四、状态、接口与配置兼容

- **状态**：Mission 快照只多一个可选字段 `waitResumeAt`，老快照缺省 = 不会自动恢复；新事件 `workspace.validation_settled`、`workspace.residue_adopted`、`workspace.checkpoint_failed`、`mission.run_requested`、`mission.auto_resumed`、`mission.model_policy_set`、`attempt.profile_selected`，`work_item.platform_blocked` 增加来源 `workspace_dirty`、`stranded_dispatch`、`operator_recovery`；工单 `validation.diffSize` 多两个可选键。全部是追加，没有迁移。
- **HTTP**：新增 `GET` / `POST /api/missions/:id/model-policy`、`POST /api/missions/:id/work-items/:id/recover`；`GET /api/missions/:id` 多 `waitResumeAt`、`waitInfo`、`modelPolicy`、`runner`，列表行多 `waitResumeAt`、`waitInfo`，`/api/platform/status` 多 `runner`——都是追加字段，老客户端忽略。reviewer MCP 工具由 11 个变 13 个；合并后服务重启之前，新增的两个工具会得到 404。
- **不是纯追加的行为变化**：① 退避的停机原因由 `project_busy` 改为 `retry_backoff`，检查点失败由 `no_available_agent` 改为 `checkpoint_failed`——仓库内的消费者都已更新，按旧词判断的外部脚本需要改；② 装了检查点的工作区上，建单 / 修订 / 派发拒绝目录、通配符、绝对 / 盘符路径、`..`、空范围的工单，存量的目录范围工单到派发时被拒；③ Mission 不在 executing 时机器不再续派；④ 验证子进程环境多 `PYTHONDONTWRITEBYTECODE=1`；⑤「模型不可用」类失败独立成类并允许换候选（以前归 unknown，不换候选）。
- **配置**：新环境变量 `COAGENT_AUTO_RESUME`（默认开，`0` 关闭自动恢复）；没有新配置文件。关着、或 PG 部署没装配调度器时，`waitInfo.autoResume` 如实给 `false`。
- **回滚**：对合并提交 `git revert -m 1`，再重启服务；已写入的新字段与事件被旧代码忽略（唯一例外：用了新 `diffSize` 键的工单在旧代码里会丢掉 validation，目前没有这样的工单）。

## 五、未解决问题与风险

- 真正的 `project_busy`（同项目别的 Mission 占着改动名额）没有自动恢复，仍要对方落地后手动重跑。
- 旧代码留下的退避 Mission（案例的 W-619 / W-622 这一类）没有 `waitResumeAt` 和托管启动参数，部署后需要手动 start 一次，之后才进入自动恢复；案例现场本批没有碰。
- 自动恢复只管非队列的托管 Mission（入过 Mission 队列的归队列 worker），PG 部署不装配；对「续跑后状态毫无进展」的 Mission 只节流到每 5 分钟一次，没有硬上限（不烧 Agent 费用：hop 记账之前就失败；关停靠 `COAGENT_AUTO_RESUME=0`）。
- 模型约束只管协调者与执行者，不管独立检视者；设置时资源池里没有匹配候选只在响应里告警、不拒绝（池可以晚点再配）。
- 开跑前核对会把「L3 手工改过 Mission worktree」也当成脏改动拦下（设计如此：不属于这张工单就不让它背着跑）。
- 没有单独的 `state_recovery_required` 停机原因：状态不一致用 blocked + 事件 + 恢复入口表达。
- 影响判断监督仍把它自己的退避写成 `project_busy`（瞬态提示，执行者交卷后清掉；改成 `retry_backoff` 又没有恢复时刻，反而更错）。
- 最大的风险是流程上的：这批代码没有经过平台的独立验收，合入 master 前只靠本机全量测试和检视者自检；真实设备验收、真实 Mission 上的端到端观察都不在本批范围。

## 六、部署步骤（未执行，等明确授权）

1. 合入 master 之后服务仍是旧代码；静态网页文件按磁盘现读，新网页对老接口向后兼容，立刻生效无害。**推送 GitHub 是另一件事，须用户明确说「推」。**
2. 重启前提：没有在跑的 agent。查 `GET /api/platform/status` 的 `occupancy.activeLeases` 为 0，并核对 node 进程命令行里没有 agent-entry / run-mission（手册第 7 节）；有就等它收尾，或由用户决定先暂停。撰写本文时 minavigate-ring 有 1 条协调者租约在跑，所以这一步现在不成立。
3. 先暂停仍在运行的 Mission；核实持锁 pid 与 3101 监听者一致（`holder.json`），PowerShell 里 `taskkill /F /T /PID <已核实的 pid>`，不得凭旧交接里的 pid 杀进程。
4. 核实进程已死、端口空闲、心跳超过 120 秒；平台会自动接管残锁并写审计，不要手工清锁、不要编辑状态文件。
5. 用隐藏启动脚本经 explorer.exe 打开 `roles/launchers/*.cmd` 起服务（`Start-Process` 随会话死，WMI 随回收死）。
6. 验证（只用 HTTP）：`/api/platform/status` 含 `runner.autoResume.enabled=true`；任取一个有停机原因的 Mission，`/api/missions/:id` 含 `waitInfo`；对旧代码留下的退避 Mission 手动 start 一次；`GET /api/missions/:id/model-policy` 返回 `{"policy":null}`。
7. 紧急开关：服务环境变量 `COAGENT_AUTO_RESUME=0` 后重启即关闭自动恢复，其余行为不变。
8. 回滚：`git revert -m 1 <合并提交>` 后重启；不需要改任何 Mission 状态。
