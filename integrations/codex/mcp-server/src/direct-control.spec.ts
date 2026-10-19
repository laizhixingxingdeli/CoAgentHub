import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { CoAgentHubClient } from "./coagenthub-client.js";
import { registerDirectControlTools } from "./direct-control.js";

type ToolConfig = { inputSchema: z.ZodRawShape };
type ToolHandler = (args: { missionId: string; command: unknown }) => Promise<{
  content: { type: string; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}>;

function setup() {
  const request = vi.fn();
  const tools: Record<string, { config: ToolConfig; handler: ToolHandler }> = {};
  const server = {
    registerTool(name: string, config: ToolConfig, handler: ToolHandler) {
      tools[name] = { config, handler };
      return {};
    },
  };
  registerDirectControlTools(
    server as unknown as Parameters<typeof registerDirectControlTools>[0],
    { request } as unknown as CoAgentHubClient,
  );
  const tool = tools.coagenthub_direct_control;
  const inputSchema = z.object(tool.config.inputSchema);
  return { request, tool, inputSchema };
}

// 七种 command 的最小合法形状（order / result 由服务器 normalize，插件只收 record）。
const validCommands: { action: string; command: Record<string, unknown> }[] = [
  {
    action: "plan",
    command: {
      action: "plan",
      plan: {
        findings: "f",
        rejectedHypotheses: [],
        decisions: [],
        direction: "d",
        risks: [],
      },
    },
  },
  {
    action: "contract_check",
    command: { action: "contract_check", check: { verdict: "ok", summary: "s" } },
  },
  {
    action: "create_work_item",
    command: { action: "create_work_item", title: "t", order: {}, workItemId: "w-1" },
  },
  {
    action: "revise_work_order",
    command: { action: "revise_work_order", workItemId: "w-1", order: {} },
  },
  { action: "dispatch", command: { action: "dispatch", workItemIds: ["w-1"] } },
  {
    action: "review",
    command: {
      action: "review",
      workItemId: "w-1",
      verdict: "accept",
      reasons: [],
      requiredChanges: [],
      acceptanceResults: [{ criterion: "c-1", status: "pass" }],
    },
  },
  { action: "submit", command: { action: "submit", result: {} } },
];

// 身份与自报结论不得从顶层注入：schema 每个分支都是 strict。
const injectedTopLevelFields = [
  ["actor", "controller"],
  ["attemptId", "attempt-1"],
  ["usage", { tokens: 1 }],
  ["passed", true],
] as const;

describe("direct-control MCP adapter", () => {
  it("accepts all seven commands and POSTs each one verbatim to the encoded direct-control path", async () => {
    const { request, tool, inputSchema } = setup();
    const responses: Record<string, unknown>[] = [];

    for (const [index, entry] of validCommands.entries()) {
      const response = { action: entry.action, index };
      responses.push(response);
      request.mockResolvedValueOnce(response);

      const parsed = inputSchema.safeParse({ missionId: "m/a", command: entry.command });
      expect(parsed.success, `${entry.action} rejected by input schema`).toBe(true);
      expect(parsed.success && parsed.data.command).toEqual(entry.command);

      const res = await tool.handler({ missionId: "m/a", command: entry.command });
      const call = request.mock.calls[index];
      expect(call[0]).toBe("/missions/m%2Fa/direct-control");
      expect(call[1].method).toBe("POST");
      // body 与 command 完全相等：插件不改写、不补默认值、不加身份字段。
      expect(call[1].body).toBe(JSON.stringify(entry.command));
      expect(res.isError).toBeUndefined();
      expect(res.structuredContent).toEqual(response);
      expect(JSON.parse(res.content[0].text)).toEqual(response);
    }

    expect(request).toHaveBeenCalledTimes(validCommands.length);
  });

  it("rejects identity and self-reported outcome injection, unknown actions, and surfaces transport errors without retrying", async () => {
    const { request, tool, inputSchema } = setup();

    for (const { action, command } of validCommands) {
      for (const [field, value] of injectedTopLevelFields) {
        const injected = inputSchema.safeParse({
          missionId: "m",
          command: { ...command, [field]: value },
        });
        expect(injected.success, `${action} accepted top-level ${field}`).toBe(false);
      }
      // 身份字段同样不能绕过 schema 出现在 missionId 之外的第一层。
      const flattened = inputSchema.safeParse({ missionId: "m", ...command });
      expect(flattened.success, `${action} accepted a flat command`).toBe(false);
    }

    for (const unknown of [
      { action: "explode" },
      { action: "plan" },
      {},
    ]) {
      expect(inputSchema.safeParse({ missionId: "m", command: unknown }).success).toBe(false);
    }
    // missionId 仍是必填且非空。
    expect(inputSchema.safeParse({ command: validCommands[0].command }).success).toBe(false);
    expect(
      inputSchema.safeParse({ missionId: "", command: validCommands[0].command }).success,
    ).toBe(false);

    const credential = "ctl-token-should-not-leak";
    const client = {
      request: vi.fn().mockRejectedValue(new Error("CoAgentHub v5 409: mission busy")),
      controlCredential: credential,
    };
    const tools: Record<string, ToolHandler> = {};
    const server = {
      registerTool(name: string, _config: unknown, handler: ToolHandler) {
        tools[name] = handler;
        return {};
      },
    };
    registerDirectControlTools(
      server as unknown as Parameters<typeof registerDirectControlTools>[0],
      client as unknown as CoAgentHubClient,
    );

    const failed = await tools.coagenthub_direct_control({
      missionId: "m/a",
      command: validCommands[0].command,
    });

    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toEqual({ error: "CoAgentHub v5 409: mission busy" });
    expect(failed.content[0].text).not.toContain(credential);
    expect(JSON.stringify(failed)).not.toContain(credential);
    // 不重试，也不顺带打别的 endpoint。
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request.mock.calls[0][0]).toBe("/missions/m%2Fa/direct-control");
  });
});
