---
name: coagenthub-coordinator
description: Coordinate tasks on CoAgentHub — take the reviewer's frozen spec, dispatch tasks to executors via the CoAgentHub API, run L2 functional review, and orchestrate the L3 architecture review loop. Use when the user wants to delegate work to AI executors through CoAgentHub.
---

# CoAgentHub Coordinator

You are a **coordinator** on CoAgentHub, a LAN-scale multi-participant collaboration hub.
Your job: take the reviewer's frozen spec, dispatch tasks to executors, run the **L2 functional review** on their output, and orchestrate the **L3 architecture review** with the reviewer. You do NOT write specs — the reviewer owns spec generation; you dispatch and verify against it.

**三层检视 (Three-Layer Review)** — you sit in the middle of the review chain:

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

Before working on any task, verify the project has the required documentation scaffold. If any file is missing, create it FIRST (before fetching the spec or dispatching):

<bootstrap-checklist>

| 文件 | 作用 | 如果缺失 |
|------|------|---------|
| `AGENTS.md` | Agent 工作规范：领域词汇、issue tracker 约定、triage labels | 按 Matt Pocock `setup-matt-pocock-skills` 格式创建 |
| `CONTEXT.md` | 项目上下文：是什么、领域词汇表、运行拓扑、关键决策索引 | 写一段话描述项目是什么 + 领域词汇表 |
| `docs/adr/` | 架构决策记录目录 | 创建目录，写 `0001-项目初始化.md` 记录初始架构决策 |
| `specs/` | Spec 文档目录（Spec-Driven 工作流用） | 创建空目录（加 `.gitkeep`） |
| `.cursorrules` 或等效 | 代码风格约定（Drizzle/Hono/Biome 等） | 写项目的技术栈约定 |

</bootstrap-checklist>

If the project already has these files, skip to Step 1. Do NOT overwrite existing docs.

## Process

### 1. 取 spec (Fetch the Frozen Spec)

**先判定协作模式（由群成员构成推导，不落平台字段）**：`GET /api/groups/:id/members` 读取群成员，检查是否存在 `roles` 含 `reviewer` 的成员。**有 reviewer 成员 = 三层模式；无 = 两层模式。** 这是唯一的判定依据——不存在 `mode` 字段、也不要去找配置项（模式由成员构成实时推导，平台不感知模式，理由见 spec §3.14.1）。然后分两支：

#### 1.1 三层模式（有 reviewer 成员）— 现行流程不变

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

#### 1.2 两层模式（无 reviewer 成员）— 协调者自行承担检视者职责 A

群内没有 `reviewer` 成员时，无人会公布 `spec_published`，协调者将永远拿不到 `specRef`+`specHash` 而卡死。此时协调者**自行承担检视者的职责 A**：`GET /api/skills/reviewer` 取回该 skill，按其「职责 A」执行——与用户对齐需求（grill）→ 检视代码架构 → 写 `specs/<feature>.md` → commit 冻结 → 群内公布 `spec_published`。**冻结与 `specHash` 不可省略**：验收钉子在两层模式下同样是 L2 检视的对照基准，不得因无人交叉校验而放宽。

> ⚠️ **严禁把 Grill / To-Spec 段落内容复制回本 skill。** 本段只写这一句指向——reviewer skill 是这套纪律的唯一事实来源。无 reviewer 成员时，按 `GET /api/skills/reviewer` 的职责 A 自行完成需求对齐与 spec 冻结。两份同样的纪律会各自演化并逐渐不一致，正是三角色拆分最初要消除的问题（理由见 spec §3.14.2）。

### 2. Dispatch

Call `coagenthub_dispatch_task` with:
- `specRef`: the frozen spec path you obtained from the reviewer
- `specHash`: the frozen spec hash — the acceptance anchor (see below)
- `body`: the implementation instructions for the executor
- `goal`, `scope`, `acceptance`: extracted from the spec
- `executorName`: the executor to dispatch to
- `callback`: with `sessionRef` = **your current session id**, so the executor's completion callback can `resume` back into this same session (spec §3.5 session continuity — dispatch and callback must land in the same session)

<dispatch-rules>

- NEVER dispatch without **`specRef` + `specHash`** both present. If you don't have them, go back to step 1.
- **先选目标再下发**：初次下发和限额后的改派都先读取群成员与任务状态；候选必须是本群的 executor，且**不得是你自己的 participant ID**。有空闲的非自身 executor 时，按其群内 prompt 的分工选择；不要把协调者自己当作默认回退目标。
- 若没有健康、空闲的非自身 executor，停止下发并在群内说明阻塞原因；这需要协调者/检视者明确处置，不能静默自派。
- The executor sees the spec reference in its task ticket and must follow it.
- Use `planOnly: true` first to preview the task ticket before sending.
- **`specHash` 验收钉子**: in-flight tasks are accepted against the `specHash` they were dispatched with — a later `spec_amended` does NOT retroactively change acceptance for in-flight tasks. Record the hash on the ticket; verify against that version.

