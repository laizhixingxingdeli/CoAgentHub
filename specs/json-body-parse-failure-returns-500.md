# Spec: 请求体解析失败返回 500 —— 客户端错误被报成了服务器故障

> **状态**: **Landed — L3 通过(2026-09-11),实现 `7c4e3cb0`**
> **版本**: 1.0
> **日期**: 2026-09-11
>
> ## ✅ L3 收口记录(精简档,fix 票)
>
> 本轮是**第一次走完整 L3 协议**:从收件箱 `list` → `claim`(租约)→ 检视 →
> `post_message` 公布 `review_result`(消息 `01a09088`)→ `ack`(带
> `processingSummary`)。此前几轮检视者只做了实质、跳过了协议(详见
> `skills/reviewer/SKILL.md` §8/§10)。
>
> ### 协调者的诊断比票面更准
>
> 票面 R2 只写了「判据必须窄,不许一刀切 `SyntaxError→400`」,**没给出正确
> 判据**。协调者查到:Hono 的 validator 在 JSON 解析失败时**已经**抛
> `HTTPException(400, "Malformed JSON in request body")` —— 错误在进入
> `onError` 之前就已归因到「本次请求 body 解析」。判据 `err instanceof
> HTTPException` 天然窄,不需要票面担心的那种启发式。
>
> ### 一处票面没要求、执行侧自己判断出来的架构改进
>
> `test/app.ts` 原有一份**简化的 `onError` 副本**:
>
> ```js
> if (err instanceof BizError) { return c.json(..., err.statusCode) }
> return c.json({ message: "Internal Server Error" }, 500)
> ```
>
> 它逐字复刻了生产的缺陷。**任何对着这个夹具写的测试都会复现 bug 而不是抓住
> 它** —— 这正是该缺陷能长期存活的原因。本次抽成 `lib/on-error.ts` 由生产与
> 夹具共用,注释点明「漂移正是本缺陷的温床」。
>
> ### 检视者独立核实
>
> - `json-body-parse-failure.test.ts` 复跑 **14/14**,与 L2 自述一致;
> - 验收 3 的核心防线有覆盖:「handler 内 throw `SyntaxError` → 500
>   (不是一刀切 400)」,另加一条业务 `SyntaxError` 仍走 error 级日志的断言;
> - `git merge-base --is-ancestor 7c4e3cb0 HEAD` 确认已在主线;
> - `turbo run build --filter server` exit 0。
>
> ### 未做实机复验的理由
>
> L2 的 runtimeNote 写了「live curl still 500 until rebuild+restart」。检视者
> **当时刻意不重启**:`coagenthub-claude-code` 群有任务在跑,重启会造成孤儿。
> 后于 2026-09-11 13:10 在无在途任务时重启,`stale` 已清为 `false`。
>
> ### 子任务的死法已另立票
>
> 子任务 `01a09025` 在**提交之后**卡在回写守卫上,从 `#t2909` 重试到
> `#t6527`(约 3600 轮、1 小时 41 分)直至进程耗尽。实现没丢(提交在死之前),
> 但该失败模式会无限烧额度 —— 见
> [writeback-rejection-loop-burns-quota.md](writeback-rejection-loop-burns-quota.md)。
> **来源**: 检视者在补做 L3 认领流程时实地撞到 —— 第一反应是「平台故障」,
> 排查后才发现是自己漏传 body。**这正是本缺陷的危害:它让调用方朝错误的
> 方向排查。**

## 1. 背景与目标

### 1.1 现状证据(检视者实测,2026-09-11)

对 `POST /api/participants/:id/task-completion-events/:eventId/claim` 四种输入:

| 场景 | 实际状态码 | 应为 |
|---|---|---|
| 完全无 body | 400 | 400 ✓ |
| **声明 `Content-Type: application/json` + 空 body** | **500** | **400** ✗ |
| 合法 body、事件不存在 | 409 | 409 ✓ |
| body 字段非法(`leaseMs: 1`,低于 min) | 400 | 400 ✓ |

**只有第二种触发。** 但它恰恰是最容易被客户端写出来的一种 —— `fetch` 带
`headers: {"Content-Type":"application/json"}` 却忘了 `body`,就是这个形状。

### 1.2 不是单个路由,是全 API

同样手法(json header + 空 body)打其它 POST 路由:

| 路由 | 状态码 |
|---|---|
| `.../task-completion-events/:eventId/ack` | 500 |
| `.../task-completion-events/:eventId/fail` | 500 |
| `POST /api/groups/:id/messages` | 500 |
| `POST /api/groups/:id/tasks` | 500 |
| `POST /api/participants` | 500 |

