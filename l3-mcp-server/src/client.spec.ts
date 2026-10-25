import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoAgentHubClient } from "./coagenthub-client.js";

describe("CoAgentHubClient v5", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
    delete process.env.COAGENTHUB_API_BASE;
    delete process.env.COAGENTHUB_CONTROL_HEADER;
    delete process.env.COAGENTHUB_CONTROL_CREDENTIAL;
  });

  afterEach(() => {
    fetchMock.mockRestore();
    delete process.env.COAGENTHUB_API_BASE;
    delete process.env.COAGENTHUB_CONTROL_HEADER;
    delete process.env.COAGENTHUB_CONTROL_CREDENTIAL;
  });

  it("uses the CoAgentHub v5 loopback default", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    const client = new CoAgentHubClient();
    await client.request("/missions");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:3101/api/missions",
    );
  });

  it("does not send the legacy participant header", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    const client = new CoAgentHubClient();
    await client.request("/projects");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("X-Participant-Id")).toBeNull();
  });

  it("strips a trailing slash from an override", async () => {
    process.env.COAGENTHUB_API_BASE = "http://example.test:3101/api/";
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    const client = new CoAgentHubClient();
    await client.request("/missions");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://example.test:3101/api/missions",
    );
  });
  it("optionally forwards a configured control credential header", async () => {
    process.env.COAGENTHUB_CONTROL_HEADER = "x-test-control";
    process.env.COAGENTHUB_CONTROL_CREDENTIAL = "secret-value";
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const client = new CoAgentHubClient();
    await client.request("/projects");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("x-test-control")).toBe("secret-value");
  });

  it("does not send a half-configured control header", async () => {
    process.env.COAGENTHUB_CONTROL_HEADER = "x-test-control";
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const client = new CoAgentHubClient();
    await client.request("/projects");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Headers).get("x-test-control")).toBeNull();
  });
  it("throws a v5-labelled error on non-OK response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    );
    const client = new CoAgentHubClient();
    await expect(client.request("/missions/missing")).rejects.toThrow(
      /CoAgentHub v5 404/,
    );
  });

  it("posts JSON bodies with content type", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const client = new CoAgentHubClient();
    await client.request("/deliveries/d-1/ack", {
      method: "POST",
      body: "{}",
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Headers).get("Content-Type")).toBe(
      "application/json",
    );
  });
});
