# 独立 QueryRun（只读问答）

`QueryRunner.runQuery` 是与 `runMission` **并列**的 application 用例：只读问答，**不进入 Mission 状态机**。

## 可观察边界

- 不 `createMission`、不 `workspace.prepare`、不启 Coordinator/Executor Attempt、不发 Mission run token、不挂 `coagent_*` 写工具。
- 只读靠**工具 allowlist**强制（`QUERY_READONLY_TOOLS`：`read` / `grep` / `find` / `ls`），不靠 prompt。写/执行类与未知工具在 `runtime.start` **之前**以 `QUERY_TOOLS_NOT_READONLY` 拒绝。
- Runtime 必须显式 `supportsQuery === true`；未声明 fail-closed（`QUERY_RUNTIME_UNSUPPORTED`）。构造 `QueryRunner` 与每次 `runQuery` 都校验。
- 持久化独立 `QueryRunRecord`（`status: running|ended`，`outcome: answered|failed|needs_mutation`）。`needs_mutation` 只记账，本路径不建 Mission。
- `role: 'query'`；`missionId` 占位为空串以兼容 `AgentRunSpec` 形状，不代表真实 Mission。

## 与晋升的关系

- Query → Lightweight Mission 是**显式**另一条用例（`query-promotion.ts`），互不自动调用；caller 必须提供 Frozen WorkOrder，禁止从 prompt/output 自动生成工单。

## 权威源 / 测试

- 源：`src/application/query-run.ts`；晋升：`src/application/query-promotion.ts`；runtime opt-in：`src/runtime/pi-query.ts`
- 测试：`test/query-run.test.ts`、`test/query-promotion.test.ts`、`test/pi-query-runtime.test.ts`
- 取舍：ADR-0003（QueryRun 不是 Mission）

## 分类角色池（UI1，2026-10-04）

三种平台装配均从 classifier 池读取启用候选；每次查询重新读取，输入 profile 不覆盖管理配置。空池或全部熔断拒绝，不借协调者候选。仅确定的上游失败按顺序换候选；额度、身份、故障与探针沿用候选熔断仓储。QueryRun 保存实际 profileId/runtimeKind，健康视图聚合查询用量；旧记录缺这些字段仍可读取。直接构造未管理 QueryRunner 的测试/嵌入用例保留显式 profile 接口。
