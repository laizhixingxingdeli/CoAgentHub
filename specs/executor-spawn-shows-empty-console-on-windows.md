# Spec: Windows 上每次派发都弹一个空终端窗口

> **状态**: **Landed — L3 通过(2026-09-12),实现 `090bcf7d`**
> **版本**: 1.0
> **日期**: 2026-09-11(落地 2026-09-12)
>
> ## ✅ L3 收口记录
>
> ### R1 的实测做出来了,而且推翻了「最小改动」
>
> 票面 §1.4 提出的疑问 —— 「只加 `windowsHide` 够不够」—— 实测给了否定答案:
>
> | # | 组合 | 弹窗 | stdout 完整 |
> |---|---|---|---|
> | 1 | `detached: true`(现状) | **YES** — 新生 OpenConsole + conhost | YES |
> | 2 | `detached: true` + `windowsHide: true` | **YES** — 仍拉起 OpenConsole | YES |
> | 3 | `windowsHide: true`(不传 `detached`) | **NO** ✓ | YES |
> | 4 | 对照:`start` 起可见 cmd | YES | n/a |
>
> #2 无效,与 Win32 的「`CREATE_NO_WINDOW` 与 `DETACHED_PROCESS` 同用时前者
> 被忽略」一致。**所以「加个 windowsHide」这个最小改动确实不管用**,必须同时
> 在 Windows 上去掉 `detached` —— 票面不预设结论是对的。
>
> ⚠️ **第 4 行是对照组,票面没要求,是执行侧自己加的。** 没有它,「没检测到
> 窗口」可能只是检测方法坏了。这是本轮方法论上最值得记的一笔。
>
> 三种组合都验了 stdout 完整性(验收 4)。
>
> ### 实现
>
> 抽出 `buildExecutorSpawnOptions`,带**可注入的 `platform` 参数** —— 两个
> 分支在同一台机器上都能测,不必真的换 OS。
>
> - **Windows**:`windowsHide: true`,不传 `detached`;
> - **POSIX**:`detached: true`,逐字保留(那里进程组 kill 真有用)。
>
> ### 检视者独立核实
>
> - `tsc --noEmit` exit 0;
> - `executor-runner-spawn-options.test.ts` + `executor-runner-windows-launcher.test.ts`
>   合跑 **14 passed**;
> - **kill 路径零 diff** —— 票面禁止顺手修 Windows 进程树 kill,守住了;
> - 新测试覆盖了票面警告的那条:**「多块 stdout/stderr 经 onOutput 完整回传」**
>  (既有的 windows-launcher 测试只覆盖 `.cmd` 垫片解析,不覆盖 stdio)。
>
> ### 遗留
>
> ~~**Windows 的进程树 kill 仍是缺陷**:只终止直接子进程、不含后代,需要
> `taskkill /T`,另立票。~~
>
> ### 🔬 2026-09-12 补测:上面这段是错的,且本票漏报了一个语义变化
>
> 收口后检视者为「另立进程树 kill 票」做前置实测,结果推翻了两件事。
> 探针在 `.scratch/`(已清理),判据用 **tasklist + 心跳文件**双口径,
> 并带对照组;最后一轮直接 `import` 源码里的 `buildExecutorSpawnOptions`,
> 不手抄选项。
>
> **① 「kill 只终止直接子进程」不成立 —— 那张票不该立。**
>
> | # | 组合 | 杀 executor 后,它普通 spawn 的孙进程 |
> |---|---|---|
> | G | executor `detached: true`(**改前**) | **也死** |
> | H | executor `windowsHide: true`(**改后**) | **也死** |
> | D | 换 `taskkill /F`(不带 `/T`)杀 executor | **也死** |
> | E | 孙进程自己用 `detached: true` 起 | **活下来** |
>
> D 排除了「node 的 kill 实现在级联」——任何终止方式都一样。真正的机制是
> **libuv 的 job object**(非 detached 的子进程被放进一个 `KILL_ON_JOB_CLOSE`
> 的 job,句柄只由父进程持有;父进程一死 job 关闭、成员全灭),**不是 POSIX
> 进程组**。所以 `process.kill(-pid)` 抛错落兜底**根本不是缺陷**,改前改后
> 后代都会被带走。
>
> 唯一的真例外是 E:后代自己 breakaway 出去的杀不到。这不是「只杀直接子进程」,
> 也不是 `taskkill /T` 能解决的(它同样杀不到已 breakaway 的进程)。
>
> → **不要去加 `taskkill /T`。** 见
> [restore-ci-green-and-resume-pushing.md](restore-ci-green-and-resume-pushing.md)
> 第 6 项(已同步更正)。
>
> **② 本票改变了「server 退出后执行器是否存活」,但汇报里没写 —— §7 明确要求写。**
>
> | executor spawn 选项 | server 退出后 executor |
> |---|---|
> | `detached: true`(**改前**) | **存活**(breakaway,不在 server 的 job 里) |
> | `windowsHide: true`(**改后**) | **跟着死** |
>
> 又用 detached 的中间进程做过一轮:server-sim 先 breakaway 出外壳的 job,
> 它起的 executor 照样跟着死 —— 证明这个 job 是 **libuv 在 spawn 侧建的**,
> 结论对生产成立,不是被 shell 环境污染的探针结果。
>
> **判断:对本部署是净改进,不回滚。** 理由:
>
> - `start.ps1` 起的是 `node dist/server.mjs`(built 产物),**不是 `tsx watch`**,
>   所以不存在「改个文件就重启、连带杀掉在跑的执行器」——这是本条能判净改进的
>   前提,换成 watch 模式起 server 时结论要重估;
> - CLI(非 detached)任务改前「存活」其实是**假存活**:server 一死 stdout 管道
>   就断了,结果无法回收,任务挂在 `running` 直到 `detachedTimeoutMinutes`
>   (默认 24h)兜底,期间白烧额度。2026-09-11 停 Postgres 误杀 server 那次,
>   正是这个形态;
> - 改后执行器跟着死 → 重启时 `recoverInterruptedTasks` 的 R3 命中
>   (`!isExecutorProcessAlive` → `server-restart` failed),**如实判死、可重试**。
>
> **代价(如实记)**:长时 **detached** 任务不再能熬过一次刻意重启 ——
> 它本来不依赖管道、能自己 PATCH 回写,改后这部分可恢复的工作会丢。
> 当前没有长时 detached 任务在跑,不构成拦截项;若将来有,再按需回到
> 「按 `run.detached` 分叉 spawn 选项」。
>
> **L3 自查**:§7 写着「子进程在 server 退出后的存活行为……后者若有变化必须
> 写明」。执行侧没写,**检视者也没查** —— 验收 3/4 都只盯 kill 路径和 POSIX
> 分支,没人去量那句兼容性条款。票面提了要求 ≠ 有人验了。
>
> ### ⚠️ 本票绕过了平台
>
> 平台下发的任务 `01a090bc` 因级联事故被误判 failed(见
> [r2-exemption-narrowing-kills-healthy-coordinators.md](r2-exemption-narrowing-kills-healthy-coordinators.md))。
> 本次由检视者直连 `pi.cmd -p --no-session @<票面>` 完成,约 11 分钟一轮。
> **来源**: 用户观察 —— 「atomcode 调用的时候会有一个空的终端窗口出现」。
> 检视者复核属实,并查到成因与一个已知缺陷相关。

