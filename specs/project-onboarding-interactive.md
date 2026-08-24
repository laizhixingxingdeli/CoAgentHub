# Spec: `/init` 一条命令完成接入 —— 把接入散文变成可执行流程

> **状态**: Landed — L3 通过(2026-08-24),实现 `4fbfa2f3`
> **版本**: 1.0
> **日期**: 2026-08-24
> **推翻**: `specs/project-onboarding-init.md`(已落地 `7c915235`)的 **R3 离线优先**、
>   **R4 接入方式**、**R5 groupId 回填时机**。该 spec 的 R1(检测判据)、R2(只存
>   groupId)、R6(已知局限)**继续有效**

## 背景:原设计把最容易出错的一段留给了散文

`project-onboarding-init` 的分工是:`/init` 只做离线脚手架,**建群/接入/装 skill
交给一段"引导指令"**,由人或 agent 照着执行,最后手工把 `groupId` 回填进
`AGENTS.md`。

这一整轮反复证明了同一件事:**没被结构或强制兜住的说明,对一个无记忆的 agent
等于不存在**(见 `specs/coordination-close-integrity.md` 的立论)。把接入流程
——尤其是「记得装 skill」「记得回填 groupId」这种纯纪律动作——留在散文里,
是把已知最脆弱的手段用在最关键的一次性环节上。

而且本轮已经踩过其中两个坑:

- **skill 没同步就开工**:仓库改了 skill,`~/.codex/skills/` 的安装副本没跟上,
  协调者拿着旧规矩干活 —— 这是本轮最大事故的直接成因。
- **建群时角色判错**:`POST /groups` 不传 `creatorRole`,建群者被默认写成
  `coordinator`。检视者建群时若不知道这个参数,群里会凭空多一个协调者,
  编制判定直接错。

## 决策:`/init` 承担完整接入,离线降级但不再是默认

### R1. 流程

```
1. 脚手架(离线)          —— 沿用现有实现,不变
2. 探测平台可达性          —— COAGENTHUB_API_BASE,默认 http://localhost:3001/api
3. 收集角色分配            —— 由调用方(agent 或交互式)给出:哪个 agent 担任哪个角色
4. 参与方对齐              —— 平台已有则复用,没有则注册
5. 建群                    —— 带正确的 creatorRole
6. 加成员                  —— 按角色
7. 装 skill                —— 按角色取对应 skill 并写入各 runtime 的 skills 目录
8. 回填 groupId            —— 写回 AGENTS.md 的标记段
```

**任一步失败 → 停止并如实报告已完成到第几步**,不静默跳过。已完成的步骤保持
(建了群就是建了),**不做回滚** —— 半途回滚比留下可续接的中间态更危险。

### R2. 平台不可达时降级,并说清楚

探测失败(连接拒绝/超时/非 2xx)→ **只执行第 1 步脚手架**,然后:

- 明确告知平台不可达、`COAGENTHUB_API_BASE` 当前取值
- 告知 `groupId` 仍为空,以及**如何在平台起来后续接**(重跑 `/init`,
  它应当识别已有脚手架并只补做联网部分)
- **退出码非零**,让调用方知道没做完

**降级是兜底,不是默认路径。** 不得把"平台没起来"包装成正常完成。

### R3. 交互与非交互双模式

- **TTY 环境**:可交互提问(哪个 agent 担任 reviewer / coordinator / executor)
- **非 TTY(agent 调用)**:全部由命令行参数给出,**不提示、不阻塞**

理由:`/init` 的实际调用方通常是 agent(它先与用户对话确认分配,再调用命令)。
一个会在非 TTY 下卡住等输入的脚本,在 agent 手里就是挂死。

参数形态由执行者设计,但必须满足:**同一份分配,交互与非交互两条路径产生完全
相同的结果**。

### R4. 参与方对齐:先查后建,按名字匹配

- `GET /api/participants` 取现有列表
- 按**名字**匹配(大小写敏感,完全相等)。命中 → **复用其 participantId**,
  不重复注册
- 未命中 → 注册新参与方,再用返回的 id
- **不得**因为重名就静默复用一个设备/类型不同的参与方 —— 若名字相同但其它属性
  明显冲突,**报错并交给用户决定**,不要猜

### R5. 建群必须显式传 `creatorRole`

`POST /groups` 的 `creatorRole` **必传**,取值为「运行 `/init` 的那一方在本群的
角色」(通常是 `reviewer`)。

⚠️ **不传会被默认写成 `coordinator`** —— 检视者建群时会让群里凭空多一个协调者,
`reviewer + coordinator 同时在场` 的三方判据随之失真。这是本轮实测踩过的坑,
必须在实现里显式处理,不能依赖调用方记得。

### R6. skill 安装:能装的装,装不了的说清楚

