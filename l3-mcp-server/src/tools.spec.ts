import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import type { CoAgentHubClient } from "./coagenthub-client.js";

function makeClient() {
  const request = vi.fn();
  return { client: { request } as unknown as CoAgentHubClient, request };
}

function toolsOf(server: McpServer) {
  return (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: any) => Promise<any> }
      >;
    }
  )._registeredTools;
}

function setup() {
  const server = new McpServer({ name: "test", version: "0.2.0" });
  const { client, request } = makeClient();
  registerTools(server, client);
  return { server, request, tools: toolsOf(server) };
}

afterEach(() => {
  delete process.env.COAGENTHUB_REVIEWER_ID;
  delete process.env.COAGENTHUB_REVIEW_CONFIRMED_BY;
});

describe("CoAgentHub v5 tool registration", () => {
  it("registers Mission/L3 tools and removes legacy group/task tools", () => {
    const { tools } = setup();
    expect(tools.coagenthub_list_projects).toBeDefined();
    expect(tools.coagenthub_list_missions).toBeDefined();
    expect(tools.coagenthub_get_mission).toBeDefined();
    expect(tools.coagenthub_get_mission_diff).toBeDefined();
    expect(tools.coagenthub_get_mission_activity).toBeDefined();
    expect(tools.coagenthub_get_validation_report).toBeDefined();
    expect(tools.coagenthub_get_inbox).toBeDefined();
    expect(tools.coagenthub_answer_escalation).toBeDefined();
    expect(tools.coagenthub_approve_checkpoint).toBeDefined();
    expect(tools.coagenthub_pause_mission).toBeDefined();
    expect(tools.coagenthub_resume_mission).toBeDefined();
    expect(tools.coagenthub_cancel_mission).toBeDefined();
    expect(tools.coagenthub_park_mission).toBeDefined();
    expect(tools.coagenthub_resume_parked_mission).toBeDefined();
    expect(tools.coagenthub_revise_contract).toBeDefined();
    expect(tools.coagenthub_retire_work_item).toBeDefined();
    expect(tools.coagenthub_rerun_mission).toBeDefined();
    expect(tools.coagenthub_raise_mission_budget).toBeDefined();
    expect(tools.coagenthub_finalize_mission).toBeDefined();
    expect(tools.coagenthub_list_plan_runs).toBeDefined();
    expect(tools.coagenthub_dashboard).toBeDefined();
    expect(tools.coagenthub_list_groups).toBeUndefined();
    expect(tools.coagenthub_dispatch_task).toBeUndefined();
  });
});

