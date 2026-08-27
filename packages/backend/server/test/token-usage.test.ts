import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectTokenUsage } from "../src/lib/executor-task/token-usage";

const cwd = "/tmp/token-usage-project";
const startedAt = "2026-08-25T10:00:00.000Z";
const endedAt = "2026-08-25T10:05:00.000Z";
const homes: string[] = [];

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "coagenthub-token-usage-"));
  homes.push(value);
  return value;
}

afterEach(() => {
  for (const value of homes.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("platform token usage collection", () => {
  it("reads Codex turn.completed usage from --json stdout and extracts the final report", async () => {
    const result = await collectTokenUsage({
      executorKey: "codex",
      cwd,
      startedAt,
      endedAt,
      stdout: [
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 16932,
            cached_input_tokens: 11008,
            cache_write_input_tokens: 0,
            output_tokens: 5,
            reasoning_output_tokens: 0,
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "提交: abcdef1" }],
          },
        }),
      ].join("\n"),
    });
    expect(result).toEqual({
      tokenUsage: {
        inputTokens: 16932,
        outputTokens: 5,
        cachedInputTokens: 11008,
        totalTokens: 16932 + 11008 + 5,
        source: "codex-stdout-jsonl",
      },
    });
  });

  it("treats reasoning_output_tokens as a subset of output_tokens, not additive (real production record)", async () => {
    // Real coordinator run captured from production stdout on 2026-08-28.
    // Per OpenAI Responses API usage semantics, `output_tokens` is the total
    // output token count and `reasoning_output_tokens` is a breakdown already
    // contained within `output_tokens` (not an extra additive component). We
    // therefore must NOT add reasoning tokens on top of output tokens.
    const result = await collectTokenUsage({
      executorKey: "codex",
      cwd,
      startedAt,
      endedAt,
      stdout: JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 499823,
          cached_input_tokens: 436992,
          cache_write_input_tokens: 0,
          output_tokens: 5707,
          reasoning_output_tokens: 2221,
        },
      }),
    });
    expect(result.tokenUsage).toEqual({
      inputTokens: 499823,
      outputTokens: 5707,
      cachedInputTokens: 436992,
      totalTokens: 499823 + 436992 + 5707,
      source: "codex-stdout-jsonl",
    });
  });

  it("reports unavailable for Codex stdout that carries no turn.completed usage", async () => {
    await expect(
      collectTokenUsage({
        executorKey: "codex",
        cwd,
        startedAt,
        endedAt,
        stdout: [
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "done" }],
            },
          }),
          JSON.stringify({ type: "turn.started" }),
        ].join("\n"),
      }),
    ).resolves.toEqual({ tokenUsage: null, reason: "unavailable" });
  });

  it("matches Claude JSONL by cwd and execution window", async () => {
    const root = home();
    const directory = join(root, ".claude", "projects", "project");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "session.jsonl"),
      `${JSON.stringify({
        cwd,
        timestamp: "2026-08-25T10:02:00.000Z",
        message: {
          usage: {
            input_tokens: 80,
            cache_read_input_tokens: 10,
            output_tokens: 15,
          },
        },
      })}\n`,
    );
    const result = await collectTokenUsage({
      executorKey: "claude",
      cwd,
      startedAt,
      endedAt,
      homeDir: root,
    });
    expect(result).toEqual({
      tokenUsage: {
        inputTokens: 80,
        outputTokens: 15,
        cachedInputTokens: 10,
        totalTokens: 105,
        source: "claude-jsonl",
      },
    });
  });

  it("reads AtomCode session metadata and CodeBuddy JSONL natively", async () => {
    const root = home();
    const atomDir = join(root, ".atomcode", "sessions", "session");
    const buddyDir = join(root, ".codebuddy", "projects", "project");
    mkdirSync(atomDir, { recursive: true });
    mkdirSync(buddyDir, { recursive: true });
    writeFileSync(
      join(atomDir, "session.meta"),
      JSON.stringify({
        working_dir: cwd,
        name: "/tmp/coagenthub-ticket-01a038e6-913f-779",
        created_at: Date.parse(startedAt),
        updated_at: Date.parse(endedAt),
        turn_stats: [
          {
            total_tokens: 77,
            used_tokens: 75,
            ctx_window: 512000,
            model_usage: [
              {
                provider_id: "AtomGit-deepseek-v4-flash",
                model_id: "deepseek-v4-flash",
                tokens: { input: 50, output: 10, cached_input: 5 },
              },
            ],
          },
        ],
      }),
    );
    const atom = await collectTokenUsage({
      executorKey: "executor",
      taskId: "01a038e6-913f-7790-0000-000000000000",
      cwd,
      startedAt,
      endedAt,
      homeDir: root,
    });
    expect(atom.tokenUsage?.source).toBe("atomcode-session-meta");
    expect(atom.tokenUsage?.totalTokens).toBe(65);
    expect(atom.tokenUsage).toMatchObject({
      inputTokens: 50,
      outputTokens: 10,
      cachedInputTokens: 5,
    });

    writeFileSync(
      join(buddyDir, "session.jsonl"),
      `${JSON.stringify({
        cwd,
        timestamp: "2026-08-25T10:03:00.000Z",
        usage: {
          inputTokens: 30,
          outputTokens: 7,
          cachedTokens: 3,
          totalTokens: 37,
        },
      })}\n`,
    );
    const buddy = await collectTokenUsage({
      executorKey: "codebuddy",
      cwd,
      startedAt,
      endedAt,
      homeDir: root,
    });
    expect(buddy.tokenUsage).toEqual({
      inputTokens: 30,
      outputTokens: 7,
      cachedInputTokens: 3,
      totalTokens: 37,
      source: "codebuddy-jsonl",
    });
  });

  it("accumulates every model_usage entry and skips turns without model usage", async () => {
    const root = home();
    const atomDir = join(root, ".atomcode", "sessions", "session");
    mkdirSync(atomDir, { recursive: true });
    writeFileSync(
      join(atomDir, "session.meta"),
      JSON.stringify({
        name: "/tmp/coagenthub-ticket-01a03b41-c0f3-75a",
        working_dir: "/another/project",
        created_at: 0,
        updated_at: 1,
        turn_stats: [
          {
            total_tokens: 77,
            model_usage: [
              { tokens: { input: 20, output: 3, cached_input: 4 } },
              { tokens: { input: 7, output: 2, cached_input: 1 } },
            ],
          },
          { total_tokens: 999, used_tokens: 888 },
        ],
      }),
    );
    writeFileSync(
      join(atomDir, "overlapping-session.meta"),
      JSON.stringify({
        name: "manual-session",
        working_dir: cwd,
        created_at: Date.parse(startedAt),
        updated_at: Date.parse(endedAt),
        turn_stats: [{ model_usage: [{ tokens: { input: 100, output: 1 } }] }],
      }),
    );

    const result = await collectTokenUsage({
      executorKey: "executor",
      taskId: "01a03b41-c0f3-75a4-8ee9-b71507363f5f",
      cwd,
      startedAt,
      endedAt,
      executorPid: 123,
      homeDir: root,
    });

    expect(result.tokenUsage).toEqual({
      inputTokens: 27,
      outputTokens: 5,
      cachedInputTokens: 5,
      totalTokens: 37,
      source: "atomcode-session-meta",
    });
    expect(result.tokenUsage?.totalTokens).not.toBe(77);
  });

  it("uses the time-window fallback for non-ticket AtomCode sessions", async () => {
    const root = home();
    const atomDir = join(root, ".atomcode", "sessions", "session");
    mkdirSync(atomDir, { recursive: true });
    writeFileSync(
      join(atomDir, "session.meta"),
      JSON.stringify({
        name: "manual-session",
        working_dir: cwd,
        created_at: Date.parse(startedAt),
        updated_at: Date.parse(endedAt),
        turn_stats: [{ model_usage: [{ tokens: { input: 8, output: 2 } }] }],
      }),
    );

    const result = await collectTokenUsage({
      executorKey: "executor",
      cwd,
      startedAt,
      endedAt,
      homeDir: root,
    });

    expect(result.tokenUsage?.totalTokens).toBe(10);
  });

  it("reports unavailable when AtomCode has no model usage instead of estimating", async () => {
    const root = home();
    const atomDir = join(root, ".atomcode", "sessions", "session");
    mkdirSync(atomDir, { recursive: true });
    writeFileSync(
      join(atomDir, "session.meta"),
      JSON.stringify({
        name: "/tmp/coagenthub-ticket-01a03b41-c0f3-75a",
        working_dir: cwd,
        created_at: Date.parse(startedAt),
        updated_at: Date.parse(endedAt),
        turn_stats: [{ total_tokens: 77, used_tokens: 75 }],
      }),
    );

    await expect(
      collectTokenUsage({
        executorKey: "executor",
        taskId: "01a03b41-c0f3-75a4-8ee9-b71507363f5f",
        cwd,
        startedAt,
        endedAt,
        homeDir: root,
      }),
    ).resolves.toEqual({ tokenUsage: null, reason: "unavailable" });
  });

  it("records unavailable (never unsupported) for the four previously-unsupported keys when no usage exists (R4)", async () => {
    // Frozen spec R4: a generic miss is always `unavailable`, including the four
    // keys that used to return `unsupported`. We never guess or fabricate.
    for (const key of ["reasonix", "hermes", "win-hermes", "reviewer"]) {
      await expect(
        collectTokenUsage({
          executorKey: key,
          cwd,
          startedAt,
          endedAt,
          homeDir: home(),
        }),
      ).resolves.toEqual({ tokenUsage: null, reason: "unavailable" });
    }
  });

  it("records unavailable for codex when stdout carries no parseable usage", async () => {
    await expect(
      collectTokenUsage({
        executorKey: "codex",
        cwd,
        startedAt,
        endedAt,
        stdout: "",
        homeDir: home(),
      }),
    ).resolves.toEqual({ tokenUsage: null, reason: "unavailable" });
  });

  it("generic fallback collects the LAST usage object from an unknown executor's stdout JSONL", async () => {
    // An executor key with no custom collector must still resolve real usage
    // by scanning the stdout JSONL, not return `unsupported`.
    const result = await collectTokenUsage({
      executorKey: "does-not-exist",
      cwd,
      startedAt,
      endedAt,
      stdout: [
        JSON.stringify({
          type: "progress",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            cached_input_tokens: 30,
            output_tokens: 20,
          },
        }),
      ].join("\n"),
    });
    expect(result.tokenUsage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 30,
      // Conservative total = input + output (cached is a subset, never added).
      totalTokens: 100 + 20,
      source: "generic-jsonl-scan",
    });
  });

  it("generic fallback matches the Codex custom path for the same real Codex stdout", async () => {
    // Replays one real Codex stdout: with the `codex` key (custom path) and with
    // an unknown key (generic scan). The collected totalTokens must be identical
    // — the fallback must not invent a second caliber.
    const codexStdout = [
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 16932,
          cached_input_tokens: 11008,
          cache_write_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "提交: abcdef1" }],
        },
      }),
    ].join("\n");
    const custom = await collectTokenUsage({
      executorKey: "codex",
      cwd,
      startedAt,
      endedAt,
      stdout: codexStdout,
    });
    const generic = await collectTokenUsage({
      executorKey: "unknown-codex-like",
      cwd,
      startedAt,
      endedAt,
      stdout: codexStdout,
    });
    expect(custom.tokenUsage?.totalTokens).toBe(16932 + 5);
    expect(generic.tokenUsage?.totalTokens).toBe(
      custom.tokenUsage?.totalTokens,
    );
    expect(generic.tokenUsage?.source).toBe("generic-jsonl-scan");
  });

  it("generic fallback matches the AtomCode custom path for the same representative totals", async () => {
    // AtomCode custom path reads session .meta; generic reads stdout JSONL.
    // Same representative totals (cache-free) must yield the same totalTokens.
    const atomcodeLikeStdout = JSON.stringify({
      type: "usage_report",
      data: { input: 50, output: 10, cached_input: 0 },
    });
    const generic = await collectTokenUsage({
      executorKey: "unknown-atomcode-like",
      cwd,
      startedAt,
      endedAt,
      stdout: atomcodeLikeStdout,
    });
    // Mirrors the AtomCode custom collector: input + cached + output = 60.
    expect(generic.tokenUsage?.totalTokens).toBe(50 + 10);
    expect(generic.tokenUsage?.source).toBe("generic-jsonl-scan");
  });

  it("generic fallback reports unavailable when no usage object exists anywhere", async () => {
    const result = await collectTokenUsage({
      executorKey: "does-not-exist",
      cwd,
      startedAt,
      endedAt,
      stdout: [
        JSON.stringify({ type: "log", message: "no usage here" }),
        JSON.stringify({ type: "turn.started" }),
      ].join("\n"),
    });
    expect(result).toEqual({ tokenUsage: null, reason: "unavailable" });
  });

  it("generic fallback collects deeply nested usage for reasonix", async () => {
    const result = await collectTokenUsage({
      executorKey: "reasonix",
      cwd,
      startedAt,
      endedAt,
      stdout: JSON.stringify({
        event: "token_usage",
        payload: {
          result: {
            token_usage: {
              input_tokens: 1200,
              cached_input_tokens: 400,
              output_tokens: 300,
            },
          },
        },
      }),
    });
    expect(result.tokenUsage).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      cachedInputTokens: 400,
      totalTokens: 1200 + 300,
      source: "generic-jsonl-scan",
    });
  });

  it("generic fallback collects deeply nested usage for hermes", async () => {
    const result = await collectTokenUsage({
      executorKey: "hermes",
      cwd,
      startedAt,
      endedAt,
      stdout: JSON.stringify({
        kind: "metrics",
        nested: {
          deep: {
            usage: {
              inputTokens: 800,
              outputTokens: 150,
              cacheReadInputTokens: 200,
            },
          },
        },
      }),
    });
    expect(result.tokenUsage).toEqual({
      inputTokens: 800,
      outputTokens: 150,
      cachedInputTokens: 200,
      totalTokens: 800 + 150,
      source: "generic-jsonl-scan",
    });
  });

  it("generic fallback collects deeply nested usage for win-hermes", async () => {
    const result = await collectTokenUsage({
      executorKey: "win-hermes",
      cwd,
      startedAt,
      endedAt,
      stdout: [
        JSON.stringify({ event: "noop", value: 1 }),
        JSON.stringify({
          stream: [
            { type: "partial", tokens: 3 },
            {
              type: "final",
              usage: {
                input_tokens: 2400,
                cached_tokens: 600,
                output_tokens: 500,
              },
            },
          ],
        }),
      ].join("\n"),
    });
    expect(result.tokenUsage).toEqual({
      inputTokens: 2400,
      outputTokens: 500,
      cachedInputTokens: 600,
      totalTokens: 2400 + 500,
      source: "generic-jsonl-scan",
    });
  });

  it("generic fallback prefers an explicit total_tokens over input+output when present", async () => {
    const result = await collectTokenUsage({
      executorKey: "does-not-exist",
      cwd,
      startedAt,
      endedAt,
      stdout: JSON.stringify({
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 999,
        },
      }),
    });
    expect(result.tokenUsage?.totalTokens).toBe(999);
    expect(result.tokenUsage?.source).toBe("generic-jsonl-scan");
  });

  it("generic scan treats an input-only object as a valid candidate (missing output = 0, R3)", async () => {
    // Frozen-spec R3: the semantic criterion is "input OR output". An object with
    // only an input count (no output) is still a valid candidate; the missing side
    // is resolved to 0. No new key mapping or aggregation algorithm is added.
    const result = await collectTokenUsage({
      executorKey: "does-not-exist",
      cwd,
      startedAt,
      endedAt,
      stdout: JSON.stringify({
        usage: { input_tokens: 40, cached_input_tokens: 12 },
      }),
    });
    expect(result.tokenUsage).toEqual({
      inputTokens: 40,
      outputTokens: 0,
      cachedInputTokens: 12,
      totalTokens: 40,
      source: "generic-jsonl-scan",
    });
  });

  it("generic scan treats an output-only object as a valid candidate (missing input = 0, R3)", async () => {
    const result = await collectTokenUsage({
      executorKey: "does-not-exist",
      cwd,
      startedAt,
      endedAt,
      stdout: JSON.stringify({
        usage: { output_tokens: 12, cached_input_tokens: 3 },
      }),
    });
    expect(result.tokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 12,
      cachedInputTokens: 3,
      totalTokens: 12,
      source: "generic-jsonl-scan",
    });
  });

  it("codex key falls back to generic-jsonl-scan when the codex-specific type is absent but nested usage is parseable (R1)", async () => {
    // L2 finding: codex-form stdout that does NOT satisfy the codex collector's
    // strict `type === "turn.completed"` / `usage` location must still be
    // recovered by the generic scan when it carries a parseable nested usage.
    // executorKey=codex therefore must NOT return unavailable here.
    const codexLikeStdout = JSON.stringify({
      type: "response",
      result: {
        usage: {
          input_tokens: 100,
          cached_input_tokens: 30,
          output_tokens: 20,
        },
      },
    });
    const result = await collectTokenUsage({
      executorKey: "codex",
      cwd,
      startedAt,
      endedAt,
      stdout: codexLikeStdout,
    });
    expect(result.tokenUsage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 30,
      totalTokens: 100 + 20,
      source: "generic-jsonl-scan",
    });
  });

  it("AtomCode custom path and generic scan agree on totalTokens for the same representative usage (R4 finder)", async () => {
    // Frozen-spec acceptance + L2 requirement 4: build ONE representative usage,
    // feed it to the custom AtomCode collector (via session .meta,
    // executorKey=executor) and to the generic scan (via stdout JSONL with a
    // non-existent key). Both must report the SAME totalTokens — the generic
    // fallback must not invent a second caliber. Cache-free so the two caliber
    // rules (custom: input+cached+output; generic: input+output) converge.
    const root = home();
    const atomDir = join(root, ".atomcode", "sessions", "session");
    mkdirSync(atomDir, { recursive: true });
    const representative = { input: 50, output: 10 };
    writeFileSync(
      join(atomDir, "session.meta"),
      JSON.stringify({
        name: "/tmp/coagenthub-ticket-01a04abc-def0-123",
        working_dir: cwd,
        created_at: Date.parse(startedAt),
        updated_at: Date.parse(endedAt),
        turn_stats: [{ model_usage: [{ tokens: representative }] }],
      }),
    );
    const custom = await collectTokenUsage({
      executorKey: "executor",
      taskId: "01a04abc-def0-1234-5678-90abcdef1234",
      cwd,
      startedAt,
      endedAt,
      homeDir: root,
    });
    const generic = await collectTokenUsage({
      executorKey: "no-such-executor-atomcode",
      cwd,
      startedAt,
      endedAt,
      stdout: JSON.stringify({ usage: representative }),
    });
    // Assert equality across both sides (not two independent constants) so a
    // drift on either path fails the test. Both resolve to 60.
    expect(custom.tokenUsage?.totalTokens).toBe(60);
    expect(generic.tokenUsage?.totalTokens).toBe(
      custom.tokenUsage?.totalTokens,
    );
    expect(generic.tokenUsage?.source).toBe("generic-jsonl-scan");
  });
});
