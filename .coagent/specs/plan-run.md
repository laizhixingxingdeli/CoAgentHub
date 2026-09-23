# 方案运行（PlanRun）：升级握手与停止条件

按一份方案（`missions/PLAN-*.json`）无人值守地逐个推进功能点时，方案这一层的事实——哪个功能走到哪、夜里升级了什么、检视者怎么定的、为什么停——记在一份**独立的方案运行记录**里。它与 Mission 并列，不在 Mission 里；与 Mission 内协调者写的 `PlanBody` 无关。

## 可观察边界

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

- 不驱动 Mission、不做路由分类、不收尾失败的 Mission（放名额、留分支）——那是驱动方 `run-plan` 的事。
- 不渲染早上的交接面。
- 不给检视者任何放行或合并权；不接 HTTP / agent tools。
- Postgres 存储下这份记录仍是文件。

## 权威源 / 测试

- 源：`src/application/plan-run.ts`（规则）、`src/application/plan-run-store.ts`（文件存储）、`src/application/lock.ts`（放锁时摘掉 exit 兜底）
- 测试：`test/plan-run.test.ts`（纯规则，时间外传）、`test/plan-run-store.test.ts`（**真子进程**：`test/helpers/plan-run-probe.ts`）、`test/lock.test.ts`
