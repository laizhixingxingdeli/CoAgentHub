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
 it("passes coordinationMode only when supplied, and verifies direct creation by authoritative read-back", async () => {
  const { request, open, tools } = setup();
  // 旧服务可能忽略 coordinationMode 仍返回 201：回读不是一次多余请求，是唯一的证据。
  request.mockImplementation(async (path: string, init?: { body?: string }) => {
    if (path === "/missions") return { missionId: JSON.parse(init!.body!).missionId, created: true };
    if (path === "/missions/d") return { missionId: "d", coordinationMode: "direct" };
    if (path === "/missions/old") return { missionId: "old", coordinationMode: "hierarchical" };
    if (path === "/missions/blank") return null;
    throw new Error("CoAgentHub v5 404: " + path);
  });
  const direct = await tools.coagenthub_create_mission.handler({ projectId: "p", missionId: "d", contract, recipient: "session", coordinationMode: "direct" });
  expect(direct.isError).toBeUndefined();
  expect(direct.structuredContent).toEqual({ missionId: "d", created: true, coordinationMode: "direct" });
  const paths = request.mock.calls.map(call => call[0]);
  // 一次 POST 一次 GET：direct 的承诺只能由回读兑现。
  expect(paths).toEqual(["/missions", "/missions/d"]);
  expect(request.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
  expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ projectId: "p", missionId: "d", contract, origin: { clientType: "codex", conversationRef: "session" }, coordinationMode: "direct" });
  expect(request.mock.calls[1][1]).toBeUndefined();

  for (const [missionId, expectDetail] of [["old", "hierarchical"], ["blank", "没有返回 Mission 视图"], ["gone", "404"]] as const) {
    request.mockClear();
    const res = await tools.coagenthub_create_mission.handler({ projectId: "p", missionId, contract, recipient: "session", coordinationMode: "direct" });
    expect(res.isError).toBe(true);
    const message = JSON.parse(res.content[0].text).error;
    // 任务可能真的建出来了：既不许假装回滚，也不许替 caller 重试或启动。
    expect(message).toContain(`Mission ${missionId} 可能已经创建`);
    expect(message).toContain("direct 协调模式未确认");
    expect(message).toContain(expectDetail);
    expect(message).toContain("不要盲目重试创建，也不要启动任何 agent");
    expect(request.mock.calls.map(call => call[0])).toEqual(["/missions", "/missions/" + missionId]);
    expect(request.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
    expect(open).not.toHaveBeenCalled();
  }

  request.mockClear();
  await tools.coagenthub_create_mission.handler({ projectId: "p", missionId: "h", contract, recipient: "session", coordinationMode: "hierarchical" });
  await tools.coagenthub_create_mission.handler({ projectId: "p", missionId: "plain", contract, recipient: "session" });
  const bodies = request.mock.calls.map(call => JSON.parse(call[1].body));
  expect(request.mock.calls.map(call => call[0])).toEqual(["/missions", "/missions"]);
  expect(bodies[0].coordinationMode).toBe("hierarchical");
  // 缺省不得凭空加字段：平台缺省即 hierarchical。
  expect(bodies[1]).not.toHaveProperty("coordinationMode");
  expect(bodies[1].origin).toEqual({ clientType: "codex", conversationRef: "session" });
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
