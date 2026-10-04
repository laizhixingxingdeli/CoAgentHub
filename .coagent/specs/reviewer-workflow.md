# 检视者工作流

2026-10-03 直接实施：RV1–RV5 后端与可选 MCP 补充入口。公开 HTTP 契约见 `docs/http-api.md`；不包含前端界面设计。

统一待办从 Mission、交卷和持久 Activity 重建，涵盖普通问题、诊断、费用上限、检查点、交卷与文档提议。问题解决后来源消失；确认记录持久且幂等，只停止通知；等用户 park，不绕费用或检查点门禁。读取不消费或 ACK Delivery。当前服务承载的 PlanRun 升级使用单独决策入口，历史来源回到 Mission 处理路径。

项目值守单一 owner，租约五分钟、客户端建议每分钟续约；领取、续约、交接、释放写入主仓储事务中的审计事件。交接及到期后重领递增 generation，旧代次写入或守候拒绝。不引入第二个状态写者，也不新增鉴权默认策略；未采用值守协议的旧调用方式兼容。

MCP 补充工具仅经本机 HTTP，stdio 采用逐行 JSON-RPC、初始化握手和 tools/list、tools/call；不支持任意 URL，不安装依赖、不改 Codex 配置或现有插件。显式守候只通知变化、不自动执行决定、不创建定时任务。

合 master 简报从可信工作区读取分支、提交、文件和已合入 Mission 验收/风险/文档/费用；核对干净集成分支、运行状态、HEAD 稳定及当前 HEAD 的可信全量报告。缺失报告或仍有尝试时不标就绪；接口永远不合 master，仍需用户明确签字。

文档提议独立于代码：交卷即保存 changes 精确替换差异，旧 body 只作兼容的整体替换提议；没有批准不会写入 `.coagent/`。坏提议进入 needs_revision，不阻止代码合入。检视者规则也走独立提议入口，批准签名及基线哈希必须先持久保存。

排队中可编辑、撤回；编辑递增版本并取消旧批准。批准核对已审阅的 revision/baseHash，原文变化必须重新编辑、重审。匹配统一 LF，before 唯一匹配，新文档空 before，不做模糊合并。未改条款保持不动。

空档提交要求项目没有未结束且未 park 的 Mission，没有 in_progress Attempt，目标为干净集成分支。文档和生成 VIBE.md 在隔离 worktree 提交，再核对 root HEAD/分支/干净状态并 fast-forward 落地；不改 root 未提交文件或索引。禁止路径遍历、符号链接和 Windows 设备名。Git 成功/队列确认丢失可凭提交标记及目标内容恢复，不重复提交；未处理文档阻止源 Mission 归档。

## Codex L3 插件托管入口（2026-10-04）
coagenthub-codex 0.2.2 经 POST /api/missions 创建 Standard Mission，经 POST /api/control/run-mission 启动服务托管运行。Contract 由平台保存并在启动时读取，Delivery 接收方来自真实会话绑定或显式 recipient；start 不能覆盖合同。GET /api/platform/status 仅返回持锁身份和运行观测，不让适配器访问状态文件。插件消费 NDJSON 长流并提供进程内有界观测；HTTP受理、启动确认、退出和业务交卷是不同状态，断流未知不自动重试。当前未实现跨 MCP 实例的启动去重，应先核实真实 runner；Delivery 仍由原桥接器实际投递后确认。
