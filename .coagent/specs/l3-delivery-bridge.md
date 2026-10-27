# L3 宿主投递桥看护与状态

Codex 宿主侧的投递桥与平台收件箱分开：平台只负责 pending / acknowledge / stillOpen；拉起守护进程、登记收件人、排队与 ACK 都在 l3-mcp-server。

## 数据目录

pluginDataDir 的解析顺序是 PLUGIN_DATA、COAGENTHUB_PLUGIN_DATA、指针文件、原默认。SessionStart 在拿到 PLUGIN_DATA 时覆盖写入 `<CODEX_HOME 或 ~/.codex>/coagenthub-v5/plugin-data-dir.json`，文件只含目录路径。MCP 服务与钩子读同一目录，不另猜一套路径。

## 看护

钩子与 MCP 共用 ensureBridge。MCP 启动后检查一次，之后每 60 秒一次。数据目录里已有绑定且守护进程 pid 不在时才 detached、unref 拉起；定时器也 unref。COAGENTHUB_L3_BRIDGE=0 时不看护。Claude Code 的 agents/claude-code/tools/mcp.mjs 起 MCP 时，调用方没设该变量就传 "0"（显式值原样保留）：Claude 宿主不用 Codex 投递桥，而从会随会话结束的 shell 拉起的守护进程若默认看护就会被反复拉起。状态查询不得借机拉起或清掉死 pid。

## 建票即登记

create_mission 与 start_mission 拿到收件人后，仅当它是 UUID v7（第三段首位 7、第四段首位 8–b）且尚无绑定时，以 source `mission` 登记，不改活动默认，并看护一次。结果带 deliveryRoute：recipient、registered、bridgeAlive。create_mission 不回落到活动绑定；不传 recipient 直接报错。已登记但不是活动默认时，提示说明投给本会话的通知照常送达，默认收件人仍是活动绑定；夺默认仍只认 COAGENTHUB_BINDING_TAKEOVER=1。

## 投递一轮

某一收件人 codex queue 失败时记下错误并继续处理同轮其他收件人；本轮结束若有失败，仍以第一个错误抛出。排队失败不 ACK；ACK 失败只重试 ACK。stillOpen === false 时不排队、直接 ACK，这是「排队成功才 ACK」的唯一例外；缺该字段按 true。正文先要求只读确认是否仍待处理，已处理就结束本轮。

## 状态

coagenthub_get_platform_status 成功时附加只读 deliveryBridge：dataDir、daemonAlive、pid、lastPollSucceededAt、consecutiveFailures、lastDeliveryAt、按更新时间倒序最多 20 个收件人 id。只读插件本地文件，不读平台状态文件，不含 cwd、投递正文与凭据。平台请求失败仍是错误结果，不夹带本地状态冒充成功。
