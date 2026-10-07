# COM9 技术恢复路径调查报告与后续工单草案（2026-10-07）

范围：**只读调查 + 工单草案**。本文件不实现任何草案、不改 src/test/.coagent、不冻结任何规则。

基线：完整 HEAD `841c6cf394a798273fee4ac6fb83d0f00700a3d8`（`841c6cf`）。
本报告中的三类信息严格区分：

- **当前源码事实**：对着上面这个 HEAD 读出来的 `文件:行`。
- **历史 HTTP 事实**：对运行中平台 `http://127.0.0.1:3101` 的只读 `GET`（`/api/missions/<id>`、`/api/missions/<id>/activity`）读到的落库记录。**它证明过去发生过什么，不证明现在的代码会怎么做。**
- **待 L3 冻结建议**：本报告提出的路径与草案，一律「未验证、未实施」。

核对方式：只读 HTTP，六个 URL —— `/api/missions/{AC4-platform-closeout-20261004,COM2-communication-20261004,COM3-B2b-impact-supervision-20261005}` 及各自 `/activity`，本次全部返回 200（字节数 49003 / 42230 / 329337，activity 分别 184 / 94 / 1098 条事件）。未重现真实 agent、未执行快照、未跑任何 `node --test`。

---

## 0. 结论速览

当前 kernel 状态机（`src/kernel/work-item.ts:54–75`）里 `accepted` / `retired` **都能 `dispatch`**（第 67、74 行），但四类恢复场景在 Application 层被门禁挡住或语义不足；第五类是工作区层的 dirty 基线问题。逐类结论：

| # | 场景 | 现在会怎样 | 卡在哪一层 | 是否需要 L3 判断 |
|---|---|---|---|---|
| ① | accepted 工作项需要补做 | 不能修订（`WORK_ITEM_NOT_REVISABLE`），也不能退休 | Application `work-order-helpers.ts:13` | **不需要**（技术路径） |
| ② | rejected 工作项不能直接 accept | kernel 抛 `ILLEGAL_TRANSITION` | kernel 状态机（不变量 A） | **不需要**（技术路径） |
| ③ | retired 工作项的目标仍要完成 | retired 单不能修订；同目标需**新建引用原 id 的替代单**承接 | Application `work-order-helpers.ts:14` + 规则出处 | 历史实例**曾需 L3 特批**；L3 一次冻结规则后，同目标/验收/范围内的替代补修属 L2 技术恢复，**不再逐案需要 L3** |
| ④ | Attempt `killed_wall_clock` 后 item 仍锁在 dispatched | 不能修订，插件无收尾入口 | Application：无 killed 的可信收尾 | 停止证据**须由可信平台提供**；平台具备该能力后同类收尾属规则内技术恢复，不必逐案 L3 |
| ⑤ | 被杀执行者留下的未提交半成品 | 后续精确小单的 checkpoint **必然失败** | `workspace.ts:453` 普通 `Error` | 快照保存**须由可信平台**按原授权路径与原字节执行；规则冻结后同范围内不需逐案 L3 |

**历史 vs 未来规则（本次修正，必须区分）**：③④⑤ 在 2026-10-04/05 的实例里确实由 L3 **逐案特批**过（原始记录见 §1），但这**不等于**未来每一例都要 L3 介入。L3 把规则**一次性冻结**之后：

- ③「retired 单的目标仍要完成」：只要目标、验收、范围都不变，协调者**新建引用原 id 的替代/补修单**是 L2 技术恢复，**不需要逐案升级**。
- ④ 停止与 revoke 必须由**可信平台**证明（执行者已停止、token 已吊销、无活写者、该 item 未提交且仍是 `dispatched`），**不能由 L2 自己口头宣布**；证据齐备即按规则收尾，不必逐案 L3。
- ⑤ 半成品保存必须由**可信平台**证明来源（原 Mission 授权路径）与原字节，并在**旧写者已退出**的条件下持久保存责任，**不需要逐案批准**。

反之，**来源未知、目标/验收/范围变化、或规则未覆盖**（例如证明不了执行者已停、证明不了快照来源）时，仍一律升级 L3。下面 §2 每类的「L3 必要性」统一按这条口径写成「历史曾需 / 未来规则内不需」两段。

**不要新增解锁状态边**：①③④⑤ 都能用「新建引用原 id 的单 / 阻断自愈 / 先持久 intent」在**不改 kernel 流转表**的前提下合法化。撤销或新增 `accepted→created` 之类的边会破坏不变量 A 与「未经 L3 不得 completed」的历史语义。

---

## 1. 五类现状：源码事实 vs 历史记录

### 1.0 复用的稳定事实（第 1–4 类共同的判据）

- 工作项流转表：`src/kernel/work-item.ts:54–75`
  - `created: ['dispatched','blocked','retired']`（:54）
  - `dispatched: ['submitted','blocked','retired']`（:55）
  - `submitted: ['accepted','rejected','retired']`（:56）
  - `accepted: ['dispatched']`（:67，**没有** `retired`）
  - `rejected: ['dispatched','retired']`（:68）
  - `blocked: ['dispatched','retired']`（:71）
  - `retired: ['dispatched']`（:74）
  - 非法流转统一抛 `IllegalTransitionError`，`code='ILLEGAL_TRANSITION'`：`src/kernel/errors.ts:31–42`（:37 生成 code）；表驱动的 `#goto` 在 `work-item.ts:365–370`。
