# CoAgentHub v5 HTTP API

来源：`src/api/server.ts`；所有JSON响应示例为结构摘录，动态字段取决于持久状态，示例未调用真实服务。路径参数须URL编码。curl使用`curl.exe --noproxy "*"`适合Windows；其它系统用curl。写请求会产生真实副作用，示例ID与token必须换成获授权的对象。

## 鉴权与错误

健康/version不需认证。控制面由可选`resolveControlPrincipal`注入；未装配时保持本机兼容放行，装配后读通常需viewer/operator、写需operator。项目没有统一内置Bearer解析器：下列`Authorization: Bearer <token>`仅示意resolver采用该约定时的请求头，部署使用其它头须替换。Agent与run/brief只接受`x-coagent-run: <token>`，身份来自绑定token，不能body自称角色。错误为`{"error":"CODE","message":"说明"}`；输入400、无凭据401、授权403、不存在404、领域状态409、未装配501、暂不可用503。

## 健康与平台

## 检视者待办、值守与合并简报（RV1–RV5）

以下读取不消费或 ACK Delivery。控制面沿用可选 resolver：读需 viewer/operator，写需 operator；未装配时沿用本机兼容行为。值守是并发所有权，不是身份认证。已领取值守的项目执行 L3 Mission 控制操作或 PlanRun 决定时，必须携带 `x-coagent-reviewer: <owner>` 与 `x-coagent-reviewer-generation: <generation>`；旧代次拒绝。未采用值守协议的项目保留既有调用方式。

### GET /api/reviewer/todos

可选查询 `projectId`。返回 `{todos:[{id,projectId,missionId,kind,title,at,blocking,state,notify}]}`；kind 包括 question、diagnostic、cost_cap、checkpoint、result、documentation。只有当前服务实际承载的 PlanRun 升级投影为 `plan_escalation` 并带 `runId,decisionPath:"plan_run"`，历史来源仍走 Mission 路径。文档待办来源于独立提议队列，代码合入后仍保留待批；批准排队、撤回或提交后不重复提醒，编辑产生新版本。
```bash
curl.exe -sS --noproxy '*' 'http://127.0.0.1:3101/api/reviewer/todos?projectId=P'
```

### POST /api/reviewer/todos/:todoId

输入 `{action:"acknowledge"|"wait_user"|"reopen",reviewer,reason,generation?}`，返回更新后的待办。reviewer/reason 必須非空。确认只停止重复提醒，不关闭升级、不放行门禁；等用户会调用 park，保存已验收成果并释放名额；parked 状态必须先经 parked-resume 安全同步才能 reopen。问题被权威源答复后，旧待办消失。PlanRun 升级须用专门 decide 路径。
```bash
curl.exe -sS --noproxy '*' -X POST 'http://127.0.0.1:3101/api/reviewer/todos/M%3Aescalation%3A0' -H 'Content-Type: application/json' -d '{"action":"acknowledge","reviewer":"session-A","reason":"已阅，继续调查","generation":1}'
```

### GET /api/projects/:projectId/reviewer-duty

无 body，响应 `{duty:null|{projectId,owner,generation,expiresAt,released,active}}`。租约五分钟，按平台时钟判定过期；持久活动重建，服务重启不丢代次。
```bash
curl.exe -sS --noproxy '*' 'http://127.0.0.1:3101/api/projects/P/reviewer-duty'
```

### POST /api/projects/:projectId/reviewer-duty

输入 `{action:"claim"|"renew"|"release"|"handoff",owner,generation?,nextOwner?}`，返回上述 duty 对象。项目需至少一条 Mission 作为审计锚点。claim 与已有其它 owner 冲突；同 owner 重复 claim 幂等且不延长租约。renew/release/handoff 必须匹配当前 owner 和代次；handoff 需 nextOwner。交接或过期后重领会递增代次，旧会话不能继续写或守候。客户端建议每分钟 renew。
```bash
curl.exe -sS --noproxy '*' -X POST 'http://127.0.0.1:3101/api/projects/P/reviewer-duty' -H 'Content-Type: application/json' -d '{"action":"claim","owner":"session-A"}'
```

### GET /api/reviewer/wait

查询必需 `projectId,owner,generation`，可选 `cursor,waitMs`（0–25000，默认25000）。响应 `{changed,cursor,todos}` 只包含需提醒项；同游标超时返回 changed=false。每次等待持续核对有效值守，交接或到期立即拒绝；断连停止等待。此端点不创建定时任务。
```bash
curl.exe -sS --noproxy '*' 'http://127.0.0.1:3101/api/reviewer/wait?projectId=P&owner=session-A&generation=1&waitMs=0'
```

### POST /api/plan-runs/:runId/decide

输入 `{escalationId,action,decidedBy,reason?,answer?,dropFeatures?}`。action 为 answer、skip、rescope、stop、rerun_isolated；具体动作仍由 PlanRun 领域规则限制，非 answer 需要 reason。响应 `{resolution}`。decidedBy 必须是运行指定检视者；截止、额度、已解决升级均不放宽。必须由当前服务真实承载该运行，历史 PlanRun 来源不能借此写入。写入沿用记录短锁，拿锁后重新检查承载及最新状态；不写主状态文件。
```bash
curl.exe -sS --noproxy '*' -X POST 'http://127.0.0.1:3101/api/plan-runs/R/decide' -H 'Content-Type: application/json' -H 'x-coagent-reviewer: session-A' -H 'x-coagent-reviewer-generation: 1' -d '{"escalationId":"E-1","action":"skip","decidedBy":"session-A","reason":"本次明确跳过"}'
```

### GET /api/projects/:projectId/master-brief

返回 `{projectId,integrationBranch,integrationHead,masterHead,ready,requiresUserSignature:true,reasons,activeMissions,verification,commits,changedFiles,missions}`；missions 汇总已合入票的验收、风险、文档标题与费用。项目需唯一可信工作区。前置检查核对真实 Git、干净集成分支、未结束 Mission/Attempt，以及与当前 HEAD 完全对应的可信平台全量 `node --test` 报告；旧 HEAD 或自由文本测试声明不算证据。无证据会明确 ready=false。接口绝不合 master。
```bash
curl.exe -sS --noproxy '*' 'http://127.0.0.1:3101/api/projects/P/master-brief'
```

