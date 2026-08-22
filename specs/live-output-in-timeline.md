# Spec: 实时日志接进需求时间线

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-23
> **协作模式**: 三层
> **前置**: `specs/executor-output-ansi-strip.md`(不先剥 ANSI,这里显示的是乱码)

## 背景:WS 在收、缓冲在填,就差最后一根线没接

用户实测反馈「运行的实时日志没有打印」。查下来不是没实现,是**主路径上没接**:

```
liveOutputs ──► TaskPanel               (requirement-workspace.tsx:381)
            │                            ↑ 只在「无需求」的回退路径才渲染
            ╳
            └─► RequirementDetailPanel  ← 从来没传
                    └─► RequirementTimeline
                            └─ 只读 task.diffSummary.outputTail
```

`requirement-workspace.tsx:167-175` 确实在订阅 WS `task_output` 并往 `liveOutputs` 追加,
但它只传给了 `TaskPanel`(369-381 行)——那是**无需求时的回退路径**。
正常有需求时走 `RequirementDetailPanel`,而 `RequirementTimeline:219` 读的是
`task.diffSummary.outputTail`,**那是任务落终态时才回填的输出尾**(`queue.ts:1074`)。

所以运行中的十几分钟到一小时里,时间线是空的;跑完才出现一截尾巴。

---

## 设计决策(已与用户确认)

**同一份数据,两种密度:**

| 任务状态 | 折叠(默认) | 展开(用户点击) |
|---|---|---|
| 运行中 | 输出的**最后一非空行**,随 WS 更新 | 全量 stdout,深色终端块,自动滚底 |
| 已完成 | 汇报摘要(测试 / 提交) | 汇报按字段分区(见 `timeline-readability` 票) |
| 已失败 | 失败原因 | `diffSummary.outputTail` |

**默认全部折叠。** 用户想看哪条自己展开——运行中的行也不例外。
折叠时那一行最后输出就足以判断「它是活的还是卡了」。

**跑完的实时输出不保留。** `liveOutputs` 是纯内存缓冲,任务转终态即丢弃,
回看靠汇报。**但失败任务的 `diffSummary.outputTail` 必须保留**——
执行器崩溃 / 被限额掐断时汇报本身可能是空的,那截尾巴是唯一的排障线索,
且是现成的既有行为(`RequirementTimeline:219` 已在读)。**不要顺手删掉它。**

---

## 要求

### R1. 把 liveOutputs 接进主路径

- `liveOutputs` 传到 `RequirementDetailPanel` → `RequirementTimeline`
- 时间线渲染 running 任务时,输出取值优先级:
  `liveOutputs[task.id]` → `diffSummary.outputTail` → 空
  (与 `TaskPanel.tsx:277` 现有写法一致,**照抄这个优先级**)
- 断线/刷新后缓冲为空的兜底已存在(`requirement-workspace.tsx:210` 的
  `includeOutput=1`),**复用它,不要重写**

### R2. 前端缓冲必须有上限(否则内存泄漏)

`requirement-workspace.tsx:170-174` 当前是**无上限字符串累加**:

```ts
[event.taskId]: (prev[event.taskId] ?? "") + event.chunk
```

后端有上限(`output-buffer.ts:8-9`,1000 行 / 256KB 滚动窗口),但 WS 是把**每个 chunk**
都推过来的,所以前端攒的是「有史以来全部输出」。跑一小时的任务足够撑爆这个 state,
且每来一个 chunk 就新建整个字符串 + 触发重渲染。

- 前端缓冲采用**与后端相同的上限**(1000 行 / 256KB,超限保留尾部)
- 上限数值不要各写各的——从共享位置取,或至少注释指明与后端一致
- 新增测试:喂入超限内容,断言只保留尾部

### R3. 折叠态显示最后一非空行

- 取缓冲的最后一**非空**行(执行器输出常有空行/纯空白行)
- 单行截断不换行(`text-overflow: ellipsis`),不得把行高撑开
- 无输出时不显示这一行,不要留空占位

### R4. 展开态复用现成的终端块

`TaskPanel.tsx:148-176` 的 `LiveOutput` 已是成品:等宽字体、深色底
(`bg-slate-950`)、`max-h-96 overflow-auto`、内容变化自动滚底。

**复用它,不要重写一个。** 若需从 `TaskPanel` 里提出来共享,提取即可,行为不变。

---

## 验收标准

- [ ] running 任务在**有需求**的主路径上能看到实时输出(不再只有回退路径有)
- [ ] 取值优先级为 `liveOutputs` → `diffSummary.outputTail` → 空
- [ ] 断线/刷新后 `includeOutput=1` 兜底仍生效
- [ ] 前端缓冲有上限,与后端一致;超限只留尾部,**有测试覆盖**
- [ ] 折叠态显示最后一非空行,单行截断
- [ ] 无输出时不显示该行
- [ ] 展开态复用 `LiveOutput`,未新写终端组件
- [ ] **所有任务行默认折叠**(running 也不例外)
- [ ] 失败任务的 `diffSummary.outputTail` 仍可在展开态看到(未被误删)
- [ ] `pnpm --filter @laizhixingxingdeli/web test` 全绿(先跑一次确认基线,不得减少)
- [ ] `pnpm --filter @laizhixingxingdeli/web build` 通过

## 不涉及

- **不改**后端:`task_output` 事件、`output-buffer.ts` 上限、`diffSummary.outputTail`
  回填逻辑全部保持现状(ANSI 剥离是前置票的事,本票不碰)
- **不新增**服务端接口
- **不做**执行器主动汇报运行阶段(那要动执行协议,是以后的事;
  本票只用 stdout,理由:stdout **不依赖被观测对象的配合**,
  执行器崩溃/卡死时汇报发不出来,而 stdout 仍在)
- **不做**终端配色还原
- 不引入新依赖

## 执行环境提示

- 本仓是 **pnpm** 项目
- 前端可实测:`http://localhost:5173/groups/01a029c4-b67f-...`
  (真跑一个任务才看得到实时输出;**不要为此下发真实任务消耗执行器额度**,
  用测试或 mock WS 事件验证)
- 沙箱执行器注意:需监听本地端口的测试会报 `listen EPERM`,那是环境限制不是回归
