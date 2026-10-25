// 协调者每跳工具画像：跳型（交卷/规划派发/评审/核对契约）、总调用、读代码调用（read/grep/find/ls，bash 不算）、平台调用，附模型与用量。只读，经 MCP。
// 注意：toolActivity 只保留尾部约 200 条，超长跳的计数会被截断——看趋势够用，当精确账目不行。
// 用法：node hop-reads.mjs <missionId> [更多 missionId…]
import { withServer, callTool } from "./mcp.mjs";
const ids = process.argv.slice(2);
if (ids.length === 0) { console.log("用法：node hop-reads.mjs <missionId> [更多…]"); process.exit(1); }
const READ = new Set(["read", "grep", "find", "ls"]);
await withServer(async (client) => {
  for (const missionId of ids) {
    const m = (await callTool(client, "coagenthub_get_mission", { missionId })).value;
    for (const attemptId of m.coordinatorAttemptIds ?? []) {
      const a = (await callTool(client, "coagenthub_get_attempt", { missionId, attemptId })).value ?? {};
      const tools = (a.toolActivity ?? []).map((t) => t.name);
      const has = (n) => tools.includes(n);
      const type = has("coagent_submit_mission_result") ? "交卷" : has("coagent_create_work_item") ? "规划派发" : has("coagent_review_execution_result") ? "评审" : has("coagent_submit_contract_check") ? "核对契约" : "其他";
      const reads = tools.filter((n) => READ.has(n)).length;
      const platform = tools.filter((n) => String(n).startsWith("coagent_")).length;
      const f = Object.fromEntries((a.profile?.facts ?? []).map((k) => [k.key, k.value]));
      const usage = a.usage?.total ? `${Math.round(a.usage.total / 1000)}k tok $${(a.usage.cost ?? 0).toFixed(2)}` : "-";
      console.log(`${missionId} ${attemptId} [${type}] ${f.provider ?? "?"}/${f.model ?? "?"} 调用${tools.length} 读代码${reads} 平台${platform} ${a.status ?? ""}/${a.endedBy ?? ""} ${usage}`);
    }
  }
});
