# 离线只读上下文归因报告

## 目的与入口

在启用任何默认简报裁剪前，先从已持久化的文件状态量出可归因的逐 Attempt 信号及历史缺口。运行 `node src/context-attribution-report.ts --input <state.json> [--archive <package.json> ...]`，显式列出 version:1 主状态与每份 version:1 归档 package；不自动扫描目录。应用层纯函数 `buildContextAttributionReport(state, archivePackages?, archiveIntegrity?)` 接受解析后的等价快照；第三参数是可选的逐归档原始字节完整性元信息。CLI 只读取显式文件，以 JSON 写 stdout；无效输入以固定 `CONTEXT_ATTRIBUTION_INPUT_ERROR` 写 stderr 并非零退出，不回显路径或输入。入口不调用状态装配、Attempt 收敛、建表、状态写入或简报请求。

## 输出口径

version:1 报告按 missionId、role、attemptId 稳定排序，每个 Attempt 至多一行；live 与显式归档走同一投影。行的白名单仅为 missionId、attemptId、role、status、可选 usage（input、output、cacheRead、cacheWrite、total、quality）、usageCoverage、已记录工具名次数 toolCounts、toolCoverage、可选 truncation（budget、estimatedBefore、estimatedAfter）、truncationCoverage、固定常量 reasons。报告顶层仅有 version、rows、liveCoverage、archiveCoverage、reasons。usage 仅在完整合法数值及 reported/estimated quality 存在时输出；不推算缺失数字。工具次数是持久化 toolActivity 的已记录次数，不等于所有历史调用。truncation 只来自有效 `context.truncated` activity 事件；相同 messageId 或无 ID 且内容完全相同的重复事件去重。预算与裁前/裁后是 Bundle 审计估算，不是模型输入 token 或节省量。不得计算简报/cacheRead 占比，不得将多个 Bundle 估算相加解释成模型用量。

## 历史数据可用性与缺口

缺 usage 或 toolActivity、没有可归因事件、未见 context.truncated 审计均明确给出 unknown 与原因；没有审计不证明未读取或未裁剪。toolActivity 达到保留尾部上限 200 时 toolCoverage 为 partial，200 仅代表可见尾部。主状态 events 缺失/不可用时 liveCoverage 为 partial，live 行的截断审计不得被当成完整。归档索引列出但没有显式提供的 package 标 archiveCoverage unknown/partial；提供的 package 只有 CLI 按原始文件 bytes/sha256 与索引核对成功才可标 complete，纯函数无完整性参数时即使归档数据已提供也为 partial。历史事件未落盘、只剩工具尾部、未裁剪简报的原始正文与完整 prompt 不可还原；报告只描述已记录信号及覆盖率，不能据此宣称减少了多少模型 token，更不能因报告成功而默认开启裁剪。

## 保密与验证

输出仅发白名单字段、合法标识和固定安全原因；不输出简报正文、工具输出、路径、key/token、resumeRef、profile facts 或任意事件 data。错误也只发固定码。合成 version:1 主快照、归档 package、手写固定期望覆盖两角色多 Attempt、缺用量、真实/无裁剪、重复事件及 200 工具尾部；`node --test test/context-attribution-report.test.ts` 逐字段比较、核验输入文件前后 Buffer 一致和敏感哨兵不出现在输出/错误。全量回归用 `node --test`。本能力仅作离线归因观察，不运行真实 Mission 或 A/B。
