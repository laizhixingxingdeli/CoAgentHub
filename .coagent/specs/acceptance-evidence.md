# 契约原文留档

平台按契约修订留下验收原文。验收处置（reuse / revalidate / new_requirement）与交卷门禁已于 2026-10-24 移除：它们默认关闭、生产从未开启，协调者侧也没有注册工具。

## 契约原文历史

有契约的建 Mission 记 r1，reviseContract 每次 +1 再记一条。两者都在与 Mission 状态同一事务里写入，一起提交或回滚。每条含 missionId、contractRevision、acceptance 原文数组（不 trim）和平台时钟 at。内存与同一 FileStateStore 可读；legacy 缺集合按空数组。没有历史的旧 Mission 或旧修订视为原文未知。未装配仓储与 PG 模式明确 unsupported，不隐式回退。没有契约的 Mission（contractRevision 仍为 0）不写历史行，也不因留档求值抛错。kernel 的 reviseContract 语义不变。

同键同内容（at 不同）重试幂等，不新增也不改已有 at；同键异内容抛 `CONTRACT_HISTORY_CONFLICT`，盘上原记录一字不变。
