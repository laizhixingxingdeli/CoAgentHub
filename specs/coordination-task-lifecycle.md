# Spec: 协调任务的生命周期与平台的完成路径冲突

> **状态**: Landed — L3 通过(2026-08-23,检视者),见文末「L3 检视记录」
> **版本**: 1.0
> **日期**: 2026-08-23
> **来源**: 三层链路首次端到端实测(群 `01a029c4-b67f-737d-837e-e49933fd3e38`)
> **上游契约**: `specs/reviewer-role-spec-generation.md` v3.8 §3.17.4

## 背景:实测把 §3.17.4 打穿了

v3.8 §3.17.4 规定:协调者 L2 通过后,**PATCH 自己那条 detached 任务为终态**,
DB trigger 写完成事件唤醒检视者做 L3。

首次真实跑这条链路,时间线如下(全部实测,非推断):

```
17:39:56  检视者 → codex,平台建 detached 协调任务 01a02a8e-cc98
17:41:04  codex 下发实现票给 atomcode
17:43:50  codex 进程退出 → 平台解析其 stdout 为汇报 → 协调任务自动 done
17:43:50  atomcode 才刚 🚀 开始执行
```

**协调任务在被协调的任务开工的同一秒就已经终态了。**

产物是这样的:

| 字段 | 值 |
|---|---|
| `hash` | `40e1a8f` —— 那是 **specHash,不是 commit** |
| `summary` | `<做了什么,3-5 句>` —— 任务书模板占位符 |
| `tests` | `<测试结果摘要>` —— 占位符 |
| `todo` | `<未完成事项,无则写"无">` + **67,066 字符的 codex 全量转录** |
| `review_request` | **不存在** |

完成事件照常写进了检视者收件箱(trigger 本身工作正常)。也就是说:
**检视者会被唤醒去做 L3,而被检视的工作根本还没开始。**

---

## 缺陷一:平台的完成路径与协调任务的语义冲突(根因)

### 现状

`lib/executor-task/queue.ts` 的完成路径对**所有任务一视同仁**:
spawn 出去的进程退出 → 解析 stdout 为汇报 → 落终态。

对普通执行器任务这是对的:进程退出 = 活干完了。

对协调任务这是错的:协调者的**进程生命周期远短于它的协调职责**。
它下发完就退出了,而 L2 检视要等被派的执行器跑完才能做——那可能是半小时后。

### 为什么 codex 不背这个锅

codex 转录里自己写着:

> "This is a coordinator ticket, so I'm loading the coordinator procedure and the
> frozen spec before touching code."

它读了 skill、也照做了。§3.17.4 要求它「L2 通过后 PATCH 自己那条任务」——
但**平台先替它 PATCH 了**,它没有机会。这不是 skill 不合规,是它做不到。

### 要求

- 协调任务(以及任何职责跨越自身进程生命周期的任务)**不得因进程退出而自动落终态**
- 普通执行器任务的行为**保持不变**(进程退出 → 汇报 → done,这是对的)
- 判别方式自行设计,**在汇报里说明选了哪种及理由**。可用的现成信号:
  - 该任务的执行目标在本群的 `group_members.roles` 含 `coordinator`
  - 该任务的 `dispatcherParticipantId` 指向一个 `reviewer` 角色成员
  - **不要新增「模式」字段**——协作模式由成员构成实时推导,平台不感知模式
    (v3.8 §3.14,理由见 §3.14.1)
- 这类任务的终态**只能由显式 PATCH 产生**。`routes/group/tasks.ts:376` 的
  「生命周期字段仅执行器本人可改」正好允许协调者 PATCH 自己那条,权限侧无需改动

### ⚠️ 必须一并回答的问题:协调者退出后,谁把它叫回来

只做上面这条会得到一个**永远不终态的僵尸任务**:codex 进程已退出,
没有任何东西会在 atomcode 跑完时把它拉起来做 L2。

实测已确认这条唤醒链也是断的:codex 派给 atomcode 的那张票
(`01a02a8f-d391`)`dispatcherSessionId` 与 `callbackRef` **都是 null**,
所以 atomcode 完成时不会回传给 codex。

- 本票必须让「执行器完成 → 协调者被唤醒做 L2」这条路走得通
- 若结论是「问题出在 coagenthub-codex 插件的 MCP dispatch 没带 callback」
  (`mcp-server/src/tools.ts:70` 的 `autoCallbackEnabled` 分支),
  **不要在本仓强行绕过**——把结论写进汇报,由检视者另行立票
- 兜底超时(`detachedTimeoutMinutes: 1440`)**不算解决方案**:
  它是安全网,不是唤醒机制

