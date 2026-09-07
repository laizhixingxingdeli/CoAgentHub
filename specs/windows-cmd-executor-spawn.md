# Spec: Windows 下 `.cmd` 执行器一律 spawn EINVAL,任何票都派不出去

> **状态**: Frozen
> **版本**: 1.0
> **日期**: 2026-09-07
> **来源**: [docs/implementation-optimization-review-2026-09-07.md](../docs/implementation-optimization-review-2026-09-07.md)
> R10「Windows 运行契约」的**第一项**;另两项(临时目录、进程树终止)不在本票。
> **背景**: 2026-09-07 首次在 Windows 主机上真实下发 R1,任务
> `01a07a5f-8deb-726f-9615-9d779242536d` 在执行器启动前即 `failed`。

## 1. 背景与目标

### 1.1 现状证据

[`executor-runner.ts`](../packages/backend/server/src/lib/executor-runner.ts) 第 84 行:

```ts
child = spawn(bin, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
```

**没有传 `shell`**。Node 自 CVE-2024-27980 加固后,在 Windows 上拒绝在无 shell 时
spawn `.cmd` / `.bat`,直接抛 `EINVAL`。本机实测(Node v24.13.0,同一 detached 选项):

```
no-shell + detached   -> throw: spawn EINVAL
shell:true + detached -> 子进程正常启动
```

真实任务的 `diffSummary.error`:

```
执行器启动失败: 无法启动 C:\Users\echo\AppData\Roaming\npm\pi.cmd: spawn EINVAL
```

本群四个执行器(`pi` / `atomcode` / `codebuddy` / `claude`)的 `bin` 全部是 npm 安装
生成的 `.cmd` 垫片,因此 **Windows 主机上任何票都派不出去**,与票的内容无关。

### 1.2 为什么不能简单加 `shell: true`

1. **注入面**:`shell: true` 时 Node 把 args 直接**拼接**进命令行且不转义
   (Node 已用 `DEP0190` 弃用警告标注)。任务书正文由 LLM 产出,含
   反引号、`&&`、`|`、`%`、引号是常态。
2. **多行 argv 不可还原**:`{ticketContent}` 占位(`queue.ts:2116-2121`)会把
   **整份多行任务书**作为**一个** argv 元素传给执行器(本群 `claude` 执行器正是
   这样配置的)。经 `cmd.exe` 的命令行拼接无法可靠还原换行与引号。

所以本票不引入 shell,改为**在 spawn 前把 `.cmd` 垫片解析成可直接 spawn 的真实目标**,
argv 数组语义保持不变(零转义、零注入面)。

### 1.3 目标

