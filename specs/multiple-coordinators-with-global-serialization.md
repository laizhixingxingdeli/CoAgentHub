# Spec: 多协调者并存与工作树级协调串行

> **状态**: Ready for Implementation
> **版本**: 1.3
> **日期**: 2026-09-01

> **修订记录**
> - v1.3(2026-09-01):**灾难恢复版**。平台 `resetWorkspace` 回滚两次摧毁了
>   v1.1(80737a46,14:33 回滚)与 v1.2(b80428da,19:04 回滚)的提交
>   (reflog 铁证:reset 到 01a05617 / 01a0570f 的 checkpoint,检视者提交
>   落在 checkpoint 之后被一并抹掉)。且 v1.2 当时是基于回退后的 v1.0 文件
>   修改的,内部不一致——R1 主体仍是 v1.0 的 status=running 判据(死锁
>   设计)、§4 验收 3 仍是旧文「执行器任务不受协调任务占用影响」,与 R1
>   双向互斥本意正面矛盾;协调者任务 01a05b39 据此正确拒发并请求修订。
>   本版从 b80428da 对象恢复,完整并入 v1.1 R1(进程存活占用)+
>   v1.2 R1.1(认领超时豁免)+ 修复后的验收(9 条,验收 3 为双向互斥)。
>   ⚠️ 「回滚摧毁检视者提交」本身是独立严重缺陷,已记缺陷池,另行立票。
> - v1.2(2026-08-31):并入认领超时豁免(R1.1)与 R2 dsh 勘误(显式定向
>   依赖执行器配置存在)。该提交已被平台回滚摧毁,内容由本版承载。
> - v1.1(2026-08-31):修正 v1.0 R1 的**死锁缺陷**与过强约束。v1.0 以
>   「status=running 的协调任务」计并发——而父协调任务在等待 PATCH 回写
>   期间恒为 running,续跑任务只有被 spawn 才能做 L2 并关掉父任务 → 按字面
>   实现会让 wake-the-coordinator 整体死锁;「全群全局并发=1」也会不必要地
>   串行化不同 projectPath(零共享)的协调者。v1.1 改为**进程存活的协调任务
>   计入其工作树占用**,与 `maxConcurrentPerWorkspace`
>   (specs/serial-dispatch-guard.md)统一在同一棵闸上。该提交已被平台回滚
>   摧毁,内容由本版承载。
> - v1.0(2026-08-31):首发(全局并发=1,后被发现死锁缺陷)。

## 1. 背景与目标

本群两个 coordinator 成员(Codex 与 dsh)。代码层**没有**单协调者假设,
但存在两个缺口:

1. **规范缺口**:`specs/dispatch-to-role.md` 只定义「audience=role → 选一个
   目标成员」,没有多协调者语义——检视者不知道可以显式选人,也不知道默认
   顺序是什么、可不可控。
2. **安全缺口**(v1.1 修正表述):协调任务全部是 detached——spawn 后队列槽
   立即释放(`queue.ts` detached 分支:「队列槽位由 finally 照常释放」),
   因此**既不计入执行器并发,也不计入工作树闸**
   (`maxConcurrentPerWorkspace`,specs/serial-dispatch-guard.md——它只数
   `groupQueues` 里的 running 条目)。后果:同群两个协调进程可以同时存活
   (2026-08-31 实测:两个 codex 协调任务同时 running);更重要的是,
   **协调进程的 L2 测试代跑与执行器写树可以重叠**——既有工作树闸的结构性
   盲区。历史上批量下发造成的真实冲突(kill + reset)正是这一维缺失的
   极端形态,serial-dispatch-guard 修掉了执行器那一半,协调进程这一半
   仍然敞开。

**目标**:多协调者并存成为一等公民——检视者可显式选人,额度不足自动分流,
同时**同一棵工作树上任一时刻至多一个「写树方」**(存活协调进程或执行任务,
合并计入既有工作树闸)。

## 2. 改动范围

- **平台代码**:`queue.ts` 泵判定 + `state.ts` 占用计数——存活协调进程
  计入工作树占用(见 R1);`queue.ts` 认领超时豁免(见 R1.1)。
- **规范文本**:`skills/coordinator/SKILL.md`、`skills/reviewer/SKILL.md`
  各补一小节(见 R2/R3)。

## 3. 详细改动

### R1(必须,代码)进程存活的协调任务占用工作树闸

- 「协调任务」的判定:任务的**目标 participant 在本群持有 coordinator
  角色**——与 `queue.ts:403` 的角色判定同源,不新造第二套判据。
- **占用的判据是「进程存活」,不是「status=running」**:
  - 协调任务 spawn 后进程存活期间(`executor_pid` 存在且
    `process.kill(pid, 0)` 不抛 ESRCH,与孤儿收敛器同源判据),
    计入其群所绑 `projectPath` 的工作树占用;
  - 进程退出后(含「派完即退」的正常生命周期)即释放占用,
    **父任务在 DB 里 status=running 等待 PATCH 不占用**——
    这是 v1.0 死锁缺陷的修正点,续跑任务因此永远可以 spawn。
- 效果 = 同一棵工作树上,任意时刻至多一个「写树方」:
  执行器任务(既有 `maxConcurrentPerWorkspace` 已管)与存活协调进程
  (本票新增)合并计数。协调进程的 L2 测试代跑因此不会与执行器写树
  重叠——这是既有闸的结构性盲区(detached 任务 spawn 后即释放队列槽,
  `runningWorkspaceCount` 看不见它)。
