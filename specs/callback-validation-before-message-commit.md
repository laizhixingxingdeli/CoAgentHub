# Spec: callback 语义校验发生在消息提交之后,400 请求仍留下已广播的消息

> **状态**: Frozen
> **版本**: 1.1
> **日期**: 2026-09-07
>
> **v1.1 修订(2026-09-07)**:§4.6 由「全量后端回归」改为「只跑改动触及的测试文件」。
> 理由与 [completion-event-fail-atomic-lease-guard.md](completion-event-fail-atomic-lease-guard.md)
> v1.1 相同(用户决策:本机全量 24 分钟,拖垮下发节奏)。
> **来源**: [docs/implementation-optimization-review-2026-09-07.md](../docs/implementation-optimization-review-2026-09-07.md) R3
> **相关**: [dispatch-fields-silent-loss.md](dispatch-fields-silent-loss.md)、
> [coordination-payload-contract.md](coordination-payload-contract.md)(均 Landed)——
> 本票不改 callback 的**判据**,只改**校验时机**。

## 1. 背景与目标

### 1.1 现状证据

[`messages.ts`](../packages/backend/server/src/routes/group/messages.ts) 的
`POST /:id/messages` 处理器里,写入与校验的顺序是:

| 行 | 动作 |
|---|---|
| 387 | `insertGroupMessage(...)` —— **消息 + closure 事务提交** |
| 406 | `wsHub.broadcastGroupMessage(full)` —— **WS 扇出已发生** |
| 511 | `throw BizError(InvalidRequest)` —— `callback.{platform,endpointRef,sessionRef}` 命中 `FORBIDDEN_RE`(URL / 命令 / 凭据 / 赋值形态 / 空白) |
| 527 | `throw BizError(InvalidRequest)` —— `callback.sessionRef` 与 `metadata.dispatcherSessionId` 冲突 |

在 `POST` 处理器中,**第 387 行之后仅剩这两处 4xx 抛出**(可复算:
`awk 'NR>=387 && NR<=630 && /throw new BizError/ {print NR}' packages/backend/server/src/routes/group/messages.ts`
→ 只输出 `511` 与 `527`)。其余校验——载荷形状、群可写、发送者存在与成员身份、
human 只读、audience/audienceRef 合法性、派发权限、`review_result` 定向、
`supersedesTaskId` 归属——都已经在写入之前完成。第 354–357 行的注释
「放在消息插入前,400 不会留下已提交的消息行」正是这条纪律的原文,
callback 这两处是漏网的。

另有一处次要缺口:第 540 行为取 `group.projectPath` **再次**调用
`assertGroupWritable(db, id)`。该函数在归档/软删群上抛 403,而它此刻位于插入之后
——群在两次调用之间被归档时,同样会出现「已提交且已广播,但接口返回 403」。

### 1.2 危害

调用方收到 400/403,合理地认为「这条消息没发出去」,于是修正后重试;
但第一条消息**已经落库、已经进 closure 树、已经被 WS 推给全部可见成员**。
结果是同一意图在群里出现两次——对协调链路而言就是**重复发言**,
而定向消息还可能被下游按「一条新指令」处理。

这条路径正是任务下发通道(`callback.sessionRef` 是会话延续的载体,见
`durable-task-completion-events.md` 与 coordinator skill §2),
出问题的是最不该出问题的那条链。

### 1.3 目标

**首次写入之前完成全部会导致请求失败的校验**;写入之后只做不可失败的动作
(广播、fire-and-forget 派发/控制通道)。请求失败时,数据库与 WS 上不留任何痕迹。

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/backend/server/src/routes/group/messages.ts` | 把 callback 归一化与两处校验(第 483–532 行的逻辑)前移到 `insertGroupMessage` 之前;第 540 行的重复 `assertGroupWritable` 改为复用插入前已取到的 group |
| `packages/backend/server/test/dispatcher-fields.test.ts` | 新增「400 不留痕」用例(见 §4) |

**不改**:`FORBIDDEN_RE` 的模式与错误文案(逐字保持,既有用例锁定的是它);
`canCarryDispatcher` 的权限判定规则(角色命中 `DISPATCH_ALLOWED_ROLES`);
`CALLBACK_STRIPPED_NOT_AUTHORIZED` / `SPEC_HASH_MISSING` 等**警告**的产生条件与
时机语义(警告不是失败,仍走响应头);`maybeDispatchExecutorTask` 的调用方式与
fire-and-forget 语义;PATCH / DELETE 两个处理器。

## 3. 详细改动

### R1. callback 归一化与校验前移

把当前位于派发分支内的这几件事,整体移到 `insertGroupMessage` 调用之前:

- `strip()` 去空白与空串;
- `FORBIDDEN_RE` 检查 → 400(**文案逐字不变**:
  ``callback.${k} 含非法内容:不允许 URL、命令、凭据、赋值形态或空白``);
- `callbackRef` / `callbackSessionId` 的构造;
- `callbackSessionId` 与 `metadata.dispatcherSessionId` 的冲突检查 → 400
  (**文案逐字不变**:`callback.sessionRef 与 dispatcherSessionId 冲突:两者必须相等`);
- `finalDispatcherSessionId` 的合成。

写入之后的派发分支**只消费**前移得到的结果,不得重新计算或二次校验
(单一判定出处,ADR-0009)。

### R2. 校验适用范围保持不变

前移**不得扩大**校验的适用面。现状是这两处校验只在
`(aud === "participant" || aud === "role") && audienceRef` 且 `canCarryDispatcher`
为真时执行;broadcast 消息、无权携带者的 callback 走的是**丢弃 + 警告**,不是 400。

前移后必须保持同样的适用条件:

- broadcast 消息即使带了非法 callback,**仍不返回 400**(callback 本就被忽略);
- 无权携带者(不命中 `DISPATCH_ALLOWED_ROLES`)的非法 callback,**仍是
  `CALLBACK_STRIPPED_NOT_AUTHORIZED` 警告 + 消息正常写入**,不是 400。

⚠️ 这是本票最容易改错的地方:把校验提到最前面顺手对所有消息生效,会让此前
合法的广播消息开始报 400。若实现者认为现状的适用面本身不合理,**停下来退回
检视者**(闸二),不要在本票里顺带改语义。

### R3. 消除插入后的 `assertGroupWritable`

第 255 行已经调用过 `assertGroupWritable(db, id)`;把它的返回值接住,
第 540 行改为复用,不再重复查询。效果:群可写性只判定一次,且判定点在写入之前。

### R4. 不变量(实现自检时对照)

> 在 `POST /:id/messages` 处理器中,`insertGroupMessage` 之后不存在任何
> 会抛出 `BizError` 的分支。

汇报中必须给出该不变量的**可复算证据**:

```
awk 'NR>=<insertGroupMessage 行号> && /throw new BizError/ {print NR": "$0}' \
  packages/backend/server/src/routes/group/messages.ts
