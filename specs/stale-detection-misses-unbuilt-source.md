# Spec: 陈旧检测看不见「源码改了但没重建」

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-25
> **补充**: `stale-runtime-detection`(`0e055cf3`)—— 那张票的判据有意从简,本票补它明确排除的那一半

## 背景:检视者差点又一次在旧代码上验收

`stale-runtime-detection` 的判据是:

```
陈旧 ⟺ dist 入口 mtime > 进程启动时刻
```

它回答的是「**进程是不是在跑当前的 dist**」。今天出现这样一幕:

```
后端启动     17:34:01
dist 建于    17:33:59      → stale: false(判定正确)
最新提交     18:59:01      → 源码已改,但 dist 从未重建
```

`stale: false` **是对的** —— 进程确实在跑当前 dist。但**运行的后端不含最新提交的
代码**,而检视者正准备在它上面验收 token 采集功能。

**两种陈旧,只覆盖了一种:**

| 情形 | 现有判据 |
|---|---|
| dist 重建了、进程没重启 | ✅ 能发现 |
| **源码改了、dist 没重建** | ❌ **看不见** |

### 为什么原 spec 排除了这一半

`stale-runtime-detection` R1 明确写过:

> 不做「源码比 dist 新」的检查 —— 那需要遍历,代价与收益不匹配,
> 且本轮三次事故全是本条能覆盖的情形

**当时的判断在当时是对的**(那三次确实都是「没重启」)。但此后又发生了「改了源码
没 build」的情形,收益侧变了。

## 决策:补上这一半,但保持低成本

### R1. 增加「构建落后于源码」的判定

```
构建陈旧 ⟺ 源码树中最新文件的 mtime > dist 入口 mtime
```

**关键约束:必须低成本。** 原 spec 拒绝它的理由是「需要遍历」,这个理由仍然成立
——所以:

- **只扫描会被打包进 dist 的源码目录**(`packages/backend/server/src/**`
  与其直接依赖的 workspace 包 `src/`),**不扫** `node_modules` / `test` / `dist`
- 结果**缓存**,默认 **10 秒**内不重复扫描(可配置)
- 扫描失败(权限、路径异常)→ **视为不陈旧**,不报错、不阻塞

若执行者评估后认为即使如此代价仍不可接受,**在汇报中给出实测数据**
(扫描耗时、文件数),并提出替代方案,**不要硬做**。

### R2. 两种陈旧要能区分

`GET /api/health` 与协调任务详情的 `runtime` 字段扩展为:

```json
{
  "startedAt": "...",
  "entryMtime": "...",
  "stale": true,                          // 任一为真
  "staleReason": "process" | "build" | "both" | null,
  "newestSourceMtime": "..."              // 仅在做了源码扫描时输出
}
```

- `process` —— dist 比进程新(原有语义,**行为不得改变**)
- `build` —— 源码比 dist 新(本票新增)
- `both` —— 两者都成立

⚠️ **`stale` 字段的既有含义不得收窄** —— 现有消费方(前端全局提示)依赖它,
它应当是「任一种陈旧」。

### R3. 前端提示要说清是哪一种

`observability-fields-in-ui` 落地的全局提示,文案按 `staleReason` 区分:

| reason | 提示 |
|---|---|
| `process` | 后端运行的不是最新构建 —— **重启后端**即可 |
| `build` | 后端构建落后于源码 —— **需重新 build 再重启** |
| `both` | 源码已改且未重建,运行的也不是当前构建 —— **build 后重启** |

**给出具体动作,不只说「陈旧」** —— 本轮多次出现「知道不对但不知道该干什么」。

### R4. 仍然只报不拦

与 `stale-runtime-detection` R4 一致:**不阻塞任何操作**,不自动 build、
不自动重启。

### R5. 不改这些

- **不改**原有 `process` 陈旧的判定逻辑与语义(R2)
- **不做**自动构建(R4)
- **不改** watch 模式相关结论(`no-manual-restart-in-dev`)

## 验收标准

- [ ] 改动 `src/**` 下任一文件但不 build → `stale: true`、`staleReason: "build"`
- [ ] build 后不重启 → `stale: true`、`staleReason: "process"`
- [ ] 两者同时成立 → `staleReason: "both"`
- [ ] 都不成立 → `stale: false`、`staleReason: null`
- [ ] **原有 `process` 判定行为逐字不变**(回归,必测)
- [ ] `stale` 仍为「任一种陈旧」,含义未收窄(回归,必测)
- [ ] 扫描**不含** `node_modules` / `test` / `dist`
- [ ] 扫描结果有缓存,连续请求不重复扫描
- [ ] 扫描失败视为不陈旧,不抛错
- [ ] 前端全局提示按 `staleReason` 给出**具体动作**
- [ ] 未新增自动 build / 自动重启
- [ ] 后端测试全绿,贴出用例数;若前端有改动,前端测试也全绿

## 不涉及

- 自动构建或热重载(R4)
- watch 模式(另有结论)
- 生产部署形态

## 执行环境提示

- 本仓 pnpm 项目,后端为**生产模式**
- 现有实现:`lib/runtime-status.ts`、`routes/runtime-health.ts`
- ⚠️ **不得停止或重启后端**;做完记得提交
