# Spec: 任务状态不明显(裸英文枚举 + 不分色)

> **状态**: Landed — L3 通过(2026-08-24),实现 `d17282f0`
> **版本**: 1.0
> **日期**: 2026-08-23

## 背景

`RequirementTimeline.tsx:243-250` 渲染任务状态:

```tsx
<span className="mt-1 inline-flex rounded-full bg-muted px-2 py-0.5
                 text-[11px] text-muted-foreground">
  任务 {taskStatus.status}
  {taskStatus.retries > 0 ? ` · 重试 ${taskStatus.retries} 次` : ""}
</span>
```

**两个问题叠在一起:**

**① 直接渲染英文枚举。** 界面上出现的是「任务 running」「任务 failed」——
其余文案全是中文,这里漏了一层。

**② 完全不分色。** `bg-muted` + `text-muted-foreground`,**失败和完成长得一模一样**
的灰药丸。要读文字才知道出了事,而这恰恰是最该一眼看见的信息。

**而且它跟自己不一致:** 同一个界面里 L1/L2/L3 的层徽章**是带状态色的**
(`RequirementDetailPanel.tsx:267-271`):

```ts
const LAYER_STATUS_CLASS: Record<LayerStatus, string> = {
  done:    "border-status-done bg-status-done/10 text-status-done",
  failed:  "border-status-failed bg-status-failed/10 text-status-failed",
  running: "border-status-running bg-status-running/10 text-status-running",
  ...
```

同一套 `--status-*` token 已经在用,任务药丸只是没接上。

## 要求

### R1. 中文状态词

英文枚举映射为中文,走现有 i18n(`lib/i18n/`),**不要在组件里硬编码字符串**:

| 枚举 | 文案 |
|---|---|
| `queued` | 排队中 |
| `running` | 执行中 |
| `done` | 已完成 |
| `failed` | 失败 |
| `cancelled` | 已取消 |

⚠️ 若映射表不全(枚举定义在 `TaskPanel.tsx` 的 `TaskStatus`),**以类型定义为准
补齐**,不要漏一个走到兜底显示英文。

### R2. 接上状态色

复用 `LAYER_STATUS_CLASS` 同款的 `--status-*` token 配色。

- **不要新定义颜色**,不要硬编码色值
- 与层徽章配色**保持一致** —— 同一个界面里「完成」应该是同一个绿

若 `LAYER_STATUS_CLASS` 可直接复用,**抽出共享**,不要复制一份。

### R3. 失败态要在无彩条件下也可辨

不能只靠颜色区分。失败态需额外携带一个非颜色信号(图标 / 边框加重 / 文案本身),
保证色觉障碍与灰度打印下仍可读。

### R4. 重试信息保留

`· 重试 N 次` 的后缀保留,格式可调,信息不能丢。

### R5. 视觉权重

状态药丸应当**比控制按钮更醒目、比正文内容略轻**。它是这张卡片上第一眼要看到的
东西,但不该盖过任务标题。

## 验收标准

- [ ] 五种状态全部显示中文,界面上不再出现 `任务 running` 这类裸枚举
- [ ] 文案走 i18n,组件内无硬编码中文状态词
- [ ] 状态药丸带状态色,`done` / `failed` / `running` 视觉可区分
- [ ] 配色与 `RequirementDetailPanel` 的层徽章**取自同一套 token**,同一状态同一色
- [ ] 失败态有非颜色信号,灰度下仍可辨
- [ ] 重试次数后缀保留
- [ ] 未新增硬编码色值
- [ ] 前端测试全绿,贴出用例数
- [ ] **未改动**后端

## 不涉及

- 层徽章本身的样式(已正确,只可能被抽取复用)
- 任务卡片的其它内容与布局
- 控制按钮位置(`requirement-detail-control-placement`)

## 执行环境提示

- 前端 `http://localhost:5173`
- **必须肉眼确认**:群里同时存在 done 与 failed 任务时,不读文字也能一眼分辨
