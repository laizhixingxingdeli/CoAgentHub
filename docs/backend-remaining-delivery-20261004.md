# 剩余已确认后端交付（2026-10-04）

基线 6d42dfe，开发分支 codex/backend-remaining；按用户“继续，除了暂缓的”直接实施。真实平台任务保持原状态，本次不是平台交卷，不编造协调者/L2/L3 验收、费用或 confirmedBy。master 基线 83d58774d53c2ed035eea131916d5d89b433eebc，不操作 master、不推送。

|票|交付|关键证据|
|---|---|---|
|UI1 后端|补齐 classifier 有序池、停用、配置版本门禁及下一查询读取；QueryRun 保存实际候选、用量、失败并进入健康视图|classifier-pool 测试经过真实文件仓储及 HTTP：503替换、熔断跳过、配置更新、写工具拒绝、needs_mutation 不建 Mission|
|PL1|项目配置与已确认 Mission 清单、顺序及依赖推进；门禁/升级/费用/重试/挂起/终审仍由 Mission 承载|mission-queue 测试：整批拒绝不写半成品、CAS、持久恢复、配置固定、暂停恢复、临时服务实际派发、停止等待在途；PG 真库两实例恢复|
|PL1 终审|固定项目验证，人工签字同样运行集成验证；失败安全回滚并留 awaiting_review，机器不能覆盖配置|machine-finalize 新场景用真实临时 Git 仓库，人工/机器两条路径先失败回滚再重试成功|
|CLEAN1|无生产调用的播种、健康辅助函数、退役离线执行主体及自身 helper 清理|redundancy-cleanup-20261004.md 含引用盘点、前后文件与行数、逐项删除证据和保留导出表|
|CLEAN3|保留故障反例的表驱动测试、清理退役 helper 自测、修正 PG fixture 隔离与初始化|原14个计费/403输入预期均保留；PG 回归可重复运行，不与候选池测试相互清表|

## 验证与边界

最终在隔离 worktree 执行 node --test --test-timeout=300000：tests 2361 / pass 2354 / fail 0 / skipped 7。唯一 skip 是 HAOFF1 既有7项；PG 测试实际运行通过。timeout 只是测试等待护栏，不改变产品的费用或执行门禁。完整输出：<用户目录>/AppData/Local/Temp/backend-final-green-20261004.log。git diff --check 通过。

零依赖近似度量仅告警；两条依赖环涉及 context.ts/types.ts 的 import type 回到平台接口，不形成运行时循环。大文件与复杂分支告警不作为硬门禁，新调度职责已放独立模块；没有新增依赖或内核修改。API、模块地图、QueryRun 规格、ADR-0007、project.md、AGENTS 与运行手册已同步，既有规则保留。

集成分支签字使用真实常设授权：“用户常设授权：集成分支合入由检视者签，仅合入 master 需用户签名（2026-09-28）”。此授权只用于 Git 集成审查，不写进真实 Mission 完成记录。

仍暂缓：前端界面及 UI1 网页部分、D1d 鉴权、B7 预算扩展、R1 HTTP 传输。历史 PlanRun 查询/恢复保留，生产新 PlanRun 运行已退役；后续批次用 Mission 队列。服务 3101 保持停止，新代码没有部署到真实状态单写者；AC4 原任务与基线未改动。以上是代码交付边界，未把真实平台运行标成已完成。