- 修订门禁：`src/kernel/work-item.ts:250–260` 只允许 `created` / `rejected` / `blocked`（:251–256）；Application 先行拒绝并给提示：`src/application/platform/work-orders.ts:63–66`，错误码 `WORK_ITEM_NOT_REVISABLE`（:65）。提示表 `src/application/platform/work-order-helpers.ts:10–15`。
- 派发门禁：`src/application/platform/work-item-dispatch.ts:32–38`，可派发集合是 `['created','rejected','blocked','accepted']`（:32），其余抛 `NOT_DISPATCHABLE`（:35）。**`retired` 不在集合里** —— 这是「kernel 允许 `retired→dispatched`，但 Application 走协调者工具时派不动」的分叉点。
- 「未修订不得原样重派」门禁：同文件 :40–67，抛 `WORK_ORDER_REVISION_REQUIRED`（:62），比对上一条 `blocked.reported` 或 `partial/blocked` 结果的 `orderRevision`。
- 作废：`src/application/platform/mission-control.ts:10–40`（`:26–28` 抛 `NOT_RETIRABLE`，`retired` 与 `accepted` 都拒）；HTTP 入口 `src/api/server.ts:1486–1494`（仅协调者，S14.6）。
- Attempt 流转表：`src/kernel/attempt.ts:53–57`，`in_progress:['succeeded','failed']`；`killed_wall_clock` 是结束原因枚举（:45–46），`KILLED_BY_US`（:51）。收尾写状态在 `src/application/platform/attempts.ts:129–133`：**只有** `endedBy==='structured_submit'` 走 `succeed()`，其余一律 `fail()`（:131–132）。
- Mission 流转表：`src/kernel/mission.ts:72–79`，`completed: []`（:78）——**没有任何状态直接进 completed**，只有 L3 检视。
- 验证基线：`src/application/platform/standard-validation.ts:46–57` 记录、:169–174 取用；取不到抛 `VALIDATION_BASELINE_MISSING`（:172），**拒绝用 Mission base 顶上**。
- checkpoint 范围门禁：`src/application/workspace.ts:150`（接口签名）与 `:426–465`（实现），`outside` 非空抛普通 `Error('检查点包含未授权改动：…')`（:453）——**没有独立业务码**。

### ① accepted 工作项需要补做

**实例（历史 HTTP）**：`AC4-platform-closeout-20261004`。`/activity` 里 `review.recorded W-460 verdict=accept` 落在 `2026-10-04T06:03:30.496Z`；`final_review.send_back` 在 `06:04:18.901Z` 打回，指出验收 5 的报告事实仍有两处错误。协调者随即在 `06:06:49.011Z` `escalated`：*「请将已accepted的W-460解锁为可修订/重新派发状态；平台拒绝对其修订，与本轮优先修正已有工单的指示冲突」*。L3 在 `06:07:37.338Z` `escalation.answered` 明确：**保留 W-460 accepted 及真实证据，不解锁、不放宽状态门禁、不原样派发旧 r2**，新建一张仅修正收尾报告事实的后续工作项。实际执行：`review.recorded W-461 accept` 落在 `06:15:59.416Z`，`final_review.merged` 落在 `06:17:07.583Z`；只读 `GET /api/missions/AC4-…` 现返回 `status=completed`，`W-460 accepted rev r2`、`W-461 accepted rev r1`。

**源码事实**：修订 `accepted` 报 `WORK_ITEM_NOT_REVISABLE`（`work-orders.ts:65`，提示原文来自 `work-order-helpers.ts:13`），kernel 侧同样抛 `ILLEGAL_TRANSITION`（`work-item.ts:250–256`）；作废 `accepted` 报 `NOT_RETIRABLE`（`mission-control.ts:26–28`）。所以「就地返工 accepted」在当前源码下**无路径**，与历史记录一致。

**当前源码 vs 历史记录**：历史记录说的是 2026-10-04 那次的实际行为；`work-order-helpers.ts:13` 与 `mission-control.ts:26` 在 `841c6cf` 下仍是同样判定，故结论**延续**，但本报告未在 841c6cf 上重现该 Mission。

### ② rejected 工作项不能直接 accept

**实例（历史 HTTP）**：`COM2-communication-20261004`。`review.recorded W-463 verdict=reject` 在 `2026-10-04T11:25:14.312Z`（原因：VR-162 只暴露 `passed=true`，无法验收第 4 条）。协调者试图直接 accept，得到 `WorkItem: rejected -> accepted is not allowed`，于 `11:29:41.932Z` `escalation.answered` 里 L3 **纠正自己先前「直接重新 accept」的要求**：*「我先前要求直接重新accept不可执行，现纠正为合法修订/重新提交路径，禁止直接改状态」*。合法路径随后依次发生：`work_item.order_revised W-463 {revision:r2}`（`11:32:01.545Z`，`changedFields` 含 objective/requiredBehaviour/verification 等）→ 新 `attempt.started`（`11:34:14.192Z`）→ `execution_result.submitted {outcome:completed, changedFiles:0, orderRevision:r2, contractRevision:2}`（`11:34:53.614Z`）→ `review.recorded verdict=accept`（`11:41:45.564Z`）。只读 `GET /api/missions/COM2-…` 现返回 `status=completed`、`contractRevision=2`、`W-463 accepted rev r2`。

