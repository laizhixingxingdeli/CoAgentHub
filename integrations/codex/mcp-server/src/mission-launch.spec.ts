import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CoAgentHubClient } from "./coagenthub-client.js";
import { registerMissionLaunchTools, consumeHostedRun } from "./mission-launch.js";
function setup() {
 const request = vi.fn(); const open = vi.fn();
 const server = new McpServer({ name: "launch-test", version: "1" });
 registerMissionLaunchTools(server, { request, open } as unknown as CoAgentHubClient);
 return { request, open, tools: (server as any)._registeredTools };
}
const contract = { intent: "test", acceptance: ["pass"], constraints: [], nonGoals: [], guardrails: [] };
describe("Mission launch adapter", () => {
 it("creates without spawning and preserves the explicit real recipient", async () => {
  const { request, open, tools } = setup(); request.mockResolvedValue({ missionId: "m" });
  await tools.coagenthub_create_mission.handler({ projectId: "p", missionId: "m", contract, recipient: "session" });
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ projectId: "p", missionId: "m", contract, origin: { clientType: "codex", conversationRef: "session" } });
  expect(open).not.toHaveBeenCalled();
 });
 it("uses current Contract and single-writer path, streams completion, and prevents concurrent duplicate start", async () => {
  const { request, open, tools } = setup();
  request.mockResolvedValueOnce({ missionId: "m", projectId: "p", contract, status: "executing", origin: { conversationRef: "session" } })
   .mockResolvedValueOnce({ store: "file", holdsMainLock: true, statePath: "state" });
  let controller!: ReadableStreamDefaultController;
  open.mockResolvedValue(new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { "content-type": "application/x-ndjson" } }));
  const args = { missionId: "m", cwd: "repo", adapter: "adapter", maxRounds: 20 };
  const first = await tools.coagenthub_start_mission.handler(args);
  expect(first.structuredContent.status).toBe("accepted");
  const body = JSON.parse(open.mock.calls[0][1].body);
  expect(body.spec.contract).toEqual(contract); expect(body.state).toBe("state");
  expect(body.env).toEqual({ COAGENT_AGENT_ENV_PASSTHROUGH: "-" });
  const second = await tools.coagenthub_start_mission.handler(args);
  expect(second.structuredContent.duplicatePrevented).toBe(true); expect(open).toHaveBeenCalledTimes(1);
  controller.enqueue(new TextEncoder().encode('{"channel":"stdout","line":"Mission m；平台监听 local"}\n{"exitCode":0}\n')); controller.close();
  await vi.waitFor(async () => expect((await tools.coagenthub_get_hosted_run.handler({ missionId: "m" })).structuredContent.exitCode).toBe(0));
 });
 it("refuses paused/terminal missions before POST", async () => {
  const { request, open, tools } = setup(); request.mockResolvedValue({ paused: true, status: "executing" });
  const res = await tools.coagenthub_start_mission.handler({ missionId: "m", cwd: "repo", adapter: "adapter" });
  expect(res.isError).toBe(true); expect(open).not.toHaveBeenCalled();
 });
 it("does not retry an uncertain network launch", async () => {
  const { request, open, tools } = setup();
  request.mockResolvedValueOnce({ missionId: "m", projectId: "p", contract, status: "planning" }).mockResolvedValueOnce({ store: "file", holdsMainLock: true, statePath: "state" });
  open.mockRejectedValue(new Error("connection lost")); const args = { missionId: "m", cwd: "repo", adapter: "adapter" };
  expect((await tools.coagenthub_start_mission.handler(args)).structuredContent.status).toBe("unknown");
  expect((await tools.coagenthub_start_mission.handler(args)).structuredContent.duplicatePrevented).toBe(true);
  expect(open).toHaveBeenCalledTimes(1);
 });
 it("parses split UTF8 NDJSON and marks missing terminal frame unknown", async () => {
  const bytes = new TextEncoder().encode('{"channel":"stdout","line":"Mission m；平台监听 local"}\n');
  const run: any = { missionId: "m", status: "accepted", lines: [] };
  await consumeHostedRun(new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0,44)); c.enqueue(bytes.slice(44)); c.close(); } })), run);
  expect(run.lines[0].line).toContain("平台监听"); expect(run.status).toBe("unknown");
 });
});
