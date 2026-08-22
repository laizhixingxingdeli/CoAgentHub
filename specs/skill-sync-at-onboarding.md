# Spec: skill 同步移到接入参与方时,一次装全套

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-23
> **协作模式**: 三层

## 背景与设计决策

**skill 是参与方级资产,角色是群组级绑定。**

一个 agent 装了哪些 skill,是它这台机器上的事实,与它加入了哪个群无关。
而它在某个群里扮演什么角色(executor / coordinator / reviewer),是群成员关系的事实。
当前实现把这两件事混在一起——加群时按 `roles` 发对应 skill 的安装引导——由此产生下面三个问题。

**决策**:接入参与方时**一次性同步全部四个 skill**(executor / coordinator / bugfix / reviewer);
具体使用时,**按群成员关系里定义的角色**决定走哪一份。

---

## 当前实现的三个问题

### 问题一:无条件重发,同一个 agent 加 N 个群收 N 条

`routes/group/members.ts:105-145` 在加成员后 fire-and-forget 发安装引导,
**完全不检查 `participant.capabilities` 是否已含该 skill**。
`capabilityHint`(同文件 111 行)读了 capabilities,但只用于角色匹配提示,与发引导无关。

实测:一个群里就有三条这样的消息;同一个执行器加进五个群会收五条完全相同的引导。

### 问题二:引导落在群消息流里,污染需求时间线

引导以 `audience: "participant"` 定向发送,但它是**群消息**——落在时间线里占位置。
`specs/group-detail-readability.md` 已要求「skill 安装引导不出现在需求时间线中」,
那份 spec 是在**渲染层**藏掉它;本 spec 从**源头**解决:根本不该发进群里。

> ⚠️ 两份 spec 会碰到同一处。执行本票时若 readability 那票已落地,
> 不要回退它的渲染层改动——两层防护并存是合理的。

### 问题三:时机太晚

加群往往意味着任务马上要下发,而此时才提示「你得先装 skill」,agent 来不及。
接入参与方时是从容的——那才是装 skill 的时机。

---

## 要求

### R1. 接入时投递全套 skill

`POST /api/participants` 的响应体**带回全部四个 skill 的完整内容**。

理由:接入时参与方**尚未加入任何群,没有消息通道**,响应体是唯一能一次到位的投递口。
skill 内容是现成的(`routes/skills.ts` 的 `SKILL_NAMES` + `readSkillDescription` 已读同一批文件),
**复用它,不要写第二份读盘逻辑**。

- 四个 skill 全部返回,**不按角色筛选**(接入时还不知道它会在哪些群扮演什么角色)
- 具体字段形状自行设计,但**必须与 `GET /api/skills` 的形状协调**——
  别让同一批数据出现两种结构
- 响应体积会明显变大(四份 SKILL.md)。若判断这不可接受,
  可改为响应里只给**拉取指引**(名单 + 各自的 URL),**在汇报里说明选了哪种及理由**

### R2. 接入时能记录同步结果

agent 写盘后需要能把「我装好了哪些」告诉平台。现有机制是发消息触发
`handleSkillInstallConfirmation`——**但接入时没有群、没有消息通道**,这条路走不通。

- 提供一条不依赖群消息的上报路径(`PATCH /api/participants` 已存在且不校验持有者,优先复用)
- capabilities 的写入**必须幂等**(重复上报不产生重复项)——
  `handleSkillInstallConfirmation:109` 已有幂等追加逻辑,**复用它,不要写第二份**
- ⚠️ **不要在接入时直接把四个 capability 全写进去**:
  capabilities 应反映**实际安装状态**,不是平台的一厢情愿。
  agent 拿到内容不等于写盘成功,凭空置位会让后续「查 capabilities 判断是否装好」失去意义

### R3. 加群时不再无条件发引导

- **移除**加群时向群消息流发 skill 安装引导的行为(`members.ts:105-145` 那一段)
- 改为:**仅当 `participant.capabilities` 缺少该群角色对应的 skill 时**,
  在**加成员接口的响应里**给出提示——与 `capabilityHint` 同一个出口,
  **不产生任何群消息**
- 角色 → skill 的映射用现成的 `COAGENTHUB_SKILL_CAPABILITIES`
  (`participant-capabilities.ts:69`),**不要新建映射表**
- `bugfix` 不是群角色,映射时注意它没有对应的 `roles` 值

### R4. 接入参与方页面呈现同步状态

`pages/app/participants/index.tsx` 已有 capabilities 字段(第 316 行按逗号分隔编辑)。

- 在接入/编辑参与方处呈现**四个 skill 各自的同步状态**(已装 / 未装),
  数据源是 `participant.capabilities`
- 未装时给出**可操作的指引**(让用户知道下一步该在 agent 机器上做什么),
  不要只显示一个红叉
- capabilities 的自由文本编辑**保留**——它还承载 `code-review` 等非 skill 标签,
  不要把这个字段改成只能勾选 skill

---

## 验收标准

### R1
- [ ] `POST /api/participants` 响应带回四个 skill(或拉取指引,二选一并已说明理由)
- [ ] 读盘逻辑复用 `routes/skills.ts`,不存在第二份
- [ ] 与 `GET /api/skills` 的数据形状协调
- [ ] 新增测试覆盖响应内容

### R2
- [ ] 存在不依赖群消息的 capabilities 上报路径
- [ ] 重复上报幂等,capabilities 不出现重复项
- [ ] 接入时**不**凭空写入 skill capability
- [ ] 新增测试覆盖幂等性

### R3
- [ ] 加群**不再**产生 skill 安装引导群消息(现有相关测试需相应调整,**在汇报里列出改了哪些**)
- [ ] capabilities 已含对应 skill 时,响应里**无**提示
- [ ] capabilities 缺对应 skill 时,响应里**有**提示且不产生群消息
- [ ] 角色映射用 `COAGENTHUB_SKILL_CAPABILITIES`,无新建映射表
- [ ] 新增测试覆盖「已装不提示 / 未装才提示」两种情况

### R4
- [ ] 参与方页面能看出四个 skill 各自的同步状态
- [ ] 未装时有可操作指引
- [ ] capabilities 自由文本编辑仍可用

### 共同
- [ ] `pnpm --filter server test` 全绿(先跑一次确认基线,不得减少)
- [ ] `pnpm --filter @laizhixingxingdeli/web test` 全绿
- [ ] `pnpm --filter @laizhixingxingdeli/web build` 通过

## 不涉及

- **不改** `GET /api/skills` 的既有契约
- **不改** skill 文件本身的内容
- **不改**协调者「按群角色决定用哪份 skill」的行为——这条本来就对,
  本票只是让它**有 capabilities 可查**,而不是靠猜
- **不做**平台替 agent 写盘:skill 要落在 agent 自己机器的 skills 目录,
  平台只能投递内容与记录状态
- 不引入新依赖

## 执行环境提示

- 本仓是 **pnpm** 项目
- 后端当前以 `pnpm --filter server start`(无 watch)运行中:
  改完后端代码需手动 build + restart 才生效,跑测试不受影响
- 沙箱执行器注意:全量测试里有需监听本地端口的用例会报 `listen EPERM`,
  那是环境限制不是回归——**全量由协调者代跑**,你只需跑定向测试与类型检查
