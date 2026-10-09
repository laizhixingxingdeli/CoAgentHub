# 平台工具注册与协调者工单交接

`src/tools.ts` 的协调者工具表独占 `coagent_revise_work_order`、`coagent_get_work_item`、`coagent_submit_contract_check`、`coagent_get_validation_report`，执行者及其他角色不暴露这些工具。工具沿既有 `PlatformClient.call(spec.name, body)` 按同名 POST `/api/agent/<工具名>` 透传，不在适配器另立规则。

`coagent_get_validation_report` 入参为 `{workItemId: string, reportId?: string}`，请求body只投影这两个业务字段，同名POST平台路径。摘要不够时（失败、要看失败细节、要核对计数与来源）读全文，不为索取全文升级给L3。

`coagent_get_work_item` 入参为 `{workItemId}`；`coagent_submit_contract_check` 为 `{verdict:'ok'|'issues', summary, issues?}`；`coagent_revise_work_order` 为 `workItemId` 加整份工单字段（不带 title）。create/revise 共用可选 `validation`：`commands: {argv:string[],timeoutMs:number}[]`，可选 `forbiddenPaths:string[]`、`diffSize:{maxChangedFiles?:number,maxChangedLines?:number}`。

create/revise 另有可选 `criteria:number[]`，表示覆盖的契约验收标准序号，从 1 开始。`coagent_submit_mission_result` 必填 `criteria:{index:number,status:'pass'|'fail'|'unverified'|'not_applicable',evidence:string}[]`；字段均原样透传，合法性与合并规则由平台负责。

`src/roles.ts` 指导协调者将核对结论同时写 findings 与 contract check、按 id 用 get_work_item 读完整详情、partial/blocked 后修订可修订的工单，并把 verification 命令同时写入 validation.commands 供平台自动运行。交卷 criteria 每条契约验收标准一项，照实填状态与证据；没全部 pass 平台不会自动合并。契约核对verdict=issues时平台自动将issues升级给L3，协调者不再调用coagent_escalate_to_l3；裁决问题、证据与推荐做法写入issues，当跳不派工并直接结束。其他契约不成立或执行中目标、验收、边界问题的升级场景保留。平台侧接口实现不属于适配器。
