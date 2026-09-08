# Spec: 限流恢复时刻按 server 本地时区解释,a2a 跨时区会整点偏移

> **状态**: Frozen —— **第一批已实现(`1b428c7e`),但未收口**,见下方 v1.1 修订
> **版本**: 1.1
>
> **v1.1 修订(2026-09-08,检视者在 L3 中发现并更正)**:
> **§2 的改动范围写漏了。** 原文只列 `test/executor-quota-redispatch.test.ts`,
> 但 `parseRateLimitRecoveryMs` **另有两个文件在测它**:
>
> | 文件 | 引用数 | 第一批是否同步 |
> |---|---|---|
> | `test/executor-quota-redispatch.test.ts` | 22 | ✅ 已同步 |
> | `test/executor-progress.test.ts` | 10 | ❌ **漏** |
> | `test/dispatch-policy.test.ts` | 6 | ❌ **漏** |
>
> 后果(检视者实测,同一清单前后对照):
> `1 failed | 86 passed (87)` → **`11 failed | 76 passed (87)`,多 10 条红**。
>
> 典型失败:
> `parseRateLimitRecoveryMs > resets around HH:MM → 今天该时刻(未过)`
> 报 `expected null to be 1786685580000` —— 它们编码的是**旧契约**。
>
> **这是检视者写 spec 的失误,不是执行者的问题** ——
> 执行者严格按 §2 执行,并且**主动自曝了这个风险**
> (「相关用例在本票未改文件里,定向清单外可能转红」),做法正确。
> §4 新增第 7 条收口标准。
>
> **日期**: 2026-09-08
> **来源**: `docs/implementation-optimization-review-2026-09-07.md` §13.4 **R11**
> **性质**: **真实缺陷,不只是测试的时区脆弱性** ——
> 测试在 UTC 环境下失败只是它的第一次显形。
> **关系**: R 类新增项,独立于 R1–R10,**不并入 R8**(配置与能力一致)。

## 1. 背景与目标

### 1.1 现状证据(检视者已复核代码)

`packages/backend/server/src/lib/executors.ts` 的 `parseRateLimitRecoveryMs`:

| 分支 | 行 | 时区处理 |
|---|---|---|
| 绝对时刻带 `UTC±X` | 126–134 | ✅ **正确**,显式换算 |
| 绝对时刻不带时区 | 134 | `new Date(y,m,d,…)` 本地时区 |
| `resets around HH:MM` | 140–147(`setHours` 在 143) | ❌ `new Date(now)` + `setHours()` |
| `try again at HH:MM AM/PM` | 150–162(`setHours` 在 158) | ❌ 同上 |
| `try again in N seconds` / 相对时长 | — | ✅ 与时区无关,**不受影响** |

两条**纯时钟**分支把收到的时钟按**server 进程的本地时区**解释。

CI 失败日志:`test/executor-quota-redispatch.test.ts >
parseRateLimitRecoveryMs: try again at HH:MM` 断言差值
`1786816990000 − 1786788190000 = 28,800,000 ms`,**正好 8 小时**,
即 Asia/Shanghai 与 UTC 之差。同文件另有两条断言呈同样差值。

### 1.2 危害:分开看两种执行器

- **cli 执行器**:与 server 同机同时区,本地时区解释**恰好正确**,当前无实际故障。
- **a2a 执行器**:`packages/backend/server/src/lib/a2a-runner.ts` 的目标是**远端主机**
  (注释举例 Windows 192.168.31.180)。远端 provider 输出的
  「resets around 7:50 PM」是**远端/供应方**的时钟,却被 server 按**自己的**时区解释。

跨时区时冷却结束时间**偏移整数小时**:

- **偏早** → 冷却形同虚设,很快再次撞限流;
- **偏晚** → 该执行器被无谓停派**最多数小时**。

这与 §11.2 表里「默认额度冷却 300 分钟」是同一量级的等待,
但成因是**解析错误**而非策略。

### 1.3 目标

