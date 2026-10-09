# 执行者会话终结提交提醒

在 src/runtime.ts 的 startRun 中，首次 session.prompt 返回后，仅 executor 且未终结提交、无上游失败、平台未不可达时，在同一会话追加一次中文提醒。提醒要求已完成调用 coagent_submit_execution_result，不能继续调用 coagent_report_blocked，未完成直接接着做，不重复长篇思考。

agent_end 记录最后 assistant 的 stopReason；length 时提醒前缀说明输出上限截断。不修改会话消息状态。提醒决策由单对象参数纯函数 executorReminder 产生。

每程最多提醒一次；其他角色不变。提醒后仍未提交时 output 记录提醒次数和触发提醒的 stopReason，即使第二轮失败也保留痕迹。endedBy 继续使用原有优先级与 no_structured_result；不新增事件或 outcome 字段。

验证接缝：src/agent-entry.integration.spec.ts 使用本地假模型与假平台。executor length→stop 验证两次请求、提醒和截断文字、原 user 上下文、未提交结果与日志；solo 验证不提醒。
