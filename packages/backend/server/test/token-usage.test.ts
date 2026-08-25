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
  it("reads Codex token_count from --json stdout and extracts the final report", async () => {
    const result = await collectTokenUsage({
      executorKey: "codex",
      cwd,
      startedAt,
      endedAt,
      stdout: [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 40,
                output_tokens: 20,
                total_tokens: 120,
              },
            },
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
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 40,
        totalTokens: 120,
        source: "codex-stdout-jsonl",
      },
    });
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

  it("uses explicit unsupported/unavailable reasons and never guesses", async () => {
    await expect(
      collectTokenUsage({
        executorKey: "reasonix",
        cwd,
        startedAt,
        endedAt,
        homeDir: home(),
      }),
    ).resolves.toEqual({ tokenUsage: null, reason: "unsupported" });
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
});
