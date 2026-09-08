# Spec: 快照树为空时 `git restore` 报错,回滚被判失败,重试被误终止

> **状态**: Landed(`c05dbe35`,2026-09-08 检视者 L3 通过)
> **版本**: 1.0
> **日期**: 2026-09-08
>
> **L3 收口记录(检视者独立复核)**:
> - 基线自行复跑两文件:`1 failed | 32 passed (33)` ——
>   `executor-quota-redispatch` 的「普通崩溃」转绿,新增 2 条用例,
>   唯一残留红是既有的 `验收#3`(Windows 清理阶段 EPERM,与本票无关)。
> - **R1 判据合格**:用 `git ls-tree -r --name-only <sha>` **正面查树是否为空**,
>   不靠 stderr 文案(文案会随 git 版本变);`ls-tree` 自身失败仍返回
>   `{ok:false}`。
> - **R2 没被放宽**:非空树走原 restore 路径。执行者按要求构造了反向用例 ——
>   `hash-object -w` → `mktree` → `commit-tree` → `update-ref`,再删掉 blob 文件,
>   restore 报 `unable to read sha1 file` → 仍 `{ok:false}`。
>   这是本票最关键的一条,**没有被跳过**。
> - **缺陷 B 既有验收不倒退**:`验收#1b` / `#2` / `#3b` / `#4` 全绿。
> - 提交边界:仅票面两文件;用户在途工作未被夹带。
>
> **来源**: [rollback-puts-checkpoint-commit-on-head.md](rollback-puts-checkpoint-commit-on-head.md)
> (Landed `99113e88`)**修复自身引入的回归**,检视者在 R11 第二批的 L3 中
> 顺藤摸到并复现。
>
> ⚠️ **这是检视者第二次因为验收清单只列一个测试文件而漏网** ——
> 缺陷 B 的验收只列了 `test/retry-rollback-guard.test.ts`,
> 而这条回归落在 `test/executor-quota-redispatch.test.ts` 里。
> 教训与 R11 v1.1 同源,已记入该 spec。

## 1. 背景与目标

### 1.1 现状证据(检视者实测复现)

`99113e88` 把 `resetToCheckpoint()` 改成两步:

```ts
git reset --hard C^                              // 1) HEAD+索引+工作树回基线
git restore --source C --worktree -- .           // 2) 只回写工作树
```

**第 2 步在快照树为空时会报错**:

```
error: pathspec '.' did not match any file(s) known to git
```

检视者在 scratch 仓库逐条复现:

| 场景 | 结果 |
|---|---|
| checkpoint 树**为空**(仓库只有空提交) | ❌ `pathspec '.' did not match any file(s)` |
| checkpoint 树**有文件** | ✅ 成功 |

于是 `resetToCheckpoint` 返回 `{ ok: false }` → 调用方按
「回滚失败 → **终止重试**」处理(`queue.ts:3486`)。

### 1.2 实测影响

`test/executor-quota-redispatch.test.ts` 的
「**无额度关键词的普通崩溃不进入冷却(回归:不误判停派)**」:

```
AssertionError: expected [ { n: 1, … } ] to have a length of 2 but got 1
```

期望重试后 `attempts` 长度为 2,实际只有 1 —— **重试根本没发生**。

日志坐实:

```
[executor] 重试前回滚失败(01a080d5-6de7-…): git restore 失败:
  error: pathspec '.' did not match any file(s) known to git
```

**前后对照(检视者实测)**:

| 版本 | 该文件结果 |
|---|---|
| `99113e88~1`(修复前) | **23 passed (23)**,全绿 |
| `99113e88`(修复后) | **1 failed \| 22 passed** |

### 1.3 生产影响评估(检视者判断,写在这里免得实现者误判优先级)

**真实仓库的快照树永远非空**(`createCheckpoint` 做 `read-tree HEAD → add -A`),
所以线上几乎不会踩到。**不要因此回退 `99113e88`** ——
旧实现是那个把用户未提交工作变成提交的版本,它的危害大得多。