**所有带 JSON 校验的 POST 路由都是。**

### 1.3 根因

`packages/backend/server/src/index.ts:63` 的 `app.onError`:

- `err instanceof BizError` → 用 `err.statusCode`(正确);
- **其余一律 500**。

Hono 的 `c.req.json()` 在 body 为空时抛 `SyntaxError`,落进「其余」那一支。

### 1.4 危害

不是「状态码不好看」:

- **调用方无法区分「我发错了」和「服务端坏了」** —— 检视者今天就先去查了
  server 日志和平台健康,之后才想到检查自己的请求;
- **5xx 告警会被客户端错误触发** —— 任何按 5xx 率做监控的东西都会被污染;
- 重试策略常按 5xx 判定「可重试」,而这种请求**重试多少次都不会成功**。

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/backend/server/src/index.ts` | `onError` 增加请求体解析失败的判定 |
| 对应测试 | 新增用例 |

若实现选择在校验层(zValidator hook / 中间件)而非 `onError` 处理,**允许**,
但必须说明为什么那样更好,并保证 §4 的验收同样成立。

**不改**:`BizError` 的既有处理;任何路由的业务语义;409/400 已经正确的那些
分支;CORS / 中间件顺序。

## 3. 详细改动

### R1. 请求体解析失败 → 400

判定为「请求体无法解析」时返回 **400**,响应体形状与既有 400 保持一致
(含 `requestId`,便于追踪)。

### R2. ⚠️ 判据必须窄,不许一刀切

**不要把所有 `SyntaxError` 映射成 400。** 业务逻辑里抛出的 `SyntaxError`
(例如解析某个执行器输出、解析配置文件)是**真正的 500**,把它压成 400 会
掩盖真实故障 —— 那比现在这个缺陷更糟。

判据必须能归因到**本次请求的 body 解析**这一步。具体怎么做由实现决定
(校验层捕获、错误来源标记、Hono 提供的类型判断等),但**票面要求实现者
在汇报里说明判据是什么、为什么它不会误伤业务层的 SyntaxError**。

### R3. 日志级别随之调整

当前这类失败走 `errorLog.error` 并打完整 stack。改判 400 后应降为警告级
(与既有 400 一致),否则日志里仍然堆着"服务器错误"。

⚠️ **但不要静默**:客户端错误也值得留痕(现在正是靠日志才定位到的),
只是不该以 error 级别报。

## 4. 验收标准

1. 对 §1.1 的四种输入,状态码分别为 **400 / 400 / 409 / 400** ——
   第二种由 500 改为 400,**其余三种逐字不变**。
2. §1.2 列的五个路由在同样手法下全部返回 400(说明判定是全局生效的,
   不是逐路由打补丁)。
3. **业务层 SyntaxError 仍返回 500**:构造一个在 handler 内部抛
   `SyntaxError` 的用例,断言它仍是 500。⚠️ **这条是本票的核心防线**,
   缺了它就无法证明 R2 的判据够窄。
4. 该类失败的日志不再以 error 级别出现,但仍有留痕。
5. 既有测试不新增失败。受影响文件的前后对照用
   `node scripts/test-baseline.mjs packages/backend/server <文件...>` 取,
   清单写进汇报。
6. `npx tsc --noEmit -p tsconfig.json` 通过。

## 5. 不涉及的改动

- 不改任何路由的业务语义与既有正确的状态码。
- 不改 `BizError` 体系。
- **不顺手统一其它状态码问题**。若排查中发现别的状态码可疑(例如 C 场景
  的「事件不存在」归 409 是否合适),**记进汇报,另立票**,不在本票动手。

## 6. 工作文件的去向(新增约束)

⚠️ 连续三张票在工作区留下了未跟踪的工作文件(`nul`、`.perf-runs/`、
`.gen-doc3.py`),每次都由 L3 顺手清理。**本票起明确要求**:

- 实施过程中产生的临时脚本、中间产物、生成器,**一律放 `.scratch/`**
  (该目录已被 gitignore);
- 交付时工作区**除本票应改的文件外不得有新增未跟踪项**;
- 若确需保留某个工具,把它作为正式交付纳入提交并说明用途,不要留成未跟踪。

验收:`git status --porcelain` 除本票改动与用户长期未提交的那两个文件
(`docs/implementation-optimization-review-2026-09-07.md`、`start.ps1`)外为空。

## 7. 兼容性

状态码由 500 改为 400 属**行为变更**,但方向是把错误归还给真正的责任方。
需确认:是否有既有调用方依赖「空 body 得到 5xx」这一行为(预计无 —— 那是
缺陷而非契约)。若发现有,在汇报里列出。
