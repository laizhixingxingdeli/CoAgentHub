# Standard 工作项交卷后的机器验证报告

Standard 工作项的冻结工单带 `validation.commands` 时，执行者交卷后、下一跳协调者评审前，平台在可信 Mission 工作目录用现有 `ValidationEngine` 执行命令（argv、不经 shell、每条有超时），以执行者开始前持久记录的逐项基线检查 changed paths 是否落在该工单 `allowedScope`。复用冻结 `validation` 中的可选 forbiddenPaths、diffSize；不另设引擎、工单形状或 ReviewAuthority。验证报告先落到既有 append-only ValidationReport 仓储，再记 validation.reported；恢复时只对当前提交且尚无报告的尝试补验，避免重复执行命令。无 validation.commands 的 Standard 工作项保持原行为；Lightweight 路径不变。

验证通过或失败仅构成机器证据，不替代协调者逐条评审。Standard 工作项的当前提交若是 completed 且有绑定这次 attempt 的失败报告（包括命令失败或改动越界），或执行者报告 partial，平台各最多自动续派 2 次同一工作项：记 `work_item.auto_redispatched` 持久事件，退回并重新派发给新的执行者 attempt，交接上次失败报告摘要或 partial 说明；partial 在运行时支持时可续用同一会话。自动接续算执行次数，连续失败规则照常计数，且不受协调者手动重派 partial/blocked 必须先修订工单的门禁限制。第三次仍失败或 partial、执行者 blocked、缺报告或绿报告均保留提交给协调者；绿报告不自动评审。Lightweight 失败升级 Standard 前的原提交仍交给协调者，不因升级被 Standard 自动续派；升级后的新 Standard 提交仍可按上述规则接续。协调者工作项详情、索引、开跑简报的 work_items_index 与 since_last_hop 及 Mission 工作项视图提供报告简版：passed、逐命令 passed/durationMs、路径检查及越界文件，失败命令的 outputTail 经 `redactSecrets` 后截最后 1,000 字；当前提交的报告不得错挂到旧事件。完整报告可按 Mission 与 reportId 只读获取，禁止跨 Mission 读取。

关键验证接缝：`test/orchestrator-standard-validation.test.ts` 的两条 Standard 主链场景，分别覆盖验证失败自动接续及 partial 自动接续（中途无协调者 attempt）。关联能力：`validation-review-authority`（报告结构、引擎及 Lightweight 权威）。