**源码事实**：`rejected` 的出边只有 `['dispatched','retired']`（`work-item.ts:68`）；到 `accepted` 的唯一通路是 `submit`（`56`→`accepted`，由 `review('accept')` 触发）。直接 accept 必然 `ILLEGAL_TRANSITION`。`rejected` **可修订**（`work-item.ts:251–256` 含 `rejected`；`work-order-helpers.ts` 的 `REVISE_BLOCKED_HINT` 没有 `rejected` 键，故 Application 不拦）。

**关键分叉**：`rejected` 单若历史上有过 `partial`/`blocked` 结果，重派还会撞 `WORK_ORDER_REVISION_REQUIRED`（`work-item-dispatch.ts:40–67`）——这正是 `test/platform.test.ts:1044–1130`（W-292 组）覆盖的行为。

### ③ retired 工作项的目标仍要完成

**实例（历史 HTTP）**：`COM3-B2b-impact-supervision-20261005`。`W-472` 先 `attempt.ended endedBy=killed_wall_clock`（`2026-10-05T05:00:55.933Z`），再 `work_item.retired`（`05:13:34.655Z`，理由记「半成品保留不回滚；恢复需协调者先审未提交diff，不原样重派」）。协调者在 `05:16:55.230Z` 同时产出 `contract_check.submitted {verdict:issues}` 与 `escalated`，原文：*「W-472 retired（coagent_get_work_item确认），work-order-helpers.ts:14禁止修订退休单；无恢复工具。用户要求优先修正已有单且仅独立新工作可新增，而此处是原权威路径未完成，不是独立新工作。请恢复可修订状态或明确授权替代。」*。L3 在 `05:17:31.944Z` 答复：*「W472由我为runaway恢复退休，保持retired，不恢复/编辑状态、不绕修订门禁。**优先修正已有可修订工单的规则不要求复活退休单**；本轮可新建引用W472与本答复的替代补修工单」*，并给出拆单原则。协调者在 `05:20:53.789Z` 又提了一次重复升级，L3 沿用同一答案（`05:20:53.787Z` 那条）。实际执行：`work_item.created W-474 {title:'补修W-472 Application impact双claim事务权威路径'}` 在 `05:29:26.718Z`；`W-472`/`W-473`/`W-474` 最终均 `retired`，`GET /api/missions/COM3-…` 现 `status=completed`（`contractRevision=5`）。

**源码事实**：`retired` 单不能修订（`work-order-helpers.ts:14`；kernel 侧 `work-item.ts:250–256` 不含 `retired`）；协调者工具也派不动它（`work-item-dispatch.ts:32–38` 的可派发集合不含 `retired`）——**注意 kernel 自身允许 `retired→dispatched`**（`work-item.ts:74`）。作废侧 `NOT_RETIRABLE` 会挡住「再退休一次」，但这是幂等保护，不影响新单承接。

**当前源码 vs 历史记录**：以上源码判定在 `841c6cf` 下**不变**；历史记录只证明 10-05 当时平台是这么表现的。

### ④ Attempt `killed_wall_clock` 后工作项仍锁在 dispatched、不能修订

**实例（历史 HTTP）**：`COM3-…` 的 `W-474`。`attempt.ended {endedBy:killed_wall_clock, failureMessage:'子进程退出 code=1 且没有回传结果。stderr: (空)'}` 落在 `2026-10-05T06:34:57.440Z`；协调者在 `08:52:34.566Z` `/api/missions/COM3-…` 的 escalation #5 里写：*「请解除W-474已killed_wall_clock Attempt的执行中修订锁（或核实仍有活执行者并安全收尾），使原W-474可按r3修订接续；平台当前拒绝修订，L2不能退休重建绕过。」* L3 在 `08:52:34.567Z` 答复：*「已核实W-474.exec-1权威failed/killed_wall_clock，执行者已停止；插件无dispatched死锁解除工具，**不能直接改状态或伪造blocked**。已由L3合法retire W-474并发布r4解除此前禁止替代的恢复…」*。随后 `work_item.retired W-474` 在 `08:52:33.724Z` 落库（理由明确「真实Attempt W-474.exec-1 failed/killed_wall_clock且无活动executor；WorkItem残留dispatched阻止合法修订，插件无死执行锁解除入口」）。

**源码事实**：`finishAttempt` 在 `attempts.ts:129–133` 把 `killed_wall_clock` 记成 `attempt.fail()`（`endedBy==='structured_submit'` 才 `succeed()`）；Attempt 变 `failed`，但**工作项状态一个字都不改**——`WorkItem` 没有「Attempt 失败即回退」的边（`work-item.ts:54–75`），因此 item 留在 `dispatched`。而 `dispatched` 恰好是 `WORK_ITEM_NOT_REVISABLE` 的键（`work-order-helpers.ts:11`），于是「执行者已死、工单锁在运行中」成为死锁。orchestrator 侧确认 runaway 的分支在 `src/application/orchestrator.ts:2398`（`runaway=true`）、`:2469`（落 `killed_wall_clock`）、`:2583–2600`（返回 `exhausted:'runaway_suspected'`，**不回滚工作区**）。

