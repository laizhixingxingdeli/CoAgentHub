# 设计笔记（存储、租约、归因链）

> 这是 v5 早期 README 里的设计记录，面向维护者：为什么文件版与 Postgres 并存、租约怎么防多进程互相回收、一跳的归因怎么冻在 Attempt 上。
> 使用说明请看仓库根目录的 [README.md](../README.md) 与 [docs/getting-started.md](getting-started.md)。


## 运行环境

Node 24+，靠原生类型剥离直接跑 TypeScript，**没有构建步骤**。

```
node --test
```

测试用 `node:test` + `node:assert/strict`。测试文件命名 `test/*.test.ts`，
从 `src/` 用相对路径带 `.ts` 后缀导入（`import { x } from "../src/kernel/y.ts"`）。

## 存储

两个实现并存，由 `COAGENT_STORE` 选（缺省 `file`）。

| | 文件 | Postgres |
|---|---|---|
| 依赖 | 无 | `pg` + 一个跑着的 Postgres |
| 并发写 | 靠进程锁，同时只有一个写者 | 版本号挡冲突，多进程可并行 |
| 活动日志 | 每记一条重写整份状态 | 一条 INSERT |
| 发号 | 读-加一-写，跨进程有竞态 | 原子自增，按号段预取 |
| 实时输出 | 持久 Activity 与 cursor Live 轮询 | 有 |

```bash
COAGENT_STORE=pg node src/main.ts
```

连接串走 `COAGENT_PG`，缺省 `postgresql://postgres:postgres@localhost:5432/coagenthub_v5`；
表在启动时自动建。

周期投递修复由 `COAGENT_RECONCILE_INTERVAL_MS` 控制（缺省 60000 毫秒；`0` 关闭）。
只补可核实的缺失投递，不把启动时的 Attempt / worktree 收敛改成周期任务。
`server.close` 与 `run-plan` 退出会先停周期任务再释锁；stop 或关 HTTP 失败不会丢掉另一个错误，告警回调抛错也不会让调度停住。

**文件版不会被删掉。** 它守着一条性质：clone 下来什么都不装就能跑通全部测试。
第三方依赖只允许出现在 `src/application/pg-store.ts`，`test/source-constraints.test.ts`
盯着这条——`pg` 一旦漏进用例层，"换存储不改用例层"就失效了，而那种泄漏是悄无声息的。

### 换存储踩到的坑（都已修，留作记录）

四个，前三个是同一类错误：**某条不变式的前提悄悄依赖了"只有一个写者"**。

- **启动收敛。** 它假设"我刚起来，所以没有任何 attempt 还活着"——只在单写者下成立。
  共用数据库之后，重启一次只读的观测面，就把正在跑的 attempt 判死并写回库，
  当场搞坏一条 Mission。现在两道防线：收敛要显式开启且按 missionId 限定范围，
  并且 attempt 带**租约**（见下）。
- **flush 重叠会自己跟自己撞。** 两个并发 flush 捏着同一个期望版本去写，后到的
  命中 0 行，报出一个纯属自制的"并发冲突"（真实并发根本没发生）。现在 flush 串行化。
- **一次写回全部 Project 会互相毒化。** 一个不相干的过期 Project 能把后续每一次写
  都顶成冲突。现在按内容判定，只写真的变了的那些。
- **测试 TRUNCATE 的是开发库。** 于是常驻服务器、正在跑的 Mission 和测试互相踩，
  症状是整套并行跑时零星红在**毫不相干的**测试上（git worktree、调度器主链），
  隔离复跑又全绿。测试现在用独立库 `coagenthub_v5_test`（`test/helpers/pg.ts`），
  不存在就建。

### 租约（多进程下"谁还活着"）

在途 attempt 上带 `heartbeatAt` + `leaseOwner`。跑它的调度器每 15 秒续一次租，
心跳**落库**——不落库的话别的进程看到的仍是"从没心跳过"，租约等于没做。

启动收敛只回收心跳过期（默认 90 秒）或从没心跳过的 attempt。"从没心跳过一律回收"
是刻意的：老数据和不打心跳的运行时行为要和加租约之前完全一致，否则升级之后
那些 attempt 永远收不掉，不变量 B 会把对应的 Mission 永久焊死。

## 分层

- `src/kernel/` —— 纯领域。**不得 import 任何第三方包**，不得出现
  provider / model / session / HTTP / SQL 这类概念。
- `src/application/` —— 用例层。工具的真实实现、调度、工作区、持久化。
- `src/runtime/` —— AgentRuntime 端口的实现。`spawn` 走真 agent，
  `scripted` 走脚本。**两个实现从第一天就并存**，"预留接第二个 agent 的能力"
  这句话才是可证伪的。
- `src/api/` —— HTTP 面（agent 工具端点 + 观测面）。

## 开跑简报：agent 开口之前就该知道的

托管 agent 启动时**直接拿到**契约或工单、架构红线、L3 的打回理由（S09.1）——
适配层在模型第一次开口之前取一次，塞进 system prompt，不走工具。

不这么做的代价不是"多一轮调用"：**执行者的工具表里根本没有读架构红线的口**，
不主动给，它就永远看不到，而红线是项目层面不可协商的东西。

