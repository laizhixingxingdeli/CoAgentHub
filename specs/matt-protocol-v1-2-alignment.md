# Spec: Skills 对齐 Matt 协议 v1.2

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-21
> **上游基准**: mattpocock/skills v1.2.3(2026-08-06 发布,含 v1.2.0/v1.2.2/v1.2.3 变更集)
> **依赖**: 现行 coordinator/executor/bugfix skills;Skill 安装 API(GET /api/skills/:name 从磁盘实时读取)

## 1. 背景与目标

CoAgentHub 的三个 skill(coordinator / executor / bugfix)基于 Matt Pocock 工程纪律体系
(grilling → to-spec → to-tickets → implement → code review),当前对齐到上游 v1.1 水平
(已采用 to-spec / to-tickets 命名、frontier 拷问、双轴 Code Review、确认门)。

上游 mattpocock/skills v1.2(2026-08-05/06 连发 v1.2.0 / v1.2.2 / v1.2.3)引入了四类
与本仓库直接相关的结构性变化:

1. **人机分工边界位移**——wizard:只有人能做的步骤,agent 生成交互式脚本代人走完;
2. **探索产物留档**——prototype / research 票不再用完即删,归档 throwaway 分支 + context pointer;
3. **沟通纠偏与提速**——wait-what 一词纠偏、grilling 压轮(约 13 问 → 约 3 轮)、to-questionnaire 问卷决策;
4. **安全与可移植**——diagnosing-bugs 脱敏(redaction 第一动作)、harness-neutral 指令。

本 spec 把三个 skill 对齐到 v1.2.3。**只改 skill 文档与配套文档,不改任何服务端代码**——
skills 由 `GET /api/skills/:name` 从磁盘实时读取(`routes/skills.ts`),更新 SKILL.md 即生效。

### 1.1 上游变化 → 本仓库落点