## 1. 背景与目标

### 1.1 现象(检视者已复现)

派发任务时,任务栏出现一个**空的**终端窗口。实测当前在跑的 atomcode
(pid 34892)对应窗口:

```
28760  WindowsTerminal  C:\Users\echo\AppData\Roaming\npm\node_modules\@atomgit.com\atomcode\...
```

窗口是空的,因为 stdout/stderr 全被 `pipe` 接到父进程了 —— **有窗口,没内容**。

### 1.2 成因

`packages/backend/server/src/lib/executor-runner.ts:173`:

```ts
child = spawn(launcher.bin, launcher.args, {
  cwd,
  detached: true,
  stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
  ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
});
```

- **`detached: true`** 在 Windows 上的语义是「子进程获得自己的控制台」
  (与 POSIX 的「独立进程组」不是一回事);
- **`windowsHide` 未设**(Node 默认 `false`),所以那个控制台被显示出来。

⚠️ 本仓库**知道**有 `windowsHide`:`packages/callback-agent/src/command-driver.ts:244`
就用了。只是执行器这处没加。

### 1.3 `detached` 在 Windows 上是净亏

代码注释(:171)说 `detached` 是为了停止指令能整体终止进程组。实际的 kill:

```ts
kill: () => {
  try {
    process.kill(-child.pid, "SIGTERM");   // 负 pid = POSIX 进程组
  } catch {
    try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
  }
}
```

**Windows 上没有 POSIX 进程组**,负 pid 那句必抛,直接落到兜底
`child.kill()` —— 而它只终止直接子进程,不含后代。

这一点仓库早已记录:
[restore-ci-green-and-resume-pushing.md](restore-ci-green-and-resume-pushing.md)
第 6 项 **「Windows 进程组 kill —— 生产缺陷」**。

→ 所以 Windows 上 `detached: true` **拿不到任何好处**(kill 本来就不工作),
**只换来一个空窗口**。