```

在 POST 处理器范围内应无输出(PATCH/DELETE 处理器的抛出不计入,汇报中说明行号边界)。

## 4. 验收标准

每条都必须**读最终产物**:数据库消息行数、closure 行数、WS 扇出记录、task 行数
——不得只断言 HTTP 状态码。

定向测试命令:

```
cd packages/backend/server && npx vitest run test/dispatcher-fields.test.ts
cd packages/backend/server && npx vitest run test/group-message.test.ts
```

1. **非法 callback → 400 且零副作用**
   构造:coordinator 身份,`audience: participant` 定向到执行器成员,
   `callback: { sessionRef: "https://evil.example/x" }`(或任一命中 `FORBIDDEN_RE` 的值)。
   断言:响应 400 且**错误文案逐字**为既有文案;
   请求前后 `group_message` 行数**不变**;`group_message_closure` 行数**不变**;
   `task` 行数**不变**;**没有** `group_message` 类型的 WS 扇出
   (复用 `ws-hub` / `task-status-ws` 用例已有的扇出观察手法,不要新造机制)。

2. **sessionRef 冲突 → 400 且零副作用**
   构造:同时提供 `metadata.dispatcherSessionId: "a"` 与
   `callback.sessionRef: "b"`。
   断言:同第 1 条的四项零副作用断言 + 文案逐字。

3. **合法 callback 行为不变**
   构造:`callback: { platform: "codex", sessionRef: "coord-session" }`。
   断言:消息写入成功;创建出的 task 的 `callbackRef` 等于
   `{ platform: "codex", endpointRef: undefined, sessionRef: "coord-session" }`
   ——即 `dispatcher-fields.test.ts` 既有断言**逐字通过,不得修改**。

4. **broadcast + 非法 callback 仍不 400**(R2 的适用面回归)
   构造:`audience` 省略(broadcast),带一个命中 `FORBIDDEN_RE` 的 callback。
   断言:响应 200,消息正常写入(与改动前行为一致)。

5. **无权携带者的非法 callback 仍走剥离警告**(R2 的适用面回归)
   构造:仅 `executor` 角色的 participant 发送,带非法 callback。
   断言:响应 200;响应头含 `CALLBACK_STRIPPED_NOT_AUTHORIZED`;
   task 的 `callbackRef` 为 null。

6. **相关面回归(v1.1 起不再跑全量)**
   只跑**本次改动触及的测试文件**:
   ```
   cd packages/backend/server && npx vitest run test/dispatcher-fields.test.ts test/group-message.test.ts test/executor-trigger.test.ts test/executor-task-role-dispatch.test.ts test/coordination-payload-api.test.ts
   ```
   汇报中贴出改动前后同口径的通过/失败计数(本机 Windows 是红基线,口径是
   **失败数不增加**)。发现触及清单之外的模块 → 把对应测试文件加进命令并说明原因。

7. **类型检查**
   ```
   cd packages/backend/server && npx tsc --noEmit -p tsconfig.json
   ```

8. **不变量证据**:§3 R4 的 `awk` 输出贴进汇报。

## 5. 不涉及的改动

- **不改 R4「消息到 task 的持久化交接」**(报告 R4):`maybeDispatchExecutorTask`
  仍是 fire-and-forget,消息提交与 task 创建仍不在同一事务。那需要先做事务设计
  决策,**不在本票**。
- **不改载荷校验**(`parseKnownCoordinationPayload`)与 `review_result` 定向规则。
- **不改 `FORBIDDEN_RE` 的宽严**:它是否漏判/误判不在本票范围。
- **不改前端**。

## 6. 兼容性

- 无 schema 变更,无迁移。
- 对调用方而言:**合法请求的行为逐字不变**;非法请求从「400 + 消息已留下」变成
  「400 + 什么都没留下」。这是修正,不提供开关回退。
- 响应头警告、`X-Project-Init-Warning`、派发行为、控制通道均不变。
