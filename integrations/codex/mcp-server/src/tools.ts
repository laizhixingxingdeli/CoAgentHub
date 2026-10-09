import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CoAgentHubClient } from "./coagenthub-client.js";

import { registerReviewerOperations } from "./reviewer-operations.js";
import { registerMissionLaunchTools } from "./mission-launch.js";

const dashboardUri = "ui://coagenthub-v5/l3-dashboard.html";

const toStructuredContent = (value: unknown): Record<string, unknown> => {
  if (Array.isArray(value)) return { items: value, total: value.length };
  if (value !== null && typeof value === "object") {
    return { ...(value as Record<string, unknown>) };
  }
  return { value };
};

const text = (value: unknown) => {
  const structuredContent = toStructuredContent(value);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
};
const failure = (error: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    },
  ],
  isError: true,
});

type MissionRecord = Record<string, unknown> & {
  missionId?: string;
  projectId?: string;
  status?: string;
  intent?: string;
  origin?: { clientType?: string; conversationRef?: string };
  openEscalations?: Array<{
    id?: string;
    question?: string;
    answer?: string;
    platformGate?: { kind?: string; threshold?: number };
  }>;
};

export function registerTools(
  server: McpServer,
  client = new CoAgentHubClient(),
) {
  registerDashboard(server, client);
  registerMissionLaunchTools(server, client);
  registerReviewerOperations(server, client);

  server.registerTool(
    "coagenthub_list_projects",
    {
      description: "List CoAgentHub v5 projects.",
      inputSchema: {},
    },
    async () => requestText(client, "/projects"),
  );

  server.registerTool(
    "coagenthub_list_missions",
    {
      description:
        "List CoAgentHub v5 Missions. Optionally filter the returned snapshot by projectId or status.",
      inputSchema: {
        projectId: z.string().optional(),
        status: z.string().optional(),
      },
    },
    async ({ projectId, status }) => {
      try {
        const rows = await client.request<MissionRecord[]>("/missions");
        const filtered = rows.filter(
          (row) =>
            (!projectId || row.projectId === projectId) &&
            (!status || row.status === status),
        );
        return text(filtered);
      } catch (error) {
        return failure(error);
      }
    },
  );
  server.registerTool(
    "coagenthub_get_mission",
    {
      description:
        "Get the authoritative CoAgentHub v5 Mission view, including contract, work items, result, escalations, workspace and final review.",
      inputSchema: { missionId: z.string().min(1) },
    },
    async ({ missionId }) =>
      requestText(client, "/missions/" + encodeURIComponent(missionId)),
  );

  server.registerTool(
    "coagenthub_get_mission_diff",
    {
      description: "Get the authoritative diff for a CoAgentHub v5 Mission.",
      inputSchema: { missionId: z.string().min(1) },
    },
    async ({ missionId }) =>
      requestText(
        client,
        "/missions/" + encodeURIComponent(missionId) + "/diff",
      ),
  );

  server.registerTool(
    "coagenthub_get_mission_activity",
    {
      description: "Get the activity timeline for a CoAgentHub v5 Mission.",
      inputSchema: { missionId: z.string().min(1) },
    },
    async ({ missionId }) =>
      requestText(
        client,
        "/missions/" + encodeURIComponent(missionId) + "/activity",
      ),
  );

  server.registerTool(
    "coagenthub_get_validation_report",
    {
      description:
        "Get one full append-only ValidationReport for a Mission. Use report ids found in the Mission activity timeline.",
      inputSchema: {
        missionId: z.string().min(1),
        reportId: z.string().min(1),
      },
    },
    async ({ missionId, reportId }) =>
      requestText(
        client,
        "/missions/" +
          encodeURIComponent(missionId) +
          "/validation-reports/" +
          encodeURIComponent(reportId),
      ),
  );

  server.registerTool(
    "coagenthub_get_inbox",
    {
      description:
        "Read pending durable CoAgentHub v5 Deliveries. recipient is optional; omit it for the L3-wide inbox.",
      inputSchema: { recipient: z.string().min(1).optional() },
    },
    async ({ recipient }) => {
      const query = recipient
        ? "?recipient=" + encodeURIComponent(recipient)
        : "";
      return requestText(client, "/inbox" + query);
    },
  );

  server.registerTool(
    "coagenthub_ack_delivery",
    {
      description:
        "Acknowledge one CoAgentHub v5 Delivery. The automatic L3 bridge normally does this after codex queue succeeds.",
      inputSchema: { deliveryId: z.string().min(1) },
    },
    async ({ deliveryId }) =>
      requestText(
        client,
        "/deliveries/" + encodeURIComponent(deliveryId) + "/ack",
        { method: "POST", body: "{}" },
      ),
  );

  server.registerTool(
    "coagenthub_answer_escalation",
    {
      description:
        "Answer an open escalation for a normal CoAgentHub v5 Mission. PlanRun Missions must use the v5 PlanRun decision path instead.",
      inputSchema: {
        missionId: z.string().min(1),
        answer: z.string().min(1),
      },
    },
    async ({ missionId, answer }) => {
      try {
        const mission = await client.request<MissionRecord>(
          "/missions/" + encodeURIComponent(missionId),
        );
        if (isPlanRunOrigin(mission.origin)) {
          throw new Error(
            "Mission belongs to a PlanRun. Use CoAgentHub v5 l3 plan decide --action answer instead of the ordinary Mission answer route.",
          );
        }
        return text(
          await client.request(
            "/missions/" +
              encodeURIComponent(missionId) +
              "/escalations/answer",
            {
              method: "POST",
              body: JSON.stringify({ answer }),
            },
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "coagenthub_approve_checkpoint",
    {
      description:
        "Approve the earliest open Standard Mission work-item checkpoint after verifying that the open escalation is a platform work_item_checkpoint gate. PlanRun-origin Missions are rejected.",
      inputSchema: { missionId: z.string().min(1) },
    },
    async ({ missionId }) => {
      try {
        const mission = await client.request<MissionRecord>(
          "/missions/" + encodeURIComponent(missionId),
        );
        if (isPlanRunOrigin(mission.origin)) {
          throw new Error(
            "Mission belongs to a PlanRun. Its checkpoint decision must use the PlanRun decision path; the v5 HTTP API does not expose that write path yet.",
          );
        }
        const open = mission.openEscalations ?? [];
        const first = open[0];
        if (!first || first.platformGate?.kind !== "work_item_checkpoint") {
          throw new Error(
            "The earliest open escalation is not a work_item_checkpoint gate; refusing to answer it as checkpoint approval.",
          );
        }
        return text(
          await client.request(
            "/missions/" +
              encodeURIComponent(missionId) +
              "/escalations/answer",
            {
              method: "POST",
              body: JSON.stringify({ answer: "continue" }),
            },
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "coagenthub_pause_mission",
    {
      description:
        "Pause a CoAgentHub v5 Mission without changing its phase. The scheduler will leave it alone until resumed.",
      inputSchema: { missionId: z.string().min(1) },
    },
    async ({ missionId }) =>
      requestText(
        client,
        "/missions/" + encodeURIComponent(missionId) + "/pause",
        { method: "POST", body: "{}" },
      ),
  );

  server.registerTool(
    "coagenthub_resume_mission",
    {
      description:
        "Resume a paused CoAgentHub v5 Mission. This clears the pause state only; the Host/runner may still need to be started again to continue execution.",
      inputSchema: { missionId: z.string().min(1) },
    },
    async ({ missionId }) =>
      requestText(
        client,
        "/missions/" + encodeURIComponent(missionId) + "/resume",
        { method: "POST", body: "{}" },
      ),
  );

  server.registerTool(
    "coagenthub_cancel_mission",
    {
      description:
        "Cancel a CoAgentHub v5 Mission as a terminal stop. In-flight work may finish its current hop but no further scheduling should occur.",
      inputSchema: {
        missionId: z.string().min(1),
        reason: z.string().default(""),
      },
    },
    async ({ missionId, reason }) =>
      requestText(
        client,
        "/missions/" + encodeURIComponent(missionId) + "/cancel",
        { method: "POST", body: JSON.stringify({ reason }) },
      ),
  );

  server.registerTool(
    "coagenthub_park_mission",
    {
      description:
        "Park a CoAgentHub v5 Mission with an explicit reviewer and reason.",
      inputSchema: {
        missionId: z.string().min(1),
        reason: z.string().min(1),
        reviewer: z.string().min(1).max(128).optional(),
      },
    },
    async ({ missionId, reason, reviewer }) => {
      const who = reviewer?.trim() || process.env.COAGENTHUB_REVIEWER_ID?.trim();
      if (!who) {
        return failure(
          new Error(
            "reviewer is required. Pass it explicitly or configure COAGENTHUB_REVIEWER_ID.",
          ),
        );
      }
      return requestText(
        client,
        "/missions/" + encodeURIComponent(missionId) + "/park",
        {
          method: "POST",
          body: JSON.stringify({ reason, reviewer: who }),
        },
      );
    },
  );

  server.registerTool(
    "coagenthub_resume_parked_mission",
    {
      description:
        "Resume a parked CoAgentHub v5 Mission with reviewer attribution and an optional answer to the parked question.",
      inputSchema: {
        missionId: z.string().min(1),
        reason: z.string().min(1),
        reviewer: z.string().min(1).max(128).optional(),
        answer: z.string().min(1).optional(),
      },
    },
    async ({ missionId, reason, reviewer, answer }) => {
      const who = reviewer?.trim() || process.env.COAGENTHUB_REVIEWER_ID?.trim();
      if (!who) {
        return failure(
          new Error(
            "reviewer is required. Pass it explicitly or configure COAGENTHUB_REVIEWER_ID.",
          ),
        );
      }
      return requestText(
        client,
        "/missions/" + encodeURIComponent(missionId) + "/parked-resume",
        {
          method: "POST",
          body: JSON.stringify({
            reason,
            reviewer: who,
            ...(answer ? { answer } : {}),
          }),
        },
      );
    },
  );

  server.registerTool(
    "coagenthub_revise_contract",
    {
      description:
        "Publish a new authoritative Mission contract revision. If the Mission was awaiting review, v5 may send it back to planning under the revised contract.",
      inputSchema: {
        missionId: z.string().min(1),
        contract: z.record(z.unknown()),
      },
    },
    async ({ missionId, contract }) =>
      requestText(
        client,
        "/missions/" + encodeURIComponent(missionId) + "/contract",
        { method: "POST", body: JSON.stringify(contract) },
      ),
  );

  server.registerTool(
    "coagenthub_retire_work_item",
    {
      description:
        "Retire one WorkItem from a Mission with an explicit reason so the coordinator can re-plan around it.",
      inputSchema: {
        missionId: z.string().min(1),
        workItemId: z.string().min(1),
        reason: z.string().min(1),
      },
    },
    async ({ missionId, workItemId, reason }) =>
      requestText(
        client,
        "/missions/" +
          encodeURIComponent(missionId) +
          "/work-items/" +
          encodeURIComponent(workItemId) +
          "/retire",
        { method: "POST", body: JSON.stringify({ reason }) },
      ),
  );

  server.registerTool(
    "coagenthub_rerun_mission",
    {
      description:
        "Create a new Mission run from the current contract while leaving the source Mission history unchanged.",
      inputSchema: {
        missionId: z.string().min(1),
        newMissionId: z.string().min(1).optional(),
        baseRevision: z.string().min(1).optional(),
      },
    },
    async ({ missionId, newMissionId, baseRevision }) =>
      requestText(
        client,
        "/missions/" + encodeURIComponent(missionId) + "/rerun",
        {
          method: "POST",
          body: JSON.stringify({
            ...(newMissionId ? { newMissionId } : {}),
            ...(baseRevision ? { baseRevision } : {}),
          }),
        },
      ),
  );

  server.registerTool(
    "coagenthub_raise_mission_budget",
    {
      description:
        "Raise a Mission cost cap through the v5 control plane. This can release a mission_cost_cap_reached gate.",
      inputSchema: {
        missionId: z.string().min(1),
        by: z.number().finite().positive().default(10),
      },
    },
    async ({ missionId, by }) =>
      requestText(
        client,
        "/missions/" + encodeURIComponent(missionId) + "/budget/raise",
        { method: "POST", body: JSON.stringify({ by }) },
      ),
  );

  server.registerTool(
    "coagenthub_finalize_mission",
    {
      description:
        "Apply the CoAgentHub v5 L3 final verdict through /finalize/reviewer. Requires explicit reviewer identity and confirmation.",
      inputSchema: {
        missionId: z.string().min(1),
        verdict: z.enum(["merge", "send_back", "abandon"]),
        reasons: z.array(z.string().min(1)).default([]),
        projectRoot: z.string().min(1).optional(),
        reviewerId: z.string().min(1).max(128).optional(),
        confirmedBy: z.string().min(1).max(128).optional(),
      },
    },
    async (args) => {
      try {
        const reviewerId =
          args.reviewerId?.trim() ||
          process.env.COAGENTHUB_REVIEWER_ID?.trim();
        const confirmedBy =
          args.confirmedBy?.trim() ||
          process.env.COAGENTHUB_REVIEW_CONFIRMED_BY?.trim();
        if (!reviewerId || !confirmedBy) {
          throw new Error(
            "reviewerId and confirmedBy are required. Pass them explicitly or configure COAGENTHUB_REVIEWER_ID and COAGENTHUB_REVIEW_CONFIRMED_BY; never invent reviewer authority.",
          );
        }
        if (args.verdict === "send_back" && args.reasons.length === 0) {
          throw new Error("send_back requires at least one concrete reason.");
        }
        const body = {
          verdict: args.verdict,
          reasons: args.reasons,
          ...(args.projectRoot ? { projectRoot: args.projectRoot } : {}),
          reviewerId,
          confirmedBy,
        };
        return text(
          await client.request(
            "/missions/" +
              encodeURIComponent(args.missionId) +
              "/finalize/reviewer",
            { method: "POST", body: JSON.stringify(body) },
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "coagenthub_list_plan_runs",
    {
      description:
        "List CoAgentHub v5 PlanRun snapshots. Use this when a Delivery recipient starts with plan-run:.",
      inputSchema: {},
    },
    async () => requestText(client, "/plan-runs"),
  );

  server.registerTool(
    "coagenthub_get_plan_run",
    {
      description: "Get one CoAgentHub v5 PlanRun snapshot by run id.",
      inputSchema: { runId: z.string().min(1) },
    },
    async ({ runId }) =>
      requestText(client, "/plan-runs/" + encodeURIComponent(runId)),
  );
}

async function requestText(
  client: CoAgentHubClient,
  path: string,
  init?: RequestInit,
) {
  try {
    return text(await client.request(path, init));
  } catch (error) {
    return failure(error);
  }
}

function isPlanRunOrigin(origin: MissionRecord["origin"]): boolean {
  return (
    origin?.clientType === "plan-run" ||
    origin?.conversationRef?.startsWith("plan-run:") === true
  );
}
function registerDashboard(server: McpServer, client: CoAgentHubClient): void {
  registerAppTool(
    server,
    "coagenthub_dashboard",
    {
      title: "CoAgentHub v5 L3 Dashboard",
      description:
        "Show CoAgentHub v5 Missions and pending L3 Deliveries in an interactive dashboard.",
      inputSchema: { projectId: z.string().optional() },
      _meta: { ui: { resourceUri: dashboardUri } },
    },
    async ({ projectId }) => {
      try {
        const [missions, inbox] = await Promise.all([
          client.request<MissionRecord[]>("/missions"),
          client.request<Record<string, unknown>>("/inbox"),
        ]);
        return text({
          missions: projectId
            ? missions.filter((row) => row.projectId === projectId)
            : missions,
          inbox,
          selectedProjectId: projectId ?? null,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  registerAppResource(
    server,
    "CoAgentHub v5 L3 Dashboard",
    dashboardUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: dashboardUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: dashboardHtml,
        },
      ],
    }),
  );
}

const dashboardHtml = [
  "<!doctype html>",
  "<html><head><meta charset=\"utf-8\"><title>CoAgentHub v5 L3</title>",
  "<style>body{font:14px system-ui;margin:0;padding:16px;background:#101217;color:#f4f4f5}",
  "button{background:#2f81f7;color:white;border:0;border-radius:6px;padding:8px 12px;cursor:pointer}",
  ".card{background:#191c24;border:1px solid #303542;border-radius:10px;padding:12px;margin:10px 0}",
  ".muted{color:#a1a1aa}.status{display:inline-block;border-radius:999px;padding:2px 8px;background:#303542}</style>",
  "</head><body><button id=\"refresh\">Refresh</button><div id=\"app\" class=\"muted\">Loading...</div>",
  "<script>(function(){",
  "const app=document.querySelector('#app');let seq=0;const pending=new Map();",
  "function call(name,args){const id=++seq;window.parent.postMessage({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args||{}}},'*');return new Promise(r=>pending.set(id,r));}",
  "function dataOf(r){if(!r)return null;if(r.structuredContent)return r.structuredContent;if(r.content&&r.content[0]&&r.content[0].text){try{return JSON.parse(r.content[0].text)}catch(e){return null}}return null}",
  "function esc(v){return String(v==null?'':v).replace(/[&<>\"]/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'})[c]})}",
  "function render(d){const ms=(d&&d.missions)||[];const ib=(d&&d.inbox&&d.inbox.pending)||[];let h='<h2>CoAgentHub v5 - L3</h2><div class=\"card\"><strong>Pending deliveries: '+ib.length+'</strong></div>';h+=ms.map(function(m){return '<div class=\"card\"><span class=\"status\">'+esc(m.status)+'</span> <strong>'+esc(m.missionId)+'</strong><div class=\"muted\">'+esc(m.projectId)+' - '+esc(m.intent||'')+'</div></div>'}).join('');app.innerHTML=h}",
  "window.addEventListener('message',function(e){const m=e.data;if(!m||m.jsonrpc!=='2.0')return;if(m.method==='ui/initialize'){window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');return}if(m.method==='ui/notifications/tool-result'){const d=dataOf(m.params);if(d)render(d);return}if(m.id!=null&&pending.has(m.id)){const r=pending.get(m.id);pending.delete(m.id);const d=dataOf(m.result);if(d)render(d);r(m.result)}});",
  "document.querySelector('#refresh').onclick=function(){call('coagenthub_dashboard',{}).catch(function(){})};",
  "window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');",
  "})();<\/script></body></html>",
].join("\n");