可选零依赖 stdio MCP：`node scripts/reviewer-mcp.ts`，`COAGENT_BASE` 只能指定本机 HTTP origin，默认 `http://127.0.0.1:3101`。公开十个工作流工具（包括读取、提出、处理和提交文档），所有状态仍经 HTTP；stdio 仅写 JSON-RPC，不打印业务日志。此入口补充现有 L3 插件，不修改已安装插件、凭据或 Codex 配置，不自动绑定 Delivery。协议依据 [MCP stdio 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) 和 [初始化规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)。

### GET /api/projects/:projectId/documents

读需 viewer/operator。无请求正文，返回 `{proposals:[{id,missionId,path,title,revision,base,baseHash,changes,proposed,state,reviewer?,reason?,commit?,error?}]}`。`changes:[{before,after}]` 是精确替换差异；before 必须唯一匹配，新文档用空 before。state 为 proposed、approved、needs_revision、withdrawn、committed。读取不 ACK Delivery，不批准提议。
```bash
curl.exe -sS --noproxy '*' 'http://127.0.0.1:3101/api/projects/P/documents'
```

### POST /api/projects/:projectId/documents

写需 operator；输入 `{missionId,path,title,changes,reviewer,reason,generation?}`，返回新提议（201）。Mission 必须属于项目并提供可信工作区。path 只允许 `.coagent/` 下安全 Markdown 路径、AGENTS.md、CLAUDE.md；拒绝遍历、设备名及符号链接。规则/架构决定同样可经此入口提出，尚未批准不会写 Git。存在值守时 reviewer/generation 必须匹配租约。
```bash
curl.exe -sS --noproxy '*' -X POST 'http://127.0.0.1:3101/api/projects/P/documents' -H 'Content-Type: application/json' -d '{"missionId":"M","path":".coagent/project.md","title":"规则修订","changes":[{"before":"旧条款","after":"新条款"}],"reviewer":"session-A","reason":"已确认的规则"}'
```

### POST /api/documents/:documentId/decide

写需 operator。输入 `{action:"approve"|"edit"|"withdraw",reviewer,reason,revision,baseHash,changes?,generation?}`。revision/baseHash 必须对应已审查差异；edit 用当前原文重建差异、递增版本并取消旧批准。approve 先持久记录签名，再尝试独立提交；代码不等文档，工作区脏、仍有运行或目标是 master 时保持 approved 排队；基线变化须重审。返回提议及可选 `queue:{committed,deferred,errors:[{id,reason}]}`。撤回不写文档。等用户的文档通知可用待办入口，独立等待不会 park 已完成代码 Mission。
```bash
curl.exe -sS --noproxy '*' -X POST 'http://127.0.0.1:3101/api/documents/DOC%3AM%3AA%3A0/decide' -H 'Content-Type: application/json' -d '{"action":"approve","reviewer":"session-A","reason":"逐条核对并保留其它条款","revision":1,"baseHash":"<GET返回的hash>"}'
```

### POST /api/projects/:projectId/documents/flush

写需 operator。正文 `{reviewer?,generation?}`；值守已启用时必需真实 reviewer/generation。返回 `{committed,deferred,errors}`。只提交已批准且项目无运行的提议；paused 但未 park 的 Mission 仍保护原基线。隔离 worktree 生成文档和 VIBE.md 后核对目标干净、分支与 HEAD，以 fast-forward 落入集成分支，绝不写 master。不改 root 的索引或未提交文件。提交标记用于 Git 成功/队列确认丢失后的恢复，不重复提交。服务启动、Mission 释放工作区及批准后也尝试 flush；未处理文档会阻止源 Mission 归档。
```bash
curl.exe -sS --noproxy '*' -X POST 'http://127.0.0.1:3101/api/projects/P/documents/flush' -H 'Content-Type: application/json' -d '{}'
```

协调者交卷 `memoryDelta` 新形式为 `{kind,slug,title,changes:[{before,after}]}`。旧 `{body}` 仍可恢复为显式整体替换差异，必须单独审查，不再自动落地；坏提议进入 needs_revision，不阻止代码合入。文档匹配与哈希统一 LF 换行，Windows Git 的 CRLF 转换不会制造虚假漂移。多个提议修改同一旧基线时，先提交的一条会使后续旧差异要求重审；不做模糊合并。

### GET /api/health

鉴权：不需要。参数：无。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET 'http://127.0.0.1:3101/api/health'
```

响应结构摘录：

```json
{
  "ok": true,
  "api": "v1"
}
```

### GET /api/version

鉴权：不需要。参数：无。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET 'http://127.0.0.1:3101/api/version'
```

响应结构摘录：

```json
{
  "api": "v1"
}
```

### GET /api/platform/status

鉴权：控制面（可选resolver）。参数：无。含pid、statePath、监听地址、队列与有效租约占用；未装配项带不可用原因。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/platform/status'
```

响应结构摘录：

```json
{
  "api": "v1",
  "store": "file",
  "holdsMainLock": true
}
```

### GET /api/usage

鉴权：控制面（可选resolver）。参数：查询 projectId、missionId 可选。用量报表形状见 Platform.getUsage；未归因数据单列。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/usage'
```

响应结构摘录：

```json
{
  "total": {
    "input": 0,
    "output": 0,
    "cacheRead": 0,
    "cacheWrite": 0,
    "total": 0,
    "cost": 0,
    "quality": "unknown"
  },
  "attempts": 0,
  "unattributed": 0,
  "byProject": [],
  "byMission": [],
  "byRole": [],
  "byFact": []
}
```

### GET /api/runtime/models

鉴权：控制面（可选resolver）。参数：无。清单由适配器提供；成功缓存，失败不缓存。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/runtime/models'
```

响应结构摘录：

```json
{
  "available": false,
  "note": "运行时不可用"
}
```

### GET /api/runtime/usage

鉴权：控制面（可选resolver）。参数：无。可返回用量行数组或 unavailable 对象。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/runtime/usage'
```

响应结构摘录：

