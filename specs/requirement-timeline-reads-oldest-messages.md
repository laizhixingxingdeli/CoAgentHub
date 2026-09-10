# Spec: 需求时间线读的是最老 200 条消息,活跃群会静默丢掉近期全部消息

> **状态**: **Landed**(2026-09-11,与本 spec 同一提交)
> **版本**: 1.1 —— 起草时把「mock 匹配器 5 处」写错了,实际 7 处跨 3 文件,
> 已在 §3 R2 更正并留作反例。
> **日期**: 2026-09-11
> **来源**: `docs/implementation-optimization-review-2026-09-07.md` §4 **R5**(客户端部分)
> —— 复核时发现 R5 的服务端部分**早已落地**,且客户端这半边已经从「建议」
> 变成一个正在逼近触发条件的活缺陷,故从 R5 中单独切出本票。
> **并入**:报告 §5 **S5-3**(group 数据层)。S5-3 原本要求「消息页和需求面板
> 复用加载/分页/WS 合并」,但**消息页已经不存在了** —— 群页面现在是
> RequirementWorkspace,消息消费者只剩 `requirement-workspace.tsx` 与
> `use-unread.ts`(后者已正确使用 `?limit=1`)。「两个页面复用」的前提消失,
> S5-3 的剩余实质就是本票。

## 1. 背景与目标

### 1.1 现状证据(检视者已复核)

`message-service.ts` 的 `listMessages` 有两套互斥语义,取决于**调用方传不传
`limit`**:

| 调用方式 | SQL | 返回 |
|---|---|---|
| 不传 `limit` | `ORDER BY id ASC LIMIT 200` | **最老的 200 条** |
| 传 `limit=n` | `ORDER BY id DESC LIMIT n` 再 `.reverse()` | 最新的 n 条(正序) |

代码位置:`packages/backend/server/src/lib/services/message-service.ts`
—— `hasExplicitLimit ? desc(id) : asc(id)`,以及末尾
`return hasExplicitLimit ? messages.reverse() : messages;`。

而 `packages/frontend/web/src/components/layout/context-panel/requirement-workspace.tsx`
的 `loadMessages` 是:

```ts
const res = await fetch(`/api/groups/${groupId}/messages`);
```

**不传 `limit`** → 落到「最老 200 条」那一支。

### 1.2 后果:不是少显示,是显示错

拉回来的 `messages` 不只是拿来预览,它喂给 `deriveRequirementLayerState`
(同文件 `useMemo`,`groupTasksBySpec(...).map(...)` 内),用来推导**每条需求的
L1/L2/L3 层状态**;另外还经 `messages={messages}` 传给 TaskPanel 与
RequirementDetailPanel。

群一旦超过 200 条消息,近期需求对应的消息**一条都不在返回集里**,层状态于是
基于空集推导。表现不是「历史看不全」这种一眼可见的缺失,而是**近期需求的层
状态静默失真**,且越活跃的群错得越厉害。

### 1.3 触发条件正在逼近(实测)

2026-09-11 查开发库(`coagenthub`):

```
群消息数:  coagenthub = 124
全库总数:  124
```

**124 / 200**。距触发还剩 76 条,而单个协作会话就能产生可观增量。也就是说这
不是「将来某天」的隐患。

### 1.4 目标

让需求时间线读**最新**的一页消息,而不是最老的一页。不引入游标分页——
完整的三段语义(最新窗口 / 向前历史 / 向后增量)仍属报告 R5 的范围,本票只
修「读错了一头」这个确定的缺陷。

## 2. 改动范围

**只改前端一处 fetch 与其测试。** 服务端不动:两套语义是既有设计,`use-unread.ts`
已经在正确使用 `?limit=1`,本票不改变任何服务端行为。

允许触碰:

- `packages/frontend/web/src/components/layout/context-panel/requirement-workspace.tsx`
- `packages/frontend/web/src/components/layout/context-panel/requirement-workspace.test.tsx`
- `packages/frontend/web/src/pages/app/groups/messages.test.tsx`(仅 mock 匹配器)
- `packages/frontend/web/src/router.test.tsx`(仅 mock 匹配器)

## 3. 详细改动

### R1. `loadMessages` 显式带上分页大小

