# 离线 Attempt 用量基线

`scripts/context-replay-report.mjs` 只读显式指定的 version:1 状态 JSON，接受 `--input E1 <path>` / `--input main <path>`（可多次）及可选 `--report <path>`；只扫描 `projects[].missions[].coordinatorAttempts[]` 与 `projects[].missions[].workItems[].attempts[]`，并要求 Attempt.kind 与所在数组对应。输入不存在或不合法时退出 2，输出 `CONTEXT_REPLAY_INPUT_ERROR`，不创建报告且不回显路径。

每个来源独立按 sourceLabel、missionId、role 分组，不跨文件去重。JSON stdout 和可选报告只含 sourceLabel、missionId、role、attemptsTotal、usageReportedCount、usageUnknownCount、input、output、cacheRead、cacheWrite。只有 usage.quality 为 reported 且四个分项都是非负整数时才纳入用量分项；否则只增加 unknown。四项是**已报告用量的分项合计**，cacheRead 仅表示缓存读取 token 数，并非 prompt 重放或可删除上下文。

没有用真实快照跑过之前，不存在历史统计：prompt 重放量、可删除上下文量、逐跳趋势和跨源覆盖率一律按「未知」对待，不能拿合成夹具的结果推断实际用量。以 `node --test test/context-replay-report.test.ts` 复验合成案例。
