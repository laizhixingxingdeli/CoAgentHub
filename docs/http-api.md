# CoAgentHub v5 HTTP API

来源：`src/api/server.ts`；所有JSON响应示例为结构摘录，动态字段取决于持久状态，示例未调用真实服务。路径参数须URL编码。curl使用`curl.exe --noproxy "*"`适合Windows；其它系统用curl。写请求会产生真实副作用，示例ID与token必须换成获授权的对象。

## 鉴权与错误

健康/version不需认证。控制面由可选`resolveControlPrincipal`注入；未装配时保持本机兼容放行，装配后读通常需viewer/operator、写需operator。项目没有统一内置Bearer解析器：下列`Authorization: Bearer <token>`仅示意resolver采用该约定时的请求头，部署使用其它头须替换。Agent与run/brief只接受`x-coagent-run: <token>`，身份来自绑定token，不能body自称角色。错误为`{"error":"CODE","message":"说明"}`；输入400、无凭据401、授权403、不存在404、领域状态409、未装配501、暂不可用503。

## 健康与平台

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

鉴权：控制面（可选resolver）。参数：plan、selection、cwd、adapter、state、store、runDir；可选候选与maxRounds。真实派发入口，会执行agent。推荐使用run-mission/run-plan CLI构造请求。响应是NDJSON，不是单个JSON；断线不取消已接收job；501表示未装配，503表示drain。 示例为空候选，不派发；实际候选必须经CLI资格筛选与分类。

请求示例及本机curl：

```bash
curl.exe -sS --noproxy '*' -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' --data '{"plan":{"planId":"PLAN-example","projectId":"P","intent":"示例","integrationBranch":"codex/integration","reviewer":"L3","stopConditions":{"unresolvedEscalations":1,"wallClockMs":3600000,"escalationTimeoutMs":60000,"maxEscalations":5,"maxRerunsPerFeature":1},"integrationVerification":[{"argv":["node","--test"],"timeoutMs":600000}],"features":[]},"selection":{"candidates":[],"exclusions":[],"warnings":[]},"cwd":"C:/path/to/repo","adapter":"C:/path/to/agent-entry.ts","state":"C:/path/to/state.json","store":"file","runDir":"C:/path/to/run","env":{"COAGENT_AGENT_ENV_PASSTHROUGH":"-"},"maxRounds":40}' 'http://127.0.0.1:3101/api/control/run-plan'
```

响应结构摘录：

```json
{"channel":"stdout","line":"开始运行"}
{"exitCode":0}
```

