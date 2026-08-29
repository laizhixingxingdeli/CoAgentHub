# Spec: 续跑任务派完即退被误杀,收敛写回又抹掉证据

> **状态**: Frozen — 待实现
> **版本**: 1.0
> **日期**: 2026-08-29

## 现象一:续跑任务派出子任务后被孤儿收敛判死,链路断了

实测(2026-08-29):

```
01a04b22  原协调任务   done
01a04b35  续跑任务     failed  ← executor pid 59690 no longer exists
  ├─ 01a04b36  running   ← 仍在干活
  └─ 01a04b39  queued    ← 仍排着队
```

续跑任务 `01a04b35`(brief 首行 `# CoAgentHub 续跑任务(协调者被重新拉起)`)
派出两个子任务后按「派完即退」退出,pid 消失,被孤儿收敛判为 `failed`。

⚠️ **后果是链路彻底断掉**:这两个子任务干完后触发续跑逻辑,
`coordinator-resume.ts:97` 会拦下 ——

```ts
if (isTerminalTaskStatus(parent.status)) return "skipped";
```

父任务已是 `failed`(终态)→ `skipped`。**没有人会回来结案**,子任务的成果悬空。

## 根因:R3「续跑任务自身不豁免」定得过宽

`orphan-reconciler-kills-pending-resume` R3 规定续跑任务不在豁免范围内,
本意是防止「反复被续跑的任务永远不被收敛」。但它没有区分两种情形:

```
A  续跑任务自己空转/挂死,名下无非终态子任务   → 该收敛  ✓ 现行行为正确
B  续跑任务派出了新子任务、派完即退           → 不该收敛 ✗ 现被误杀
```

B 正是「派完就退」的**正确形态**,与 `3811b798` 为协调根任务修复的竞态
是同一个问题 —— 当时只豁免了非续跑的协调根任务,续跑任务被 R3 明文排除。

## 现象二:收敛写回整体替换 diffSummary,抹掉一切证据

`orphan-task-reconciler.ts`:

```ts
.set({
  status: "failed",
  diffSummary: { error: reason, reconciledReason: reason, reconciledAt: ... },
})
```

**整体替换,不是合并。** 被抹掉的包括:

```
platform.resumeOf   → 事后无法判断它是不是续跑任务
tokenUsage          → 与 token-fields-clobbered-by-close 同一种病
执行器已写的任何字段
```

⚠️ 这直接妨碍排障:检视者定位现象一时,因 `resumeOf` 被抹而先后错怪了
「豁免漏了 queued」「isCoordinatorTask 判错」「executorParticipantId 为空」,
逐项排除后才发现是证据没了。

## 要做的

### R1 — 续跑任务的豁免条件与协调根任务一致

续跑任务(`diffSummary.platform.resumeOf` 非空)同样适用豁免:
**名下存在非终态子任务、或存在待建续跑事件时,不收敛**。

⚠️ 保住 R3 的本意:仅当它**自己也无事可做**(无非终态子任务且无待建续跑)
时才收敛,避免「永远不被收敛」。

⚠️ 复用现有 `hasNonTerminalChildTask` / `hasPendingResumeEvent`,
**不新写判定**;实质是把 `!isResumeTask(task) &&` 这个前置条件去掉。

### R2 — 收敛写回改为合并,不得整体替换

保留 `diffSummary` 中已有的全部字段(`platform.*`、`tokenUsage`、
`tokenUsageReason`、执行器已写内容),**仅新增**
`error` / `reconciledReason` / `reconciledAt`。

⚠️ 若已存在同名键,以本次收敛值覆盖该三键,其余键不动。

### R3 — ⚠️ 不得放宽 coordinator-resume 的终态检查

不要通过删除 `coordinator-resume.ts:97` 的终态判断来绕过现象一 ——
那会让已被正确判死的任务被重新拉起。本票的修法是**让它不被误判死**。

### R4 — ⚠️ 不改其它收敛判据

`process.kill(pid,0)` 抛 ESRCH 才判死、条件更新(仅当仍为 running 才写回)、
10 秒周期、显式测试开关,一律不动(回归,必测)。

## 验收要点

- 续跑任务派出子任务后 pid 消失 → **不被收敛**;子任务终态后产生新续跑,
  父任务最终 `done`(核心场景,必测,贴出任务链)
- 续跑任务无非终态子任务且无待建续跑 + pid 消失 → **仍被正常收敛**
  (R1 的边界,必测 —— 防止「永远不被收敛」)
- 收敛写回后,`diffSummary` 中原有的 `platform.resumeOf` 与 `tokenUsage`
  **仍然存在**(R2,必测,贴出收敛前后对照)
- 收敛写回新增了 `error` / `reconciledReason` / `reconciledAt`(R2)
- 非续跑协调根任务的豁免行为**不变**(回归,必测)
- ESRCH 判据、条件更新、周期、测试开关均未改动(R4,回归必测)
- 测试全绿,贴出用例数

## 注意

⚠️ 本票**必须下发给执行器**完成,**不限定是哪一个**;
   若执行器全部冷却,允许协调者降级两层兼任。
⚠️ ⚠️ **当前有一条断链需要人工接管**:`01a04b35` 已 failed,
   其子任务 `01a04b36` / `01a04b39` 干完后无人结案。
   **不要试图修复这条历史数据**,检视者会另行处理;本票只修机制。
⚠️ specHash 不是 commit,汇报时不要混用。
⚠️ 提交前 `git status --porcelain` 并**看第一列**;只提交本票产物。
⚠️ 做完记得提交。
