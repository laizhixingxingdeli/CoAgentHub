# Spec: 恢复 CI 绿灯并恢复推送

> **状态**: **Landed**(2026-09-10 检视者 L3 收口)
> —— 实现部分 `e17d8d94` 于 2026-09-08 通过;**收口所差的那个「绿的 run id」
> 已于 2026-09-10 拿到**,见下方「2026-09-10 收口记录」。
> **版本**: 1.0
>
> **L3 收口记录(检视者独立复核)**:
> - **隔离对照(检视者自己做的)**:同样三个后端文件
>   改前 `6 failed | 83 passed (89)` → 改后 **`1 failed | 86 passed (89)`**。
>   **修好 5 条**,另 2 条按 R1 允许的方式**条件跳过**(win32,理由写明:
>   Unix 进程组 kill 在 Windows 无效),剩 1 条红。
> - **web `router.test.tsx`**:`1 failed | 7 passed` → **`8 passed (8)`**。
> - **R1 守住了 —— 没有放宽超时。** 执行者找到了超时的**真正原因**:
>   policy 把 `maxRetries` 提到 3 后,可重试的失败(含 stall)会连跑多次,
>   15s 级 wait 在中间一次 `running` 上超时,**看起来像「信号永远不来」**。
>   这正是 R1 要的处理方式(报告 §12.6 T3 同源)。
> - **⚠️ 一处越出票面字面、检视者认可的改动**:
>   为此在 `state.ts` 加了 14 行测试接缝 `__setMaxRetriesForTests`
>   (+ `index.ts` 一行导出)。票面写的是「需要动生产代码就停下来说明」。
>   **判定:接受。** 它是 `__` 前缀的测试专用钩子、注释写明用途、
>   与仓库既有 `__set*` 约定一致,**不改变任何生产行为**;
>   而它换来的是「找到根因」而非「加长等待」。
>   执行者自评里也点出了这个钩子的边界:
>   「在『要测默认 3 次重试』时不成立 → 那些用例应读 `getRetryPolicy()` 而非 pin」。
> - **R4 E2E 根因**:Playwright 在 **plugin setup** 里起 `webServer`,
>   **早于** `globalSetup` —— CI 上 `coagenthub_e2e` 尚未创建,
>   server 连库失败报「无法读取 Drizzle 迁移账本」。
>   修法是把建库放进 `webServer.command`。本机无 PostgreSQL service,
>   **未跑通完整 E2E**,需 push 后看 CI。
> - **R3 守住**:未 push、未建 PR、未推分支。
>
> ## ⚠️ 收口还差什么(执行者如实列出,检视者逐条确认)
>
> 这是本票**最重要的产出** —— 执行者无法自证,于是把不确定的部分全列了出来:
>
> | # | 项 | 检视者复核 |
> |---|---|---|
> | 1 | `output-parser.test.ts` 缺 `.scratch` 采样 | **已过时** —— 重录票 `985f0a2b` 之后本机 `0 failed | 132 passed`,该项应已解决 |
> | 2 | 时区类断言(未在本机用 UTC 复跑) | R11 收口时执行者跑过 `TZ=UTC/Asia-Shanghai/America-Los_Angeles` 三种,结果一致 |
> | 3 | workspace-gate 验收 1 | 已 Landed `be68d102`,检视者复跑 `0 failed | 13 passed` |
> | 4 | **E2E 业务用例在新 schema 上是否绿** | **真未知**,需 CI |
> | 5 | **`dispatch-policy.json` 走 `process.cwd()`,换个起法就读不到** | **成立且有价值** —— 见下 |
> | 6 | Windows 进程组 kill | ~~生产缺陷~~ **不成立**(2026-09-12 实测推翻,见下) |
> | 7 | 清单外回归 | **真风险**,今晚已两次实证 |
>
> **第 5 条另立票**:检视者核实 `executors.ts:691` 确为
> `resolve(process.cwd(), "scripts/dispatch-policy.json")`。
> 本机 `start.ps1` 把 cwd 设为仓库根,所以**当前是通的**;
> 兜底也是**有意的 fail-safe**(注释写明)。
> 但**读没读到不可观测** —— 见
> [dispatch-policy-load-is-not-observable.md](dispatch-policy-load-is-not-observable.md)。
>
> ## ✅ 2026-09-10 收口记录(检视者 L3)
>
> 上表第 4、第 7 两项是当时仅剩的未知,现在都有答案了。
>
> **绿的 run id(连续三个,不是单次侥幸)**:
>
> | run | commit | Build and Test | E2E |
> |---|---|---|---|
> | `34459862764` | `49447ce2` | ✅ Test / Typecheck / Lint | ✅ |
> | `34462137557` | `8c333669` | ✅ | ✅ |
> | `34464606595` | `6f2329f2` | ✅ | ✅ |
>
> 距上一次全绿(2026-08-16 `69ee93b3`)三周半。
>
> - **第 4 项「E2E 业务用例在新 schema 上是否绿」—— 已成立**,但过程中翻出了
>   比 schema 更根本的问题:E2E 套件对着的是**已下线的产品形态**
>   (身份模型 2026-08-24 `f6dc7b22` 换成 Local User;群页面从聊天流改成
>   RequirementWorkspace,`MessageList.tsx` 成了零 import 的死代码)。
>   先按「修得动的修、能力已下线的 skip 并记债」落了 `254ec75f`
>   (3 passed / 3 skipped),再由 `efc03495` 按所有者定调逐条重建,
>   现在是 **5 passed / 0 skipped**(回复树那条经论证后删除,理由留在
>   `e2e/messages.spec.ts` 文件头)。
> - **第 7 项「清单外回归」—— 确实发生了,且正是它拖住了收口**:
>   Test / Typecheck 转绿后,Lint 步骤才露出来(89 条 biome error,
>   自 2026-08-19 起一直被前面的失败挡着看不见),`51a7850e` + `3e496d8e`
>   清掉;随后又连续暴露两条测试自身的竞速(`2d115993` 认领超时阈值与占位
>   任务时长设成等量、`49447ce2` 等进程退出却断言占用归零),各修一笔。
> - **第 5 项另立的票仍未下发** —— `dispatch-policy-load-is-not-observable.md`
>   还是 Frozen。本轮反倒又实证了它一次:复现 CI 的重试行为必须手工带上
>   `COAGENTHUB_DISPATCH_POLICY_FILE`,否则本机 cwd 读不到策略、静默回落到
>   `maxRetries: 1`,而**没有任何输出提示你回落了**。
> - **第 6 项 Windows 进程组 kill** 仍是生产缺陷,不影响 ubuntu CI,未动。
>   → **2026-09-12 更正:这条不成立,不要另立票去修。** 为立票做前置实测时
>   推翻了它:Windows 上杀执行器**会**带走它普通 spawn 的后代,机制是 libuv 的
>   job object(`KILL_ON_JOB_CLOSE`),不是 POSIX 进程组;`process.kill(-pid)`
>   抛错落 `child.kill()` 兜底**不构成缺陷**。改前(`detached`)改后
>   (`windowsHide`)都一样,换 `taskkill /F` 不带 `/T` 也一样。唯一杀不到的是
>   **后代自己 breakaway 出去**的情形,而那个 `taskkill /T` 同样杀不到。
>   实测四组对照与机制判别见
>   [executor-spawn-shows-empty-console-on-windows.md](executor-spawn-shows-empty-console-on-windows.md)
>   的「2026-09-12 补测」。同处还记了一条那张票**漏报**的语义变化:
>   Windows 去掉 `detached` 后,执行器不再能在 server 退出后存活。
>
> **本机遗留(不拦 CI,如实记下)**:`web/src/router.test.tsx` 有 1 条本地红
> ——懒加载 chunk 超 `findBy` 默认 1000ms;已 A/B 确认改动前后一模一样,
> CI 上是绿的。`executor-queue.test.ts` 在本机整文件跑不可靠
> (同条件下改动前是 15 failed / 18 passed),两条竞速的修复是靠隔离复跑
> 加 CI 判定的,本地全量数不作判据。

