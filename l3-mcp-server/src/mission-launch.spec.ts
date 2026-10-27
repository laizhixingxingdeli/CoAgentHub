import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CoAgentHubClient } from "./coagenthub-client.js";
import { registerMissionLaunchTools, consumeHostedRun } from "./mission-launch.js";
import {
 daemonPidPath,
 readActiveSessionId,
 readSessionBinding,
 recordPollSuccess,
 setActiveSession,
 writeSessionBinding,
} from "./l3-state.js";
function setup() {
 const request = vi.fn(); const open = vi.fn();
 const server = new McpServer({ name: "launch-test", version: "1" });
 registerMissionLaunchTools(server, { request, open } as unknown as CoAgentHubClient);
 return { request, open, tools: (server as any)._registeredTools };
}
const contract = { intent: "test", acceptance: ["pass"], constraints: [], nonGoals: [], guardrails: [] };
const V7 = "0192a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const V4 = "0192a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b";
const tempDirs: string[] = [];
function tempDataDir(): string {
 const dir = mkdtempSync(join(tmpdir(), "launch-recipient-"));
 tempDirs.push(dir);
 return dir;
}
function seedKeeper(dataDir: string) {
 writeSessionBinding(dataDir, { sessionId: "keeper", cwd: dataDir, inboxScope: "recipient", recipient: "keeper", updatedAt: "2026-10-27T00:00:00.000Z" });
 setActiveSession(dataDir, "keeper");
}
// 必须注入假 spawn：真 spawn 会拉起守护进程盯真实数据目录。
function launchWith(dataDir: string, spawn: ReturnType<typeof vi.fn>) {
 const request = vi.fn(); const open = vi.fn();
 const server = new McpServer({ name: "launch-test", version: "1" });
 registerMissionLaunchTools(server, { request, open } as unknown as CoAgentHubClient, { spawn, env: { PLUGIN_DATA: dataDir } });
 return { request, open, spawn, tools: (server as any)._registeredTools };
}
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
 it("registers a v7 recipient and ignores v4 or plain strings", async () => {
  const dataDir = tempDataDir(); seedKeeper(dataDir);
  const spawn = vi.fn(() => ({ unref: vi.fn() }));
  const { request, tools } = launchWith(dataDir, spawn);
  request.mockResolvedValue({ missionId: "m" });

  const v7 = await tools.coagenthub_create_mission.handler({ projectId: "p", missionId: "m", contract, recipient: V7 });
  const v7Body = JSON.parse(request.mock.calls[0][1].body);
  expect(v7Body.origin.conversationRef).toBe(V7);
  expect(v7Body).not.toHaveProperty("coordinationMode");
  expect(v7.structuredContent.deliveryRoute).toEqual({ recipient: V7, registered: true, bridgeAlive: false });
  expect(readSessionBinding(dataDir, V7).source).toBe("mission");
  // 活动默认仍是 keeper：建票不得抢走别人正在收的投递。
  expect(readActiveSessionId(dataDir)).toBe("keeper");
  expect(spawn).toHaveBeenCalledTimes(1);

  const v4 = await tools.coagenthub_create_mission.handler({ projectId: "p", missionId: "m", contract, recipient: V4 });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(readSessionBinding(dataDir, V4)).toBeUndefined();
  expect(v4.structuredContent).not.toHaveProperty("deliveryRoute");

  const plain = await tools.coagenthub_create_mission.handler({ projectId: "p", missionId: "m", contract, recipient: "session" });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(JSON.parse(request.mock.calls[2][1].body)).toEqual({ projectId: "p", missionId: "m", contract, origin: { clientType: "codex", conversationRef: "session" } });
  expect(plain.structuredContent).not.toHaveProperty("deliveryRoute");
 });
 it("rejects a missing recipient and registers a v7 origin on start", async () => {
  const dataDir = tempDataDir(); seedKeeper(dataDir);
  const spawn = vi.fn(() => ({ unref: vi.fn() }));
  const { request, open, tools } = launchWith(dataDir, spawn);
  request.mockResolvedValue({ missionId: "m" });

  const missing = await tools.coagenthub_create_mission.handler({ projectId: "p", missionId: "m", contract });
  expect(missing.isError).toBe(true);
  expect(JSON.parse(missing.content[0].text).error).toContain("本会话号");
  expect(request).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();

  const startDir = tempDataDir(); seedKeeper(startDir);
  const startSpawn = vi.fn(() => ({ unref: vi.fn() }));
  const started = launchWith(startDir, startSpawn);
  started.request
   .mockResolvedValueOnce({ missionId: "m", projectId: "p", contract, status: "executing", origin: { conversationRef: V7 } })
   .mockResolvedValueOnce({ store: "file", holdsMainLock: true, statePath: "state" });
  started.open.mockResolvedValue(new Response(new ReadableStream({ start(c) { c.close(); } }), { headers: { "content-type": "application/x-ndjson" } }));

  const res = await started.tools.coagenthub_start_mission.handler({ missionId: "m", cwd: "repo", adapter: "adapter" });
  expect(res.structuredContent.deliveryRoute.registered).toBe(true);
  expect(res.structuredContent.deliveryRoute.bridgeAlive).toBe(false);
  expect(readActiveSessionId(startDir)).toBe("keeper");
  expect(readSessionBinding(startDir, V7).source).toBe("mission");
  expect(startSpawn).toHaveBeenCalledTimes(1);
  expect(started.open).toHaveBeenCalledTimes(1);
 });
 it("reports read-only delivery bridge health with at most 20 recipients", async () => {
  const dataDir = tempDataDir();
  const spawn = vi.fn(() => ({ unref: vi.fn() }));
  const { request, tools } = launchWith(dataDir, spawn);

  // 用当前进程 pid 冒充守护进程：进程一定活着，且绝不起真守护进程。
  writeFileSync(daemonPidPath(dataDir), String(process.pid));
  recordPollSuccess(dataDir, 1, { at: "2026-10-27T01:00:00.000Z" });
  // 21 条绑定：第 21 条（最旧）必须被截掉，cwd 是绝不能漏出的哨兵值。
  for (let i = 0; i <= 20; i += 1) {
   const id = `s${String(i).padStart(2, "0")}`;
   writeSessionBinding(dataDir, {
    sessionId: id,
    cwd: "SECRET-CWD-SHOULD-NOT-LEAK",
    inboxScope: "recipient",
    recipient: id,
    updatedAt: `2026-10-27T00:${String(i).padStart(2, "0")}:00.000Z`,
   });
  }
  request.mockResolvedValue({ store: "file", holdsMainLock: true });

  const res = await tools.coagenthub_get_platform_status.handler({});
  expect(res.isError).toBeUndefined();
  expect(res.structuredContent.store).toBe("file");
  expect(res.structuredContent.deliveryBridge).toEqual({
   dataDir,
   daemonAlive: true,
   pid: process.pid,
   lastPollSucceededAt: "2026-10-27T01:00:00.000Z",
   consecutiveFailures: 0,
   lastDeliveryAt: "2026-10-27T01:00:00.000Z",
   recipients: Array.from({ length: 20 }, (_, i) => `s${String(20 - i).padStart(2, "0")}`),
  });
  expect(JSON.stringify(res.structuredContent)).not.toContain("SECRET-CWD-SHOULD-NOT-LEAK");
  // 状态查询不得拉起守护进程，也只读一次平台状态。
  expect(spawn).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe("/platform/status");
 });
 afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
 });
});
