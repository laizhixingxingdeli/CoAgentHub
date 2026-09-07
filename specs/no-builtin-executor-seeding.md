# Spec: 不再为用户播种内置执行器配置与默认参与者

> **状态**: Frozen
> **版本**: 1.0
> **日期**: 2026-09-07
> **来源**: 用户决策(2026-09-07)——「去掉默认的参与者配置,全都让用户自己配置,
> 不要帮用户加默认的参与者」。
> **相关**: [ADR-0008](../docs/adr/) 把执行器从代码内置改为配置驱动;
> `0028_seed_builtin_executor_configs.sql` 是那次改动的迁移侧产物,本票收掉它的播种行为。

## 1. 背景与目标

### 1.1 现状证据

- `packages/backend/database/drizzle/migrations/0028_seed_builtin_executor_configs.sql`
  向 `executor_config` **插入 6 行**内置配置(`executor`/`reasonix`/`codebuddy`/
  `codex`/`hermes`/`win-hermes`),`ON CONFLICT (key) DO NOTHING`。
- `executors.ts` 的 `ensureExecutorParticipants(db)` 在**开机时**遍历
  `effectiveExecutors(db)`,为每条配置 `registerExecutorParticipant` —— 于是这 6 条
  播种配置在首次启动后各自变成一个 participant。
- 结果:用户什么都没配,`GET /api/participants` 就已经有一串 AI 工具身份。
  本机实测,用户事后手工删掉了 `reasonix` / `hermes` / `win-hermes` 三条,
  并把剩下三条的 `bin` 改成了本机真实路径 —— 播种值对用户没有一条是直接可用的。

### 1.2 为什么要改

`executors.ts` 的模块注释已经写着:

> 不再有代码内置默认执行器(ADR-0008):列表里有的,就是这台机器上真的配了的。

**这句话现在是假的**:代码里确实没有 `DEFAULT_EXECUTORS` 数组了,但同一批默认值
被搬进了迁移,启动后照样出现在列表里。用户看到的仍然是「我没配过的东西」,
而且它们的 `bin` 指向本机不存在的命令,只有报错时才会发现。

配置驱动的意义是**列表即事实**。播种把「事实」污染成「猜测」。

### 1.3 目标