对每个成员,按其角色取 skill(`GET /api/skills/{role}`,三个角色实测均 200)
并写入该 agent runtime 的 skills 目录。

**已知的目录约定**(本机实测存在):

| runtime | 目录 |
|---|---|
| Claude Code | `~/.claude/skills/coagenthub-<role>/SKILL.md` |
| codex | `~/.codex/skills/coagenthub-<role>/SKILL.md` |
| atomcode | `~/.atomcode/skills/coagenthub-<role>/SKILL.md` |
| codebuddy | `~/.codebuddy/skills/coagenthub-<role>/SKILL.md` |

- 目录已存在 skill → **覆盖**(保证是最新版本),并在输出里标明「已更新」
- runtime 不在上表 / 目录不存在 → **不猜、不创建**,输出里明确列出
  「以下成员的 skill 需手工安装:<名字>(<角色>),skill 内容可从
  `GET /api/skills/<role>` 获取」
- **安装失败不中止整个流程**,但必须计入最终报告,且退出码非零

理由:任务书模板已有「未安装 → 先 GET 再装」的自助路径(`queue.ts` 的
`buildExecutionModeSection`),那是安全网;`/init` 尽力而为即可,**但不许假装装好了**。

### R7. `groupId` 回填是最后一步,且必须验证

建群成功后,把返回的真实 `groupId` 写回 `AGENTS.md` 的 `## CoAgentHub` 标记段,
**复用现有的 `writeCoAgentHubGroupId()`**,不要另写。

写完后**读回文件确认** `groupId` 与建群返回值逐字相等,不等 → 报错。

### R8. 幂等:重跑 `/init` 不应造成损坏

已有脚手架 → 不覆盖已存在的文档文件(现有行为,保持)。
`AGENTS.md` 的标记段里 `groupId` **已非空** → **不再建新群**,而是:

- 校验该群在平台上仍存在 → 存在则只补做「成员对齐 + skill 安装」
- 不存在(群被删/换库)→ **报错并说明**,由用户决定是重新建群还是修正 `groupId`,
  **不要自作主张建一个新群**

### R9. 沿用原 spec 仍然有效的部分

- **R1 检测判据**:判「是不是 CoAgentHub 项目」看 `## CoAgentHub` **section**,
  不是 `AGENTS.md` 文件是否存在
- **R2 只存 groupId**:标记段不存 role / apiBase / participantId
- **R6 已知局限**:各 runtime 无统一的"启动时自动读取"机制,生成文档中如实写明

### R10. 不做这些

- **不改**任务书模板的 skill 自助安装路径(那是安全网,保留)
- **不做** skill 的持续同步(仓库改动 → 已装副本自动更新)——
  另立票 `skill-sync-mechanism`
- **不改**前端;不新增前端接入页

## 验收标准

- [ ] 平台可达时,`/init` 一次完成脚手架 → 建群 → 加成员 → 装 skill → 回填 groupId
- [ ] `AGENTS.md` 标记段中的 `groupId` 与建群返回值**逐字相等**(读回验证)
- [ ] `POST /groups` **显式传了** `creatorRole`,群成员里**没有**多余的 coordinator
- [ ] 已存在的参与方**按名字复用**,不重复注册
- [ ] 名字相同但属性冲突 → **报错**,不静默复用
- [ ] 每个成员按角色装上了对应 skill;已存在的被**覆盖**并标明「已更新」
- [ ] runtime 目录未知的成员 → 输出明确列出待手工安装项,**退出码非零**
- [ ] 平台不可达 → 只做脚手架,报告说明,**退出码非零**,不伪装成成功
- [ ] 非 TTY 下用参数驱动,**不提示、不阻塞**
- [ ] 同一份分配,交互与非交互两条路径**结果完全相同**
- [ ] `groupId` 已非空时重跑 → **不建新群**;群不存在时**报错**而非自作主张新建
- [ ] 已有文档文件不被覆盖(回归,沿用原 spec)
- [ ] 检测判据仍看 section 而非文件存在性(回归,沿用原 spec)
- [ ] 任一步失败 → 报告已完成到第几步,**不回滚**
- [ ] 测试覆盖上述每条;测试全绿并贴出用例数

## 不涉及

- skill 的持续同步机制(另票)
- 前端接入页
- 平台自身的安装部署(postgres / 后端启动)

## 执行环境提示

- 本仓 pnpm 项目;现有实现在 `scripts/coagenthub-init.mjs`,测试在同目录
  `.test.mjs`,用 **vitest** 跑(`npx vitest run scripts/coagenthub-init.test.mjs`),
  **不是** `node --test`
- 联网部分的测试**不要打真实后端** —— 用可注入的 fetch/HTTP 层,
  测试里替换掉。测试必须能在后端未运行时通过
