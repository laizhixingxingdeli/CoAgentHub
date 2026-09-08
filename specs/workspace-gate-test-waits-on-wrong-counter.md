# Spec: workspace-gate 用例等错了计数器,断言必然抢跑

> **状态**: Frozen
> **版本**: 1.0
> **日期**: 2026-09-08
> **来源**: [migrate-remaining-fake-executors.md](migrate-remaining-fake-executors.md)
> B5 执行者按 §3 R4 交出的 **③ 真实缺陷**;检视者 L3 独立复核后**收窄了结论**
> (见 §1.3)。
> **性质**: **纯测试缺陷,生产闸无恙** —— 不要顺手去"修"生产代码。

## 1. 背景与目标

### 1.1 现象

`packages/backend/server/test/executor-coordinator-workspace-gate.test.ts:348`
「验收 1」稳定红:`expected +0 to be 1`。**3/3 复现,同一断言同一行,不是抖动。**

执行者探针实测(插桩已还原):断言时刻 `coordinatorOccupancyCount=0` /
`runningWorkspaceCount=1`,再等 100ms 后 `coordinatorOccupancyCount` 才变 1。

### 1.2 根因:等待条件守不住被断言的对象

用例先轮询 `runningWorkspaceCount` 等到 1,再断言 `coordinatorOccupancyCount`。
但这两个量**在不同时刻变 1**:

| 量 | 何时变 1 | 出处 |
|---|---|---|
| 队列槽位(汇入 `runningWorkspaceCount`) | 写 `status=running` 时 | `queue.ts:1931` |
| `coordinatorOccupancyCount` | **spawn 之后**才登记 | `queue.ts:2229` `registerCoordinatorProcess` |

两点之间隔着 `postStatus` / `beginAttempt` / `buildTicket` /
**`createCheckpoint`(一个 git 子进程)** / `registerTaskOwnerServer`,
约 300 行代码。这个窗口**远大于**用例 50ms 的轮询间隔,所以
`runningWorkspaceCount` 一到 1 就断言,`coordinatorOccupancyCount` 必然还是 0。

**与 win32 无关,任何平台都会踩** —— 只是快机器上偶尔侥幸。

### 1.3 ⚠️ 生产闸没有问题(检视者 L3 复核收窄)

`state.ts:500`:

```ts
export function runningWorkspaceCount(projectPath: string | null): number {
  let n = coordinatorOccupancyCount(projectPath);   // detached 协调进程
  for (const g of groupQueues.values())
    for (const r of g.running) if (r.projectPath === projectPath) n += 1;  // 队列槽位
  return n;
}
```

两项**相加、不重叠**:窗口期内该任务占着队列槽位,被第二项数到,**正好一次**;
spawn 后登记进第一项时,队列槽位对 detached 任务已释放。
所以 `runningWorkspaceCount` 在整个窗口里**始终正确**,
`maxConcurrentPerWorkspace` 闸和 ADR-0009 的认领超时豁免都不受影响。

**错的只是用例的等待条件。不得以本票为由改动 `queue.ts` / `state.ts`。**

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/backend/server/test/executor-coordinator-workspace-gate.test.ts` | 「验收 1」的等待条件 |

**不改**:`queue.ts`、`state.ts`、任何生产代码(§1.3);
该文件其它用例;断言本身的**意图**(仍然要断言协调进程占用登记成功)。

## 3. 详细改动

### R1. 等待条件必须就是被断言的量

把「先等 `runningWorkspaceCount` 到 1」改成**直接轮询
`coordinatorOccupancyCount` 本身**到期望值,再做断言。

判据:**用例等待的量与它断言的量必须是同一个**。这是本票唯一的设计约束;
具体写法(轮询助手、`vi.waitFor`、既有 `waitFor` 工具)自选。

### R2. 不得靠加固定延时糊过去

`await sleep(200)` 这类固定等待**不接受** —— 它把竞态换成了机器速度依赖,
慢机器上照样红。必须是**对目标量的轮询**,带超时上限。

### R3. 超时要给可读信息

轮询超时时的失败信息要能一眼看出「等的是 `coordinatorOccupancyCount`、
等到的是几」,不要退化成 `expected +0 to be 1` 这种无上下文的断言。

## 4. 验收标准

**基线先用工具取**:

```
node scripts/test-baseline.mjs packages/backend/server test/executor-coordinator-workspace-gate.test.ts
```

**取数基准(检视者 2026-09-08 实测,B5 收口后)**:该文件 **1 failed**,
即本票这一条。

1. **核心**:「验收 1」由红转绿。给出改前红、改后绿的对照两行。
2. **连跑 3 次都绿**(竞态票,单次绿不算数)。贴三次结果。
3. **零生产代码改动**:`git show --stat` 不得出现
   `packages/backend/server/src/**`。**硬约束**(§1.3)。
4. **同文件其它用例状态不变**。
5. **未加固定延时**:diff 里不得出现 `sleep(` / `setTimeout` 形式的固定等待(R2)。
6. `npx tsc --noEmit -p tsconfig.json` 通过。

## 5. 不涉及的改动

- **不改生产代码** —— 生产闸经复核是对的(§1.3)。若实现者认为生产侧确有问题,
  **停下来报告,不要顺手改**。
- 不改该文件其它用例,不改 `dispatch-policy.json`。
- 不改 `registerCoordinatorProcess` 的登记时机 —— 「spawn 后才登记」是有意的
  (`state.ts:442` 注释:没有 pid 就没有可做存活判定的对象)。

## 6. 兼容性

- 纯测试改动,无 schema 变更,无生产行为变更。