```json
{
  "available": false,
  "note": "读取用量失败"
}
```

## 项目

### GET /api/projects

鉴权：控制面（可选resolver）。参数：无。项目摘要数组。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/projects'
```

响应结构摘录：

```json
[]
```

## 候选池

### GET /api/pools

鉴权：控制面（可选resolver）。参数：无。只读候选池，附加健康、用量及熔断事实，不播种或清除候选。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/pools'
```

响应结构摘录：

```json
{
  "coordinator": [],
  "executor": [],
  "independent_reviewer": []
}
```

### POST /api/pools

鉴权：控制面（可选resolver）。参数：role、profileId、endpoint，facts可选。201；追加候选，主要返回字段以 AgentPoolRepository.add 为准。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"role":"executor","profileId":"exec-example","endpoint":"local"}' 'http://127.0.0.1:3101/api/pools'
```

响应结构摘录：

```json
{
  "role": "executor"
}
```

### GET /api/pools/config

读取候选配置和 revision，不播种或改变配置；需要 poolList 权限。返回协调者、执行者、独立检视者的有序列表。旧记录缺 enabled 时默认启用，facts 保持适配层定义的模型与思考档位键值。

### POST /api/pools/coordinator/configure

需要 poolAdd 权限。请求 `{expectedRevision, candidates}`，candidates 按提交顺序成为完整角色列表，每项含 profileId、endpoint、可选 facts 和 enabled；省略的候选删除，空数组清空角色。服务器校验整个配置的版本，旧页面提交返回 409 STALE_POOL，成功返回新 revision 与配置。错误输入不会部分落库。已运行跳次保留选定配置，下一跳重新读取当前启用列表。

### POST /api/pools/executor/configure

输入、权限、版本门禁和响应同协调者配置，替换执行者列表；不会改其他角色。

### POST /api/pools/classifier/configure

输入、权限、版本门禁和响应同协调者配置，替换分类用只读候选；每次 QueryRun 重读启用列表，上游可切换故障才按序顶替，空池拒绝，不借用协调者或请求中指定的模型。只读工具白名单保持强制。

### POST /api/pools/independent_reviewer/configure

输入、权限、版本门禁和响应同协调者配置，替换独立检视者列表；空池不会复用协调者身份。

### POST /api/pools/:profileId/circuit/reset

鉴权：控制面（可选resolver）。参数：路径profileId；body非空reason。复位者身份来自控制凭据，不接受body自称actor；503表示无仓储。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"reason":"人工核实额度恢复"}' 'http://127.0.0.1:3101/api/pools/exec-example/circuit/reset'
```

响应结构摘录：

```json
{
  "profileId": "exec-example",
  "circuit": {
    "state": "closed"
  }
}
```

### GET /api/pools/:profileId/circuit/reset-events

鉴权：控制面（可选resolver）。参数：路径profileId。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/pools/exec-example/circuit/reset-events'
```

响应结构摘录：

```json
{
  "profileId": "exec-example",
  "events": []
}
```

## Mission

### GET /api/missions

鉴权：控制面（可选resolver）。参数：无（此列表不接收project过滤）。Mission摘要数组。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/missions'
```

响应结构摘录：

```json
[]
```

### POST /api/missions

鉴权：控制面（可选resolver）。参数：projectId、可选missionId、contract、可选origin。201；只创建，不运行。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"projectId":"P","missionId":"M-example","contract":{"intent":"示例任务","acceptance":["完成验证"],"constraints":[],"nonGoals":[],"guardrails":[]}}' 'http://127.0.0.1:3101/api/missions'
```

响应结构摘录：

```json
{
  "missionId": "M-example"
}
```

### POST /api/missions/classified

鉴权：控制面（可选resolver）。参数：projectId、contract、facts；assessment/workOrder按分类需要提供。201；示例明确声明副作用并选择Standard，无workOrder；不能由caller覆盖路由。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"projectId":"P","missionId":"M-example","contract":{"intent":"示例任务","acceptance":["完成验证"],"constraints":[],"nonGoals":[],"guardrails":[]},"facts":{"mutationSideEffect":true,"readOnlyProven":false,"highAssurance":{"productionDeployRelease":false,"externalPaidOp":false,"destructiveData":false,"credentialsPermissionsSecurity":false,"schemaPublicApiPersistenceCompat":false,"unrecoverableExternalSideEffect":false},"standardFloor":{"publicInterface":true,"buildSystemOrDependency":false,"multipleDomainModules":false,"acceptanceNotCheckableUpfront":false,"rootCauseOrCompetingDesigns":false}}}' 'http://127.0.0.1:3101/api/missions/classified'
```

响应结构摘录：

```json
{
  "missionId": "M-example"
}
```

### GET /api/missions/:missionId

鉴权：控制面（可选resolver）。参数：路径missionId。完整视图包含契约、结果、升级和签字。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/missions/M-example'
```

响应结构摘录：

```json
{
  "missionId": "M-example",
  "status": "planning",
  "workItems": []
}
```

### GET /api/missions/:missionId/project-context

鉴权：控制面（可选resolver）。参数：路径missionId；查询slug可选。项目规范只读投影；精确字段见 getProjectContext。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/missions/M-example/project-context'
```

响应结构摘录：

```json
{
  "available": false,
  "note": "项目规范未装配"
}
```

### GET /api/missions/:missionId/activity

鉴权：控制面（可选resolver）。参数：路径missionId。活动数组，含kind、at、data及归因。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/missions/M-example/activity'
```

响应结构摘录：

```json
[]
```

### GET /api/missions/:missionId/live

鉴权：控制面（可选resolver）。参数：路径missionId；查询cursor默认0。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/missions/M-example/live'
```

响应结构摘录：

```json
{
  "cursor": 0,
  "chunks": []
}
```

### GET /api/missions/:missionId/attempts/:attemptId

鉴权：控制面（可选resolver）。参数：两个路径ID。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/missions/M-example/attempts/coord-1'
```

响应结构摘录：

```json
{
  "attemptId": "coord-1",
  "kind": "coordinator",
  "status": "succeeded",
  "evidence": []
}
```

### GET /api/missions/:missionId/validation-reports/:reportId

鉴权：控制面（可选resolver）。参数：两个路径ID。不存在或不属于此Mission统一404，不暴露跨Mission归属。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/missions/M-example/validation-reports/VR-1'
```

