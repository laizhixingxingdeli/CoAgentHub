// 验证报告摘要：对着 mcp.mjs --out 落盘的 get_validation_report 结果，打印每条命令的 argv、退出码、耗时与结果行。
// 用法：先 node mcp.mjs coagenthub_get_validation_report '{"reportId":"VR-x"}' --out vr.json，再 node vr-summary.mjs vr.json
import { readFileSync } from "node:fs";
const v = JSON.parse(readFileSync(process.argv[2], "utf8")).value;
const BS = String.fromCharCode(92);
for (const c of v.checks) {
  if (c.kind !== "command") continue;
  const k = c.command;
  console.log("--- argv", JSON.stringify(k.argv), "exit", k.exitCode, "timedOut", k.timedOut, "durationMs", k.durationMs);
  console.log("    cwd tail", String(k.cwd).split(BS).slice(-2).join("/"));
  const t = String(k.outputTail || "");
  const lines = t.split("\n");
  console.log("    outputTail chars", t.length, "lines", lines.length);
  console.log("    summary:", JSON.stringify(lines.filter((l) => /^(ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo|duration)/.test(l.trim())).slice(-9)));
  const skipped = lines.filter((l) => /skip/i.test(l));
  console.log("    lines mentioning skip:", skipped.length, JSON.stringify(skipped.slice(0, 10).map((s) => s.slice(0, 140))));
}
