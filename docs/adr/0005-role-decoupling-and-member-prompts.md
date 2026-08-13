# ADR-0005:角色解绑与群内提示词

**状态**:已接受(2026-08)

## 背景
最初把"执行器名↔角色"隐含绑定(atomcode=写代码);需要支持同一 participant 在不同群担任
不同职责,且分工可细化。

## 决策
- participant 是**身份**,角色是**群内职务**:任何 participant 可在任何群持任意技术角色
  (coordinator/executor/reviewer/specialist/observer/human,驱动权限与可见性)。
- `group_members.prompt`:每个 (群,participant) 可配自定义提示词;该成员被定向调度时
  提示词拼进任务书;助手群记忆也纳入分工。
- 名字↔角色不再被假设,分工由 prompt 显式表达。

## 后果
- 职责清晰、可配置;执行器行为由任务书(含本群 prompt)驱动。