**当前源码 vs 历史记录**：`attempts.ts:129–133` 与 `work-item.ts:54–75` 在 `841c6cf` 下未变，死锁**仍然成立**；历史记录是 10-05 的实证。

### ⑤ 被杀执行者留下的未提交半成品让后续精确小单的 checkpoint 必然失败

**实例（历史 HTTP）**：`COM3-…` escalation #3/#4。`05:24:25.751Z` 与 `05:25:16.403Z` 两条升级原文：*「当前9 tracked修改+1 untracked helper横跨Application/HTTP/issuer；src/application/workspace.ts:450-452在stage前拒绝所有不属于当单allowedPaths的dirty路径。**任何精确小单都因其他组既有半成品失败**，串行也无法解决初始脏基线」*、*「已确认workspace.checkpoint按全worktree dirty集合做范围门禁，W-472的10个未提交半成品路径导致任何精确替代小单必失败」*。L3 答复（`05:25:16.403Z`，沿用 `05:24:00.976Z` 那条）：*「批准协调者在本Mission隔离分支直接保存一次未验收Git恢复…」*——即先做一次「未验收恢复快照」，再放精确小单。

**源码事实**：`workspace.ts:426–465`。`checkpoint` 先取 `git status --porcelain=v1 -z --no-renames --untracked-files=all`（:450），把 **整个 worktree 的 dirty 集合**逐个与当单 `allowedPaths` 比（:451–453），任何不属于本单的路径直接 `throw new Error('检查点包含未授权改动：…')`（:453），**普通 `Error`，无独立业务码**（对比 `NOT_DISPATCHABLE` 这类 `PlatformRuleError`——调用方只能靠 message 匹配）。orchestrator 在 `:2504–2527` 调 checkpoint，失败时把执行者已交回的改动**留在工作区**（:2522 文案「改动保留在工作区，已停止后续执行」）并返回 `exhausted:'no_available_agent'`——**不回滚**。

**当前源码 vs 历史记录**：`:453` 在 `841c6cf` 下是普通 `Error`，与历史记录一致；「dirty 基线导致精确小单必失败」的机制**依然成立**。注意 `WorkspaceManager.checkpoint` 是接口上的**可选方法**（`workspace.ts:150`），orchestrator 对不实现它的非 InPlace 实现会直接抛错（`:2518–2519`）。

---

## 2. 每类的判断、合法路径、最小层级改动、不变量、风险

对每一类都给出五段：**是否需要 L3 判断**、**可写成规则的合法路径**、**平台最小改动与所在层**、**会碰到的既有测试与不变量**、**风险与不做什么**。

### ① accepted 需要补做

- **L3 必要性**：**不需要**。目标不变、验收不变、范围不变，纯技术路径。
- **合法路径**：保留原 `accepted` 记录不动，**新建一张补修单**，在其 `contextRefs` / `requiredBehaviour` 里引用原工作项 id（这里是 `W-460`）与它已满足的验收标准，由新单承担剩下的（这里是验收 5 的报告事实纠错）。历史 HTTP 里 L3 就是这个组合（`W-460` 保留、`W-461` 承接）。
- **最小改动 / 层级**：**零 kernel 改动**。现有 `createWorkItem` 已支持写 `contextRefs`/`requiredBehaviour`；若要让协调者「知道可以这么干」，只需在 `work-order-helpers.REVISE_BLOCKED_HINT.accepted`（`work-order-helpers.ts:13`）与 `work-item-dispatch.dispatchWorkItems` 的 `NOT_DISPATCHABLE` 文案（`work-item-dispatch.ts:35–37`）里各补一句「accepted 若要补做请新建引用原 id 的补修单」。**不改状态边**。
- **不变量 / 既有测试**：`accepted` 不能进 `retired`（`work-item.ts:67`；`mission-control.ts:26` 拒 `NOT_RETIRABLE`）；「到达 accepted 只有 `review('accept')` 一条」不被削弱（`work-item.test.ts:190–214` 明确断言）。Mission 交卷只认 `accepted`/`retired`（`mission-control.ts` `WORK_ITEMS_UNFINISHED` 分支）。
- **风险 / 非目标**：不把补修单写成「重做已验收的验收 1–4」——那会重复计功。非目标：不新增 `accepted→created`、不自动 `completed`、不放宽 `NOT_RETIRABLE`。文档来源/历史事实纠错若涉及「对外宣称平台状态」仍需升级。

### ② rejected 不能直接 accept