| 上游变化 | 版本 | 落点 |
|---|---|---|
| grilling round-by-round 重构:拷问压缩至约 3 轮;facts(自查代码)与 decisions(用户定夺)用引导词显式分离;防自拷问(#532) | v1.2.0 | coordinator §1 |
| wait-what:用户表达困惑时,用少量上下文 + 简化技术英语(ASD-STE100)+ CONTEXT.md 通用语言重新表述,只修复当前一条消息(#751) | v1.2.0 | coordinator 新增小节 |
| to-questionnaire:决策人不在会话中时生成 Markdown 问卷;拷问"发给谁/要回什么"而非主题本身(#593) | v1.2.0 | coordinator 新增规则 |
| wayfinder 决策票(decision ticket):拆票单元是"以决策为解的问句";research 票由 subagent 并行烧掉,结论落 `research/<name>` throwaway 分支 + context pointer;research 票是"一票一会话"的唯一例外(#763/#538) | v1.2.0 | coordinator §5 |
| prototype = primary source:探索产物归档 `prototype/<name>` throwaway 分支 + context pointer,结论(verdict + question)持久化进 issue/ADR/commit,不再删除(#763/#488) | v1.2.0 | coordinator §5 |
| 本地票据一票一文件:`.scratch/<feature>/issues/<NN>-<slug>.md`,禁止合并单个 tickets.md(#502) | v1.2.0 | coordinator §5 |
| tdd 重塑为 reference-only:red → green,refactor 移出循环归入 code review;类型检查常跑、单文件测试常跑、收尾全量一遍;vertical slices 收入反模式说明 | v1.1 引入,v1.2 细化 | executor §3 |
| code review 重构坏味道词表(Fowler smells:调用即触发模型先验) | v1.1 引入,现行仍含(本仓库未补齐) | executor §4 |
| wizard 毕业(model-invoked):四类触发分支;agent 自己能做的是明确非触发;stages 式交互 bash 脚本;进度按 stage 计数、无时间估算;`bash -n` + `shellcheck` 验证(#680/#783) | v1.2.0/1.2.3 | executor 新增段 |
| diagnosing-bugs 脱敏:展示命令/输出/捕获产物时 redaction 是第一动作——`<REDACTED>`、凭据走 env vars、只引信号行;向用户索要 redacted 产物(#779) | v1.2.3 | bugfix §2(executor 汇报同样适用) |
| harness-neutral:派发/子代理指令不写死具体 harness 的工具名与 agent 类型名(#781) | v1.2.3 | 三 skill 通用约束 |

## 2. 改动范围

- `skills/coordinator/SKILL.md` — 拷问压轮、wait-what、问卷决策、决策票/研究票/原型留档
- `skills/executor/SKILL.md` — TDD 重塑、坏味道词表、wizard 人工墙、汇报脱敏
- `skills/bugfix/SKILL.md` — 诊断脱敏、harness-neutral
- `CONTEXT.md` — 领域词汇新增(决策票、throwaway 分支、context pointer)
- `docs/architecture.md` — skill 承载段落措辞同步(注明对齐 v1.2.3)
- **不改** `packages/` 下任何代码,**不改**任务书模板(buildTicket)

## 3. 详细改动

### 3.1 coordinator SKILL.md

**(a) §1 Grill 压轮 + facts/decisions 分离**(上游 #532)

保留 frontier 机制,追加四条:

1. **目标轮次**:整场拷问压缩到约 3 轮(不再逐问等待)。每轮把当前 frontier 的全部
   问题打包发出,一次性收回。
2. **facts/decisions 用引导词显式分离**,每个问题标注类型:
   - **Fact(事实)** — 能从代码库/文档/日志查到的,coordinator 自己查,不问用户;
   - **Decision(决策)** — 只有用户能定夺的(范围、取舍、优先级),才进拷问轮。
3. **确认门**(已有,保留):用户确认达成共识前不得进入 To-Spec。
4. **防自拷问**:不得在没有用户输入的情况下自问自答推进设计。

**(b) wait-what 纠偏规则**(上游 #751)

新增小节。用户表达困惑("等等,什么?"/"没听懂")时:

- 只修复**当前这一条消息**:用少量上下文 + 简化技术英语(短句、主动语态、一个概念一句)
  + `CONTEXT.md` 领域词汇重新表述;
- 不翻聊天记录长篇复盘,不引入新术语,不改变既定决策。

**(c) to-questionnaire 问卷决策**(上游 #593)

新增规则。当某个 Decision 的答案在会话之外(决策人不是当前用户)时:

1. 不阻塞等待——生成一份 Markdown 问卷交给决策人(异步填或会上过);
2. 问卷拷问的是"**发给谁、要回什么**",再把每个问题对准两者的差值;
   **不拷问主题本身**——那正是会话里答不了的;
3. 问卷回收后按答案继续推进 frontier。

**(d) §5 To-Tickets 升级为决策票模型**(上游 #763/#538/#488/#502)

1. **决策票(decision ticket)**:大特性拆出的每张票,单元是"以决策为解的问句",
   不是实现切片;实现切片才是下发给执行器的 task。
2. **research 票并行烧掉**:调研型决策票不挂起等待——协调者用 subagent(或作为 AFK
   调研任务派发给执行器)并行消化;结论落 `research/<name>` throwaway 分支,并在对应
   票/任务上留 context pointer(一行:分支名 + 结论一句话)。research 票是
   "一票一会话"的唯一例外。
3. **prototype 留档**:原型/探索产物不再用完即删——落 `prototype/<name>` throwaway
   分支 + context pointer;结论(verdict + question)持久化进 spec/ADR/commit,
   主分支只保留被验证过的决策。
4. **本地票据一票一文件**:不走 GitHub tracker 时,票据写
   `.scratch/<feature>/issues/<NN>-<slug>.md`,禁止合并进单个 tickets.md。
5. **大特性路由**:估摸塞不进一个会话的想法,先建决策票地图再收敛于 To-Spec;
   规模明确的一个特性直接走 Grill。地图收敛进 spec,**不直接下发实现**。

### 3.2 executor SKILL.md

**(a) §3 Test 重塑为 TDD reference-only**

Test 段改为参考式纪律,不规定逐步流程:

1. 循环只剩 **red → green**:先写失败测试,再写最小实现让它变绿;
2. **refactor 移出循环**——重构归入 §4 Code Review 阶段处理,实现会话不夹带重构;
3. 节奏:类型检查常跑、单文件测试常跑、收尾全量测试一遍;
4. 垂直切片:一次一个可验证切片,不横切分层。

**(b) §4 Code Review 补齐坏味道词表**(v1.1 遗留,现行协议仍含)

Standards 轴 checklist 追加:按 Fowler 重构坏味道词表自查——mysterious name /
duplicated code / feature envy / data clumps / primitive obsession / repeated switches /
divergent change / speculative generality / message chains / middleman(列出词表即可,
模型自带先验,命中即修)。

**(c) 新增「人工墙 → wizard」段**(上游 #680/#783)

执行中遇到**只有人能做的步骤**时,不再往 stdout/汇报里堆编号说明,改为生成一个
stages 式交互 bash 脚本交给人类跑:

- **触发分支(四类)**:配置基础设施 / 配置凭据或 CI secrets / 走陌生第三方
  dashboard / 一次性迁移或切换;
- **非触发(明确写出)**:agent 自己能跑的命令绝不包装成 wizard——"agent 能做的事
  agent 做;wizard 留给不会交给 agent 的点击、审批和后台操作";
- **脚本要素**:分 stage 推进、每个 stage 有确认门、敏感输入隐藏回显、产物幂等写入
  `.env`、跳过项收尾汇总;
- **进度按 stage 计数,不估算时间**;
- 生成后用 `bash -n`(语法)与 `shellcheck`(如可用)自检;
- **适配约束**:CoAgentHub skill 为单文件下发(GET /api/skills/executor),不捆绑上游
  template.sh 库——上述要素以"生成脚本必须包含什么"的形式内联描述。

**(d) §5 Report 脱敏**(上游 #779)

汇报与展示的命令/输出/产物,脱敏是第一动作:

- 凭据/token/密钥一律写 `<REDACTED>`;
- 能用环境变量承接的循环,不把凭据写进脚本或输出;
- 引用产物只引携带信号的行,不整段粘贴。

注意:只约束展示内容,不改变汇报五段结构(提交/测试/Token/汇报/遗留)——server 按段
解析的契约不动。

### 3.3 bugfix SKILL.md

**(a) §2 Diagnose 脱敏**(上游 #779,最直接落点)

diagnosis-rules 追加三条:

1. 展示命令、输出、日志、捕获产物**之前**先脱敏:`<REDACTED>`、凭据走 env vars、
   只引携带信号的行;
2. 向用户索要的复现产物(repro artifact)必须要求 **redacted 版本**;
3. 诊断完成的判定标准包含"所展示内容已脱敏"。

**(b) harness-neutral 约束**(上游 #781)

三个 skill 的 Constraints 各加一条:指令不得写死具体 harness 的工具名/子代理类型名,
保持跨 harness 可执行(CoAgentHub 工具名 `coagenthub_*` 除外——那是平台契约)。

### 3.4 文档同步

- `CONTEXT.md` 领域词汇表新增:**决策票(decision ticket)**、**throwaway 分支**
  (`research/<name>` / `prototype/<name>`)、**context pointer**;
- `docs/architecture.md` skill 承载相关段落(「任务书自包含原则」附近)补一句:
  skills 对齐 Matt 协议 v1.2.3;
- `README.md` / `README_CN.md`:"基于 Matt 任务书规范"措辞补版本号(可选,低优先)。

## 4. 验收标准

- [ ] coordinator SKILL.md:grilling 段含"约 3 轮"目标与 Fact/Decision 引导词分离;保留确认门;含防自拷问
- [ ] coordinator SKILL.md:含 wait-what 纠偏规则(只修复当前消息;简化技术英语 + CONTEXT.md 词汇;不翻记录不复盘)
- [ ] coordinator SKILL.md:含问卷决策规则(拷问"发给谁/要回什么",不拷问主题本身;回收后继续 frontier)
- [ ] coordinator SKILL.md:To-Tickets 段含决策票定义、research 票 subagent 并行烧掉 + `research/<name>` 留档 + context pointer、prototype 留档 `prototype/<name>` + 结论入 spec/ADR、本地一票一文件 `.scratch/<feature>/issues/<NN>-<slug>.md`、大特性先地图后 To-Spec
- [ ] executor SKILL.md:Test 段为 red → green 参考式,refactor 明确移入 Code Review;含"类型检查常跑/单文件测试常跑/收尾全量一遍"
- [ ] executor SKILL.md:Standards 轴含 10 个坏味道词
- [ ] executor SKILL.md:含 wizard 段(四类触发分支 + 明确非触发 + stages 要素 + 确认门/隐藏回显/幂等写入 + 按 stage 计数不估时 + `bash -n`/`shellcheck` 自检)
- [ ] executor SKILL.md:Report 段含脱敏三则(`<REDACTED>` / env vars / 只引信号行),且明示不改变汇报五段结构
- [ ] bugfix SKILL.md:Diagnose 段含"脱敏是第一动作"、索要 redacted 产物、诊断完成判定含已脱敏
- [ ] 三个 skill 的 Constraints 均含 harness-neutral 条款
- [ ] CONTEXT.md 词汇表含 决策票/throwaway 分支/context pointer;docs/architecture.md 措辞同步
- [ ] `packages/` 下零代码改动;buildTicket 输出与现行完全一致(「执行方式」段不变)
- [ ] pnpm test 全绿、check-types 通过、build 通过(纯文档改动,应零影响)

## 5. 不涉及的改动

- **不动任务书模板**(buildTicket/「执行方式」段)——spec「skill-enforcement-and-ticket-slim」
  的约束仍然有效:执行流程由 skill 承载,任务书只触发 skill
- **不动服务端代码**:skill 由 GET /api/skills/:name 磁盘实时读取,无 API/DB 变更;
  汇报五段解析契约不变
- **不引入捆绑资源文件**:不移植上游 template.sh / SKILL-MECHANICS.md 等,保持单文件 skill
- **不做双平台元数据**(agents/openai.yaml、Claude plugin 打包、skills.sh 三态分发):
  CoAgentHub 走自己的单文件下发,与上游分发形态无关,为有意偏离
- **不完整复刻上游新 skill**(ask-matt 路由、writing-for-agents、to-questionnaire 独立
  skill 化、improve-codebase-architecture YAGNI 扫描):仅吸收对 coordinator/executor/bugfix
  三角色有行为影响的部分
- 不新增 npm 依赖,不改前端

## 6. 兼容性

- skill 内容更新后,已通过 GET /api/skills 安装过旧版的执行器**不会自动更新**——需重新
  拉取安装(安装指令流程不变);coordinator 验收时可要求执行器重新安装(不强制)
- 任务书解析、汇报五行解析(提交/测试/Token/汇报/遗留)不受影响
- 脱敏要求只约束"展示/汇报"层,不改变任务执行与 git 提交行为
- 落地后与上游 v1.2.3 的关系:吸收全部行为级变化;分发形态差异(单文件 vs plugin)与
  未复刻的独立 skill 为有意偏离,记录于本节
