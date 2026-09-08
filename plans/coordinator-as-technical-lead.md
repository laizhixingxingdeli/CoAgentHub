# Plan: 协调者升为技术负责人（第一版）

> 配套 `specs/coordinator-as-technical-lead.md`。
> **本文件是示例填法**（本 spec 自身当素材）；实战中派发后回填 taskId。

## 元信息

| 字段 | 值 |
|---|---|
| specRef | `specs/coordinator-as-technical-lead.md` |
| specHash | `0ab9570f3acd06c55a4542664647b8416346d772` |
| 编制 | 三方（检视者直连下发本票） |
| 更新 | 2026-09-08 |

## 工作项

### W1 — 切分线写入两个 skill

| 字段 | 内容 |
|---|---|
| 稳定编号 | W1 |
| 目标 | 协调者接 §4–§5；检视者保留 §3 与 §6；L3 仍属检视者 |
| 范围 | `skills/coordinator/SKILL.md`、`skills/reviewer/SKILL.md` |
| 前置依赖 | 无 |
| 预期产物 | 两 skill 正文含切分表/说明；两方 §1.2 逐字不动 |
| 验收方法 | 逐处指出句子；grep 确认未复制 grill/模板正文 |
| specRef | `specs/coordinator-as-technical-lead.md` |
| specHash | `0ab9570f3acd06c55a4542664647b8416346d772` |
| taskId | _本示例不回填真实 id_ |
| 状态 | planned |

### W2 — 计划与诊断模板

| 字段 | 内容 |
|---|---|
| 稳定编号 | W2 |
| 目标 | `plans/` 模板字段齐；含「被排除的假设」；给填好示例 |
| 范围 | `plans/_template.md`、`plans/coordinator-as-technical-lead.md` |
| 前置依赖 | 无（可与 W1 并行于同一文档票） |
| 预期产物 | 模板 + 本示例 |
| 验收方法 | 对照 spec §4.1 第 4–5 条字段清单 |
| specRef | `specs/coordinator-as-technical-lead.md` |
| specHash | `0ab9570f3acd06c55a4542664647b8416346d772` |
| taskId | _本示例不回填真实 id_ |
| 状态 | planned |

### W3 — 续跑加载纪律

| 字段 | 内容 |
|---|---|
| 稳定编号 | W3 |
| 目标 | 续跑：读计划 → 读子任务 → 以 task 校正；含「派发成功未回填 taskId」 |
| 范围 | `skills/coordinator/SKILL.md` §1.3 与 resume-rules |
| 前置依赖 | W1 |
| 预期产物 | skill 内顺序与校正规则 |
| 验收方法 | 对照 spec §4.1 第 6 条 |
| specRef | `specs/coordinator-as-technical-lead.md` |
| specHash | `0ab9570f3acd06c55a4542664647b8416346d772` |
| taskId | _本示例不回填真实 id_ |
| 状态 | planned |

### W4 — 五处文档同步 + ADR

| 字段 | 内容 |
|---|---|
| 稳定编号 | W4 |
| 目标 | AGENTS / CONTEXT / architecture 同步；新增 ADR（追加不抹改） |
| 范围 | `AGENTS.md`、`CONTEXT.md`、`docs/architecture.md`、`docs/adr/0010-*.md` |
| 前置依赖 | W1 |
| 预期产物 | 四处改句可指认 + 新 ADR |
| 验收方法 | spec §4.1 第 8 条；`git show --stat` 无 `packages/**/src/**` |
| specRef | `specs/coordinator-as-technical-lead.md` |
| specHash | `0ab9570f3acd06c55a4542664647b8416346d772` |
| taskId | _本示例不回填真实 id_ |
| 状态 | planned |

## 依赖图

```
W1 → W3
W1 → W4
W2（可与 W1 同票）
```

## 诊断（本票非 Bug；示意字段）

| 字段 | 内容 |
|---|---|
| 现象 | 续跑后协调者丢拆分计划与已排除的根因假设，只能看见子任务列表 |
| 期望行为 | 技术分析产物随 `specRef` 可复得，不依赖上一轮 CLI 记忆 |
| 复现步骤 | 协调者派一子任务后退出 → 续跑 → 问「还剩哪些未派工作项 / 排除过哪些假设」 |
| 已观察事实及证据位置 | `buildResumeBrief` 只带回 specRef/specHash/子任务状态/diffSummary（`coordinator-resume.ts`；spec §1.2 表） |
| 根因假设 | 缺口在「上一轮想过什么」未落盘，而非 L2 设计错误 |
| 验证动作与结果 | 对照 resume brief 字段与 skill §2.3「L2 只依赖可复得事实」——L2 正确，计划/诊断确实不在 brief 里 |
| **被排除的假设** | ①「应改 `buildResumeBrief` 塞进计划」——否决：文案级改动不该付构建+重启（见 ticket-text-is-workflow-policy）；`specRef` 已能推路径。②「计划应写进冻结 spec」——否决：计划要回填 taskId，会破坏 specHash 锚点。③「需要 DB 工作项实体」——否决：第一版明确不做 |
| 建议修复范围 | skills + plans/ + 文档/ADR；零平台代码 |
| **不能改变的行为** | 两方 §1.2 整体继承；L3 归属检视者；一条消息一个 task；载荷契约 |
| 回归场景 | 三方新需求走「grill→计划草案→冻结→派发」；续跑不重派已有子任务 |
| 最终产物验收方式 | spec §4.1 十条；§4.2 留待真实需求实战 |
