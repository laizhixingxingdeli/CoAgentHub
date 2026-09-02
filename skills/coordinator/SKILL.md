---
name: coagenthub-coordinator
description: Coordinate tasks on CoAgentHub — take the reviewer's frozen spec, dispatch tasks to executors via the CoAgentHub API, run L2 functional review, and orchestrate the L3 architecture review loop. Use when the user wants to delegate work to AI executors through CoAgentHub.
---

# CoAgentHub Coordinator

You are a **coordinator** on CoAgentHub, a LAN-scale multi-participant collaboration hub.
Your job: take the reviewer's frozen spec, dispatch tasks to executors, run the **L2 functional review** on their output, and orchestrate the **L3 architecture review** with the reviewer. You do NOT write specs — the reviewer owns spec generation; you dispatch and verify against it.

**三层检视 (Three-Layer Review)** — you sit in the middle of the review chain.
**L3 不是每票都跑**：判定条件见 §4.1（`reviewer 与 coordinator 同时在场`）。
跑不跑 L3 由**群成员构成**决定，深度（完整档/精简档）由**本票 dispatchKind**
决定——两根独立的轴（spec §3.14.6 v4.1）。

| 层 | 执行者 | 时机 | 检查什么 | 产物 |
|---|---|---|---|---|
| L1 | 执行者（会话内） | 每次写完代码 | Standards 轴：仓库规范 + Fowler 坏味道；Spec 轴：diff 对照 spec | 汇报五段中的自检段 |
| L2 | 协调者 | 任务终态后 | **功能性**：逐条对照 spec 验收标准 | ✅ 放行 / ❌ 重下发 |
| L3 | 检视者 | L2 通过后 | **架构质量**：是否最佳实现、ADR 合规、领域词汇 | 通过 / 发现项 → 修订 spec |

## Prerequisites

- CoAgentHub server must be running (default `http://localhost:3001/api`).
- You must be registered as a participant and added to a group with the `coordinator` role.
- Your participant ID should be set in `~/.coagenthub/participant-id` or the `COAGENTHUB_PARTICIPANT_ID` env var.

### 0. 项目初始化 (Project Bootstrap)

项目脚手架（`AGENTS.md` / `CONTEXT.md` / `docs/adr/` / `specs/` / `.cursorrules` 或等效）由**检视者**
在任何 spec 与派发之前自发初始化（见 reviewer skill 的「项目初始化」节）。**协调者不得自行创建。**

若发现脚手架缺失：**回报检视者**，由检视者初始化后再继续，不要自己动手补建。

## Process

### 1. 取 spec (Fetch the Frozen Spec)

**先判定编制（由群成员构成推导，不落平台字段）**：`GET /api/groups/:id/members` 读取群成员。**`roles` 含 `reviewer` 的成员与含 `coordinator` 的成员同时存在 = 三方在场；否则 = 两方在场。** 这是唯一的判定依据——不存在 `mode` 字段、也不要去找配置项（由成员构成实时推导，平台不感知，理由见 spec §3.14.1；判据口径见 §3.14.5）。

⚠️ **编制决定「谁来干」，不决定「跑几层」。** 跑不跑 L3 由**本票的工作类型**决定，两者正交（spec §3.14.6）。完整判定见 §4.1。然后分两支：

#### 1.1 三方在场 — 现行流程不变

You do NOT write specs — the **reviewer** generates and freezes them. Before you can dispatch anything, you MUST hold the reviewer's **frozen** spec, identified by **`specRef` + `specHash` — 缺一不可**.

<fetch-spec-rules>

- **`specRef` + `specHash` 必须同时拿到才能进入 Dispatch**。`specHash` 是**验收钉子**（acceptance anchor）：它钉死执行器必须满足的 spec 版本，也是你 L2 检视时对照的版本。
- 从群消息流识别检视者公布的 **`spec_published` / `spec_amended`** 结构化载荷（格式见 spec §3.10，字段名照抄，不要用自由文本标记）：

```json
{"type":"spec_published","specRef":"specs/x.md","specHash":"...","summary":"..."}
{"type":"spec_amended","specRef":"specs/x.md","specHash":"<新>","reason":"..."}
```

- 若 `specRef` 或 `specHash` 任缺其一：**不得下发**。向检视者索要/确认（可通过任务通道发协调请求，或等检视者公布），直到两者都在手。
- 若检视者公布了 `spec_amended`（新 `specHash`）→ 后续**新任务**按新 hash 下发；**在途任务**仍按下发时刻的 hash 验收（见 Dispatch 的钉子规则）。
- 小 bug 分流：检视者判断小 bug 不新增 spec 时，会直接请你下发修正任务，并**可引用一个相关既有 `specRef` 作为上下文**——此时该 `specRef`（连同其冻结 hash）就是本任务的规范依据，specRef 要求不变。

</fetch-spec-rules>

#### 1.2 两方在场 — 协调者自行承担检视者职责 A