- **L3 必要性**：**不需要**。这是已知的合法路径，L3 自己在 `COM2` `11:29:41.932Z` 答复里纠正过一次，说明它属于技术层可写清楚的规则。
- **合法路径**：`rejected` → `reviseOrder`（r+1）→ `dispatch` → 新 Attempt `submit` → `submitted` → L2 `review('accept')`，并绑定**新的** `submittedAttemptId` / 新 VR。历史 HTTP 完整走出这条链：`revision=r2`（`11:32:01.545Z`）→ `orderRevision=r2, contractRevision=2` 的 `execution_result.submitted`（`11:34:53.614Z`）→ `accept`（`11:41:45.564Z`）。证据不全时**保留 `submitted`、先 `get_validation_report`**，不要先 `reject` 再补证（会造成 reject↔re-submit 循环，COM2 差点撞上）。
- **最小改动 / 层级**：**零 kernel 改动**。`rejected` 本就在可修订集合（`work-item.ts:251–256`）与可派发集合（`work-item-dispatch.ts:32`）里。若希望协调者「第一步就知道要先修订」，可在 reject 的返回提示里点名 `coagent_revise_work_order`（**在 Application 文案层**）。若历史上有 `partial`/`blocked` 结果，则**必须先修订**才过 `WORK_ORDER_REVISION_REQUIRED`（`work-item-dispatch.ts:62`）——这条已经在。
- **不变量 / 既有测试**：不变量 A（唯一入口 `review('accept')`）、`test/work-item.test.ts:169–175`（`created` 上 `submit`/`review` 非法）、`test/platform.test.ts:1067–1130`（W-292：`partial` 被 reject 后同修订号重派被拒、修订后放行）。不得为了让「直接 accept」通过而改这些断言。
- **风险 / 非目标**：不要用「先 reject 再 accept」凑合，也不要伪造 `submitted`。非目标：不新增 `rejected→accepted` 边，不伪造新 Attempt 的 provenance。

### ③ retired 的目标仍要完成

- **L3 必要性**：**历史曾需特批，未来规则内不需逐案**。把 retired 单的目标搬到新单，历史上（`COM3` `05:17:31.944Z`）是 L3 逐案授权的「合法替代」；但一旦 L3 把「retired 单不复活、同目标新建引用原 id 的替代单」这条规则**一次冻结**，此后**同目标、同验收、同范围**的替代补修就只是 L2 技术恢复，不必每例再取一次授权。真正的责任判断只剩下「有没有改变目标/验收/范围」——变了才升级。
- **合法路径**：保持原单 `retired` 不动（保留「为什么作废」的历史），**另建一张替代/补修单**，`contextRefs` 引用原 id（`W-472`）与该次 L3 答复编号；同目标未完成部分在新单里接受验收。历史 HTTP 里 L3 给的拆单维度是「按可独立验证调用点」（application fenced 用例+测试 / HTTP 限权入口+真实 HTTP 测试 / 可信 issuer 装配），并允许合并强耦合调用点，但**禁止原样 15 文件重派**。规则冻结后，这条路径**不再逐次升级**——直接在允许范围内新建替代单即可。
- **最小改动 / 层级**：**零 kernel 改动**。若要让 Application 的提示不再把协调者引向「复活退休单」，只需把 `work-order-helpers.ts:14` 的 `retired` 提示与 `work-item-dispatch.ts` 的门禁文案改成「retired 不能修订；要完成同一目标请新建引用原 id 的替代单」。**不写「并在升级里取得 L3 授权」**——规则冻结后同目标/验收/范围的替代补修不需要逐案授权，写进去反而把技术恢复误述成每次都要特批。**不要**为了「就地续做」把 `retired` 加进可修订集合——那会抹掉「为什么作废」的记录。
- **不变量 / 既有测试**：`WORK_ITEMS_UNFINISHED` 只放行 `accepted`/`retired`（`mission-control.ts`），所以「retired 当完成」是被允许的**计数**语义，但**不等于目标已达成**——替代单必须真验收。`kernel` 允许 `retired→dispatched`（`work-item.ts:74`）是给「L3 判断它其实还要做」的出口，**不构成协调者绕过修订门禁的路径**。
- **风险 / 非目标**：不要把「retired 被计入未完成=0」当成目标已完成；共享脏文件必须串行并如实声明来源（COM3 里 L3 的原话）。非目标：不复活退休单、不自动换候选、不放宽预算与 checkpoint。

### ④ killed Attempt 后 item 锁在 dispatched

