# Spec: 运行时陈旧时自动重建,不再依赖人工

> **状态**: Landed — L3 通过(2026-08-27),实现 `850b71c7`
> **版本**: 1.0
> **日期**: 2026-08-26

## 现象

每落地一票就必须有人手工 `build + restart`,否则下一票必然撞死锁:
执行器改了源码 → dist 落后 → 结案撞上旧构建里的守卫 → 任务 `failed`。

本轮实测:检视者手工重建 **4 次**,其中 `01a03e60` 就是因为守卫已在源码删除、
dist 未重建而失败。这类失败与实现质量无关,纯粹是构建滞后。

## 现有基础设施(已具备,不要重写)

- `scripts/coagenthub-prod.sh restart --build` —— 带构建的重启,已实现且幂等
- `scripts/coagenthub-watchdog.sh` —— 每 5 分钟巡检,不健康则 restart
- `GET /api/health` —— 返回 `stale` 与 `staleReason`(`build`/`process`/`both`)
- `runtime-status.ts` —— 已在扫源码树并缓存,`buildStale` 判据为
  「最新源码文件 mtime > dist/server.mjs mtime」

## 缺口

1. 看门狗只判「进程活不活」(`health_ok`),**不判构建新不新**
2. 看门狗第 45 行 `"$PROD_SCRIPT" restart` **不带 `--build`**,
   即使触发也修不好陈旧
3. cron 条目**根本没装**(`crontab -l` 无 coagenthub 条目)

## 要做的

### R1 — 看门狗把「构建陈旧」纳入巡检

`coagenthub-watchdog.sh` 的单次检查中,除现有健康判断外,再读
`/api/health` 的 `stale`/`staleReason`。当 `staleReason` 为 `build` 或 `both`
时,视为需要恢复。

⚠️ `staleReason` 为 `process` 时**不触发重建** —— 那是 entry 比进程启动新,
重启即可,不需要重新构建。

### R2 — 因陈旧触发的恢复必须带 `--build`

因 R1 判据触发时调用 `"$PROD_SCRIPT" restart --build`。
⚠️ 原有的「不健康」路径**保持现状**,仍调用不带 `--build` 的 `restart` ——
进程挂掉时重新构建只会拖慢恢复。两条路径分开,不要合并成一条。

### R3 — ⚠️ 必须防重建风暴

构建失败时 dist 不会更新,`stale` 仍为真,下一轮巡检会再次触发 ——
**这会变成每 5 分钟无限重建**。必须有退避:

- 连续失败达到阈值(建议 3 次)后停止自动重建,只记日志
- 一次成功的重建后计数归零
- 状态持久化到文件(看门狗是 `--once` 单次调用,内存态不跨调用)

### R4 — ⚠️ 不得在任务执行期间重建

重建会重启后端,正在跑的任务会失联。重建前必须确认**没有 running/queued 任务**;
有在途任务则跳过本轮,记日志,等下一轮。

### R5 — 安装 cron 条目

`cron-install` 已实现但从未执行。本票需实际安装并验证条目存在。
⚠️ 保持幂等,重复安装不得产生重复条目。

### R6 — ⚠️ 范围限制

不改 `runtime-status.ts` 的 `stale` 计算方式,不改 `coordinationCloseError`,
不动任何结案守卫。本票只动看门狗脚本与 cron 安装。

## 验收要点

- 制造陈旧(`touch` 一个源码文件)后跑 `coagenthub-watchdog.sh --once`,
  验证:检测到 `staleReason=build` → 执行带 `--build` 的 restart →
  再查 `/api/health` 的 `stale` 变为 `false`(贴出前后两次 health 输出)
- 有 running 任务时跑一次,验证**跳过**且记日志(R4)
- `staleReason=process` 时验证**不触发**重建(R1)
- 模拟构建失败,验证连续 3 次后停止重试(R3,贴日志)
- `crontab -l` 能看到条目;重复跑 `cron-install` 条目数不变(R5)
- 测试全绿,贴出用例数;**基线 694**

## 注意

⚠️ 本票**必须下发给执行器**完成。
⚠️ 结案若被守卫拒绝,如实回报拒绝原文,**不要自行重启后端,也不要以 failed 收场**。
⚠️ 做完记得提交。
