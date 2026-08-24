# CoAgentHub — 项目上下文

> 单上下文布局:本文件 + `docs/adr/` 是本仓库的领域文档锚点(见 AGENTS.md)。

## 是什么

CoAgentHub 是一个**局域网规模的多 participant 协作中枢**:participant 注册身份、加入任务群组、
按角色路由交换消息、通过 P2P 信令交接文件。它只做协作调度与消息信令,不代理文件字节。

## 领域词汇(ubiquitous language)

| 词 | 含义 |
|---|---|
| **participant** | **参与者身份**(原名 agent,2026-08 改名,旧 API `/api/agents` 与 `audience=agent` 仍兼容):任何想参与群聊的主体——人、CLI 工具、常驻脚本、AI bot——都统一注册成一个 participant(名字唯一,`token_hash` 列保留待删,token 认证已移除)。不是「AI 智能体」,平台不内置 AI;与角色解绑 |
| **group(表名 groups)** | 一个任务/项目 = 一个群;创建者自动成为 coordinator |
| **group_members.prompt** | 群内成员自定义提示词:该 participant 在本群的分工说明,调度时拼进任务书 |
| **audience** | 消息投递范围:`broadcast` / `role`(audienceRef=角色名) / `participant`(audienceRef=participantId) |
| **group_message + closure** | 消息与闭包表(消息树,`depth`=根到该消息的层级) |
| **task** | 一次执行:定向消息(`audience=participant`)命中执行器 → server 直接建 task → 按 project_path 分组队列 spawn(同项目串行、跨项目并行)+ 按执行器并发能力排队(可选 `maxConcurrency` 上限 / `403 atomgit_session_concurrency_conflict` 反应式排队)→ done/failed。可选 callback 路由(`callbackRef` = `{ platform?, endpointRef?, sessionRef? }` 三个短字符串,不存 URL/token/命令/secret)随任务持久化 |
| **checkpointRef** | 执行前 git 快照(`refs/coagenthub-cp/<taskId>`),回滚用 |
| **callbackRef** | 可选 opaque 路由信息,只允许 `{ platform?, endpointRef?, sessionRef? }` 三个短字符串(≤200 字符),不存 URL/token/命令/secret。task 首次进入终态时由 DB trigger 据此创建 completion event,宿主按 callbackRef 恢复会话 |
| **completion event** | Durable Task Completion Event:task 首次从非终态进入 done/failed/cancelled 时,若存在 dispatcherParticipantId,由 DB trigger 在 task 同事务内持久化到 `task_completion_event` 表(task_id 唯一约束保证幂等)。状态机 `pending → leased → delivered → dead`,participant-scoped inbox + claim/lease/ack/fail API 交付 |
| **inbox** | participant-scoped completion event 视图:`GET /api/participants/:id/task-completion-events` 查询 pending/可重试/lease 已过期的事件(可靠性来源始终是数据库 inbox,WS 仅低延迟提示) |
| **executor_config** | 执行器配置(DB 持久化;内置在 `lib/executors.ts`) |
| **Local User** | 无身份声明请求的默认身份(human,全可见);局域网全信模型 |
| **项目记忆** | 群绑定 `project_path` → 读取仓库文档(静态记忆) |
| **决策票(decision ticket)** | 大特性拆票的单元是「以决策为解的问句」，不是实现切片；实现切片才是下发执行器的 task |
| **throwaway 分支** | 探索留档分支：`research/<name>`(调研结论)与 `prototype/<name>`(原型产物)，用完不删，主分支只保留被验证过的决策 |
| **context pointer** | 票/任务上的一行指针：分支名 + 结论一句话，指向 throwaway 分支上的留档 |
| **reviewer(检视者)** | **用户侧唯一入口**：与用户直接对话（对话发生在检视者 runtime 的原生会话，不经平台群）；需求分流（大需求写 spec / 小 bug 不改 spec / 仅当影响 spec 描述才修订）；生成并冻结 spec（公布 `specRef`+`specHash`）；执行 L3 架构检视；发现实现与预期有出入时修订 spec。**协调者不再自写 spec** |
| **三层检视** | L1 执行者会话内自检（Standards + Spec 双轴）/ L2 协调者功能检视（对照 spec 验收标准，✅ 放行 / ❌ 重下发）/ L3 检视者架构检视（最佳实现、ADR 合规、领域词汇；发现项 → 修订 spec） |
| **协作模式（三层 / 两层）** | 群级编制由**群成员构成推导**，不是配置项、不落 `groups.mode` 字段；具体工作是否跑 L3 还要结合逐票工作类型判断。两层下协调者**兼任检视者的写 spec 职责**——读 `skills/reviewer/SKILL.md` 的「职责 A」自行 grill + 写 spec + 冻结公布（严禁把内容复制回 coordinator skill）；两层**跳过 L3** 架构检视。取舍：更少 agent 跳转（省 token / 延迟）vs L3 变自审（同一上下文既下发又检视）、写 spec 与验收 spec 同一方（交叉校验消失）；建议小改动 / bug / 边界明确小需求走两层，架构决策 / 新模块 / 写进 ADR 的工作走三层 |
| **编制（三方 / 两方）** | 由群成员构成**实时推导**：`reviewer` 与 `coordinator` 同时在场 = 三方，否则两方。**不落平台字段**。决定「谁来干」，不决定「跑几层」 |
| **工作类型（需求 / 修复）** | 逐票由检视者分流，落 `dispatchKind`。决定要不要新写 spec、**要不要跑 L3**。与编制**正交** |
| **替代关系** | `supersedesTaskId`：换执行器时新任务指向被替代的那次尝试。多行保留完整现场，`l1.childCount` 只算有效尝试，`supersededCount` 透出换过几次 |
| **轴的区分** | **三层 / 两层**是检视深度轴（由工作类型决定），**三方 / 两方**是编制轴（由成员构成决定）；两者不是同一个概念，不能混用 |
| **验收钉子(specHash)** | 在途任务按下发时刻的 specHash 口径验收，不受后续 spec 修订影响 |
| **会话延续(detached)** | `## ReplyMode: detached` 对 CLI 与 a2a 均生效；下发方带 `callback.sessionRef`，收件方结案时 `PATCH` 回写终态，回传经 completion event → callback-agent `resume <sessionRef>` 回到下发时的同一会话 |
| **单角色约束** | 一个 participant 在一个群内只能持有一种角色（`roles.length ≤ 1`，违反 400）；跨群可不同 |

