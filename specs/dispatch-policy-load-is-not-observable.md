# Spec: 调度策略读没读到不可观测,静默回落让人以为配置生效了

> **状态**: **Landed**(2026-09-11)
> **版本**: 1.0
> **日期**: 2026-09-08(落地 2026-09-11)
>
> ## ✅ 2026-09-11 落地记录
>
> - **R1**:`readDispatchPolicy()` 解析成功打 `console.log` 记下绝对路径与
>   路径来源;读不到打 **`console.warn`**(比正常读到更显眼,因为「跑在兜底
>   默认上」通常是意外),文案里连带写出后果:`maxRetries=1`、瞬时退避未启用。
>   **不报错、不阻断启动** —— 回落语义逐字未动。
> - **R2**:`/api/health` 新增 `dispatchPolicy: { origin, effective }`。
>   取值一律走 `state.ts` 的 live getter,**不在端点里重读文件** —— 重读报的是
>   「文件里写了什么」,而这里要答的是「进程现在按什么在跑」;策略在 state.ts
>   模块加载时读一次并缓存,cwd 变化或文件被改后两者就会不一致。
> - **R3**:判据只在 `resolveDispatchPolicyFile()`,它现在返回
>   `{ path, resolvedFrom }`;`readDispatchPolicy()` 据此记 `lastPolicyOrigin`,
>   日志与端点都从 `getDispatchPolicyOrigin()` 取,没有第二处判定。
> - **额外收紧(票面没写但有必要)**:判据是**解析成功**而非「文件存在」。
>   一份坏 JSON 会走 catch 回落到默认值,若按「文件在不在」判,端点就会报着
>   `file` 却跑着默认值 —— **比没有这个字段更误导**。已补用例覆盖。
> - **未透出 `rateLimit.detectPatterns`**:它没有 live getter,且生效值是
>   「文件里的 ∪ 代码内置默认」的并集,单看哪一边都不代表实际判据。理由写在
>   `runtime-health.ts` 的注释里,要查它得另立一条。
>
> **验证**:`dispatch-policy.test.ts` 35 passed(新增 4 条:cwd 读到 / env
> 覆盖 / 真造出读不到 / 坏 JSON);`health.test.ts` 8 passed(新增 1 条断端点
> 形状与不夹带无关配置);受影响 6 个文件合跑 73 passed。
> `turbo run check-types` 与 `biome check .` 均通过。
>
> 顺带留个证据:跑测试时打出的第一条告警是
> `读不到 …\packages\backend\server\scripts\dispatch-policy.json(路径来自
> process.cwd())` —— 正是 §1.1 表格里「从包目录起就读不到」那一行,
> **现在它能被看见了**。
>
> ⚠️ **角色说明**:平台 server 未运行,下发通道不通,本票由检视者实现 ——
> 角色合并,只有单层复核,缺少独立的 L2/L3。
> **来源**: [restore-ci-green-and-resume-pushing.md](restore-ci-green-and-resume-pushing.md)
> 的 L3 中,执行者在排查超时根因时**顺带发现**并列入「还差什么」清单第 5 条;
> 检视者复核后认为成立、值得独立成票。

## 1. 背景与目标

### 1.1 现状证据(检视者已复核)

`packages/backend/server/src/lib/executors.ts:691`:

```ts
function resolveDispatchPolicyFile(): string {
  return (
    process.env.COAGENTHUB_DISPATCH_POLICY_FILE ??
    resolve(process.cwd(), "scripts/dispatch-policy.json")
  );
}
```

**路径相对于 `process.cwd()`。**

| 起法 | 结果 |
|---|---|
| 本机 `start.ps1`(`-WorkingDirectory` = 仓库根) | ✅ 读得到 |
| `cd packages/backend/server && node dist/server.mjs`(很自然的起法) | ❌ 读不到 |

### 1.2 ⚠️ 这**不是**缺陷,回落是有意的

`executors.ts:680` 附近的注释写得很清楚:

> 缺省策略(配置文件不可读时的兜底)不启用瞬时退避:两个键都为 null →
> 所有额度失败按 exhausted 处理,与瞬时分级落地前的行为一致(fail-safe)。

