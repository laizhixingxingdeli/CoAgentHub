# Spec: 重录执行器探针样本,让 6 条硬验收重新产生证据

> **状态**: Landed(`985f0a2b`,2026-09-08 检视者 L3 通过)
> **版本**: 1.0
>
> **L3 收口记录(检视者独立复核)**:
> - **核心达成**:基线自行复跑 **`0 failed | 132 passed (132)`** ——
>   **skipped 从 6 变 0**,6 条硬验收全部恢复运行并通过。
> - **零生产代码**:`git show --name-only` 无 `server/src/**`。
> - **不再依赖 `.scratch/`**:两个测试文件里 `.scratch` 与 `skipIf` 计数均为 **0**。
> - **§4.2(本票最有价值、最易糊弄的一条)做到了**:
>   执行者给出 6 条用例逐条的「**要验的现象是什么 / 新样本里在哪**」表 ——
>   例如「失败命令不进界面、进持久化」对应
>   `command_execution exit 1`,并给了 sha 与字节数。
> - **脱敏**:新增的 5 个 fixture
>   (`atomcode-run.stdout/.stderr` / `codebuddy-run.jsonl` /
>   `codex-error-run.jsonl` / `pi-run.jsonl`)**零命中**。
>   ⚠️ 检视者的自查 grep 曾在 4 个**既有** fixture 上报警,
>   核实为假阳性:`sk-` 匹配到了 `queued-ta**sk-ne**ver-picked-up` /
>   `ta**sk-re**claim` 里的 "task-"。
>   执行者的脱敏细致处:把 codebuddy 的 `apiKeySource` 字段改名为 `keySource`,
>   因为**字段名本身**会命中 `api[_-]?key`。
> - **探针无副作用**:`git status` 探针前后对比,仓库无因探针产生的改动。
>
> **⚠️ 执行者如实声明的覆盖缺口(检视者确认,并认为处理正确)**:
>
> 原硬验收里的 **Codex「Reconnecting ×4 + 传输降级」场景本环境未能复现** ——
> 它依赖一次真实的网络抖动。执行者用**真实**的 `exit 1` 失败命令 + 两条旁白
> 重新锁定,**仍覆盖**「界面只留 report 旁白+终稿」「非 report 进持久化不进界面」;
> **未覆盖**顶层 `type:error` / Reconnecting 在真实 corpus 上的过滤
> (该路径仍有单元级 synthetic 用例)。
>
> **它没有伪造一次断连来凑满覆盖** —— 这正是本票 §3 R3 的底线。
> 若要求 error 事件也出现在真实 corpus,**需另票在可制造传输错误的环境重采**。
> **日期**: 2026-09-08
> **前置**: [tests-depend-on-gitignored-samples.md](tests-depend-on-gitignored-samples.md)
> (Partially landed `5d42f961`)已消除 ENOENT,但代价是 **6 条硬验收改为
> `it.skipIf` + `[需本地样本]`,不产生任何证据**。本票把证据补回来。

## 1. 背景与目标

### 1.1 为什么前一票只能走到这

原样本(`.scratch/probe/samples/` 下的 `atomcode-run.stdout` /
`atomcode-run.stderr` / `pi-run.jsonl`)**已经不存在**,连采集它的这台机器上都没了。

而这批用例**锁死了那一次探针的哈希 / token 计数 / 正文片段**。于是:

| 路子 | 为什么不行 |
|---|---|
| 用 `logs/` 下的其它执行器日志 | 来自**不同任务**,格式同、内容不同,断言必红;改断言去迁就 = 放宽断言 |
| 手写一份像样的探针 | 伪造。这批用例的全部价值就是「以真实输出为准」,伪造 = 自证 |
| `it.skipIf` | 不违规,但**不产生证据** ← 前一票落在这 |

### 1.2 现在失去了什么

被 skip 的 6 条是**执行器输出解析与 token 记账的硬验收**
(spec `live-output-only-agent-narration` 等)。

它们守护的是:实时输出里哪些是 agent 叙述、哪些该排除;token 怎么记账。
**这两件事一旦回归,表现是「任务面板显示的东西不对」——
用户会看到,但没有任何测试会先报警。**

### 1.3 目标

**重新采集真实探针 → 脱敏入库 → 按新样本重新锁定断言 → 6 条 skip 全部恢复运行。**

## 2. 改动范围

