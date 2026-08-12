import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { SWRConfig } from "swr";
import { vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

/**
 * Shared test helpers: a dispatchable global fetch mock (the pages rely on
 * fetch — either directly or through the hono hc client — so stubbing the
 * global `fetch` covers both) and a render helper that isolates the SWR cache
 * and drives wouter through an in-memory location.
 */

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export type FetchHandler = {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => Response;
};

export function createFetchMock(handlers: FetchHandler[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const handler = handlers.find((h) => h.match(url, init));
    if (!handler) {
      return jsonResponse(
        { message: `unhandled request: ${init?.method ?? "GET"} ${url}` },
        404,
      );
    }
    return handler.respond(url, init);
  });
}

export function renderWithProviders(ui: ReactElement, path = "/") {
  return render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        shouldRetryOnError: false,
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
      }}
    >
      <Router hook={memoryLocation({ path }).hook}>{ui}</Router>
    </SWRConfig>,
  );
}
