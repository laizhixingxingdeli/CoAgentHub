# Plan: Windows 上每次派发都弹一个空终端窗口

> 配套 `specs/executor-spawn-shows-empty-console-on-windows.md`。spec 已冻结；**本文件会变**（回填 taskId、标完成）。
> 路径规则：`specs/<name>.md` → `plans/<name>.md`。
> 平台不解析本文件。计划是提示，**task 事实是权威**。

## 元信息

| 字段 | 值 |
|---|---|
| specRef | `specs/executor-spawn-shows-empty-console-on-windows.md` |
| specHash | `889c1c6b4d9e8f0dce1a0bc8067c2745ef3c6972` |
| 编制 | 三方（reviewer + coordinator + executor） |
| dispatchKind | `fix`（检视者分流；L3 精简档） |
| 更新 | 2026-09-11 |

## 工作项

> **工作项 ≠ task**：工作项 = 要完成的事；task = 一次执行。

### W1 — 实测三种 spawn 组合 + 按平台分叉消除弹窗

| 字段 | 内容 |
|---|---|
| 稳定编号 | W1 |
| 目标 | Windows 派发不再弹空终端；POSIX spawn 选项逐字未变；kill/stdio/孤儿语义不退化 |
| 范围 | `packages/backend/server/src/lib/executor-runner.ts` 的 `runExecutor` spawn 选项按平台分叉；新增/扩展对应单测；**必须先做 R1 三种组合的真机弹窗实测** |
| 前置依赖 | 无 |
| 预期产物 | ① 改后的 `executor-runner.ts`（Windows 最小组合消除弹窗；非 Windows 仍 `detached: true`）② 覆盖 spawn 选项平台分叉 + stdio 仍为 pipe 的测试 ③ 汇报含 R1 三组合实测表、kill 路径说明、§7 存活行为说明 ④ 本计划文件纳入同一提交边界 |
| 验收方法 | 对照冻结 spec §4 验收 1–7；基线 `node scripts/test-baseline.mjs packages/backend/server test/executor-runner-windows-launcher.test.ts`（及本票新增的测试文件）；`npx tsc --noEmit -p tsconfig.json`（server 包） |
| specRef | `specs/executor-spawn-shows-empty-console-on-windows.md` |
| specHash | `889c1c6b4d9e8f0dce1a0bc8067c2745ef3c6972` |
| taskId | _未派发_ |
| 状态 | planned |

## 依赖图

```
W1
```

## 诊断（下发前）

| 字段 | 内容 |
|---|---|
| 现象 | 派发时任务栏弹出**空的**终端窗口（有窗无内容，因为 stdout/stderr 被 pipe） |
| 期望行为 | Windows 上派发不弹窗；其它平台与 kill/stdio 行为不变 |
| 复现步骤 | 向本群 executor 派发任意任务 → 观察任务栏 / WindowsTerminal 窗口 |
| 已观察事实及证据位置 | 检视者复现：atomcode pid 对应 `WindowsTerminal` 空窗；成因 `executor-runner.ts:173` `detached: true` 且无 `windowsHide`；同仓 `callback-agent/.../command-driver.ts:244` 已用 `windowsHide`；Windows 上 `process.kill(-pid)` 必抛、落 `child.kill()`（restore-ci-green 第 6 项） |
| 根因假设 | Windows 上 `detached` → 子进程自有控制台 + 默认显示；`windowsHide` 与 `detached` 组合是否有效**待 R1 实测**（可能 CREATE_NO_WINDOW 被 DETACHED_PROCESS 忽略） |
| 验证动作与结果 | 由 W1 执行器按 R1 三组合真机实测（禁止只读文档推断） |
| **被排除的假设** | 「全平台去掉 detached」——POSIX 进程组 kill 真有效，砍掉是更严重回归；「顺手修 Windows 进程树 kill」——独立缺陷，本票不改既有（有缺陷的）kill 语义 |
| 建议修复范围 | 仅 `runExecutor` 的 spawn 选项平台分叉 + 测试；不改 `.cmd` 垫片、超时、git spawn、kill 兜底实现 |
| **不能改变的行为** | POSIX `detached: true`；Windows kill 仍走负 pid→catch→`child.kill()`；stdio pipe 流式回传；不修 process-tree kill |
| 回归场景 | 非 Windows 分支 diff 逐字；stdio onOutput 仍触发；server 退出后子进程可探测性若因去 detached 变化必须在汇报写明 |
| 最终产物验收方式 | L2 对照 spec §4；三方在场 L3 精简档（`review_request` + `lite: true`） |

## 派发备注

- 实现+测试合并为一张执行票（单一内聚关注点）。
- 执行器：atomcode（票面测试执行器；实现同票完成）。
- 测试清单（只跑这些，失败数不增加即可）：
  - `test/executor-runner-windows-launcher.test.ts`
  - 本票新增的 executor-runner spawn/stdio 相关测试文件（若有）
- 红线：禁止全平台去掉 detached；禁止修 Windows 进程树 kill；验收 5 必须覆盖 stdio。
