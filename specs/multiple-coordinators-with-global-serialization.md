# Spec: 多协调者并存与全局串行

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-31

## 1. 背景与目标

本群现存两个 coordinator 成员(Codex 与 dsh)。代码层**没有**单协调者假设,
但存在两个缺口:

1. **规范缺口**:`specs/dispatch-to-role.md` 只定义「audience=role → 选一个目标
   成员」,没有多协调者语义——检视者不知道可以显式选人,也不知道默认顺序
   是什么、可不可控。
2. **安全缺口**:`resolveRoleTarget`(`packages/backend/server/src/lib/executor-task/queue.ts:619`)
   的并发判定按**单个执行器**计数(`runningExecutorCount(ex.key) >= cap`,
   L653-654)。两个协调者是不同 executor key,各自 max_concurrency=1 互不感知
   → **可能同时各跑一张票**。协调者任务是真并行 OS 进程、共用一棵 git 工作
   树,历史上批量下发已造成过真实冲突(被迫 kill + reset)。

**目标**:多协调者并存成为一等公民——检视者可显式选人,额度不足自动分流,
同时全群任一时刻**只有一个协调者进程在跑**。

## 2. 改动范围

- **平台代码**:`queue.ts` 派发链——协调任务增加全局并发约束(见 R1)。
- **规范文本**:`skills/coordinator/SKILL.md`、`skills/reviewer/SKILL.md` 各补
  一小节(见 R2/R3)。
- 不动 `routes/group/messages.ts`(DK 票 `01a055a8` 正在改同一派发链的另一处,
  本票与其文件不重叠,但**必须串行下发**,等 DK 关票后再发本票)。

## 3. 详细改动

### R1(必须,代码)协调任务全局并发 = 1

- 「协调任务」的判定:任务的**目标 participant 在本群持有 coordinator 角色**
  ——与 `queue.ts:403` 的角色判定同源,不新造第二套判据。
- 派发时刻(spawn 之前)检查:**全群已存在 status=running 且目标为协调者的
  任务** → 本任务不得 spawn,进入等待;前一个协调任务进入终态后,等待中的
  协调任务按创建顺序拉起。
- 等待/拉起机制优先复用现有排队路径(`resolveRoleTarget` 的 fallback 分支
  已有「不可用 → 排队等可用」语义),不新建调度器;若现有机制无法表达
  「跨执行器的全局等待」,允许在汇报中说明并最小化扩展。
- 约束对象是**协调任务**,执行器任务(目标为 executor/specialist 角色)的
  并发语义逐字不变。
- 续跑任务(coordinator-resume)同样是协调任务,同样计入全局并发额度
  ——它在父协调任务存活检查之外,不得成为绕过全局并发的旁路。

### R2(规范文本)检视者显式选择协调者

写入 reviewer skill:

- 检视者可以用 `audience: "participant"` + `audienceRef: <协调者 participant ID>`
  显式指定接单的协调者。该通道现有代码已支持(与 role 定向走完全相同的
  任务创建流程,`queue.ts:555-590`),本条**只写规范,不改代码**。
- 显式定向时**必须**仍满足 R1 的全局并发约束——选人不豁免串行。

### R3(规范文本)role 定向的默认优先级 = 检视者读 prompt 自行判断

- 平台侧 `resolveRoleTarget` 保持现状(按成员顺序取第一个可用:冷却排除、
  并发排除、全排除则 fallback 排队)。**不得**在平台侧引入 prompt 关键词
  计分——语义判断发生在 LLM 在场的时刻,服务端机械规则已被
  `reviewer-role-spec-generation.md` §3.14 明确反对(与 `resolveTestExecutor`
  的区别一节)。
- 写入 reviewer skill:发票前若对协调者有偏好,读各协调者在本群的
  `group_members.prompt` 分工说明,用 R2 的 participant 定向显式选人;
  无偏好时用 role 定向兜底,接受平台按可用性分流。
- 写入 coordinator skill:多协调者并存是合法形态;额度不足被跳过、
  票分流到另一协调者是正常行为,不是故障。

## 4. 验收标准

1. 协调者 A 的任务 running 时,给协调者 B(不同 executor key)发第二张
   coordinator 定向票(role 或 participant 均可)→ **B 的任务不 spawn**,
   状态等待;A 终态后 B 被拉起。⚠️ 本票存在的直接理由,必测。
2. 全局等待按创建顺序拉起,不丢任务、不重复拉起(同一任务只 spawn 一次)。必测。
3. 执行器任务并发语义回归:执行器任务不受协调任务占用影响,可正常派发
   (协调者 A 在跑、其子执行器任务正常 spawn)。必测。
4. 单协调者场景回归:`audience: role, audienceRef: coordinator` 行为与现状
   逐字一致(选择、排队、fallback)。必测。
5. participant 显式定向到协调者 → 任务落在该协调者,不经 role 解析(现状
   已然,回归确认)。
6. 续跑任务计入并发额度:协调任务 running 时,另一协调任务的续跑创建同样
   受阻(或按实现说明的等价约束)。
7. 全协调者冷却/不可用时:行为与现状 fallback 排队一致(回归)。

## 5. 不涉及的改动

- 不改 `routes/group/messages.ts` 的 dispatchKind 裁定(DK 票范围)。
- 不改执行器选择规则(§3.14 既有纪律)。
- 不改 `executor_config` 结构、不加优先级字段。
- 不建 prompt 关键词表或任何平台侧语义排序。
- 不改 WS / 完成事件投递机制。

## 6. 兼容性

- 单协调者部署:全局并发=1 与该协调者自身 max_concurrency=1 语义重合,
  行为不变。
- 与在途任务:本票上线时已 running 的任务不受影响;约束只作用于新派发。
- 与 DK 票串行:两票都触及派发链,先 DK 关票、后本票下发,避免同树并发
  实现冲突。