按角色给不同的东西：协调者要契约与规划，执行者只要工单——给它契约只会诱导它
去重新定义目标，而那不是它的职责。

## 归因链：一跳到底记了什么

问"这一跳当时到底跑的是什么、花了多少"，答案必须**全在状态里**，不能靠回查
任何一张会变的表。

- 适配层那张 profileId → 实际身份的映射带版本号（`PROFILE_TABLE_REVISION`），
  改任何一行都要 +1。
- 每跳结束时，运行时把**解析结果**报回来，冻在 Attempt 上（S13.3）。
  冻的是通用的键值列表，不是写死的 provider/model 两个字段——换一个运行时
  可能是三个轴或一个，写死就等于把今天这个运行时的词汇刻进领域模型。
- 用量按 Project / Mission / Role / 上面那些键值聚合（S11.5，`/api/usage`）。
  没冻过身份的 attempt 进 `unattributed` 单列，**不摊给任何一家**——摊给谁都是编的。

## 与基线文档的偏离

只有一处，且是刻意的。

S15.2 把 **Recovery Reconciler** 列入推迟项，但 `reconcileInterruptedAttempts`
仍然在启动时跑了一遍。理由：不变量 B 规定同一 Mission 同时只能有一个在途
协调者尝试，于是**进程崩在半路上的那次尝试会把 Mission 永久焊死**——没有
任何别的出口，人手工改状态文件是唯一办法。

推迟项指的是常驻的、持续扫描并修复 Attempt / 调度状态的子系统；启动收敛仍
只跑一次，把"进程已经不在了却还是 in_progress"的尝试标成 `interrupted`
（可重试）。另有可关闭的周期投递补建（`COAGENT_RECONCILE_INTERVAL_MS`），
只补可核实的缺失投递，不是 DurableScheduler。

以下为早期基线记录；后续熔断、fencing 等实现以 `.coagent/specs/` 和模块地图为准。其余当时推迟项（每 WorkItem 独立 worktree、自动语义冲突解决、完整 Circuit
Breaker、Fencing Token、Transactional Outbox、Saga、exactly-once、自主
Provider 路由、跨机器迁移、完整 Shell Sandbox、改 pi agent-core）都没有碰。

## 安装、启动与开发

CoAgentHub 把需求拆成 Mission、WorkItem 与 Attempt，保存工单、证据、验收和恢复记录。Node 24+ 可直接运行文件存储版本；Postgres 版本先执行 `npm ci` 并准备独立数据库。规则入口是 [AGENTS.md](AGENTS.md)，模块职责见 [.coagent/architecture/modules.md](.coagent/architecture/modules.md)。

三层分工为 L3 冻结需求与签字、L2 规划并逐项验收、L1 执行冻结工单；用户明确授权直接开发时按 AGENTS.md 的本批例外执行。`src/l3.ts` 是检视者控制入口，查看命令用 `node src/l3.ts --help`；服务运行时进度通过插件或观测 HTTP 读取。

PowerShell 启动示例（新建状态必须显式指定路径，已有环境务必复用原状态）：

```powershell
$env:COAGENT_STATE = 'C:/path/to/coagent-state.json'
$env:COAGENT_AGENT_ENV_PASSTHROUGH = '-'
node src/main.ts
```

默认观测页面为 `http://127.0.0.1:3101`，健康入口 `/api/health`；完整路由、参数、鉴权与 curl 示例见 [docs/http-api.md](docs/http-api.md)。未显式指定状态且默认状态不存在时，启动会拒绝静默新建，以免分裂状态。观测页面不代替检视者验收或消费其 Delivery。

```powershell
node src/run-mission.ts C:/path/to/mission.json --cwd C:/path/to/repo --adapter C:/path/to/agent-entry.ts --max-rounds 20
node src/run-plan.ts C:/path/to/plan.json --cwd C:/path/to/repo --adapter C:/path/to/agent-entry.ts --max-rounds 40
node --test
npm run metrics -- --changed HEAD
```

服务持锁时 CLI 转交运行请求；不得另开写者直接加载主状态。`run-plan --check` 仅服务停止时运行。开发验证优先一两条对应测试，交付前运行全量 `node --test`；本批只允许 HAOFF1 既有 7 条跳过，任何新增跳过需解释。度量为零依赖近似告警，默认扫描 src，`--changed` 限制告警到指定基线后的改动，不参与合入判定；复杂签名和不可读取文件单列未分析。

## 部署与恢复

文件模式保持一个真实状态写者；备份状态与 `.coagent/`、Git 版本，并保留运行日志。Postgres 模式设置 `COAGENT_STORE=pg` 与 `COAGENT_PG`，不要将开发库和测试库混用。控制面可注入授权解析器，部署前按 HTTP 文档核实读写权限；示例请求头不代表内置认证配置。

Windows 常驻运行使用现有隐藏 VBS 包装器调用 cmd，再由 `explorer.exe` 启动；仅在持锁进程已退出且 3101 空闲时执行，避免重复启动。换代码前先暂停 Mission，核实执行者退出，再停止服务。进程已死、端口空闲、锁心跳超过 120 秒时由平台自动接管；不编辑状态文件恢复任务。具体停服、检查点批准和 runaway 处置见 [.coagent/architecture/reviewer-runbook.md](.coagent/architecture/reviewer-runbook.md)。
