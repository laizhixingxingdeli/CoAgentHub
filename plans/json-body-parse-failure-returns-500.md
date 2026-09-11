# Plan: 请求体解析失败返回 500 —— 客户端错误被报成了服务器故障

> 配套 `specs/json-body-parse-failure-returns-500.md`。spec 冻结后 `specHash` 作验收锚点；**本文件会变**（回填 taskId、标完成），不要写入 specs/。
> 路径规则：`specs/<name>.md` → `plans/<name>.md`（从 `specRef` 推得）。
> 平台不解析本文件。计划是提示，**task 事实是权威**。

## 元信息

| 字段 | 值 |
|---|---|
| specRef | `specs/json-body-parse-failure-returns-500.md` |
| specHash | `e21c6f711afac871fc5440cd7d69b86e08251ace`（检视者 2026-09-11 冻结，commit `8e1756eb`） |
| 编制 | 三方（reviewer + coordinator 在场） |
| dispatchKind | `fix`（检视者分流；L3 精简档 `lite: true`） |
| 更新 | 2026-09-11 |
| 编制角色 | 协调者（技术负责人）§4–§5 |

## 先做哪一步、为什么

缺陷在**全局错误出口**一处，不在逐路由。一张工作项即可闭环：改 `onError`（及测试夹具镜像）+ 验收用例。拆多票只会制造无意义的接口依赖。

## 诊断（下发前）

| 字段 | 内容 |
|---|---|
| 现象 | `Content-Type: application/json` + 空/非法 body 的 POST 返回 **500** + `Internal Server Error` |
| 期望行为 | 返回 **400**，响应带 `requestId`；日志为 **warn** 而非 error |
| 复现步骤 | `curl -X POST -H 'Content-Type: application/json' -H 'X-Participant-Id: …' http://localhost:3001/api/participants`（无 body）→ 实测 500（2026-09-11 协调者复核） |
| 已观察事实及证据位置 | 1) 生产 `packages/backend/server/src/index.ts:63` `app.onError`：仅 `BizError` 用 `statusCode`，其余一律 500 + `errorLog.error`。2) Hono 内置 `validator`（`@hono/zod-validator` 底层）在 json 目标下 `c.req.json()` 失败时 **catch 后抛 `HTTPException(400, { message: "Malformed JSON in request body" })`**（`hono/dist/validator/validator.js`），**不是**裸 `SyntaxError` 直接进 onError。3) 自定义 onError **不识别 `HTTPException`**，把已正确标成 400 的客户端错误压成 500。4) 无 Content-Type / 无 body 时 validator 不读 json，落到 zod `safeParse` → 既有 400（与 §1.1 一致）。5) 测试夹具 `packages/backend/server/test/app.ts` **镜像**了同一套 onError（无 HTTPException 分支），单测必须两边一起改，否则只改 index 测不过 / 只改 test 生产仍坏。 |
| 根因假设 | **自定义 `onError` 吞掉了 Hono `HTTPException` 的 status**（body 解析失败路径已是 HTTPException(400)）。 |
| 验证动作与结果 | 对照 hono validator 源码 + 本机 curl 复现 500，与假设一致。 |
| **被排除的假设** | ❌「必须把所有 `SyntaxError` 映射成 400」——业务层 `throw new SyntaxError(...)` 与 `JSON.parse` 失败仍应 500；且生产路径上 body 解析错误在到达 onError 前已被 Hono 包成 `HTTPException`，一刀切 SyntaxError 既不必要也会误伤。❌「逐路由补 try/catch」——§1.2 全 API 同症，根在全局出口。❌「事件不存在归 409 是否合适」——属另票，本票不碰。 |
| 建议修复范围 | `index.ts` onError + `test/app.ts` 镜像 onError；新增回归测试文件；可选抽共享 `handleOnError` 避免两处漂移（若抽，仍只服务本缺陷，不借机重构路由）。 |
| **不能改变的行为** | BizError 分支；既有无 body→400 / 字段非法→400 / 事件不存在→409；任何路由业务语义；CORS/中间件顺序；不顺手统一其它状态码争议。 |
| 回归场景 | §1.1 四格；§1.2 五路由空 json body；handler 内 `throw new SyntaxError("boom")` 仍 500；日志级别。 |
| 最终产物验收方式 | 读 HTTP 状态码与 JSON 体（含 requestId）；读测试断言；`git status --porcelain` 无杂散未跟踪（§6）。 |

## 推荐实现（给执行器的技术方向，非强制字面）

### 判据（R2，必须在汇报写明）

**判据 = `err instanceof HTTPException`（来自 `hono/http-exception`），响应 status 用 `err.status`。**

为什么不会误伤业务层 `SyntaxError`：

1. Hono/`@hono/zod-validator` 在**请求体 JSON 解析**失败时，于 validator 内 catch 并抛出 **`HTTPException(400, "Malformed JSON in request body")`**——错误在进入 onError 前已被归因到「本次请求 body 解析」。
2. Handler / 业务逻辑里 `throw new SyntaxError(...)` 或未捕获的 `JSON.parse` 失败仍是 **`SyntaxError` 实例，不是 `HTTPException`** → 继续走「其余 → 500」。
3. **禁止** `err instanceof SyntaxError` → 400 的一刀切。

