# Spec: 任务标 failed 却没有原因

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-23

## 现象(实测)

协调者把批次任务 `01a02ded-9f8e-76db-b467-c519d8e97454` PATCH 为 `failed`,
并且**在群里和 stdout 里都写清了阻塞原因**:

> 第 3 张因唯一可用 AtomCode 执行器触发 rate limit(约 22:33 重置)未实现;
> 第 4、5 张依赖未下发。已 PATCH detached 任务为 `failed`,记录阻塞原因。

但库里:

```
status: failed
diff_summary->>'error':  (无)
```

检视者的失败监听器因此只能报出 `FAILED-TASK <id>|?` —— **那个 `?` 就是这个洞**。

## 为什么这是真问题

- **原因只活在内存里**。stdout 缓冲随后端重启即失;界面、监听器、任何自动化
  看到的都只是"失败了"
- 这与本轮已修的两个问题同源:`server-restart` 掩盖真实原因、
  `outputTail` 只在完成路径回填。**平台反复出现「知道原因却不落地」**
- 协调者做得没错——它写了原因,只是**平台没有让它落到该落的字段上**

## 判断原则

**终态是有代价的状态转换,不该比创建任务更随意。**
任务从 running 变成 failed 会中断整条链路、触发检视者的告警、进入审计记录,
而当前平台接受一个不带任何解释的 failed。

---

## 要求

### R1. PATCH 到 failed 时应携带原因

- `PATCH /api/groups/:id/tasks/:taskId` 把 `status` 改为 `failed` 时,
  应要求 `diffSummary` 里带上失败原因(字段名沿用现有的 `error`)
- **拒绝还是警告,自行判断并在汇报里说明理由**。可考虑的方向:
  - 硬性要求(400):最严,但可能打断现有调用方
  - 接受但补一个明确的占位原因(如 `unspecified`)+ 产生警告
  - 只警告
- ⚠️ **无论选哪种,平台自身的失败路径(如 `recoverInterruptedTasks` 写的
  `server-restart`)必须继续工作**,不能因为新校验而写不进去

### R2. 不要只堵 PATCH 这一个入口

`failed` 还可能由平台内部路径写入(`failTask` / `handleFailure` /
`recoverInterruptedTasks`)。这些路径**本来就带 reason**,本票不改它们,
但要确认新逻辑不会误伤。

### R3. `cancelled` 同样处理

用户主动停止产生的 `cancelled` 也应留下"谁停的、为什么"。
若判定 `cancelled` 与 `failed` 语义差别大、不该同等要求,
**在汇报里说明并只做 `failed`**。

---

## 验收标准

- [ ] PATCH 到 `failed` 且无原因时,产生可见后果(拒绝或警告,方案已说明)
- [ ] 带原因时正常通过
- [ ] **平台内部失败路径不受影响**:`server-restart` 等仍能正常写入
- [ ] `cancelled` 的处理方式已明确(同等要求 / 仅 failed,理由已说明)
- [ ] 新增测试覆盖:PATCH failed 带原因、不带原因、平台内部路径不受影响
- [ ] `pnpm --filter server test` 退出码 0,用例数不减

## 不涉及

- **不改**前端
- **不改**平台内部失败路径写入的 reason 内容
- **不做**失败原因的分类枚举(自由文本即可;强行枚举会逼调用方硬套)
- 不引入新依赖

## 执行环境提示

- 本仓是 **pnpm** 项目
- 后端以 `pnpm --filter server start`(无 watch)运行:改完需 build + restart
- ⚠️ **重启前确认无在途任务**
