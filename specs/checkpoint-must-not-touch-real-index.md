# Spec: 执行前快照会暂存别人的在途改动 —— checkpoint 必须用独立 Git index

> **状态**: Frozen
> **版本**: 1.0
> **日期**: 2026-09-07
> **来源**: [docs/implementation-optimization-review-2026-09-07.md](../docs/implementation-optimization-review-2026-09-07.md) R7
> **相关**: [checkpoint-concurrent-same-repo.md](checkpoint-concurrent-same-repo.md)(Landed;
> 按 repoRoot 串行化快照,解决的是 `index.lock` 争用,**不解决**本票的 index 污染)

## 1. 背景与目标

### 1.1 现状证据

[`executor-runner.ts`](../packages/backend/server/src/lib/executor-runner.ts)
的 `createCheckpointUnlocked()`(第 392 行起):

```ts
const add = await gitExec(["add", "-A"], repoRoot);      // ← 动的是真实 index
const tree = await gitExec(["write-tree"], repoRoot);
const commit = await gitExec([... "commit-tree", tree, "-p", "HEAD", ...], repoRoot);
const upd = await gitExec(["update-ref", ref, sha], repoRoot);
```

函数注释写着「不动 HEAD/工作区(**仅暂存 index**)」—— 括号里那句正是缺陷本身:
**它把工作树里所有未忽略的改动都 `git add` 进了用户的真实暂存区,而且从不恢复。**

`gitExec(args, cwd)` 当前**不支持传 env**(第 281 行签名只有 `args` / `cwd`),
所以现在无法把 git 指到另一个 index 文件。

### 1.2 危害

每次派发任务前都会打一次快照。于是:

- 用户手工暂存了一部分改动准备提交(部分暂存是常规工作流)→ 平台快照把**其余
  未暂存的改动、以及未跟踪文件**一并暂存,用户的暂存区被改写;
- 工作树里同时有多张票的在途产物时,快照会把**别人的在途改动**也暂存 ——
  这正是 AGENTS.md「Git 提交边界」那节反复付学费的场景:
  `git add <路径>` 之后直接 `git commit` 会把暂存区里别人的改动一起带走。
  平台自己每次派发都在制造这个前提。
- 「用明确路径提交」是**补偿措施**,不是隔离:它靠每个提交方自律,而污染是平台造成的。

本机实测佐证:2026-09-07 多次派发后 `git status --porcelain` 出现
`A  start.ps1` —— 一个从未被任何人 `git add` 过的未跟踪文件,被平台快照暂存了。

### 1.3 目标

