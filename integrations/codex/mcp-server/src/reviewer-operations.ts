import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CoAgentHubClient } from "./coagenthub-client.js";

/** Existing operations required for supervision and independent document approval. */
export function registerReviewerOperations(server: McpServer, client: CoAgentHubClient) {
  const call = async (path: string, body?: unknown) => {
    try {
      const value = await client.request<Record<string, unknown>>(path, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }], isError: true };
    }
  };
  server.registerTool("coagenthub_get_attempt", {
    description: "Read one authoritative Attempt detail and recorded output/evidence for supervision.",
    inputSchema: { missionId: z.string().min(1), attemptId: z.string().min(1) },
  }, async ({ missionId, attemptId }) => call(`/missions/${encodeURIComponent(missionId)}/attempts/${encodeURIComponent(attemptId)}`));
  server.registerTool("coagenthub_get_mission_live", {
    description: "Read Mission live output from a cursor without consuming Delivery or acknowledging it.",
    inputSchema: { missionId: z.string().min(1), cursor: z.number().int().min(0).optional() },
  }, async ({ missionId, cursor }) => call(`/missions/${encodeURIComponent(missionId)}/live?cursor=${cursor ?? 0}`));
  server.registerTool("coagenthub_get_pools", {
    description: "Read role candidate health and priority configuration through the platform; does not read credentials.", inputSchema: {},
  }, async () => call("/pools"));
  server.registerTool("coagenthub_get_pool_config", {
    description: "Read current complete role lists with optimistic revision for an explicitly authorized configuration change.", inputSchema: {},
  }, async () => call("/pools/config"));
  server.registerTool("coagenthub_configure_role_pool", {
    description: "Replace one role list after reviewing its full current configuration; retain unrelated candidates and use the actual revision. Does not affect in-flight selected identity.",
    inputSchema: { role: z.enum(["coordinator", "executor", "independent_reviewer", "classifier"]),
      revision: z.string().min(1), candidates: z.array(z.object({ profileId: z.string().min(1), endpoint: z.string().min(1),
        enabled: z.boolean().optional(),
        facts: z.array(z.object({ key: z.string(), value: z.string() }).strict()), }).strict()) },
  }, async ({ role, revision, candidates }) => call(`/pools/${role}/configure`, { expectedRevision: revision, candidates }));
  server.registerTool("coagenthub_get_document_proposals", {
    description: "Read complete document proposals and exact changes, revision and baseHash; does not approve or write documents.",
    inputSchema: { projectId: z.string().min(1) },
  }, async ({ projectId }) => call(`/projects/${encodeURIComponent(projectId)}/documents`));
  server.registerTool("coagenthub_decide_document", {
    description: "Approve, edit or withdraw an independently reviewed exact document delta using real reviewer/reason and reviewed revision/baseHash. Approval may flush only when the platform's idle gates permit.",
    inputSchema: { proposalId: z.string().min(1), action: z.enum(["approve", "edit", "withdraw"]),
      revision: z.number().int().min(1), baseHash: z.string().min(1), reviewer: z.string().min(1), reason: z.string().min(1),
      changes: z.array(z.object({ before: z.string(), after: z.string() }).strict()).optional() },
  }, async ({ proposalId, ...body }) => call(`/documents/${encodeURIComponent(proposalId)}/decide`, body));
}
