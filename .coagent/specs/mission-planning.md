# Mission 协调者规划补充

协调者的 `coagent_update_findings` 为增量补充：有旧 findings 时旧内容原样保留为前缀，空行及「—— 第 n 次补充」分隔后追加本次 findings。仅显式传入 `rejectedHypotheses` 时追加并按字面去重；原 plan 的 `rootCause`、`decisions`、`direction`、`risks` 均保持。需要整段替换规划仍调用 `coagent_update_plan`；分类阶段简报不是 plan，不能替代协调者规划门禁。
