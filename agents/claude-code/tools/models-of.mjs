// 列出若干 Mission 里每个 Attempt 实际用的模型（provider/model/reasoning）与状态、用量。只读，经 MCP。
// 用法：node models-of.mjs <missionId> [更多 missionId…]
import { withServer, callTool } from "./mcp.mjs";
const ids = process.argv.slice(2);
if (ids.length === 0) { console.log("用法：node models-of.mjs <missionId> [更多…]"); process.exit(1); }
await withServer(async (client) => {
  for (const missionId of ids) {
    const m = (await callTool(client, "coagenthub_get_mission", { missionId })).value;
    const attIds = [...(m.coordinatorAttemptIds ?? [])];
    for (const w of m.workItems ?? []) for (const a of w.attemptIds ?? w.attempts?.map((x) => x.id ?? x.attemptId) ?? []) attIds.push(a);
    console.log(`== ${missionId} [${m.status}] cost=$${(m.usage?.cost ?? 0).toFixed(2)} attempts=${attIds.length}`);
    for (const attemptId of attIds) {
      const r = await callTool(client, "coagenthub_get_attempt", { missionId, attemptId });
      const a = r.value ?? {};
      const f = Object.fromEntries((a.profile?.facts ?? []).map((x) => [x.key, x.value]));
      const t = a.usage?.total ? `${Math.round(a.usage.total / 1000)}k tok $${(a.usage.cost ?? 0).toFixed(2)}` : "-";
      console.log(`  ${attemptId.padEnd(14)} ${(a.kind ?? "").padEnd(11)} ${(a.profile?.profileId ?? "?").padEnd(26)} ${f.provider ?? "?"}/${f.model ?? "?"} 思考=${f.reasoning ?? "?"}  ${a.status ?? ""}/${a.endedBy ?? ""}  ${t}`);
    }
  }
});
