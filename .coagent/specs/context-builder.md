# 角色 Context Bundle 与开跑简报来源

## 作用范围

平台在 `src/application/platform.ts` 的 `getStartupBrief` 原有读取路径上收集项目红线、环境注记和 Mission/Attempt 所需的现有值，将它们交给 `src/application/context-builder.ts` 的纯输入构造器。无需新增必填适配器字段、第三方依赖或单独的读取权限。Bundle 提供来源可追溯性；旧简报字段仍从同一 Bundle 投影，兼容尚未更新的 coagent-pi。

## 角色视图

- 协调者 Bundle 的固定来源顺序：`project_rules`、`environment_notes`、`contract`、`plan`、`final_review`；投影旧字段 `projectRules`、`environmentNotes`、`contract`、`contractRevision`、`plan`、`planRevision`、`finalReview`，不含 `workItem`。
- 执行者 Bundle 的固定来源顺序：`project_rules`、`environment_notes`、`work_order`；投影旧字段 `projectRules`、`environmentNotes`、绑定的 `workItem`（含 `id`、`title`、`order`），不含契约、规划、打回及它们的修订字段。两个角色均保留简报原有 `role`、`projectId`、`missionId`、`status`。
- 来源缺省仍占位，旧投影保持对应 `undefined` 缺省；没有 `.coagent` 项目记忆也能取得简报，`projectRules` 缺省。`environmentNotes` 保持既有系统注记。

## 条目与标识

`contextBundle` 含 `role` 和有序 `entries`。每条有 `source`、`reason`、`estimatedTokens`、`content`，以及 `revision` 或 `hash`。契约、规划用平台既有修订号作为 `revision`；其余来源用内容的 SHA-256 十六进制 `hash`。字符串直接按 UTF-8 哈希，其他内容按稳定键序列化后哈希；每条估算值为其字符串原文（其他内容用稳定键序列化文本）的 UTF-8 字节数除以四向上取整，不代表精确用量或节约效果。标识元数据不写入原文、Mission/Attempt id 或凭据；条目的 `content` 则用于投影原有正文，不是脱敏机制。同输入重复构造深度相等，按平台修订契约只变化契约来源标识，改项目红线只变化红线来源标识。

## 按需引用边界

执行者工单中的 `contextRefs` 原样留在 `order`，Bundle 构造器不读盘、不预取 living_spec、contract、previous_result 或 file 的引用正文。`getContext` 继续按既有执行者绑定工单的声明引用权限查询：未声明引用返回 `found=false`；已声明引用维持原返回语义（如不存在的文件提示、未有结果的 previous_result 为 `found=false`）。`getWorkOrder`、`getMissionView`、`getProjectContext`、`getContract` 及对应 HTTP 工具原权限和响应不由 Bundle 改变。

## 显式简报尺寸预算

`GET /api/run/brief?budget=N` 接受十进制非负安全整数；省略预算时沿用 B2 完整简报与旧字段，不生成预算报告或截断事件。构造器 `buildContextBundle(input, budget?)` 的可选预算仅约束 Bundle 尺寸，不是 ADR-0005 的 ExecutionBudget，也不设置生产默认 token 阈值。传入预算时 `contextBundle.budgetReport` 给出 `budget`、`estimatedBefore`（所有条目逐条估算之和）、`estimatedAfter`（保留条目之和）、`omittedSources`、`overflow` 和 `remainingOverBudget`；等于预算时全部保留且无截断事件。

超过预算时只按 `plan`、再 `environment_notes` 的优先级整条删去可选来源，直到不超预算或没有可删来源。保留的条目继续按上述角色固定来源顺序排列，旧简报字段从保留的 Bundle 投影；不截断字段内字符串、不把可选内容移到必需来源。协调者的完整契约（含 intent/acceptance/constraints/guardrails）、项目红线及当前 L3 打回理由，执行者的完整工单（含 contextRefs）与项目红线都是必需内容。若必需条目仍使 `estimatedAfter > budget`，完整返回并报告 `overflow=true`、`remainingOverBudget=estimatedAfter-budget`，不能假装满足预算。

## 裁剪审计

仅 `omittedSources` 非空的实际裁剪通过平台的 Attempt 写事务路径记录 `context.truncated`，按当前 missionId/attemptId 去重；同一 Attempt 重取不追加，新 Attempt 的实际裁剪可各记一条。事件信封关联当前 Mission 和 Attempt，data 仅含角色、预算、裁前/裁后估算、被裁来源、overflow 及剩余超额等元数据，不含简报正文、凭据或工具输出。队列 Attempt 的裁剪写入受 claim fencing 保护；审计事件落盘失败时请求失败，不向客户端返回声称已审计的裁剪简报。未提供预算或没有实际删条目的读取不写 `context.truncated`。
