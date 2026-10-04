# 三层沟通实现核对与修正（2026-10-04）

## 目标与边界
减少重复调查、无信息量的拆单往返和不明确返工，以完成时间为主要指标；不能通过放宽冻结目标、范围或验收来提速。本次不改变内核、工具 schema、平台状态与派发策略，不启动真实 agent，不合入任何 master。适配器使用独立开发分支，经测试合入 auto/harness-remaining；AC4 保持暂停。

## 当前实现证据
- src/application/context-builder.ts、platform/startup-brief.ts 已按角色生成契约/规划修订、工作项索引、sinceLastHop、当前契约核对；不是缺少上下文协议。
- platform/agent-view-helpers.ts 为执行者投影已答阻塞、previousRequiredChanges 与 L3 打回理由；增量验证报告校验当前 submittedAttemptId，不把旧提交报告冒充新提交。
- platform/work-orders.ts 在有 Plan 后才允许建单，校验 criteria；运行中或已有结果的工单不能就地改，修订记录字段差异和 orderRevision。
- kernel/work-item.ts 冻结工单，审查记录保存 submittedAttemptId；platform/work-item-review.ts 要求 reject 有 requiredChanges，逐条验收有 fail 不可 accept。最终交卷与机器验证另有门禁，提示词不是唯一防线。
- coagent-pi 集成分支已有 PI-adaptive-work-order，未重复执行该冻结票。

## 实际缺口与修正
适配器 src/extension.ts 的 fetchBrief 原先只显示规划方向和排除假设，未显示已确认发现、根因、决策和风险；也遗漏平台已经投影的工作项索引、上一跳变化、契约核对、前次返工要求与已答阻塞。模型被告知不要重复取简报材料，却拿不到这些材料，容易再次查询或调查。现在原字段按角色透传一次，执行者不收到协调者专用的机器验证与契约核对投影；未提供字段不编造内容，不把完整 contextBundle 或元数据重复注入。

src/roles.ts 原先自适应拆单与硬写 1–2 文件并存，执行者还有最多补查 5 次，且宣称拆细不增加成本。现在按完整可验收路径拆单，文件数是建议，承认执行会话与交接成本；允许冻结范围内必要局部补查，缺设计决策或越界仍报告 blocked。关键发现及时记录，相关发现合并提交，不逐条记录读取过程；打回写明验收原文、观察、预期与验证，保留已验收成果。

## 验证与生效
定向 roles/extension 测试 25 项通过；适配器全量 src/*.test.ts 147 项通过，整合后的最终全量结果待填写。新增一条集成简报测试，验证一次 run/brief 即带齐差距与增量、工单 r2 和 doNot 保留、角色信息隔离；工具权限原有测试继续通过。开发提交 5644a1c。使用该适配器集成路径的新进程会加载新简报与提示词，已运行的会话不热改。本次没有实际 Mission 对照实验，不能声称时间或 token 已下降。

## 尚未保证的事项
现有工单修订和提交/验证来源校验不等于所有在途 Attempt 都绑定不可变的 Contract 快照；L3 修改契约的过程、旧验收迁移与最终证据版本仍需逐项核对。本次未引入新版本门禁。历史规划与工单正文仍是当前投影，无法补造每次流转的完整快照。后续观察首次验收通过率、blocked/reject 往返、协调者唤醒次数、完成时间以及重复读/查次数；这些是观察指标，不新增次数或时长硬门禁。
