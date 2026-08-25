# Spec: AtomCode token 采集读错字段,从未成功过一次

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-25
> **修正**: `token-usage-from-cli-records`(`13fb895e`)的 AtomCode 分支

## 现象

`token-usage-from-cli-records` 落地后,**每一张 AtomCode 票的 `tokenUsageReason`
都是 `unavailable`**,零成功。界面上 token 列永远是空的。

## 根因一:读的 key 不存在

`token-usage.ts` 的 `collectAtomCode` 这样取值:

```ts
const tokens = (stat as Record<string, unknown>).tokens;
const usage = readUsageObject(tokens);
```

而 AtomCode 的 `turn_stats[]` 条目**没有 `tokens` 这个 key**。实测键集:

```
after_message, position_valid, turn_id, round_count, tool_call_count,
duration_ms, total_tokens, errored, used_tokens, ctx_window, model_usage
```

于是 `readUsageObject(undefined)` 恒为 `undefined` → `totals.totalTokens` 恒为 0
→ `if (totals.totalTokens > 0)` 恒不成立 → `matches` 恒空 → `unavailable`。

**数据一直都在**,只是在别处:

```json
"model_usage": [
  {"provider_id":"AtomGit-deepseek-v4-flash","model_id":"deepseek-v4-flash",
   "tokens":{"input":77201,"output":35216,"cached_input":1899008}}
]
```

`model_usage[].tokens` 的 `input` / `output` / `cached_input` **恰好是
`readUsageObject` 已经认识的键名** —— 取值路径错了一层,不是格式不兼容。

实测两票(本轮 `01a038ba` / `01a038ab`):

| 票 | input | output | cached_input | turn.total_tokens | turn.used_tokens |
|---|---|---|---|---|---|
| `01a038ba` | 77,201 | 35,216 | 1,899,008 | 77,173 | 75,257 |
| `01a038ab` | 254,916 | 58,922 | 3,939,456 | 128,150 | 126,915 |

## 根因二:`total_tokens` 不是消耗量,不能当消耗量用

注意上表:`turn.total_tokens`(77,173)**小于**同一轮的 `input`(77,201),
且与 `input+output` 差了一个量级。结合 `ctx_window: 512000` 一起看,
**`total_tokens` / `used_tokens` 是上下文占用量,不是累计消耗量**。

所以**不要**用 `total_tokens` 填 `TokenUsage.totalTokens` —— 那会把「上下文有多满」
显示成「花了多少 token」,是个看起来有数、实则错误的指标,比空着更糟。

## 根因三:匹配锚太弱,而更强的锚就在文件里

现行匹配是「`working_dir` 相同 + 时间窗相交 + 恰好命中一个」。同一个仓库串行跑票时,
相邻两票的时间窗很容易相交,`matches.length === 1` 一旦不成立就静默退回 `unavailable`。

而 meta 里的 `name` 字段**就是任务书路径**:

```json
"name": "/tmp/coagenthub-ticket-01a038ba-c480-709"
```

这是**任务身份的直接证据**,不是启发式。(注意它被截断到 ~40 字符,
只保留了 taskId 的前缀,所以要按前缀匹配,不能全等比 taskId。)

## 要求

### R1. 从 `model_usage[].tokens` 取值

对每个 turn,遍历 `turn_stats[].model_usage[]`,把每项的 `tokens`
交给现有 `readUsageObject` 并累加。**不新增解析分支** —— `input`/`output`/
`cached_input` 已在 `readUsageObject` 的别名表里。

- 一个 turn 可能有多个 model(不同模型分别计),**全部累加**
- `model_usage` 缺失或为空数组的 turn **跳过**,不算失败

### R2. 不用 `total_tokens` 当消耗量

`TokenUsage.totalTokens` 仍由 `readUsageObject` 按
`input + cached_input + output` 计算。**不得**回退到 `turn.total_tokens`
或 `used_tokens`(理由见根因二)。

⚠️ 如果实现时发现某些 meta **只有** `total_tokens` 而无 `model_usage`,
**不要**拿它凑数 —— 该 turn 跳过即可。

### R3. 匹配锚改用 meta 的 `name`

`collectAtomCode` 的匹配判据改为:

1. **首选**:`session.name` 是形如 `/tmp/coagenthub-ticket-<taskId前缀>...`
   的字符串,且该前缀是本任务 `taskId` 的前缀 → **命中,直接采用,不再看时间窗**
2. **回退**:name 不是任务书路径(手工会话等)→ 沿用现行的
   `working_dir` + 时间窗 + `matches.length === 1`

因此 `TokenUsageCollectionInput` 需要新增 `taskId`(可选);
调用方在 `queue.ts` 传入。

⚠️ **前缀方向要对**:meta 的 name 里是被截断的短前缀,`taskId` 是完整 uuid,
所以判定是「taskId 以该短前缀开头」,不是反过来。

### R4. 采不到仍然如实记 `unavailable`

**不得**在采不到时估算、回退到自报、或填 0。现行「显式记录 reason」的行为保留。

### R5. 不改其他执行器分支

**不改** codex / claude / codebuddy 的采集逻辑,**不改** `readUsageObject`。

## 验收标准

- [ ] 用**真实 meta 文件**(`~/.atomcode/sessions/**/*.meta`)构造测试夹具,
      断言解析出 `input`/`output`/`cached_input`,数值与文件一致
- [ ] 单个 turn 含**多个 model_usage 条目**时正确累加
- [ ] `model_usage` 缺失的 turn 被跳过,不导致整体失败
- [ ] `totalTokens` **不等于** `turn.total_tokens`(反向断言,防回退)
- [ ] `name` 前缀命中时,即使时间窗与另一会话相交也能唯一命中
- [ ] `name` 非任务书路径时回退到旧判据(回归)
- [ ] 采不到时仍记 `unavailable`,不估算(回归)
- [ ] codex / claude / codebuddy 分支未改动(回归,必测)
- [ ] **真实跑一票 AtomCode 任务**,`diff_summary->'tokenUsage'` 非空,
      数值与该票 meta 文件对得上 —— **这是本票唯一的真验收信号**
- [ ] 后端测试全绿,贴出用例数

## 不涉及

- 前端 token 展示(已由 `observability-fields-in-ui` 落地)
- 其他执行器的采集(R5)
- 自报 token(仍显式丢弃)

## 执行环境提示

- 实现位置:`packages/backend/server/src/lib/executor-task/token-usage.ts`
  的 `collectAtomCode`;调用方 `executor-task/queue.ts`
- 真实样本:`~/.atomcode/sessions/f20b76692b59f50c/*.meta`
  —— **先 cat 一个真文件再动手**,本票的根因正是照着想象中的结构写代码
- ⚠️ 做完记得提交
