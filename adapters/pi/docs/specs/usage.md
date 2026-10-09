# 用量查询与上游可用性聚合

`src/usage.ts` 的 queryUsage 并发查询 xAI 与本机10Router，各自默认5秒deadline；输出xAI行在前、10Router行在后，xAI既有行形状不变，失败互不影响。

10Router GET `<root>/api/usage/quotas`，默认root为 `http://127.0.0.1:20128`，环境变量 `COAGENT_TENROUTER_URL` 可覆盖。不读pi模型或凭据配置、不带密钥。401/403输出no_auth，不可达输出error，超时输出timeout；请求失败按三项白名单输出安全状态行，不输出错误正文、账号id/name/email或原始响应。

仅聚合connections.provider匹配且isActive严格为true的账号。白名单：codebuddy-cn→modelPrefix cbcn，antigravity→ag，qoder-cn→qdc；其余上游不出行。成功响应中没有active账号的上游不出行。每行包含provider=tenrouter、upstream、modelPrefix、status、fetchedAt，可选remainingPercent、usedPercent、resetAt。

聚合是可用性指标，不是跨模型或单位的账务加权：跳过detailOnly桶，按层级选择可服务额度：优先aggregate或summarizesDetail汇总桶；没有汇总桶时，选择非giftPack且resetAt为null或缺省的账号级总池桶；两者都没有时，选择非detailOnly窗口/备用桶。存在汇总或总池时，低层小包与礼包不单独参与百分比，不求和，不被小包拉低或抬高。百分比优先remainingPercentage/有效正percentScale归一到0..100，默认scale=100；否则remaining/total或(total-used)/total，要求有效非负数据且total>0。选中桶任一有余额或unlimited即账号可用；窗口型取剩余最多窗口的百分比。任一active账号可用即上游可用，上游取最佳已知可用账号百分比，usedPercent=100-remainingPercent。unlimited无可解释百分比时省略百分比，不伪造100%。无确定正额度且有未知则百分比省略；空桶或limitReached单独不足以证明耗尽。仅全部active账号的全部选中可服务额度明确耗尽才输出0/100。

resetAt仅在上游全部active账号明确耗尽时提供，且必须是有效的将来额度恢复时刻。汇总/总池型从非detailOnly桶中选择recurring为true的刷新桶（如Monthly月度礼包）；窗口型使用选中窗口的resetAt，但排除显式recurring为false的桶。非recurring Bonus Pack的resetAt是过期时间，不作为恢复证明。账号内取恢复候选最早时刻，上游再取账号候选最早时刻，因为任一可服务额度或账号恢复即可用；拿不到恢复时刻则省略resetAt。可用或未知行不提供resetAt，额度未知保持未知，不猜。