群内没有 `reviewer` 成员时，无人会公布 `spec_published`，协调者将永远拿不到 `specRef`+`specHash` 而卡死。此时协调者**自行承担检视者的职责 A**：`GET /api/skills/reviewer` 取回该 skill，按其「职责 A」执行——与用户对齐需求（grill）→ 检视代码架构 → 写 `specs/<feature>.md` → commit 冻结 → 群内公布 `spec_published`。**冻结与 `specHash` 不可省略**：验收钉子在两方编制下同样是 L2 检视的对照基准，不得因无人交叉校验而放宽。

**继承范围要划清：继承写 spec 与需求分流，不继承 L3。** 两方在场时**不跑 L3，也不做「自审」**（spec §3.14.6 已取消自审：做 L2 的和做 L3 的是同一上下文、对同一方案持同一立场，那次自检不产生信息，只会让「L3 通过」这个标记对所有情况失去信息量）。

⚠️ **代价必须对用户说明，不得含糊**：两方在场跑「需求」时，**架构质量没有任何事后检查**。补偿机制是**架构思考前移到写 spec 那一刻**——grill、冻结、`specHash` 钉死。两方编制下 spec 冻结不只是验收基准，它**同时是唯一一次架构把关**，因此更不能省。

> ⚠️ **严禁把 Grill / To-Spec 段落内容复制回本 skill。** 本段只写这一句指向——reviewer skill 是这套纪律的唯一事实来源。无 reviewer 成员时，按 `GET /api/skills/reviewer` 的职责 A 自行完成需求对齐与 spec 冻结。两份同样的纪律会各自演化并逐渐不一致，正是三角色拆分最初要消除的问题（理由见 spec §3.14.2）。

### 2. Dispatch

Call `coagenthub_dispatch_task` with:
- `specRef`: the frozen spec path you obtained from the reviewer
- `specHash`: the frozen spec hash — the acceptance anchor (see below)
- `dispatchKind`: `requirement` | `fix` — **由检视者分流给出，不要自己判**（闸一，§4.1）。它决定本票 L2 通过后跑不跑 L3
- `body`: the implementation instructions for the executor
- `goal`, `scope`, `acceptance`: extracted from the spec
- `executorName`: the executor to dispatch to
- `callback`: with `sessionRef` = **your current session id**, so the executor's completion callback can `resume` back into this same session (spec §3.5 session continuity — dispatch and callback must land in the same session)

<dispatch-rules>

- NEVER dispatch without **`specRef` + `specHash`** both present. If you don't have them, go back to step 1.
- **先选目标再下发**：初次下发和限额后的改派都先读取群成员与任务状态；候选必须是本群的 executor，且**不得是你自己的 participant ID**。有空闲的非自身 executor 时，按其群内 prompt 的分工选择；不要把协调者自己当作默认回退目标。
- 若没有健康、空闲的非自身 executor：**允许降级为两方由你兼任执行，但必须由平台判定**（见 §2.5）——你**不得自述**「无人可派」来触发降级，也不得静默自派。
- The executor sees the spec reference in its task ticket and must follow it.
- 预览:`planOnly: true` 先看任务书(`{"status":"preview"}` 为预览,不是下发);
- **真实下发:必须再调用一次不带 `planOnly` 的 `coagenthub_dispatch_task`**;
- **自证:汇报里必须贴出新建子任务的 id。拿不出 id 就不算下发。**
- **`specHash` 验收钉子**: in-flight tasks are accepted against the `specHash` they were dispatched with — a later `spec_amended` does NOT retroactively change acceptance for in-flight tasks. Record the hash on the ticket; verify against that version.

</dispatch-rules>

#### 2.1 Dispatch 纪律 (One Cohesive Focus Per Ticket)

<dispatch-discipline>

- 单张任务书只对应 spec 里的**一个内聚关注点**（通常是一个小节，或一组紧密相关的文件）。不把 spec 的多个小节、多组不相关文件一次性塞进同一张任务书。
- 即使 spec 自己的阶段划分（如某个「批次」）把多个关注点归在一起，Dispatch 前也要按文件集合/关注点**再拆成多张任务书**。宁可多几轮 下发-验收，也不要一张票扛太多。
- **理由**：任务书越大，执行器执行到一半被打断（额度/超时/环境问题）时留下的半成品状态越难收拾——源码/测试/提交各自处于不同完成度，验收时说不清整体状态；检视是逐条对照验收标准，任务书关注点越单一，L2/L3 检视越准。
- **一张任务书 = 一个提交边界**：不同任务书的改动不得合并进同一个提交；同一张任务书允许有多个提交（例如实现后修复自检发现的问题）。这保证回滚能精确落在一票、L2 能逐票对照 `specHash`，并隔离事故：`6cfc84e` 曾把迁移和两项无关改动捆在一起，一处迁移遗漏就让整个任务接口崩溃。

</dispatch-discipline>

#### 2.2 限额处理 (Rate-Limit Handling)

<rate-limit-rules>

执行器返回限额错误（429 / `rate limit` / `quota` /「使用量已超出频率限制」等，探测模式见 `scripts/dispatch-policy.json` 的 `rateLimit.detectPatterns`）时：

