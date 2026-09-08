# Spec: 后端测试在 Windows 上整体失效 —— 假执行器起不来

> **状态**: Frozen
> **版本**: 1.0
> **日期**: 2026-09-08
> **来源**: 2026-09-07 检视者实测发现,**不在实现优化报告的清单内**。
> 报告 §11.4/§12 用大篇幅讨论测试**提速**,却没有意识到测试在这台机器上
> **根本跑不起来** —— 提速的前提是先能跑。

## 1. 背景与目标

### 1.1 现状证据(全部实测)

| 观测 | 数字 |
|---|---|
| 后端全量 | **129 failed / 924 passed**(2026-09-07 13:48) |
| 前端全量 | **33 文件 / 377 用例全绿**(2026-09-08 00:01) |
| 造 `#!/bin/sh` 假执行器的后端测试文件 | **23 个** |
| 这些假执行器使用的环境变量 | **43 个**(`FAKE_SLEEP_SECS` 60 次、`FAKE_COUNTER_FILE` 43 次、`FAKE_ALWAYS_FAIL` 27 次…) |
| 本票三个样本文件的基线 | **39 failed / 14 passed (53)**,耗时 486 秒(2026-09-08 12:38) |

**红全在后端**:前端一条不红。根因单一 —— 测试用
`writeFileSync(bin, ["#!/bin/sh", …])` + `chmodSync(0o755)` 造假执行器,
再把该路径当 `bin` 交给平台 spawn。**Windows 无法直接执行 `.sh`**,
于是所有依赖执行器生命周期的用例统统超时或拿到错误状态。

### 1.2 危害

**不是「慢」,是「没有信号」。** 129 条红意味着每张票的验收都退化成
「在红海里数增量」:检视者今晚三次都必须用 `git stash` 手动做前后对照才敢下结论,
而任何真回归都可能被淹没在既有红里。

### 1.3 关键判断:不要重写那 43 个环境变量

一个自然的想法是把假执行器改写成跨平台的 `.mjs`。**不要这么做**:
43 个环境变量分散在 23 个文件的不同脚本里,重写等于把 23 个测试的行为逻辑
重做一遍,风险与工作量都极大,而且**改的是被测行为的替身,容易悄悄改变语义**。

**正确的切口是「怎么把脚本变成可 spawn 的 bin」,而不是「脚本写什么」。**
检视者已实测(2026-09-08):

```
node -e spawnSync('C:/Program Files/Git/usr/bin/sh.exe', ['.scratch/fake-probe.sh'], {env:{FAKE_MSG:'hello'}})
→ status=0  stdout="got:hello\n"
```

`sh.exe` 随 Git for Windows 提供(本仓库的开发流程本身就跑在 Git Bash 上),
能原样执行这些脚本、正确传递环境变量、正确返回退出码与 stdout。
**脚本一行不改,43 个环境变量的行为全部保留。**

### 1.4 目标

让依赖假执行器的后端测试在 Windows 上真正跑起来,**不改任何假执行器脚本的内容**,
不改被测的生产代码。

## 2. 改动范围(本票只做样板,不做全量迁移)

| 文件 | 改什么 |
|---|---|
| `packages/backend/server/test/fake-executor-bin.ts`(新增) | 共享助手 |
| `packages/backend/server/test/retry-rollback-guard.test.ts` | 改用助手 |
| `packages/backend/server/test/executor-task-repo.test.ts` | 改用助手 |
| `packages/backend/server/test/executor-queue.test.ts` | 改用助手 |

**其余 20 个文件不在本票**,由后续票按本票确立的助手机械迁移。
先用 3 个文件证明修法成立,再铺开 —— 一次改 23 个文件正是要避免的。

**不改**:任何 `#!/bin/sh` 脚本的内容;`packages/backend/server/src/**` 下的任何生产代码;
`vitest.config.ts`;CI 配置;不加依赖。

## 3. 详细改动

### R1. 共享助手