**快照对用户的真实暂存区必须是只读的。** 快照内容不变(仍是工作树的完整树),
隐藏 ref 与回滚能力不变;改的只是「用哪个 index 去构造这棵树」。

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/backend/server/src/lib/executor-runner.ts` | `gitExec` 支持可选 env;`createCheckpointUnlocked` 改用独立 index |
| `packages/backend/server/test/checkpoint-index-isolation.test.ts`(新增) | 定向验收 |

**不改**:`withRepoCheckpointLock` 的按仓库串行(那是另一票已落地的并发修复);
`checkpointRef()` 的 ref 命名;`commit-tree -p HEAD` 与兜底作者身份;
`resetToCheckpoint` 的回滚语义(`reset --hard`,不跑 `git clean`,未跟踪文件残留);
调用方(队列)对失败的处置。

## 3. 详细改动

### R1. `gitExec` 支持可选环境变量

给 `gitExec(args, cwd)` 增加可选的第三个参数用于附加环境变量,
与 `process.env` 合并后传给 spawn。**不改**既有两参调用的行为。

> ⚠️ 这是本票唯一允许扩大的公共面。不要顺手给 `gitExec` 加超时/重试/日志等
> 其它能力 —— 那些不在本票范围。

### R2. 用独立 index 构造快照

`createCheckpointUnlocked` 改为在**临时 index 文件**上工作,推荐配方:

```
GIT_INDEX_FILE=<临时文件>  git read-tree HEAD     # 先按 HEAD 铺底
GIT_INDEX_FILE=<临时文件>  git add -A             # 再把工作树叠上去
GIT_INDEX_FILE=<临时文件>  git write-tree
git commit-tree <tree> -p HEAD -m "coagenthub checkpoint <taskId>"
git update-ref <ref> <sha>
```

要求:

- 临时 index 路径必须**每次快照唯一**(含 taskId 或随机串),不能多个快照共用一个;
- 放在系统临时目录,**不要**放进 `.git/` 或仓库工作树(会被下一次 `add -A` 看见);
- 无论成功失败都要清理临时 index 文件;清理失败只记日志,不影响快照结果;
- `commit-tree` / `update-ref` 不需要 index,保持现状。

若实现者认为 `read-tree HEAD` 那一步可省(空 index 直接 `add -A`),
必须在汇报中给出「两种做法产出的 tree sha 相同」的实测证据,否则按上面的配方做。

### R3. 快照内容逐字不变

修改前后,对同一工作树状态打的快照,`write-tree` 产出的 **tree sha 必须相同**。
这是本票「只改构造方式、不改语义」的判据,必须实测,不能只靠推理。

### R4. 失败路径不留残留

任一步失败(仍然抛错、调用方仍然中止任务)时,不得留下临时 index 文件,
也不得留下半成品的隐藏 ref。错误信息保持可读,包含失败的 git 子命令。

## 4. 验收标准

**必须读真实 git 状态**,不接受只断言函数返回值。

1. **真实 index 全程不变(本票的核心)**
   构造一个含四类文件的临时仓库:①已暂存的改动 ②未暂存的改动
   ③同一文件的部分暂存(一部分 hunk 已 add) ④未跟踪文件。
   打快照前后对比:
   ```
   git status --porcelain
   git diff --cached --stat
   git ls-files --stage
   ```
   三者**逐字相同**。(修改前跑同一用例必须失败 —— 汇报中给出「改前红、改后绿」
   的对照,证明用例真的能暴露旧行为。)

2. **快照内容不变**:同一工作树状态下,新旧实现产出的 tree sha 相同(实测两次 sha 并比对)。

3. **快照仍包含约定内容**:未跟踪文件与未暂存改动都在快照树里
   (用 `git ls-tree -r <ref>` 断言具体文件在);被 `.gitignore` 忽略的文件不在。

4. **并发快照不污染**:同一仓库两个任务并发打快照(既有串行锁仍在)→ 两个 ref 都成立、
   真实 index 仍不变、无 `index.lock` 报错。

5. **失败路径**:构造 `write-tree` 失败(例如临时 index 指向不可写路径)→ 抛错、
   真实 index 不变、无临时文件残留、无半成品 ref。

6. **回滚不回退**:`resetToCheckpoint` 的既有行为不变 —— `test/retry-rollback-guard.test.ts` 保持绿。

7. **只跑改动触及的测试文件**(不跑全量):
   ```
   cd packages/backend/server && npx vitest run test/checkpoint-index-isolation.test.ts test/retry-rollback-guard.test.ts test/executor-task-repo.test.ts test/executor-queue.test.ts test/task.test.ts
   ```
   贴改动前后同口径的通过/失败计数(本机 Windows 是红基线,口径 = **失败数不增加**)。

8. **类型检查**通过。

## 5. 不涉及的改动

- **不改回滚语义**:`reset --hard` 仍只恢复已跟踪文件,未跟踪文件仍残留,
  仍**不跑 `git clean`**(报告 R7 明确要求「不扩大删除范围」)。
- **不改并发锁**:按 repoRoot 串行已由另一票落地。
- **不给 `gitExec` 加 env 之外的任何能力。**
- **不改 checkpoint 的触发时机与调用方**。

## 6. 兼容性

- 无 schema 变更,无迁移,无 API 变更。
- 隐藏 ref 的命名与内容不变 → 已有的 checkpoint ref 仍可回滚。
- 行为变更(需在汇报中写明):打快照后用户的暂存区不再被改写。
  依赖「派发会顺手把我的改动 add 上」的用法(若有)属于依赖缺陷,不予兼容。