- **跨工作树(不同 projectPath)互不影响**:两个协调者各绑不同项目的群
  可并行,不设全局闸。未绑定 projectPath 的群沿用 serial-dispatch-guard
  的既有口径(默认组单槽,不参与工作树闸)。
- 等待/拉起复用现有排队与泵机制(`groupQueues` / `pumpQueue`),
  不新建调度器;泵判定处新增上述占用来源即可。
- 执行器任务的并发语义逐字不变(它们本来就计入工作树闸)。
- 续跑任务(coordinator-resume)同样是协调任务:其**进程存活期间**计入
  工作树占用;它在父协调任务存活检查(coordinator-resume.ts R2)之外,
  不得成为绕过工作树占用的旁路。

### R1.1(代码)认领超时对「调度闸阻塞」豁免

`handleClaimTimeout`(queue.ts)已有额度冷却豁免(`isInCooldown` 直接
返回),但**没有工作树闸豁免**:任务因 `maxConcurrentPerWorkspace` 被泵
合法跳过、保持 queued 时,30 分钟后同样被标「任务未认领」failed。
2026-08-31 实证:AtomCode 实现任务 running 期间,Codex 续跑任务(同工作树)
连续两棒各卡满 30 分钟被误标 failed,每棒又触发新续跑——噪音循环直到执行
任务出终态。

修法(与 R1 同域):认领超时判定增加第二个豁免——任务仍在组队列中且
「工作树占用 ≥ 上限」(泵的跳过原因就是闸,不是遗弃)。判据复用泵的
占用计数(R1 引入的统一占用源),不另写第二套「队列是否阻塞」判定
(ADR-0009 第 2 条:同一事实——任务是否被合法调度阻塞——只能有一个
判定出处)。

### R2(规范文本)检视者显式选择协调者

写入 reviewer skill:

- 检视者可以用 `audience: "participant"` + `audienceRef: <协调者
  participant ID>` 显式指定接单的协调者。该通道现有代码已支持(与 role
  定向走完全相同的任务创建流程),本条**只写规范,不改代码**。
  ⚠️ **勘误**:显式定向的前提是目标 participant 绑定了 executor 配置
  (`findExecutorByParticipant` 命中),否则派发层静默跳过。dsh 的
  coordinator 身份(web 常驻)无配置、不可派发——**本条适用于绑定了
  执行器配置的协调者**(Codex;dsh-executor 形态是 executor 角色,
  不是 coordinator)。
- 显式定向时**必须**仍满足 R1 的工作树占用约束——选人不豁免串行。

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

## 4. 验收标准(共 9 条)

1. 协调者 A 的**进程存活**期间,给同群协调者 B(不同 executor key)发
   第二张 coordinator 定向票(role 或 participant 均可)→ **B 的任务不
   spawn**,排队等待;A 进程退出后 B 被拉起。⚠️ 本票存在的直接理由,必测。
2. **父任务 running ≠ 占用**(死锁修正的核心断言):协调者 A 已派完
   子任务、进程退出、父任务仍 status=running 等待 PATCH 时——
   (a) 续跑任务**必须能 spawn**(不得被本票阻塞);
   (b) 给 B 的新票也**必须能 spawn**。必测。
3. **双向互斥**(v1.3 修复项):协调进程存活期间,同工作树的**执行器任务
   不开始**(排队);协调进程退出后执行器任务被泵出。反向:执行器任务
   running 时,协调任务(新票或续跑)不 spawn,等执行器终态。
   必测(L2 测试代跑与执行器写树互斥是本票的直接目的)。
4. 等待任务按创建顺序拉起,不丢任务、不重复 spawn(同一任务只 spawn
   一次)。必测。
5. 单协调者场景回归:`audience: role, audienceRef: coordinator` 行为与
   现状逐字一致(选择、排队、fallback);「派完即退 → 续跑 → L2 →
   关父」全链路行为与现状逐字一致。必测。
6. participant 显式定向到协调者 → 任务落在该协调者,不经 role 解析
   (现状已然,回归确认)。
7. **跨工作树并行**:两个群绑不同 projectPath,各自的协调任务互不阻塞。
   必测。
8. 全协调者冷却/不可用时:行为与现状 fallback 排队一致(回归)。
9. **认领超时豁免(R1.1)**:同工作树已有任务 running(闸满)时,
   queued 任务超过 claimTimeoutMinutes(30)→ **不标 failed**,保持
   queued 等闸释放,闸释放后被正常泵出。反例回归:执行器冷却中同样
   豁免(现状);无闸阻塞且 30 分钟无人认领 → 仍标 failed(现状)。必测。

## 5. 不涉及的改动

- 不改 `routes/group/messages.ts` 的 dispatchKind 裁定(DK 票范围)。
- 不改执行器选择规则(§3.14 既有纪律)。
- 不改 `executor_config` 结构、不加优先级字段。
- 不建 prompt 关键词表或任何平台侧语义排序。
- 不改 WS / 完成事件投递机制。
- 不改 `resetWorkspace` 回滚机制本身(另票)。

## 6. 兼容性

- 单协调者部署:协调进程占用与其自身 max_concurrency=1 语义方向一致;
  「派完即退」使占用窗口极短,行为与现状几乎重合(新增的只有
  「协调进程存活时执行器排队」这一互斥,正是目的本身)。
- 与在途任务:本票上线时已 running 的任务不受影响;约束只作用于新派发。
- 与 wake-the-coordinator 兼容:占用判据(进程存活)与续跑创建的
  父进程存活检查同源同向——都只认「活进程」,不认「running 状态行」。
