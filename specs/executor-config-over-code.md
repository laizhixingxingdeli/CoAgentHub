# Spec: 执行器全配置化(批1)——去内置、补列、权限归位

> **状态**: Landed(2026-09-02 状态订正:DB 中该 specRef 有 20 个 done 任务为证;此前状态未随关票更新)
> **版本**: 1.0
> **日期**: 2026-08-29
> **ADR**: [ADR-0008](../docs/adr/0008-executor-adaptation-config-over-code.md)

## 1. 背景与目标

ADR-0008 决定:执行器适配「机制归代码,字段归配置」,`executor_config` 表成为唯一
真相源,接入新执行器不再改代码。本批是三批中的第一批,只做**结构与权限的归位**,
不动解析逻辑:

- 批1(本 spec):去内置 + 补配置列 + 下发权归群内角色 + usage 别名补全
- 批2(`executor-output-profile.md`):输出画像引擎,三个适配消费点改读画像
- 批3(`executor-onboarding-wizard.md`):接入向导,自动推断画像

本批落地后,**不需要专用解析的执行器已可纯界面接入**;需要专用解析的(如 pi)以
「通用解析器 + 正确 token 账目」的降级形态先跑起来,等批2。

## 2. 改动范围

| 文件 | 改动 |
|---|---|
| `packages/backend/database/src/schema/executor-config.ts` | 新增 4 列 |
| `packages/backend/database/drizzle/migrations/0027_*.sql` | 加列 |
| `packages/backend/database/drizzle/migrations/0028_*.sql` | seed 现有内置配置 + 清 reviewer 的 `participant.executor_key` |
| `packages/backend/server/src/lib/executors.ts` | 删 `DEFAULT_EXECUTORS` / `defaultExecutors` / `isBuiltinExecutorKey` / `DISPATCH_CAPABLE_KEYS` / `BUILTIN_PARTICIPANT_NAMES` / `ExecutorConfig.canDispatch` |
| `packages/backend/server/src/routes/executor/index.ts` | 删 403/409 两处内置禁令与 `builtin` 字段 |
| `packages/backend/server/src/lib/control.ts` | 删纯执行器防回环分支 |
| `packages/backend/server/src/routes/group/messages.ts` | `canCarryDispatcher` 去掉 `!senderIsPureExecutor` 合取项 |
| `packages/backend/server/src/lib/executor-task/token-usage.ts` | `readUsageObject` 补别名 |
| `packages/backend/server/test/**` | 18 个引用内置 key 的文件改 fixture 注入 |
| `docs/architecture.md` · `docs/usage.md` / `usage_CN.md` | 去掉「内置执行器」概念 |

## 3. 详细改动

### R1 — `executor_config` 补 4 列

```ts
// 同一执行器最大并发 running 任务数;null = 不限制。
maxConcurrency: integer("max_concurrency"),
// 任务书传递方式(见 R1.1);null 按 "path" 处理(既有行为)。
inputMode: text("input_mode"),
// spawn 时注入的额外环境变量(键值对);null = 无。
env: jsonb("env").$type<Record<string, string>>(),
// 输出画像(批2 消费,本批只加列不读);null = 走通用解析器。
outputProfile: jsonb("output_profile"),
```

- `ExecutorConfig`(代码侧接口)、`AddExecutorConfigInput`、`rowToConfig`、
  `updateExecutorConfig`、接入/编辑路由的入参 schema 同步放行这 4 个字段。
- `maxConcurrency` 落地后,调度侧既有的声明式并发上限逻辑对 DB 行**自动生效** ——
  今天的注释「DB 持久化配置暂无可持久化列,按缺省处理」随之删除。

#### R1.1 `inputMode` 取值

任务书今天靠 args 模板里手写 `{ticket}` / `{ticketContent}` 占位符表达,属于隐性
知识。本批把它显式化(占位符继续支持,`inputMode` 是更明确的等价表达):

