-- Seed the legacy built-in executors into executor_config (spec §3 R2, ADR-0008).
--
-- executor_config becomes the single source of truth: the code-side
-- DEFAULT_EXECUTORS array is deleted in the same change. 6 rows are seeded,
-- each carrying the current built-in values verbatim (including
-- max_concurrency for executor/codex). The `reviewer` entry is NOT migrated
-- (spec §3 R3 removes it; its participant cleanup is a separate ticket).
--
-- Idempotency: ON CONFLICT (key) DO NOTHING — re-running the migration on an
-- existing install must not duplicate rows nor overwrite user-edited rows.
--
-- win-hermes carries NO token: its a2a token is read from the
-- COAGENTHUB_WIN_A2A_TOKEN environment variable at runtime (same as today),
-- never persisted to the DB. Only the gateway url is stored.
INSERT INTO "executor_config" (
  "id", "key", "agent_name", "type", "kind", "bin", "url", "args", "label",
  "model", "memory", "max_concurrency"
) VALUES
  (
    "uuid_generate_v7"(), 'executor', 'AtomCode', 'participant', 'cli', 'atomcode', NULL,
    '["-y","-v","-p","{ticket}"]'::jsonb, 'atomcode', NULL, NULL, 1
  ),
  (
    "uuid_generate_v7"(), 'reasonix', 'Reasoning', 'participant', 'cli', 'reasonix', NULL,
    '["run","-y","--model","{model}","{ticket}"]'::jsonb, 'reasonix', 'deepseek-v4-flash', NULL, NULL
  ),
  (
    "uuid_generate_v7"(), 'codebuddy', 'CodeBuddy', 'participant', 'cli', 'codebuddy', NULL,
    '["-y","-p","{ticket}","--output-format","stream-json"]'::jsonb, 'codebuddy', NULL, NULL, NULL
  ),
  (
    "uuid_generate_v7"(), 'codex', 'Codex', 'participant', 'cli', 'codex', NULL,
    '["exec","--approve-for-me","--ephemeral","--json","-c","sandbox_workspace_write.network_access=true","{ticket}"]'::jsonb,
    'codex', NULL, NULL, 1
  ),
  (
    "uuid_generate_v7"(), 'hermes', 'Hermes', 'hermes', 'cli', 'hermes', NULL,
    '["-z","{ticketContent}"]'::jsonb, 'hermes', NULL, NULL, NULL
  ),
  (
    "uuid_generate_v7"(), 'win-hermes', 'Win Hermes', 'hermes', 'a2a', 'win-hermes',
    'http://192.168.31.180:9900/', '[]'::jsonb, 'win-hermes', NULL, 'per-group', NULL
  )
ON CONFLICT ("key") DO NOTHING;
