import type { ClaimResponse, CompletionEvent, InboxItem } from "./config.js";
import { ClaimResponseSchema, InboxItemSchema } from "./config.js";

/**
 * Minimal HTTP client for the CoAgentHub task-completion-events API.
 * Uses fetch (Node 18+ global). No external dependencies.
 */
export class CompletionEventClient {
  constructor(
    private readonly apiBase: string,
    private readonly participantId: string,
  ) {}

  /**
   * List pending / retriable / lease-expired events for this participant.
   * @param after - optional cursor (eventId) for incremental polling
   * @param limit - max items (1-100)
   */
  async listEvents(after?: string, limit = 100): Promise<InboxItem[]> {
    const url = new URL(
      `/api/participants/${this.participantId}/task-completion-events`,
      this.apiBase,
    );
    if (after) url.searchParams.set("after", after);
    url.searchParams.set("limit", String(limit));

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`listEvents failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { events: unknown[] };
    return data.events.map((e) => InboxItemSchema.parse(e));
  }

  /**
   * Atomically claim an event (lease).
   * @param eventId - event to claim
   * @param consumerId - local consumer identifier
   * @param leaseMs - lease duration in milliseconds
   */
  async claimEvent(
    eventId: string,
    consumerId: string,
    leaseMs: number,
  ): Promise<ClaimResponse> {
    const url = new URL(
      `/api/participants/${this.participantId}/task-completion-events/${eventId}/claim`,
      this.apiBase,
    );
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ consumerId, leaseMs }),
    });
    if (!res.ok) {
      throw new Error(`claimEvent failed: ${res.status} ${res.statusText}`);
    }
    return ClaimResponseSchema.parse(await res.json());
  }

  /**
   * Acknowledge a claimed event as delivered (idempotent for same leaseToken).
   * @param eventId - event to ack
   * @param leaseToken - lease token from claim
   */
  async ackEvent(eventId: string, leaseToken: string): Promise<void> {
    const url = new URL(
      `/api/participants/${this.participantId}/task-completion-events/${eventId}/ack`,
      this.apiBase,
    );
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ leaseToken }),
    });
    if (!res.ok) {
      throw new Error(`ackEvent failed: ${res.status} ${res.statusText}`);
    }
  }

  /**
   * Record a delivery failure. Increments attempts, sets retryAfterMs.
   * @param eventId - event to fail
   * @param leaseToken - lease token from claim
   * @param error - optional error message (truncated to 2000 chars by server)
   * @param retryAfterMs - optional retry delay
   */
  async failEvent(
    eventId: string,
    leaseToken: string,
    error?: string,
    retryAfterMs?: number,
  ): Promise<void> {
    const url = new URL(
      `/api/participants/${this.participantId}/task-completion-events/${eventId}/fail`,
      this.apiBase,
    );
    const body: Record<string, unknown> = { leaseToken };
    if (error) body.error = error;
    if (retryAfterMs !== undefined) body.retryAfterMs = retryAfterMs;

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`failEvent failed: ${res.status} ${res.statusText}`);
    }
  }
}

export type { CompletionEvent };
