# Plan: 执行器适配器注册表——三处 key 分支收敛为一次查表

> 配套 `specs/executor-adapter-registry.md`。spec 冻结后 `specHash` 作验收锚点；**本文件会变**（回填 taskId、标完成），不要写入 specs/。
> 路径规则：`specs/executor-adapter-registry.md` → `plans/executor-adapter-registry.md`。
> 平台不解析本文件。计划是提示，**task 事实是权威**。

## 元信息

| 字段 | 值 |
|---|---|
| specRef | `specs/executor-adapter-registry.md` |
| specHash | `4b4f13b9ef6efbb0d7847c7c3ac4e59bd778b1d3` |
| 编制 | 三方（reviewer=claude + coordinator=pi + executor=atomcode/codebuddy） |
| dispatchKind | requirement（检视者协调票口径；完整档 L3） |
| 更新 | 2026-09-11 |

## 现状核对（协调者 2026-09-11，与检视者复核一致）

三处 key 分支仍在（行号已漂，按内容定位）：

| 调用点 | 文件 | 形态 |
|---|---|---|
| `createExecutorOutputParser` | `output-parser.ts` ~1301 | `switch(executorKey)`：codex / codebuddy / **pi** / atomcode\|executor / default→generic |
| `collectTokenUsage` | `token-usage.ts` ~539 | if-else：codex / **executor** / codebuddy / claude；miss → generic scan；`GENERIC_SCAN_TRUSTED_KEYS={"pi"}` |
| finalText | `queue.ts` ~2557 | 三元：`ex.key==="codex"` → `extractCodexExecText`；`codebuddy` → `extractCodeBuddyStreamResult`；else → `extractGenericJsonlText` |

当前覆盖集（**必须逐字保留，含不一致**）：

| key | parser | token | finalText |
|---|---|---|---|
| codex | 专用 | 专用 | 专用 |
| codebuddy | 专用 | 专用 | 专用 |
| pi | 专用 | 通用（trusted via GENERIC_SCAN_TRUSTED_KEYS） | 通用 |
| claude | 通用 | 专用 | 通用 |
| atomcode | 专用 | **通用**（if 链只有 `executor`，没有 `atomcode`） | 通用 |
| executor | 专用(=atomcode parser) | 专用(`collectAtomCode`) | 通用 |

⚠️ **不要顺手补齐覆盖集**（例如给 pi 加专用 token / 给 atomcode 加 token 分支）——那是行为变更，另立票。

## 工作项

### W1 — 适配器注册表 + 三处查表收敛

| 字段 | 内容 |
|---|---|
| 稳定编号 | W1 |
| 目标 | 按冻结 spec R1–R4：定义 `ExecutorAdapter`、`adapterFor` 注册表；把三处 key 分支改为一次查表；每家一个 adapters 模块，**函数体逐字搬迁** |
| 范围 | `packages/backend/server/src/lib/executor-task/`：新建 `adapters/`（含 registry）；改 `output-parser.ts` / `token-usage.ts` / `queue.ts` 调用点；必要时经 `index.ts` 导出稳定面。不改 schema/迁移/scripts；不改解析/采集/提取逻辑本身 |
| 前置依赖 | 无 |
| 预期产物 | ① `adapters/types.ts`（或 registry 同文件）定义 `ExecutorAdapter` 三方法全可选 ② `adapters/registry.ts`：`ADAPTERS` Map + `adapterFor(key)`（未命中→空对象 + `observeUnknownExecutorKey` 口径） ③ `adapters/{codex,codebuddy,atomcode,claude,pi}.ts`——**pi 必须有**（现状已有专用 parser，搬迁后行为不变；spec 原文 R4 列表无 pi 是写票时尚未接入，检视者复核已确认 pi 在 parser switch 内） ④ 三处调用点改为查表 ⑤ git commit（独立提交边界） |
| 验收方法 | 见下「验收钉子」 |
| specRef | `specs/executor-adapter-registry.md` |
| specHash | `4b4f13b9ef6efbb0d7847c7c3ac4e59bd778b1d3` |
| taskId | `01a08f05-e1a6-7390-b986-9fbaff417ec2` |
| 状态 | L2 passed → 交回 L3（完整档） |
| 实现 commit | `248999b2b792b0a4a74154355879f1237790eb09` |
| L2 | 2026-09-11 协调者：§4 硬验收 1/3/4 通过；验收 2 本机无 `.scratch/probe` 按票跳过；R4 以 export+引用实现（函数体未物理搬迁，见结案 note） |

