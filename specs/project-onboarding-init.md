# Spec: 新项目接入 CoAgentHub —— `/init` + `AGENTS.md` 标记段

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-24
> **依据**: 与用户讨论确定的设计(见记忆 `project-onboarding-design`)

## 背景

现有流程是「先有平台、后有项目」——群和参与方都在平台已运行的前提下手动建。
反过来的场景没有设计:一台新机器 / 一个新项目,想快速接入这套规范,当前
除了照抄现有群的手工步骤,没有任何辅助。

## 决策

仿照 Matt Pocock 协议 `/init` 命令的思路:本地生成脚手架 + 一个**标记段**,
供后续的接入指令识别「这是不是一个 CoAgentHub 项目」。**`/init` 保持
离线优先**——它不联网,不建群,不需要平台已运行。

## 要求

### R1. 检测标准是 `AGENTS.md` 里的一个特定 section,不是文件存在性

**判据**:`AGENTS.md` 中存在一个 `## CoAgentHub` 标题的 section,内含一个
fenced ` ```json coagenthub ` 代码块。

⚠️ **不能只判 `AGENTS.md` 是否存在**。Matt Pocock 协议本身就会生成
`AGENTS.md`,与 CoAgentHub 无关的项目也会有这个文件。判据必须是**这个
具体 section**,这是最容易被简化掉的一步,必须在实现里显式测试。

### R2. 该 section 只存一个事实:`groupId`

```markdown
## CoAgentHub

\`\`\`json coagenthub
{ "groupId": "" }
\`\`\`
```

**不存 role、不存 apiBase、不存 participantId**。理由分别:

- **role**:群成员归属关系(`group_members.roles`),同一 participant 在不同群
  可持有不同角色,存副本会静默过期——与 v3.9 §3.14.5 模式推导「不落字段」
  同一条原则。运行时用 `GET /api/groups/{groupId}/members` 现查。
- **apiBase**:已有约定 `COAGENTHUB_API_BASE` 环境变量(`queue.ts`
  `executionApiBase()` 已在用,缺省 `http://localhost:3001/api`),不重复定义。
- **participantId**:是机器级身份,不是项目属性,不属于某个项目的配置文件。

`/init` 生成时 `groupId` 留空——此时还没有群。

### R3. `/init` 的产出(离线,不联网)

比照 Matt Pocock 协议 `setup-matt-pocock-skills` 的脚手架,若缺失则创建
(已存在的文件不覆盖):

- `AGENTS.md`(含上面的 `## CoAgentHub` section)
- `CONTEXT.md`
- `docs/adr/`(含一份初始 ADR)
- `specs/`(空目录 + `.gitkeep`)
- `.cursorrules` 或等效风格约定文件

**这一步不建群、不注册参与方、不发任何网络请求。**

### R4. 接入 + 建群(联网,`/init` 之后单独进行)

由用户在两种方式中选择:

- **前端页面操作**:在群管理页手动建群、加参与方(现有能力,不新增)
- **交给 agent 的引导指令**:一段可以喂给任意 agent 的文本,让它调用平台
  HTTP API 自己完成建群/加成员

**本票负责产出第二种方式的引导指令模板**,不是新写一套建群逻辑——
底层调用的是已有的 `POST /groups`、`POST /groups/:id/members` 等既有接口。

### R5. `groupId` 回填是引导指令的最后一步

引导指令流程:调 API 建群/加成员(此时已经拿到 `groupId`) → **把
`groupId` 写回 `AGENTS.md` 的 `## CoAgentHub` section** → 结束。

**不是**再跑一次 `/init`。`/init` 只负责生成骨架,回填是接入指令自己收尾。

### R6. 已知局限,写进文档,不掩盖

**没有统一的「启动时自动读取该文件」机制。** 各 runtime 的常驻指令约定不同
(Claude Code 是 `CLAUDE.md`,codex 原生读 `AGENTS.md`,其它 runtime 可能
都没有)。`AGENTS.md` 标记段是**统一的判据**,但触发读取是**每个 runtime
自己的适配层**——这与 v3.9 §3.18「平台契约统一、runtime 适配各异」是同一原则。

**本票不解决这个局限**,只要求在生成的文档里如实写明:接入后如果 agent
没有自动读到这个 section,需要手动提示它读一次。

## 验收标准

- [ ] `/init` 命令(或等效脚本)存在,离线运行,不发任何网络请求
- [ ] 生成的 `AGENTS.md` 含 `## CoAgentHub` section,`groupId` 初始为空字符串
- [ ] 已存在的文档文件不被覆盖(测试:预先放一个自定义 `CONTEXT.md`,跑
      `/init` 后内容不变)
- [ ] 有一个独立函数/脚本可以判断「给定路径是不是 CoAgentHub 项目」,依据
      **是 section 存在性,不是文件存在性**(测试:构造一个有 `AGENTS.md`
      但无该 section 的目录,判定结果为「不是」)
- [ ] 引导指令模板产出(文档/脚本均可),涵盖建群 → 加成员 → 回填 `groupId`
- [ ] 回填后的 `AGENTS.md` 该 section 的 `groupId` 是建群返回的真实 id
- [ ] 生成文档中包含 R6 描述的局限说明
- [ ] 若涉及代码(判据函数等),测试全绿,贴出用例数

## 不涉及

- 各 runtime 的自动加载机制(R6 已说明是已知局限)
- 前端建群页面的改动(路径 A 用现状能力即可)
- 角色的存储或缓存(明确不做,见 R2)

## 执行环境提示

- 本仓 pnpm 项目
- 判据函数与 `/init` 脚手架生成建议放在一个清晰独立的位置(如
  `packages/backend/server/src/lib/onboarding/` 或类似),不要散落进现有
  不相关模块
