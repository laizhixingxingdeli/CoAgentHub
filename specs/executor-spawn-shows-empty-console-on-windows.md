# Spec: Windows 上每次派发都弹一个空终端窗口

> **状态**: Frozen
> **版本**: 1.0
> **日期**: 2026-09-11
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