Windows 上以 npm `.cmd` 垫片配置的 CLI 执行器可以被正常拉起;解析不出目标时
**明确失败并给出可读原因**,不做静默兜底,也不改变非 Windows 平台的行为。

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/backend/server/src/lib/executor-runner.ts` | 新增导出的纯函数 `resolveWindowsLauncher()`;`runExecutor` 在 spawn 前调用它 |
| `packages/backend/server/test/executor-runner-windows-launcher.test.ts` | 新增该纯函数的单元测试 |

**不改**:`runExecutor` 的返回契约(`pid` / `promise` / `kill`)、超时与流式输出、
`detached` 选项、A2A 分支、执行器配置 API 与数据库、任何非 win32 平台的行为。

## 3. 详细改动

### R1. `resolveWindowsLauncher(bin, args, deps?)` —— 纯函数,可单测

签名(`deps` 仅供测试注入,生产调用不传):

```ts
resolveWindowsLauncher(
  bin: string,
  args: string[],
  deps?: { platform?: NodeJS.Platform; readShim?: (p: string) => string | undefined; nodeBin?: string },
): { bin: string; args: string[] }
```

判定顺序,任一不满足即**原样返回**入参(不猜、不兜底):

1. `platform !== "win32"` → 原样返回。
2. `bin` 不以 `.cmd` / `.bat`(大小写不敏感)结尾 → 原样返回。
3. 读不到垫片文件 → 原样返回。
4. 从垫片中取**最后一条含 `%*` 的行**,提取其中的双引号 token,
   丢弃含 `%_prog%` / `%COMSPEC%` 的 token,取第一个含 `%dp0%` 的 token 作为目标;
   把 `%dp0%` 替换为垫片所在目录并规范化路径(垫片写的是 `%dp0%\node_modules\…`,
   `dp0` 自带结尾反斜杠,会产生双反斜杠,必须规范化)。
5. 目标文件不存在 → 原样返回。
6. 目标以 `.exe` 结尾 → `{ bin: 目标, args }`(直接 spawn 真实可执行文件)。
7. 其余(`.js` 或无扩展名的 node 脚本)→ `{ bin: nodeBin ?? process.execPath, args: [目标, ...args] }`。

**args 只做前缀追加,不做任何转义或重排**——这是本方案相对 `shell: true` 的全部价值。

### R2. `runExecutor` 接入

spawn 前调用一次 `resolveWindowsLauncher`,用返回值 spawn。
spawn 失败时的错误信息**必须同时给出原始 bin 与实际尝试的 bin**,
否则 Windows 上的排障会看到一个与配置对不上的路径。

### R3. 不改变失败语义

解析不出目标 → 仍然按原 bin spawn → 仍然抛 `EINVAL` → 仍然走既有
`failTask("执行器启动失败: …")` 路径。本票**不新增**「无法解析垫片」这一类
新的失败态,只是让能解析的那部分正常工作。

## 4. 验收标准

1. **纯函数单测**(`npx vitest run test/executor-runner-windows-launcher.test.ts`):
   - node 型垫片(`… & "%_prog%"  "%dp0%\node_modules\pkg\bin\x.js" %*`)
     → `bin === process.execPath`(或注入的 `nodeBin`),`args[0]` 为解析出的 `.js`
     绝对路径,**其余 args 顺序与内容逐字不变**;
   - exe 型垫片(`"%dp0%\node_modules\pkg\bin\x.exe"   %*`)
     → `bin` 为该 `.exe` 绝对路径,`args` **逐字不变**;
   - 无扩展名脚本目标(`bin\codebuddy`,首行 `#!/usr/bin/env node`)→ 走 node 分支;
   - `platform !== "win32"` → 原样返回(同一份垫片输入,断言未改写);
   - 非 `.cmd` 的 bin → 原样返回;
   - 垫片读不到 / 目标文件不存在 → 原样返回;
   - 含空格、`&`、换行的 args → **逐字不变**地出现在返回的 args 里
     (证明没有引入转义/拼接)。
2. **端到端**:在本机重新下发一张真实任务,任务离开 `queued/failed`、
   进入 `running` 且 `executorPid` 非空(读 `GET /groups/:id/tasks/:taskId`,
   不看日志推断)。
3. **主干回归**:`cd packages/backend/server && npx vitest run` 全绿。
4. **类型检查**通过。
5. **运行时新鲜度**:改完 server 必须重新构建并重启,`GET /api/health` 的
   `"stale": false`(AGENTS.md 硬性要求)。

## 5. 不涉及的改动

- **`/tmp` 硬编码**(`queue.ts:2043` 任务书、`detail-store.ts` 明细、
  `watchdog-state.ts` 状态文件):本机 `C:\tmp` 恰好存在,写入可成功,
  因此**不是当前阻塞**;统一临时目录仍属 R10,另票。
- **进程树终止**:`process.kill(-pid)` 与 `detached` 在 Windows 上不成立
  (Callback Agent 的负 PID 同理),属 R10,另票。
- **是否正式支持 Windows 本地执行**:本票只解开当前阻塞,不构成平台支持承诺。
- 不改执行器配置 API,不要求用户改 `bin` 配置。

## 6. 兼容性

- 非 Windows 平台:`resolveWindowsLauncher` 第一步即原样返回,行为逐字不变。
- Windows 平台:此前必然 `EINVAL` 的 `.cmd` 配置现在可以启动;无法解析的
  垫片行为与此前一致(仍然 `EINVAL` 失败)。
- 无 schema 变更,无迁移,无配置变更;回滚只需回滚代码。