#### W1 实现要点（给执行器的技术边界，非行为变更）

1. **R1 接口**（方法全可选）:
   ```ts
   export interface ExecutorAdapter {
     createParser?(): ExecutorOutputParser;
     collectTokenUsage?(input: TokenUsageCollectionInput): TokenUsage | undefined;
     extractFinalText?(stdout: string): string | undefined;
   }
   ```
2. **R2 查表**: `adapterFor(key)` 未命中 → `{}`；未知 key 仍走 `observeUnknownExecutorKey`（与今日 default 分支同口径，去重观测）。
3. **R3 调用点**:
   - `createExecutorOutputParser(key)` → `adapterFor(key).createParser?.() ?? createGenericParser()`（未知 key 在 adapterFor 或此处仍 observe）
   - `collectTokenUsage` → 先 `adapterFor(key).collectTokenUsage?.(input)`；有值直接返回；**`undefined` 时完整保留**既有 `collectGenericJsonl` → `GENERIC_SCAN_TRUSTED_KEYS` → `unavailable` 两级降级（**含 pi 的 trusted:true**）
   - `queue.ts` finalText → `adapterFor(ex.key).extractFinalText?.(stdout) ?? extractGenericJsonlText(stdout)`
4. **R4 搬迁映射**（只搬位置，函数体逐字不动）:
   | adapter 文件 | createParser | collectTokenUsage | extractFinalText |
   |---|---|---|---|
   | codex | `createCodexParser` | `tokenUsageFromCodexJsonl(stdout)` | `extractCodexExecText` |
   | codebuddy | `createCodeBuddyParser` | `collectCodeBuddy` | `extractCodeBuddyStreamResult` |
   | atomcode | `createAtomCodeParser` | **仅 key=`executor` 时**挂 `collectAtomCode`；key=`atomcode` **不**挂 token（保持现状：atomcode 走通用）——可用两个 Map 条目：`atomcode` 只有 parser，`executor` 有 parser+token |
   | claude | （无） | `collectClaude` | （无） |
   | pi | `createPiParser` | （无） | （无） |
5. **红线**:
   - 未知 key **不得**抛错或返回空结果，必须落到通用路径
   - **不得**修改任何既有测试用例
   - **不得**「补齐」pi/atomcode/claude 缺失的专用实现
   - **不得**顺手修 `extractCodexExecText` 未命中缺陷
   - 不读/不改 `output_profile`；不做画像解释器
6. **测试清单**（只跑这些，失败数不增加；改前/改后各取基线）:
   ```
   node scripts/test-baseline.mjs packages/backend/server \
     test/output-parser.test.ts \
     test/token-usage.test.ts
   ```
   定向单文件：
   ```
   cd packages/backend/server && npx vitest run test/output-parser.test.ts test/token-usage.test.ts
   ```
   若存在 `.scratch/probe/samples/` 与 `show-user-output.ts`，按 spec 硬验收 2 存基线并逐字节比对；样本缺失则在汇报里写明并跳过，**不**伪造样本。
7. **提交**: `git commit -- <明确路径>`；message 按功能写（如 `refactor(executor-task): converge key branches into adapter registry`）。

## 依赖图

```
W1（单内聚重构，一次派发）
```

## 派发记录

| 轮次 | taskId | executor | 时刻 | 结果 |
|---|---|---|---|---|
| 1 | `01a08f05-e1a6-7390-b986-9fbaff417ec2` | codebuddy（atomcode 当时 recently_failed；票面「实现执行器:pi」与群角色冲突——pi 仅 coordinator，按 skill §2 不得自派，改派健康 executor） | 2026-09-11T05:52:02Z | queued，parent=`01a08f02-df68-7529-bc9d-749ce61dbe7e`，message=`01a08f05-e198-74b8-8557-0f0097030ca3`，specHash 钉死 |

## 诊断

本票为 requirement 重构，无 bug 诊断段。
