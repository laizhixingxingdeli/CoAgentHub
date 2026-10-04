# Mission 结构化交卷与平台附件

## 逐条结论

协调者交卷的 `criteria` 对应契约每条验收标准，字段固定为 `{ index: number, status: 'pass' | 'fail' | 'unverified' | 'not_applicable', evidence: string }`，index 从 1 开始。平台在写入前校验数量与契约一致、序号完整且不重复、状态和字段形状合法；`not_applicable` 必须给出非空理由。形状非法时报 `MISSION_RESULT_CRITERIA_INVALID`。

历史结果或兼容调用可以缺少 criteria，但缺失不能自动合并。旧 `acceptanceEvidence` 仍保存，不承担自动合并判定。

## 平台附件

平台在交卷记录的 `attachments` 中自动记录：

- `lastFullTest`：可取得的 Mission worktree 最后一次全量 `node --test` 结果行及来源，来自证据或工作项验证报告。
- `diffStats`：相对集成分支的文件数、增删行。
- `criterionWorkItems`：契约每条标准关联的 WorkItem ID，来自工作项 criteria；没有关联为空列表。
- 无法取得的来源用 null 和 `unavailable` 说明，不伪造验证结果。

附件是平台事实，与协调者 criteria 判断分开。

## 机器终审闸门

`finalizeMissionByMachine` 在任何工作区合并、集成验证和记忆落地副作用前检查逐条结论。仅全部 `pass` 或带理由的 `not_applicable` 放行；缺 criteria、`fail`、`unverified` 或非法结构都保持 `awaiting_review`、设置 `waiting_l3`，并创建普通可答复 Mission 升级，列明未达成条目，交检视者决定。

相同问题已有未答复升级时不重复投递。答复升级不等于把 criteria 改为 pass，不能绕过闸门。放行后仍须走既有集成合并与验证，不能仅凭 criteria 跳过验证。

## 权威源与关键验证

- `src/kernel/payloads.ts`：结果与附件类型。
- `src/application/platform/mission-result-criteria.ts`：写入校验与机器闸门诊断。
- `src/application/platform/mission-result-attachments.ts`：平台附件采集。
- `src/application/platform/mission-control.ts`：交卷接线。
- `src/application/platform/machine-finalization.ts`：机器终审闸门。
- `test/machine-finalize.test.ts`：全部 pass 可合并且附件存在；unverified 不合并、不验证，升级可答复。

不改变人工终审权威、快车道或网页展示。
