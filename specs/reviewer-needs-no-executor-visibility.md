# Spec: 协调任务详情透出 L1 聚合 —— 让检视者没有理由下探执行器层

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-24

## 背景:平台在邀请越界

用户指出:「判断也应该是协调者来判断,你不应该感知执行器失败了」。

事发经过:执行器 CodeBuddy 卡死,检视者挂了这样一块监控——

```
子任务=1 | 执行方=CodeBuddy | 子状态=running | review_request=?
```

然后据此杀进程、清工作区、改派另一个执行器。**三件事全是别人的职责**:换执行器
是协调者 skill §2.2 的明文规定;清工作区是平台的 `resetWorkspace: true`;
进程回收是 `EXECUTOR_TIMEOUT_MS`(默认 30 分钟 SIGKILL)——而它当时才卡了 20 分钟,
**平台自己的超时还没到就被人抢先动手了**。

**但根子不在检视者不守规矩,在平台允许它看见。** `GET /groups/:id/tasks` 返回
全部任务,包含执行子任务的执行器名、实时状态;没有任何角色作用域。检视者想
盯执行器层,平台一路绿灯。

### 为什么"写进 skill"解决不了

同一轮已经验证过:写在 skill 里但没被结构或强制兜住的规则,对一个无记忆的 agent
等于不存在(见 `specs/coordination-close-integrity.md` 的立论)。再加一句
「检视者不得查询子任务」只是又一条会被忽略的说明。

### 检视者到底需要什么

它需要的**不是**执行器的实时状态,而是 L3 验收时的一个事实:**这张票的 L1 层
到底发生了没有**。现在为了拿到这个事实,它只能去查 `parent_task_id` ——
而那个查询顺带把执行器身份和实时状态一并交到了它手上。

**把它真正需要的东西直接给它,它就没有理由去下探。** 这与
`specs/ticket-template-role-blind.md` 是同一条思路:不要指望 agent 做对选择,
让对的那条路成为手边最顺的路。

## 要求

### R1. 协调任务详情透出 `l1` 聚合

`GET /groups/:id/tasks/:taskId` 在目标是**协调任务**时,增加派生字段:

```json
"l1": {
  "childCount": 1,
  "status": "done",          // 子任务聚合态: done | failed | running | pending
  "allTerminal": true
}
```

- **聚合规则复用** `group-tasks-by-spec.ts` 里 L1 步的既有口径(有 running →
  running;全 done → done;存在 failed 且无后续成功 → failed;其余 pending)。
  **不要另写一套** —— 前端已经在用这套口径,两份会各自演化。
- **不含执行器身份**:不透出执行器名、participantId、executorKey。检视者验收
  需要知道"L1 发生了没有、结果如何",不需要知道"是谁跑的"。
- 非协调任务:**不输出** `l1` 字段(不是输出空对象),保持现状载荷不变。
- 「协调任务」判定**复用 `lib/detached-task-liveness.ts` 的 `isDetachedTask()`**。

### R2. 不做访问控制

**不要**给 `GET /tasks` 加角色过滤或权限拦截。理由:

- 人类用户需要完整的三层视图,前端正是靠列出全部任务来渲染需求列表;
- LAN 全信模型下加一层形同虚设的过滤,只会制造"以为挡住了"的错觉;
- 本票的手段是**让正确路径更顺**,不是筑墙。墙挡不住,顺路才有效。

### R3. 不改前端

前端有自己的数据源与聚合(`group-tasks-by-spec.ts`),本票只服务于走 HTTP API
的 agent。**前端不需要改,也不要改。**

### R4. 不改 skill

skill 里不新增"禁止查询子任务"之类的条文。本票的立论就是**说明层解决不了这件事**,
再写一条只是自我否定。

## 验收标准

- [ ] 协调任务详情含 `l1` 聚合,字段为 `childCount` / `status` / `allTerminal`
- [ ] 零子任务时 `childCount: 0` 且 `status: "pending"`
- [ ] 子任务全部 done → `status: "done"`, `allTerminal: true`
- [ ] 存在 running 子任务 → `status: "running"`, `allTerminal: false`
- [ ] `l1` **不含**任何执行器身份字段(名称 / participantId / executorKey)
- [ ] **非**协调任务的详情**不含** `l1` 字段,其余载荷与改动前逐字一致(回归,必测)
- [ ] 聚合口径与 `group-tasks-by-spec.ts` 的 L1 规则一致(同输入同结论,测试对照)
- [ ] 协调任务判定复用 `isDetachedTask()`,未另写
- [ ] **未新增**任何角色过滤或权限拦截(R2)
- [ ] 后端测试全绿,贴出用例数
- [ ] **未改动**前端、`skills/`

## 不涉及

- 角色作用域的 API 访问控制(R2 明确不做)
- 执行器超时/回收 —— **已有机制**:`EXECUTOR_TIMEOUT_MS` 默认 30 分钟 SIGKILL,
  `stallAlertMinutes: 15` / `stallTimeoutMinutes: 30`。本轮的"卡死无人回收"是
  误判,平台超时尚未到点
- 提交策略(用户已明确暂缓)

## 执行环境提示

- 本仓 pnpm 项目,后端 `:3001`
- 改完重启后端;重启前确认无 running/queued 任务;验收前用 `ps -o lstart=`
  确认监听进程启动时间晚于本次提交
