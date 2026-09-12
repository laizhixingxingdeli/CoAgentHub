# Spec: 测试依赖 gitignored 的执行器采样,任何 checkout 都跑不过

> **状态**: **Landed**(`5d42f961` + `985f0a2b`)
>
> ~~Partially landed —— ENOENT 已消除,但 6 条硬验收改为 skip,不产生证据。~~
>
> **2026-09-12 复核:整票已收口,状态行此前陈旧。**
> 后继票 [re-record-executor-probe-samples.md](re-record-executor-probe-samples.md)
> 已 Landed(`985f0a2b`),检视者复核三条事实:
> ① 采样 fixtures **已入库**(`git ls-files test/fixtures/` 可见
> `atomcode-run.stdout` / `codex-error-run.jsonl` / `pi-run.jsonl` 等);
> ② 当初那 **6 条 skip 已全部消失**;
> ③ 全测试目录仅剩 `executor-queue.test.ts` 两条 `skipIf(win32)` 平台守卫,
> 与本票无关。
>
> ⚠️ **留痕**:本票挂着 Partially 挂了 4 天,而实际早已由后继票收口。
> **后继票 Landed 时要回头改前票的状态行** —— 否则 backlog 里会长期躺着
> 一条其实没有活的条目,每次盘点都要重新查一遍才敢划掉。
> **版本**: 1.0
> **日期**: 2026-09-08
>
> **L3 收口记录(检视者独立复核)**:
> - 基线自行复跑:`1 failed | 125 passed (132)`,含 **6 skipped**。
>   改前两个文件**整份 ENOENT、加载不了**,一条证据都不产生。
> - **R1(样本入库)被执行者驳回,检视者确认驳回成立**:
>   任务书里检视者说「`logs/` 下有真样本,别走 skipIf」——
>   **这个前提是错的**。那批用例锁的是**某一次特定探针**的
>   哈希 / token / 正文;`logs/*.log` 来自**不同任务**,
>   **格式相同、内容不同**,拿来必红。于是三条路全堵:
>   用 logs 要改断言(违反「不放宽」)、手写探针要伪造(违反 R3)、
>   只剩 R2。**执行者的判断是对的,检视者的票面前提是错的。**
> - **额外的正确改动(未要求)**:把 `token-usage` 里的静默 `return`
>   改成显式 skip —— 否则 CI 会把「没跑」记成「过了」。
> - **新暴露(不是新造)的 1 条红**:`atomcode-task-01a04f70-outputTail.txt`
>   本机是 CRLF,断言要求无 `\r`。改前整文件 ENOENT,这条**根本没跑到**;
>   修好加载后才显形。已另立
>   [fixture-line-endings-break-on-windows.md](fixture-line-endings-break-on-windows.md)。
> - 提交边界:仅两个 test 文件;零生产代码;用户在途工作未被夹带。
>
> **执行者回提的两条 spec 改进意见,检视者确认成立**:
> ① §3 R3 应显式写:logs 若来自**不同任务**、无法满足已锁哈希/token/正文时,
>    **不得**为迁就 logs 改断言,应走 R2;
> ② 「logs 足够覆盖断言」这个说法有误导性 ——
>    它覆盖的是**格式**,不是这批用例锁死的**那一次探针内容**。
> **来源**: `docs/implementation-optimization-review-2026-09-07.md` §13.3 **V2**
> **检视者补充实测(2026-09-08)**:比报告描述的更严重 ——
> `.scratch/probe/samples/` 在**采集样本的这台机器上也已经不存在了**
> (`ls .scratch/probe/samples/` 为空)。这批用例现在**哪台机器都过不了**,
> 不只是「只能在某一台机器上通过」。

## 1. 背景与目标

### 1.1 现状证据

| 文件 | 行 | 引用 |
|---|---|---|
| `test/output-parser.test.ts` | 523 | `../../../.scratch/probe/samples/atomcode-run.stdout` |
| `test/output-parser.test.ts` | 527 | `../../../.scratch/probe/samples/atomcode-run.stderr` |
| `test/output-parser.test.ts` | 1794 | `../../../.scratch/probe/samples/${name}` |
| `test/output-parser.test.ts` | 1881 | `../../../../.scratch/probe/samples/pi-run.jsonl` |
| `test/token-usage.test.ts` | 366 | `../../../../.scratch/probe/samples/pi-run.jsonl` |

`.gitignore:12` 忽略 `.scratch/`。CI 报
`ENOENT: … .scratch/probe/samples/pi-run.jsonl`。
`token-usage.test.ts:361` 的注释已自认「gitignored local fixture」——
**问题是已知的,但一直没有处置。**

