# Spec: 四家执行器的 token 账目不可比,默认执行器走的是已知失真的兜底

> **状态**: Frozen — 2026-09-07

## 1. 现象(2026-09-07 生产库实测)

本群全部带 `tokenUsage` 的任务,按执行器与采集来源分组:

| 执行器 | 采集来源 | 任务数 | 合计 tokens |
|---|---|---|---|
| codex | `codex-stdout-jsonl`(专用) | 35 | **35,232,029** |
| executor(AtomCode) | `atomcode-session-meta`(专用) | 5 | **23,396,484** |
| **pi** | **`generic-jsonl-scan`(兜底)** | 24 | **834,357** |
| **codebuddy** | **`generic-jsonl-scan`(兜底)** | 1 | 82,548 |
| executor / pi | (source 为空) | 3 | — |

**Pi 跑了 24 个任务合计 83 万 token,AtomCode 5 个任务合计 2340 万。**
两者量级差 28 倍而任务数相反 —— 这个数字不可能是真的。

`generic-jsonl-scan` 是已知失真的兜底路径:它曾把 codebuddy 少报 **400 倍**
(既有记录)。现在**默认执行器 Pi 走的正是它**。

## 2. 危害

- **成本不可比、不可信。** 「换哪个执行器更省」这类决策没有依据;
  2026-09-02 挑默认执行器时只能拿耗时中位数代替消耗量,因为账目不能用。
- **额度耗尽无法预警。** 真实消耗被系统性低估,平台看不出某个执行器正在逼近额度。
- **失真是静默的。** `source` 字段确实记了 `generic-jsonl-scan`,但没有任何地方
  提示「这个数不可信」,读数的人(和协调者)会把它当真值。

## 3. 已知根因(检视者此前排查,未修)

- **pi**:`collectTokenUsage` 的 if-else 链没有 `pi` 分支(只有
  codex / executor / codebuddy / claude),必然落到通用扫描。
  `~/.pi/agent/sessions` 目录存在,有可用的会话文件。
- **codebuddy**:专用采集器存在、路径存在(实测 420 个 jsonl)、
  `record.cwd === input.cwd` 也能匹配(仓库根下实测 1710 条),
  但 `matchingFiles.size === 1` 这一条在结构上不成立 ——
  实测**一个真实任务窗口跨 2 个会话文件、81 条 usage 记录**。

## 4. 要做的

**R1 Pi 接专用采集器。** 从 `~/.pi/agent/sessions` 读该次执行的会话文件,
取其 usage(pi 的 JSONL 事件里 `message.usage` 带
`input/output/cacheRead/cacheWrite/totalTokens`,现成)。

**R2 codebuddy 去掉 `matchingFiles.size === 1` 的唯一性断言。**
一次执行跨多个会话文件是常态,不是异常。改为按时间窗 + cwd 汇总全部匹配文件。
⚠️ 汇总方式要先用真实语料验证是**求和**还是**取末值**(累计式 usage 求和会翻倍),
判别函数本身必须先被验证 —— 不要凭形状猜。

**R3 兜底结果必须自带不可信标记。** 落 `generic-jsonl-scan` 时,
在 `tokenUsage` 里显式标注该值为估算且已知失真(如 `trusted: false`),
任务 API 与界面透出该标记。**没有专用采集器时宁可标为不可用,也不要给一个看着
像真值的数。**

**R4 `source` 为空不得发生。** 实测有 3 条任务 `tokenUsage` 存在但 `source` 为空,
说明还有一条未标注来源的写入路径。补齐或改为 `unavailable`。

## 5. 硬验收

⚠️ **必须用真实执行产生的语料,不得构造 JSONL。** 本缺陷的成因正是「通用扫描
按形状猜」,用构造样本验收会继承同一盲区。

1. 起一次真实 Pi 任务 → 断言 `tokenUsage.source` 是 pi 专用来源(不是
   `generic-jsonl-scan`),且 `totalTokens` 与该次会话文件里的 usage 一致。
2. 起一次真实 codebuddy 任务,**制造跨 2 个会话文件**的情形 →
   断言账目把两个文件都算进去(与手工汇总一致),不因唯一性断言而漏。
3. 无专用采集器的执行器 → 断言结果带 `trusted: false`(或等价标记)并被 API 透出。
4. 回归:codex 与 AtomCode 的既有账目数值不变(它们本来就是对的,别改坏)。

## 6. 不涉及

- 不改 token 的展示口径与计费逻辑(平台不计费)。
- 不改执行器配置与派发策略。
- 不为此引入新的依赖或后台服务。
