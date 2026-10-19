/**
 * Direct 主控模式的 MCP 接线：一条命令一条 POST，不在插件里做任何领域校验。
 *
 * 平台侧的门禁、host Attempt 生命周期、事件留痕都在
 * `src/application/platform/direct-control.ts`。这里只做两件事：
 *  - 用 zod 描述七种 command 的形状（每个分支都 strict：actor / attemptId /
 *    passed / usage 这类身份与自报结论字段出现在顶层就拒，不默默忽略）；
 *  - POST `/missions/{id}/direct-control`，把应答原样交回调用方。
 *
 * WorkOrder / MissionResult 这类由服务器 normalize 的大对象收成 record，
 * 不跨包 import 内核源码类型——插件与平台各自独立发布。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CoAgentHubClient } from "./coagenthub-client.js";

const planCommand = z
  .object({
    action: z.literal("plan"),
    plan: z.object({
      findings: z.string(),
      rejectedHypotheses: z.array(z.string()),
      decisions: z.array(z.string()),
      direction: z.string(),
      risks: z.array(z.string()),
      rootCause: z.string().optional(),
    }),
  })
  .strict();

const contractCheckCommand = z
  .object({
    action: z.literal("contract_check"),
    check: z.object({
      verdict: z.enum(["ok", "issues"]),
      summary: z.string(),
      issues: z.array(z.string()).optional(),
    }),
  })
  .strict();

const createWorkItemCommand = z
  .object({
    action: z.literal("create_work_item"),
    title: z.string().min(1),
    // WorkOrder 由服务器 normalize，插件不重复它的字段表。
    order: z.record(z.unknown()),
    workItemId: z.string().min(1).optional(),
  })
  .strict();

const reviseWorkOrderCommand = z
  .object({
    action: z.literal("revise_work_order"),
    workItemId: z.string().min(1),
    order: z.record(z.unknown()),
  })
  .strict();

const dispatchCommand = z
  .object({
    action: z.literal("dispatch"),
    workItemIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

const reviewCommand = z
  .object({
    action: z.literal("review"),
    workItemId: z.string().min(1),
    verdict: z.enum(["accept", "reject"]),
    reasons: z.array(z.string()),
    requiredChanges: z.array(z.string()),
    // status 取内核 AcceptanceStatus 的实际取值：not_applicable，不是 unnecessary。
    acceptanceResults: z
      .array(
        z.object({
          criterion: z.string().min(1),
          status: z.enum(["pass", "fail", "unverified", "not_applicable"]),
          evidence: z.string().optional(),
          note: z.string().optional(),
        }),
      )
      .optional(),
  })
  .strict();

const submitCommand = z
  .object({
    action: z.literal("submit"),
    // MissionResultBody 同样由服务器 normalize。
    result: z.record(z.unknown()),
  })
  .strict();

const directControlCommandSchema = z.discriminatedUnion("action", [
  planCommand,
  contractCheckCommand,
  createWorkItemCommand,
  reviseWorkOrderCommand,
  dispatchCommand,
  reviewCommand,
  submitCommand,
]);

const toStructuredContent = (value: unknown): Record<string, unknown> => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return { value };
};

const result = (value: unknown) => {
  const structuredContent = toStructuredContent(value);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
};

const errorResult = (error: unknown) => ({
  ...result({ error: error instanceof Error ? error.message : String(error) }),
  isError: true,
});

export function registerDirectControlTools(
  server: McpServer,
  client: CoAgentHubClient,
): void {
  server.registerTool(
    "coagenthub_direct_control",
    {
      description:
        "Run exactly one direct-mode controller command on a v5 Mission (plan / contract_check / create_work_item / revise_work_order / dispatch / review / submit). Actor and attempt identity come from the control-plane credential; this tool starts no agent and never retries.",
      inputSchema: {
        missionId: z.string().min(1),
        command: directControlCommandSchema,
      },
    },
    async ({ missionId, command }) => {
      try {
        const response = await client.request<Record<string, unknown>>(
          "/missions/" + encodeURIComponent(missionId) + "/direct-control",
          { method: "POST", body: JSON.stringify(command) },
        );
        return result(response);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
