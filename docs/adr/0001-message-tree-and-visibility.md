# ADR-0001:闭包表消息树与服务器端可见性

**状态**:已接受(2026-08)

## 背景
群消息需要支持线程(回复树)、按受众路由、增量拉取,且可见性必须在服务端强制。

## 决策
- 消息树用**闭包表**(`group_message_closure`):每条消息自指行(depth 0),
  子消息对每个祖先一行(depth+1);读取时 `depth = max(depth)`。
- 可见性规则集中在 `lib/group-visibility.ts` 一个纯函数(JS)+ 一个 SQL 谓词,
  两者用一致性测试钉死;`GET /messages` 在 SQL 层过滤并分页(LIMIT 200 + `?after=` 游标)。
- 消息 id 用 uuidv7:时间有序,游标与顺序同键不漂移。

## 后果
- 长线程读放大(每消息一个 max(depth) 子查询)——可接受,当前规模;若恶化改物化 depth。
- 可见性单一来源,GET/webhook/WS 永不漂移。
