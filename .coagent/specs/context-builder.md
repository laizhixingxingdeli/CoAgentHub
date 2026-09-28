# 角色 Context Bundle 与开跑简报来源

## 作用范围

平台在 `src/application/platform.ts` 的 `getStartupBrief` 原有读取路径上收集项目红线、环境注记和 Mission/Attempt 所需的现有值，将它们交给 `src/application/context-builder.ts` 的纯输入构造器。无需新增必填适配器字段、第三方依赖或单独的读取权限。Bundle 提供来源可追溯性；旧简报字段仍从同一 Bundle 投影，兼容尚未更新的 coagent-pi。

## 角色视图

- 协调者 Bundle 的固定来源顺序：`project_rules`、`environment_notes`、`contract`、`plan`、`final_review`；投影旧字段 `projectRules`、`environmentNotes`、`contract`、`contractRevision`、`plan`、`planRevision`、`finalReview`，不含 `workItem`。
- 执行者 Bundle 的固定来源顺序：`project_rules`、`environment_notes`、`work_order`；投影旧字段 `projectRules`、`environmentNotes`、绑定的 `workItem`（含 `id`、`title`、`order`），不含契约、规划、打回及它们的修订字段。两个角色均保留简报原有 `role`、`projectId`、`missionId`、`status`。
- 来源缺省仍占位，旧投影保持对应 `undefined` 缺省；没有 `.coagent` 项目记忆也能取得简报，`projectRules` 缺省。`environmentNotes` 保持既有系统注记。

## 条目与标识

`contextBundle` 含 `role` 和有序 `entries`。每条有 `source`、`reason`、`estimatedTokens`、`content`，以及 `revision` 或 `hash`。契约、规划用平台既有修订号作为 `revision`；其余来源用内容的 SHA-256 十六进制 `hash`。字符串直接按 UTF-8 哈希，其他内容按稳定键序列化后哈希；token 数为文本长度除以四向上取整的确定性粗估，不代表精确用量或节约效果。标识元数据不写入原文、Mission/Attempt id 或凭据；条目的 `content` 则用于投影原有正文，不是脱敏或裁剪机制。同输入重复构造深度相等，按平台修订契约只变化契约来源标识，改项目红线只变化红线来源标识。

## 按需引用边界

执行者工单中的 `contextRefs` 原样留在 `order`，Bundle 构造器不读盘、不预取 living_spec、contract、previous_result 或 file 的引用正文。`getContext` 继续按既有执行者绑定工单的声明引用权限查询：未声明引用返回 `found=false`；已声明引用维持原返回语义（如不存在的文件提示、未有结果的 previous_result 为 `found=false`）。`getWorkOrder`、`getMissionView`、`getProjectContext`、`getContract` 及对应 HTTP 工具原权限和响应不由 Bundle 改变。