| 值 | 含义 |
|---|---|
| `path`(缺省) | 任务书**文件路径**作为参数(codex / atomcode / codebuddy 现状) |
| `inline` | 任务书**正文**作为参数(hermes 现状,即 `{ticketContent}`) |
| `at-file` | 路径前缀 `@` 作为参数,由 CLI 自己内联(pi 的原生形态) |
| `stdin` | 正文经 stdin 喂入 |

⚠️ `stdin` 若当前 runner 不支持,**本批不实现它**,只在 schema 里保留取值并在
接入界面标注「暂不支持」——不得为了凑满枚举而写一条没跑过的分支。

### R2 — 删除内置执行器

- `DEFAULT_EXECUTORS`、`defaultExecutors()`、`isBuiltinExecutorKey()`、
  `BUILTIN_PARTICIPANT_NAMES`、`participantDisplayName()` 全部删除。
- `effectiveExecutors(db)` 只返回 `listExecutorConfigs(db).map(rowToConfig)`;
  短缓存与失效逻辑不变。
- `ensureExecutorParticipants(db)` 改为按 DB 行注册,展示名直接取 `agent_name`。
- 迁移 `0028` 把今天 `DEFAULT_EXECUTORS` 中的 **6 条**写入 `executor_config`
  (`executor` / `reasonix` / `codebuddy` / `codex` / `hermes` / `win-hermes`),
  逐字段照搬现值,含新的 `max_concurrency`(`executor`=1、`codex`=1,其余 null)。
  **`reviewer` 那条不迁移**(见 R3)。
  - `win-hermes` 的 `a2a.token` 今天从 env 读、不落库 —— 迁移后**仍从 env 读**,
    不得把 token 写进 DB。
  - 迁移必须幂等(`ON CONFLICT (key) DO NOTHING`):老装机重复执行不产生重复行,
    也不覆盖用户已改过的行。

### R3 — 下发权归群内角色

- 删 `DISPATCH_CAPABLE_KEYS` 与 `ExecutorConfig.canDispatch`。
- `messages.ts` 的判据简化为:

```ts
const canCarryDispatcher = membership.roles.some((r) =>
  (DISPATCH_ALLOWED_ROLES as readonly string[]).includes(r),
);
```

- `control.ts` 删掉「发送者是纯执行器 → 跳过」那段(它是同一道全局门的另一处)。
  控制门自己的 `CONTROL_ALLOWED_ROLES` 角色门槛**保持不变**。
- 内置 `reviewer` 那条假执行器不迁移、直接消失。迁移 `0028` 同时把
  `participant.executor_key = 'reviewer'` 的行清为 NULL,避免留下指向不存在配置的
  悬空 key。

⚠️ **行为变化必须在验收里确认**:reviewer participant 不再命中执行器配置,于是
定向给它的消息不再被当作任务创建(`isExecutorTarget` 为假),而是走普通消息/控制
指令路径。这**正是 spec v3.8 §3.17.4 想要的**(L3 不再向 reviewer 下发任务,
改由完成事件唤醒),但它是本批唯一的运行时行为变化,不得顺手带过。

### R4 — `readUsageObject` 补别名

在既有别名表中补:

- 缓存读:`cacheRead` / `cache_read`
- 缓存写:`cacheWrite` / `cache_write`
- 推理:`reasoning` / `reasoningTokens` / `reasoning_tokens`

⚠️ **只补别名,不改聚合口径**。「取最后一个 usage 对象」「total 缺省 =
input + output」这两条既有规则在本批**逐字不变** —— 聚合方式的修正属于批2 的
输出画像(`usage.aggregate`),在这里改会让其他执行器的账目口径静默漂移。

### R5 — 测试 fixture 化

18 个测试文件直接引用内置 key(`"codex"` / `"codebuddy"` / `executorKey: "executor"`)。
改为在测试内显式插入 `executor_config` 行(或注入配置桩),**不得**依赖「系统自带
某个 key」。