响应结构摘录：

```json
{
  "id": "VR-1",
  "passed": true,
  "checks": []
}
```

### GET /api/missions/:missionId/diff

鉴权：控制面（可选resolver）。参数：路径missionId。返回统计与路径清单，非完整补丁。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/missions/M-example/diff'
```

响应结构摘录：

```json
{
  "stat": "",
  "files": [],
  "pendingMemory": []
}
```

### POST /api/missions/:missionId/budget/raise

鉴权：控制面（可选resolver）。参数：body.by有限正数；缺省10。只沿票级费用门禁增额；成功结果见 raiseMissionCostCap。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"by":10}' 'http://127.0.0.1:3101/api/missions/M-example/budget/raise'
```

响应结构摘录：

```json
{
  "costCap": 20
}
```

### POST /api/missions/:missionId/checkpoint/approve

鉴权：控制面（可选resolver）。参数：threshold正整数15倍数；reviewer、reason非空。仅批准实际已到达且历史有对应升级的检查点；重复幂等，不改变费用。输入400，领域错误409。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"threshold":15,"reviewer":"L3","reason":"明确批准继续"}' 'http://127.0.0.1:3101/api/missions/M-example/checkpoint/approve'
```

响应结构摘录：

```json
{
  "threshold": 15,
  "approved": true,
  "alreadyApproved": false
}
```

### POST /api/missions/:missionId/escalations/answer

鉴权：控制面（可选resolver）。参数：body.answer非空。普通Mission升级答复；PlanRun决策不走此口。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"answer":"继续按原契约完成"}' 'http://127.0.0.1:3101/api/missions/M-example/escalations/answer'
```

响应结构摘录：

```json
{}
```

### POST /api/missions/:missionId/contract

鉴权：控制面（可选resolver）。参数：body完整MissionContract。完整替换契约，非部分PATCH。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"intent":"示例任务","acceptance":["完成验证"],"constraints":[],"nonGoals":[],"guardrails":[]}' 'http://127.0.0.1:3101/api/missions/M-example/contract'
```

响应结构摘录：

```json
{
  "contractRevision": 2
}
```

### POST /api/missions/:missionId/park

鉴权：控制面（可选resolver）。参数：reviewer、reason必填；parked-resume可带answer。park保存已验收成果释放名额；恢复同步目标，冲突必须处理；answer仅在有开放升级时使用。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"reviewer":"L3","reason":"明确的停靠或恢复理由"}' 'http://127.0.0.1:3101/api/missions/M-example/park'
```

响应结构摘录：

```json
{
  "parked": true,
  "reason": "明确的停靠理由"
}
```

### POST /api/missions/:missionId/parked-resume

鉴权：控制面（可选resolver）。参数：reviewer、reason必填；parked-resume可带answer。park保存已验收成果释放名额；恢复同步目标，冲突必须处理；answer仅在有开放升级时使用。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"reviewer":"L3","reason":"明确的停靠或恢复理由"}' 'http://127.0.0.1:3101/api/missions/M-example/parked-resume'
```

响应结构摘录：

```json
{
  "parked": false,
  "conflictFiles": [],
  "targetHead": "<commit>"
}
```

### POST /api/missions/:missionId/cancel

鉴权：控制面（可选resolver）。参数：reason可选。resume只清暂停标记，不自动启动runner。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"reason":"用户取消"}' 'http://127.0.0.1:3101/api/missions/M-example/cancel'
```

响应结构摘录：

```json
{
  "status": "cancelled"
}
```

### POST /api/missions/:missionId/pause

鉴权：控制面（可选resolver）。参数：无额外body字段。resume只清暂停标记，不自动启动runner。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{}' 'http://127.0.0.1:3101/api/missions/M-example/pause'
```

响应结构摘录：

```json
{
  "paused": true
}
```

### POST /api/missions/:missionId/resume

鉴权：控制面（可选resolver）。参数：无额外body字段。resume只清暂停标记，不自动启动runner。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{}' 'http://127.0.0.1:3101/api/missions/M-example/resume'
```

响应结构摘录：

```json
{
  "paused": false
}
```

### POST /api/missions/:missionId/finalize

鉴权：控制面（可选resolver）。参数：verdict=merge/send_back/abandon；reasons数组；projectRoot可选；reviewer入口还需真实reviewerId与confirmedBy。仅awaiting_review终审；merge受目标基线和干净工作区约束。示例为打回；不构成合master授权。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"verdict":"send_back","reasons":["证据缺失"]}' 'http://127.0.0.1:3101/api/missions/M-example/finalize'
```

响应结构摘录：

```json
{
  "status": "planning"
}
```

### POST /api/missions/:missionId/finalize/reviewer

鉴权：控制面（可选resolver）。参数：verdict=merge/send_back/abandon；reasons数组；projectRoot可选；reviewer入口还需真实reviewerId与confirmedBy。仅awaiting_review终审；merge受目标基线和干净工作区约束。示例为打回；不构成合master授权。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"verdict":"send_back","reasons":["证据缺失"],"reviewerId":"L3","confirmedBy":"<真实授权原文>"}' 'http://127.0.0.1:3101/api/missions/M-example/finalize/reviewer'
```

响应结构摘录：

```json
{
  "status": "planning"
}
```

### POST /api/missions/:missionId/work-items/:workItemId/retire

鉴权：控制面（可选resolver）。参数：reason必填。保留历史，不作删除。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"reason":"用户改变执行方式，保留成果"}' 'http://127.0.0.1:3101/api/missions/M-example/work-items/W-1/retire'
```

响应结构摘录：

```json
{
  "status": "retired"
}
```

### POST /api/missions/:missionId/rerun

鉴权：控制面（可选resolver）。参数：newMissionId、baseRevision可选。新Mission，原契约和记录保留；不是resume。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"newMissionId":"M-rerun"}' 'http://127.0.0.1:3101/api/missions/M-example/rerun'
```

