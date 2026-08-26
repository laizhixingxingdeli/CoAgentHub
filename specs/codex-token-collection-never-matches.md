# Spec: 协调者的 token 一次都没采到,十次全是 unavailable

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-26

## 现象

执行器采得到,协调者一次都采不到。库里实况:

| 执行方 | attempts 末次 `tokenUsage` |
|---|---|
| AtomCode | `{source: atomcode-session-meta, totalTokens: 907247, …}` |
| AtomCode | `{… totalTokens: 673642 …}` |
| AtomCode | `{… totalTokens: 10365075 …}` |
| **Codex** | **null,`tokenUsageReason = unavailable`(10 次全部)** |

后果:今天所有协调开销都没有记账。而协调者恰恰是**用强模型**的那一环,
它的消耗比执行器更值得看。

## 根因线索:stdout 是好的,读法不对

`collectTokenUsage`(`token-usage.ts:382`)对 `codex` 走
`tokenUsageFromCodexJsonl(input.stdout)`,该函数只认:

```ts
if (payload.type !== "token_count") continue;
const usage = readUsageObject(info?.total_token_usage ?? payload.total_token_usage);
```

**stdout 本身是有内容的** —— 同一份 `result.stdout` 被 `extractCodexExecText`
成功解析出了汇报文本(任务 summary 都不为空)。所以不是没拿到输出,
而是 **`token_count` 这个类型名或它的嵌套层级对不上**。

⚠️ 这与 `atomcode-token-wrong-field` 是**同一类错误**:照着想象中的结构写解析,
从未拿真实输出核对过。

## 决策

### R1. 先看真实输出,再改代码

⚠️ **动手前必须先 dump 一份真实的 codex stdout**,确认用量记录的实际类型名、
字段名与嵌套层级,再据此修正取值路径。**不要**凭 CLI 文档或既有代码猜。

获取方法:让平台跑一条最小的协调任务,或直接 `codex exec` 一条简单指令并
捕获 stdout;把其中与用量有关的那条记录原样贴进任务汇报。

### R2. 复用现有解析件

`readUsageObject` 已认识 `input`/`output`/`cached_input` 等键名,
`finishTotals` 已负责汇总。**只修取值路径**,不要新写一套解析。

### R3. 采不到仍如实记 unavailable

修正后若仍取不到,**照旧记 `unavailable`**。
⚠️ **不得**估算、不得回退到别处的数字、不得填 0。

### R4. 不动其它执行器分支

`executor`(AtomCode)/ `codebuddy` / `claude` 三个分支**逐字不变**(回归,必测)。
AtomCode 刚修好不久,不要顺手重构它。

### R5. 不改存储位置

仍写入 `attempts[].tokenUsage` 与 `attempts[].tokenUsageReason`,
**不新增字段、不改 `diffSummary` 结构**。前端怎么显示是另一票。

## 验收标准

- [ ] 任务汇报里**贴出真实 codex stdout 中用量记录的原样片段**(R1,必须)
- [ ] 用该真实片段做夹具,断言解析出的 input/output/total 与片段一致(必测)
- [ ] **真实跑一条协调任务**,其 `attempts[-1].tokenUsage` 非空且
      `totalTokens > 0` —— 本票唯一的真验收信号
- [ ] 该次记录的 `source` 能指明来源(如 `codex-stdout-jsonl`)
- [ ] 构造一份不含用量记录的 stdout → 仍记 `unavailable`,不估算(必测)
- [ ] `executor` / `codebuddy` / `claude` 三个分支未改动(回归,必测)
- [ ] 后端测试全绿,贴出用例数

## 不涉及

- 前端显示(另票 `token-usage-never-renders`)
- 其它执行器的采集(R4)
- 存储位置与结构(R5)

## 执行环境提示

- 实现位置:`packages/backend/server/src/lib/executor-task/token-usage.ts`
  的 `tokenUsageFromCodexJsonl`
- ⚠️ **先 dump 真实 stdout 再动手** —— 本票的根因正是照着想象写解析
- ⚠️ 本票**必须下发给执行器**完成
- ⚠️ 结案若被旧构建守卫拒绝,不要自行重启后端,以 `failed` 结案并写明
- ⚠️ 做完记得提交
