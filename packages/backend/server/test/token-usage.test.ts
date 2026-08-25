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
        created_at: Date.parse(startedAt),
        updated_at: Date.parse(endedAt),
        turn_stats: [{ tokens: { input: 50, output: 10, cached_input: 5 } }],
      }),
    );
    const atom = await collectTokenUsage({
      executorKey: "executor",
      cwd,
      startedAt,
      endedAt,
      homeDir: root,
    });
    expect(atom.tokenUsage?.source).toBe("atomcode-session-meta");
    expect(atom.tokenUsage?.totalTokens).toBe(65);

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