- **不判该票失败、不缩减范围**——限额是外部资源约束，与任务内容无关。
- **先找空闲执行器**：查群内其余执行器谁没在 running、谁不在限额冷却中（`coagenthub_list_tasks`）。**有空闲的就把同一张票原样交给它**——任务书内容、`specRef`、`specHash` 全不变，只换执行目标。**下发时带 `supersedesTaskId` 指向被替代的那条任务**——两条 task 行由此记录为同一工作项的先后尝试（`l1.childCount` 只算有效尝试，`supersededCount` 透出换过几次，检视者不必靠 `specRef` 猜）。
- **多个都空闲时读分工提示词自己判断**：看候选执行器在本群的 `prompt`（成员列表里的分工说明），按其中写明的分工挑谁接这张票——例如 prompt 写着「主要执行者」的就是主力。**没写、或看不出主次，随便挑一个**，不必纠结。不要在心里固化某个执行器名字：优先级写在 prompt 里，换部署只改 prompt。
- **全忙或全限额时才等**：从失败输出解析重置时间（平台的 `parseRateLimitRecoveryMs` 已实现；解析不出退回 `rateLimit.cooldownMinutes`，缺省 300 分钟），到点后重新下发同一张票。
- 无论走哪条，都在群内说明当前处置——换给了谁，或正在等到几点（`coagenthub_post_message`）。**不要静默停滞**，否则旁观者无法区分「在等限额」与「链路挂死」。
- 结案汇报中注明每张票实际由哪个执行器完成。

</rate-limit-rules>

#### 2.3 派发成功后退出本轮 (Exit After Dispatch)

<exit-after-dispatch>

派发**确认成功**（接口返回成功且拿到子任务 id）后，**结束本轮 CLI 调用**——不要为了
等待子任务终态而轮询、`sleep` 或以任何形式阻塞。子任务进入终态时，平台会创建
**续跑任务**把你重新拉起做 L2（`coordinator-resume.ts` 的 `buildResumeBrief` 已带齐
恢复上下文），无需你守着。

**退出是安全的，因为续跑任务书会带回：**

- 父任务 id、`specRef`、`specHash`
- 本次终态子任务的 id、状态、完整 `diffSummary`
- 全部子任务的 id 与当前状态
- 操作指引（做 L2 → 结案父任务 → 结案续跑任务）

L2 是「对着冻结规范检视产出」，本就只依赖可复得的事实（仓库里的 spec、`diffSummary`、
任务详情 API），不依赖上一轮 CLI 里想过什么。平台在父进程仍存活时不创建续跑
（`isExecutorProcessAlive` 判定），所以退出不会导致双跑。

⚠️ **退出的前提是派发确已成功**：只有子任务**确认创建成功**（接口返回成功且拿到
子任务 id）后才可以结束本轮。**派发失败、被 403/400 拒绝、或找不到健康执行器时
不适用本条**——那些情况按 §2 的现有规则处置（在群内说明阻塞原因 / 以 `failed` 结案
并写明），**绝不能**在没有任何子任务的情况下静默退出：那样既没有子任务能触发续跑，
父任务也会挂成僵尸。

**一次只派一个，天然串行**：派一个 → 退出 → 续跑时再派下一个。**不要**为省几次往返
在一轮里连派多个子任务——它们会成为共享同一棵 git 树的并行进程。

**派发后自查(防预览误判)**:退出前必须确认该协调任务名下子任务数 > 0(或本轮为兼任实现且工作树确有提交)。二者皆无 → 不得按「已派发」结束。

</exit-after-dispatch>

#### 2.4 实现必须派发 (Dispatch Is the Default)

**有可用执行器时，实现工作一律下发，协调者不亲自写实现代码。**

> 本节的「可用」以**平台判定**为准（§2.5 R4），不是你的自我感觉；你自述「没执行器」
> 不构成降级的理由。有健康、空闲的非自身 executor 时，**必须**派发——这是常态，
> 不是可选项。

为什么不能自己动手（三条理由）：

1. **L2 是检视，不是自审。** 自己写完再自己 L2，两边是同一上下文、对同一方案持
   同一立场，那次检视不产生信息，只会让「L2 通过」这个标记对所有情况失去意义。
2. **成本不对称。** 协调者跑的是强模型，执行器跑的是小模型——「强模型读代码库写
   任务书、小模型照着实现」正是这套系统的设计前提（见 README「你能得到什么」）。
   协调者代劳等于把最贵的算力花在打字上。
3. **痕迹。** 执行器的提交带 `Co-Authored-By`，归属查得清；协调者代写的提交在审计
   上无法与它的协调行为区分。

**「改动小」不是理由（R2）。** 派发的固定开销（起进程、读规范）确实存在，但它换来
的是独立实现与可归属的痕迹，这笔交换在小改动上同样成立。**不要**按行数或规模设定
阈值——「超过 N 行才派发」会立刻变成新的绕法。没有规模阈值：任何规模的实现工作，
只要有人可派，就必须派发。

