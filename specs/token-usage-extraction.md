# Spec: Token 消耗提取 (Token Usage Extraction)

## 背景

执行器完成任务的汇报(任务书「汇报格式要求」段)目前只有「提交/测试/汇报/遗留」
四段,服务端 `parseTaskReport` 也只解析这四段。用户希望把每次执行消耗的 token 数
记录进任务结果,便于审计与成本统计。Durable Task Completion Events 与 callback
agent(核心层 + 回调层)已完成,本需求此前已确认「等 Durable 核心层完成后再下发」,
现在前置条件已满足,继续落地。

## 改动范围

涉及 CoAgentHub 服务端(不改 dsh 插件、不改 callback-agent):

- `packages/backend/server/src/lib/executor-task/report.ts`:
  - `TaskReport` 新增可选 `tokenUsage?: string`(或数字)字段。
  - `REPORT_SECTION_RE` 增加段落头匹配(与既有「提交/测试/汇报/遗留」同一套段落
    解析逻辑),匹配 `Token:` / `tokens:` / `token:` / `消耗:` 大小写变体。
  - `parseTaskReport` 解析出 token 段;值做清洗(去千分位逗号、去 `tokens/token`
    等后缀词、取首个数字组),空值省略。
- `packages/backend/server/src/lib/executor-task/queue.ts`:
  - `buildTicket` 的「汇报格式要求」段落中新增一行 `Token: <数量>`(沿用四段同款
    键值风格,让执行器按此输出)。
  - 完成路径(done)构建 `diffSummary` 时,`{ ...report }` 已透传新字段;确保 token
    值以 `tokenUsage` 键存入 `diffSummary`(与 `TaskReport` 字段名一致,勿另造键名)。
- 测试:`packages/backend/server/test/executor-report-quota.test.ts` 中
  `parseTaskReport` 大小写变体/缺段用例、集成成功卡片用例的 `toMatchObject` 断言
  补 token 相关断言(新增的小节)。

## 验收标准

- [ ] `parseTaskReport` 能识别 `Token:` / `tokens:` / `token:` 大小写变体并解析出数字。
- [ ] 缺 token 段时 `tokenUsage` 省略,不影响既有四段解析与渲染(向后兼容)。
- [ ] token 值包含千分位逗号或 `tokens` 等后缀时能被清洗成纯数字;非法/空值省略。
- [ ] 任务书「汇报格式要求」段包含 `Token: <数量>` 行。
- [ ] done 任务的 `diffSummary` 包含 `tokenUsage`(当执行器输出该段时)。
- [ ] 成功卡片(renderTaskCard)不因新字段改变既有渲染(卡片字段仍是提交/测试/汇报/遗留,
      不新增卡片行,避免破坏既有 UI/消费者断言)。
- [ ] 相关单测与集成测试全绿;服务端 `check-types`、`build` 通过。
- [ ] 文档同步:`docs/architecture.md`(任务书/汇报解析说明)与 `README.md`/`README_CN.md`
      (如提及汇报格式)在需要处补一句 token 汇报说明。

## 不涉及的改动

- 不改 dsh-coagenthub 插件与 callback-agent(它们只是消费/透传 `diffSummary`)。
- 不新增数据库列(token 存入现有 `diffSummary` JSONB,不做 schema/migration)。
- 不改变任务终态、调度、执行器协议、Post-Flight 裁决逻辑与成功卡片行数。
