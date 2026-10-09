# Attempt 上下文归因聚合报告

coagent-pi 在每个 `startRun` Attempt 内采集平台简报实际注入量及 SDK 可见工具返回，且只在终态 `AgentRunOutcome.contextMetrics` 上报一次平台 `ContextMetricsV1`。旧平台忽略这个可选字段时运行不受影响；不根据 tool.started、usage、cacheRead 或最终模型 token 数推断结果内容或缓存命中。

## 简报

coordinator/executor 等既有角色仍只从 `run/brief` 拉一次简报，随后每次 `before_agent_start` 注入缓存的渲染文本。可选 `onBriefInjected` 回调逐次给出实际简报文本的 UTF-8 字节数与 `contextBundle.entries` 中经校验的来源桶；最终只保留最后一次有效注入的 brief。来源限 `project_rules`、`environment_notes`、`contract`、`plan`、`final_review`、`work_order`，最多六项且不得重复；`estimatedTokens` 为可选非负整数，`truncated` 仅根据来源标志或实际 `budgetReport.omittedSources`。旧平台不提供有效 contextBundle 时不报 brief；不为测量传 budget，也不缓存 bundle 正文。solo 与 independent_reviewer 不拉 run/brief，query 不装配平台扩展。

## 工具与 read

仅统计 SDK `tool_execution_start` / `tool_execution_end` 的 `read`、`grep`、`find`、`ls`、`bash`，按 callId 配对；calls 来自 start，returnedUtf8Bytes 只计成功 end.result.content 内可见 text 的 UTF-8 字节。read 对 start.args.path 和 end 可见 text 分别做同一 Attempt 随机盐前缀的 SHA-256 小写十六进制摘要；同 pathDigest/contentDigest 聚合 repeats，路径相同内容变化则分桶，最多 64 桶。遍历各 content text 块时即时计数并更新 hash，不额外储存结果正文；非文本结果不猜字节。只导出 version、coverage、brief、tools、reads 的 V1 字段，数值上限 1e9，JSON 不超过 32 KiB；不导出原路径、正文、请求/响应、盐或额外度量。

## 覆盖率

只有简报和工具观测完整且简报实际注入恰好一次时为 `complete`，并包含 brief/tools/reads（后两者可为空数组）。同跳多次注入、工具结果事件缺失、执行失败、SDK 截断、非文本/未知结果、未配对或重复工具 ID、read 桶超限时为 `partial`；完全没有可观测量时为 `unknown`。没有有效 contextBundle 的旧平台不报 brief，也不宣称 complete。不报告注入次数、同跳历史大小等 V1 合同外指标。

## 验证

`src/extension.spec.ts` 覆盖多轮注入、旧平台和敏感简报；`src/runtime.spec.ts` 覆盖相同/变化 read、五类工具、缺失/失败/截断/重复 ID、大文本多块及序列化不泄漏；全量回归运行 `node --import tsx --test src/*.spec.ts`。
