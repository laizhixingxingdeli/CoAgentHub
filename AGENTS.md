# AGENTS.md

Agent-facing conventions for the CoAgentHub repo: where the domain docs live,
the workspace commands, coding style, and how to operate the GitHub issue
tracker.

## Project in one sentence

CoAgentHub is a LAN-scale multi-participant collaboration hub: participants
(humans, CLIs, resident scripts, AI bots) register identities, join task
groups, exchange role-routed messages, and hand off files via P2P signaling.
On the group `fileRef` P2P signaling path it does coordination and messaging
only — it does not proxy those file bytes. Separately, `/api/file/*` is a LAN
disk file store that does stream upload/download bytes.

## Domain docs (read these before diving into code)

- Read **`CONTEXT.md`** first. It defines the ubiquitous language
  (`participant` / `group` / `audience` / `task` / `checkpointRef` / `callbackRef`
  / `completion event` …) and the run topology. Use exactly those terms in issue
  titles, test names, refactor proposals and hypotheses — don't drift to
  synonyms.
- **`docs/architecture.md`** is the structural reference: directory tree, data
  model, API surface, and key flows.
- **`docs/adr/`** records the architecture decisions (message tree, trust model,
  single-scheduler executors, memory, role decoupling, durable completion
  events). Read the relevant ADR before working in an area; if your output
  contradicts one, surface the conflict explicitly rather than silently
  overriding it.
- If a referenced file doesn't exist, proceed silently — don't flag its absence
  or propose creating it up front.

## Workspace & commands

pnpm monorepo; packages live under `packages/**` (`@laizhixingxingdeli/…` scope).
Scheduling policy / env knob review lives in `docs/usage.md`.

| Task | Command |
| --- | --- |
| Install deps | `pnpm install` |
| Run dev servers (web :3000, API :3001) | `pnpm dev` |
| Build everything | `pnpm build` |
| Build frontend only | `pnpm build:frontend` |
| Lint | `pnpm lint` |
| Unit tests | `pnpm test` |
| E2E tests | `pnpm test:e2e` |
| Per-package test / types | `pnpm --filter @laizhixingxingdeli/server test` · `… check-types` |

Migrate the database before exercising the server:
`pnpm --filter @laizhixingxingdeli/database migrate`.

## Coding style

- **Frontend**: React + Vite + wouter; **backend**: Hono + Drizzle ORM + PostgreSQL.
- Linting and formatting are enforced by **Biome** (config in `biome.json`).
- Backend domain logic is split into focused, independently-testable modules
  (e.g. `lib/executor-task/` → types/state/output-buffer/output-parser/detail-store/notify/report/queue);
  keep the exported surface stable and unit-testable.
- TypeScript strict mode; run `check-types` after non-trivial changes.
- No new dependencies without justification.
- **Responsive breakpoints follow the container, not the viewport.** Tailwind's
  `sm:`/`md:`/`lg:` are viewport-based. A component rendered inside a
  fixed-width shell (the 480px group-settings drawer, a sidebar, a card) will
  match `lg:` on a wide desktop while having only ~445px to work with — the
  wide-layout branch then overflows a container that has no `overflow-x`, and
  the excess is unreachable. When a component can render inside such a shell,
  drive the layout from a prop (`embedded`), not from the viewport breakpoint.
  Verify with `clientWidth === scrollWidth` on the shell, not by eyeballing.
  (2026-09-02: `members.tsx` overflowed its drawer by 167px this way.)
  ⚠️ Adding `overflow-x-auto` as a safety net can backfire: it makes the element
  a scroll container, which under a `flex ... flex-col` parent loses
  `min-height: auto` and collapses the child (observed: 1093px content squashed
  to 57px). Fix the breakpoint, don't paper over it.

## 测试与验收(2026-09-07 一批修复中反复付学费的几条)

- **当前口径(2026-09-07 用户决策):由票面给出显式测试文件清单,执行器照单跑。**
  定向单文件示例:
  ```
  cd packages/backend/server && npx vitest run test/<文件>.test.ts
  ```
  不要根 `pnpm test`;不要 `pnpm --filter ... test`(带 `pretest`,会先构建
  database 与 error 两个包)。
- **历史口径(已取代)**:曾写「不要根 `pnpm test`(全量 77 文件 / 1140 用例,
  另一台主机历史实测 **~490 秒**,会超过执行器 180 秒命令超时);全量回归由
  检视者在 L3 跑;改动落在主干路径(`done` 分支、聚合函数、渲染入口)时必须
  跑全量」。**2026-09-07 用户决策**改为只跑票面清单内的文件。理由:本机
  (CoAgentHub 执行环境)全量实测 **1444 秒 / 约 24 分钟**(2026-09-07 13:48
  起跑,78 文件 / 1053 用例);当天已有执行器按旧规则跑全量、白耗约 40 分钟。
- **清单列错就会漏。** 只跑清单里想到的文件 = 只验证了「我想到的那部分」。
  同一天两次因此漏掉回归:一次 11 条既有用例转红,一次深比较断言未同步新字段。
  风险已从「跑不跑全量」转移到「票面清单准不准」——列文件时必须覆盖改动触及的
  既有测试,不能只列新增用例。
- **验收要走到最终产物,不能停在被测函数的返回值。** 单测里函数返回对了,
  生产路径在函数与落库之间还有一段(attempts 聚合、渲染、API 序列化),
  要求常常就在那段里丢掉。至少要有一次「读落库的 `diffSummary` 字段 /
  API 响应 / 界面渲染出的那一行」的动作。
- **加强测试本身可能把「没做」固化成「通过」。** 遇到 findings 票,逐条对着
  findings 核,不以测试通过替代 —— 曾有一轮新加逐字节 `toBe` 断言,
  锁的正是**旧**形状。

