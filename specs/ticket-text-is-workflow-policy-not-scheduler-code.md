# Spec: 任务书文案是工作流策略,不该编译进调度器

> **状态**: Frozen
> **版本**: 1.0
> **日期**: 2026-09-08
> **来源**: `docs/implementation-optimization-review-2026-09-07.md` §13.5 **S6**
> **前置决策(用户 2026-09-08 拍板)**:
> - **归属层级**:**全局一份 + 按 `dispatchKind` 覆盖**
>   (不按群、不按角色 —— 见 §3 R2 的理由);
> - **变更权限**:**只有人能改,且模板必须冻结**(入库 + 有 hash,
>   改动走 spec 流程)。
>
> **关系**:S6 是 **S4 的前置判断,不是替代**。
> 若先按 S4 把 ticket builder 拆成独立模块但内容仍是代码字面量,
> **S6 的三个后果一个都不解决**。

## 1. 背景与目标

### 1.1 现状证据(检视者已复核代码)

`packages/backend/server/src/lib/executor-task/queue.ts`:

| 函数 | 行 |
|---|---|
| `buildSpecSection` | 3814 |
| `buildExecutionContextSection` | 3830 |
| `buildExecutionModeSection` | 3857 |
| `buildReportSection` | 3901 |
| `buildTicket` | 3934 |

这些函数以 **TypeScript 字面量**的形式直接写入了:

- skill 名称(`coagenthub-coordinator` / `coagenthub-executor`)与安装指引;
- L2/L3 检视协议、`review_request` 载荷的 `lite` 档位规则;
- 「派发成功后立即退出本轮」的强制语义及其理由;
- 具体测试命令 `node scripts/test-baseline.mjs <包目录> <测试文件...>`;
- 「只跑票面指定的测试文件清单」「验收口径是失败数不增加」;
- commit message 约定与「不动 schema/迁移」等默认约束。

配套地 `packages/backend/server/src/routes/group/tasks.ts` 有 **78 处**
引用 `review_request` / L3 / `dispatchKind`。

### 1.2 与既有判据不一致

- `CONTEXT.md` 的「**平台不内置 AI**」;
- `docs/adr/0008-executor-adaptation-config-over-code.md` 的
  「**机制归代码,字段归配置**」。

任务书文案**既不是机制也不是字段,它是方法论**,却落在了代码侧。

### 1.3 三个具体后果

1. **改一句措辞要构建 + 受控重启** —— 即 AGENTS.md 「运行时与重启」那整套代价。
   2026-09-03~04 卡在旧构建 22 小时的事故,成本的一部分来自这里。
   ⚠️ 检视者补充实证:**2026-09-08 本轮同样踩到** ——
   `99113e88` 修好回滚后,运行中的 server 仍是 4.5 小时前的构建,
   必须重建重启才生效。
2. **调度器无法脱离这套工作流被测试**,正是 §12.4(T1)分类时会遇到的困难。
3. **与 §10 的协调者职责调整直接冲突**:§10.2 若落地,
   `buildExecutionModeSection` 与 `buildReportSection` 都要改代码,
   而 §10 明确写了「本文不改变当前生效规则」——
   两者之间**缺一个不需要改代码的通道**。

### 1.4 目标