但这个逻辑本身是错的:**树为空意味着「无需恢复」,不是「恢复失败」**。
而且它已经在吞掉一条真实的重试回归用例。

### 1.4 目标

**快照树为空时,回滚正常成功(第 1 步已经完成了全部工作),不再误报失败。**

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/backend/server/src/lib/executor-runner.ts` | `resetToCheckpoint()` 的第 2 步 |
| `packages/backend/server/test/retry-rollback-guard.test.ts` | 新增空树用例 |

**不改**:第 1 步 `reset --hard C^`(它是对的);
`createCheckpoint`;checkpoint ref 命名与生命周期;
RB-GUARD 判定(`queue.ts:3481`);「回滚失败 → 终止重试」的既有处置(R4);
`gitExec`;控制指令「回滚」入口。

## 3. 详细改动

### R1. 空树 → 跳过 restore,回滚算成功

判定方式自选(例如先 `git ls-tree -r --name-only C` 看是否为空,
或对 `restore` 的这一种失败做定向识别),但:

⚠️ **不要用「stderr 里含某段文字」当唯一判据** —— git 的错误文案会随版本变。
若你选择识别错误,**必须同时有正面判据**(比如确实查过树是空的)。
在汇报里说明你的判据为什么可靠。

### R2. 真正的 restore 失败仍必须是失败

只放行「树为空所以没东西可恢复」这一种情况。

其它 restore 失败(权限、损坏对象、磁盘满……)**仍然返回 `{ok:false}`**,
调用方仍按「终止重试,保留原始失败原因」处理。

⚠️ **本票最大的风险是把这个判定放宽过头**,变成「restore 失败一律当没事」——
那会让真实的回滚失败被静默吞掉,比现在的问题更严重。

### R3. 不改「回滚失败 → 终止重试」的处置

那条处置是对的(`queue.ts:3486`),本票只是让「空树」不再被误判成失败。

## 4. 验收标准

**基线先用工具取。⚠️ 清单必须同时包含这两个文件**
(这正是上次漏掉的那个):

```
node scripts/test-baseline.mjs packages/backend/server \
  test/retry-rollback-guard.test.ts test/executor-quota-redispatch.test.ts
```

**取数基准(检视者 2026-09-08 19:43 实测)**:
`executor-quota-redispatch.test.ts` 当前 **1 failed | 22 passed**;
`99113e88~1` 时是 **23 passed (23)**。

1. **核心:普通崩溃能重试**。
   `无额度关键词的普通崩溃不进入冷却(回归:不误判停派)` 转绿,
   `attempts` 长度回到 2。给出改前红、改后绿的对照。
2. **空树用例**:构造快照树为空的仓库 → 回滚 → 断言 `ok === true`,
   且 HEAD 仍在 `C^`。**改动前该用例必须是红的。**
3. **真实失败仍是失败**(R2):构造一个**非空树**但 restore 会失败的场景
   (方式自选,例如把目标文件设成不可写),断言仍返回 `{ok:false}`。
   ⚠️ 这条是防止 R2 被放宽过头的关键用例,**不能省**。
   若你判断该场景在本机构造不出来,**说明你试了什么、为什么不行**,
   不要静默跳过。
4. **缺陷 B 的既有验收不倒退**:`retry-rollback-guard.test.ts` 的
   `验收#1b`(HEAD 停在 C^)、`验收#2`(日志无 checkpoint)、
   `验收#3b`、`验收#4` 全部保持绿。
5. 两文件基线前后对照,**失败数下降**(至少 `executor-quota-redispatch` 那条转绿)。
6. `npx tsc --noEmit -p tsconfig.json` 通过。

## 5. 不涉及的改动

- **不回退 `99113e88`**(§1.3)。
- 不改 `createCheckpoint`、ref 命名与清理、RB-GUARD 判定。
- 不改「回滚失败 → 终止重试」的处置(R3)。
- 不扩大删除范围(仍不跑 `git clean`)。

## 6. 兼容性

- 无 schema 变更,无迁移。
- 行为变更:快照树为空时回滚从「失败并终止重试」变成「成功」。
