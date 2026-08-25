# Spec: token 消耗改由平台采集,不再依赖 agent 自报

> **状态**: Landed — L3 通过(2026-08-25),实现 `13fb895e`
> **版本**: 1.0
> **日期**: 2026-08-25
> **取代**: `token-usage-extraction.md` 的自报路径(该 spec 其余部分不变)

## 背景:自报机制形同虚设

现状是任务书要求执行器汇报 `Token: <数量>`,平台解析后存进
`attempts[].tokenUsage`。实测 89 条执行任务:

```
有 token 数据的      14 条(16%)
```

而这 14 条里的值:

```
未测量                          ← 字符串直接存进了「纯数字字符串」字段
9  18  29  45  46  118          ← 量级不可能是一次执行的 token 数
30000  42000  68000  120000     ← 这些才像
```

三个问题叠加:**覆盖率 16%**、**无任何校验**(schema 注释写「纯数字字符串」但
「未测量」照样存)、**量级差三个数量级**(执行器对该字段的理解不一致)。

**根因是它依赖 agent 自觉汇报** —— 这与本轮反复验证的规律一致:
没被结构兜住的说明,对 agent 等于不存在。

## 已查明的可用数据源

CLI **自己**会记账,那不是 agent 自报,agent 也改不了:

| 执行器 | 原生 usage | 位置与字段 |
|---|---|---|
| **codex** | ✅ | `~/.codex/sessions/<年>/<月>/<日>/rollout-<ISO时间>-<uuid>.jsonl` → `total_token_usage`(含 `input_tokens` / `cached_input_tokens` / `output_tokens` / `reasoning_output_tokens` / `total_tokens`) |
| **claude** | ✅ | `~/.claude/projects/<slug>/*.jsonl` → 每条消息的 `usage` |
| atomcode | ✅(**本 spec 原判断有误,已由实现核验推翻**)| `~/.atomcode/**/*.meta` → `total_tokens` / `used_tokens` |
| codebuddy | ✅(**本 spec 原判断有误,已由实现核验推翻**)| `~/.codebuddy/projects/**/*.jsonl` → `usage`(sessions/<pid>.json 确实只有心跳,但不是唯一位置)|

### ⚠️ 一个已查明的硬约束

**`codex exec --ephemeral` 不写 rollout 文件。** 实测:最新 rollout 停在
`2026-08-22`,而本轮(8-24/25)所有 codex 任务都没有对应记录 ——
平台正是以 `--ephemeral` 启动 codex 的(`executors.ts`)。

**所以「读 codex rollout」这条路,在当前启动参数下拿不到数据。**
这一点必须在实现前先验证清楚,不要照搬本 spec 的表格就动手。

## 要求

### R1. 先做可行性核验,再动手实现

**这是本票的第一步,产出是结论不是代码。** 逐项核实并写进汇报:

1. `codex exec --ephemeral` 是否真的不写 rollout?若去掉 `--ephemeral` 会写吗?
   去掉的代价是什么(每票复用上下文,与「每票冷启动」的设计冲突)?
2. codex 是否有别的方式输出 usage(stdout 尾部、环境变量、CLI 参数)?
   —— 检视者曾在 codex 输出中见过 `tokens used\n23,480` 字样,**但那是交互
   模式还是 exec 模式未确认**。
3. claude 的 jsonl 能否按「本次执行的时间窗 + cwd」定位到具体任务?
4. atomcode / codebuddy 确无原生记录,还是藏在别处?

**若核验结论是「当前架构下拿不到」,如实写进汇报并停止实现** ——
不要为了交付而退回自报方案或伪造数据源。这条比实现更重要。

### R2. 能采到的才采,采不到的明确标记

对每个执行器,`tokenUsage` 的取值只有三种,**不允许第四种**:

| 情形 | 值 |
|---|---|
| 采集成功 | 结构化对象(见 R3) |
| 该执行器无原生记录 | `null` + 原因标记 `"unsupported"` |
| 有记录但本次未采到 | `null` + 原因标记 `"unavailable"` |

⚠️ **不得回落到 agent 自报**,不得写入「未测量」这类自由文本。

### R3. 字段改为结构化,不再是字符串

```ts
tokenUsage?: {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  totalTokens: number;
  source: "codex-rollout" | "claude-jsonl" | ...;   // 采集来源,便于追溯
} | null;
reason?: "unsupported" | "unavailable";
```

**必须带 `source`** —— 数据来自哪里,和数据本身一样重要。本轮多次因为
「不知道这个数字哪来的」而无法判断可信度。

### R4. 采集时机与定位方式

任务落终态时采集。定位方式按执行器:

- 有 `executorPid` 的(`restart-recovery-must-check-liveness` 已加该列)→ 优先按 pid
- 否则按「执行时间窗 + cwd」匹配

**匹配不上就是 `unavailable`,不要猜**。

### R5. 不改这些

- **不改**任务书模板里的 `Token:` 汇报要求 —— 保留作为交叉校验的参考,
  但**平台不再据它落库**
- **不改**执行器启动参数(除非 R1 的核验结论明确要求,且需在汇报中论证代价)
- **不做**成本换算、不做跨执行器比较 —— 本票只负责把真实数字采上来

## 验收标准

- [ ] **R1 的四项核验结论已写进汇报**,每项有依据(命令输出 / 文件路径 / 实测)
- [ ] 若结论为「拿不到」→ 如实说明并停止,**不退回自报、不伪造**
- [ ] 若可采集:`tokenUsage` 为结构化对象且含 `source`
- [ ] 无原生记录的执行器 → `null` + `reason: "unsupported"`
- [ ] 有记录但未匹配到 → `null` + `reason: "unavailable"`
- [ ] **不存在**「未测量」这类自由文本值(回归:现有脏数据不回填,但新写入不允许)
- [ ] 定位优先用 `executorPid`,匹配不上不猜
- [ ] **未改动**执行器启动参数(或已在汇报中论证代价)
- [ ] 后端测试全绿,贴出用例数

## 不涉及

- 成本换算与执行器比较(R5)
- 历史脏数据回填
- 前端展示 token(另开票)

## 执行环境提示

- 本仓 pnpm 项目,后端为**生产模式**
- 相关列:`task.attempts[].tokenUsage`(现为 string)、`task.executor_pid`
- ⚠️ **不得停止或重启后端**;做完记得提交
