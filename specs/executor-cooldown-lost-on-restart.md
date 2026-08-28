# Spec: 额度冷却只存内存,重启即失忆

> **状态**: Landed — L3 通过(2026-08-28),实现 `346752e0` + `34a1394e`
> **版本**: 1.0
> **日期**: 2026-08-28

## 现象

`lib/executor-task/state.ts:78` 的冷却状态是进程内 `Map`:

```ts
export const executorCooldowns = new Map<string, number>();
export const cooldownTimers = new Map<string, NodeJS.Timeout>();
```

后端一重启,所有额度冷却记录**全部丢失**。

实测时间线(2026-08-28):

```
19:21  AtomCode / CodeBuddy 因 usage limit 进入冷却,预计 23:44 / 00:01 恢复
19:2x  检视者按规程 build + restart  → executorCooldowns 清空
20:00  任务 01a0483e 创建(明确授权走两层)
20:14  结案 → 平台判定「有可用执行器」→ 不写 degradedToTwoParty
```

`executor-availability.ts` 的判定逻辑**本身正确**(遍历 executor 角色成员、
跳过协调者自身、`isInCooldown` 命中则记不可用),
错的是它依据的冷却状态**已经不存在了**。

## ⚠️ 危害有两层

1. **降级留痕丢失** —— `dispatching-should-be-the-default` R4 要求平台记录
   `degradedToTwoParty`,重启后判定失真,该写的不写
2. **熔断被削弱** —— `quota-exhaustion-triggers-infinite-retry`(`df8bf8b1`)
   刚落地的额度冷却,重启一次就失忆,平台会再次去撞已耗尽的执行器。
   ⚠️ 而**每张票落地后都要重启**(既定规程),所以这不是罕见路径,是常态

## 要做的

### R1 — 冷却状态持久化

冷却到期时刻需在进程重启后仍然有效。
⚠️ **优先复用既有存储**,不新建表:
可考虑写入 `executor_config` 行、或复用既有的 participant/任务侧字段。
若确需新增存储,须在汇报中说明为何无法复用。

### R2 — 重启后恢复未到期的冷却

服务启动时读回未到期的冷却记录,并重建对应的到期定时器
(`cooldownTimers` 的等价物)。
⚠️ 已过期的记录不得复活,启动时应清理。

### R3 — ⚠️ 不改判定逻辑

`executor-availability.ts` 与 `isInCooldown` / `cooldownEndMs` 的
**判定语义逐字不变** —— 它们没判错,错的是数据丢了。
本票只解决「状态活不过重启」。

### R4 — ⚠️ 不改熔断阈值与识别规则

`quota-exhaustion` 票落地的额度识别、冷却时长、重派熔断阈值
一律不动(回归,必测)。

### R5 — 时钟与时区

冷却到期时刻须以绝对时间存储(epoch ms 或带时区的时间戳),
⚠️ 不得存「剩余分钟数」——重启后无法还原。

## 验收要点

- 让某执行器进入冷却 → **重启后端** → 验证该执行器**仍处于冷却**
  且到期时刻不变(核心场景,必测,贴出重启前后对照)
- 已过期的冷却记录在启动时被清理,不复活(R2,必测)
- 冷却期内 `executor-availability` 判定其不可用,
  零执行子任务结案时写入 `degradedToTwoParty`(R1 的下游效果,必测)
- `isInCooldown` / `cooldownEndMs` 的判定语义未改动(R3,回归必测)
- 额度识别、冷却时长、重派熔断阈值未改动(R4,回归必测)
- 测试全绿,贴出用例数;**基线 805**

## 注意

⚠️ 本票**必须下发给执行器**完成,**不限定是哪一个**;
   若执行器全部冷却,**允许协调者降级两层兼任**(平台判定 + 留痕)。
⚠️ specHash 不是 commit,汇报时不要混用。
⚠️ 提交前 `git status --porcelain` 并**看第一列**:第一列有标记的文件会被
   `git commit` 一并带走;只提交本票产物,可用 `git commit -m "…" -- <路径>` 限定。
⚠️ 做完记得提交。
