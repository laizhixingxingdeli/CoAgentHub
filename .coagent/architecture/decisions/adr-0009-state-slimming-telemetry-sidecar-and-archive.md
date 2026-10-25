# 状态文件瘦身：遥测事件外置边车 + Mission 归档启用（2026-10-26 已实施）

用户 2026-10-25 要求按实际运行数据出优化建议并直接实施；数据侧的诊断已完成，本 ADR 记录由此提出的存储决策。**2026-10-26 经用户「修复ADR-0009」授权直接实施**，要点：

- 遥测外置：`runtime.command.started` / `runtime.tool.completed` 写入 `.coagent-events/<missionId>.ndjson`（append-only，追加不触发整份落盘），主状态与读方 `list()` / `all()` 归并拼接，协议与事件形状不变；排他启动一次性迁移存量（幂等，第二次零写入）。实测 97MB 状态每次 flush 阻塞约 0.75s、延迟双峰 10ms↔785ms——这两类占事件字节 58%、条数 69%，外置后主状态不再随它们增长。
- 归档启用：既有 `archiveMission` 机制（守卫、hash 钉包、读侧全部就绪）从未被调用；排他启动清扫 `completed + mergedInto` 且 mergedAt 超过 30 天的 Mission。blocked / parked 不动（35 条僵尸 blocked 仍留工作集，处置另行）。
- 都挂在 `startupMaintenance`（仅常驻服务启动），失败只记 warning 不挡启动。

## 数据（2026-10-25 只读诊断，25 个活跃日）

- `.coagent-state.json` 已到 **100 MB**（81,096 条事件、214 个 Mission、652 份 VR），近期增速约 4 MB/活跃日。
- 事件字节里 **58% 是两条纯遥测**：`runtime.tool.completed` 15.1 MB（33,121 条）＋ `runtime.command.started` 9.8 MB（22,962 条）；按条数算这两类占 69%。
- `flush()` 是同步整份序列化＋临时文件＋rename（`file-store.ts`）。`docs/file-store-performance.md` 的基线：50 MB → 245–302 ms，期间事件循环全停（HTTP / SSE / 定时器）。100 MB 线性外推约 0.5 s+，且随历史线性恶化；POOLS1（池健康 1.1–1.4 s 同步扫描）已经为同一根因打过一次缓存补丁。
- 状态里的 `archivedMissions` 数组**一直是空的**：`file-store-performance.md` 把「Mission 完成后进 archive、主状态只留 working 集」当成既定减压机制，但生产从未启用。

## 决定（待实施）

1. **遥测外置**：`runtime.command.started` / `runtime.tool.completed` 不再进主状态的事件日志，改为 append-only 边车文件（按 attempt 或按日一份，放 artifacts 目录旁）。主状态只留领域事件。需要逐工具耗时的读方（time-attribution 的工具区间、context-replay 报告）改读边车；`ActivityLog.append` 的落点按事件 kind 分流，协议与事件形状不变。
2. **归档启用**：completed 且已合入（`finalReview.mergedInto` 存在）超过约 30 天的 Mission 移入 `archivedMissions`；parked / blocked / 进行中的一律不动。默认列表与 pools-health 扫描只看 working 集；Mission 详情与活动视图按需读归档。归档是搬家不是删除，Work Truth 不丢。
3. **继续不做**：不引数据库、不改「零第三方依赖」不变量、不做节流落盘（崩溃丢状态违反耐久契约）。`file-store-performance.md` 说的顺序——先做外置与归档、再看实测 flush 延迟——维持不变；现在数据已经有了：100 MB / 约 0.5 s。

## 预期收益

- 主状态回到 ~20–30 MB 量级（去掉 25 MB 遥测＋约 21.6 MB 已完成 Mission 大头），`flush()` 回到几十毫秒；
- POOLS1 一类「扫全部历史」的读路径不再需要为历史体量打补丁；
- 增速与历史脱钩：边车只追加、归档不参与热路径。

## 碰到的既有测试与不变量（实施票要点名）

- `ActivityLog.append` 不收 `at` 的不变量（COM5）不变；分流只按 kind，不改事件内容。
- time-attribution 的纯投影（`projectTimeAttribution`）输入源要换边车，`specs/time-attribution.md` 与其测试随之改。
- 归档要过 `specs/`（Mission 结果、投递修复 `repairMissingDeliveries` 都按 Mission 存在性判断，`isArchivedMission` 钩子已在）。
- 事件序列化形状被 `test/` 多处字节级比对钉着（fixtures），改存储格式要逐个核对。

## 什么时候该推翻它

- 需要跨全历史实时分析遥测（比如全库候选失败率趋势入 UI），边车读放大不可接受；
- 边车文件数量失控（每 attempt 一份太碎），改为按日合并或内嵌轻量索引；
- 出现第二个写者（远端执行器）——那要重新谈整个文件存储。
