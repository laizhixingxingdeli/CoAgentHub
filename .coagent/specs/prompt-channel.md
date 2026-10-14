# 角色提示的通道交付

## 作用范围

pi 适配层按候选把角色规则与开跑简报放进系统提示或一条用户消息。看不见客户端系统提示的上游（10Router 的 qdc 与 cbai 已实测；qd 与 qdc 走同一个执行器，按代码同样处理，被限流未能实测）否则会丢掉角色规则与简报。不改 10Router、资源池顺序或候选 facts；上线后由检视者按金丝雀写 `prompt_channel`。

## 判定

`resolvePromptChannel` 是纯函数。候选 facts 里 `prompt_channel` 为字面量 `user` 或 `system` 时以它为准；大小写不对或其他词当没写。没写时，provider 为 `tenrouter` 且模型 id 以 `qdc/`、`qd/`、`cbai/` 开头的判为 `user`，其余一律 `system`。`runtime` 把判定结果传给 `createCoagentExtension` 的可选项 `promptChannel`，缺省 `system`。

## 交付

经 `createCoagentExtension` 注入系统提示的角色：`system` 通道的 `before_agent_start` 返回值与改前字节级一致（只有 `systemPrompt`，内容为角色提示加简报）。`user` 通道第一次还带 `message`（`customType` 为 `coagent-brief`、`display` 为 false），内容是同一份全文，开头一句「以最后一份简报为准」；同时返回的 `systemPrompt` 只说角色名，并说明规则与简报在紧随其后的用户消息里、以它为准。之后的 `before_agent_start`（含执行者没交结果时的提醒）只返回这句短 `systemPrompt`，不再追加。`onBriefInjected` 计量不变。

压缩会话后不重发简报；用户消息可能被摘要掉。加候选前先确认它看得见系统提示；看不见就在 facts 里写 `prompt_channel=user`。