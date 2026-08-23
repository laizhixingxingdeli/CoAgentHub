# Spec: Composer 下线后的死代码清理

> **状态**: Landed — 已完成(2026-08-23 核实)
> **版本**: 1.0
> **日期**: 2026-08-22
> **协作模式**: 两层（群 `01a02953-e519-77f6-be9c-55fb4b31c898` 无 reviewer 成员，
> 协调者按 spec v3.8 §3.14 兼任写 spec 职责）
> **上游**: `a5e9a53`（群内页主区改为需求两栏，聊天流降级为只读消息 tab）、
> `f284e2e`（群组列表合并为单套清单行）

## 背景

前几票的重构留下了三处死代码，各自都在提交里明确记录为「留待下一票」：

1. `a5e9a53` 把 `Composer`（消息输入框）从群内页移除，但**文件本身与残留 handler 保留**，
   并把 9 个相关测试用例标记为 `describe.skip`/`it.skip`，注释写明「待下一票决定这些能力的去留」
2. `f284e2e` 把群组列表从「移动端卡片 + 桌面端表格」合并为单套清单行后，
   `status-badge.tsx` 与 `groups.table.*` 词典键**失去全部引用**但未删

死代码的代价不是磁盘占用，是**误导**：后来者读到 `Composer.tsx` 会以为页面还有发送入口，
读到 `describe.skip` 会以为那些能力只是暂时关闭。清理的同时要保留「这些能力曾经存在过」
的判断依据——所以本 spec 对每一项都要求给出**去留判断的理由**，而不是一删了之。

## 已核实的事实

- `Composer.tsx` **无任何 import**（`grep from "./Composer"` 无结果）→ 确认死文件
- `use-messages-page.ts` 仍有 `handleComposerKeyDown`（第 550 行定义、851 行导出）
- `status-badge.tsx` / `StatusBadge` 除自身文件外**无引用**
- `groups.table.*` 词典键在 `src` 下（i18n 词典文件除外）**无引用**
- `messages.test.tsx` 有 9 处 skip：4 个 `describe.skip` + 5 个 `it.skip`

## 改动范围

### T1 — Composer 死代码与跳过用例的处置

**删除**：
- `packages/frontend/web/src/pages/app/groups/messages/Composer.tsx`
- `use-messages-page.ts` 中仅服务于 Composer 的残留（`handleComposerKeyDown`
  及其导出；以及顺着它牵出的、确认只被 Composer 使用的 state/handler）
- `MessageList.tsx` / `messages-tab.tsx` / `messages/index.tsx` 里遗留的
  Composer 相关注释（这些是纯注释，改成描述现状或删掉）

**9 个跳过用例的处置判断**：

| 用例 | 处置 | 理由 |
|---|---|---|
| `@ 提及输入 (ticket 18)` | 删除 | @提及是输入框能力，页面已无输入框 |
| `发送 payload (ticket 18)` | 删除 | 同上 |
| `测试执行器下拉` | 删除 | 属于发送区的分工选择控件 |
| `身份禁言 (§3.9 票 10)` | 删除 | 该用例断言 human 身份下 Composer 换成只读引导条；
现在**任何身份都没有发送入口**，前端禁言展示已无意义。
⚠️ 后端 403 禁言规则**不受影响**，其测试在 `group-message.test.ts`，不得动 |
| `输入区布局` | 删除 | 输入区不存在了 |
| `点回复 → 引用条` | 删除 | 回复是输入框能力 |
| `取消回复` | 删除 | 同上 |
| **`WS 回显与发送后 reload 不重复(按 id 去重)`** | **迁移，不删** | 核心断言是**消息列表按 id 去重**，
在只读消息 tab 里**仍然有效**——WS 推送与列表 reload 之间照样可能重复。
去掉其中「发送」的部分，改为纯 WS 推送 + reload 场景，迁到消息 tab 的测试里 |
| 第 9 处 skip | 执行时确认 | 上表列了 8 处；实际 `grep -c` 为 9，
执行者需定位第 9 处并按同样标准判断（属 Composer 能力→删；属列表/展示能力→迁移） |

### T2 — 群组列表重构的遗留

**删除**：
- `packages/frontend/web/src/pages/app/groups/status-badge.tsx`
- `zh.ts` / `en.ts` 里的 `groups.table.*` 词典键（两本必须同步，
  i18n 的 `en` 是 `Record<DictKey, string>`，缺键会类型报错）

## 验收标准

### T1
- [ ] `Composer.tsx` 已删除，全仓无残留 import
- [ ] `use-messages-page.ts` 无 `handleComposerKeyDown` 及其它仅服务 Composer 的残留
- [ ] 8 个 Composer 专属用例已删除（不是继续 skip）
- [ ] WS 去重用例**已迁移并恢复运行**（不再是 skip），断言消息列表按 id 去重
- [ ] 第 9 处 skip 已定位并给出处置理由
- [ ] `messages.test.tsx` 中**不再有** `describe.skip` / `it.skip`
- [ ] 后端 `group-message.test.ts` 的 human 403 用例**未被触碰**

### T2
- [ ] `status-badge.tsx` 已删除，全仓无残留 import
- [ ] `groups.table.*` 词典键在 zh/en 两本中同步删除
- [ ] 类型检查通过（缺键会报错，这是验证删干净的手段）

### 两票共同
- [ ] `pnpm --filter @laizhixingxingdeli/web build` 通过
- [ ] `pnpm --filter @laizhixingxingdeli/web test` 全绿
      （基线 22 文件 / 308 通过 + 20 跳过；改完 skip 数应**显著下降**，
      通过数不得减少——删掉的是"已跳过"的，不是"在跑的"）

## 不涉及

- **不改**后端任何文件（human 403 禁言规则是后端行为，不在本次范围）
- **不改** `MessageList.tsx` 的渲染逻辑（只清注释）
- **不恢复**任何已下线的发送能力

## 测试环境提示

这台机器负载高（无关进程占用大量 CPU），全量并行跑测试会偶发超时，
失败文件每次漂移且单独跑全绿。判断是否真回归请用
`cd packages/frontend/web && npx vitest run --maxWorkers=1` 串行跑一次。


---

## 清理核实记录(2026-08-23)

检视者核实:`Composer` 相关文件已从 `packages/frontend/web/src` 全部移除(`find` 零结果)。
