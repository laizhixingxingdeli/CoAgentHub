# Spec: 测试依赖 gitignored 的执行器采样,任何 checkout 都跑不过

> **状态**: Frozen
> **版本**: 1.0
> **日期**: 2026-09-08
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