| 范围 | 内容 |
|---|---|
| 新增 | `packages/backend/server/test/fixtures/` 下的新探针样本 |
| 改 | `test/output-parser.test.ts` / `test/token-usage.test.ts` 里那 6 条的断言基准 |
| 不改 | 生产代码;解析器实现;`.gitignore`;**测试的意图** |

## 3. 详细改动

### R1. 重新采集真实探针

在本机跑一次执行器,**捕获它的原始输出**。要点:

- **pi**:`pi.cmd -p --no-session "@<某个小任务书>"` 的 JSONL 流
  (本机 `logs/pi-taskpanel.log` 就是这种形态,开头是
  `{"type":"session","version":3,…}`);
- **atomcode**:`atomcode -y -v -p "<提示>"` 的 stdout / stderr
  (形态见 `logs/atomcode-r3.log`:`[headless]` / `[thinking]` / `[tokens]`)。

⚠️ **探针任务要小且无副作用** —— 让它读一个文件、说一句话就行,
**不要让探针执行器改动仓库**。在汇报里写明你用的探针任务内容。

### R2. 断言基准按新样本重新锁定 —— 这是「重新锁定」,不是「放宽」

哈希、token 计数、正文片段都会变。**按新样本更新它们是正确的**,
因为断言的**意图**没变:「解析器对这一份真实输出得出这些结果」。

⚠️ **但意图必须逐条保住**。例如某条原本断言
「工具调用的原文不出现在 agent 叙述里」——
新样本里必须**仍然存在**一次工具调用,否则这条用例就名存实亡了。

**逐条检查:新样本是否仍然覆盖该用例要验的那个现象。**
不覆盖的,**说明并另想办法**(例如设计探针任务时特意触发它),
**不要留一条什么都没验到的绿用例**。

### R3. 脱敏(与前一票同口径)

- 真实路径(`C:\Users\echo\…`、JSONL 的 `cwd`);
- 主机名、局域网 IP;
- token / API key;
- 采样时的仓库内容片段。

**脱敏不得改变被断言的结构。** 若某处脱敏会破坏断言,停下来说明。

### R4. 截取要保持行完整

JSONL **不得**截出半行。样本大小控制在够用即可,
在汇报里给出**新增样本总字节数**。

### R5. 6 条 skip 全部恢复

`it.skipIf` 与 `[需本地样本]` 标记应当消失(或至少这 6 条不再命中跳过条件)。

⚠️ **不要保留「本机有样本才跑」的条件** —— 样本入库后它就是无条件该跑的。
若你判断某条确实不该无条件跑,说明理由。

## 4. 验收标准

**基线先用工具取**:

```
node scripts/test-baseline.mjs packages/backend/server test/output-parser.test.ts test/token-usage.test.ts
```

**取数基准(检视者 2026-09-08 20:21 实测)**:
`1 failed | 125 passed (132)`,其中 **6 skipped**。

1. **核心:skipped 归零**(那 6 条),且**全部通过**。
   贴出改前改后两行基线,**明确写出 skipped 数从 6 变成 0**。
2. **意图逐条保住**(R2):对这 6 条,逐条说明
   「它要验的现象是什么」「新样本里它在哪」。
   ⚠️ 这是本票最有价值的部分,也是最容易糊弄的部分。
3. **脱敏自查**:样本里
   `grep -inE 'C:\\\\Users|/Users/|api[_-]?key|token[=:]|sk-'` 无真实值命中。
4. **不依赖 `.scratch/`**:`grep -rn '\.scratch' <两个测试文件>` 为空。
5. **零生产代码改动**:`git show --stat` 无 `packages/backend/server/src/**`。**硬约束。**
6. **探针任务无副作用**(R1):说明你跑的是什么,以及它没改动仓库。
7. **新增样本总字节数**写进汇报。
8. `npx tsc --noEmit -p tsconfig.json` 通过。

## 5. 不涉及的改动

- 不改生产代码、解析器实现、`.gitignore`。
- **不放宽或删除断言**(R2:重新锁定 ≠ 放宽)。
- 不修那条 CRLF 红(另票:
  [fixture-line-endings-break-on-windows.md](fixture-line-endings-break-on-windows.md))。
- 不修 CI(V1 另票)。

## 6. 兼容性

- 纯测试改动,无生产行为变更。
- 仓库体积增加,需给出字节数(§4.7)。
