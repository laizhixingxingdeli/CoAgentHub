# Spec: 载荷契约要求整条消息是 JSON,而人读的消息都包 markdown

> **状态**: Landed — L3 通过(2026-08-26),实现 `211b9ae3 + 1bdd3ae5`
> **版本**: 1.0
> **日期**: 2026-08-25
> **修正**: `findings-must-reach-coordinator`(`68446529`)的 R2 强制口径

## 现象一:检视者的两条 L3 裁决,平台一条都没认

实测 `timeline-layer-by-actor` 协调任务:

```
l3 = {"answered": false, "verdict": null, "awaitingSince": "...", "overdue": false}
```

检视者 21:18 公布过 `verdict: "pass"`,任务至今显示「等待检视」。

## 现象二:新落地的 findings 强制,在真实用法下一次都不会触发

端到端三组(后端已重建重启):

| 发法 | 期望 | 实际 |
|---|---|---|
| 纯 JSON 广播 findings | 400 | **400** ✓ |
| **markdown 包 json 广播 findings** | 400 | **200 绕过** ❌ |
| 纯 JSON 广播 pass | 200 | 200 ✓ |

## 同一个根因

`parseKnownCoordinationPayload`(`database/src/schema/coordination-payload.ts`)
第一步就是:

```ts
try { value = JSON.parse(body); } catch { return undefined; }
```

**要求整个 message body 就是一个 JSON 对象。** 而任何给人看的裁决都会写成

```
## L3 裁决:xxx —— pass
<人读的说明>

​```json
{"type":"review_result", ...}
​```
```

于是**所有实际发出的载荷都解析失败**,一路静默 —— 读取路径把它当自由文本
(`l3.verdict` 永不填),强制路径也看不见它(广播 findings 照样 200)。

`review_request` 之所以没暴露这个问题,是因为它走 `diffSummary`(JSON 列),
**不走消息 body**。也就是说:**凡是走消息 body 的载荷契约,今天全是失效的。**

## 决策:解析器要能从 markdown 中取出载荷

### R1. 支持 ```json 代码块

`parseKnownCoordinationPayload` 在整体 JSON 解析失败时,继续尝试:

- 从 body 中提取 **```json ... ```** 围栏内的内容再解析
- 无语言标注的 **``` ... ```** 围栏也要试(检视者可能漏写 `json`)
- 一条消息中**有多个**围栏时:逐个尝试,**采用第一个解析成功且 `type` 在已知集合内的**

### R2. 整体 JSON 仍然优先,行为不变

body 整体就是合法 JSON 时,**走现行路径,结果逐字不变**(回归,必测)。
围栏提取只是**失败后的补充**,不改变既有成功路径。

### R3. 提取不到仍返回 undefined,不抛

自由文本、围栏里不是 JSON、围栏里是 JSON 但 `type` 不在已知集合 →
**返回 `undefined`**,与现行「自由文本原样放行」一致,**不得**变成 400。

⚠️ 这条是防止本票把强制面意外扩大:今天大量自由文本消息在流转,
解析器变宽后**不能**把它们卷进校验。

### R4. 一处改,两处生效

解析器是读取路径(`tasks.ts` 的 `l3.verdict` 派生)与强制路径
(`messages.ts` 的 findings 定向校验)**共用的同一个函数**。
本票只改这一个函数,**不在两处各写一套提取逻辑**。

### R5. 补认历史消息 —— 不做

**不做**对已存消息的回填/重解析。理由:`l3.verdict` 是读时派生
(每次查询重新扫消息),解析器修好后**历史消息自然被重新认出**,无需迁移。

⚠️ 实现时请**验证这一点**再落这条 —— 若发现 `l3` 是写时固化的,
在汇报里说明,由检视者另行判断。

### R6. 不改这些

- **不改** `coordinationPayload` 的 zod 结构(§3.10 字段契约不动)
- **不改** findings 定向强制的判定规则(那条是对的,只是看不见载荷)
- **不改** `review_request` 走 `diffSummary` 的路径

## 验收标准

- [ ] ```json 围栏中的 `review_result` 能被解析出来
- [ ] 无语言标注的 ``` 围栏也能解析
- [ ] 前置有 markdown 标题与正文时仍能解析(即实际发法)
- [ ] 一条消息含多个围栏 → 采用第一个 `type` 已知且解析成功的
- [ ] body 整体是 JSON 时行为**逐字不变**(回归,必测)
- [ ] 自由文本 → `undefined`,**不抛错、不 400**(回归,必测)
- [ ] 围栏内是 JSON 但 `type` 未知 → `undefined`,不 400
- [ ] **端到端**:markdown 包裹的广播 findings → **400**(本票的核心信号)
- [ ] **端到端**:markdown 包裹的 `verdict: "pass"` → 200,且该任务
      `l3.answered` 变为 `true`、`verdict` 为 `"pass"`
- [ ] 后端与前端测试全绿(该解析器前端也在用),贴出用例数

## 不涉及

- 历史消息迁移(R5)
- 载荷字段结构(R6)
- findings 定向规则本身

## 执行环境提示

- 实现位置:`packages/backend/database/src/schema/coordination-payload.ts`
  的 `parseKnownCoordinationPayload` —— **前后端共用**,改一处两处生效
- ⚠️ 端到端验证必须**重建并重启后端**再测,否则测的是旧构建;
  本轮已有先例:一个检测「源码改了没重建」的功能自己跑在没重建的进程上
- ⚠️ 本票**必须下发给执行器**,不要由协调者自己动手
- ⚠️ 做完记得提交
