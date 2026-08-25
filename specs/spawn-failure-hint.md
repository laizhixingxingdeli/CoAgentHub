# Spec: spawn 失败只报原始错误串,看不出该怎么办

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-25
> **来源**: `stash@{0}` 一份未验证的历史半成品(「T3 codex 半成品:queue.ts 已 patch 未验证」)

## 背景

执行器 spawn 失败时,平台把底层错误串原样抛出:

```
❌ [codex] 任务失败: 无法启动 codex (unexpected argument '--ask-for-approval')
```

**这句话对着屏幕的人没有任何行动指引。** 本轮多次靠人眼猜错误含义:

- `unexpected argument` —— 实际是 codex CLI 升级后参数变了,要改 `executors.ts`
  的内置配置(本轮曾为此排查许久)
- `ENOENT` —— 执行器没装或不在 PATH
- `EACCES` —— 少可执行位

三类错误的处置方向完全不同,但**错误串本身不说**。

## 已有的半成品

`stash@{0}` 里有一份实现,**当初标注为「未验证」**,内容为:

```ts
export function spawnFailureHint(msg: string): string {
  if (/unexpected argument|unrecognized|cannot be used with|invalid value/i.test(msg))
    return ";执行器参数配置可能与当前 CLI 版本不匹配,请核对 executors.ts 中的内置配置";
  if (/ENOENT|command not found/i.test(msg))
    return ";执行器可能未安装或不在 PATH,请使用 which <bin> 确认或配置绝对路径";
  if (/EACCES|permission denied/i.test(msg))
    return ";执行器文件可能没有可执行权限,请检查可执行位";
  return "";
}
```

并接入两处:群内状态消息(`spawnFailureStatus`)与任务失败原因(`spawnFailureReason`)。

⚠️ **该实现从未被验证过**,不要直接 `git stash pop` 就当完成。**按本 spec 重做或
核验后再落地**,并补齐它缺失的测试。

## 要求

### R1. 三类错误各给可操作提示

| 错误特征 | 提示方向 |
|---|---|
| `unexpected argument` / `unrecognized` / `cannot be used with` / `invalid value` | CLI 参数与内置配置不匹配,核对 `executors.ts` |
| `ENOENT` / `command not found` | 未安装或不在 PATH |
| `EACCES` / `permission denied` | 缺可执行位 |
| 其余 | **返回空串**,不猜 |

⚠️ **无法归类时必须返回空串** —— 猜错方向比不给方向更糟,会把排查引到错误的路上。

### R2. 提示是追加,不是替换

原始错误串**必须完整保留**,提示追加在其后。

理由:提示是**推断**,原始错误是**事实**。丢掉事实只留推断,等于把一层猜测伪装成
结论 —— 本轮已多次因此走弯路。

### R3. 两个出口都要带上

- 群内状态消息(人看的)
- 任务 `errorReason` / 失败原因(agent 与排障时看的)

### R4. 纯函数可测

`spawnFailureHint` 必须是**不依赖任何外部状态的纯函数**,便于直接测各分支。

### R5. 不做这些

- **不改** spawn 逻辑本身、不改重试/冷却策略
- **不做**自动修复(如检测到 ENOENT 就自动找路径)—— 本票只给方向
- **不改** `executors.ts` 的内置配置

## 验收标准

- [ ] 四类输入(三类可识别 + 一类无法归类)各返回预期结果
- [ ] 无法归类时返回**空串**,不返回任何猜测
- [ ] 原始错误串在两个出口中都**完整保留**,提示为追加
- [ ] 群内状态消息含提示
- [ ] 任务失败原因含提示
- [ ] `spawnFailureHint` 为纯函数,有直接覆盖各分支的单测
- [ ] 大小写不敏感匹配(`ENOENT` / `enoent` 均命中)
- [ ] **未改动** spawn 逻辑、重试策略、`executors.ts`
- [ ] 后端测试全绿,贴出用例数

## 不涉及

- 自动修复(R5)
- 执行器配置内容
- 其它错误类型的扩充(本票只覆盖这三类已实际遇到的)

## 执行环境提示

- 本仓 pnpm 项目,后端为**生产模式**
- 参考实现在 `git stash show -p stash@{0}`,**未经验证,仅供参考**
- ⚠️ **不得停止或重启后端**;做完记得提交
