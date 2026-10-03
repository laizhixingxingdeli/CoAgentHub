# RV4 文档差异队列直接实施记录

用户继续要求直接实现；基线 `de55a5f`，独立分支 `codex/document-queue`。这是直接代码交付，不伪造真实 Mission 完成、平台验收或费用签名，真实服务保持停止。

交卷文档改为独立持久队列：人工/机器代码合入均不自动覆盖 memoryDelta；新提议给 changes 精确替换，旧 body 转成显式整体替换差异，仍要独立批准。错误提议进入 needs_revision，不阻止已验证代码完成。规则与架构提议也支持同一入口。

批准核对 revision/baseHash，先持久保存真实 reviewer/reason，再做 Git 副作用；编辑取消批准并递增版本，撤回不写 Git。运行中保留 approved 队列，包含 paused 未 park 的基线保护；空档在隔离 worktree 写文档和生成 VIBE.md，再核对 root 分支、HEAD、干净状态后 fast-forward，master 不动。基线漂移要求重审，不模糊合并，不改 root 未提交文件或索引。

Git 成功而队列确认丢失时，提交标记与文档内容支持重入，不重复提交。服务启动、批准后及 Mission 释放工作区会尝试处理，显式 flush 可重试；未处理提议阻止源 Mission 归档。统一待办在代码完成后仍保留文档项，文档等用户不 park 已完成代码。路径遍历、符号链接（包括断链）、Windows 设备名均拒绝；匹配与哈希统一 LF，兼容 Git CRLF 转换。

四个 HTTP 文档入口及四个 MCP 工具已接线；补充 MCP 总计十个工具，已安装 L3 插件及 Codex 配置未修改。CLI 读面支持只有 changes 的新交卷，不对缺省 body 调 split，不写状态。coagent-pi 独立分支 `codex/document-diff` 只改 tools.ts 与既有 tools.test.ts，将整份正文改为可选、增加差异字段，并取消工具说明中的自动随代码落地承诺；未升级 SDK 或依赖。

验证：Hub 全量 `node --test` 为 2353 tests / 2346 pass / 0 fail / 7 skip，198375.3442 ms，skip 仅既有 HAOFF1。日志 `C:/Users/echo/AppData/Local/Temp/coagent-document-queue-final-20261003.log`。末次 CLI 读面修复后又跑文档队列 2 条关键测试，包含临时状态的真实 CLI show、状态字节不变、审批/排队/持久恢复/编辑撤回/归档保护/漂移/脏工作区/master 拒写/Git 确认丢失恢复，2 pass / 0 fail；日志 `document-queue-cli-read.log`。适配器 tools.test.ts 10 pass / 0 fail；日志 `coagent-pi-document-test.log`。接口文档和事件叙事覆盖通过，`git diff --check` 通过。

本批没有在真实 AC4 运行上操作或重启服务，也没有把直接测试日志冒充平台 ValidationReport。文档提交会推进 HEAD，旧提交全量报告仍不能满足 master 简报的当前 HEAD 前置检查。

集成合入依据：「用户常设授权：集成分支合入由检视者签，仅合入 master 需用户签名（2026-09-28）」。master 保持 `83d5877`。剩余 UI1 后端、PL1、CLEAN1 / CLEAN3；鉴权、预算及前端仍按用户原决定暂缓。
