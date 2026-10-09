import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReviewerOperations } from "./reviewer-operations.js";
import { CoAgentHubClient } from "./coagenthub-client.js";
function setup() {
 const request = vi.fn().mockResolvedValue({ ok: true });
 const server = new McpServer({ name: "ops-test", version: "1" });
 registerReviewerOperations(server, { request } as unknown as CoAgentHubClient);
 return { request, tools: (server as any)._registeredTools };
}
describe("Reviewer existing HTTP operations", () => {
 it("reads attempt detail and live cursor without a write or ACK", async () => {
  const { request, tools } = setup();
  await tools.coagenthub_get_attempt.handler({ missionId: "m", attemptId: "W-1.exec-2" });
  await tools.coagenthub_get_mission_live.handler({ missionId: "m", cursor: 17 });
  expect(request.mock.calls).toEqual([["/missions/m/attempts/W-1.exec-2", undefined], ["/missions/m/live?cursor=17", undefined]]);
 });
 it("preserves optimistic pool revision and the supplied full role list", async () => {
  const { request, tools } = setup(); const candidates = [{ profileId: "p", endpoint: "local", facts: [], enabled: false }];
  await tools.coagenthub_configure_role_pool.handler({ role: "executor", revision: "hash", candidates });
  expect(request.mock.calls[0][0]).toBe("/pools/executor/configure");
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ expectedRevision: "hash", candidates });
 });
 it("reads exact document proposals and passes reviewed signature/version without replacement body", async () => {
  const { request, tools } = setup(); await tools.coagenthub_get_document_proposals.handler({ projectId: "p 1" });
  expect(request.mock.calls[0][0]).toBe("/projects/p%201/documents");
  await tools.coagenthub_decide_document.handler({ proposalId: "DOC:m:1", action: "approve", revision: 2, baseHash: "hash", reviewer: "real-reviewer", reason: "reviewed delta" });
  expect(request.mock.calls[1][0]).toBe("/documents/DOC%3Am%3A1/decide");
  expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ action: "approve", revision: 2, baseHash: "hash", reviewer: "real-reviewer", reason: "reviewed delta" });
 });
});