**把「这个时钟属于谁的时区」变成显式契约,而不是隐式默认。**

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/backend/server/src/lib/executors.ts` | `parseRateLimitRecoveryMs` 的纯时钟分支 |
| `packages/backend/server/test/executor-quota-redispatch.test.ts` | 断言显式设定时区 |
| **`packages/backend/server/test/executor-progress.test.ts`**(v1.1 补) | 同步纯时钟用例的期望 |
| **`packages/backend/server/test/dispatch-policy.test.ts`**(v1.1 补) | 同上 |
| **`packages/backend/server/test/orphan-task-reconciler.test.ts`**(v1.1 补) | 若受分类口径变化影响则同步 |
| 可能涉及的落库路径测试 | 见 §4 验收 3 |

⚠️ **v1.1 教训**:改一个被多处引用的纯函数时,
**先 `grep -rl <函数名> test/` 把测它的文件全找出来**,再定改动范围。
本票第一批就是因为漏了这一步而留下 10 条红。

**不改**:带 `UTC±X` 的绝对时刻分支(它是对的);
`try again in N seconds` 与相对时长分支(与时区无关);
`state.ts` 的额度判定取向;冷却策略与默认冷却时长;a2a 传输实现。

## 3. 详细改动

### R1. 采用方案 (a):纯时钟分支要求同行有时区标记

报告给了三个方案,**本票指定 (a)**:

> 纯时钟分支要求同一行存在时区标记,否则**不视为可解析的恢复时刻**,
> 回落到既有的固定冷却兜底。

理由:

1. **不新增配置面**(方案 b 要给执行器配置加时区字段);
2. **失败方向是保守的** —— 拿不准就用固定冷却,不会偏早导致立刻再撞限流;
3. 与 `state.ts` 中「**没有正面证据一律不判额度**」的既有取向一致。

⚠️ 若你在实现中发现 (a) 有本 spec 未预见的问题,**停下来报告**,
不要自行改用 (b) 或 (c)。

### R2. 「时区标记」的判据要写清楚

在代码注释里写明**什么算时区标记**(至少覆盖 `UTC±X`;是否接受
`Z` / `GMT±X` / 具名时区缩写由你定,但**要在注释和汇报里说明取舍**)。

判据要**只有一处出处** —— 不要在两条纯时钟分支里各写一套判定。

### R3. 回落行为必须与既有兜底一致

「不视为可解析」意味着走**既有**的固定冷却路径,
**不是**返回 0、不是抛异常、不是自造一个新的兜底时长。
在汇报里写明回落后实际用的是哪条既有路径。

### R4. 测试不得依赖运行机器的时区

所有相关用例**显式设定时区**(`TZ=` 或注入时钟),
不依赖机器恰好是 UTC+8。

## 4. 验收标准

**基线先用工具取**:

```
node scripts/test-baseline.mjs packages/backend/server test/executor-quota-redispatch.test.ts
```

1. **三时区一致(核心)**:在 `TZ=UTC`、`TZ=Asia/Shanghai`、
   `TZ=America/Los_Angeles` 三种环境下,`parseRateLimitRecoveryMs` 的用例结果
   **完全一致**。三次都贴出来。
   ⚠️ **改动前必须能复现不一致** —— 给出改前在 `TZ=UTC` 下的实际报错
   (期望差值 28,800,000 ms 那条)。
2. **带时区标记的仍然正确解析**(回归):`UTC±X` 分支行为逐字不变。
3. **走到落库字段,不能只断言函数返回值**(§8 要求):
   构造一次 a2a 执行器返回**纯时钟**恢复提示的场景,
   读取落库的 `executorCooldownEndMs`,断言它与 R3 的回落口径相符。
4. **相对时长分支不受影响**(回归):`try again in N seconds` 等用例保持原状态。
5. 定向测试前后对照,**失败数不增加**。
6. `npx tsc --noEmit -p tsconfig.json` 通过。
7. **(v1.1 新增,全票收口条件)跨文件期望同步**。
   基线清单必须覆盖**所有**测 `parseRateLimitRecoveryMs` 的文件:

   ```
   node scripts/test-baseline.mjs packages/backend/server \
     test/executor-quota-redispatch.test.ts test/executor-progress.test.ts \
     test/dispatch-policy.test.ts test/orphan-task-reconciler.test.ts
   ```

   **取数基准(检视者 2026-09-08 19:28 实测)**:
   后三个文件在第一批**之前**是 `1 failed | 86 passed (87)`,
   **之后**是 `11 failed | 76 passed (87)`。
   收口口径:**回到 1 failed**(那 1 条是既有的超时红,与本票无关)。

   ⚠️ 同步的是**期望文本**,不是测试意图。
   这些用例原本断言「纯时钟能解析出时刻」——新契约下它应当返回 `null`
   并回落固定冷却。**按新契约改写期望是正确的**;
   但若某条用例的意图是别的(例如测分类而非解析),
   **不要顺手改它** —— 逐条说明你怎么判断的。

## 5. 不涉及的改动

- **不改带 `UTC±X` 的绝对分支**、不改相对时长分支。
- **不新增执行器配置字段**(那是方案 b,本票不采用)。
- 不改冷却策略、默认冷却时长、`state.ts` 的额度判定取向。
- 不改 a2a 传输实现。
- 不修 CI 本身(V1 另票)。

## 6. 兼容性

- 无 schema 变更,无迁移。
- **行为变更(需写明)**:此前纯时钟提示会得到一个(可能错误的)精确恢复时刻,
  现在无时区标记时回落到固定冷却。
  对 cli 执行器这是从「恰好正确」变成「保守兜底」——
  **在汇报里明确说明这个代价**,并说明为什么仍然值得
  (正确性优先于恰好正确;a2a 路径上的偏移是真实故障)。