> **日期**: 2026-09-08(收口 2026-09-10)
> **来源**: `docs/implementation-optimization-review-2026-09-07.md` §13.2 **V1**
> **前置决策(用户 2026-09-08 拍板)**:**逐票推**
> —— 每张票落地就推,不再本地积几十个提交。
> **排序**:报告 §13.8 明确「**V1 应当排在第 12 节的 T0 之前**」。
> 在没有一个绿的、跨机器的验证回路之前,基线测量得到的任何数字
> 都无法区分「优化生效」与「失败提前退出」。

## 1. 背景与目标

### 1.1 事实

| 事实 | 取值 |
|---|---|
| 最近一次 CI 通过 | **2026-08-16**(`69ee93b3`) |
| 此后 CI 运行 | 3 次,**全部失败**(08-19 / 08-29 / 09-07) |
| 最近一次失败 | `34074787902`,`6e142ed3`;Build and Test 与 E2E **两个 job 均失败** |
| 该次失败范围 | 测试 **7 文件失败 / 112 通过**(共 119) |
| 近 30 天提交数 | 738 |
| 本地未推送提交 | 报告写作时 36,**检视者 2026-09-08 20:15 实测已 60** |

**近 30 天的绝大部分工作从未被 CI 看到,而 CI 最后一次看到的状态是红的。**

### 1.2 这不是「CI 配置问题」

是**验证回路本身缺位**。当前唯一的事实来源是一台开发机。
AGENTS.md 记录的两次同日回归漏网(11 条既有用例转红、深比较断言未同步新字段)
正是在**没有第二个验证点**的条件下发生的。

⚠️ 检视者补充:**2026-09-08 本轮又发生了两次同类漏网** ——
缺陷 B 与 R11 各留下一批清单外的红,都是靠 L3 手工复跑才发现的。
第 12 节全部步骤(T0 基线、T5 复测、T6 分片)都假定「原有效测试通过」,
**该前提当前不成立**。

