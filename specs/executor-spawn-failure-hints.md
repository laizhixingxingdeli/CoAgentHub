# Spec: 执行器启动失败时给出可操作的提示

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-22
> **协作模式**: 两层（协调者兼任写 spec，spec v3.8 §3.14）

## 背景（实测踩出来的，不是设想）

内置 codex 执行器的调用参数与实际 CLI 已经漂移：

```
executors.ts 原配置：exec --sandbox workspace-write --ask-for-approval never --ephemeral {ticket}
codex-cli 0.149.0：  exec --approve-for-me --ephemeral {ticket}
```

`--ask-for-approval` 在当前版本已不存在，且 `--approve-for-me` 自带 workspace-write
沙箱、**不能再叠 `--sandbox`**（叠了报 `cannot be used with`）。该配置已在本 spec 之外
单独修正，但**暴露出的问题不止于此**。

用户当前看到的失败提示是：

```
❌ [codex] 任务失败: 无法启动 codex (unexpected argument '--ask-for-approval' found)
```

**问题不在信息量，在指错方向**：用户读到「无法启动 codex」会去查 codex 装没装、PATH 对不对、
权限够不够——而真正的原因是**平台侧的参数配置过时了**，这条线索一个字都没给。

这类失败有个共同特征：**只有真正 spawn 的那一刻才暴露**。CLI 升级了，平台侧配置无人同步，
配置静默腐化，直到某次下发才炸。参数漂移会反复发生（每次 CLI 升级都可能），
所以值得把「失败时指对方向」做成常设能力，而不是每次靠人去猜。

## 改动范围

`packages/backend/server/src/lib/executor-task/queue.ts` 有两处相同的失败提示
（约 903 行与 1130 行）：

```ts
`❌ [${ex.label}] 任务失败: 无法启动 ${ex.bin} (${msg})`
```

按 spawn 失败的类型分流，追加**可操作**的提示。两处都要改，抽成共用函数，不要复制两份。

### 分流规则

| 失败类型 | 提示方向 |
|---|---|
| **参数不被识别** | 指向**参数配置与 CLI 版本不匹配**，让用户核对该执行器的 args 配置 |
| **命令找不到**（ENOENT / command not found） | 指向**未安装或不在 PATH**，建议 `which <bin>` 或填绝对路径 |
| **权限**（EACCES / permission denied） | 指向可执行位 |
| 其他 | 保持现状，原样透出 `msg` |

⚠️ **实际错误串必须自行核实**，不要照抄上表——不同 CLI（codex / atomcode / codebuddy）
的报错措辞不同。至少覆盖 codex 的真实情况：`unexpected argument '--ask-for-approval' found`
与 `the argument '--sandbox <SANDBOX_MODE>' cannot be used with '--approve-for-me'`
（两条都是本次实测原文）。

### 提示落点

- 群消息（`postStatus`）——用户最可能看到的地方
- `failTask` 的 reason——任务详情里可见

### 关于 env 覆盖

`applyEnvOverrides` 已有 `EXECUTOR_BIN_<KEY>`。**args 有没有对应的覆盖机制需要先查**；
有就在提示里给出，没有就**不要提**——让用户去设一个不存在的环境变量，比不提示更糟。

## 明确不做

- **不做**启动时对所有执行器做 `--help` 探测。评估后否决：每次启动 spawn 一遍所有 CLI，
  慢、吵，且各家 `--help` 的退出码与输出格式不一，判断规则脆弱。
  **失败时指对方向，比启动时预检划算。**
- **不改**任何执行器的 args 本身（已在别处修正）
- **不改**前端
- 不引入新依赖

## 验收标准

- [ ] 参数类失败的提示明确指向「参数配置可能与 CLI 版本不匹配」，而非只说「无法启动」
- [ ] ENOENT 类失败的提示指向「未安装 / 不在 PATH」
- [ ] 两处失败提示（约 903 / 1130 行）行为一致，判断逻辑只有一份
- [ ] 其他失败类型行为不变（原样透出 `msg`）
- [ ] 新增测试至少覆盖「参数类」与「ENOENT 类」两个分支的提示文案
- [ ] `pnpm --filter server test` 全绿（基线 28 文件 / 379 用例）

## 不涉及

- 不改前端、不改 schema、不加接口