响应结构摘录：

```json
{
  "missionId": "M-rerun",
  "rerunOf": "M-example",
  "contractRevision": 1
}
```

## 方案运行

### GET /api/plan-runs

鉴权：控制面（可选resolver）。参数：查询project可选。裸数组；runtimeState由读取时推导，不回写历史。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/plan-runs'
```

响应结构摘录：

```json
[]
```

### GET /api/plan-runs/:runId

鉴权：控制面（可选resolver）。参数：路径runId。无记录404，损坏409；没有PlanRun决策HTTP写入口。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/plan-runs/PLAN-example'
```

响应结构摘录：

```json
{
  "id": "PLAN-example",
  "runtimeState": "stopped"
}
```

### GET /api/plan-runs/:runId/live

鉴权：控制面（可选resolver）。参数：查询cursor默认0。未托管或缓冲为空时附原因。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/plan-runs/PLAN-example/live'
```

响应结构摘录：

```json
{
  "cursor": 0,
  "chunks": []
}
```

## 收件箱与投递

### GET /api/inbox

鉴权：控制面（可选resolver）。参数：查询recipient可选。只读持久Delivery；不读取就提前ACK。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'Authorization: Bearer <token>' 'http://127.0.0.1:3101/api/inbox'
```

响应结构摘录：

```json
{
  "pending": []
}
```

### POST /api/deliveries/:deliveryId/ack

