import { describe, expect, it } from "vitest";
import {
  CallbackAgentConfigSchema,
  CommandDriverSchema,
  EndpointConfigSchema,
} from "../src/config.js";

describe("Config validation", () => {
  it("accepts valid config", () => {
    const result = CallbackAgentConfigSchema.safeParse({
      apiBase: "http://localhost:3001",
      participantId: "00000000-0000-7000-8000-000000000001",
      consumerId: "my-consumer",
      endpoints: {
        "dev-mac": {
          driver: {
            driver: "command",
            executable: "/usr/bin/codex",
            args: ["exec", "resume", "--json", "{sessionRef}", "{message}"],
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects relative executable", () => {
    const result = CommandDriverSchema.safeParse({
      driver: "command",
      executable: "./codex",
      args: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects mixed template argument", () => {
    const result = CommandDriverSchema.safeParse({
      driver: "command",
      executable: "/usr/bin/codex",
      args: ["prefix-{sessionRef}-suffix"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields in endpoint config", () => {
    const result = EndpointConfigSchema.safeParse({
      driver: {
        driver: "command",
        executable: "/usr/bin/codex",
        args: [],
      },
      extraField: "should-fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid participantId (not uuid)", () => {
    const result = CallbackAgentConfigSchema.safeParse({
      apiBase: "http://localhost:3001",
      participantId: "not-a-uuid",
      consumerId: "test",
      endpoints: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing apiBase", () => {
    const result = CallbackAgentConfigSchema.safeParse({
      participantId: "00000000-0000-7000-8000-000000000001",
      consumerId: "test",
      endpoints: {},
    });
    expect(result.success).toBe(false);
  });

  it("allows env allowlist", () => {
    const result = CommandDriverSchema.safeParse({
      driver: "command",
      executable: "/usr/bin/codex",
      args: [],
      env: { HOME: "/Users/test", PATH: "/usr/bin" },
    });
    expect(result.success).toBe(true);
  });

  it("allows timeoutMs and eventFile options", () => {
    const result = CommandDriverSchema.safeParse({
      driver: "command",
      executable: "/usr/bin/codex",
      args: ["{eventFile}"],
      timeoutMs: 30000,
      eventFile: true,
    });
    expect(result.success).toBe(true);
  });
});