- **L3 必要性**：**历史曾需特批，未来由可信平台证明后不需逐案**。判据是「执行者是否真的已停止、有没有活执行者」，这是**可信性判断**，不该由协调者自己口头宣布——L3 在 `COM3` `08:52:34.567Z` 明确「不能直接改状态或伪造 blocked」。未来这条证明责任落在**可信平台**身上：平台在确认（见下）后按规则收尾，**不需要 L2 逐案升级**；只有当平台**证明不了**（拿不到停止/revoke 证据）时才升级。
- **合法路径（待冻结）**：**可信调度器/平台**（不是 L2 的口头宣布）证明「执行者已停止、token 已吊销、无活写者、该 item 未 `submit` 且仍是 `dispatched`」之后，用**现有**的 `item.recordBlocked(...)`（`work-item.ts:288–294`，`dispatched→blocked`）转 `blocked`，并记录**平台侧恢复原因**与**证明来源**（例如「请求的运行已结束、token 已吊销、无活动执行者」）。**不得以 L2 的叙述替代这套平台证明。**这样 item 离开 `dispatched`，修订门禁解锁（`blocked` 不在 `REVISE_BLOCKED_HINT` 里），之后**必须先修订再重派**，并过 `WORK_ORDER_REVISION_REQUIRED`（`work-item-dispatch.ts:62`）。
- **最小改动 / 层级**：Application 层小改——在 `src/application/platform/attempts.ts` 的 `finishAttempt`（:64–177，状态写在 :129–133）里判定「`endedBy` ∈ `KILLED_BY_US`（`attempt.ts:51`）且该 item 仍 `dispatched`」时触发收尾，或抽一个**小 helper**（例如 `recoverKilledExecutorAttempt`）由 `platform.ts` 少量接线 + orchestrator 的 `finally`（`orchestrator.ts:2454–2502`，`killed_wall_clock` 在 :2469）可信调用。**不动 `kernel.recordBlocked`**（它已经支持该边）。禁止伪造「执行者 reportBlocked」——这是两回事：一个是执行者的判断，一个是平台对失联执行者的收尾。
- **不变量 / 既有测试**：不变量 B（同一 item 只有一个 `in_progress` executor，`work-item.ts:178–190` 的 `CONCURRENT_EXECUTOR_ATTEMPT`）；单写者事务（`context.ts:100–150` 的 `tx`/`txFenced`，`attemptWrite` 的 `QUEUE_CLAIM_REQUIRED`）；`test/orchestrator.test.ts:3200–3290`（墙钟强杀：`endedBy='killed_wall_clock'`、不虚报 complete）、`test/command-transaction.test.ts:59–120`（事务回滚不留半截）。**不碰 `submitted`/`accepted`、不自愈已提交的 item、不自动换候选、不解除预算**。
- **风险 / 非目标**：**停止/吊销 token 与写状态的顺序必须先冻结**（否则会出现「宣布已停但 token 还能写」）。迟到 claim 必须无副作用。非目标：不新增 kernel 状态边、不改 `killed_wall_clock` 的 Attempt 语义、不把 `failed` Attempt 记成 `succeeded`。

### ⑤ 未提交半成品让精确小单 checkpoint 必失败

- **L3 必要性**：**历史曾需特批，未来由可信平台证明后不需逐案**。半成品**属于哪张单、来源是否清晰、能不能进仓库**是责任判断；COM3 里是 L3 逐案批准「保存一次未验收 Git 恢复快照」的。未来这套保存由**可信平台**执行并**持久保存责任**（原 Mission 授权路径可证、原字节落库、旧写者已退出），规则冻结后同范围内不需逐案 L3；只有**来源不可证 / 范围变化 / 旧写者未退出**才升级。
- **合法路径（待冻结）**：**可信 WorkspaceManager** 保存一次**未验收恢复快照**，要求：
  1. 路径**全部属于原 Mission 授权路径**（原契约 `allowedPaths`）且来源清晰；
  2. **旧写者（被杀执行者）已退出**才能保存，否则不碰；
  3. 记录原 Attempt id、路径 + hash、保存前后的 HEAD、**未验收清单**，**责任随快照持久化**；
  4. 顺序：**先持久 intent → 再 Git commit → 最后完成事件**；崩溃后核对 commit/hash 做**幂等补账**；
  5. 未知来源或越界 → **fail-closed 升级**，不猜。
  这份快照**不是功能提交、不是 accepted、不是 VR**，不改 Mission `baseRevision`；后续正常每单 baseline/checkpoint，最终从 Mission 原基线累计 diff 验收**快照全部路径**，未验收清单不能漏。
- **最小改动 / 层级**：`src/application/workspace.ts`——扩 `WorkspaceManager` 接口（:133–150 区，现有可选 `checkpoint` 在 :150）或从中抽**小模块**（例如 `RecoverySnapshotStore`），`GitWorktreeManager`（:426–465）实现；orchestrator（`:2504–2527`）可信接线；快照事件走**平台现有事件 + 现有 File 事务**（不新增 writer）。为了让「越界」可判别，建议给 `workspace.ts:453` 那条普通 `Error` 一个**业务码**（或新增一个明确的错误类型），由平台层映射——**但这是建议，未冻结**。
- **不变量 / 既有测试**：单写者事务（`context.ts:100–150`）；`test/workspace.test.ts:61–90`（`checkpoint` 只提交授权路径、越界拒且不删文件——:76–80 的 `未授权` 断言、`:81–83` 的 `checkpoint rejects outside changes`）；`test/orchestrator.test.ts:354–468`（checkpoint 成功一次 / 抛错停靠且不回滚——:397–436 的 `checkpoint-denied` 组）。**注意**：`test/workspace.test.ts:80` 用正则 `/未授权/` 匹配 message，若改文案/错误类型要同步核对。
- **风险 / 非目标**：intent 存哪、幂等事件接口、累计未验收闸门都**未验证**，必须 L3 冻结。非目标：不把快照当验收、不自动 `completed`、不删半成品、不放宽 `allowedScope`。

---

## 3. 「优先修正已有单、只有独立新工作才新增」的出处核实

要求：核实这条规则的出处，并写明它与**替代单**的关系。

**核实方法**：全仓检索 `src/`、`docs/`、`test/`、`.coagent/`、`VIBE.md`、`AGENTS.md`、`CLAUDE.md`，以及 `git grep HEAD`。检索 `优先修正`（含 `优先修正已有单`、`只有独立新工作`）。

**结果（如实）**：

