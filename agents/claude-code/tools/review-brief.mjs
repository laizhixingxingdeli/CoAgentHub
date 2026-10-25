// 终审简报：结论、逐条验收、平台附件、最终 VR 编号、文档提议、各 Attempt 实际模型，一条命令出齐。只读，经 MCP。
// 用法：node review-brief.mjs <missionId>
import { withServer, callTool } from "./mcp.mjs";
const missionId = process.argv[2];
if (!missionId) { console.log("用法：node review-brief.mjs <missionId>"); process.exit(1); }
const cut = (s, n) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
await withServer(async (client) => {
  const m = (await callTool(client, "coagenthub_get_mission", { missionId })).value;
  const r = m.result ?? {};
  console.log(`== ${missionId} [${m.status}] outcome=${r.outcome} cost=$${(m.usage?.cost ?? 0).toFixed(2)} contractRev=${m.contractRevision}`);
  console.log("摘要:", cut(r.summary, 900));
  for (const c of r.criteria ?? []) console.log(` 验收${c.index} ${c.status}: ${cut(c.evidence, 420)}`);
  const a = r.attachments ?? {};
  console.log("全量:", JSON.stringify(a.lastFullTest), "| diff:", JSON.stringify(a.diffStats), "| criterionWorkItems:", JSON.stringify(a.criterionWorkItems));
  console.log("openRisks:", cut(JSON.stringify(r.openRisks), 500));
  console.log("memoryDelta:", (r.memoryDelta ?? []).map((d) => `${d.kind}:${d.slug}(${(d.changes ?? []).length}处)`).join(", ") || "无");
  for (const w of m.workItems ?? []) console.log(` 工作项 ${w.id} ${w.status} 尝试${(w.attemptIds ?? []).length}次 VR=${cut(JSON.stringify(w.validationReport), 160)}`);
  const ids = [...(m.coordinatorAttemptIds ?? [])];
  for (const w of m.workItems ?? []) ids.push(...(w.attemptIds ?? []));
  for (const attemptId of ids) {
    const x = (await callTool(client, "coagenthub_get_attempt", { missionId, attemptId })).value ?? {};
    const f = Object.fromEntries((x.profile?.facts ?? []).map((k) => [k.key, k.value]));
    console.log(`  ${attemptId.padEnd(14)} ${(x.kind ?? "").padEnd(11)} ${f.provider}/${f.model} 思考=${f.reasoning} ${x.status}/${x.endedBy} ${x.usage?.total ? Math.round(x.usage.total / 1000) + "k tok $" + (x.usage.cost ?? 0).toFixed(2) : ""}`);
  }
});
