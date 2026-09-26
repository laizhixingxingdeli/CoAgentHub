# HA 放行权威：人或显式配置的高保证 Principal

## 取舍

被判为 `high_assurance` 的功能点合进**集成分支**，由**人或显式配置的高保证 Principal**放行。不是任意控制面 operator、不是 Run Token、不是机器 L3、不是 Jev SHADOW。

**master 一律由用户放行。** 集成分支 → master 不在本 ADR 的代行范围里。

当前配置口径（E1 只把权威写死；配置文件与放行动作是后续事项）：

- 配置放在仓库与 worktree 之外，平台 API 与 agent 都写不了。
- 配置里登记高保证放行主体（检视者）与允许的目标分支，只限集成分支。
- 当前该主体是按用户常设授权（`haDelegation` / `reviewerSignature`）登记的检视者签名：用户点确认 = 给权限；记录上签 `reviewerId`，不写成 `human`。
- 不新增逐次确认界面。「可信的用户确认」就是这份常设授权，由部署者控制的配置落地。
- 放行时平台按配置核对；控制写鉴权（D1d）之后再叠加 operator 身份，不把「有 operator 凭据」当成高保证放行。
- 记录签 reviewerId、授权出处与平台时间。

不采用：把 CLI `--as` / `--confirmed-by` 两个任意字符串当成已核验确认；把 Jev SHADOW 判断当放行；机器 L3 放行 HA。

## 与既有 ADR

- **修订 ADR-0004**：原文「HA 合并永远要人 / 机器 L3 不放行 HA」收窄为「人或显式配置的高保证 Principal」。当前该 Principal 是按常设授权登记的检视者签名。「概率判断只选路、不开门」仍适用于分类和 Jev SHADOW，并不因此否定经配置、证据和确认约束的独立审批。
- **不修订 ADR-0002**：Decision/Jev 在 OFF/SHADOW 下无执行权威；SHADOW 仅审计。
- **不修订 ADR-0005**：软预算只告警，永不停、永不晋升。

## Jev

只列为未来移交。先 SHADOW：对每个 HA 合并给判断、只记录，与检视者 / 用户的实际决定比对，重点量误放行。ADVISORY / ENFORCED 必须另开 ADR 定义权威移交，本 ADR 不提前给 Jev 执行权威。

## 外部副作用

下列 HA 事实命中时，首版一律拒绝并给结构化理由，不进入放行：

- `productionDeployRelease`
- `externalPaidOp`
- `unrecoverableExternalSideEffect`
- `destructiveData`

凭据 / 权限及可 Git 回滚的集成分支代码改动，仍须证明实施动作不触发上述副作用。

## 判定点

授权判定收拢到 Application 的声明式 PolicyEngine：给定 Principal、动作、Run Context 与当前状态，返回 allow / deny 与稳定理由码。认证（解析凭据）在入口，授权在引擎；引擎不读时钟、不碰存储。未知角色、未知动作、与 Mission / Attempt / WorkItem 不匹配的身份默认拒绝。

本 ADR **不开放** HA 路由、不改机器终审对外行为、不实现配置读取。单独合入后，HA 分类建单与机器 HA 放行仍被拒绝。

## 为什么

1. **放行权威必须可指出处。** 只在 CLI 或 prompt 里约定「检视者代行」，审计时无法证明那一次确认发生过。常设授权写在部署者控制的配置里，平台按配置核对，出处才是同一份。
2. **人和配置的高保证主体不是机器、也不是概率模型。** 机器 L3 凭的是集成分支上的确定性集成验证，范围只有 lightweight + standard。Jev SHADOW 只产信号。把这两类抬成 HA 放行，等于用「碰巧绿了」或「模型觉得可以」开门。
3. **master 与集成分支分开。** 集成分支可丢、可回滚；master 不能靠常设代行混进去。

## 什么时候该推翻它

- 产品要求 HA 也可由机器 L3 凭集成验证放行，并接受无高保证 Principal 收据；
- Jev 完成 SHADOW 计量并另开 ADR 移交 ADVISORY / ENFORCED 权威；
- 出现独立合规签署服务，需新 ADR 定义权威移交。

在那之前，「先让 run-plan 把 HA 合进去再说」或「SHADOW 既然后端通了就让它放行」不是理由。

## 明确不在本 ADR 范围

- 凭据发放、轮换、Web 登录。
- 文件 / 网络 / 命令 / 环境变量沙箱。
- 独立 Reviewer Attempt 与 Run Token（后续事项）。
- HA 建单、受控放行实现、run-plan 跑 HA（后续事项）。