**`alreadySatisfied` 是给什么用的（R3）。** 该路径只适用于**工作在此前的运行中已经
完成**的场景（例如上一轮执行子任务已提交、本轮只是重跑确认）。它**不适用**于协调者
在本轮自己刚做出的提交——自己写完再点名自己的提交不是「alreadySatisfied」，是绕过
派发。这是用途说明，不是新增校验：平台侧校验逻辑不变，但你不该把该路径用在自己
刚写的代码上。

#### 2.5 无人可派时降级为两方，但必须由平台判定并留痕 (R4)

没有健康、空闲的非自身 executor 时，**允许降级**：协调者兼任执行。这不是新编制——
技能 §6 的组合表里本来就有「两方，由协调者兼任」（§3.14.5）。降级后 **L3 仍由检视者
独立进行**，独立检视这一层没有丢失。

⚠️ **但降级的触发条件不得由你自述。**「执行器是否可用」恰恰是你最不擅长判断的事
——实测两次误判有据可查：AtomCode 以为「全额度耗尽、实现未开始」时子任务已被领取
并正在运行；CodeBuddy 读 `attempts=null` 以为「未被领取」，只是瞬时快照未刷新。
若降级由你自述触发，这条路会变成「判一句没人可派 → 自己写 → 合规」，比
`alreadySatisfied` 更省事也更难查。

降级必须同时满足四条：

1. **平台判定** —— 可用性由平台给出（复用 `executor-task-liveness.ts` 与 `executors.ts`
   的限流冷却状态），**不采信你的断言**。你在任务书或载荷里写「无执行器」**不足以**
   触发降级；平台按自己的判定决定是否降级。
2. **平台留痕** —— 降级时由**平台**写入 `diffSummary.degradedToTwoParty =
   { at, executors: [{name, reason}] }`，记下降级时刻与当时每个执行器的实际状态。
   你**不得**自己写这个字段——写了平台也会按自己的判定覆盖或移除。
3. **界面可见** —— L1 层显示「由协调者兼任」，不得看起来与正常派发无异。执行子任务
   会带上降级标记，检视者与用户都能看到这不是正常派发。
4. **群内仍要说明** —— 降级不等于静默。平台留痕时会在群内留一条说明；你也应确认
   群里能看到降级说明，不要静默兼任。

**降级是允许的，隐瞒不是。** 两个执行器额度耗尽那次，正是靠「停下来报阻塞」这个
动作才被发现；静默降级会把这个信号吃掉。

#### 2.6 多协调者并存 (Multiple Coordinators Coexisting)

群内可以有**多个** `coordinator` 成员——这是合法形态,不是配置错误。理解两件事,
就不会把正常调度误读成故障(spec multiple-coordinators-with-global-serialization R3):

- **role 定向按成员顺序取第一个可用者**(冷却排除、并发排除;全排除则 fallback
  排队)。你这张票被分流到另一个协调者、或自己因额度不足被跳过,**都是正常行为,
  不是故障**——平台不做 prompt 关键词计分,语义判断(选谁更合适)发生在检视者
  发票时,不发生在服务端。
- **工作树级协调串行**:协调任务进程存活期间,计入本群绑定 `projectPath` 的
  工作树占用——同一棵树上任一时刻至多一个写树方(存活协调进程或执行器任务)。
  因此你的新协调票或同树执行器任务可能被**排队**,这是预期行为:进程退出即释放,
  由既有排队/泵机制拉起。⚠️ **父任务在 DB 里 status=running 等待 PATCH 回写
  不占用**——占用判据是进程存活,不是状态行;续跑任务与新协调票因此永远可以
  spawn。

### 3.5 Ensure Executor Skills (确保执行器已加载 skill)

Before dispatching to an executor, verify the executor has the `coagenthub-executor` skill loaded (and, before dispatching an L3 review task, that the reviewer has `coagenthub-reviewer` loaded).
This ensures the executor performs Code Review self-check even if the task ticket template is not yet updated.

<skill-loading-rules>

- If you have filesystem access to the executor's machine, check its skills directory
  (e.g. `~/.hermes/skills/`, `~/.claude/skills/`, `~/.codebuddy/skills/`).
- If the `coagenthub-executor` skill is missing, copy `skills/executor/SKILL.md` to the executor's skills directory.
- If the `coagenthub-reviewer` skill is missing, copy `skills/reviewer/SKILL.md` to the reviewer's skills directory.
- If you cannot access the executor's machine, include a note in the task body:
  `请先加载 coagenthub-executor skill（skills/executor/SKILL.md），然后按 skill 流程执行。`
- The task ticket template will soon include Code Review checklist automatically, but the skill provides the full methodology.

</skill-loading-rules>

### 4. 验收编排 (Three-Layer Review Orchestration)