`loadMessages` 的请求改为携带 `limit`,取值 **200** —— 与原先的隐式
`MESSAGE_PAGE_LIMIT` 等量,**只翻转取哪一头**,不改变单次拉取的数据量,
因此不影响渲染成本与内存占用。

数值必须**在代码里以具名常量出现并注释说明为何是 200**(它与服务端
`MESSAGE_PAGE_LIMIT` 同值是有意的),不允许写成裸字面量。

### R2. 测试 mock 的 URL 匹配器必须同步

⚠️ **这是本票最容易做砸的地方。** 全仓有 **7 处** mock 用
`url.endsWith("/messages")` 匹配,**跨 3 个文件**:

| 文件 | 处数 |
|---|---|
| `requirement-workspace.test.tsx` | 5 |
| `pages/app/groups/messages.test.tsx` | 1 |
| `router.test.tsx` | 1 |

加上 query 之后这些匹配器**全部失配**,mock 不再命中,测试会以难以归因的
方式红。

> **本票起草时这里写的是「5 处,都在 requirement-workspace.test.tsx」——
> 错的。** 后两个文件同样 mock 这个端点,`router.test.tsx` 更是会渲染群页面
> 进而挂载 RequirementWorkspace、真的发出这个请求。之所以没漏,是因为下面
> 那句「动手前先 grep 拿完整清单」被照做了。这条留在这里当反例:**清单靠
> 现搜,不靠起草人记忆。**

要求:改为对 query 不敏感的匹配(例如比对 `URL` 的 pathname,或用
`includes("/messages")`),而不是把 query 串硬编进 `endsWith`。硬编 query 会
让下次调整 limit 时再次全体失配。

**动手前先 `grep -n '"/messages"' <测试文件>` 拿到完整清单**,逐个改完再跑,
不要改一处跑一次。

### R3. 补一条回归用例

新增用例断言 `loadMessages` 发出的 URL **带 `limit` 参数**。理由:本缺陷的
表征是「返回了错的一头」,而组件侧看不出差别——只有请求 URL 能证明取的是
哪一支语义。断言应检查解析后的 `searchParams.get("limit")`,不要断言完整
URL 字符串(会被 base、顺序影响而变脆)。

## 4. 验收标准

1. `requirement-workspace.tsx` 的 `loadMessages` 请求带 `limit=200`,该数值是
   具名常量且有注释说明与服务端 `MESSAGE_PAGE_LIMIT` 同值的用意。
2. 新增用例断言请求 URL 的 `limit` 参数存在且为 200;把改动还原后该用例必须
   **红**(证明它真的在测这件事,不是恒真断言)。
3. `pnpm --filter @laizhixingxingdeli/web test` 中
   `requirement-workspace.test.tsx` **全绿**,用例数不减少 —— 5 处 mock 匹配器
   都已同步,没有出现「mock 未命中导致的静默降级」。
4. `pnpm exec turbo run check-types` 通过。
5. `pnpm exec biome check .` 退出码 0。
6. 前端整包测试相对改动前**不新增失败**。已知既有失败一条:
   `src/router.test.tsx` 首条(懒加载 chunk 超 `findBy` 默认 1000ms),
   与本票无关,不要顺手"修"它。

## 5. 不涉及的改动

- **不实现游标分页**。报告 R5 完整要求的「最新窗口 / 向前历史 / 向后增量」
  三段语义不在本票内,超过 200 条的历史仍然拿不到 —— 但那是**已知的容量
  上限**,与本票要修的**取错了一头**是两回事。
- **不改服务端**。两套语义是既有设计,`use-unread.ts` 依赖着 `?limit=1` 那一支。
- 不改 WS 合并、重连恢复。
- 不动 `use-messages-page.ts`(它已不再服务聊天流,其去留另议)。

## 6. 兼容性

无 schema 变更、无 API 变更。服务端 `limit` 参数是既有能力。对消息数 ≤200 的
群,返回集合与改动前**完全相同**(全部消息,正序),因此不存在行为回归面。

## 7. 备注:本票的产生方式

平台 server 未运行,下发通道不通,本票由检视者直接撰写并冻结。若实现也由
检视者完成,则**角色合并**这一事实必须写进提交说明——它意味着本票缺少
独立的 L2/L3 双层复核,只有单层。
