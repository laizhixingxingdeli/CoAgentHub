# 测试依赖分类清单 (T1 交付 / 解 barrel 耦合)

> 配套 `specs/test-dependency-classification.md`(Frozen, specHash `f84aa2f665025bf60692e6a8f221ea0b56c9fd1d`)与 `plans/test-dependency-classification.md`(W1)。
> 本清单是 **T2 的输入**:覆盖 server 包全部 `*.test.ts`,给出真实依赖分类 + 判据 + barrel 解耦结论 + T2 结论表。本票**不动** setup/db/vitest.config(属 T2)。

## 1. 方法 & 范围

- 分类维度(spec R1 六类,可多选): **纯内存 / 临时文件 / 数据库 / Git / HTTP-WS / 执行器生命周期**.
- 判据来自**导入图 + 副作用**(不按文件名):每文件列明触发分类的具体 import / 运行时副作用,检视者可抽查.
- 数据库依赖判定口径:满足任一即归入「数据库」——(a) 体中对 `testDb`/`db` 跑 insert/select/update/delete/query;(b) 调 `ensureExecutorConfig`/`seedBuiltinExecutorConfigs`;(c) 调 `migrate()` 于 testClient;(d) 经 `app.request`/`appWs` 驱动 Hono app,而 app 命中被 mock 的 `@server/lib/database`(setup.ts 把该模块重导出为 PGlite).
- **T2 DB 结论口径**:文件导入图中**在运行时抵达 `test/db.ts` 的 PGlite 实例**(`new PGlite()`)即「必须要 DB fixture」.下列归入「未确认 / 保留重环境」(spec R4):文件 import 任一重生产模块(executor-task 桶及其非纯子模块(queue/state/notify/coordinator-resume/completion-recipient/runner/claim-verification/liveness 等)、executor-runner、executors、executor-availability、runtime-status、server-startup、single-server-lock、a2a-runner、orphan-task-reconciler、control —— 别名或相对路径),其导入图会在模块加载时经 `@server/lib/database` 的 mock 抵达 PGlite.仅 import 已核验纯子模块(ansi/diff-summary/output-buffer/report/cooldown-store[仅 type]/review-request-policy[仅 type]/token-usage/detail-store/types/unknown-participant/exec-bin/executor-config-fields/group-visibility/migration-health/schema 纯函数)或读源码 fixture 的文件,方可不要 DB fixture.

## 2. 文件数对齐 (CI 129 vs 本机 87)

| 口径 | 数 | 说明 |
|---|---|---|
| CI run `34571914641` | 129 | 报告采集的 CI 单文件口径(含其它包 / 彼时存在的文件) |
| 本机 `packages/backend/server/test/*.test.ts` | 87 | 当前工作树实际文件数 |

出入 **42** 的原因: CI 129 为全仓库(含 web / database / shared 等其它包)或派发时之后已被移除/重命名的文件;本机对 server 包执行 `find . -name '*.test.ts'` 得 87,且 `test/fixtures/` 下无 `.test.ts`.本清单覆盖**当前工作树全部 87 个**,与 129 的差距为口径差异(包范围 + 历史文件),非漏分.后续若需对齐 CI 129,应到各包分别取数,超出本票 server 包范围.

## 3. 分类汇总

| 类别 | 文件数 | 含义 |
|---|---|---|
| 数据库 (DB) | 60 | 直接查 mock DB 或经 app 命中 DB |
| Git | 16 | 起真实 git 子进程 |
| 临时文件 (Temp) | 38 | mkdtemp/tmpdir/writeFileSync |
| HTTP-WS | 53 | app.request/appWs/fetch/WS |
| 执行器生命周期 (Exec) | 49 | 重 executor-task 子模块 / runner / lock(含相对路径导入) |
| 纯内存 (Pure, 无任何其它类别) | 见 §4 | 仅纯子模块或读源码 fixture |