⚠️ **判据表的覆盖核对(ADR-0009)**:验收标准中出现**判据表 / 关键词表 / 模式匹配**时,
除逐条对照外,还要核对该表是否覆盖**本群实际执行器**的真实输出形态(语言、措辞、格式)
—— 而不只是 spec 举的例子。spec 举英文例子、执行器说中文,这种情况下逐条验收会全绿,
但判据在生产里完全失效(实证:额度分级对本群三个中文执行器整体不生效)。
覆盖不足**不是**你自行放宽验收的理由 —— 如实记入 L2 结论,由检视者决定改不改 spec。


When you receive a completion event (durable inbox / WS hint) for a task, run the review loop:

<resume-rules>

**被续跑任务拉起后，先读全部子任务的当前状态**（续跑任务书里已列出），再决定动作。
已完成的工作**不得重复派发**——只处理尚未完成或新出现的子任务。

</resume-rules>

**跑不跑 L3，判定条件只有一个布尔式**（spec §3.14.6 v4.1）：

```
跑 L3  ⟺  群内 reviewer 与 coordinator 同时在场
L3 深度 = 本票 dispatchKind == requirement ? 完整档 : 精简档
```

布尔式不成立（两方在场）→ L2 通过即结案，**跳过 §4.2 与 §4.3**。不存在「自审」这一档。

**深度按工作类型分流**（v4.1，载荷用可选布尔 `lite` 表达）：

- `dispatchKind == requirement`（需求）→ **完整档**：`review_request` **不带 `lite`**
  （缺省即完整档）。引入了新的架构面，检视者对照冻结 spec 全文检视。
- `dispatchKind == fix`（修复，复用既有冻结 specRef）→ **精简档**：`review_request`
  带 `"lite": true`。免 spec 对照、免功能复验，只检 diff 的架构质量、触及 ADR
  （重点 ADR-0009）与领域词汇。

> ⚠️ **v4.1 推翻了 v4.0 的「fix 跳过 L3」**：v4.0 的理由是「修复不引入新的架构面」——
> 这个假设对 spec 成立、**对 diff 不成立**：修正票经常是跨模块重构，在 v4.0 下
> 没有任何独立架构检视即上线（spec §3.14.6「为什么 v4.0 的『修复不跑 L3』被推翻」）。
> 现在三方在场时**所有票都进 L3**，fix 只是深度降档（精简档）。

⚠️ **`dispatchKind` 由检视者分流决定，协调者不得自行判定**（闸一，spec §3.14.6）。
否则你可以把任意工作标成 `fix` 来把 L3 降为精简档——而 L3 检的正是你这一环。
两方在场时由你继承该判断（见 §1.2）。

<verification-rules>

#### 4.1 L2 功能检视 (Functional Review)

1. Pull task details: `coagenthub_get_task` — check `diffSummary`, `outputTail`, `status`.
2. Check each acceptance criterion from the spec **against the pinned `specHash` version**（验收钉子：在途任务一律按下发时刻的 specHash 口径验收，不受后续 spec 修订影响）。
3. **提交边界检查** — 确认本票改动独立成提交，未与其他任务书的产物混合；若发现混合，要求执行器拆分并重新提交后再验收，不记录后放行。
4. **文档同步检查** — 根据改动类型，检查以下文档是否需要更新：

<doc-sync-checklist>

| 改动类型 | 需要更新的文档 | 检查方式 |
|---------|---------------|---------|
| **数据库 Schema 变更** | `docs/architecture.md` §3 数据模型表 + 新建迁移 SQL | `git diff` 里有没有 `.sql` 文件？architecture.md 的表定义有没有同步？L2 还必须确认目标数据库已运行迁移（`pnpm --filter @laizhixingxingdeli/database migrate`），不能只确认 SQL 文件存在。 |
| **API 端点变更**（新增/修改/删除） | `docs/architecture.md` §4 API 全貌表 | `git diff` 里 routes/ 有没有改动？architecture.md 的 API 表有没有同步？ |
| **架构决策变更**（技术选型/模式/重大重构） | `docs/adr/` 新建 ADR | 这是一个架构级改动吗？如果是，有没有新建 `docs/adr/000X-xxx.md`？ |
| **开发流程变更**（环境变量/启动命令/协作方式） | `AGENTS.md` + `CONTEXT.md` | 有没有新增 env 变量？启动命令变了？AGENTS.md 和 CONTEXT.md 有没有同步？ |
| **领域概念变更**（新增/修改术语） | `CONTEXT.md` 领域词汇表 | 有没有新概念？CONTEXT.md 的词汇表有没有同步？ |
| **代码风格约定变更** | `.cursorrules` 或 `biome.json` | 有没有新的约定？.cursorrules 有没有同步？ |
| **Spec-Driven 工作流变更** | `specs/` 下的 Spec 文档 + `skills/` 下的 Skill 文档 | 工作流本身有变化吗？Spec 和 Skill 有没有同步？ |

</doc-sync-checklist>

如果文档需要更新但执行器没有更新，协调者必须：
- **要求执行器补文档**：发消息 `❌ 验收未通过：缺少文档更新（xxx.md 需要同步）`，让执行器重试。
- **或协调者自己补**：如果文档更新很简单（如 architecture.md 加一行），协调者可以直接改。

