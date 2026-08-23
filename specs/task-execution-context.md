# Spec: 任务书带上执行上下文

> **状态**: Landed — L2 + L3 均通过(2026-08-23)
> **版本**: 1.0
> **日期**: 2026-08-23
> **上游**: `specs/reviewer-role-spec-generation.md` v3.9 §3.18.3
> **下游**: coordinator skill 去插件化依赖本票

## 背景

v3.9 §3.18 定下架构约束:**协调者与执行者的能力不通过插件实现,插件只做检视者适配。**
理由是分界线依据参与方怎么运行——检视者常驻会话、平台够不着,必须有插件才能唤醒;
协调者/执行者是平台 spawn 的子进程,能调 HTTP API 就够。

**但现在它们调不了。** `buildTicket`(`lib/executor-task/queue.ts:1812`)产出的任务书:

```
# CoAgentHub 任务
执行器: codex
项目: /Users/apple/Projects/CoAgentHub
发布时间: 2026-08-23T...
## 📜 关联规范 ...
## 任务内容 ...
## 执行方式
本任务按 coagenthub-executor skill 执行。
- 未安装:先 GET /api/skills/executor 获取 skill 内容      ← 让它调 API,却没说 API 在哪
## 汇报格式要求 ...
```

**缺四样**:API base URL、自己的 `participantId`、`groupId`、自己的 `taskId`。

现在能跑通全靠插件 env(`COAGENTHUB_API_BASE` / `COAGENTHUB_GROUP_ID` /
participant-id 文件)兜着。这正是 v3.9 要拆掉的那层依赖。

其中 **`taskId` 最关键**:v3.8 §3.17.4 要求协调者 L2 通过后 PATCH **自己那条任务**
为终态。不知道自己的 taskId 就做不到——现状是协调者靠 `list_tasks` 反查
「哪条 running 任务的执行者是我」把自己找出来,能 work 但绕,且依赖插件工具。

---

## 要求

### R1. 任务书新增「执行上下文」段

在任务书里加一段,含四项:

| 项 | 来源 |
|---|---|
| API base URL | 见 R2 |
| `participantId` | 该任务的 `executorParticipantId`(接收者自己的 id) |
| `groupId` | 该任务的 `groupId` |
| `taskId` | 该任务自己的 id |

- 段落位置与措辞自行设计,但要求 **agent 一眼能看懂这是给它调 API 用的**
  (任务书是给 LLM 读的,不是配置文件)
- 说明清楚认证方式:平台是全信模型,带 `X-Participant-Id: <自己的 participantId>`
  头即可(见 `middleware/participant-identity.ts`)

### R2. API base URL 的来源

平台自己不一定知道外部可达的 base URL(可能有反代/端口映射)。

- 优先读环境变量(名字自行设计,如 `COAGENTHUB_API_BASE`)
- 未配置时回落到本地默认(`http://localhost:<当前监听端口>/api`)
- **不要**硬编码 `3001`——端口应取实际监听值

### R3. detached 任务尤其要说清「回写终态」

协调者那条任务(v3.9 §3.18.3 / v3.8 §3.17.4)spawn 后保持 running,
**必须由它自己 PATCH 才终态**。任务书里要写明:

- 它的 taskId 是多少(R1 已给)
- 怎么回写:`PATCH /api/groups/<groupId>/tasks/<taskId>`,带 `status` 与 `diffSummary`
- **不回写的后果**:任务会挂到 `detachedTimeoutMinutes`(缺省 1440 分钟)
  兜底超时,检视者一直等不到结果

判定「这是不是 detached 任务」用现成的 `run.detached`(`queue.ts:731`),
**不要新写一份判定逻辑**。

### R4. 不泄露给不该看的人

任务书会作为群消息落库、在前端展示。执行上下文里只有 id 和 URL,
没有凭据(全信模型下 `X-Participant-Id` 不是 secret),**所以不需要脱敏**。

但要确认一点:任务书里的 `participantId` 是**接收者自己的**,不是发送者的——
不要把其他参与方的 id 混进去。

---

## 验收标准

- [ ] 任务书含执行上下文段:apiBase / participantId / groupId / taskId 四项齐全
- [ ] `participantId` 是接收者自己的 id
- [ ] API base 取自环境变量,未配置时回落本地默认,**端口取实际监听值不硬编码**
- [ ] detached 任务的任务书额外说明回写终态的方法与不回写的后果
- [ ] detached 判定复用 `run.detached`,无第二份逻辑
- [ ] 既有任务书内容(关联规范/任务内容/汇报格式/本群分工/执行与测试要求)全部保留
- [ ] 新增测试覆盖:普通任务的上下文段、detached 任务的额外说明、
      环境变量配置与未配置两种情况
- [ ] `pnpm --filter server test` 全绿(先跑一次确认基线,不得减少)

## 不涉及

- **不改** coordinator/executor skill(那是下游独立票)
- **不改**插件(任何仓)
- **不改**认证模型(全信模型不变,不引入 token)
- **不做**任务书模板的整体重构——本票只加一段
- 不引入新依赖

## 执行环境提示

- 本仓是 **pnpm** 项目
- 后端以 `pnpm --filter server start`(无 watch)运行中:改完需手动 build + restart
- 沙箱执行器注意:需监听本地端口的测试会报 `listen EPERM`,那是环境限制不是回归


---

## L3 检视记录(2026-08-23)

**verdict: pass**。实现在 `6cfc84e`(`buildExecutionContextSection`,`queue.ts:2001`),
测试补充在 `8441248`,server 435/435。

逐项核实:

- `apiBase`:`COAGENTHUB_API_BASE` 优先,缺省用 `serverPort()` 的**实际监听端口**,
  **未硬编码 3001**——符合 R2
- `participantId`:用 `run.participantId`,即**接收者自己的** id,非发送者(R4)
- detached 分支**复用 `run.detached`**,未新写判定逻辑(R3)
- detached 任务额外写明 PATCH 地址,以及「不回写会挂到 `detachedTimeoutMinutes`
  1440 分钟兜底、检视者一直等不到结果」的后果

**⚠️ 检视时的新发现**:该实现早已在 `6cfc84e` 中,也就是说那个提交实际装了
**四张票**(`task-parent-link` / `verify-agent-claims` / `coordination-payload-contract` /
本票),而非此前认为的三张。

这加重了「一票一提交」(`fc04c89`)的必要性:四票合一时其中的迁移遗漏直接导致
`/api/groups/:id/tasks` 全线 500,而**没有任何单票边界能帮助定位**。
历史提交不追溯拆分,此处记录其真实落地位置。
