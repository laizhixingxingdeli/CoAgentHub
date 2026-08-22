# Spec: 执行器输出在后端剥离 ANSI

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-23
> **协作模式**: 三层
> **下游**: `specs/live-output-in-timeline.md` 依赖本票;三个检视者插件的实时显示同样依赖

## 背景

执行器 stdout 带 ANSI 转义码。当前**输出流这条路上没有任何剥离**——
剥离正则只存在于 `lib/executor-task/report.ts:9`(汇报解析用),流式输出原样透传。

原样塞进 `<pre>` 会看到 `[32m` 一类乱码。

**剥在后端而不是各消费端**:`ws-hub.ts:238` 的注释已写明 `task_output` 是给
「插件/前端免轮询感知任务生命周期」用的——它是**面向多消费端的契约**。
目前 dsh / codex 两个插件都尚未消费该事件(`grep` 零结果),但实时显示是既定方向。
剥在源头,前端、三个插件、`includeOutput` 兜底拉取、失败任务的 `outputTail` 一次性全部受益。

---

## 要求

### R1. 在唯一源头剥离

`lib/executor-task/queue.ts:838` 的 `onOutput` 是缓冲与 WS 广播的共同分叉点:

```
onOutput(chunk)
  ├─ process.stdout.write(chunk)      ← 保持原样
  ├─ appendTaskOutput(taskId, chunk)  ┐ 剥离后的文本走这两条
  └─ wsHub.broadcastTaskOutput(...)   ┘
```

- 剥离发生在 `appendTaskOutput` 与 `broadcastTaskOutput` **之前**
- `process.stdout.write(chunk)` **保持原样**——服务端控制台留着颜色是有用的
- 复用 `report.ts:9` 的既有正则,**不要写第二份**(抽到共享位置,两处引用)

### R2. 处理跨 chunk 的转义序列(关键)

chunk 是流式片段,**一个 ANSI 转义序列会被切在两个 chunk 中间**:
`\x1b[3` 落在前一块、`2m` 落在后一块,逐 chunk 套正则两边都不匹配,
乱码照样漏出去——而且是偶发的,最难查。

- 必须处理这种情况。具体做法自行设计(在累积缓冲上剥、或 chunk 结尾疑似
  半截转义时留一小段不发,都可以),**在汇报里说明选了哪种及理由**
- **必须有测试直接覆盖跨 chunk 场景**:把一个完整转义序列拆成两个 chunk 依次喂入,
  断言输出无残留。只测单 chunk 不算数

### R3. 修正 output-buffer 注释

`lib/executor-task/output-buffer.ts:7` 注释写「200 行 / 64KB」,
而下面两行常量是 `1000` / `256 * 1024`。注释与代码不符,顺手改对。

---

## 验收标准

- [ ] `appendTaskOutput` 与 `broadcastTaskOutput` 收到的是已剥离文本
- [ ] `process.stdout.write` 仍收到原始 chunk(带色)
- [ ] 剥离正则只有一份,两处引用
- [ ] **跨 chunk 转义序列有专门测试**,断言无残留
- [ ] 单 chunk 常规转义有测试
- [ ] `output-buffer.ts` 注释与常量一致
- [ ] `pnpm --filter server test` 全绿(先跑一次确认基线,不得减少)

## 不涉及

- **不改**前端
- **不改** `task_output` 事件的形状(字段名、广播可见性均不变)
- **不做**终端配色保留(现在不需要上色;真要上色是另一个议题)
- **不改**缓冲上限的数值(1000 行 / 256KB 是合理的,本票只修注释)
- 不引入新依赖

## 执行环境提示

- 本仓是 **pnpm** 项目
- 后端当前以 `pnpm --filter server start`(无 watch)运行中:
  改完后端代码需手动 build + restart 才生效,跑测试不受影响
- 沙箱执行器注意:全量测试里有需监听本地端口的用例会报 `listen EPERM`,
  那是环境限制不是回归——**全量由协调者代跑**