describe("CoAgentHub v5 read tools", () => {
  it("lists and filters Missions client-side", async () => {
    const { request, tools } = setup();
    request.mockResolvedValueOnce([
      { missionId: "m1", projectId: "p1", status: "awaiting_review" },
      { missionId: "m2", projectId: "p2", status: "running" },
    ]);
    const res = await tools.coagenthub_list_missions.handler({
      projectId: "p1",
    });
    expect(request).toHaveBeenCalledWith("/missions");
    expect(JSON.parse(res.content[0].text)).toEqual({
      items: [{ missionId: "m1", projectId: "p1", status: "awaiting_review" }],
      total: 1,
    });
  });

  it("gets Mission diff from the v5 route", async () => {
    const { request, tools } = setup();
    request.mockResolvedValueOnce({ diff: "x" });
    await tools.coagenthub_get_mission_diff.handler({ missionId: "M 1" });
    expect(request).toHaveBeenCalledWith("/missions/M%201/diff", undefined);
  });

  it("filters inbox by recipient only when requested", async () => {
    const { request, tools } = setup();
    request.mockResolvedValueOnce({ pending: [] });
    await tools.coagenthub_get_inbox.handler({ recipient: "plan-run:R 1" });
    expect(request).toHaveBeenCalledWith(
      "/inbox?recipient=plan-run%3AR%201",
      undefined,
    );
  });

  it("gets a full validation report by Mission and report id", async () => {
    const { request, tools } = setup();
    request.mockResolvedValueOnce({ id: "VR 1", checks: [] });
    await tools.coagenthub_get_validation_report.handler({
      missionId: "M 1",
      reportId: "VR 1",
    });
    expect(request).toHaveBeenCalledWith(
      "/missions/M%201/validation-reports/VR%201",
      undefined,
    );
  });
});
describe("L3 actions", () => {
  it("answers a normal Mission escalation through v5 HTTP", async () => {
    const { request, tools } = setup();
    request
      .mockResolvedValueOnce({ missionId: "m1", origin: { clientType: "cli" } })
      .mockResolvedValueOnce({ ok: true });
    const res = await tools.coagenthub_answer_escalation.handler({
      missionId: "m1",
      answer: "Proceed with option A",
    });
    expect(res.isError).not.toBe(true);
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/missions/m1/escalations/answer",
      {
        method: "POST",
        body: JSON.stringify({ answer: "Proceed with option A" }),
      },
    );
  });

  it("refuses to send a PlanRun escalation through the ordinary answer route", async () => {
    const { request, tools } = setup();
    request.mockResolvedValueOnce({
      missionId: "m1",
      origin: { clientType: "plan-run", conversationRef: "plan-run:R1" },
    });
    const res = await tools.coagenthub_answer_escalation.handler({
      missionId: "m1",
      answer: "yes",
    });
    expect(res.isError).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(res.content[0].text).toContain("PlanRun");
  });
  it("approves only a verified Standard Mission work-item checkpoint", async () => {
    const { request, tools } = setup();
    request
      .mockResolvedValueOnce({
        missionId: "m1",
        origin: { clientType: "cli" },
        openEscalations: [
          {
            id: "E-1",
            platformGate: { kind: "work_item_checkpoint", threshold: 15 },
          },
        ],
      })
      .mockResolvedValueOnce({ released: true });
    const res = await tools.coagenthub_approve_checkpoint.handler({
      missionId: "m1",
    });
    expect(res.isError).not.toBe(true);
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/missions/m1/escalations/answer",
      {
        method: "POST",
        body: JSON.stringify({ answer: "continue" }),
      },
    );
  });

  it("refuses checkpoint approval when the earliest escalation is not a checkpoint", async () => {
    const { request, tools } = setup();
    request.mockResolvedValueOnce({
      missionId: "m1",
      origin: { clientType: "cli" },
      openEscalations: [{ id: "E-1", question: "Need a product decision" }],
    });
    const res = await tools.coagenthub_approve_checkpoint.handler({
      missionId: "m1",
    });
    expect(res.isError).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("maps Mission lifecycle controls to the v5 HTTP routes", async () => {
    const { request, tools } = setup();
    request.mockResolvedValue({ ok: true });

    await tools.coagenthub_pause_mission.handler({ missionId: "M 1" });
    await tools.coagenthub_resume_mission.handler({ missionId: "M 1" });
    await tools.coagenthub_cancel_mission.handler({
      missionId: "M 1",
      reason: "stop",
    });
    await tools.coagenthub_park_mission.handler({
      missionId: "M 1",
      reason: "needs review",
      reviewer: "Codex L3",
    });
    await tools.coagenthub_resume_parked_mission.handler({
      missionId: "M 1",
      reason: "resolved",
      reviewer: "Codex L3",
      answer: "use A",
    });

    expect(request).toHaveBeenNthCalledWith(1, "/missions/M%201/pause", {
      method: "POST",
      body: "{}",
    });
    expect(request).toHaveBeenNthCalledWith(2, "/missions/M%201/resume", {
      method: "POST",
      body: "{}",
    });
    expect(request).toHaveBeenNthCalledWith(3, "/missions/M%201/cancel", {
      method: "POST",
      body: JSON.stringify({ reason: "stop" }),
    });
    expect(request).toHaveBeenNthCalledWith(4, "/missions/M%201/park", {
      method: "POST",
      body: JSON.stringify({ reason: "needs review", reviewer: "Codex L3" }),
    });
    expect(request).toHaveBeenNthCalledWith(
      5,
      "/missions/M%201/parked-resume",
      {
        method: "POST",
        body: JSON.stringify({
          reason: "resolved",
          reviewer: "Codex L3",
          answer: "use A",
        }),
      },
    );
  });

  it("maps contract, WorkItem, rerun and budget controls to v5 HTTP", async () => {
    const { request, tools } = setup();
    request.mockResolvedValue({ ok: true });

    await tools.coagenthub_revise_contract.handler({
      missionId: "M 1",
      contract: { intent: "new", acceptance: ["AC1"] },
    });
    await tools.coagenthub_retire_work_item.handler({
      missionId: "M 1",
      workItemId: "W 1",
      reason: "superseded",
    });
    await tools.coagenthub_rerun_mission.handler({
      missionId: "M 1",
      newMissionId: "M 2",
      baseRevision: "abc123",
    });
    await tools.coagenthub_raise_mission_budget.handler({
      missionId: "M 1",
      by: 12,
    });

    expect(request).toHaveBeenNthCalledWith(1, "/missions/M%201/contract", {
      method: "POST",
      body: JSON.stringify({ intent: "new", acceptance: ["AC1"] }),
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/missions/M%201/work-items/W%201/retire",
      {
        method: "POST",
        body: JSON.stringify({ reason: "superseded" }),
      },
    );
    expect(request).toHaveBeenNthCalledWith(3, "/missions/M%201/rerun", {
      method: "POST",
      body: JSON.stringify({
        newMissionId: "M 2",
        baseRevision: "abc123",
      }),
    });
    expect(request).toHaveBeenNthCalledWith(
      4,
      "/missions/M%201/budget/raise",
      {
        method: "POST",
        body: JSON.stringify({ by: 12 }),
      },
    );
  });

  it("requires explicit reviewer authority before finalizing", async () => {
    const { request, tools } = setup();
    const res = await tools.coagenthub_finalize_mission.handler({
      missionId: "m1",
      verdict: "merge",
      reasons: [],
    });
    expect(res.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("posts reviewer finalization with configured authority", async () => {
    process.env.COAGENTHUB_REVIEWER_ID = "Codex L3";
    process.env.COAGENTHUB_REVIEW_CONFIRMED_BY = "standing authorization";
    const { request, tools } = setup();
    request.mockResolvedValueOnce({ missionId: "m1", status: "completed" });
    const res = await tools.coagenthub_finalize_mission.handler({
      missionId: "m1",
      verdict: "merge",
      reasons: ["All acceptance criteria verified."],
    });
    expect(res.isError).not.toBe(true);
    expect(request).toHaveBeenCalledWith(
      "/missions/m1/finalize/reviewer",
      {
        method: "POST",
        body: JSON.stringify({
          verdict: "merge",
          reasons: ["All acceptance criteria verified."],
          reviewerId: "Codex L3",
          confirmedBy: "standing authorization",
        }),
      },
    );
  });
});
describe("error handling", () => {
  it("returns structured MCP errors", async () => {
    const { request, tools } = setup();
    request.mockRejectedValueOnce(new Error("CoAgentHub v5 500: boom"));
    const res = await tools.coagenthub_list_projects.handler({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("CoAgentHub v5 500");
  });
});
