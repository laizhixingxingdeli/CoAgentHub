# Spec: 重试回滚把 checkpoint 提交推上 HEAD,吞掉用户在途工作

> **状态**: Landed(`99113e88`,2026-09-08 检视者 L3 通过)
> **版本**: 1.0
> **日期**: 2026-09-08
>
> **L3 收口记录(检视者独立复核,非采信汇报)**:
> - 「改前红」自行复现:临时换回旧实现后 `3 failed | 5 passed`,其中
>   **验收#2 报 `expected '47c3097 fake bin change\nef56d07 coag…' not to contain
>   'coagenthub checkpoint'`** —— 数据吞噬在测试里逐字复现;
>   验收#1b 报 `expected '4af84ed…' to be '77099fb…'`(HEAD 落在 C 而非 C^)。
> - 「改后绿」自行复跑:`1 failed | 7 passed (8)`,与汇报逐字一致,失败数未增加。
>   唯一残留红是**改前即存在**的验收#3(`spawn sh.exe ENOENT` → `checkpointRef`
>   为 null),属 ② Windows 环境性,与本票无关。
> - 提交边界:`git show --stat` 仅票面两个文件;`queue.ts` / `control.ts` 未动
>   (R4/§4.5 满足);用户未提交的报告与未跟踪 `start.ps1` **未被夹带**。
>
> ⚠️ **未生效提示**:修复已入库,但**运行中的服务器仍是旧构建** ——
> 需 `cd packages/backend/server && npx tsx esbuild.config.ts` 后
> `scripts/coagenthub-prod.sh restart` 才真正生效。在那之前回滚仍会吞工作。
> **来源**: 2026-09-08 检视者监督平台运行时实测捕获,**当天连续发生两次**。
> **相关**: [checkpoint-must-not-touch-real-index.md](checkpoint-must-not-touch-real-index.md)
> (Landed,`d1626fb3`)修的是 checkpoint 污染**暂存区**;本票是它污染**提交历史**的另一半。

## 1. 背景与目标

### 1.1 现状证据(实测,两次)

`packages/backend/server/src/lib/executor-runner.ts` 的 `resetToCheckpoint()`:

```ts
const reset = await gitExec(["reset", "--hard", ref], repoRoot);
```

`ref` 是 `refs/coagenthub-cp/<taskId>`,指向一个**合成的 checkpoint 提交**
(由 `commit-tree <tree> -p HEAD` 生成)。`git reset --hard <该提交>` 会把
**HEAD 移到这个合成提交上**。

调用点在重试路径 `queue.ts:3484`。

**2026-09-08 实测两次**,同一个失败任务 `01a0804b-5f7b` 的重试各触发一次:

```
582c4e28 coagenthub checkpoint 01a0804b-5f7b-763a-b280-66c4ccffb693   ← 第一次
40b1a576 coagenthub checkpoint 01a0804b-5f7b-763a-b280-66c4ccffb693   ← 第二次
```

其内容:

```
docs/implementation-optimization-review-2026-09-07.md | 567 +++++   ← 用户未提交的编辑
start.ps1                                            |  29 ++++    ← 用户未跟踪的本机脚本
```

两次都由检视者手工 `git reset --mixed <批次提交>` 还原。

### 1.2 危害

**checkpoint 快照的是整棵工作树**,必然包含与该任务无关的在途工作:
用户正在编辑但未提交的文件、有意保持未跟踪的本机脚本、其它票的半成品。

回滚把这棵树变成**分支上的一个提交**,于是:

- 用户「未提交」的意图被推翻 —— 东西进了历史,提交信息还是机器生成的;
- 「未跟踪」的文件被跟踪 —— 用户可能故意不想入库(本机路径、密钥旁的脚本等);
- 提交历史里混入 `coagenthub checkpoint <uuid>` 这种噪音提交;
- **发生得完全静默** —— 用户不会收到任何提示,直到自己 `git log` 才发现。

⚠️ 这与 AGENTS.md 反复强调的「提交边界」纪律直接冲突:仓库要求人用
`git commit -- <明确路径>` 防止带走别人的改动,而平台自己在回滚时把**所有人的**
在途改动一次性提交掉。

### 1.3 目标

**回滚只恢复工作树,不改写提交历史,不把任何东西变成提交。**

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/backend/server/src/lib/executor-runner.ts` | `resetToCheckpoint()` 的实现 |
| `packages/backend/server/test/retry-rollback-guard.test.ts` | 断言同步 + 新增 HEAD 不变的用例 |

