# Spec: 执行器被服务商拒绝(exit 0 + 零输出)却被记成 done

> **状态**: Frozen — 2026-09-07
> **相关**: [quota-misclassified-from-coordinator-narration.md](quota-misclassified-from-coordinator-narration.md)
> (那张管「不该判额度却判了」;本张管「该判失败却判成功了」)

## 1. 现象(2026-09-06 实证)

默认执行器 Pi 的 provider 账户余额不足,直接返回:

```
400 {"message":"credit insufficient balance: balance=1492 required=1738",
     "type":"api_error","code":"insufficient_user_quota"}
stopReason: "error"
```

进程**退出码 0**,stdout 零字节,token 用量全零。平台把该任务记为 **`done`**:

```
01a06cc5-97a2  done  pi
  tokenUsage: {inputTokens: 0, totalTokens: 0, outputTokens: 0}
  liveOutputTail: (空)
  reportMissingReason: "未采集到结构化汇报段(stdout 无「提交/测试/汇报/遗留」段头)"
```

同一形态另有一例:AtomCode `01a074c8-8747`,`exit 0` + 空输出。

## 2. 危害

**资源枯竭完全隐形。** 每一张票派下去都「成功」,却什么都没做:

- 协调者看到子任务 `done`,去做 L2,发现没有提交,判未通过,**重派**;
- 重派再次「成功」,再次无产出;直到三次上限交回检视者。
- 检视者看到的是「执行器连续失败」,而不是「执行器根本没跑」。

2026-09-06 因此连烧四轮才被发现,发现方式是人工直接跑一次 `pi` 看到那条 400。
**平台自身没有任何信号。**

判成 `done` 还有第二重代价:`done` 是终态成功,不进重试退避、不触发冷却、
不计入任何失败统计 —— 一个彻底坏掉的执行器在平台看来「健康且高产」。

## 3. 根因

完成回调只看退出码:`exit 0` → `done`。而 provider 层的错误(HTTP 4xx/5xx、
`stopReason: "error"`)发生在 CLI 内部,CLI 自身正常退出。
`reportMissingReason` 已经记录了「没有结构化汇报」,但**它只是备注,不影响终态**。

## 4. 要做的

**R1 零产出不得记 `done`。** 退出码为 0 但同时满足「无结构化汇报段」且
「token 用量为零或不可得」→ 判 `failed`,原因写明是零产出而非任务失败
(建议 `error: "executor-no-output"`)。
⚠️ 判据取**结构化事实**(有无汇报段 / 有无 token),不得靠猜输出长度阈值。

**R2 provider 错误要被识别并透出。** 执行器输出里出现 provider 错误结构
(JSON 含 `"type":"api_error"` / `stopReason:"error"` / HTTP 4xx-5xx 错误行)时,
把该错误原文带进 `diffSummary.error`,使协调者与检视者一眼看到「是服务商拒绝」,
而不是「执行器没做完」。
⚠️ 判据是**错误结构形状**,不是关键词计数 —— 与 quota 那张同一条纪律。

**R3 连续零产出要能被看见。** 同一执行器连续 N 次(建议 2)零产出 →
在 `/api/executors` 的可用性里透出(如 `unavailableReason: "连续零产出,疑似
provider 拒绝"`),并在群里告警一次。**不要冷却**(那会与真限流的处置混淆),
只要可见。

## 5. 硬验收

1. 用真实样本:Pi 的 400 余额不足输出(退出码 0、stdout 空、usage 全零)
   → 断言任务落 **`failed`** 且 `error` 含 provider 原文,**不是 `done`**。
2. 正常任务(有汇报段、token 非零)→ 仍落 `done`,不误伤。
3. 有汇报段但 token 不可得(账目采集降级,四家里有两家如此)→ **仍落 `done`**。
   ⚠️ 这条必须测:token 采集本身就不可靠(pi 无 collector、codebuddy 被
   `matchingFiles.size === 1` 挡住),拿它单独当判据会把正常任务判死。
4. 同一执行器连续 2 次零产出 → `/api/executors` 可读出该事实。

## 6. 不涉及

- 不改额度失败的判定与冷却(那是 `quota-misclassified-from-coordinator-narration`)。
- 不修 token 账目采集本身(独立议题,见缺陷池)。
- 不改 `reportMissingReason` 的既有文案与产出位置。