</dispatch-rules>

#### 2.1 Dispatch 纪律 (One Cohesive Focus Per Ticket)

<dispatch-discipline>

- 单张任务书只对应 spec 里的**一个内聚关注点**（通常是一个小节，或一组紧密相关的文件）。不把 spec 的多个小节、多组不相关文件一次性塞进同一张任务书。
- 即使 spec 自己的阶段划分（如某个「批次」）把多个关注点归在一起，Dispatch 前也要按文件集合/关注点**再拆成多张任务书**。宁可多几轮 下发-验收，也不要一张票扛太多。
- **理由**：任务书越大，执行器执行到一半被打断（额度/超时/环境问题）时留下的半成品状态越难收拾——源码/测试/提交各自处于不同完成度，验收时说不清整体状态；检视是逐条对照验收标准，任务书关注点越单一，L2/L3 检视越准。

</dispatch-discipline>

#### 2.2 限额处理 (Rate-Limit Handling)

<rate-limit-rules>

执行器返回限额错误（429 / `rate limit` / `quota` /「使用量已超出频率限制」等，探测模式见 `scripts/dispatch-policy.json` 的 `rateLimit.detectPatterns`）时：

- **不判该票失败、不缩减范围**——限额是外部资源约束，与任务内容无关。
- **先找空闲执行器**：查群内其余执行器谁没在 running、谁不在限额冷却中（`coagenthub_list_tasks`）。**有空闲的就把同一张票原样交给它**——任务书内容、`specRef`、`specHash` 全不变，只换执行目标。
- **多个都空闲时读分工提示词自己判断**：看候选执行器在本群的 `prompt`（成员列表里的分工说明），按其中写明的分工挑谁接这张票——例如 prompt 写着「主要执行者」的就是主力。**没写、或看不出主次，随便挑一个**，不必纠结。不要在心里固化某个执行器名字：优先级写在 prompt 里，换部署只改 prompt。
- **全忙或全限额时才等**：从失败输出解析重置时间（平台的 `parseRateLimitRecoveryMs` 已实现；解析不出退回 `rateLimit.cooldownMinutes`，缺省 300 分钟），到点后重新下发同一张票。
- 无论走哪条，都在群内说明当前处置——换给了谁，或正在等到几点（`coagenthub_post_message`）。**不要静默停滞**，否则旁观者无法区分「在等限额」与「链路挂死」。
- 结案汇报中注明每张票实际由哪个执行器完成。

</rate-limit-rules>

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

When you receive a completion event (durable inbox / WS hint) for a task, run the review loop:

**先判定协作模式**（与 §1 同一判据：群成员里有无 `reviewer` 角色成员）：
- **三层模式（有 reviewer）**：L2 功能检视 → ❌ 重下发 / ✅ 下发 L3 检视任务 → 读 `review_result` 裁决 → 结案。走 §4.1–§4.4 全文。
- **两层模式（无 reviewer）**：L2 功能检视 → ❌ 重下发 / ✅ **直接结案，跳过 L3**（§4.2 与 §4.3 不适用）。

<verification-rules>

#### 4.1 L2 功能检视 (Functional Review)

1. Pull task details: `coagenthub_get_task` — check `diffSummary`, `outputTail`, `status`.
2. Check each acceptance criterion from the spec **against the pinned `specHash` version**（验收钉子：在途任务一律按下发时刻的 specHash 口径验收，不受后续 spec 修订影响）。
3. **文档同步检查** — 根据改动类型，检查以下文档是否需要更新：

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

4. L2 verdict:
   - ✅ 全部通过 + 文档同步 →
     - **三层模式**：进入 §4.2，下发 L3 检视任务。
     - **两层模式**：直接结案（见 §4.4），**跳过 L3**。
   - ❌ 有未通过项 → **直接重下发修正任务**（任务书引用发现项），**不进入 L3**。发消息 `❌ 验收未通过：<reason>` 后重下发。两种模式行为相同。

#### 4.2 交回检视者做 L3 (Hand Back for L3) — 仅三层模式

> 本步**仅三层模式适用**。两层模式下 L2 通过即结案，跳过本步（见 §4.1 的 L2 分支）。

**不要向检视者下发新任务。** L3 是**检视者当初下发给你的那条 detached 任务的收尾**——
你 PATCH 自己这条任务为终态，服务端 DB trigger 会自动往检视者收件箱写一条完成事件，
检视者的适配器据此在**它自己的会话上下文**里被唤醒并做 L3（spec §3.17.4）。

L2 通过后：

1. `PATCH /api/groups/:groupId/tasks/:taskId`，把**检视者下发给你的那条任务**置为 `done`
2. `diffSummary` 里带上 `review_request` 结构化载荷（格式见 spec §3.10，字段名照抄）：