### 1.4 ⚠️ 「加个 windowsHide」可能不够 —— 这是本票的核心技术问题

Win32 的进程创建标志里,`CREATE_NO_WINDOW`(即 `windowsHide` 的底层)
**在与 `DETACHED_PROCESS`(即 `detached` 的底层)同时指定时会被忽略**。

若该行为属实,则:

- 只加 `windowsHide: true` 而保留 `detached: true` → **窗口照旧出现**;
- 必须在 Windows 上**同时去掉 `detached`**,窗口才会消失。

**票面不预设结论。** 实现者必须**实测**这两种组合的真实行为,把结果写进汇报 ——
这是本票唯一需要判断的地方,其余都是搬运。

### 1.5 目标

Windows 上派发不再弹窗,且**不改变任何平台的 kill 行为与进程生命周期语义**。

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/backend/server/src/lib/executor-runner.ts` | spawn 选项按平台分叉 |
| 对应测试 | 新增用例 |

**不改**:`resolveWindowsLauncher` 的 `.cmd` 垫片解析;kill 的兜底逻辑;
超时路径;stdio 口径;`git` 那处 spawn(:316,它本来就没有 `detached`,
也不弹窗)。

## 3. 详细改动

### R1. 先实测,再决定改法

必须实测并在汇报里给出结论:

| 组合 | Windows 上是否弹窗 |
|---|---|
| `detached: true`(现状,无 windowsHide) | 弹(已知) |
| `detached: true` + `windowsHide: true` | **待测** |
| 无 `detached` + `windowsHide: true` | **待测** |

⚠️ **实测指的是真的跑一次派发并观察窗口**,不是读文档推断。文档与实际行为
不一致的情况在 Windows 上很常见。

### R2. 按实测结果改,并按平台分叉

- **POSIX 保持现状**:`detached: true` 在那里是真有用的(进程组 kill 确实
  工作),不得改动。
- **Windows**:按 R1 的实测结果取能消除弹窗的最小组合。

⚠️ **不要全平台一刀切去掉 `detached`** —— 那会破坏 POSIX 上真正工作的
进程组 kill,是比弹窗严重得多的回归。

### R3. kill 行为必须证明未变

若 Windows 上去掉了 `detached`,必须证明 kill 行为**与改动前一致**:

改动前 Windows 的实际路径已经是「负 pid 抛错 → 落 `child.kill()`」,
去掉 `detached` 后应当**仍是同一条路径、同样的结果**。

⚠️ **不要顺手去修 Windows 的进程树 kill**。那是 `restore-ci-green` 第 6 项
记录的独立缺陷(需要 `taskkill /T` 之类的平台特定手段),**另立票** ——
本票只消除弹窗,不改变既有的(有缺陷的)kill 语义。

## 4. 验收标准

1. **实测三种组合的弹窗行为**并列表写进汇报(R1),含「怎么测的」。
2. Windows 上派发不再出现终端窗口。
3. **POSIX 的 spawn 选项逐字未变**(`git diff` 自证:非 Windows 分支
   仍是 `detached: true`)。
4. **kill 行为未变**:说明改动前后 Windows 上走的是同一条路径;
   POSIX 的进程组 kill 未受影响。
5. stdout/stderr 的收集不受影响 —— 执行器输出仍能完整流式回传
   (这是任务面板实时输出的来源,断了会静默丢进度)。
6. 既有测试不新增失败;受影响文件前后对照用
   `node scripts/test-baseline.mjs packages/backend/server <文件...>` 取。
7. `npx tsc --noEmit -p tsconfig.json` 通过。

⚠️ 验收 5 特别提示:`executor-runner-windows-launcher.test.ts` 等既有用例
覆盖的是垫片解析,**不覆盖 stdio 行为**。别只跑它就认为没事。

## 5. 不涉及的改动

- **不修 Windows 的进程树 kill**(§3 R3,另立票)。
- 不改 `.cmd` 垫片解析。
- 不改超时/停止/回滚的任何既有语义。
- 不改 `git` 那处 spawn。

## 6. 工作文件的去向

沿用既定约束:临时脚本与中间产物**一律放 `.scratch/`**;交付时
`git status --porcelain` 除本票改动与用户长期未提交的两个文件外为空。
**计划文件 `plans/<name>.md` 属于交付物,要纳入提交**。

## 7. 兼容性

无 API / schema 变更。Windows 上子进程的控制台归属可能改变(取决于 R1
结论),需说明这是否影响:执行器读取 stdin(本平台按 `useStdin` 决定是否
传 pipe)、子进程在 server 退出后的存活行为。**后者若有变化必须写明** ——
平台的孤儿收敛依赖「server 退出后执行器进程仍可被探测到」这一前提。