## 4. 逐文件分类 (87)

| # | 文件 | 类别 | 分类判据(具体 import / 副作用) | barrel | T2 DB |
|---|---|---|---|---|---|
| 1 | `a2a-runner.test.ts` | Exec | Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 未确认 |
| 2 | `checkpoint-index-isolation.test.ts` | Git Temp Exec | Git: execFileSync/spawnSync 'git' 起真实 git 子进程; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 未确认 |
| 3 | `claim-verification.test.ts` | Git Temp Exec | Git: execFileSync/spawnSync 'git' 起真实 git 子进程; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 未确认 |
| 4 | `control-command-skip-dispatch.test.ts` | DB Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 5 | `cooldown-store.test.ts` | Pure | Pure: 仅 import 纯子模块(ansi/diff-summary/output-buffer/report/cooldown-store[type]/review-request-policy[type]/unknown-participant/exec-bin/executor-config-fields/group-visibility/token-usage/migration-health/schema 纯函数)或读源码 fixture; 无 db/git/http/temp 运行时依赖 | - | 可不要 |
| 6 | `coordination-activity.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 7 | `coordination-close-integrity.test.ts` | DB Git Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Git: execFileSync/spawnSync 'git' 起真实 git 子进程; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 8 | `coordination-payload-api.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 9 | `coordination-payload.test.ts` | Pure | Pure: 仅 import 纯子模块(ansi/diff-summary/output-buffer/report/cooldown-store[type]/review-request-policy[type]/unknown-participant/exec-bin/executor-config-fields/group-visibility/token-usage/migration-health/schema 纯函数)或读源码 fixture; 无 db/git/http/temp 运行时依赖 | - | 可不要 |
| 10 | `coordinator-exit-after-dispatch.test.ts` | Pure | Pure: 仅 import 纯子模块(ansi/diff-summary/output-buffer/report/cooldown-store[type]/review-request-policy[type]/unknown-participant/exec-bin/executor-config-fields/group-visibility/token-usage/migration-health/schema 纯函数)或读源码 fixture; 无 db/git/http/temp 运行时依赖 | - | 可不要 |
| 11 | `coordinator-l2-retry-protocol.test.ts` | Pure | Pure: 仅 import 纯子模块(ansi/diff-summary/output-buffer/report/cooldown-store[type]/review-request-policy[type]/unknown-participant/exec-bin/executor-config-fields/group-visibility/token-usage/migration-health/schema 纯函数)或读源码 fixture; 无 db/git/http/temp 运行时依赖 | - | 可不要 |
| 12 | `coordinator-resume.test.ts` | DB Git Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Git: execFileSync/spawnSync 'git' 起真实 git 子进程; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 13 | `detached-close-deadlock-guard.test.ts` | DB HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | barrel | 必须 |
| 14 | `detached-token-backfill.test.ts` | DB Git Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Git: execFileSync/spawnSync 'git' 起真实 git 子进程; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | barrel | 必须 |
| 15 | `detail-store.test.ts` | Temp | Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件 | - | 可不要 |
| 16 | `diff-summary-compat.test.ts` | DB HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | barrel | 必须 |
| 17 | `diff-summary-merge.test.ts` | Pure | Pure: 仅 import 纯子模块(ansi/diff-summary/output-buffer/report/cooldown-store[type]/review-request-policy[type]/unknown-participant/exec-bin/executor-config-fields/group-visibility/token-usage/migration-health/schema 纯函数)或读源码 fixture; 无 db/git/http/temp 运行时依赖 | - | 可不要 |
| 18 | `diff-summary-write-paths.test.ts` | DB HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | barrel | 必须 |
| 19 | `dispatch-intent-persist.test.ts` | DB Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | barrel | 必须 |
| 20 | `dispatch-policy.test.ts` | DB Temp Exec | DB: 体中对 testDb/db 跑 insert/select/update/delete/query 或 ensureExecutorConfig/seed; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 21 | `dispatch-target-audit.test.ts` | DB Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 22 | `dispatchKindNote-preservation.test.ts` | DB Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | barrel | 必须 |
| 23 | `dispatcher-fields.test.ts` | DB Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 24 | `e2e-acceptance.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 25 | `exec-bin.test.ts` | Temp | Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件 | - | 可不要 |
| 26 | `executor-a2a-reliability.test.ts` | DB HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 27 | `executor-ansi.test.ts` | Pure | Pure: 仅 import 纯子模块(ansi/diff-summary/output-buffer/report/cooldown-store[type]/review-request-policy[type]/unknown-participant/exec-bin/executor-config-fields/group-visibility/token-usage/migration-health/schema 纯函数)或读源码 fixture; 无 db/git/http/temp 运行时依赖 | barrel | 可不要 |
| 28 | `executor-api.test.ts` | DB Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 29 | `executor-config-fields.test.ts` | Temp Exec | Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 未确认 |
| 30 | `executor-coordinator-workspace-gate.test.ts` | DB Git Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Git: execFileSync/spawnSync 'git' 起真实 git 子进程; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 31 | `executor-progress.test.ts` | DB Git Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Git: execFileSync/spawnSync 'git' 起真实 git 子进程; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 32 | `executor-provider-error.test.ts` | Exec | Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 未确认 |
| 33 | `executor-queue.test.ts` | DB Git Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Git: execFileSync/spawnSync 'git' 起真实 git 子进程; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 34 | `executor-queued-reclaim.test.ts` | DB Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | barrel | 必须 |
| 35 | `executor-quota-r9.test.ts` | DB Git Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Git: execFileSync/spawnSync 'git' 起真实 git 子进程; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 36 | `executor-quota-redispatch.test.ts` | DB Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 37 | `executor-report-quota.test.ts` | DB Git Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Git: execFileSync/spawnSync 'git' 起真实 git 子进程; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 38 | `executor-runner-windows-launcher.test.ts` | Exec | Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 未确认 |
| 39 | `executor-startup-failure.test.ts` | Exec | Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | barrel | 未确认 |
| 40 | `executor-task-liveness.test.ts` | DB HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 41 | `executor-task-repo.test.ts` | DB Git Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Git: execFileSync/spawnSync 'git' 起真实 git 子进程; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 42 | `executor-task-role-dispatch.test.ts` | DB Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 43 | `executor-transient-quota.test.ts` | DB Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 44 | `executor-trigger.test.ts` | DB Git Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Git: execFileSync/spawnSync 'git' 起真实 git 子进程; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 45 | `file.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 46 | `findings-dispatchKind-regression.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 47 | `group-file.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 48 | `group-member-mgmt.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 49 | `group-message.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 50 | `group-visibility-consistency.test.ts` | DB | DB: 体中对 testDb/db 跑 insert/select/update/delete/query 或 ensureExecutorConfig/seed | - | 必须 |
| 51 | `group.test.ts` | DB Temp HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 52 | `health.test.ts` | DB Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 53 | `l1-aggregate.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 54 | `l2-claim-adjudication.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 55 | `l3-per-spec.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 56 | `l3-request-recipient.test.ts` | DB HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 57 | `l3-verdict-observability.test.ts` | DB HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | barrel | 必须 |
| 58 | `migration-0029-reviewer-cleanup.test.ts` | DB Temp | DB: migrate() 于 testClient 跑真实迁移; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件 | - | 必须 |
| 59 | `migration-0030-recipient-backfill.test.ts` | DB Temp | DB: migrate() 于 testClient 跑真实迁移; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件 | - | 必须 |
| 60 | `migration-health.test.ts` | Pure | Pure: 仅 import 纯子模块(ansi/diff-summary/output-buffer/report/cooldown-store[type]/review-request-policy[type]/unknown-participant/exec-bin/executor-config-fields/group-visibility/token-usage/migration-health/schema 纯函数)或读源码 fixture; 无 db/git/http/temp 运行时依赖 | - | 可不要 |
| 61 | `migration-no-builtin-executor-seeding.test.ts` | DB Temp | DB: migrate() 于 testClient 跑真实迁移; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件 | - | 必须 |
| 62 | `orphan-task-reconciler.test.ts` | DB HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | barrel | 必须 |
| 63 | `output-buffer.test.ts` | Pure | Pure: 仅 import 纯子模块(ansi/diff-summary/output-buffer/report/cooldown-store[type]/review-request-policy[type]/unknown-participant/exec-bin/executor-config-fields/group-visibility/token-usage/migration-health/schema 纯函数)或读源码 fixture; 无 db/git/http/temp 运行时依赖 | - | 可不要 |
| 64 | `output-parser.test.ts` | Exec | Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | barrel | 未确认 |
| 65 | `participant-extensions.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 66 | `participant.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 67 | `quota-misclassification.test.ts` | Exec | Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 未确认 |
| 68 | `retry-rollback-guard.test.ts` | DB Git Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Git: execFileSync/spawnSync 'git' 起真实 git 子进程; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 69 | `review-request-policy.test.ts` | Pure | Pure: 仅 import 纯子模块(ansi/diff-summary/output-buffer/report/cooldown-store[type]/review-request-policy[type]/unknown-participant/exec-bin/executor-config-fields/group-visibility/token-usage/migration-health/schema 纯函数)或读源码 fixture; 无 db/git/http/temp 运行时依赖 | - | 可不要 |
| 70 | `review-workflow.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 71 | `runtime-status.test.ts` | Temp Exec | Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 未确认 |
| 72 | `second-instance-sweep.test.ts` | Exec | Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 未确认 |
| 73 | `server-startup.test.ts` | Exec | Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 未确认 |
| 74 | `single-server-lock.test.ts` | Exec | Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 未确认 |
| 75 | `skills-route.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 76 | `skills-version.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 77 | `skills.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |
| 78 | `task-completion-event-trigger.test.ts` | DB | DB: 体中对 testDb/db 跑 insert/select/update/delete/query 或 ensureExecutorConfig/seed | - | 必须 |
| 79 | `task-completion-events.test.ts` | DB Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 80 | `task-output-detail.test.ts` | DB Git Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Git: execFileSync/spawnSync 'git' 起真实 git 子进程; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 81 | `task-status-ws.test.ts` | DB Git Temp HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Git: execFileSync/spawnSync 'git' 起真实 git 子进程; Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 82 | `task.test.ts` | DB Git HTTP Exec | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; Git: execFileSync/spawnSync 'git' 起真实 git 子进程; HTTP: app.request/appWs 发 HTTP/WS; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | - | 必须 |
| 83 | `ticket-template.test.ts` | Temp Exec | Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件; Exec: import executor-task 重子模块(非纯)或 executor-runner/executors/runtime-status 等重模块(别名或相对路径) | barrel | 未确认 |
| 84 | `token-usage.test.ts` | Temp | Temp: mkdtemp/tmpdir/writeFileSync 建/写临时文件 | - | 可不要 |
| 85 | `unknown-participant.test.ts` | Pure | Pure: 仅 import 纯子模块(ansi/diff-summary/output-buffer/report/cooldown-store[type]/review-request-policy[type]/unknown-participant/exec-bin/executor-config-fields/group-visibility/token-usage/migration-health/schema 纯函数)或读源码 fixture; 无 db/git/http/temp 运行时依赖 | - | 可不要 |
| 86 | `visibility-sql.test.ts` | DB | DB: 体中对 testDb/db 跑 insert/select/update/delete/query 或 ensureExecutorConfig/seed | - | 必须 |
| 87 | `ws-hub.test.ts` | DB HTTP | DB: 经 app.request/appWs 驱动 Hono app -> 命中 mock @server/lib/database; HTTP: app.request/appWs 发 HTTP/WS | - | 必须 |

## 5. barrel 调查细节 (executor-task 汇总入口)

全部 `@server/lib/executor-task` 导入共 **14** 个文件(见 §4 barrel 列).唯一聚合 barrel 是 `executor-task/index.ts`;`@server/lib/database` 也是 barrel,但它是被 setup mock 的 DB,DB 测试必需,非本票解耦对象.其余 `@server/lib/*` 均为单文件模块,导入即直引,无需处理.

| 文件 | 从 barrel 导入的符号 | 决定 | 理由 |
|---|---|---|---|
| `detached-close-deadlock-guard.test.ts` | __resetExecutorQueueForTests, maybeCreateCoordinatorResumeTask | 保留 | DB 测试(体中有 testDb/db 查询 + fake executor).符号来自 queue + coordinator-resume 重子模块;直引仍会拉重图,且本文件非纯逻辑,解耦无 collect 收益.保留 barrel. |
| `detached-token-backfill.test.ts` | backfillDetachedClosedTokenFields | 保留 | DB 测试(import testDb + seedBuiltinExecutorConfigs + fake-executor-bin).非纯逻辑测试.保留 barrel. |
| `diff-summary-compat.test.ts` | mergeDiffSummary | 保留 | DB/HTTP 测试(经 app.request 命中 DB).虽 mergeDiffSummary 来自纯 diff-summary.ts,但本文件已因 app 拉起全图,解耦 mergeDiffSummary 单项无 collect 收益,且属非纯逻辑测试.保留 barrel(理由同 R4:未确认解耦收益). |
| `diff-summary-write-paths.test.ts` | __resetExecutorQueueForTests, applyDiffSummaryPatch, mergeDiffSummary, recoverInterruptedTasks | 保留 | DB 测试,且已同时 import queue 符号(recoverInterruptedTasks / __resetExecutorQueueForTests).属于重子模块,直引无收益.保留 barrel. |
| `dispatch-intent-persist.test.ts` | __resetExecutorQueueForTests, DISPATCH_INTENT_RECLAIM_GRACE_MS, findDispatchIntentByMessage, payloadFromDispatchInput, reclaimDispatchIntents, writeDispatchIntent | 保留 | DB 测试(import testDb + seedBuiltinExecutorConfigs + fake-executor-bin).符号来自 dispatch/queue 重子模块.保留 barrel. |
| `dispatchKindNote-preservation.test.ts` | __resetExecutorQueueForTests, preserveDispatchKindNote | 保留 | DB 测试(import testDb + seedBuiltinExecutorConfigs + fake-executor-bin).保留 barrel. |
| `executor-ansi.test.ts` | createAnsiStripper, stripAnsi | 已改直引 | **纯逻辑**测试(仅测 ANSI 剥离,无 db/git/http/temp).符号来自纯子模块 ansi.ts(仅正则,无 db).改为 `import { createAnsiStripper, stripAnsi } from "../src/lib/executor-task/ansi"`.此为本次唯一有 collect 收益的 barrel 解耦(文件不拉重图). |
| `executor-queued-reclaim.test.ts` | __resetExecutorQueueForTests, __setMaxConcurrentPerWorkspaceForTests, __setReliabilityTimeoutsForTests, reclaimQueuedTasks, startQueuedTaskReclaim | 保留 | DB 测试(import testDb + seedBuiltinExecutorConfigs).符号来自 queue 重子模块.保留 barrel. |
| `executor-startup-failure.test.ts` | formatExecutorStartupFailure, spawnFailureHint | 保留 | 纯逻辑测试(仅测启动失败文案),但符号定义在 queue.ts(重子模块,经 notify/state 在模块加载时抵达 PGlite).直引 queue.ts 与经 barrel 拉起的图一致,解耦无收益.保留 barrel. |
| `l3-verdict-observability.test.ts` | __setL3ResponseMinutesForTests | 保留 | DB 测试(经 app.request 命中 DB).保留 barrel. |
| `orphan-task-reconciler.test.ts` | __resetExecutorQueueForTests, consumePendingCompletionEvents | 保留 | DB+Git 测试(import testDb + spawnSync git).符号来自 queue + coordinator-resume 重子模块.保留 barrel. |
| `output-parser.test.ts` | appendTaskDetail, createExecutorOutputParser, getCodexSkippedEventCounts, getGenericSkippedEventCounts, liveStreamText, readTaskDetail, resetCodexSkippedEventCounts, resetGenericSkippedEventCounts, summaryStreamText, taskDetailFilePath (type: OutputEntry) | 保留 | **spec 点名,勿无脑改**.覆盖 output-parser + detail-store(写 FILE_DIR 临时文件) + queue 流文本函数(liveStreamText/summaryStreamText 来自 queue 重子模块),跨多子模块;queue 依赖是重模块,直引仍拉重图,解耦无 collect 收益.保留 barrel,原因写进清单. |
| `ticket-template.test.ts` | buildTicket, loadTicketTemplate, resolveTicketTemplatesDir | 保留 | Temp 测试(import mkdtemp/tmpdir),非纯逻辑;符号来自 executor-task 重子模块(经模板模块抵达 PGlite).保留 barrel. |

**解耦结论**: 仅 `executor-ansi.test.ts` 由 barrel 改为直引 `../src/lib/executor-task/ansi`(纯子模块,且文件本身无其它重依赖,是唯一有 collect/transform 收益的解耦).其余 13 个保留 barrel,原因如上:要么是非纯逻辑测试(解耦无收益),要么符号来自重子模块 queue(直引仍拉重图),要么跨多子模块(output-parser).未新增任何测试专用转发层/re-export,保持生产导出面不变.

## 6. 混合文件 (spec R3)

未发现「纯逻辑 + 重依赖」混在同一文件、可干净拆分的案例——「可不要」集合(§4 中标「可不要」的文件)均不混入 DB/Exec 类别;多类别文件均为一体化端点/生命周期/集成测试(DB+HTTP+Exec 等天然耦合,如 `executor-api`/`coordinator-resume`/`participant-extensions`),拆分将打断基线文件名对照(spec R3 明确「拆文件会改变文件数与文件名,基线报告排名断裂」),故**仅标记、不拆**.本票未拆分任何文件.

## 7. 未确认 (spec R4: 拿不准保留重环境)

以下文件归入 T2 DB = **未确认**,保守保留 DB fixture.判定依据:文件 import 了重生产模块(executor-task 非纯子模块 / executor-runner / executors / executor-availability / runtime-status / server-startup / single-server-lock / a2a-runner / orphan-task-reconciler / control,别名或相对路径),其导入图在模块加载时经 `@server/lib/database` mock 抵达 PGlite;本票不逐条验证传递路径,按 R4 保留重环境,待 T2 用单文件 stub 确认.

- `a2a-runner.test.ts`
- `checkpoint-index-isolation.test.ts`
- `claim-verification.test.ts`
- `executor-config-fields.test.ts`
- `executor-provider-error.test.ts`
- `executor-runner-windows-launcher.test.ts`
- `executor-startup-failure.test.ts`
- `output-parser.test.ts`
- `quota-misclassification.test.ts`
- `runtime-status.test.ts`
- `second-instance-sweep.test.ts`
- `server-startup.test.ts`
- `single-server-lock.test.ts`
- `ticket-template.test.ts`

## 8. 交给 T2 的结论表

**可不要 DB fixture (can-drop): 13 个** —— 导入图不在运行时抵达 PGlite,仅纯子模块或读源码 fixture:

- `cooldown-store.test.ts`
- `coordination-payload.test.ts`
- `coordinator-exit-after-dispatch.test.ts`
- `coordinator-l2-retry-protocol.test.ts`
- `detail-store.test.ts`
- `diff-summary-merge.test.ts`
- `exec-bin.test.ts`
- `executor-ansi.test.ts`
- `migration-health.test.ts`
- `output-buffer.test.ts`
- `review-request-policy.test.ts`
- `token-usage.test.ts`
- `unknown-participant.test.ts`

**必须要 DB fixture (must-keep): 60 个** —— 直接查 mock DB 或经 app 命中 DB(体中有 testDb/db 查询、ensureExecutorConfig/seed、migrate()、或 app.request/appWs):

- `control-command-skip-dispatch.test.ts`
- `coordination-activity.test.ts`
- `coordination-close-integrity.test.ts`
- `coordination-payload-api.test.ts`
- `coordinator-resume.test.ts`
- `detached-close-deadlock-guard.test.ts`
- `detached-token-backfill.test.ts`
- `diff-summary-compat.test.ts`
- `diff-summary-write-paths.test.ts`
- `dispatch-intent-persist.test.ts`
- `dispatch-policy.test.ts`
- `dispatch-target-audit.test.ts`
- `dispatchKindNote-preservation.test.ts`
- `dispatcher-fields.test.ts`
- `e2e-acceptance.test.ts`
- `executor-a2a-reliability.test.ts`
- `executor-api.test.ts`
- `executor-coordinator-workspace-gate.test.ts`
- `executor-progress.test.ts`
- `executor-queue.test.ts`
- `executor-queued-reclaim.test.ts`
- `executor-quota-r9.test.ts`
- `executor-quota-redispatch.test.ts`
- `executor-report-quota.test.ts`
- `executor-task-liveness.test.ts`
- `executor-task-repo.test.ts`
- `executor-task-role-dispatch.test.ts`
- `executor-transient-quota.test.ts`
- `executor-trigger.test.ts`
- `file.test.ts`
- `findings-dispatchKind-regression.test.ts`
- `group-file.test.ts`
- `group-member-mgmt.test.ts`
- `group-message.test.ts`
- `group-visibility-consistency.test.ts`
- `group.test.ts`
- `health.test.ts`
- `l1-aggregate.test.ts`
- `l2-claim-adjudication.test.ts`
- `l3-per-spec.test.ts`
- `l3-request-recipient.test.ts`
- `l3-verdict-observability.test.ts`
- `migration-0029-reviewer-cleanup.test.ts`
- `migration-0030-recipient-backfill.test.ts`
- `migration-no-builtin-executor-seeding.test.ts`
- `orphan-task-reconciler.test.ts`
- `participant-extensions.test.ts`
- `participant.test.ts`
- `retry-rollback-guard.test.ts`
- `review-workflow.test.ts`
- `skills-route.test.ts`
- `skills-version.test.ts`
- `skills.test.ts`
- `task-completion-event-trigger.test.ts`
- `task-completion-events.test.ts`
- `task-output-detail.test.ts`
- `task-status-ws.test.ts`
- `task.test.ts`
- `visibility-sql.test.ts`
- `ws-hub.test.ts`

**未确认 (保留重环境): 14 个**(见 §7):

- `a2a-runner.test.ts`
- `checkpoint-index-isolation.test.ts`
- `claim-verification.test.ts`
- `executor-config-fields.test.ts`
- `executor-provider-error.test.ts`
- `executor-runner-windows-launcher.test.ts`
- `executor-startup-failure.test.ts`
- `output-parser.test.ts`
- `quota-misclassification.test.ts`
- `runtime-status.test.ts`
- `second-instance-sweep.test.ts`
- `server-startup.test.ts`
- `single-server-lock.test.ts`
- `ticket-template.test.ts`

> 注: T2 在重写 setup/fixture 生命周期时,可先针对「可不要」集合验证去掉 PGlite 后是否仍绿;「未确认」集合建议先用单文件 stub 验证再决定是否豁免;「必须要」集合维持现状.