### 1.3 目标

**`main` 上一次完整 CI 通过(Build and Test 与 E2E 两个 job 均绿),
且失败用例是被修复而非被跳过或放宽超时。记录该次运行 id 作为后续比较锚点。**

## 2. ⚠️ 本地红 ≠ CI 红(实现者必读)

**检视者量的是 Windows 本机,CI 是 `ubuntu-latest`。两边不是同一批红。**

- 本机的一批红是 **Windows 特有**的(进程树终止、`/tmp` 语义、EPERM 清理),
  在 CI 上根本不出现;
- CI 上的一批红本机也未必复现(时区默认 UTC、缺 `.scratch/` 采样)。

**所以:不要把「本机全绿」当成本票达成。** 判据只有一个 ——
**真实的 CI 运行是绿的**。

## 3. 前置票的状态(检视者 2026-09-08 20:20 实测)

报告把 CI 失败归为三类。当前进度:

| 类别 | 对应票 | 状态 |
|---|---|---|
| **时区断言差值** | [recovery-clock-parsed-in-server-timezone.md](recovery-clock-parsed-in-server-timezone.md) | ✅ **Landed**(`1b428c7e` + `6b571f30`) |
| **缺失 fixture** | [tests-depend-on-gitignored-samples.md](tests-depend-on-gitignored-samples.md) | 🔄 在途 |
| **超时(15s/30s/60s)** | 本票 | ⬜ 未开始 |

本机实测的剩余红(**仅供定位,不是验收口径,见 §2**):

| 范围 | 结果 |
|---|---|
| `executor-coordinator-workspace-gate` + `executor-queue` + `task-completion-events` | **6 failed \| 72 passed (78)** |
| `executor-progress` | 1 failed(15s 超时) |
| `executor-quota-redispatch` | 1 failed(Windows EPERM,环境性) |
| web `src/router.test.tsx` | **1 failed \| 7 passed (8)** —— `Unable to find an element with the text: 群组消息流` |

其中 workspace-gate 的 1 条已另立
[workspace-gate-test-waits-on-wrong-counter.md](workspace-gate-test-waits-on-wrong-counter.md)。

## 4. 详细改动

### R1. 修,不许跳过或放宽超时

报告原文:「**失败用例是被修复而非被跳过或放宽超时**」。

- **不得** `it.skip` / `it.todo` 掉失败用例;
- **不得**把 `timeout: 15000` 改成 30000 让它勉强过 ——
  ⚠️ 这是本票最容易走的捷径,**明令禁止**。
  超时通常意味着**在等一个永远不来的信号**,把等待时间加长只是把问题推后。
  报告 §12.6(T3)的方向是「**以明确完成信号替代固定空闲等待**」,与此一致。
- 若某条用例确实**不该**在 CI 上跑(例如依赖本机 Windows),
  用**条件跳过 + 明确原因**,并在汇报里逐条列出,
  **不要无条件 skip**。

### R2. web `router.test.tsx` 的判断

`Unable to find an element with the text: 群组消息流` ——
先弄清是 **UI 改了而测试没跟**,还是 **UI 真的丢了这块**。

⚠️ 前者改测试,后者是产品缺陷、**要报告不要改测试**。
在汇报里说明你怎么判断的。

### R3. 逐票推(用户决策)

本票落地后,**推送节奏改为逐票推**。

⚠️ **实际的 `git push` 由用户执行或明确授权后执行** ——
执行器**不得**自行 push。
本票的实现部分只做「让它能绿」,推送与验证是用户与检视者的事。

### R4. E2E job 也要绿

报告要求「Build and Test 与 E2E **两个 job 均绿**」。
E2E 的失败原因可能与单测不同,**单独查、单独说明**。

## 5. 验收标准

1. **核心**:`main` 上一次完整 CI 通过,**两个 job 均绿**。
   记录该次 **运行 id** 作为后续比较锚点。
2. **不是靠跳过或放宽超时达成**(R1):
   逐条列出你改了什么、为什么;若有条件跳过,列出条件与原因。
3. **web router 用例**:说明是测试没跟还是产品缺陷(R2)。
4. **E2E 单独说明**(R4)。
5. 本地定向测试前后对照(**仅作参考,不是判据**,见 §2)。
6. `npx tsc --noEmit` 通过(相关包)。

## 6. 不涉及的改动

- **不执行 `git push`**(R3)—— 由用户决定时机。
- 不做 §12 的 T0–T6(本票是它们的前置)。
- 不改 CI 的 `timeout-minutes: 20`(V3 会重新审视 CI 与本机的时间口径)。
- 不修 workspace-gate 那条(已另票)。
- 不修 V2 的 fixture 依赖(已另票,在途)。

## 7. 兼容性

- 无生产行为变更(本票只修测试与 CI 可跑性)。
- 若某条修复需要动生产代码,**停下来说明** —— 那说明它不是「测试没跟」,
  而是真实缺陷,应当另立票。
