import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(__dirname, "../dist/index.js");

function rpc(id: number, method: string, params: Record<string, unknown> = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

describe("MCP stdio protocol smoke", () => {
  it("initialize → tools/list → tools/call over stdio", async () => {
    const child = spawn("node", [serverEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        COAGENTHUB_API_BASE:
          process.env.COAGENTHUB_API_BASE ?? "http://127.0.0.1:3101/api",
      },
    });

    const buffer: string[] = [];
    const pending = new Map<number, (msg: Record<string, unknown>) => void>();

    child.stdout.on("data", (d) => {
      buffer.push(d.toString());
      const text = buffer.join("");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.id != null && pending.has(msg.id as number)) {
            pending.get(msg.id as number)!(msg);
            pending.delete(msg.id as number);
          }
        } catch { /* not json */ }
      }
    });

    const waitForResponse = (id: number) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for response ${id}`)), 10_000);
        pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      });

    try {
      child.stdin.write(rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0.0.0" } }));
      const initResp = await waitForResponse(1);
      expect(initResp.result).toBeDefined();
      expect((initResp.result as Record<string, unknown>).serverInfo).toBeDefined();

      child.stdin.write(rpc(2, "tools/list"));
      const listResp = await waitForResponse(2);
      const tools = (listResp.result as Record<string, unknown>).tools as Array<{ name: string }>;
      const names = tools.map((t) => t.name);
      expect(names).toContain("coagenthub_get_attempt");
      expect(names).toContain("coagenthub_get_mission_live");
      expect(names).toContain("coagenthub_get_pool_config");
      expect(names).toContain("coagenthub_configure_role_pool");
      expect(names).toContain("coagenthub_get_document_proposals");
      expect(names).toContain("coagenthub_decide_document");
      expect(names).toContain("coagenthub_create_mission");
      expect(names).toContain("coagenthub_start_mission");
      expect(names).toContain("coagenthub_get_hosted_run");
      expect(names).toContain("coagenthub_get_platform_status");
      expect(names).toContain("coagenthub_list_projects");
      expect(names).toContain("coagenthub_list_missions");
      expect(names).toContain("coagenthub_get_mission");
      expect(names).toContain("coagenthub_get_validation_report");
      expect(names).toContain("coagenthub_get_inbox");
      expect(names).toContain("coagenthub_approve_checkpoint");
      expect(names).toContain("coagenthub_resume_mission");
      expect(names).toContain("coagenthub_revise_contract");
      expect(names).toContain("coagenthub_retire_work_item");
      expect(names).toContain("coagenthub_raise_mission_budget");
      expect(names).toContain("coagenthub_finalize_mission");
      expect(names).not.toContain("coagenthub_list_groups");
      expect(names).not.toContain("coagenthub_dispatch_task");

      child.stdin.write(rpc(3, "tools/call", { name: "coagenthub_list_projects", arguments: {} }));
      const callResp = await waitForResponse(3);
      expect(callResp.result).toBeDefined();
      const content = (callResp.result as Record<string, unknown>).content as Array<{ type: string; text: string }>;
      expect(content[0].type).toBe("text");
      expect(() => JSON.parse(content[0].text)).not.toThrow();
    } finally {
      child.kill();
    }
  }, 15_000);
});
