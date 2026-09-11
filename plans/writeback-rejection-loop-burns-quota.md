# Plan: 回写被拒可以无限重试 —— 一次烧掉 3600 轮、1 小时 41 分

> 配套 `specs/writeback-rejection-loop-burns-quota.md`。spec 冻结后 `specHash` 作验收锚点；**本文件会变**（回填 taskId、标完成），不要写入 specs/。
> 路径规则：`specs/<name>.md` → `plans/<name>.md`（从 `specRef` 推得）。
> 平台不解析本文件。计划是提示，**task 事实是权威**。

## 元信息

| 字段 | 值 |
|---|---|
| specRef | `specs/writeback-rejection-loop-burns-quota.md` |
| specHash | `e4db4208662dd3fd08f86027b086f2db891a1ff4`（检视者 2026-09-11 冻结，commit `2360565c`） |
| 编制 | 三方（reviewer + coordinator 在场） |
| dispatchKind | `fix`（检视者分流；L3 精简档 `lite: true`） |
| 更新 | 2026-09-11 |
| 编制角色 | 协调者（技术负责人）§4–§5 |
| 父协调任务 | `01a0909c-218a-7588-98b0-08c8aeeedebe` |

## 先做哪一步、为什么

缺陷 A（无上限）与缺陷 B（stale 提示不分项目）都落在同一条回写拒绝路径
`packages/backend/server/src/routes/group/tasks.ts` 的 `coordinationCloseError` /
结案守卫调用点。两处改动共享同一函数签名扩展与同一批 API 测试夹具，拆成两票
只会制造无意义的接口依赖。**一张工作项闭环**。

## 诊断（下发前）

| 字段 | 内容 |
|---|---|
| 现象 | 任务 `01a09025`（atomcode）实现已落地后，从 #t2909 到 #t6527 约 3600 轮工具调用全部在重试回写；进程耗尽而死；烧掉 1h41m 无价值产出。 |
| 期望行为 | (A) 同一任务连续回写被拒达阈值 → 平台**主动**把任务判终态，`diffSummary` 含被拒次数与最后一次拒绝原文；(B) stale 追加提示只在群 `projectPath` 就是平台自身仓库时出现，其它项目消息与非 stale 时逐字一致。 |
| 复现步骤 | 三方群 + coordinator 结案缺 `review_request` → 400；客户端可无限次 PATCH；`stale:true` 时任意项目都会看到「请发起方重启」。 |
| 已观察事实及证据位置 | 1) `tasks.ts:128` `coordinationCloseError`：`runtime.stale` 时无条件追加重启提示。2) 守卫 `shouldWalkL3` / `summaryHasReviewRequest` / `reviewRequestLiteFlag` 在 `tasks.ts:99+` / `407+` / `487+` / `502+`——**本票逐字不动**。3) `runtime-status.ts:178` `resolveScanRoots()` 只扫平台 server 源码树；`stale` 是**全局进程状态**。4) `findRepoRoot()`（`executor-runner.ts:28`）=`COAGENTHUB_REPO_ROOT` 覆盖否则 cwd 上溯最外层 package.json。5) 群绑定路径在 `groups.project_path`，结案路径已读 `group?.projectPath`（`tasks.ts:255` 一带）。6) `dispatch-policy.json` 已有 `retry.maxRetries` 等；`executors.ts` `readDispatchPolicy` fail-safe 缺省。7) 已有同类「连续失败熔断」：`queue.ts` `countConsecutiveFailedChildren` + `getRedispatchFailureLimit()`（默认 5）。 |
| 根因假设 | **A** 回写 400 路径不累计、不终态，完全依赖客户端停手。**B** stale 提示绑定全局 runtime 而非任务所属项目。 |
| 验证动作与结果 | 对照事故任务输出（stale 提示出现 2 次）+ 源码，与假设一致。实现 `7c4e3cb0` 在进程死前已落地——烧掉的是回写环，不是实现能力。 |
| **被排除的假设** | ❌「执行器被抢占」——检视者已否决。❌「靠 skill / 提示让执行器停」——R1 明确不得依赖客户端。❌「stall 检测应救下」——执行器一直在输出；判据另票。❌「把 schema 写进错误消息」——方向对，另票（R3）。❌「改守卫判定」——验收 5 要求三函数 git diff 为空。 |
| 建议修复范围 | `tasks.ts`（计数 + 超限终态 + stale 按项目追加）；`dispatch-policy.json` + `executors.ts`/`state.ts` 读配置；测试；**不改**守卫三函数逻辑、stall、schema/迁移（计数落点见下）。 |
| **不能改变的行为** | `shouldWalkL3` / `summaryHasReviewRequest` / `reviewRequestLiteFlag` 逐字；既有重试/冷却/并发；非连续历史失败不影响新窗口；其它项目 stale 时错误原文与非 stale 逐字一致。 |
| 回归场景 | 连续拒达阈值终态；成功回写清零后再拒不触顶；policy 缺省；平台仓 vs 外仓 stale 提示双向；守卫 diff 空。 |
| 最终产物验收方式 | 读落库 `status`/`diffSummary`（含次数与最后拒绝原文）；读 HTTP 400/终态响应；`git diff` 三函数为空；基线前后对照；tsc。 |

