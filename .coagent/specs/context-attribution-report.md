# 离线只读上下文归因报告

## 目的与入口

在启用任何默认简报裁剪前，先从已持久化的文件状态量出可归因的逐 Attempt 信号及历史缺口。运行 `node src/context-attribution-report.ts --input <state.json> [--archive <package.json> ...]`，显式列出 version:1 主状态与每份 version:1 归档 package；不自动扫描目录。应用层纯函数 `buildContextAttributionReport(state, archivePackages?, archiveIntegrity?)` 接受解析后的等价快照；第三参数是可选的逐归档原始字节完整性元信息。CLI 只读取显式文件，以 JSON 写 stdout；无效输入以固定 `CONTEXT_ATTRIBUTION_INPUT_ERROR` 写 stderr 并非零退出，不回显路径或输入。入口不调用状态装配、Attempt 收敛、建表、状态写入或简报请求。

## 输出口径

version:1 报告按 missionId、role、attemptId 稳定排序，每个 Attempt 至多一行；live 与显式归档走同一投影。行的白名单仅为 missionId、attemptId、role、status、可选 usage（input、output、cacheRead、cacheWrite、total、quality）、usageCoverage、已记录工具名次数 toolCounts、toolCoverage、可选 truncation（budget、estimatedBefore、estimatedAfter）、truncationCoverage、可选 contextMetrics、contextMetricsCoverage、固定常量 reasons。报告顶层仅有 version、rows、liveCoverage、archiveCoverage、reasons。usage 仅在完整合法数值及 reported/estimated quality 存在时输出；不推算缺失数字。工具次数是持久化 toolActivity 的已记录次数，不等于所有历史调用。truncation 只来自有效 `context.truncated` activity 事件；相同 messageId 或无 ID 且内容完全相同的重复事件去重。预算与裁前/裁后是 Bundle 审计估算，不是模型输入 token 或节省量。不得计算简报/cacheRead 占比，不得将多个 Bundle 估算相加解释成模型用量。

## Attempt 终态采集摘要（v1）

adapter 的 RuntimeOutcome 可选携带不可信 `contextMetrics`；没有字段的旧适配器、旧 ScriptedRuntime 脚本不补零。SpawnRuntime 只透传结果行中的可选字段，ScriptedRuntime 可在正常完成脚本时透传；常规与独立检视 Attempt 的终态由 orchestrator 交 `platform.finishAttempt`，常规墙钟强杀或没有 outcome 时不透传采集摘要。平台接收处重新白名单校验，只有通过的对象才会进入带 missionId/attemptId envelope 的 `attempt.ended.data.contextMetrics`，与 Attempt 收尾处于同一写入事务。收尾失败不报告成功；已终态重试不重复记摘要。无需修改 kernel 快照。指标仅是观测事实，不用作 ExecutionBudget 权威用量。

v1 形状：`{version:1, coverage:'complete'|'partial'|'unknown', brief?, tools?, reads?}`。`brief` 有实际渲染 `renderedUtf8Bytes` 和 `sources:[{source,estimatedTokens?,truncated}]`；来源只允许 project_rules、environment_notes、contract、plan、final_review、work_order。`tools:[{kind,calls,returnedUtf8Bytes}]` 的类别限 read、grep、find、ls、bash。`reads:[{pathDigest,contentDigest,repeats}]` 的两个摘要须为 64 位小写十六进制 SHA-256 表示；仅作同一 Attempt 内去重，不保存原始路径、文件正文或工具返回正文。可得估算可以缺席，不可把缺席当零。complete 须有合法 brief/tools/reads 三段；partial/unknown 可缺段。接收端限定单份 JSON 32KiB、最多六来源桶、五工具桶、64 read 桶、非负有界整数（不大于 1,000,000,000）、唯一桶、严格对象字段及摘要格式；畸形或超限输入整段不落盘，也不得宣称 complete。不得复制输入中任意正文、路径、请求头或密钥到 Activity 或错误。

离线报告仅从该 Attempt 的 `attempt.ended` Activity 读取 v1，独立重复验证白名单及 complete 所需段；多个同 Attempt 终态事件不累计。报告行的 `contextMetrics` 若可用，仅列 brief 的实际字节和每来源可得估算/裁剪、固定工具类别的调用数与返回字节、reads 的 `totalRepeats` 与 `bucketCount` 聚合，绝不输出 pathDigest/contentDigest 或原路径/正文。`contextMetricsCoverage` 为 complete/partial/unknown；缺事件的旧历史标 unknown 且 reason 为 `context_metrics_absent`，畸形指标标 unknown 且 reason 为 `context_metrics_untrusted`，不生成伪零。live 事件流不可证完整时不把指标标成 complete，并给出 `live_data_incomplete`。新指标与旧 toolActivity 次数、context.truncated 审计分开呈现；报告版本保持 1。

## 历史数据可用性与缺口

缺 usage 或 toolActivity、没有可归因事件、未见 context.truncated 审计均明确给出 unknown 与原因；没有审计不证明未读取或未裁剪。toolActivity 达到保留尾部上限 200 时 toolCoverage 为 partial，200 仅代表可见尾部。主状态 events 缺失/不可用时 liveCoverage 为 partial，live 行的截断审计不得被当成完整。归档索引列出但没有显式提供的 package 标 archiveCoverage unknown/partial；提供的 package 只有 CLI 按原始文件 bytes/sha256 与索引核对成功才可标 complete，纯函数无完整性参数时即使归档数据已提供也为 partial。历史事件未落盘、只剩工具尾部、未裁剪简报的原始正文与完整 prompt 不可还原；旧历史无终态采集摘要时也无法推断精确 read 返回字节。报告只描述已记录信号及覆盖率，不能据此宣称减少了多少模型 token，更不能因报告成功而默认开启裁剪。

## 保密与验证

输出仅发白名单字段、合法标识和固定安全原因；不输出简报正文、工具输出、路径、摘要哈希、key/token、resumeRef、profile facts 或任意事件 data。错误也只发固定码。合成 version:1 主快照、归档 package、手写固定期望覆盖两角色多 Attempt、缺用量、真实/无裁剪、重复事件及 200 工具尾部；`node --test test/context-attribution-report.test.ts` 逐字段比较、核验输入文件前后 Buffer 一致和敏感哨兵不出现在输出/错误。`node --test test/context-metrics.test.ts test/spawn-runtime.test.ts test/orchestrator.test.ts` 覆盖旧 outcome、合法/越界输入、重复收尾、事务失败、文件与隔离 PG 重读及运行时透传。全量回归用 `node --test`。本能力仅作离线归因观察，不运行真实 Mission 或 A/B。