## 运行时与重启

- **改完 server 代码要重新构建再重启**,否则运行时仍是旧代码:
  ```
  cd packages/backend/server && npx tsx esbuild.config.ts
  scripts/coagenthub-prod.sh restart
  ```
  核对方式是 `curl -s localhost:3001/api/health` 的 `"stale": false`,
  不要靠「我记得我重启过」。
- **重启必须走 `scripts/coagenthub-prod.sh restart`,绝不 `nohup node dist/server.mjs`。**
  手工起的进程 pid 与 `/tmp/coagenthub-prod-3001.pid` 对不上,看门狗后续
  `restart` 会判「进程未被替换」并退出 1;连续 3 次后**永久停用自动重建**。
  2026-09-03~04 因此运行时卡在旧构建 22 小时,四轮协调链条撞同一个已修好的死结。
- 看门狗(`com.coagenthub.watchdog`,每 5 分钟)会自愈陈旧运行时,但**有在途任务时
  按 fail-closed 守卫等待**。发票前先看 `stale`,别指望它刚好在那个窗口动手。

## Git 提交边界

- **提交一律用 `git commit -- <明确路径>`。** `git add <路径>` 之后直接
  `git commit` 会把**暂存区里别人的改动一起带走** —— 工作树里常同时有多张票
  的在途产物。检视者 2026-09-04 因此把执行器的实现夹带进了 spec 提交。
- 拆开的办法:`git reset --soft HEAD~1` → `git reset HEAD -- <别人的路径>` →
  `git commit -- <自己的路径>`。

## Issue tracker

Issues and specs are tracked as GitHub issues, operated via the `gh` CLI (the
repo is inferred from `git remote -v`). PRs are **not** a triage surface.
GitHub shares one number space across issues and PRs, so a bare `#42` may be
either — resolve with `gh pr view 42`, falling back to `gh issue view 42`.

- **Create**: `gh issue create --title "..." --body "..."` (heredoc for multi-line).
- **Read**: `gh issue view <number> --comments`.
- **List**: `gh issue list --state open --json number,title,body,labels,comments --jq '...'`
- **Comment**: `gh issue comment <number> --body "..."`
- **Labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

When a skill says "publish to the issue tracker", create a GitHub issue; when
it says "fetch the relevant ticket", run `gh issue view <number> --comments`.

### Triage labels

| Role | Label | Meaning |
| --- | --- | --- |
| Needs triage | `needs-triage` | Maintainer needs to evaluate this issue |
| Needs info | `needs-info` | Waiting on the reporter for more information |
| Ready for agent | `ready-for-agent` | Fully specified, ready for an AFK agent |
| Ready for human | `ready-for-human` | Requires human implementation |
| Wontfix | `wontfix` | Will not be actioned |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the
corresponding label string from this table.

## Spec 状态词表

`specs/*.md` 头部的 `> **状态**:` 只能取以下 8 个值之一,后跟可选的 ` — 说明`
(说明里放日期、实现 commit、L3 结论等证据)。**这是目录里唯一能用来筛选的字段。**

| 值 | 含义 | 可下发? |
|---|---|---|
| `Draft` | 未冻结,内容还会改 | 否 |
| `Frozen` | 已冻结,`specHash` 可作验收锚点 | **是** |
| `Landed` | 已落地并通过检视 | 否(已完成) |
| `Partially landed` | 部分落地,说明里写清哪部分 | 视情况 |
| `Superseded` | 已作废/被取代,**不要按它下发** | 否 |
| `Partially superseded` | 部分被取代,说明里写清哪部分 | 视情况 |
| `Deferred` | 暂缓,说明里写清恢复条件 | 否 |
| `Living` | 活文档(架构契约等),非实现票 | 否 |

⚠️ **关票时必须更新状态。** 2026-09-02 盘点发现:146 份 spec 里 12 份标着
「Ready for Implementation」,其中 **11 份在 DB 里已有 done 任务**(4~20 个不等)——
状态从不随关票更新,于是整个目录看起来都是待办,真正开放的只有 7 份。
`Ready for Implementation` 已并入 `Frozen`(同义),不再使用。

## Spec-Driven workflow

CoAgentHub uses a Spec-Driven dispatch flow: the coordinator must not dispatch a
task until the implementation plan is fully settled in a **frozen** spec
(`specRef` + `specHash`). The full workflow lives in the reviewer and coordinator
skills:

- **三方编制（检视者在场）**：检视者 §3 grill 对齐需求 → **协调者（技术负责人）**
  按 reviewer skill §4–§5 做技术细化与工作项拆分（产物 `plans/<spec 同名>.md`，
  从 `specRef` 推路径）→ 检视者 §6 确认并冻结 `spec_published` → 协调者逐项下发
  与 L2，L3 仍由检视者做。协调者 skill **只指向** §4–§5，不复制写 spec 纪律。
- **两方编制（无 reviewer）**：协调者仍**整体**继承检视者职责 A（grill + 写 + 冻结），
  见 `skills/coordinator/SKILL.md` §1.2；不跑 L3。
- `skills/coordinator/SKILL.md` — 技术负责人：计划/诊断、派发、L2、编排 L3。
- `skills/reviewer/SKILL.md` — 用户入口：grill、冻结、L3。
- `specs/` — 冻结契约；`plans/` — 可变的工作项/诊断计划（平台不解析）。
- `docs/adr/` — 决策（含 ADR-0010 协调者技术负责人）。

The executor's method (implement → test → self-review → report) is carried by
`skills/executor/SKILL.md`; the task ticket only triggers that skill. When you
change workflow, spec, or skill behavior, keep `AGENTS.md` / `CONTEXT.md` /
`docs/architecture.md` / `docs/adr/` in sync.
