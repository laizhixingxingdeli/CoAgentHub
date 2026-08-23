import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchLocalUserParticipantId,
  findLocalUserParticipantId,
} from "./local-user";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Local User participant lookup", () => {
  it("finds the server-provided Local User id", () => {
    expect(
      findLocalUserParticipantId([
        { id: "participant-2", name: "win-hermes" },
        { id: "local-user-id", name: "Local User" },
      ]),
    ).toBe("local-user-id");
  });

  it("does not mistake another participant for Local User", () => {
    expect(
      findLocalUserParticipantId([
        { id: "participant-1", name: "local user" },
        { id: "participant-2", name: "win-hermes" },
      ]),
    ).toBeUndefined();
  });

  it("loads the id through the existing participant list endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([{ id: "local-user-id", name: "Local User" }]),
            { status: 200 },
          ),
      ),
    );

    await expect(fetchLocalUserParticipantId()).resolves.toBe("local-user-id");
    expect(fetch).toHaveBeenCalledWith("/api/participants");
  });
});
