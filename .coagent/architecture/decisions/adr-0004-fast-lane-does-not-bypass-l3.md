# Fast Lane（Lightweight）不绕过 L3 / 审查权威

## 取舍

Lightweight 缩短 **L2 规划与协调者自验**，不缩短 **机器验收权威** 与 **L3 最终落地权**。

不采用：validator 通过即 `completed` / 自动 merge；或 Executor 自报证据视为 accept。

## 为什么

1. **落地权单点。** 与项目不变量一致：未经 L3 不得 completed。Fast Lane 若可自完成，Standard/Lightweight 会分裂成两套「完成」定义，审计与回滚无从对齐。
2. **执行者不能自验。** ReviewAuthority 无 executor 分支；Lightweight 的 accept 必须来自 ValidationEngine 签发的 validator authority，且 durable `ValidationReport` 联动一致。
3. **交卷 ≠ 完成。** `submitLightweightMissionForReview` 只到 `awaiting_review`；merge/send_back/abandon 仍走 `finalizeMission`（含目标 HEAD 校验与 memory 同提交落地）。

## 后果

- Lightweight trusted 方法仅进程内 Orchestrator 使用，不绑 HTTP/agent tools，降低「外部直接 accept」面。
- Standard 仍可走 coordinator review；两种权威形状并存，但最终 completed 闸门相同。
- 晋升到 Standard 后恢复协调者路径，不解除 L3。

## 什么时候该推翻它

- 产品明确允许「机器全绿即自动入主干」且接受无 L3 收据；
- 另有独立合规签署服务替代 L3（需新 ADR 定义权威移交）。

在那之前，「Fast Lane 就是要快到跳过人工」不是理由——快的是协调，不是落地权。