---

## 缺陷二:汇报解析把 6.7 万字符吞进 todo

`lib/executor-task/report.ts` 的 `parseTaskReport` 认到「遗留」段之后,
把后面**所有内容**都收进了 `todo`——包括 codex 的完整执行转录。

`6157e16` 加过「跳过 `<...>` 占位符段落」的修复,但本次三个字段
(`summary`/`tests`/`todo`)**全是占位符原样落库**,说明该修复没覆盖这条路径。

### 要求

- 汇报各段**必须有边界**:一段的内容在下一段标题处结束,没有下一段则有长度上限
- 占位符段(`<...>` 形态)**不落库**——现有意图如此,让它真的生效
- 上限数值自行判断,但**必须有**(6.7 万字符进一个字段是不可接受的)
- 新增测试:占位符全套输入、段后跟大量无关文本、无结束标题的末段

---

## 验收标准

### 缺陷一
- [ ] 协调任务不因进程退出而自动落终态
- [ ] 普通执行器任务行为不变(有回归测试证明)
- [ ] 判别方式已在汇报中说明,且**未新增模式字段/配置项**
- [ ] 「执行器完成 → 协调者被唤醒」这条路可走通,或已明确指出断点在插件侧
- [ ] 新增测试覆盖:协调任务进程退出后仍非终态;显式 PATCH 后才终态

### 缺陷二
- [ ] 汇报各段有边界,不会吞掉后续全部文本
- [ ] `<...>` 占位符不落库
- [ ] 新增测试覆盖三种情况(全占位符 / 段后大量文本 / 末段无结束标题)

### 共同
- [ ] `pnpm --filter server test` 全绿(先跑一次确认基线,不得减少)

## 不涉及

- **不改** DB trigger(`0018_task_completion_events.sql` 的 trigger 工作正常,
  实测已确认事件正确写入检视者收件箱)
- **不改** `routes/group/tasks.ts` 的 PATCH 权限模型
- **不改** coagenthub-codex 插件(不同仓;若断点在那边,写进汇报另行立票)
- **不改** v3.8 §3.17.4 本身——本票是让平台**支持**该设计,不是改设计
- 不引入新依赖

## 执行环境提示

- 本仓是 **pnpm** 项目
- 后端以 `pnpm --filter server start`(无 watch)运行中:改完需手动 build + restart
- ⚠️ **本仓当前有一个正在运行的执行器任务**(atomcode 在做 `specs/executor-output-ansi-strip.md`,
  改的是 `lib/executor-task/queue.ts` 的 `onOutput` 与 `output-buffer.ts`)。
  **本票也要改 `queue.ts`——先 `git log`/`git status` 看清当前状态再动手**,
  不要覆盖它的改动。有冲突就等它落地,或在汇报里说明。


---

## L3 检视记录(2026-08-23)

**verdict: pass**,commit `e3e6061`。

核实过的点:
- 完成路径隔离复用了既有的 `detached` 机制(`## ReplyMode: detached` 那套),
  没有另起一套并行逻辑——静默检测/无进展检测/超时兜底对两种触发方式一视同仁,
  是干净的复用而不是分叉
- 汇报解析的双空格段头支持,直接对应实测里 `提交  40e1a8f` 这种无冒号格式;
  段落长度上限 4000 字符,新增测试覆盖「全占位符 / 段后大量文本 / 末段无结束标题」
- 插件侧断点的诊断(`coagenthub-codex/mcp-server/src/tools.ts:70`,
  `dispatcherSessionId` 取自 `resolveCodexThreadId(extra?._meta)`,
  codex CLI 未带 `x-codex-turn-metadata` 时恒为 `undefined`)复核属实,
  且改动确实没有跨仓越界去动 coagenthub-codex
- 相关测试单独重跑 52/52 通过,与汇报数字一致

**一处非阻塞发现,记录以供后续参考**:

`isCoordinatorTask` 按「目标 participant 在本群 roles 含 coordinator」判定是否
detached。若某成员在同一群里**同时持有 `executor` 与 `coordinator`**两个角色,
它收到的**每一张**任务(哪怕是普通实现票)都会被误判为协调任务——保持 running
直到 24 小时兜底超时,因为它并不知道自己需要 PATCH。

当前库内无此类双角色成员(已查),且 24 小时兜底把损害范围限定住,**不构成
阻塞项**。但这条风险与 `specs/group-creation-gaps.md` 缺口二(建群者被自动塞成
coordinator,可能与已有角色重叠)是同一类问题的两个表现,该票落地时一并考虑。
