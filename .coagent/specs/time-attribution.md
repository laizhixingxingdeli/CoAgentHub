# 时间归因

应用层纯函数 projectTimeAttribution 将活动、验证报告起止及本 Mission hop 投影成 schemaVersion 1、coverage（complete / partial / unknown）、totalOccupiedMs 与 phases。阶段 kind 闭集：queue、hop_backoff、schedule_select、agent_run、tool、validation、l2_review、waiting_decision、pause、park、unclassified。

未知时长为 null；缺结束事实不使用当前时间、token、contextMetrics、waiting.detail 或 hop.updatedAt 补算。工具按 attemptId+callId 去重并取区间并集；agent_run 减已知工具并集所得剩余叫「未分类」，相关工具未知则剩余未知。验证与运行重叠时两者显示并标 overlaps，总占用取并集，不双计。矛盾的 attempt.ended 使该跳未知，不求和；usage 只原样来自 attempt.ended。l2_review 仅有记录时点，不拿整跳冒充评审耗时。

runtime.tool.completed 经与工具开始相同的串行持久化队列写入，按 attemptId+callId 幂等，不增加命令开始计数；旧适配器缺结束不补造。活动 at 始终是平台落盘时钟，工具时长是完成 at 减开始 at，误差为两次落盘延迟之差。hop.enqueued / hop.claimed / hop.backoff 的发生时点在 data；首次认领的 data.claimedAt 不受续租覆盖，renew 不发认领事件。当前投影继续按事件 at 计时。

Platform.getTimeAttribution 是独立只读方法，按活动引用读取本 Mission 验证报告，仅白名单取身份与起止，不带 outputTail；hop 按 Mission 过滤。GET /api/missions/:id 在既有 missionRead 授权下附带 timeAttribution，不让 getMissionView 其他调用方承担计算成本。

任务页只在既有 stage-head 显示阶段耗时及「未知」「未分类」，保留 token、发生顺序和单条时间线，不在浏览器重新归因。历史事件不足仍可返回未知。