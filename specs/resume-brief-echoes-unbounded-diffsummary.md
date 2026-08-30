# Spec: 续跑任务书无界回显子任务 diffSummary

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-30

## 1. 现象

子任务进入终态后,平台拉起协调者做 L2 检视,生成「续跑任务书」。该任务书把
**子任务的整个 `diffSummary` 裸 JSON 回显**进正文,无任何截断。

**实测(生产库,2026-08-30 核实):**

```
续跑任务 01a0524f-c080   brief 总长 123,051 字符
                         其自身 diffSummary 仅 757 字符
其子任务 01a05213-5040   diffSummary 121,930 字符,其中 outputTail 111,106

→ 121,930 / 123,051 = 99.1% 的任务书正文是子任务 diffSummary 的回显
```

brief 长度 Top 5 **全部是续跑任务书**:

```
01a0524f-c080  123,051
01a04f6a-e606   92,204
01a05011-0d40   85,247
01a0502b-fe44   83,143
01a04f1f-df43   80,536
```

### 1.1 危害

这段回显进入协调者的 prompt,并在其**后续每一轮对话中重复计费**。
按 4 字符/token 粗估,单条续跑任务书约 **3 万 token 纯传输**,内容是执行器的
原始输出尾部 —— 而这份全文**在 DB 里、在明细 API 里都拿得到**。

⚠️ **这是平台侧唯一可控的传输浪费。** 固定开销(任务书模板 + 必读文档)实测
仅占单任务均耗的 <0.4%,压缩它们零收益;99.6% 消耗在执行器自身迭代循环,
平台管不着。唯独这一处是平台自己搬运的。

### 1.2 同一文件内的防护不对称

```
coordinator-resume.ts:224   MAX_SUPERSEDED_ECHO_LENGTH = 4000   ← 被替代任务回显有上限
coordinator-resume.ts:319   JSON.stringify(childTask.diffSummary)  ← 裸插值,无上限
```

被替代任务回显做了截断,diffSummary 回显漏了。

## 2. 关键设计约束:必须「保尾」,不能「保头」

`diffSummary.outputTail` 的语义是执行器输出的**最近 500 行**(`queue.ts` 终态回填)。
而 L2 检视真正需要的信息 —— 执行器五段汇报(提交/测试/Token/汇报/遗留)、
失败原因、额度报错行 —— **全部在输出末尾**。

⚠️ 按直觉写 `slice(0, N)` 会**恰好切掉最值钱的尾部**,留下无用的中间过程输出。
**截断方向必须是保尾(`slice(-N)`)。** 这是本 spec 最容易做错的一点。

## 3. 改动范围

- `packages/backend/server/src/lib/executor-task/coordinator-resume.ts`

## 4. 详细改动

### R1 — 只截 `outputTail`,其余键原样保留

替换 `:319-324` 的裸 `JSON.stringify`:

- 若 `outputTail` 为字符串且超过上限 → **保留末尾** `MAX_RESUME_DS_ECHO_LENGTH`
  字符,前面替换为省略提示。
- **其余键全部原样保留**(`summary` / `tests` / `todo` / `hash` / `tokenUsage` /
  `claimVerification` / `error` / `platform.*` 等)—— 它们都是 KB 级以内,
  且正是 L2 检视的真正依据。
- 上限取具名常量,建议 **2000**(与同文件 `MAX_SUPERSEDED_ECHO_LENGTH = 4000`
  风格一致,取值更小是因为本处并非唯一信息源)。

### R2 — 截断必须留下可见信号与取回路径

省略处写明**省略了多少字符**,并附全文取回路径:

```
…(前 109106 字符省略;完整明细:GET /api/groups/{groupId}/tasks/{taskId}/output?detail=1)
```

⚠️ **静默截断是被禁止的降级**。协调者必须知道信息被截、知道去哪取全文。

### R3 — 只改任务书文本生成,不碰任何数据

- **不改 DB 中的 `diff_summary` 本体**。
- 不改前端任务卡片渲染。
- 不改两级输出(摘要流 / 明细 JSONL)的既有规则 —— 全文取回通道本就存在,
  本 spec 正是让任务书**停止重复搬运**它。

### R4 — 不涉及

- 不改 `MAX_SUPERSEDED_ECHO_LENGTH` 及被替代任务回显逻辑。
- 不改续跑任务的创建条件、防环判定(`isResumeTask` / `platform.resumeOf`)。
- 不清洗历史任务书。

## 5. 验收标准

1. 构造含 111K 字符 `outputTail` 的子任务 diffSummary → 回显中 `outputTail`
   长度 ≤ 上限 + 省略提示;**末尾 N 字符逐字保留**。必测。
2. **保尾方向必测**:fixture 的 outputTail 末尾放一段五段汇报
   (`提交: <hash>` / `测试: …` / `遗留: …`),断言回显中**能看到这段**。
   ⚠️ 这条是防「写成 slice(0,N)」的唯一闸门,不得省略。
3. `outputTail` 未超上限时,回显与旧版 `JSON.stringify` **完全一致**
   (小任务零行为变化)。必测。
4. 截断文本含**省略字符数**与明细 API 指引(可见信号)。必测。
5. `outputTail` 缺失 / 非字符串 / diffSummary 为 null 时不报错,行为与旧版一致。
6. DB 中 `diff_summary` 本体不受影响(断言写入路径未被触碰)。
7. 既有 coordinator-resume 测试全绿。

## 6. 不涉及的改动

- 不做任何 token 统计或聚合(数据口径问题另见批2)。
- 不改协调者 skill。
- 不改 schema、不加迁移。

## 7. 兼容性

- 纯文本生成改动,无 schema 变更、无 API 变更。
- 历史任务书不受影响(已生成的正文不回溯)。
- 小任务(outputTail 未超上限)回显逐字不变。