## 推荐实现（给执行器的技术方向，非强制字面）

### R1 — 连续回写被拒计数，超限终态

**触发点**：所有经 `coordinationCloseError` 抛出的结案拒绝（即 PATCH 终态被守卫打回的路径）。**不是**业务字段校验以外的无关 400。

**计数口径**：

| 规则 | 说明 |
|---|---|
| 按任务 | key = `taskId` |
| 连续累加 | 每次 `coordinationCloseError` 路径 +1 |
| 成功清零 | 同任务一次**被接受的**终态 PATCH（`done`/`failed` 等写库成功）→ 计数清零 |
| 与客户端无关 | 累加与终态写入全在 server；执行器不读、不传计数 |

**超限行为**：

1. 将任务 `status` 置为终态（建议 `failed`）；
2. `diffSummary` **必须**含：被拒次数、**最后一次拒绝原文**（建议固定键，例如 `writebackRejectionLimit: { count, lastMessage, at }` 或等价可读结构，并保证人类打开 diffSummary 能直接看到原文）；
3. 仍向本次 PATCH 返回错误（或返回已终态事实）——要点是**任务行已终态**，后续 PATCH 走既有终态不可再改语义，环路打断；
4. 写 `recipientParticipantIds` 等与既有 failed 结案路径一致，避免完成事件丢接收人（对照附近 failed 写入）。

**计数落点（推荐，汇报须写明实选）**：

- **首选：进程内 `Map<taskId, { count, lastMessage }>`**（可放 `tasks.ts` 旁或 `lib/` 小模块），成功终态 / 超限终态后 delete。
  - 理由：票面默认不动 schema/迁移；事故形态是**同一进程内**数千次重试，Map 足够覆盖；测试可 export `resetWritebackRejectionCountsForTest`。
  - 不选 DB 列：避免迁移；不选 `diffSummary` 在每次 400 时写库：400 路径应保持「未接受回写」，只在触顶时写一次终态摘要。
- 若实现中发现 Map 在测试并行下难隔离，允许改为 task 行既有 jsonb 旁路字段，但**禁止**为计数单独加迁移，除非在汇报里证明 Map 不可行并停下来说明（票面：不可行则停，不自行放宽）。

**阈值配置**：

- `scripts/dispatch-policy.json` 新增键（建议顶层或与 retry 并列）：
  `"writebackRejectionLimit": 5`
- **缺省 5 的依据**：与既有 `getRedispatchFailureLimit()`（连续失败子任务熔断，默认 5）同量级——够执行器改 1～2 次载荷形状再试，远低于 3600；不要硬编码魔法数在调用点。
- `readDispatchPolicy` / `DEFAULT_*` / `describeDispatchPolicy`（health 可见）同步；**配置缺失不报错**，回落缺省（与 maxRetries fail-safe 一致）。
- 测试可 override（对照 `setMaxParallelGroupsForTest` 一类既有测试钩子）。

### R2 — stale 提示按项目归属

**改 `coordinationCloseError` 签名**：需要知道「本任务所属群的 projectPath」（调用点已持有 group 或能查）。**禁止**再无条件读全局 stale 就追加。

**「平台自身仓库」判据（必须写进汇报，禁止字符串包含）**：

```
platformRoot =
  process.env.COAGENTHUB_REPO_ROOT 若存在且 isDirectory
  else findRepoRoot()          // executor-runner.ts 已有，cwd 上溯最外层 package.json

groupRoot = group.projectPath  // 可 null

isPlatformProject =
  groupRoot != null
  && sameDirectory(groupRoot, platformRoot)

sameDirectory(a, b) =
  realpath/normalize 后路径相等
  （Windows：大小写不敏感；用 path.resolve + fs.realpathSync.native 或既有 normalize 工具；
   比较的是目录身份，不是 substring）
```

**为什么选这套**：

