# Spec: 执行器适配器注册表——三处 key 分支收敛为一次查表

> **状态**: Frozen — 2026-09-02
> **版本**: 1.0
> **ADR**: [ADR-0008](../docs/adr/0008-executor-adaptation-config-over-code.md)
> **取代**: [executor-output-profile.md](executor-output-profile.md)(画像方案,暂缓)

## 1. 背景与决策

ADR-0008 要治的是「执行器适配散落在多处 + 静默漂移」。
`executor-output-profile.md` 提出用**声明式画像**(数据)解决,批1 已落
`executor_config.output_profile` 列(只存不读)。

**本票改为先做适配器注册表(代码),画像暂缓。** 理由(2026-09-02 实证):

1. **画像表达不了 token 采集。** 四家里三家不读 stdout,读的是家目录会话文件:

   | 执行器 | 账目来源 |
   |---|---|
   | codex | stdout JSONL `turn.completed.usage` |
   | atomcode | `~/.atomcode/sessions/*.meta` |
   | codebuddy | `~/.codebuddy/projects/**.jsonl` |
   | claude | `~/.claude/projects/**.jsonl` |

   后三者需要「扫目录 / 解析文件 / `startedAt`-`endedAt` 时间窗筛选 /
   `matchingFiles.size === 1` 唯一性断言」。要画像表达它,解释器得支持这些操作
   —— 那已不是字段映射表(ADR-0008 的判据),是在造语言。
   而 `executor-output-profile.md` §3 的硬验收要求四家全部用画像重写,**当场卡住**。

2. **以最小代码为目标,注册表严格更小。** 画像 = 解释器(匹配 / 路径求值 /
   跳过名单 / 折叠规则 / schema 校验)+ 每家一份数据;注册表 = 每家一份代码 +
   零解释器。只接 4~5 家时注册表总量明显更少。

3. **配错的暴露时机不同。** 画像来自 DB、用户可编辑,写错只在运行时表现为
   静默退到 raw 兜底;注册表由 TypeScript 类型 + 既有单测在提交前抓住。

⚠️ **画像不是被否决,是被推后。** 注册表是容器,画像是往容器里塞东西的一种方式。
`declarativeAdapter(profile)` 将来可作为注册表的一员共存 —— 能用画像表达的走画像,
表达不了的走代码。ADR-0008 要防的「三处分散」由**收敛到一个接口**解决,
不依赖画像。`output_profile` 列保留不动。

## 2. 现状:三处硬编码 key 分支

```
output-parser.ts:1136   createExecutorOutputParser   switch(codex/codebuddy/atomcode/executor/default)
token-usage.ts:524      collectTokenUsage            if-else(codex/executor/codebuddy/claude)+ 通用兜底
queue.ts:2097           finalText                    三元链(codex/codebuddy/其余通用)
```

⚠️ 三处的**覆盖集互不相同**,这本身就是漂移的证据:

| key | parser | token | finalText |
|---|---|---|---|
| codex | ✅ 专用 | ✅ 专用 | ✅ 专用 |
| codebuddy | ✅ 专用 | ✅ 专用 | ✅ 专用 |
| atomcode / executor | ✅ 专用 | ✅ 专用(`executor`) | ❌ 通用 |
| claude | ❌ 通用 | ✅ 专用 | ❌ 通用 |

## 3. 要做的

### R1 定义适配器接口

```ts
export interface ExecutorAdapter {
  /** 缺省 = 通用语义解析器(createGenericParser)。 */
  createParser?(): ExecutorOutputParser;
  /** 缺省 = 不提供专用采集(直接走通用扫描)。返回 undefined 同样降级到通用扫描。 */
  collectTokenUsage?(input: TokenUsageCollectionInput): TokenUsage | undefined;
  /** 缺省 = extractGenericJsonlText。 */
  extractFinalText?(stdout: string): string | undefined;
}
```

**三个方法全部可选**,缺省落到现有的通用实现。这是硬要求:`claude` 今天只有
token 专用实现,parser 与 finalText 走通用 —— 接口若强制全实现,就会逼出
凑数的空实现,漂移换个地方继续。

### R2 注册表与查表

```ts
const ADAPTERS = new Map<string, ExecutorAdapter>([...]);
export function adapterFor(key: string): ExecutorAdapter  // 未命中 → 空对象(全走缺省)
```

未知 key 仍记一次去重观测日志(沿用 `observeUnknownExecutorKey` 口径)。

### R3 三处调用点改为查表

- `createExecutorOutputParser(key)` → `adapterFor(key).createParser?.() ?? createGenericParser()`
- `collectTokenUsage` → `adapterFor(input.executorKey).collectTokenUsage?.(input)`,
  **`undefined` 时继续走既有通用扫描**(`collectGenericJsonl` → `unavailable`)。
  两级降级语义逐字保留(frozen spec R5)。
- `queue.ts:2097` 三元链 → `adapterFor(ex.key).extractFinalText?.(stdout) ?? extractGenericJsonlText(stdout)`

### R4 每家一个模块

`lib/executor-task/adapters/{codex,codebuddy,atomcode,claude}.ts`,
各自搬运现有实现,**函数体逐字不动**(只搬位置,不改逻辑)。

## 4. 硬验收

1. **既有测试逐字全绿,不得修改任何用例。** 本票是纯重构,零行为变化。
2. **`.scratch/probe/samples/` 三份真实样本**(codex / codebuddy / atomcode)
   经 `.scratch/probe/show-user-output.ts` 跑出的三段输出(实时输出流 / 完成卡片 /
   token 账目)与重构前**逐字节相同**。改动前先存一份基线。
3. **新增一家 = 新增一个文件 + `ADAPTERS` 一行**,零处修改既有分支。
   由 pi 接入(独立票)充当该判据的验证。
4. `claude` 仍只实现 `collectTokenUsage`,另两个方法缺省 —— 证明可选性生效。

## 5. 不涉及

- **不改任何解析 / 采集 / 提取的逻辑本身**(纯搬运)。
- 不做画像解释器;`output_profile` 列保留不动,仍不读。
- 不改 `onOutput` 的 stdout/stderr 来源参数 —— 那是
  `live-output-only-agent-narration.md` R2,独立票。
- 不修 codex `extractCodexExecText` 未命中(独立票)。**搬运时逐字保留该缺陷**,
  否则验收 2 的字节比对失效。