新增 `test/fake-executor-bin.ts`,导出一个把「脚本路径」变成「可 spawn 的 bin + 前缀参数」的函数:

```ts
// 名称与签名自定,契约如下:
resolveFakeExecutor(scriptPath: string): { bin: string; argsPrefix: string[] }
```

- **非 win32**:`{ bin: scriptPath, argsPrefix: [] }` —— 行为与现状**逐字一致**;
- **win32**:`{ bin: <sh 可执行文件>, argsPrefix: [scriptPath] }`。

`sh` 的定位顺序自定,但必须:先尝试常见的 Git for Windows 路径
(`C:/Program Files/Git/usr/bin/sh.exe` 等),可被环境变量覆盖;
**找不到时抛出可读错误**,明确说「Windows 上需要 Git for Windows 的 sh.exe」,
**不得**静默回退成直接 spawn `.sh`(那只会退回今天的现象)。

### R2. 三个样板文件改用助手

把这三个文件里构造执行器配置的地方,从「直接用脚本路径当 bin」改为
「用助手返回的 `bin` + `argsPrefix` 拼」。

⚠️ **`argsPrefix` 必须拼在最前面**,原有的 `{ticket}` 等占位参数顺序**保持不变**。

⚠️ **不改这三个文件的任何断言与测试意图** —— 本票只改「假执行器怎么被启动」。
若某条用例在修好 spawn 之后仍然红,那是**另一个** Windows 问题,按 R3 处理。

### R3. 仍然红的必须逐条给出原因

修好之后大概率仍有残留红(路径分隔符、进程树终止、`/tmp` 等)。
**对每一条仍然红的用例,给出它的失败原因分类**(至少区分:
① 假执行器 spawn 问题——本票应已消除;② 其它 Windows 平台问题;③ 真实缺陷)。

**不得**为了让数字好看而修改断言或跳过用例。分类不确定时写「未能判定」并说明查过什么。

## 4. 验收标准

**基线(检视者实测,2026-09-08 12:38,commit `df619a5e`)**:

```
node scripts/test-baseline.mjs packages/backend/server \
  test/retry-rollback-guard.test.ts test/executor-task-repo.test.ts test/executor-queue.test.ts
→ 39 failed | 14 passed (53);文件 3 failed | 0 passed (3);耗时 486 秒
```

⚠️ 这一跑要 **8 分钟**,前后各一次,请预留时间。**不要跑全量**(24 分钟)。

1. **失败数显著下降**:用同一条命令取改动后的基线,贴出前后两行。
   期望「假执行器起不来」这一类红被清零;**具体数字不预设**,
   但必须按 R3 对每条残留红给出分类。
2. **非 Windows 行为逐字不变**:助手在非 win32 分支返回原路径与空前缀;
   说明你如何确认这一点(读代码即可,不要求真在 Linux 上跑)。
3. **找不到 sh 时报错可读**:构造一次找不到 sh 的情形(例如把定位用的环境变量指到
   不存在的路径),断言抛出的错误信息里明确提到需要 Git for Windows 的 sh。
4. **零生产代码改动**:`git show --stat` 里**不得出现** `packages/backend/server/src/**`
   下的任何文件,也不得出现任何 `.sh` 脚本内容的改动。**硬约束。**
5. `cd packages/backend/server && npx tsc --noEmit -p tsconfig.json` 通过。

## 5. 不涉及的改动

- **不迁移其余 20 个测试文件**(后续票)。
- **不重写假执行器脚本**、不改那 43 个环境变量的语义。
- **不改生产代码**:`/tmp` 硬编码与进程树终止是报告 R10 的另两项,各自另票。
- 不改 `vitest.config.ts` / CI / 依赖。
- 不为提速而跳过或删除用例。

## 6. 兼容性

- 非 Windows:助手第一分支即返回原值,行为逐字不变。
- Windows:需要 Git for Windows 提供的 `sh.exe`(本机已确认存在)。
  缺失时报可读错误而非静默失败。
- 无生产代码改动,无 schema 变更。