## 运行拓扑

```
Web (:3000, serve.mjs) ──/api 反代+WS──► Server (:3001, Hono)
                                            │  PostgreSQL (coagenthub 库)
                                            ├─ spawn 执行器 CLI(atomcode/codebuddy/reasonix/hermes)
                                            ├─ A2A gateway(Win Hermes, 远端)
                                            └─ WS 通知 / ?after= 增量拉取
```

实现布局(2026-08 架构审视后):`routes/group/` 按职责拆为 groups/members/messages/tasks 子路由 +
`helpers.ts`(共享守卫,API 路径/响应不变);`lib/executor-task/` 拆为 types/state/output-buffer/notify/
report/queue 六个子模块(barrel 导出面不变,`@server/lib/executor-task` 导入兼容);统一配置读取收敛在
`lib/config.ts`(CORS_ORIGIN / FILE_DIR / MAX_FILE_UPLOAD_BYTES / PORT);`participant.token_hash` 列为
已知历史遗留(token 认证已移除),**不删除**,标记 deprecated 待删。

## 平台下发的运维前提(2026-08-22 实测)

用平台下发任务(而非直调 CLI)时,有四条前提。**详见 `docs/architecture.md` §9.9**,
这里只列结论:

1. **后端进程要能拿到代理变量** —— 执行器完整继承后端环境;后端没代理,
   执行器就直连超时,每票白等约 2 分钟。
2. **会改后端代码的任务,后端要用非 watch 模式**(`pnpm --filter server start`)
   —— 否则 `tsx watch` 重启会杀掉自己 spawn 的执行器子进程。
3. **codex 执行器带沙箱**:禁网络、禁监听回环、禁写 `.git/`。
   全量测试由协调者代跑;执行器提交需申请非沙箱操作。
4. **执行器会把暂存区里的无关文件带进提交** —— 提交前确认暂存区干净。

## 关键决策

见 `docs/adr/`:闭包表消息树、局域网信任模型、单调度器执行器、两级记忆、角色解绑。

## Spec-Driven Task Dispatch (规范驱动任务下发, 2026-08-18)

协调者在完全确定实现方案前不允许下发任务。任务可携带 `specRef`（规范文档路径）
和 `specHash`（版本哈希）字段,任务书模板自动插入"关联规范"段,执行器严格按 Spec 实现。
任务书以精简的"执行方式"段触发 `coagenthub-executor` skill,执行器自检(Code Review
自检,Standards + Spec Compliance)由 skill 承载;汇报格式要求固定五行(提交/测试/Token/
汇报/遗留),`Token:` 段由 server 端清洗为纯数字。
Spec 文档位于 `specs/` 目录。Skills 位于 `skills/` 目录(coordinator/executor/bugfix/reviewer,其中 bugfix 现为索引——诊断/分流归检视者、方案与下发/验收归协调者)。
详见 `specs/spec-driven-task-dispatch.md` 和 `specs/plugin-skill-adaptation.md`。