| 候选 | 结论 |
|---|---|
| `COAGENTHUB_REPO_ROOT` | **优先覆盖**：测试与部署已用它把平台根指到真实/临时仓；与 `findRepoRoot` 同源。 |
| `findRepoRoot()` | **无 env 时的生产缺省**：与 spawn cwd / 仓库根推导一致。 |
| `runtime-status.resolveScanRoots()` | **不直接当归属根**：它返回的是 `server/src` 与 workspace dep 的 **src** 扫描根，不是仓库根；拿来和 `projectPath`（仓库根）比会永久 false 或要再上溯，易错。可用于辅助校验但不是主判据。 |
| 群 `project_path` | **任务侧唯一归属**：提示是否追加由「这个任务的群绑的是哪里」决定。 |
| 字符串 `includes` | **禁止**。 |

**行为矩阵**：

| group.projectPath | stale | 消息 |
|---|---|---|
| = 平台仓 | true | 原始拒绝 + stale 追加句（保持现有文案） |
| = 平台仓 | false | 仅原始拒绝 |
| = 其它仓 | true | **仅原始拒绝**（与 stale false **逐字一致**） |
| = 其它仓 | false | 仅原始拒绝 |
| null | * | 仅原始拒绝（无法认定平台自身 → 不追加；避免误导） |

### R3 — 不动守卫

对 `shouldWalkL3` / `summaryHasReviewRequest` / `reviewRequestLiteFlag`：**零逻辑 diff**。重构移动文件也不要动；验收 5 查这三个符号的 diff 为空。

### 文件预期

| 文件 | 改动 |
|---|---|
| `packages/backend/server/src/routes/group/tasks.ts` | 计数钩入拒绝路径；超限终态；`coordinationCloseError` 按项目追加 stale |
| `packages/backend/server/src/lib/executors.ts`（及 state 暴露） | 读 `writebackRejectionLimit` |
| `scripts/dispatch-policy.json` | 增加 `writebackRejectionLimit`（本票允许改此文件；其它 scripts 不动） |
| `packages/backend/server/test/writeback-rejection-limit.test.ts`（新建名可微调） | 验收 1–4 |
| 可能扩展 `coordination-close-integrity.test.ts` | stale 项目归属若更适合落在既有 close 套件 |
| `dispatch-policy.test.ts` | 缺省/缺失 fail-safe（若已有 pattern 则跟） |

**明确不改**：schema、迁移、stall、守卫三函数、错误消息 schema 化。

### 测试要点（对照 spec §4）

1. **连续被拒达阈值 → 终态**；读落库 `diffSummary` 含次数 + **最后一次拒绝原文**（不要只断言函数返回值）。
2. **成功清零**：拒 N-1 → 一次合法成功回写 → 再拒一次 → **不得**触顶。
3. **policy**：显式配置生效；删除/缺键用缺省且不抛。
4. **stale 归属双向**（缺一不算）：
   - 群 projectPath = 平台根 + stale → 消息含追加句；
   - 群 projectPath = 其它目录 + stale → 消息与非 stale **逐字一致**。
5. 守卫三函数 `git diff` 空（汇报贴命令）。
6. 基线：  
   `node scripts/test-baseline.mjs packages/backend/server test/writeback-rejection-limit.test.ts test/coordination-close-integrity.test.ts test/dispatch-policy.test.ts`  
   （按实际改动触及的文件调整清单；**失败数不增加**）。
7. `cd packages/backend/server && npx tsc --noEmit -p tsconfig.json`（**勿管道吞退出码**）。

### 提交与工作树

- `git commit -- <明确路径>`；message 按功能写。
- 临时物进 `.scratch/`。
- `plans/writeback-rejection-loop-burns-quota.md` **纳入提交**（本票验收项）。
- 交付时 `git status --porcelain` 除本票改动与用户长期未提交的 `docs/implementation-optimization-review-2026-09-07.md`、`start.ps1` 外为空。

## 工作项

### W1 — 回写拒绝上限 + stale 项目归属

| 字段 | 内容 |
|---|---|
| 稳定编号 | W1 |
| 目标 | R1 连续拒绝达阈终态（可配置）；R2 stale 提示仅平台自身项目；守卫三函数不动。 |
| 范围 | 见上表。实现 + 测试 + policy 键 + 本 plan 若需回填。 |
| 前置依赖 | 无 |
| 预期产物 | 功能提交；测试文件；汇报写明计数落点、阈值缺省依据、项目归属判据。 |
| 验收方法 | spec §4 全部 7 条；基线前后对照。 |
| specRef | `specs/writeback-rejection-loop-burns-quota.md` |
| specHash | `e4db4208662dd3fd08f86027b086f2db891a1ff4` |
| taskId | _未派发_ |
| 状态 | planned |
| 执行器 | atomcode（实现+测试；票面测试执行器） |

## 依赖图

```
W1
```

## 派发记录

| 时间 | 动作 | taskId | 备注 |
|---|---|---|---|
| （派发后回填） | | | |