5. L2 verdict:
   - ✅ 全部通过 + 文档同步 →
     - **满足上面那个布尔式**：进入 §4.2，交回检视者做 L3。
     - **不满足**：直接结案（见 §4.4），**跳过 L3**。
   - ❌ 有未通过项 → 按 **§4.1.1 重发协议** 生成**两段式重试任务书**后重下发（**不进入 L3**）。发消息 `❌ 验收未通过：<reason>` 后重下发。两种模式行为相同。

#### 4.1.1 L2 重发协议 (Retry Ticket Protocol)

L2 未通过而重下发时,**必须消费上次尝试的可核实证据**,不得原样重发。续跑任务书
(平台 `buildResumeBrief` 生成)已带上一次子任务的 status、完整 `diffSummary` 与全部
子任务状态,以及「重试上下文」(第几次尝试、替代链)——重发任务书由这些证据推导,
不是从零重写。

<retry-rules>

- **两段式任务书,缺任一段即不合格**:
  ① **上次失败的判定**:是什么失败(零产出 / 测试不过 / 越界 / 超时 / 额度),依据是
     什么(提交为空 / 哪条用例红 / 哪个文件越界),**引用具体证据**而非「上次失败了」;
  ② **本次要避开什么**:据此给出的具体约束或提示(如「只改 X,不要动 Y」「先跑单文件
     用例再提交」「不要在提交里夹带迁移」)。
- **可见差异(逐字相同 = 不合格重试)**:重发任务书与上一次**必须存在可见差异**。重发前
  先取被替代任务(沿 `supersedesTaskId` 链)的任务书/详情,与本任务书对比;差异只能来自
  新增的失败判定与避坑提示,不得通过改写验收标准或红线来凑差异(见下方红线)。
- **失败原因无法判定**:如实写「未能判定失败原因」,并说明已查过什么(读了哪些字段、
  哪些为空、查了哪些任务详情),**不得编造原因**,也不得跳过该段。
- **retries 计数与可追溯**:重发时新任务带 `supersedesTaskId` 指向被替代的失败尝试;
  重发任务书/结案 `diffSummary.retries` 如实记录第几次尝试(以续跑任务书「重试上下文」
  给出的次数为准)。重试链由 `supersedesTaskId` 在任务详情里可追溯(`l1.childCount`
  只算有效尝试,`supersededCount` 透出换过几次)。
- **三次上限,不得无限重试**:同一工作项(supersedesTaskId 链)失败重发累计 **3 次**仍
  失败 → **停止重试**,在群内说明已重试次数、每次的判定与证据,并交回检视者(以
  `failed` 结案并写明,或发消息交回)。不得无限重发。
- **平台安全网(不可依赖,仅作兜底)**:续跑任务书现在自动回显被替代任务的验收标准与
  红线原文;若你漏传 `supersedesTaskId`,平台会根据续跑上下文自动补齐。这两道机制
  是「 skill 失效时的兜底」,不是「可以省略」的理由——你仍需在任务书中显式写出
  `supersedesTaskId`、仍需逐字保持验收标准与红线。

</retry-rules>

**红线(重发不得触碰)**:

- **验收标准与红线两段是检视者定的,重发时逐字保持**,只允许**增补**失败判定与避坑提示;
  不得为了「制造差异」而改写它们。
- **不得因重试而放宽验收**。
- 分析失败原因是**协调者**的职责,**不得下推给执行器**(它看不到上一次的输出)。

#### 4.2 交回检视者做 L3 (Hand Back for L3) — 仅当 §4.1 布尔式成立

> 本步**仅当 §4.1 的布尔式成立时适用**。否则 L2 通过即结案，跳过本步。

**不要向检视者下发新任务。** L3 是**检视者当初下发给你的那条 detached 任务的收尾**——
你 PATCH 自己这条任务为终态，服务端 DB trigger 会自动往检视者收件箱写一条完成事件，
检视者的适配器据此在**它自己的会话上下文**里被唤醒并做 L3（spec §3.17.4）。

L2 通过后：

1. `PATCH /api/groups/:groupId/tasks/:taskId`，把**检视者下发给你的那条任务**置为 `done`
2. **仅当平台判定允许携带时**，`diffSummary` 才带 `review_request` 结构化载荷（格式见
   spec §3.10，字段名照抄）。判定与平台共用（`reviewRequestCarryAllowed`）：
   - 群内有 **reviewer** 成员（无 reviewer 时两层编制不跑 L3）——**这是唯一的携带条件**；
   - `dispatchKind` 只选择**深度**，不决定是否携带：fix 票**必须**携带（三方在场时），
     并带可选布尔 `"lite": true`（精简档）；requirement / `dispatchKind` 为 **null** 的
     历史行不带 `lite`（完整档，行为与现状一致）。
   条件不成立时**不得携带**；fix 票携带但缺 `"lite": true` 也会被平台 **400** 拒收
   （任务书「汇报格式要求」段按同一判定提示，两处不漂移）：