### 1.2 危害

这些不是边角用例。它们是**执行器输出解析与 token 记账的硬验收**
(spec `live-output-only-agent-narration` 等以真实样本为准的用例) ——
也就是说**最有价值的那批回归证据,在协作环境里不可复现**。

叠加检视者实测的「本机样本也没了」:这批用例现在是**永久红**,
既不产生证据,也污染基线。

### 1.3 目标

让这批用例在**任何全新 clone** 上都能产生确定结果 ——
要么真跑(样本入库),要么明确跳过(并说明跳了几条)。
**不接受「在某台机器上碰巧能过」。**

## 2. 改动范围

| 范围 | 内容 |
|---|---|
| 改 | `test/output-parser.test.ts`、`test/token-usage.test.ts`;新增 `packages/backend/server/test/fixtures/` 下的样本文件 |
| 不改 | 生产代码(`packages/backend/server/src/**`);`.gitignore` 对 `.scratch/` 的忽略;任何断言的**意图** |

## 3. 详细改动

### R1. 首选:样本脱敏后入库

放到 `packages/backend/server/test/fixtures/`,测试改为读该路径。

**必须脱敏的至少包括**:

- 真实文件系统路径(`C:\Users\<用户名>\…`、`/Users/…`);
- 主机名、局域网 IP;
- 参数/环境里可能出现的 token、API key、密钥;
- 采样当时的仓库内容片段(可能含未发布代码)。

⚠️ **脱敏不得改变被断言的结构**。解析器测的是格式,不是内容 ——
把路径换成 `<REDACTED_PATH>` 这类占位是可以的,把 JSONL 的字段删掉不行。
若某处脱敏会破坏断言,**停下来说明**,不要偷偷调断言。

### R2. 次选:样本确实不宜入库时

改用 `it.skipIf(!existsSync(...))`,并在**测试名里注明「需本地样本」**,
使 CI 上是**明确跳过**而不是失败。

⚠️ 这是次选,因为**跳过的用例不产生证据**。
选它就必须在汇报里逐条说明:哪几条跳了、为什么不能入库、
这些用例原本守护的是什么(丢失了什么证据)。

### R3. 样本已不存在时怎么办

检视者实测 `.scratch/probe/samples/` 已空。所以你很可能**手上根本没有样本**。

按此顺序处理,**不要伪造样本**:

1. 先找:仓库里、`.scratch/` 其它子目录、`logs/` 下的历史执行器日志
   (`logs/pi-*.log`、`logs/atomcode-*.log` 等是真实执行器输出,可能可用);
2. 找到可用的真实输出 → 按 R1 脱敏入库;
3. 找不到 → 按 R2 处理,并在汇报里**明确写「样本不可得」**。

**绝对不要手写一份看起来像的样本冒充真实采样。**
这批用例的全部价值就在于「以真实输出为准」,伪造样本等于把验收变成自证。
若你构造了任何非真实数据,必须在测试名与汇报里显著标注是构造数据。

## 4. 验收标准

**基线先用工具取**:

```
node scripts/test-baseline.mjs packages/backend/server test/output-parser.test.ts test/token-usage.test.ts
```

1. **核心**:改动后这两个文件**不再因 `ENOENT` 失败**。
   贴出改前改后两行基线。
2. **不依赖 `.scratch/`**:改动后 `grep -rn '\.scratch' test/output-parser.test.ts
   test/token-usage.test.ts` 为空(R2 方案下允许保留 `existsSync` 探测,
   但要在汇报里说明)。
3. **脱敏自查**(R1 方案):入库的样本里 `grep -inE 'C:\\\\Users|/Users/|api[_-]?key|token[=:]|sk-'`
   无真实值命中。逐项在汇报里说明你查了什么。
4. **用例数交代清楚**:改后这两个文件的
   通过 / 失败 / **跳过** 各几条,与改前对照。跳过的必须逐条列出。
5. **零生产代码改动**:`git show --stat` 不得出现
   `packages/backend/server/src/**`。**硬约束。**
6. `npx tsc --noEmit -p tsconfig.json` 通过。

## 5. 不涉及的改动

- **不改生产代码**、不改解析器实现。
- **不放宽或删除断言** —— 若某条断言在真实样本缺失下无法成立,按 R2 跳过并说明,
  不得改成弱断言。
- 不改 `.gitignore` 对 `.scratch/` 的忽略(那是对的,采样目录本就不该入库)。
- 不处理 CI 配置本身(V1 另票)。

## 6. 兼容性

- 纯测试改动,无生产行为变更,无 schema 变更。
- 若采用 R1,仓库体积增加 —— 在汇报里给出新增样本的总字节数。