- **全新安装:零内置执行器配置、零自动创建的 AI 工具 participant。**
- **既有安装:一行都不动** —— 现存配置已被用户编辑,是用户数据。
- 空配置状态必须是**可理解、可操作**的,而不是一片空白或难懂的报错。

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/backend/database/drizzle/migrations/` | 让全新安装不再得到那 6 行(机制自选,见 R1) |
| `packages/backend/server/src/lib/executors.ts` | 仅在需要时调整注释与空集合处理;**不改** `ensureExecutorParticipants` 对真实配置行的注册行为 |
| 前端「接入参与方」相关页面 | 零配置时的空态引导(R4) |
| `docs/architecture.md` / `docs/adr/` | 同步(R6) |

**不改**:`POST /api/executors` 新增配置时自动注册 participant 的行为(那是**用户
发起**的,正是本票要保护的路径);执行器配置表结构;`effectiveExecutors` 的缓存;
任务派发与路由逻辑。

## 3. 详细改动

### R1. 全新安装不得播种任何内置执行器配置

跑完全部迁移的空库,`executor_config` 必须是 **0 行**。

机制由实现者选择并在汇报中说明理由,可选方向:把 0028 的 INSERT 变为无操作
(注意 drizzle 迁移校验/哈希的影响)、或新增一条迁移在「行与播种值逐字相同」时
删除它们。**无论选哪条,R2 都是硬约束。**

### R2. 既有安装的现有行一律不动(硬约束)

升级路径上,`executor_config` 已有的每一行的
`key` / `agent_name` / `type` / `kind` / `bin` / `url` / `args` / `label` /
`model` / `memory` / `max_concurrency` / `input_mode` / `env` / `output_profile`
**必须逐字不变**,也不得删除任何行。

⚠️ 本机当前 5 行配置里有 3 行(`executor`/`codebuddy`/`codex`)出身于播种但
**已被用户改写 `bin`**,并且是当前唯一能干活的执行器。**误删它们会让整条派发链
再次瘫痪。** 「按播种值精确匹配才删」这类方案必须先证明匹配不到这些行。

### R3. 启动时不为「用户没配过的东西」创建 participant

`ensureExecutorParticipants` 只对 `executor_config` 里**真实存在的行**注册
participant —— 这已经是现状,本票**只做确认与回归**,不扩大改动。
配置为 0 行时,它不得创建任何 AI 工具 participant。

### R4. 零配置下的空态必须可操作

没有任何执行器配置时:

- `GET /api/executors` 返回 `[]`(不是错误);
- 前端「接入参与方」页面显示空态,并给出**下一步动作**的指引(去哪里新增一个执行器配置);
- 建群、发消息、看群列表等不依赖执行器的功能**照常可用**;
- 向不存在的执行器定向下发时,仍走既有的可见失败信号(响应头 warning /
  任务失败原因),**不得静默跳过**。

### R5. `Local User` 是例外,并写明理由

`resolveLocalUser(db)` 预建的 LAN 观察者身份**保留**:它不是「用户的 AI 工具配置」,
而是匿名读取路径的稳定身份回落,删掉会让未声明身份的 GET 失去归属。
在代码注释里写明这条例外,避免后来者按本票把它一并删掉。

若用户希望连这个也去掉,那是另一张票(涉及匿名访问的身份模型),不在本票。

### R6. 文档同步

- `docs/architecture.md` 中涉及 0028「把旧内置配置写成 seed 行」的描述;
- `executors.ts` 模块注释中「列表里有的,就是这台机器上真的配了的」—— 本票之后
  这句才第一次成立,把它与迁移现状对齐;
- ADR-0008 追加一条后续决策引用(**保留原决策文字,不抹改**)。

## 4. 验收标准

1. **全新安装路径**(必须真跑,不能只读 SQL):
   ```
   createdb coagenthub_fresh_test
   DATABASE_URL=...coagenthub_fresh_test pnpm --filter @laizhixingxingdeli/database migrate
   psql ...coagenthub_fresh_test -c "select count(*) from executor_config;"   -- 期望 0
   psql ...coagenthub_fresh_test -c "select name from participant;"           -- 期望仅 Local User(或空)
   ```
   贴出实际输出。

2. **升级路径**(硬约束 R2):在**当前生产库的副本**上跑迁移,前后对比
   `select key, agent_name, type, kind, bin, url, args, label, model, memory, max_concurrency from executor_config order by key;`
   的完整输出,**逐字相同**且行数不变(当前为 5 行)。贴出前后两份输出。

3. **零配置可用性**:在全新库上启动 server,`GET /api/executors` 返回 `[]`;
   建群、发广播消息成功;前端「接入参与方」页面渲染出空态引导(截图或渲染断言,
   不接受「函数返回了空数组」当作页面验收)。

4. **回归**:
   ```
   cd packages/backend/server && npx vitest run
   ```
   ⚠️ 本机 Windows 基线是红的(2026-09-07 实测 **129 failed | 924 passed**,
   测试用 `#!/bin/sh` 假执行器,Windows 起不来)。验收口径是**失败数不增加**;
   若有测试依赖播种行(`seedBuiltinExecutorConfigs` 在多个测试里被调用),
   按新契约更新并**逐条列出改了哪几个、为什么**。

5. **类型检查**通过。

## 5. 不涉及的改动

- **不删既有配置行**(R2 硬约束的另一面)。
- **不改 `POST /api/executors` 的自动注册 participant** —— 用户发起的注册是本票要
  保护的正路。
- **不动 `Local User`**(R5)。
- **不改执行器路由/派发/队列**。
- 不引入「一键导入推荐执行器」之类的替代品:本票的诉求是**不替用户做决定**,
  换个入口再塞一遍是绕过。

## 6. 兼容性

- 既有安装:**行为零变化**(R2)。
- 全新安装:首次进入时没有任何执行器,必须先在「接入参与方」里配一个才能派发。
  这是本票的**预期**行为变更,需在 README / usage 文档中写明。
- 无表结构变更。