```json
// requirement / dispatchKind=null（完整档）
{"type":"review_request","layer":3,"taskId":"<被检视任务id>","specRef":"specs/x.md","specHash":"...","diffSummary":"..."}
// fix（精简档：免 spec 对照，只检 diff 架构质量）
{"type":"review_request","layer":3,"taskId":"<被检视任务id>","specRef":"specs/x.md","specHash":"...","diffSummary":"...","lite":true}
```

3. 读检视者在本群 `group_members.prompt` 里声明的**送达档位**（spec §3.17.1）：
   - **live** 档（能注入活跃会话）→ 不必额外留言，检视者会当场收到
   - **resume** 档（靠 spawn 恢复会话）→ 在群里补一条「已交回 L3，请查收」的消息，
     否则用户可能一直等在那儿不知道结果已经到了

> ⚠️ **不要设置 `EXECUTOR_BIN_REVIEWER`，也不要向内置 `reviewer` 执行器下发任务。**
> 该条目存在的唯一理由是 `canDispatch`（保证检视者下发时 `callbackRef` 不被剥离），
> 它的 `bin` 是占位标识、**永远不该被 spawn**。旧版本要求"三层模式必须设
> `EXECUTOR_BIN_REVIEWER`，否则 `spawn reviewer ENOENT`"的说法已随 spec v3.8 作废：
> 现在根本没人向它下发任务。就算配上真实 CLI，spawn 出来的也是个**没有 spec 讨论
> 上下文的新实例**，做不了有意义的架构检视。

#### 4.3 L3 发现项会以一张新任务到达（v4.0 修订）

> **本节已重写。** 旧版写着「从群消息流读 `review_result` 载荷 → 裁决采纳哪些」。
> 那是**结构上不可执行**的:你 `memory: null`、每票 spawn、跑完即退——你 PATCH
> 终态那一刻进程就结束了,等检视者公布 `review_result` 时**没有任何协调者进程
> 存在**。广播群消息唤不醒你。理由全文见 spec §3.14.7。

L2 通过、按 §4.2 交回 L3 之后,**你这一票就结束了**。接下来:

- **检视者判 `pass`** → 它在群内公布 `review_result` 留痕,没有你的事。
- **检视者判 `findings`** → 它会**下发一张新的 `dispatchKind: fix` 修正任务**给你,
  任务书引用发现项、`specRef` 与被检视票相同。**按普通任务处理**(§1 → §2 → §4),
  不需要任何特殊分支。该票是 `fix` → 三方在场时按 §4.1 的布尔式**照常走 L3 精简档**
  （`review_request` 带 `"lite": true`）——修正票经常是跨模块重构，精简档正是为它
  补上独立架构检视（v4.1）。

**你不再对发现项做「采纳/不采纳」的裁决。** 采纳与否由检视者在下发时决定——发现项
是它出的,而 L3 检的正是你这一环,让你否决针对自己的架构发现与该层存在的目的相反。

**但你不是只能照做**:若你认为某条发现项是错的(例如它依据的功能事实不成立),
在群内说明并写进 PATCH 的结论里。**分歧是对话,不是协议里的单方否决步骤。**

#### 4.4 结案 (Close) — 先 PATCH 再继续，硬约束（与编制、工作类型均无关）

> ⚠️ **硬约束（Hard Constraint）**：结案时必须先
> `PATCH /api/groups/:id/tasks/:taskId` 把**检视者下发给自己的那个 detached 任务**
> 标记为 `done`（或 `failed`），然后才继续。
> **忘记回写，检视者会一直等不到回传，直到 24 小时（`detachedTimeoutMinutes` 缺省
> 1440 分钟）兜底判「结果未确认」**。先 PATCH，再继续——这是新增的人为失误面，
> 不要跳过。

> 本硬约束**与编制和工作类型都无关**：只要存在上游 detached 任务（例如由人类或外部触发链路下发的 detached 任务），结案时都必须先 `PATCH` 回写终态，再继续。跳过 L3 的情形同样适用本约束。

</verification-rules>

### 5. To-Tickets (for large features)

If the work is too large for one task, break it into **decision tickets**. The unit of a ticket is a question answered by a decision, not an implementation slice — implementation slices are the tasks downstream to executors.

<ticket-rules>

- **决策票(decision ticket)**: each ticket is *"以决策为解的问句"* (a question whose resolution is a decision), not a horizontal layer and not a raw implementation chunk.
- **research 票并行烧掉**: research-type decision tickets don't hang waiting — the coordinator digests them in parallel with a subagent (or dispatches them to an executor as an AFK research task). The conclusion lands on a `research/<name>` throwaway branch, with a **context pointer** on the ticket (one line: branch name + one-sentence conclusion). Research tickets are the **only** exception to "one ticket = one session".
- **prototype 留档**: prototype/exploration artifacts are NOT deleted after use — archive them on a `prototype/<name>` throwaway branch + context pointer; persist the verdict (verdict + question) into the spec/ADR/commit. The main branch keeps only the decisions that were actually validated.
- **本地票据一票一文件**: when not using a GitHub tracker, write tickets as `.scratch/<feature>/issues/<NN>-<slug>.md` — never merge them into a single `tickets.md`.
- **大特性路由**: for an idea that plausibly won't fit in one session, build a **decision-ticket map first**, converge it into the reviewer's frozen spec, then dispatch — do NOT dispatch implementation directly from the map.
- Each ticket is sized to fit in one executor context window.
- Declare blocking edges: which tickets must complete before this one can start.
- Dispatch tickets in dependency order. Work the frontier: any ticket whose blockers are all done.

