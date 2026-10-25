import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWidgetBridge } from "./widget-bridge.js";

describe("MCP Apps widget bridge", () => {
  let posted: unknown[];
  let mockWindow: Window;

  beforeEach(() => {
    posted = [];
    const listeners = new Map<string, Set<EventListener>>();
    mockWindow = {
      parent: {
        postMessage: (msg: unknown) => {
          posted.push(msg);
        },
      },
      document: {
        querySelector: vi.fn(),
      },
      addEventListener: (type: string, listener: EventListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      dispatchEvent: (event: Event) => {
        const set = listeners.get(event.type);
        if (set) {
          for (const listener of set) {
            listener(event);
          }
        }
        return true;
      },
    } as unknown as Window;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends ui/notifications/initialized on creation", () => {
    createWidgetBridge(mockWindow);
    const initNotification = posted.find(
      (m) => (m as Record<string, unknown>).method === "ui/notifications/initialized",
    );
    expect(initNotification).toBeDefined();
  });

  it("sends ui/notifications/initialized when receiving ui/initialize", () => {
    createWidgetBridge(mockWindow);
    posted.length = 0;
    const data = {
      jsonrpc: "2.0",
      method: "ui/initialize",
      params: {},
    };
    mockWindow.dispatchEvent(new MessageEvent("message", { data }));
    const initNotification = posted.find(
      (m) => (m as Record<string, unknown>).method === "ui/notifications/initialized",
    );
    expect(initNotification).toBeDefined();
  });

  it("renders groups and tasks from tool-result notification", () => {
    const mockApp = { innerHTML: "" };
    (mockWindow.document.querySelector as ReturnType<typeof vi.fn>).mockReturnValue(mockApp);
    createWidgetBridge(mockWindow);
    posted.length = 0;

    const data = {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        structuredContent: {
          groups: {
            items: [
              { id: "g1", title: "Group One", memberCount: 3, status: "active" },
            ],
          },
          tasks: [
            { id: "t1", status: "done", brief: "Fix bug", executorName: "exec-1", outputTail: "ok" },
          ],
        },
      },
    };
    mockWindow.dispatchEvent(new MessageEvent("message", { data }));

    expect(mockApp.innerHTML).toContain("Group One");
    expect(mockApp.innerHTML).toContain("Fix bug");
    expect(mockApp.innerHTML).toContain("exec-1");
    expect(mockApp.innerHTML).toContain("ok");
  });

  it("clicking refresh sends tools/call request", () => {
    const mockRefreshBtn = { onclick: null as (() => void) | null };
    const mockApp = { innerHTML: "" };
    (mockWindow.document.querySelector as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(mockRefreshBtn) // for refresh button setup
      .mockReturnValue(mockApp); // for all subsequent calls (render)
    createWidgetBridge(mockWindow);
    posted.length = 0;

    mockRefreshBtn.onclick?.();

    const call = posted.find(
      (m) =>
        (m as Record<string, unknown>).method === "tools/call" &&
        (m as Record<string, unknown>).params &&
        ((m as Record<string, unknown>).params as Record<string, unknown>).name ===
          "coagenthub_dashboard",
    );
    expect(call).toBeDefined();
  });

  it("renders from tools/call response with structuredContent", () => {
    const mockApp = { innerHTML: "" };
    (mockWindow.document.querySelector as ReturnType<typeof vi.fn>).mockReturnValue(mockApp);
    createWidgetBridge(mockWindow);
    posted.length = 0;

    const data = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        structuredContent: {
          groups: {
            items: [{ id: "g2", title: "Group Two", memberCount: 5, status: "active" }],
          },
          tasks: [
            { id: "t2", status: "running", brief: "Add feature", executorName: "exec-2", outputTail: "in progress" },
          ],
        },
      },
    };
    mockWindow.dispatchEvent(new MessageEvent("message", { data }));

    expect(mockApp.innerHTML).toContain("Group Two");
    expect(mockApp.innerHTML).toContain("Add feature");
    expect(mockApp.innerHTML).toContain("exec-2");
  });

  it("renders from tools/call response with content text", () => {
    const mockApp = { innerHTML: "" };
    (mockWindow.document.querySelector as ReturnType<typeof vi.fn>).mockReturnValue(mockApp);
    createWidgetBridge(mockWindow);
    posted.length = 0;

    const data = {
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              groups: {
                items: [{ id: "g3", title: "Group Three", memberCount: 2, status: "active" }],
              },
              tasks: [],
            }),
          },
        ],
      },
    };
    mockWindow.dispatchEvent(new MessageEvent("message", { data }));

    expect(mockApp.innerHTML).toContain("Group Three");
  });

  it("ignores non-JSON-RPC messages", () => {
    const mockApp = { innerHTML: "" };
    (mockWindow.document.querySelector as ReturnType<typeof vi.fn>).mockReturnValue(mockApp);
    createWidgetBridge(mockWindow);
    posted.length = 0;

    const data = { someOtherProtocol: true };
    mockWindow.dispatchEvent(new MessageEvent("message", { data }));

    // Should not have sent any new messages
    expect(posted.length).toBe(0);
  });

  it("window.openai.callTool sends tools/call request", () => {
    const mockApp = { innerHTML: "" };
    (mockWindow.document.querySelector as ReturnType<typeof vi.fn>).mockReturnValue(mockApp);
    createWidgetBridge(mockWindow);
    posted.length = 0;

    // @ts-expect-error openai is set up by the bridge
    (mockWindow as unknown as { openai: { callTool: (name: string, args: unknown) => void } }).openai.callTool(
      "coagenthub_dashboard",
      {},
    );

    const call = posted.find(
      (m) =>
        (m as Record<string, unknown>).method === "tools/call" &&
        (m as Record<string, unknown>).params &&
        ((m as Record<string, unknown>).params as Record<string, unknown>).name ===
          "coagenthub_dashboard",
    );
    expect(call).toBeDefined();
  });

  it("parseStructuredContent extracts structuredContent", () => {
    const bridge = createWidgetBridge(mockWindow);
    const result = bridge.parseStructuredContent({
      structuredContent: { groups: { items: [] }, tasks: [] },
    });
    expect(result).toEqual({ groups: { items: [] }, tasks: [] });
  });

  it("parseStructuredContent extracts content text", () => {
    const bridge = createWidgetBridge(mockWindow);
    const result = bridge.parseStructuredContent({
      content: [{ type: "text", text: JSON.stringify({ groups: { items: [] } }) }],
    });
    expect(result).toEqual({ groups: { items: [] } });
  });

  it("parseStructuredContent returns null for invalid input", () => {
    const bridge = createWidgetBridge(mockWindow);
    expect(bridge.parseStructuredContent(null)).toBeNull();
    expect(bridge.parseStructuredContent({})).toBeNull();
    expect(bridge.parseStructuredContent({ content: [{ type: "text", text: "invalid json" }] })).toBeNull();
  });
});
