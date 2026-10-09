import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CoAgentHubClient } from "./coagenthub-client.js";
import { pluginDataDir, readBinding } from "./l3-state.js";

const contractSchema = z.object({
  intent: z.string().min(1), acceptance: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string()), nonGoals: z.array(z.string()), guardrails: z.array(z.string()),
}).strict();
const result = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: structuredClone(value),
});
const errorResult = (error: unknown) => ({
  ...result({ error: error instanceof Error ? error.message : String(error) }), isError: true,
});

type Run = {
  missionId: string; status: "requesting" | "accepted" | "running" | "ended" | "unknown" | "failed";
  exitCode?: number; lines: Array<{ channel: string; line: string }>; error?: string;
};

/** Only Host transport observation; never a second Mission state store. */
export async function consumeHostedRun(response: Response, run: Run): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Hosted response has no stream");
  const decoder = new TextDecoder();
  let pending = "";
  const apply = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (typeof event.exitCode === "number") {
      run.status = "ended"; run.exitCode = event.exitCode;
    } else if (typeof event.line === "string" && typeof event.channel === "string") {
      run.lines.push({ channel: event.channel, line: event.line.slice(-4000) });
      run.lines = run.lines.slice(-30);
      // Emitted by the existing runner only after creation/finding the Mission.
      if (event.channel === "stdout" && event.line.startsWith(`Mission ${run.missionId}；平台监听`)) {
        run.status = "running";
      }
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      if (pending.length > 256_000) throw new Error("Hosted NDJSON line exceeds limit");
      const lines = pending.split("\n"); pending = lines.pop() ?? "";
      for (const line of lines) apply(line);
    }
    pending += decoder.decode();
    if (pending.trim()) apply(pending);
    if (run.status !== "ended") run.status = "unknown";
  } finally { reader.releaseLock(); }
}

export function registerMissionLaunchTools(server: McpServer, client: CoAgentHubClient) {
  const runs = new Map<string, Run>();
  server.registerTool("coagenthub_get_platform_status", {
    description: "Read service lock identity, queue occupancy and configured adapter; does not read state files.", inputSchema: {},
  }, async () => {
    try { return result(await client.request<Record<string, unknown>>("/platform/status")); }
    catch (error) { return errorResult(error); }
  });
  server.registerTool("coagenthub_create_mission", {
    description: "Create a Standard Mission from a frozen Contract, without launching agents. Delivery recipient defaults to the real bound Codex session.",
    inputSchema: { projectId: z.string().min(1), missionId: z.string().min(1), contract: contractSchema, recipient: z.string().min(1).optional() },
  }, async ({ projectId, missionId, contract, recipient }) => {
    try {
      const target = recipient ?? readBinding(pluginDataDir())?.recipient;
      if (!target) throw new Error("No bound Delivery recipient; supply the actual recipient explicitly");
      return result(await client.request<Record<string, unknown>>("/missions", {
        method: "POST", body: JSON.stringify({ projectId, missionId, contract,
          origin: { clientType: "codex", conversationRef: target } }),
      }));
    } catch (error) { return errorResult(error); }
  });
  server.registerTool("coagenthub_start_mission", {
    description: "Start an existing Mission through the single-writer hosted runner. Read current Contract, use explicit cwd/adapter, never auto-retry an uncertain launch. Candidate arguments are compatibility validation only; current platform role configuration determines dispatch. Check no other runner first; local tracking is not a distributed lock.",
    inputSchema: { missionId: z.string().min(1), cwd: z.string().min(1), adapter: z.string().min(1),
      maxRounds: z.number().int().min(1).max(100).optional(),
      coordinator: z.string().min(1).optional(), executor: z.string().min(1).optional() },
  }, async ({ missionId, cwd, adapter, maxRounds, coordinator, executor }) => {
    const old = runs.get(missionId);
    if (old && old.status !== "ended" && old.status !== "failed") return result({ ...old, duplicatePrevented: true });
    const run: Run = { missionId, status: "requesting", lines: [] };
    runs.set(missionId, run);
    let submitted = false;
    try {
      const mission = await client.request<Record<string, any>>("/missions/" + encodeURIComponent(missionId));
      if (mission.paused || mission.parked || ["awaiting_review", "completed", "blocked", "failed", "cancelled"].includes(mission.status)) {
        throw new Error("Mission is paused, parked, awaiting review or terminal; use the dedicated lifecycle decision first");
      }
      const platform = await client.request<Record<string, any>>("/platform/status");
      if (platform.store !== "file" || platform.holdsMainLock !== true || typeof platform.statePath !== "string") {
        throw new Error("Hosted runner requires a confirmed file single-writer service");
      }
      const body = { spec: { projectId: mission.projectId, missionId, contract: mission.contract },
        cwd, adapter, state: platform.statePath, env: { COAGENT_AGENT_ENV_PASSTHROUGH: "-" },
        origin: mission.origin?.conversationRef, maxRounds, coordinator, executor };
      submitted = true;
      const response = await client.open("/control/run-mission", { method: "POST", body: JSON.stringify(body) });
      if (!response.headers.get("content-type")?.includes("ndjson")) throw new Error("Hosted endpoint did not return NDJSON; inspect Mission before retrying");
      run.status = "accepted";
      void consumeHostedRun(response, run).catch(error => {
        run.status = "unknown"; run.error = error instanceof Error ? error.message : String(error);
      });
      return result({ ...run, note: "HTTP acceptance is not agent completion; inspect hosted run, Mission and activity." });
    } catch (error) {
      run.status = submitted ? "unknown" : "failed";
      run.error = error instanceof Error ? error.message : String(error);
      return { ...result({ ...run }), isError: true };
    }
  });
  server.registerTool("coagenthub_get_hosted_run", {
    description: "Read this MCP instance's hosted stream observation. Unknown after restart; authoritative Mission/activity remain required.",
    inputSchema: { missionId: z.string().min(1) },
  }, async ({ missionId }) => result({ ...(runs.get(missionId) ?? { missionId, status: "unknown", note: "No local tracking; inspect authoritative Mission/activity before starting." }) }));
}
