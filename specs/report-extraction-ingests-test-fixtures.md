# Spec: 汇报提取吃进测试夹具,把假 hash 和源码当成提交与汇报

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-30

## 1. 现象

执行器跑测试时,**测试夹具里的假提交 hash 与源码片段进入 stdout**,
汇报提取器把它们当成了「提交」与「汇报正文」上报。

**实证(群 01a03be2-4a58,2026-08-30):**

```
01a0516a-7ab8  hash=0123456789ab  not_found  summary="\n  group?.projectPath ?? null,\n );\n return declaredRo…"
01a0512b-dceb  hash=0123456789ab  not_found  summary="oid> {\n const diffSummary: Record<string, unknown> = { err…"
01a04fe3-cdf1  hash=0123456789ab  not_found  summary="kens\":36021,\"cost\":{\"input\":0.00104975,…"
```

三条报的是**同一个假 hash**,`summary` 全是**源码片段或 JSON 碎片**。

该 hash 的来源已确认 —— 仓库测试文件里的夹具常量,出现 **62 次**:

```
packages/backend/server/test/executor-task-repo.test.ts:32
  'echo "commit 0123456789abcdef0123456789abcdef01234567"'
packages/backend/server/test/coordination-close-integrity.test.ts:770
  const missingHash = "0123456789abcdef0123456789abcdef01234567";
packages/backend/server/test/claim-verification.test.ts:53
  verifyCommitClaim("0123456789abcdef", dir, [ … ])
```

### 1.1 危害分层(据此定验收单位)

| 层 | 是否受损 | 说明 |
|---|---|---|
| **正确性** | ❌ 未受损 | `claimVerification` **全部拦下**(三条均 `not_found`),没有错误结论被放行 |
| **可读性** | ✅ 受损 | 前端展示给人的汇报是乱码源码(用户 2026-08-30 截图指出) |
| **L2 输入** | ✅ 受损 | 协调者读 `diffSummary.summary` 拿到源码,须自行重新查证 |
| **token** | ✅ 受损 | 无效正文进入摘要流与协调者上下文 |

⚠️ **平台的提交核实防线是有效的,本 spec 不动它。** 要修的是**提取**这一步。

### 1.2 规模

```
pi        11 条完成任务中 5 条 claimVerification=not_found
AtomCode  14 条中 5 条 not_found + 2 条 outside_window
```

## 2. 根因

汇报提取在执行器 stdout 里按形态找「提交 hash」与「汇报正文」,
**没有区分「执行器在陈述自己的结果」与「执行器在回显它读到/写入的文件内容」**。

测试输出、`read_file` / `edit_file` 的工具参数与返回、diff 片段,
都会把源码与夹具常量带进 stdout。

## 3. 决策

### R1 — 提交 hash 只采信执行器**明确声明**的位置

- 只从汇报段的**结构化字段**(如「提交: <hash>」行、五段式汇报的对应段)采集,
  **不得**在整个 stdout 里做形态扫描(`[0-9a-f]{7,40}`)。
- ⚠️ **判据用位置,不用内容** —— 不得靠「排除已知夹具值」来打补丁:
  夹具值会变,位置不会。**明确禁止**把 `0123456789ab…` 加进任何排除名单。

### R2 — 汇报正文只取汇报段,取不到就如实为空

- 取不到结构化汇报段时,`summary` **留空并标注原因**,
  **不得**回退成「取 stdout 尾部若干行」——那正是源码混入的来路。
- 前端与协调者看到「未采集到汇报」比看到一段源码**更有用**:
  前者是准确的空,后者是伪装成内容的噪音。

### R3 — 不改的东西

- 不改 `claimVerification` / `claimAdjudication`(它们工作正常,是最后防线)。
- 不改两层级输出(摘要流 / 明细)的既有过滤规则。
- 不改任何执行器的 `outputProfile` 配置结构(那是批2 范围)。
- 不清洗历史记录 —— 上面三条是本 spec 的实证。

## 4. 验收标准

1. 构造一份含 `commit 0123456789abcdef…` 字样但**不在汇报段**的 stdout
   (模拟测试输出)→ 提取结果的 hash 为**空**,不得为该夹具值。必测。
2. 构造一份汇报段里写明「提交: <真实 hash>」的 stdout → 正确提取该 hash。必测。
3. 取不到汇报段时:`summary` 为空并带原因标注;
   **断言其中不含源码特征**(如 `=>` / `const ` / `);` 连续出现)。必测。
4. **不得存在夹具值排除名单**:全仓 grep `0123456789ab` 在 `src/` 下零命中。必测。
5. 既有能正确提取的样本(pi / AtomCode / codex 各一)行为**逐字不变**(回归)。
6. `claimVerification` 相关测试全绿且未被修改。

## 5. 不涉及

- 不改执行器一侧的输出格式(那要各 CLI 配合,属批2 输出画像)。
- 不做「从 git 反查本次提交」——那是 `claimVerification` 已有的职责。
- 不改前端。

## 6. 兼容性

- 提取更严格后,部分历史上能「碰巧提取到」的场景会变成空 ——
  这是**预期**的:空是准确的,假 hash 不是。