1. **在工作区文本里找不到这句话。** `grep -rn "优先修正" src docs test .coagent VIBE.md AGENTS.md CLAUDE.md` 返回 0 命中；`git grep -n "优先修正" HEAD` 返回 0 命中。
2. **pi roles 里也没有。** 本机 `~/.pi` 下只有 `agent` 目录，没有可检索的角色文案文件命中该句。**未验证**：本条基于「该路径下无可检索文本」，不代表平台别处的 prompt 里一定没有——那份内容不在本工作区，本报告不声称核查过。
3. **最早的 HTTP 可见记录（本次可证）**：`AC4-platform-closeout-20261004` 的 `escalated`，时间 `2026-10-04T06:06:49.011Z`，原文「…与本轮**优先修正已有工单**的指示冲突」，同 Mission `escalation.answered` 在 `06:07:37.338Z` 复述。
4. **与「退休单/替代单」直接挂钩的那次**：`COM3-B2b-impact-supervision-20261005`，`contract_check.submitted {verdict:issues}` 与 `escalated` 同在 `2026-10-05T05:16:55.230Z`，L3 的 `escalation.answered` 在 `05:17:31.944Z` 才是**权威定性**：*「优先修正已有可修订工单的规则不要求复活退休单；本轮可新建引用W472与本答复的替代补修工单，属于同一Mission已授权技术恢复，不是新需求。」*

**结论（限定到可证范围）**：

- 这句话**在本工作区任何源码/文档/测试/ADR 中都不存在**，因此**不能**声称它出自 ADR、全局平台门禁或某份 Contract 原文。**当前 COM3 r5 Contract 里没有这句原话**。原用户消息与历史 r2 原文**未验证**（不在本工作区，无法取证）。
- 它在平台里**只能追踪到协调者升级文本**（最早可证 `2026-10-04T06:06:49.011Z` AC4；与替代单挂钩的是 `2026-10-05T05:16:55.230Z` COM3），以及 **L3 对它的解释性答复**（`2026-10-05T05:17:31.944Z`）。
- **它和替代单的关系**：按 L3 的解释，这条规则的**作用范围是「可修订的已有单」**，**不延伸到「退休单」**——退休单不复活，替代单是**新增一张单**，但因为它承接的是「同一 Mission 里原权威路径未完成」的部分，所以属于**技术恢复**，不算「独立新需求」。「只有独立新工作才新增」的**反例边界**正在这里：如果新单是承接同一目标未完成部分（引用原 id），它是恢复；如果它是另一个目标，才需要走新需求流程。**历史实例里**（`W-474`）替代单还引用了 L3 那次授权答复编号——那是当时规则尚未冻结的逐案特批，**不构成未来每次新建替代单都要再取一次授权的先例**（见 §0 与 §2③）。

---

## 4. 后续工单草案（A / B / C，分别可冻结）

均**待 L3 冻结、不在本票实施**，均为「仅文档之外」的后续单。五维结论沿用协调者预审，本报告如实转写，并列出**未验证事项**。

### 草案 A：合法恢复路径的提示/规则（最轻）

- **目录范围（`allowedScope`）**：`src/application/platform/work-order-helpers.ts`、`src/application/platform/work-item-dispatch.ts`、`test/platform.test.ts`。
- **真实函数/接缝**：`REVISE_BLOCKED_HINT`（`work-order-helpers.ts:10–15`）新增/改写 `accepted`、`retired` 的提示文案；`dispatchWorkItems` 里 `NOT_DISPATCHABLE` 抛错处（`work-item-dispatch.ts:32–38`）的文案。**依赖**：无（可并行）。
- **测试接缝**：`test/platform.test.ts`（现有 W-292 组 :1044–1130 同文件）。测试装配**用现有平台接缝即可**（现有平台测试已能构造 `accepted`/`retired`/`rejected` 工作项并观察状态），**不需要为描述块另定归属**。
- **关键测试（1–2 条）**：① 「accepted 单要求补做 / retired 单要求替代时，都走新建引用原 id 的补修单，且**原单旧记录（原状态与已有证据）保持不变**」——一条用例同时覆盖 accepted 补修与 retired 替代；② 「rejected 单直接 accept 被拒后，走 revise→dispatch→submit→accept 成功且来源是新 Attempt」。
- **验证命令（不超两条）**：`node --test test/platform.test.ts`。
- **依赖顺序**：无真依赖，可与 B 并行。
- **五维（L2 预审）**：设计=复用现有载荷（`contextRefs`/`requiredBehaviour`），零 kernel 边；功能=提高合法路径的可发现性；复杂度=低；测试=平台外部可观测状态；命名=文案里**禁止出现「解锁」**（那会把「新增单」误述成「改状态」）。**结论：可行。**
- **未验证**：文案改动是否影响任何断言 message 匹配（需在实施时核对 `test/platform.test.ts` 是否有对 `NOT_DISPATCHABLE` 原文的匹配）。

### 草案 B：可信 killed 收尾

