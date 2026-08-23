# Spec: 一次失败的启动尝试会摧毁健康实例的任务状态

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-23
> **严重性**: 高 —— 它会伪装成 `server-restart`,掩盖真实原因

## 现象

2026-08-23 12:59:20,协调者那条 detached 任务被标成 `failed / server-restart`。
**但后端根本没有重启**——同一个进程从 12:21:55 一直跑到现在,`ps` 可证。

## 根因:清理跑在绑定端口之前

`packages/backend/server/src/index.ts` 的启动顺序:

```
152  await assertNoPendingMigrations(db)
157  await recoverInterruptedTasks(db)   ← 把 DB 里所有 queued/running 任务标 failed
173  serve({ port })                     ← 到这里才尝试绑定端口
```

于是当**第二个实例**被启动时(协调者为验证后端改动而重启是常规操作):

1. 迁移检查通过
2. **`recoverInterruptedTasks` 把健康实例正在跑的任务全部标成 `failed`**
3. 绑定 3001 → `EADDRINUSE` → 进程崩溃退出

**净效果:一个注定失败、一秒都没服务过的进程,摧毁了健康实例的全部任务状态。**

`recoverInterruptedTasks` 的意图是对的(队列在内存里,重启后 DB 里的 running 是孤儿),
问题只在**它在还不知道自己能不能成为那个 server 之前就动手了**。

## 为什么危害被低估

失败标记写的是 `server-restart`——**看起来像一次正常的重启兜底**。
本次若不是我核对了进程启动时间,会被当成"又一次重启"放过去。

它每次都会伪装成同一个原因,掩盖真实故障。

---

## 要求

### R1. 先确保自己是唯一实例,再做清理

`recoverInterruptedTasks` 必须发生在**确认本进程真正持有服务端口之后**。

- 具体做法自行判断并**在汇报里说明**。可考虑的方向:
  - 把 `recoverInterruptedTasks` 挪到 `serve()` 成功回调之后
  - 或先尝试绑定端口、成功后再执行清理
- ⚠️ 注意 `serve()` 的回调时机与错误处理:`EADDRINUSE` 是否会走回调、
  会不会在回调后才抛,要**实际验证**,不要假设

### R2. 绑定失败要清晰报错

当前绑定失败的表现是进程崩溃。改完之后:

- 端口被占用时给出**明确信息**(端口号 + 可能已有实例在跑),而不是裸栈
- 此时**不得**执行任何写 DB 的清理动作

### R3. 不要改变清理逻辑本身

`recoverInterruptedTasks` 的范围判定(只回收 `executor_key` 非空的任务)
有其理由,注释已写明(避免与桥双跑)。**只改调用时机,不改判定范围。**

---

## 验收标准

- [ ] 第二个实例在端口被占用时**不会**修改任何任务状态
- [ ] 健康实例的 running 任务在一次失败启动尝试后**保持 running**
- [ ] 端口占用时报错清晰,含端口号
- [ ] 正常启动(端口空闲)时清理照常执行,行为不变
- [ ] `recoverInterruptedTasks` 的判定范围未改动
- [ ] 新增测试覆盖:端口被占用时不清理、正常启动时清理照常
- [ ] `pnpm --filter server test` 退出码 0,用例数不减(当前 425)

## 不涉及

- **不改** `recoverInterruptedTasks` 的判定范围
- **不改**迁移守卫(`assertNoPendingMigrations`,它在清理之前是对的——
  schema 不对时本来就不该做任何事)
- **不做**多实例协同/选主(平台是 LAN 单机部署,不需要)
- 不引入新依赖

## 执行环境提示

- 本仓是 **pnpm** 项目
- 后端以 `pnpm --filter server start`(无 watch)在 3001 运行中
- **复现方式**:后端跑着时再启一个实例,观察 DB 里 running 任务是否被标 failed
  —— ⚠️ **不要在有真实在途任务时复现**,会破坏协调链路。用测试或空闲时段验证
