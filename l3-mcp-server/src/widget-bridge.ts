/**
 * MCP Apps JSON-RPC postMessage bridge for the CoAgentHub task dashboard.
 * This module is framework-agnostic and runs inside the iframe.
 */
export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface WidgetBridge {
  sendRequest(method: string, params?: unknown): Promise<JsonRpcMessage>;
  sendNotification(method: string, params?: unknown): void;
  render(data: { groups?: { items?: unknown[] }; tasks?: unknown[] }): void;
  parseStructuredContent(result: unknown): Record<string, unknown> | null;
}

export function createWidgetBridge(window: Window): WidgetBridge {
  let nextId = 0;
  const pending = new Map<number, (msg: JsonRpcMessage) => void>();

  function getNextId(): number {
    return ++nextId;
  }

  function sendRequest(method: string, params?: unknown): Promise<JsonRpcMessage> {
    const id = getNextId();
    const msg: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    window.parent.postMessage(msg, "*");
    return new Promise<JsonRpcMessage>((resolve) => {
      pending.set(id, resolve);
    });
  }

  function sendNotification(method: string, params?: unknown): void {
    window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
  }

  function parseStructuredContent(result: unknown): Record<string, unknown> | null {
    if (!result) return null;
    const r = result as Record<string, unknown>;
    if (r.structuredContent) return r.structuredContent as Record<string, unknown>;
    if (Array.isArray(r.content) && r.content[0] && (r.content[0] as Record<string, unknown>).text) {
      try {
        return JSON.parse((r.content[0] as Record<string, unknown>).text as string);
      } catch {
        return null;
      }
    }
    return null;
  }

  function render(data: { groups?: { items?: unknown[] }; tasks?: unknown[] }): void {
    const groups = data?.groups?.items ?? [];
    const tasks = data?.tasks ?? [];
    const app = window.document.querySelector<HTMLElement>("#app");
    if (!app) return;

    let html = "<h2>CoAgentHub</h2>";
    html += groups
      .map((g) => {
        const group = g as Record<string, unknown>;
        return (
          `<div class="card"><strong>${group.title}</strong>` +
          `<div class="muted">${group.memberCount} participants · ${group.status}</div></div>`
        );
      })
      .join("");

    if (tasks.length > 0) {
      html += "<h3>Tasks</h3>";
      html += tasks
        .map((t) => {
          const task = t as Record<string, unknown>;
          const executorHtml = task.executorName
            ? `<span class="executor">${task.executorName}</span> · `
            : "";
          return (
            `<div class="card"><span class="status">${task.status}</span> ${task.brief ?? ""}` +
            `<div class="muted">${executorHtml}${task.outputTail ?? ""}</div></div>`
          );
        })
        .join("");
    } else {
      html += '<p class="muted">Select a group to inspect tasks.</p>';
    }
    app.innerHTML = html;
  }

  // Set up message handler
  window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as JsonRpcMessage;
    if (!msg || msg.jsonrpc !== "2.0") return;

    if (msg.method === "ui/initialize") {
      sendNotification("ui/notifications/initialized");
      return;
    }

    if (msg.method === "ui/notifications/tool-result") {
      const parsed = parseStructuredContent(msg.params);
      if (parsed) render(parsed as { groups?: { items?: unknown[] }; tasks?: unknown[] });
      return;
    }

    if (msg.id != null && pending.has(msg.id as number)) {
      const resolve = pending.get(msg.id as number)!;
      pending.delete(msg.id as number);
      resolve(msg);
    }

    if (msg.result) {
      const parsed = parseStructuredContent(msg.result);
      if (parsed) {
        render(parsed as { groups?: { items?: unknown[] }; tasks?: unknown[] });
        return;
      }
      const legacy = (msg.result as Record<string, unknown>).structuredContent ?? msg.result;
      const data = legacy as { groups?: unknown; tasks?: unknown };
      if (data && (data.groups || data.tasks)) {
        render(data as { groups?: { items?: unknown[] }; tasks?: unknown[] });
      }
    }
  });

  // Set up refresh button
  const refreshBtn = window.document.querySelector<HTMLButtonElement>("#refresh");
  if (refreshBtn) {
    refreshBtn.onclick = () => {
      sendRequest("tools/call", { name: "coagenthub_dashboard", arguments: {} }).catch(() => {});
    };
  }

  // Expose legacy compatibility
  (window as unknown as { openai: unknown }).openai = {
    callTool: (name: string, args: unknown) => sendRequest("tools/call", { name, arguments: args }),
  };

  // Signal ready
  sendNotification("ui/notifications/initialized");

  return { sendRequest, sendNotification, render, parseStructuredContent };
}