⚠️ 不得为了让测试通过而弱化断言;断言的是行为,不是内置清单。

## 4. 验收标准

1. 全新库 + 跑完迁移:`executor_config` 有且仅有 6 行,`reviewer` 不在其中;
   `effectiveExecutors()` 返回这 6 条,`executor` / `codex` 的 `maxConcurrency` 为 1。
2. 迁移重复执行第二次:行数不变,已被用户改过的行内容不被覆盖。
3. `PATCH /api/executor/executor` 改 args 与 model:返回 200,改动生效
   (`effectiveExecutors` 缓存失效后读到新值)。今天它返回 403。
4. `DELETE /api/executor/reasonix`:返回 200 并真的删除。今天它返回 409。
5. 界面接入一个新执行器并填 `maxConcurrency: 1`:并发下发两条任务,第二条保持
   `queued`,第一条终态后自动出队。今天 DB 行拿不到这个能力。
6. 群内持 `coordinator` 角色的 participant,**即便它同时是一个执行器配置**,
   其消息携带的 `dispatcher` / `callback` 路由信息被保留(不再被 `canDispatch`
   全局否决);群内只持 `executor` 角色的 participant 携带的同类信息仍被剥离,
   并产生 `CALLBACK_STRIPPED_NOT_AUTHORIZED` 警告。
7. 定向给 reviewer participant 的消息**不再创建任务**;`participant.executor_key`
   中不存在 `'reviewer'`。
8. `readUsageObject({input:1,output:2,cacheRead:3,cacheWrite:4,reasoning:5})`
   读出 cached=3;**且**既有 codex / codebuddy / atomcode / claude 的 token 用例
   结果逐字节不变(证明只补别名、没动口径)。
9. `pnpm --filter @laizhixingxingdeli/server test`、`… check-types`、`pnpm lint`
   全绿;`pnpm --filter @laizhixingxingdeli/database migrate` 在新库与老库上都通过。
10. 端到端:重启服务,participant 列表与改造前一致(6 个执行器身份,展示名不变)。

## 5. 不涉及的改动

- 不改任何解析逻辑:`output-parser.ts` 的 switch、`collectTokenUsage` 的 if-else 链、
  `queue.ts` 的汇报正文三元链**本批一律不动**(批2 处理)。
- 不实现 `outputProfile` 的读取——本批只加列。
- 不实现 `inputMode: "stdin"`。
- 不动 `DISPATCH_ALLOWED_ROLES` / `CONTROL_ALLOWED_ROLES` 的取值。
- 不改前端接入表单的字段布局(新列的界面呈现随批3 的向导一起做);本批只保证
  API 能收能存。
- 不引入 pi(等批2)。

## 6. 兼容性

- 老装机:迁移把内置配置写成 DB 行,participant 身份与展示名不变,协调者看到的
  执行器清单不变。
- 新装机:执行器列表为空,必须先接入 —— 这是 ADR-0008 明确接受的代价,由批3 的
  向导承接。在批3 落地前,新装机通过接入界面手填即可。
- `EXECUTOR_BIN_<KEY>` 覆盖保持不变。
- `win-hermes` 的 a2a token 仍只从 `COAGENTHUB_WIN_A2A_TOKEN` 读。

## 7. 拆票建议(串行,不并行)

| 票 | 内容 | 依赖 |
|---|---|---|
| T1 | R1 加列 + 迁移 0027 + 代码侧字段放行 | — |
| T2 | R2 去内置 + 迁移 0028 seed + 解锁 403/409 + R5 fixture 化 | T1 |
| T3 | R3 权限归位(删 canDispatch / reviewer 条目 / 清 executor_key) | T2 |
| T4 | R4 别名补全 | — |

T1 与 T4 互不相干,但**仍串行下发** —— 当前 runner 共享同一 git 工作区。
