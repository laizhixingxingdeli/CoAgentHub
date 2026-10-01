# Standard Mission 派发前的契约核对

协调者在首次派发前核对当前契约的验收涉及文件与允许范围、输入位置、诊断依据及验收之间的一致性。`POST /api/agent/coagent_submit_contract_check` 接受 `{ verdict: "ok" | "issues", summary: string, issues?: string[] }`，仅协调者 Attempt 可提交；summary 不可空，issues 结论须列非空问题。平台以 `contract_check.submitted` 事件记下契约修订号、结论和摘要；issues 同时经既有 Mission 升级通道创建一条可由 L3 答复的升级，并记录对应索引。

Standard 派发读取事件，必须有当前契约修订的核对结论；缺失时拒绝并提示先提交核对，契约修订后旧结论不解闸。最新的当前修订结论为 issues 时继续拒绝，直到 L3 对该次升级明确答复「照原契约做」，或 L3 修订契约后协调者重新核对并提交 ok。门禁在派发副作用之前执行；Lightweight 不经此协调者门禁。

协调者后续简报仅显示当前修订核对结论及可选 `contract_check` Bundle 来源；无当前结论则不显示，执行者简报不带此来源。Web 对 `contract_check.submitted` 有事件翻译。适配器工具注册及提示词另行实现，不在本能力的平台侧范围内。