**把「平台注入的执行上下文」与「工作流策略文本」分开。**

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/backend/server/src/lib/executor-task/queue.ts` | 策略段改为读模板 |
| 新增模板文件(位置由实现者定,见 R3) | 承载策略文本 |
| 对应测试 | 新增用例 |

**不改**:`tasks.ts` 的 **R2/R3 守卫**
(「PATCH 必须携带 / 反向守卫禁止携带 `review_request`」)——
⚠️ **那是平台侧的载荷契约,与文案是两件事**,报告 §13.5 明令决策前不要动;
`buildExecutionContextSection` 的**内容**(它是平台事实,见 R1);
既有占位符替换机制;`dispatchKind` 的取值集合;
skill 文件本身(`skills/*/SKILL.md`)。

## 3. 详细改动

### R1. 划线:平台事实留在代码,方法论出去

**留在代码(不可被模板覆盖或删除)**:

`buildExecutionContextSection`(queue.ts:3830)的全部内容 ——
`apiBase` / `participantId` / `groupId` / `taskId` / `X-Participant-Id` /
**detached 回写要求及其超时后果**。

**改为模板数据**:

`buildExecutionModeSection`(3857)与 `buildReportSection`(3901)的文案 ——
执行方式、汇报格式、测试与提交约定。

`buildSpecSection`(3814)**自行判断**:它同时含 specRef/specHash(平台事实)
与围绕它的说明文字(方法论)。**在汇报里说明你怎么切的、为什么。**

### R2. 层级:全局一份 + 按 `dispatchKind` 覆盖

**用户决策。** 理由记录在案:

- 不按群 —— 多个群的文案会各自演化,违背「同一事实单一出处」;
- 不按角色 —— 盖不住 `dispatchKind` 的差异
  (协调者票与执行者票的文案本就不同,而 `dispatchKind` 正是承载这个区分的维度)。

**查找顺序**:`dispatchKind` 专属模板 → 全局默认。
找不到就用全局,**不要报错**。

### R3. 冻结:模板入库 + 有 hash

**用户决策:只有人能改,且要冻结。**

- 模板**入库**(不是只存 DB),这样它有 git 历史、有 blob hash、能走 spec 流程;
- **平台自身不得写模板** —— 没有「协调者改自己文案」的写接口。
  ⚠️ 这一条是决策的核心:**防止被约束方修改约束自己的东西**。
- 若你同时做 DB 缓存以避免每次读盘,**DB 只能是缓存**,
  仓库文件是唯一真相源。

### R4. 第一版不要模板引擎

报告明确:「一个存 DB 或文件的**字符串 + 既有占位符替换**即可,
与 ADR-0008『**只有路径与枚举,没有条件、没有循环**』的克制取向一致」。

⚠️ **不要引入 Handlebars / Mustache / EJS 之类**。
若你觉得非引擎不可,**停下来报告**。

### R5. 平台段不可被模板覆盖

模板**不能**删除或改写 R1 里「留在代码」的那部分。

实现上要能防住:即使模板文件被改成空的,
任务书里 `taskId` 与 detached 回写要求**仍然在**。
**给一条用例钉死这一点。**

## 4. 验收标准

**基线先用工具取**(受影响文件自行判断,清单写进汇报):

```
node scripts/test-baseline.mjs packages/backend/server test/executor-trigger.test.ts <其它...>
```

1. **核心(报告 §13.5 原文的验收)**:
   **在不重新构建 server 的前提下**改变一次任务书的「执行方式」段落,
   下发一票并确认**执行器收到的是新文案**。
   ⚠️ 「不重新构建」是这条的全部意义 —— 若你的实现仍需 `esbuild` 才生效,
   **本票没有达成目标**,如实说明。
2. **平台段不可覆盖**(R5):把模板改空 → 任务书里 `taskId`、
   detached 回写要求仍在。给出实际的任务书文本。
3. **按 `dispatchKind` 覆盖生效**(R2):至少两种 `dispatchKind` 拿到不同文案;
   没有专属模板时回落全局,**不报错**。
4. **平台不能写模板**(R3):不存在写模板的 API;
   在汇报里说明你怎么保证的。
5. **`tasks.ts` 的 R2/R3 守卫未被改动**:
   `git show --stat` 中 `tasks.ts` 无改动,或若有**逐行说明为什么不得不改**。
6. **无模板引擎依赖**(R4):`package.json` 无新增依赖。
7. 定向测试前后对照,失败数不增加。
8. `npx tsc --noEmit -p tsconfig.json` 通过。

## 5. 不涉及的改动

- **不改 `tasks.ts` 的 R2/R3 载荷守卫**(报告明令)。
- **不引入模板引擎**(R4)。
- 不改 skill 文件本身、不改 `dispatchKind` 取值集合。
- **不实施 §10.2 的协调者职责调整** —— 本票只是给它铺出「不改代码就能调文案」
  的通道,职责调整本身是另一件事。
- 不做 S4 的模块拆分(S6 是它的前置,不是它)。

## 6. 兼容性

- **文案必须逐字保持现状** —— 第一版是**搬家,不是改写**。
  ⚠️ 在汇报里给出「搬家前后文案 diff 为空」的证据
  (例如同一票的任务书文本改动前后逐字相同)。
  这条很重要:如果搬家的同时改了措辞,出了问题就分不清是搬家坏的还是改写坏的。
- 无 schema 变更(若做 DB 缓存则有,单独说明)。