鉴权：控制面（可选resolver）。参数：路径deliveryId。只在实际路由成功后确认；L3桥接器通常自动处理。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{}' 'http://127.0.0.1:3101/api/deliveries/D-1/ack'
```

响应结构摘录：

```json
{
  "id": "D-1",
  "status": "acknowledged"
}
```

## agent 工具接口

impact Run（`purpose='impact'` 的 run token）是限权身份：只放行 `GET /api/run/brief`、映射到 missionRead / attemptGetBrief / attemptGetContext / workItemGetAgentDetail 的 `/api/agent/*` 读工具（如 get_mission、get_contract、get_project_context、get_work_item、get_validation_report），以及两个按**精确工具名**点名的专属工具 `coagent_get_change_request`（body 必须为空）与 `coagent_submit_change_impact`（body 只接受 decision/workOrderDiff/affectedAcceptance/reason）。这两个工具不入策略矩阵、不复用任何宽泛写别名，只在 impact 牌上放行，且另要求 role=coordinator、changeId 与目标 workItemId 非空、claim 三元组完整；请求指向的工作项与牌上目标不一致时 403。普通协调者/执行者/独立检视者牌对它们一律 403 `ACTION_DENIED`。同一个 changeId 上重复提交相同业务内容按幂等返回原记录，内容不同回 409 `CHANGE_IMPACT_CONFLICT` 且不覆盖。其余一切入口（含 finish、两种终审、控制写与未知工具）一律 403 `ACTION_DENIED`，且在被拒前不读 body、不落盘。绑定、来源与角色门禁对放行的读继续生效（例如 get_context 仍按实际来源门禁执行，impact 不解锁它）。purpose/changeId/role 只由可信调用方在发牌时配对写入，HTTP 没有签发端点，body 自述一律不采信。

影响判断只是**判断**，不是应用：提交 decision 不触发重派 / 取消，也不把任何状态标成 applied / verified；原冻结工单不改。本阶段尚未启动 impact 运行监督。

### GET /api/run/brief

鉴权：run token。参数：x-coagent-run必填。绑定本次运行的开跑简报，包含契约/工单与角色需要的上下文。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X GET -H 'x-coagent-run: <token>' 'http://127.0.0.1:3101/api/run/brief'
```

响应结构摘录：

```json
{
  "role": "executor"
}
```

### POST /api/agent/coagent_get_mission

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 精简Mission索引；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{}' 'http://127.0.0.1:3101/api/agent/coagent_get_mission'
```

响应结构摘录：

```json
{
  "missionId": "M-example"
}
```

### POST /api/agent/coagent_get_work_item

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 协调者工作项详情；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"workItemId":"W-1"}' 'http://127.0.0.1:3101/api/agent/coagent_get_work_item'
```

响应结构摘录：

```json
{
  "id": "W-1"
}
```

### POST /api/agent/coagent_get_validation_report

鉴权：run token。参数：body 见请求示例，workItemId 必填且为非空字符串，reportId 可选、给出时必须是非空字符串；Mission/Attempt/角色只从 x-coagent-run 取，body 里带 missionId / attemptId / role 一律不采信，也不能借 L3 控制面身份。返回 完整 ValidationReport（checks 含 command.argv/cwd/exitCode/outputTail，成功项与长输出都不裁剪）；以 Platform 领域类型为准。仅协调者可读，执行者/查询者/独立检视者与无 run 的运行一律拒绝；不是 L3 控制面。默认取同一 WorkItem 当前 submittedAttemptId 最新一条 validation.reported 所引用的报告，显式 reportId 也须被当前提交的引用事件认下，且报告自身 missionId / workItemId / attemptId 与当前提交一致。不存在 / 跨 Mission / 跨工单 / 旧来源 / 无来源统一 404 VALIDATION_REPORT_NOT_FOUND，文案不泄露归属；读取不产生事件与状态转移。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"workItemId":"W-1"}' 'http://127.0.0.1:3101/api/agent/coagent_get_validation_report'
```

响应结构摘录：

```json
{
  "id": "VR-1",
  "missionId": "M-example",
  "workItemId": "W-1",
  "attemptId": "AT-1",
  "passed": true,
  "checks": [
    {
      "kind": "command",
      "passed": true,
      "summary": "command exited 0",
      "command": {
        "argv": ["node", "--test"],
        "cwd": "/proj",
        "exitCode": 0,
        "outputTail": "tests 1 / pass 1 / fail 0\\n"
      }
    }
  ]
}
```

### POST /api/agent/coagent_get_contract

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 MissionContract；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{}' 'http://127.0.0.1:3101/api/agent/coagent_get_contract'
```

响应结构摘录：

```json
{
  "contractRevision": 1,
  "contract": {
    "intent": "示例任务",
    "acceptance": [
      "完成验证"
    ],
    "constraints": [],
    "nonGoals": [],
    "guardrails": []
  }
}
```

### POST /api/agent/coagent_submit_contract_check

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 核对结果；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"verdict":"ok","summary":"已核对"}' 'http://127.0.0.1:3101/api/agent/coagent_submit_contract_check'
```

响应结构摘录：

```json
{
  "contractRevision": 1,
  "verdict": "ok"
}
```

### POST /api/agent/coagent_update_findings

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 planRevision；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"findings":"补充真实发现","rejectedHypotheses":[]}' 'http://127.0.0.1:3101/api/agent/coagent_update_findings'
```

响应结构摘录：

```json
{
  "planRevision": 1
}
```

### POST /api/agent/coagent_update_plan

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 planRevision；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"findings":"已核实","rejectedHypotheses":[],"decisions":[],"direction":"补做","risks":[]}' 'http://127.0.0.1:3101/api/agent/coagent_update_plan'
```

响应结构摘录：

```json
{
  "planRevision": 1
}
```

### POST /api/agent/coagent_create_work_item

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 workItemId；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"title":"小单","objective":"改foo","allowedScope":["src/foo.ts"],"requiredBehaviour":"返回1","constraints":[],"acceptance":["返回1"],"verification":["node --test test/foo.test.ts"],"doNot":[],"contextRefs":[]}' 'http://127.0.0.1:3101/api/agent/coagent_create_work_item'
```

响应结构摘录：

```json
{
  "workItemId": "W-1",
  "warnings": []
}
```

### POST /api/agent/coagent_retire_work_item

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 status；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"workItemId":"W-1","reason":"已取消"}' 'http://127.0.0.1:3101/api/agent/coagent_retire_work_item'
```

响应结构摘录：

```json
{
  "status": "retired"
}
```

### POST /api/agent/coagent_dispatch_work_item

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 派发结果；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"workItemIds":["W-1"]}' 'http://127.0.0.1:3101/api/agent/coagent_dispatch_work_item'
```

响应结构摘录：

```json
{
  "dispatched": [
    "W-1"
  ]
}
```

### POST /api/agent/coagent_revise_work_order

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 完整替换工单结果；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"workItemId":"W-1","objective":"修订目标","allowedScope":["src/foo.ts"],"requiredBehaviour":"返回1","constraints":[],"acceptance":["返回1"],"verification":["node --test test/foo.test.ts"],"doNot":[],"contextRefs":[]}' 'http://127.0.0.1:3101/api/agent/coagent_revise_work_order'
```

响应结构摘录：

```json
{
  "workItemId": "W-1",
  "revision": "r2",
  "changedFields": [
    "objective"
  ],
  "warnings": []
}
```

### POST /api/agent/coagent_review_execution_result

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 L2审查结果；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"workItemId":"W-1","verdict":"reject","acceptanceResults":[{"criterion":"返回1","status":"fail","evidence":"实测失败"}],"reasons":["失败"],"requiredChanges":["修正"]}' 'http://127.0.0.1:3101/api/agent/coagent_review_execution_result'
```

响应结构摘录：

```json
{
  "status": "rejected"
}
```

### POST /api/agent/coagent_escalate_to_l3

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 空对象；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"question":"需确认范围","why":"前提矛盾","optionsConsidered":[]}' 'http://127.0.0.1:3101/api/agent/coagent_escalate_to_l3'
```

响应结构摘录：

```json
{}
```

### POST /api/agent/coagent_submit_mission_result

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 空对象；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"outcome":"delivered","summary":"交卷","acceptanceEvidence":[],"memoryDelta":[],"openRisks":[],"criteria":[{"index":1,"status":"pass","evidence":"真实命令结果"}]}' 'http://127.0.0.1:3101/api/agent/coagent_submit_mission_result'
```

响应结构摘录：

```json
{}
```

### POST /api/agent/coagent_get_project_context

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 项目规范投影，slug可选；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{}' 'http://127.0.0.1:3101/api/agent/coagent_get_project_context'
```

响应结构摘录：

```json
{
  "available": false,
  "note": "没有工作区"
}
```

### POST /api/agent/coagent_get_work_order

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 绑定工单；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{}' 'http://127.0.0.1:3101/api/agent/coagent_get_work_order'
```

响应结构摘录：

```json
{
  "objective": "改foo",
  "allowedScope": [
    "src/foo.ts"
  ]
}
```

### POST /api/agent/coagent_get_context

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 上下文内容；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"ref":"<允许的上下文引用>"}' 'http://127.0.0.1:3101/api/agent/coagent_get_context'
```

响应结构摘录：

```json
{
  "found": true,
  "kind": "file",
  "body": "示例上下文"
}
```

### POST /api/agent/coagent_submit_evidence

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 evidenceId；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"kind":"test","summary":"实测结果","command":"node --test","exitCode":0,"output":"tests 1 / pass 1 / fail 0 / skipped 0"}' 'http://127.0.0.1:3101/api/agent/coagent_submit_evidence'
```

响应结构摘录：

```json
{
  "evidenceId": "E-1"
}
```

### POST /api/agent/coagent_submit_execution_result

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 status；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"outcome":"completed","summary":"完成","changedFiles":["src/foo.ts"],"evidenceIds":["E-1"],"notes":"无"}' 'http://127.0.0.1:3101/api/agent/coagent_submit_execution_result'
```

响应结构摘录：

```json
{
  "status": "submitted"
}
```

### POST /api/agent/coagent_report_blocked

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 空对象；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"reason":"前提缺失","whatWasTried":["已核实路径"],"needsFromUpstream":"请补文件"}' 'http://127.0.0.1:3101/api/agent/coagent_report_blocked'
```

响应结构摘录：

```json
{}
```

### POST /api/agent/coagent_get_mission_review_bundle

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 独立检视bundle；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{}' 'http://127.0.0.1:3101/api/agent/coagent_get_mission_review_bundle'
```

响应结构摘录：

```json
{
  "missionId": "M-example"
}
```

### POST /api/agent/coagent_submit_independent_review

鉴权：run token。参数：body见请求示例；Mission/Attempt/WorkItem身份来自x-coagent-run。返回 独立检视结果；以Platform领域类型为准。协调者/执行者/独立检视者权限隔离，越权拒绝；不是L3控制面。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"verdict":"send_back","reasons":["证据不足"]}' 'http://127.0.0.1:3101/api/agent/coagent_submit_independent_review'
```

响应结构摘录：

```json
{
  "recorded": {
    "verdict": "send_back",
    "reasons": [
      "证据不足"
    ]
  }
}
```

### POST /api/agent/coagent_get_change_request

鉴权：run token，且必须是 role=coordinator、purpose=impact、changeId 与目标 workItemId 均非空、并带完整 claim 三元组的**影响判断牌**。参数：body必须为空；Mission/Attempt/WorkItem/changeId身份全部来自x-coagent-run。返回 本次要判断的那条已确认变更（ChangeRequest）；以Platform领域类型为准。该请求指向的工作项必须与牌上钉死的目标一致，否则403 ACTION_DENIED。普通协调者/执行者/独立检视者牌一律403 ACTION_DENIED；body不接受任何字段，changeId不受理。目标那一侧的租约/代次/Attempt 已失效时由Platform回409（如 CLAIM_FENCE_REJECTED / UNKNOWN_ATTEMPT）；平台未装配变更仓储与队列槽时回409 CHANGE_IMPACT_UNSUPPORTED（不降级成放行）。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{}' 'http://127.0.0.1:3101/api/agent/coagent_get_change_request'
```

响应结构摘录：

```json
{
  "changeId": "CR-1",
  "missionId": "M-example",
  "workItemId": "W-1",
  "attemptId": "W-1.exec-1",
  "claimGeneration": 1,
  "confirmedChange": "改 < 为 <="
}
```

### POST /api/agent/coagent_submit_change_impact

鉴权：run token，且必须是 role=coordinator、purpose=impact、changeId 与目标 workItemId 均非空、并带完整 claim 三元组的**影响判断牌**。参数：body仅接受decision（compatible 兼容照跑｜replan 需重排｜cancel_replace 需取消替换）/workOrderDiff/affectedAcceptance/reason；Mission/Attempt/WorkItem/changeId身份全部来自x-coagent-run。返回 已保存的影响判断（ChangeImpact）；以Platform领域类型为准。提交前先读一次请求核目标：目标与牌不一致时403 ACTION_DENIED；目标不满足时由Platform回409（CLAIM_FENCE_REJECTED / UNKNOWN_ATTEMPT / UNKNOWN_CHANGE_REQUEST）。普通协调者/执行者/独立检视者牌一律403 ACTION_DENIED；body里任何身份字段一律400。同一个changeId上重复提交相同业务内容按幂等返回原记录（不再发事件），内容不同回409 CHANGE_IMPACT_CONFLICT且不覆盖原记录。

**这只是「判断」，不是「应用」**：decision=replan / cancel_replace 都不会触发重派或取消，也不把任何状态标成 applied / verified。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"decision":"compatible","workOrderDiff":"把 step 2 换成 step 2b","affectedAcceptance":[1],"reason":"step 2b 仍可执行"}' 'http://127.0.0.1:3101/api/agent/coagent_submit_change_impact'
```

响应结构摘录：

```json
{
  "changeId": "CR-1",
  "decision": "compatible",
  "claimGeneration": 1,
  "coordinatorAttemptId": "coord-2"
}
```

### POST /api/agent/coagent_get_change_deliveries

鉴权：run token，且必须是 role=executor、**不是** impact 牌、attemptId 与 workItemId 非空、并带完整 claim 三元组的**执行者自己的牌**。参数：body 必须是空对象 `{}`——目标 Mission / Attempt / WorkItem / 代次全部来自 x-coagent-run。返回 `{ deliveries: [...] }`，其中每项含 changeId / workOrderDiff / affectedAcceptance / diffHash / receipts（已录到的层）；以 Platform 领域类型为准。只有结论为 compatible、且 attemptId 与代次都对得上这一趟执行的差异会出现：replan 与 cancel_replace 不由执行者自己决定照跑，跨 Attempt 的差异交回来会被当成这一趟的。没有符合的差异时返回空数组，不是错误。coordinator / independent_reviewer 牌与 impact 牌一律 403 `ACTION_DENIED`（impact 牌因不在白名单里、在读 body 之前就被拒）；body 里多任何字段一律 400 `BAD_REQUEST`；租约失效或代次不符回 409（`CLAIM_FENCE_REJECTED` / `UNKNOWN_ATTEMPT`）。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{}' 'http://127.0.0.1:3101/api/agent/coagent_get_change_deliveries'
```

响应结构摘录：

```json
{
  "deliveries": [
    {
      "changeId": "CR-1",
      "workOrderDiff": "把 step 2 换成 step 2b",
      "affectedAcceptance": [1],
      "diffHash": "9d4fbbb3d09d3b36d8573d4185d0bbc69e52e61c3b2dabb72e68c11539512241",
      "receipts": []
    }
  ]
}
```

### POST /api/agent/coagent_ack_change_receipt

鉴权：同上（执行者自己的牌）。参数：body 只接受 changeId / layer（layer=executor_started 时还必须带 contentHash，即 workOrderDiff 的 sha256 小写 hex）；Mission / Attempt / WorkItem / role / claim / claimGeneration / at / verified 一律不受理——多一个身份字段就 400，身份全部由牌与已持久的影响判断补齐。layer 取 adapter_received（执行侧已收到）｜ session_consumed（已进入会话）｜ executor_started（执行者自述已按差异继续）；verified 不是可写层。返回写下的那一层回执（ChangeReceipt）；以 Platform 领域类型为准。

只有发给这趟执行的 compatible 差异可回执：replan / cancel_replace 与跨 Attempt 的差异回 409 `CHANGE_NOT_DELIVERABLE`；低层没落就写高层、或已录高层再写低层回 409 `RECEIPT_LAYER_ORDER`；executor_started 的 contentHash 与实际 diff 不符回 409 `RECEIPT_HASH_MISMATCH`；租约失效或代次不符回 409 `CLAIM_FENCE_REJECTED`；同一层重复回执相同内容按幂等返回原记录（不再发事件），内容不同回 409 `CHANGE_RECEIPT_CONFLICT` 且不覆盖。coordinator / independent_reviewer 牌与 impact 牌一律 403 `ACTION_DENIED`；body 多字段或 layer 不合法一律 400 `BAD_REQUEST`。所有拒绝要么在读 body 之前、要么在同一个事务内回滚，盘上逐字节不变。

**回执（ACK）不等于已应用或已验证**：它只记「接收侧承认收到了」，回执链全程没有 verified 层；也不等于执行结果通过验收、不等于这份 diff 已经合进产线。写回执的动作不能用来证明质量。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'x-coagent-run: <token>' -H 'Content-Type: application/json' --data '{"changeId":"CR-1","layer":"executor_started","contentHash":"9d4fbbb3d09d3b36d8573d4185d0bbc69e52e61c3b2dabb72e68c11539512241"}' 'http://127.0.0.1:3101/api/agent/coagent_ack_change_receipt'
```

响应结构摘录：

```json
{
  "changeId": "CR-1",
  "missionId": "M-example",
  "workItemId": "W-1",
  "attemptId": "W-1.exec-1",
  "claimGeneration": 1,
  "layer": "executor_started",
  "contentHash": "9d4fbbb3d09d3b36d8573d4185d0bbc69e52e61c3b2dabb72e68c11539512241"
}
```

## 控制面

### POST /api/missions/:missionId/coordinator-attempts

鉴权：控制面（可选resolver）。参数：路径missionId。201；换取绑定角色的临时run token。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{}' 'http://127.0.0.1:3101/api/missions/M-example/coordinator-attempts'
```

响应结构摘录：

```json
{
  "attemptId": "coord-1",
  "token": "<run-token>"
}
```

### POST /api/missions/:missionId/independent-reviewer-attempts

鉴权：控制面（可选resolver）。参数：路径missionId。201；换取绑定角色的临时run token。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{}' 'http://127.0.0.1:3101/api/missions/M-example/independent-reviewer-attempts'
```

响应结构摘录：

```json
{
  "attemptId": "review-1",
  "token": "<run-token>"
}
```

### POST /api/missions/:missionId/work-items/:workItemId/executor-attempts

鉴权：控制面（可选resolver）。参数：两个路径ID。201；绑定执行者工单。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{}' 'http://127.0.0.1:3101/api/missions/M-example/work-items/W-1/executor-attempts'
```

响应结构摘录：

```json
{
  "attemptId": "W-1.exec-1",
  "token": "<run-token>"
}
```

### POST /api/missions/:missionId/attempts/:attemptId/finish

鉴权：控制面（可选resolver）。参数：endedBy必填；usage等可选。队列Attempt还需带当前领取身份的x-coagent-run，不能body伪造代次；成功后吊销token。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"endedBy":"structured_submit"}' 'http://127.0.0.1:3101/api/missions/M-example/attempts/coord-1/finish'
```

响应结构摘录：

```json
{}
```

### POST /api/control/run-mission

鉴权：控制面（可选resolver）。参数：cwd、adapter、env、maxRounds等；Mission带spec；Plan请求以run-plan CLI转发形状为准。真实派发入口，会执行agent。推荐使用run-mission/run-plan CLI构造请求。响应是NDJSON，不是单个JSON；断线不取消已接收job；501表示未装配，503表示drain。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"spec":{"projectId":"P","missionId":"M-example","contract":{"intent":"示例任务","acceptance":["完成验证"],"constraints":[],"nonGoals":[],"guardrails":[]}},"cwd":"C:/path/to/repo","adapter":"C:/path/to/agent-entry.ts","env":{"COAGENT_AGENT_ENV_PASSTHROUGH":"-"},"maxRounds":20}' 'http://127.0.0.1:3101/api/control/run-mission'
```

响应结构摘录：

```json
{"channel":"stdout","line":"开始运行"}
{"exitCode":0}
```

### POST /api/control/run-plan

生产服务返回 HTTP 410 与 {"error":"PLAN_RUN_RETIRED","message":"方案运行已退役…"}，不会创建 PlanRun 或派发 agent。历史 PlanRun 查询及恢复裁决继续保留；测试专用历史装配不代表生产入口可运行。

### GET /api/projects/:projectId/mission-queue

返回 {projectId,config,revision,entries:[{missionId,position,dependsOn,status,eligible,blockedBy,contract}]}。读需 missionRead 权限；没有项目时返回空队列与可用于首次提交的 revision，不建项目。

### POST /api/projects/:projectId/mission-queue

输入 {expectedRevision,confirmedBy,config?,missions:[{missionId,contract?,dependsOn?}]}，成功返回 HTTP 201 与新队列。写需 missionCreate 权限；已领取项目值守时必须携带真实 reviewer 与 generation 头。confirmedBy 必须记录真实确认原文。新 Mission 必须提供冻结契约，已有 Mission 不允许在入队时覆盖契约。依赖只能引用同项目已有或本批更早的 Mission；整批先验证再写入，旧版本返回 QUEUE_STALE。

config 为 {projectRoot,adapter,integrationBranch,reviewer,conversationRef,envPassthrough,verification:[{argv,timeoutMs}]}，目录和适配器须存在，禁止 master/main 目标，验证命令必须非空。没有旧配置时可连同清单一次提交。

### POST /api/projects/:projectId/execution-config

输入 {expectedRevision,confirmedBy,config}，返回 HTTP 200 与队列新版本。权限及值守要求同入队。配置存为项目活动，在途 Mission 保留启动时配置，后续任务读取新配置；续跑已有工作区不能改目录或目标分支。

本机使用：先 GET 获取 revision，再 POST；CLI 可使用 node src/run-queue.ts missions.json --confirmed-by "真实确认原文"，已有值守时附 --reviewer 与 --generation。--check 只预览输入，不触碰主状态。队列仅按序、依赖推进，暂停、挂起、升级、费用、重试和终审均由 Mission 承载，不创建方案级预算或升级。前一项等待验收时不启动后一项；lightweight 完成后仍须通过逐条验收与项目集成验证。