**不改**:`createCheckpoint`(R7 已修,快照构造正确);checkpoint ref 的命名与生命周期;
重试策略与 RB-GUARD「检测到外来提交则跳过回滚」的既有判定(`queue.ts:3481`);
控制指令「回滚 <taskId>」的入口与权限;`gitExec`。

## 3. 详细改动

### R1. 回滚后 HEAD 必须回到快照时刻的真实提交

checkpoint 提交 `C` 由 `commit-tree <tree> -p HEAD` 生成,因此
**`C^` 就是打快照那一刻的真实 HEAD**。

回滚的正确语义是两件事:

1. **HEAD 与索引回到 `C^`** —— 撤销执行器在本次尝试中产生的提交;
2. **工作树内容恢复成 `C` 的树** —— 快照时的未提交改动重新以**未提交**的形式出现。

**不得**让 HEAD 停在 `C` 上。具体实现自选(例如先 `reset --hard C^`
再从 `C` 恢复工作树内容),但必须满足 R2 的可验证结果。

### R2. 可验证结果(实现无论怎么写都要满足)

回滚完成后:

- `git rev-parse HEAD` **等于** `C^`(快照时刻的提交),**不等于** `C`;
- `git log` 中**不出现** `coagenthub checkpoint` 字样的提交;
- 快照时**未提交**的改动仍然是未提交的(`git status --porcelain` 能看到它们);
- 快照时**未跟踪**的文件仍然是未跟踪的(`??`,不是 `A `);
- 快照时**已跟踪且已修改**的文件内容恢复到快照时的内容。

### R3. 删除与新增文件的处置要明确

- 任务执行中**新建**的文件:回滚后应消失还是保留?
  **保持与现状一致**(现状 `reset --hard` 不删未跟踪文件,`resetToCheckpoint`
  的注释也写明「不跑 `git clean`,避免误删用户工作区里与任务无关的未跟踪文件」)。
  **本票不扩大删除范围。**
- 任务执行中**删除**的已跟踪文件:回滚后必须恢复。

在汇报中写明这两类的实际行为,并各给一条用例。

### R4. 失败处置不变

回滚失败时仍然返回 `{ ok: false, message }`,调用方仍按
「回滚失败 → 终止重试,保留原始失败原因」处理(`queue.ts:3486`)。

## 4. 验收标准

**基线(先用工具取,不要手抄)**:

```
node scripts/test-baseline.mjs packages/backend/server test/retry-rollback-guard.test.ts
```

⚠️ 该文件已迁移到跨平台假执行器助手,但仍可能有残留红;**以你取到的数字为准**,
口径是**失败数不增加**。

1. **HEAD 不再落在 checkpoint 提交上(核心)**
   构造:工作树含 ①已跟踪已修改文件 ②未跟踪文件 → 打快照 → 让执行器产生一个提交
   → 触发回滚。
   断言:
   - `git rev-parse HEAD` 等于快照时刻的提交(即 `C^`),**不等于** checkpoint 提交;
   - `git log --oneline` 里**没有** `coagenthub checkpoint`;
   - 那个已修改文件仍是 `M`(未提交),内容等于快照时的内容;
   - 那个未跟踪文件仍是 `??`。
   ⚠️ **这条用例在改动前必须是红的** —— 给出「改前红、改后绿」的对照。
2. **执行器提交被撤销**:回滚后 `git log` 里不含执行器在本次尝试中产生的提交。
3. **删除的已跟踪文件被恢复**(R3)。
4. **新建文件的处置与现状一致**(R3),用例断言实际行为并在汇报中写明。
5. **RB-GUARD 不受影响**:`queue.ts:3481` 的「检测到外来提交则跳过回滚」逻辑
   未被改动,相关既有用例保持原状态。
6. 定向测试前后对照,失败数不增加。
7. `npx tsc --noEmit -p tsconfig.json` 通过。

## 5. 不涉及的改动

- **不改 `createCheckpoint`**、不改 checkpoint ref 命名与清理。
- **不改重试策略**与 RB-GUARD 判定。
- **不扩大删除范围**(仍不跑 `git clean`)。
- 不改控制指令「回滚」的入口与权限。
- 不清理已经产生的历史 checkpoint 提交(本机的两次已由检视者手工还原)。

## 6. 兼容性

- 无 schema 变更,无迁移。
- 行为变更(需写明):回滚后 HEAD 不再指向 checkpoint 提交;
  依赖「回滚会产生一个提交」的观察方(若有)属于依赖缺陷,不予兼容。
- 已存在的 `refs/coagenthub-cp/*` 隐藏 ref 不受影响(本机现有 22 个)。