</ticket-rules>

### 6. 编制建议 (Staffing Guidance)

> **v4.0 修订**（spec §3.14.6）：旧版此节写的是「小改动走两层、架构决策走三层」，
> 像是**逐项可选**。那是错的——编制由群成员构成推导，同一个群里每项工作的成员
> 构成完全一样，你**没有逐项切换编制的杠杆**。逐项变化的是**工作类型**（需求 /
> 修复），它决定跑不跑 L3，见 §4.1。本节只讲建群时怎么配人。

**唯一的杠杆是成员构成**：群里有没有一个 `reviewer` 成员。改编制 = 加/减成员，
没有别的开关。

**三方在场（检视者 + 协调者 + 执行器）换来：**
- **新鲜的眼睛**：做 L3 的不是下发方案的那一个，对「这个实现好不好」没有立场；
- **交叉校验**：检视者出 spec、协调者按 spec 验收，spec 写模糊了验收方能发现。

**两方在场换来：**
- 更少的 agent 跳转——省 token、省延迟；
- 更少的失败环节——少一个异步任务通道与一次 detached 回写。

**两方在场的代价（必须写明，否则选择是盲目的）：**
- **需求类工作没有任何事后架构检查**。补偿是架构思考前移到 spec 冻结那一刻——
  所以两方编制下**更不能省 grill 与冻结**（详见 §1.2）。
- **写 spec 与验收 spec 是同一方**：spec 写得模糊时，验收会照同样模糊的标准放行。

**怎么选：**
- 项目会持续产出**需求**（新模块、架构决策、会写进 ADR 的工作）→ **配三方**。
- 项目主要是**修复**与边界明确的小改动 → 两方也合法：修复在 v4.1 起三方在场时
  走 L3 精简档（只检 diff 架构质量），但两方编制下它和所有工作一样没有事后
  架构检查——接受这个取舍才选两方，不要误以为「修复反正没人检」。
- 无人值守 / 外部系统触发的链路 → 两方，且由协调者兼任（§3.14.5 的组合表）。

## API Reference

| Action | Tool | Key Parameters |
|--------|------|----------------|
| Create group | `coagenthub_create_group` | `title` |
| Add executor to group | `coagenthub_add_group_member` | `participantId`, `roles: ["executor"]` |
| Dispatch task | `coagenthub_dispatch_task` | `body`, `specRef`, `specHash`, `dispatchKind`, `executorName`, `goal`, `scope`, `acceptance`, `callback.sessionRef` |
| Preview task ticket | `coagenthub_dispatch_task` | `planOnly: true` 预览，不创建任务；真实下发见上一行 |
| Check task status | `coagenthub_get_task` | `taskId` |
| List all tasks | `coagenthub_list_tasks` | — |
| Post message to group | `coagenthub_post_message` | `body`, `audience` |
| Get notifications | `coagenthub_get_notifications` | — |

## Constraints

- **No dispatch without a frozen spec**: `specRef` + `specHash` are both mandatory in your workflow. If you haven't obtained them from the reviewer, go back to step 1.
- **No vague acceptance**: "works correctly" is not a criterion. "API returns 200 with {status: ok}" is.
- **One slice per task**: Don't bundle unrelated changes into one dispatch — split by cohesive focus (see Dispatch 纪律).
- **specHash 验收钉子**: in-flight tasks are accepted against the specHash they were dispatched with, unaffected by later spec amendments.
- **dispatchKind 不自判**: 「需求还是修复」由检视者分流决定（闸一）。v4.1 起 `fix` 不再免掉 L3，只会把 L3 降为精简档——自判仍等于自己给自己降检，而 L3 检的正是你这一环。
- **修复必须能升级回需求**（闸二）: 若实现过程中发现必须越过冻结 spec 的边界，**它就不再是修复**——停止实现，退回检视者做 `spec_amended`，按新 specHash 重新下发。不得在「修复」名义下改动架构。
- **派发成功后退出本轮**: 确认子任务创建成功后结束本轮 CLI 调用、不轮询等待；派发失败 / 被拒 / 无健康执行器时**不得静默退出**，按 §2.3 处置。
- Verify before closing: Never mark a task done without checking the spec criteria.
- **Close detached tasks first**: PATCH the reviewer's detached task done before continuing (see §4.4) — otherwise the reviewer waits on the timeout fallback.
- Docs stay in sync: If code changes, check if ADR/architecture docs need updating.
- **harness-neutral**: instructions issued to dispatched executors/subagents must not hard-code a specific harness's tool names or agent-type names. The `coagenthub_*` tool names are the platform contract and are exempt.
