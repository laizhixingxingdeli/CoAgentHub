# Spec: 重试回滚不得摧毁检查点之后的提交

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-09-01

## 1. 背景:一次数据丢失事故

检视者与执行器共享同一棵 git 工作树(R9 的已知前提)。执行器任务失败重试时,
平台自动回滚工作区到该任务的 checkpoint:

```ts
// queue.ts:2783(handleFailure 重试分支)
if (getRetryPolicy().resetWorkspace && run.checkpointRef) {
  const res = await resetToCheckpoint(run.checkpointRef, repoRoot);
```

`resetToCheckpoint`(executor-runner.ts:320)执行 `git reset --hard <ref>`,
**不检查 HEAD 是否仍等于 checkpoint**。

**2026-08-31 两次兑现数据丢失**(reflog 铁证):

| 时刻 | 事件 |
|---|---|
| 12:57 | 检视者提交多协调者 spec v1.1(80737a46) |
| 14:33 | DK修正票(01a05617)失败重试 → reset 到其 checkpoint → **v1.1 被抹** |
| 18:11 | 检视者提交 v1.2(b80428da,基于被回退的 v1.0 重写,内部已不一致) |
| 19:04 | L3-Lite(01a0570f)失败重试 → reset 到其 checkpoint → **v1.2 被抹** |

次生灾害:v1.2 的内部不一致(验收 3 残留 v1.0 旧文)导致 MC 票被协调者
正确拒发,链路阻塞半日。检视者的 spec 冻结是平台的验收锚点来源,
**它的无声销毁直接威胁 Spec-Driven 工作流的根基**。

### 根因(ADR-0009 形状)

回滚把「HEAD 可以安全硬 reset 到 checkpoint」当作事实,实际读的近似量是
「任务创建时打过这个 checkpoint」。沉默的前提:**任务运行期间没有其他人
提交**——共享工作树下永不成立。

## 2. 改动范围

- `executor-runner.ts` 的 `resetToCheckpoint`(或其调用方 queue.ts:2783)
  增加外来提交防护。
- 不改 `control.ts` 的手动「回滚」指令(它有人在场判断 + 本群运行检查,
  且语义就是显式回滚;见 §5)。

## 3. 详细改动

### R1 自动重试回滚的前置检查

`resetToCheckpoint` 在执行 reset 前:

1. `git rev-parse HEAD` 取当前 HEAD;
2. 与 checkpoint ref 指向的提交比较(先 `git rev-parse <ref>` 解析);
3. **HEAD ≠ checkpoint**(工作树在任务启动后接受过外来提交——包括检视者
   冻结、其他任务产物、用户手工提交)→ **拒绝硬 reset**。

### R2 拒绝时的行为:降级为「不回滚直接重试」,不终止重试

现有失败语义是「回滚失败 → 终止重试,按最终失败处理」(queue.ts:2788-2801)。
R1 的拒绝**不得**走这条路径——外来提交不是故障,终止重试会把一次可自愈的
执行失败变成需要人工介入的最终失败。

正确行为:
- 跳过回滚,照常重试(重试任务书本身带两段式失败判定,执行器会在
  当前工作树状态上继续);
- diffSummary 留痕 `rollbackSkipped: { reason: "checkpoint 之后存在外来
  提交,跳过回滚保护共享工作树", headAtSkip: <sha>, checkpoint: <ref> }`;
- 群内回传消息中附一句可读说明(与既有 ⏳/↻ 提示同风格)。

### R3 防护范围:只保护「外来」提交

HEAD == checkpoint 时行为与现状逐字一致(干净重试,硬 reset 无损害)。
判断只看提交图(HEAD 可达性),**不试图归因**谁提交的——归因需要
可归因判据,那是另一张票(R9)的范围;本票宁可保守:任务启动后的
**任何**提交都算外来。

## 4. 验收标准

1. **事故复现用例(必测,本票直接理由)**:checkpoint 打下后,第三方
   (测试里模拟检视者)提交一个新 commit → 任务失败触发自动重试 →
   **该 commit 存活**(HEAD 不被 reset),重试照常进行,diffSummary 含
   rollbackSkipped 留痕,群内回传含说明。
2. HEAD == checkpoint(无外来提交)→ 硬 reset 照常执行,行为与现状
   逐字一致(干净重试回归,必测)。
3. 快照不存在(ref 无效)→ 现状语义不变(终止重试,保留原失败原因,
   回归确认)。
4. 留痕字段名与形状照抄本 spec(rollbackSkipped/headAtSkip/checkpoint),
   静默跳过被禁止。
5. 手动「回滚 <taskId>」指令(control.ts)行为逐字不变(回归,必测)。

## 5. 不涉及的改动

- 不改 `resetToCheckpoint` 的手动回滚路径(control.ts 调用,人在场)。
- 不改 retry policy 结构(`resetWorkspace` 开关语义不变,本票约束的是
  开关为 true 时的执行方式)。
- 不做提交归因(哪条提交属于哪个任务——R9 域)。
- 不引入 git worktree / 独立 clone(更大的架构变更,另行评估)。
- 不改 checkpoint 的创建时机与 ref 命名。

## 6. 兼容性

- 部署初期行为几乎无感知:多数重试时 HEAD==checkpoint(串行队列下,
  任务失败到重试之间无人提交),防护只在共享树真正被并发写入时生效。
- 与 MC 票(多协调者 v1.3)兼容:两票都动 queue.ts 不同分支
  (MC 动泵判定/占用;本票动 handleFailure 重试段),文件重叠但函数
  不重叠,串行下发即可。