- **目录范围（`allowedScope`）**：`src/application/platform/attempts.ts`、`src/application/platform.ts`、`src/application/orchestrator.ts`，以及**待新增的候选小 helper** `src/application/platform/killed-executor-recovery.ts`（仅候选路径，**不是现有函数**）。
- **真实函数/接缝**：`finishAttempt`（`attempts.ts:64–177`，状态写在 :129–133）或抽出上面那个**小恢复 helper**，由 `platform.ts` 少量接线；orchestrator `finally` 可信调用（`:2454–2502`，`killed_wall_clock` 在 :2469）。**`kernel.recordBlocked` 不改**（`work-item.ts:288–294` 已可用）。
- **测试接缝**：`test/orchestrator.test.ts` 的 `ScriptedRuntime`（:3200–3290 已有墙钟强杀组）与 `test/command-transaction.test.ts`（:59–120、:228–277 事务组）。
- **关键测试（1–2 条）**：① 「killed 且未提交 → item 转 `blocked`，且在修订前拒绝重派」；② 「迟到的旧 claim 调用无副作用，事务回滚」。
- **验证命令（不超两条）**：`node --test test/orchestrator.test.ts`、`node --test test/command-transaction.test.ts`。
- **依赖顺序**：无真依赖，可与 A 并行；**但 C 依赖 B**（C 需要 B 保证旧写者已退出）。
- **五维（L2 预审）**：设计=可信收尾；功能=不触已提交/预算；复杂度=抽 helper 避免 `attempts.ts` 继续膨胀；测试=生命周期 + 事务；命名=必须解释「Attempt 失败」与「工单状态」是两件事。**结论：可行，但停止/revoke 顺序必须冻结。**
- **未验证**：停止与吊销 token 的先后、迟到 claim 的具体触发路径**未验证**。

### 草案 C：未验收恢复快照（最重）

- **目录范围（`allowedScope`，范围候选）**：`src/application/workspace.ts`、**待新增的恢复模块候选** `src/application/recovery-snapshot.ts`、`src/application/orchestrator.ts`、`src/application/platform.ts`、`src/application/platform/context.ts`，以及**拟议的 intent 持久层** `src/application/file-store.ts`；对应测试 `test/workspace.test.ts`、`test/orchestrator.test.ts`。
- **真实函数/接缝**：`WorkspaceManager` 接口（`workspace.ts:133–150`，现有可选 `checkpoint` 在 :150）/ `GitWorktreeManager`（:426–465）抽小模块（例如 `RecoverySnapshotStore`）；orchestrator 可信接线（:2504–2527）；Platform 事务/事件走 `platform.ts` 与 `platform/context.ts` 的 `tx`/`txFenced`（:100–150），**不新 writer**；intent 存储拟议落在文件存储层 `file-store.ts`（**具体数据形状未定**）。`:453` 的普通 `Error` 是否给业务码**待冻结**。
- **测试接缝**：`test/workspace.test.ts`（临时 Git，:61–90）与 `test/orchestrator.test.ts` 集成。
- **关键测试（1–2 条）**：① 「跨组 dirty 保存原字节后，精确单 `checkpoint` 成功，且累计 diff 仍含保存路径」；② 「越界或崩溃重入不漏未验收清单」。
- **验证命令（不超两条）**：`node --test test/workspace.test.ts`、`node --test test/orchestrator.test.ts`。
- **依赖顺序**：**依赖 B 的 accepted**（旧写者退出/收尾可信后再动）。
- **五维（L2 预审）**：设计=保存与验收分开；功能=保留责任；复杂度=最高，**必须抽模块**；测试=真实 Git + 重入；命名=显式写「未验收恢复快照」。**结论：有条件可冻结。**
- **未验证 / 待 L3 冻结**：现有事务如何复用、intent **持久接口与数据形状**、PG 兼容性，以及**累计未验收闸门**均**未验证**；这些是**范围候选**，**不是已可执行工单**——**当前仅有条件可冻结**，**不得由 L1 自行选定存储协议**。

**注**：A/B/C 的「函数 ≤ 40 行、文件 ≤ 400 行」是**建议值**，不为机械凑数删注释；大文件只做少量接线，逻辑多的抽模块。

---

## 5. 边界与非目标（本报告一律不越）

- 规则**不是**自动 `completed`，**不是**合 master 权限。
- 目标/验收/范围变化、来源未知、预算或不可逆风险 → 一律**升级**。
- **不放宽**：冻结工单修订门禁（`WORK_ITEM_NOT_REVISABLE`）、检查点范围门禁（`workspace.ts:453`）、claim 单写者事务（`context.ts:100–150`）、`WORK_ORDER_REVISION_REQUIRED`、不变量 A/B/C。
- **不新增解锁状态边**；不改 ADR / `.coagent` / `VIBE.md`。
- **不宣称未来测试跑过**：本报告除工单指定的**文档结构检查命令**外，未跑任何 `node --test`、未跑全量、未保存真实快照、未重现真实 agent。

## 6. 未验证事项汇总（如实列出）

1. 「优先修正已有单、只有独立新工作才新增」这句话的**原用户消息 / 历史 r2 原文**不可取证，仅能追踪到协调者升级文本与 L3 解释（见 §3）。
2. `~/.pi` 下无该句命中，但**平台别处 prompt 是否含此句未验证**。
3. 草案 B 的**停止/revoke 顺序**、迟到 claim 触发路径：未验证。
4. 草案 C 的 **intent 存储、幂等事件接口、累计未验收闸门**：未验证。
5. 草案 A 的文案改动是否与既有断言 message 匹配冲突：未验证。
6. 本报告引用的历史 HTTP 结论均来自 2026-10-04/05 的落库记录；**未**在 `841c6cf` 上重现这三个 Mission，也未在其中任何一条上跑过恢复路径。
