# Spec: 仓库没有 `.gitattributes`,Windows 上换行被改写,fixture 断言与格式检查双双失真

> **状态**: Frozen
> **版本**: 1.0
> **日期**: 2026-09-08
> **来源**: [tests-depend-on-gitignored-samples.md](tests-depend-on-gitignored-samples.md)
> 修好 fixture 加载后**新暴露**(不是新造)的一条红;
> 检视者顺查发现根因比那一条更广。

## 1. 背景与目标

### 1.1 证据(检视者实测)

```
$ file packages/backend/server/test/fixtures/atomcode-task-01a04f70-outputTail.txt
… UTF-8 text, with very long lines (367), with CRLF line terminators

$ ls -l .gitattributes
不存在
```

**仓库根本没有 `.gitattributes`。** 于是 Windows 上
`core.autocrlf` 的默认行为把 checkout 出来的文本文件换行改成 CRLF。

### 1.2 两个后果

**① fixture 断言失真。**

`test/output-parser.test.ts` 有断言要求样本正文里**没有 `\r`**。
样本入库时是 LF,checkout 到 Windows 变成 CRLF → 断言红。

⚠️ 注意这条**在 CI(ubuntu)上是绿的** —— 它只在 Windows 显形。
这正是「本地红 ≠ CI 红」的一个具体实例。

**② Biome 格式检查噪音。**

本轮多个执行器在汇报里都提到同一件事:

> 「biome check 报的 CRLF/format 错误在**未改动的**文件上同样存在,属既有基线」

也就是说,**格式检查对每个人都在持续报假警**,
所有人都学会了无视它 —— 那么它真的报出问题时也不会有人看。

### 1.3 目标

**让换行在所有平台一致,fixture 断言与格式检查都恢复可信。**

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `.gitattributes`(新增) | 声明换行规则 |
| 受影响的已入库文件 | 按新规则重新规范化(`git add --renormalize`) |

**不改**:生产代码;测试断言;`.gitignore`;
Biome 配置(除非你判断它与新规则冲突 —— 那时**说明再改**)。

## 3. 详细改动

### R1. 新增 `.gitattributes`

至少要覆盖:

- **默认**:文本文件在仓库里存 LF(`* text=auto eol=lf` 或等价写法);
- **测试 fixture**:`packages/backend/server/test/fixtures/**`
  —— ⚠️ 这类文件是**被逐字断言的语料**,
  最稳妥是标成**不做任何转换**(`-text` / `binary`),
  这样它在任何平台 checkout 出来都逐字等于入库时的样子;
- **明确的二进制**(图片等):`binary`。

在汇报里说明你的每一条规则**为什么这么写**。

### R2. 重新规范化已入库文件

加了 `.gitattributes` 之后,已入库文件的**索引内容**不会自动变。
需要 `git add --renormalize .` 之类的操作让它们符合新规则。

⚠️ **这会产生一个改动量很大的提交**(可能上千文件)。
**单独一个提交**,commit message 写清楚它是纯换行规范化,
不要和别的改动混在一起 —— 否则以后 `git blame` / review 全被淹没。

⚠️ **规范化前先确认工作树是干净的**:
用户有**未提交的** `docs/implementation-optimization-review-2026-09-07.md`
和**未跟踪的** `start.ps1`。
**这两个绝对不能被卷进规范化提交。**
`git commit -- <明确路径>` 或先确认它们不在待提交集合里。

### R3. 验证换行真的一致了

不要只看 `.gitattributes` 写对了。**实际检查文件**:

```
file packages/backend/server/test/fixtures/*.txt
```

应当不再报 `CRLF line terminators`(或按你选的规则,是预期的那种)。

## 4. 验收标准

**基线先用工具取**:

```
node scripts/test-baseline.mjs packages/backend/server test/output-parser.test.ts
```

**取数基准(检视者 2026-09-08 20:21 实测)**:
`output-parser` + `token-usage` 合计 `1 failed | 125 passed (132)`,
那 1 条红就是本票要治的 CRLF 断言。

1. **核心**:`atomcode:任务 01a04f70-9101 … 验收 3` 转绿。
   给出改前红的实际报错、改后绿的对照。
2. **fixture 换行实测一致**(R3):贴出 `file` 的输出。
3. **规范化是单独提交**(R2):`git log` 里能看到它自成一个提交。
4. **用户在途工作未被卷入**:规范化提交里
   **不含** `docs/implementation-optimization-review-2026-09-07.md`
   与 `start.ps1`。⚠️ **硬约束,逐项自查后在汇报里自证。**
5. **Biome 噪音下降**:给出改前改后
   `npx biome check` 的错误数对照(不要求归零,要求**明显下降**;
   若没下降,说明原因)。
6. **零生产代码逻辑改动**:换行规范化会碰到 `src/**` 的文件,
   但 `git show -w --stat`(忽略空白)应当显示**无实质改动**。
   在汇报里给出这个证据。
7. `npx tsc --noEmit -p tsconfig.json` 通过。

## 5. 不涉及的改动

- 不改任何测试断言、不改生产代码逻辑。
- 不改 `.gitignore`。
- 不修 V1 的 CI 问题、不修那 6 条 skip(各自另票)。

## 6. 兼容性

- ⚠️ **规范化提交会让所有人的本地工作树出现大量「改动」** ——
  在汇报里写明升级后需要做什么(通常是重新 checkout 或
  `git add --renormalize` 一次)。
- 无生产行为变更。