**回落方向是保守的,设计是对的。** 而且有 `COAGENTHUB_DISPATCH_POLICY_FILE`
可以显式覆盖。**本票不改这个设计。**

### 1.3 真正的问题:读没读到,从外面看不出来

系统跑起来之后,**没有任何办法知道**当前用的是文件里的策略还是兜底默认值。

后果不是「配置错了」,而是**排障时会被误导**:

- 有人配了 `maxRetries: 3`,看到只重试 1 次,会去怀疑重试逻辑 ——
  而真实原因可能只是 cwd 不对;
- 反过来,有人以为在跑保守兜底,实际读到了一份旧配置。

⚠️ **今晚就有一次实例**:V1 的执行者在排查测试超时时,
一度需要判断「生产是不是一直在用默认 `maxRetries=1`」——
它**没法从系统里查到答案**,只能读代码推断。

### 1.4 目标

**让「策略从哪来、有没有读到」成为可观测的事实。**

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/backend/server/src/lib/executors.ts` | 加载时留下可见记录 |
| 可能的健康端点(`routes/runtime-health.ts`) | 透出当前生效策略与来源 |
| 对应测试 | 新增用例 |

**不改**:回落语义(§1.2,fail-safe 是对的);
`COAGENTHUB_DISPATCH_POLICY_FILE` 覆盖机制;
`dispatch-policy.json` 的字段与取值;重试/冷却/并发的任何行为。

## 3. 详细改动

### R1. 启动时留下一条可见记录

至少要能回答:**用的是哪个路径的文件,还是兜底默认**。

⚠️ **读不到时不要报错、不要拒绝启动** —— 回落是有意设计的(§1.2)。
这里要的是**可见**,不是**阻断**。

日志级别自选,但「用了兜底默认」这件事应当比「正常读到」更显眼 ——
它更可能是意外。

### R2. 运行时可查

`routes/runtime-health.ts` 已有健康端点。把**当前生效的策略**与
**它的来源**(文件绝对路径 / env 覆盖 / 兜底默认)透出去。

理由:日志会滚掉,而排障往往发生在几小时之后。
**能直接查当前状态,比翻日志可靠。**

⚠️ 透出的是策略取值与来源路径,**不要连带透出无关的环境变量或配置**。

### R3. 判据只有一处

「策略从哪来」的判定**只在 `resolveDispatchPolicyFile` 一处**。
R1 的日志与 R2 的端点都从它取,**不要各自再判一次**
(ADR-0009:同一事实只有一个判定出处)。

## 4. 验收标准

**基线先用工具取**(受影响文件自行判断,清单写进汇报):

```
node scripts/test-baseline.mjs packages/backend/server <受影响的测试文件...>
```

1. **读到文件时**:记录/端点显示**该文件的绝对路径**,策略取值与文件内容一致。
2. **读不到时**:记录/端点显示**「兜底默认」**,且
   **server 正常启动**(不报错、不拒绝启动)。
   ⚠️ 这条要真构造出「读不到」的场景(例如换 cwd 或指向不存在的路径),
   不能只测正常路径。
3. **env 覆盖时**:显示来源是 env 覆盖及其路径。
4. **回落语义未变**:读不到时 `transientBackoffSeconds` /
   `transientEscalationLimit` 仍为 `null`,额度失败仍按 `exhausted` 处理(回归)。
5. **判据单一出处**(R3):说明日志与端点都从哪里取的。
6. **不透出无关配置**(R2):说明端点返回了什么、为什么只有这些。
7. 定向测试前后对照,失败数不增加。
8. `npx tsc --noEmit -p tsconfig.json` 通过。

## 5. 不涉及的改动

- **不改回落语义**、不改 `dispatch-policy.json` 的字段与取值;
- **不把「读不到」变成错误或启动失败**(§1.2);
- 不改重试 / 冷却 / 并发的任何行为;
- 不改 `COAGENTHUB_DISPATCH_POLICY_FILE` 覆盖机制;
- **不顺手把路径改成相对模块位置** —— 那是行为变更,会让现有部署的解析结果
  改变。若你认为该改,**停下来报告,另立票**。

## 6. 兼容性

- 无 schema 变更,无行为变更(只加可观测性)。
- 健康端点若新增字段,说明是否有消费方依赖其形状。