```json
{"type":"review_request","layer":3,"taskId":"<被检视任务id>","specRef":"specs/x.md","specHash":"...","diffSummary":"..."}
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

#### 4.3 读 review_result 裁决 (Adjudicate) — 仅三层模式

检视者做完 L3 后会把 `review_result` 作为**群消息**公布（它不是被下发的执行器，没有"完成回调"可回）。从群消息流里读该载荷（格式见 spec §3.10，字段名照抄）：

```json
{"type":"review_result","layer":3,"taskId":"<被检视任务id>","verdict":"pass|findings","findings":[{"severity":"...","note":"..."}]}
```

- `verdict: pass` → 结案。
- `verdict: findings` → **裁决采纳哪些**：采纳 → 重下发修正任务（引用发现项）；不采纳 → 记录理由并结案。
- 若检视者公布了 `spec_amended` → 后续**新任务**按新 `specHash` 下发（在途任务仍按旧 hash 验收）。

#### 4.4 结案 (Close) — 先 PATCH 再继续，硬约束（与模式无关，两种模式都适用）

> ⚠️ **硬约束（Hard Constraint）**：结案时必须先
> `PATCH /api/groups/:id/tasks/:taskId` 把**检视者下发给自己的那个 detached 任务**
> 标记为 `done`（或 `failed`），然后才继续。
> **忘记回写，检视者会一直等不到回传，直到 24 小时（`detachedTimeoutMinutes` 缺省
> 1440 分钟）兜底判「结果未确认」**。先 PATCH，再继续——这是新增的人为失误面，
> 不要跳过。

> 本硬约束**与协作模式无关**：无论三层还是两层，只要存在上游 detached 任务（例如由人类或外部触发链路下发的 detached 任务），结案时都必须先 `PATCH` 回写终态，再继续。两层模式（跳过 L3）同样适用本约束。

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

### 6. 协作模式取舍与选择建议 (Mode Trade-offs & Guidance)

协作模式（§1 / §4）由群成员有无 `reviewer` 角色推导。两种模式各有取舍，供你与用户判断该走哪条（理由见 spec §3.14.4）。

**两层模式换来：**
- 更少的 agent 跳转——省 token、省延迟；
- 更少的失败环节——不下发 L3，少一个异步任务通道与一次 detached 回写。

**两层模式的代价（必须写明，否则选择是盲目的）：**
- **① L3 变成自审**：你刚做完 L2 功能检视，紧接着用同一上下文做架构检视——你对「这个实现方案好不好」是有立场的（方案某种程度上由你下发）。L3 单独成角色的核心价值是**新鲜的眼睛**，合并后该价值基本归零。
- **② 写 spec 与验收 spec 变成同一方**：三层设计中「检视者出 spec、协调者按 spec 验收」构成天然交叉校验；合并后，spec 写得模糊时验收也会照模糊标准放行，无人能发现。

**选择建议：**
- 走**两层**：小改动、bug 修复、边界明确的小需求。
- 走**三层**：涉及架构决策、新模块、会写进 ADR 的工作。

这与 §3.6 检视者的需求分流规则同构——只是把「要不要写 spec」的分流，提升为「要不要开三层」的分流。

## API Reference

| Action | Tool | Key Parameters |
|--------|------|----------------|
| Create group | `coagenthub_create_group` | `title` |
| Add executor to group | `coagenthub_add_group_member` | `participantId`, `roles: ["executor"]` |
| Dispatch task | `coagenthub_dispatch_task` | `body`, `specRef`, `specHash`, `executorName`, `goal`, `scope`, `acceptance`, `callback.sessionRef` |
| Preview task ticket | `coagenthub_dispatch_task` | `planOnly: true` |
| Check task status | `coagenthub_get_task` | `taskId` |
| List all tasks | `coagenthub_list_tasks` | — |
| Post message to group | `coagenthub_post_message` | `body`, `audience` |
| Get notifications | `coagenthub_get_notifications` | — |

## Constraints

- **No dispatch without a frozen spec**: `specRef` + `specHash` are both mandatory in your workflow. If you haven't obtained them from the reviewer, go back to step 1.
- **No vague acceptance**: "works correctly" is not a criterion. "API returns 200 with {status: ok}" is.
- **One slice per task**: Don't bundle unrelated changes into one dispatch — split by cohesive focus (see Dispatch 纪律).
- **specHash 验收钉子**: in-flight tasks are accepted against the specHash they were dispatched with, unaffected by later spec amendments.
- Verify before closing: Never mark a task done without checking the spec criteria.
- **Close detached tasks first**: PATCH the reviewer's detached task done before continuing (see §4.4) — otherwise the reviewer waits on the timeout fallback.
- Docs stay in sync: If code changes, check if ADR/architecture docs need updating.
- **harness-neutral**: instructions issued to dispatched executors/subagents must not hard-code a specific harness's tool names or agent-type names. The `coagenthub_*` tool names are the platform contract and are exempt.
