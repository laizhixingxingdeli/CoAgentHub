# 方案运行只读观测面（HTTP 与 Web）

本能力只投影已有 PlanRun/Mission 和服务内存输出，不改变 `plan-run` 的记录格式、驱动资格、升级决定、停止或合并语义。Web 是无构建的浏览器原生 ES module，只经 `/api/*` 读，不提供启动方案或作决定的写操作。网页列表按时间倒序；同票尝试时间线按发生顺序。

## 记录与任务 API

- `GET /api/plan-runs` 从服务已知记录目录枚举 JSON，默认目录为服务状态文件旁 `.coagent-plans`；服务成功托管的自定义 runDir 也登记。独立 createApi 默认读工作目录 `.coagent-plans`。非托管 CLI 任意自定义目录不会自动发现。按 startedAt 倒序；`?project=` 过滤有效记录的 projectId。有效摘要含 id、planId、projectId、integrationBranch、startedAt、stopped、features（featureId、title、status、missionIds）及 escalationCount。损坏或不可读文件单独 `{id,error}`，不使整份列表失败。读取走 PlanRun 的已有恢复校验，文件 id 安全验证，重复 id 确定性处理。
- `GET /api/plan-runs/:id` 返回原记录完整快照（升级问题、可用动作、决定、理由、签名与时间均在内）；缺失/非法 id 为 404，损坏记录明确报错，路径不能越目录。
- `GET /api/missions` 保持原有字段；仅对 origin 指向 `plan-run:<runId>` 且能确认的 Mission 额外投影 planRunId、featureId。优先依记录 features[].missionIds 消歧；普通 Mission 不增加来源字段。
- 上述路由与 live 均采用已有控制面只读鉴权策略，不新增写接口。

## 托管方案输出

runId 确定后，常驻服务在原 CLI NDJSON stdout/stderr 输出之外，按 runId 同时保留带 seq、at、channel、line 的内存行；预检前不能确定 runId 的输出不归类。`GET /api/plan-runs/:id/live?cursor=N` 返回 `{cursor,chunks,reason?}`，chunk 为 `{seq,at,channel,line}`，按 runId 隔离、游标递增；缓冲最多 5000 行，不持久化。非本服务托管、服务重启或未装缓冲时为空且附原因，游标没有新行时保持原值。

## Web

- `#/plan-runs/<id>` 展示方案开始/结束/时长/结局、票结果、该次 Mission 已上报费用汇总（缺费用如实提示），同 featureId 跨运行 Mission 的时间链（结局、合入 SHA、费用）、升级问题/原因/选项/决定/签名、实时输出及停止原因。运行中每三秒刷新，结束、离页或页面隐藏后停止；外来文字 HTML 转义。
- 项目页默认「方案运行」标签，按开跑时间倒序显示方案、票数及结局、升级数、费用，可进入详情；「全部任务」按 featureId 折叠多次 Mission，无 featureId 各自成组，按最新更新时间倒序，可筛进行中/需处理/已完成/已中止。任务页在 origin 指向方案时面包屑链接项目／方案运行／任务，普通任务旧面包屑不变。
- `src/web/narrate.js` 集中状态、停止、票状态、费用等文案；HTML 渲染保持纯函数、DOM 更新留在页面装配部分；颜色沿用 tokens.css 令牌，静态文件仍是一层扁平小写名。

实现：`src/application/plan-run-store.ts`、`src/application/live.ts`、`src/application/plan-runtime.ts`、`src/application/platform.ts`、`src/api/server.ts`、`src/main.ts`、`src/web/plan-run.js`、`src/web/projects.js`、`src/web/task.js`、`src/web/narrate.js`。