### 行为

| 错误 | status | 日志 |
|---|---|---|
| `BizError` | `err.statusCode` | warn（保持） |
| `HTTPException` 且 status &lt; 500 | `err.status` | **warn**（R3；含 message、requestId、method、path；不要静默） |
| `HTTPException` 且 status ≥ 500 | `err.status` | error |
| 其它 | 500 | error（保持） |

响应体：4xx/业务错误路径带 `requestId`（与现网 BizError 一致）。`HTTPException` 建议 `c.json({ message: err.message, requestId }, err.status)`（若 `err.res` 已存在可优先 `err.getResponse()` 再考虑是否附加 requestId——以实现时能通过验收 1/2 且形状稳定为准；不要引入新的公开错误码体系，除非沿用既有 `BizError`/`INVALID_REQUEST`）。

### 文件

| 文件 | 改动 |
|---|---|
| `packages/backend/server/src/index.ts` | onError 增加 HTTPException 分支 + 4xx warn |
| `packages/backend/server/test/app.ts` | **同步镜像**（测试入口与生产不得漂移） |
| `packages/backend/server/test/json-body-parse-failure.test.ts`（新建，名可微调） | 验收 1–4 的回归 |

可选：`packages/backend/server/src/lib/on-error.ts` 抽共享处理函数，index 与 test/app 共用——若抽，属本票范围；不抽则两处复制必须行为一致。

### 测试要点

1. **§1.1 形状**：对 claim（或等价 json 校验 POST）四种输入 → 400 / 400 / 409 / 400。第二种为 `Content-Type: application/json` + 空 body。
2. **§1.2 全局**：`ack` / `fail` / `groups/:id/messages` / `groups/:id/tasks` / `participants` 同手法均 400。
3. **R2 防线（验收 3，不可缺）**：挂一个仅测试用的路由或在既有 app 上临时 `app.post(..., () => { throw new SyntaxError("business boom") })`，断言 **仍 500**。
4. **日志**：可用 logger mock/spy 断言 body 解析失败走 warn 而非 error（若测试基建不便 spy winston，至少不回归 error 路径的断言文档化，并在汇报说明限制）。
5. **基线**：改前改后  
   `node scripts/test-baseline.mjs packages/backend/server test/json-body-parse-failure.test.ts test/app.ts`（及实际改动触及的既有文件；清单写汇报）。口径：**失败数不增加**。
6. `npx tsc --noEmit -p tsconfig.json`（在 `packages/backend/server`）通过；管道勿吞退出码。
7. §6：临时物进 `.scratch/`；`git status --porcelain` 除本票文件与用户长期未提交的 `docs/implementation-optimization-review-2026-09-07.md`、`start.ps1` 外为空。

## 工作项

### W1 — onError 识别 HTTPException + 回归测试

| 字段 | 内容 |
|---|---|
| 稳定编号 | W1 |
| 目标 | 请求体 JSON 解析失败返回 400（全局），业务 SyntaxError 仍 500；日志 4xx 为 warn 且留痕。 |
| 范围 | 见上表三文件（+ 可选 on-error 抽取）。**不改** BizError、路由业务语义、schema/迁移、其它状态码争议。 |
| 前置依赖 | 无 |
| 预期产物 | 实现提交；测试文件；汇报中写明 R2 判据与「为何不误伤」。 |
| 验收方法 | spec §4 全部 6 条；基线前后对照。 |
| specRef | `specs/json-body-parse-failure-returns-500.md` |
| specHash | `e21c6f711afac871fc5440cd7d69b86e08251ace` |
| taskId | `01a09025-1c3c-72da-b1de-5070a376083a`（平台 failed：executor pid 消失；实现已落地） |
| 提交 | `7c4e3cb0fd0f632eee8cd4a9d241036d29a593d1` |
| 状态 | L2 ✅ 通过（续跑 `01a09081-cdb3-74dc-82f8-f263297184f3`） |
| 执行器 | atomcode（Co-Authored-By 署名） |

## 依赖图

```
W1
```

## 派发记录

| 时间 | 动作 | taskId | 备注 |
|---|---|---|---|
| 2026-09-11T11:05:46Z | 下发 W1 → atomcode | `01a09025-1c3c-72da-b1de-5070a376083a` | messageId `01a09025-1c23-77b1-afc4-5a2a93564fc1`；parent `01a0901c` |
| 2026-09-11T12:46:59Z | 子任务平台 failed | 同上 | `executor pid 5664 no longer exists`；commit 已在 |
| 2026-09-11T12:47+ | 续跑 L2 ✅ | resume `01a09081` | 14/14 单测绿；tsc 0；交回 L3 lite |

## L2 结案摘要

- 验收 1–4：`test/json-body-parse-failure.test.ts` 14/14（§1.1 四格、§1.2 五路由、R2 SyntaxError→500、R3 warn）。
- 验收 6：server 包 `tsc --noEmit` exit 0。
- 判据 R2：`err instanceof HTTPException`（`lib/on-error.ts`），生产与 test/app 共用。
- 运行时 health `stale:true`，live 仍 500 直至重建——不否定代码验收。
- 交回 L3 精简档（fix / `lite: true`）。
