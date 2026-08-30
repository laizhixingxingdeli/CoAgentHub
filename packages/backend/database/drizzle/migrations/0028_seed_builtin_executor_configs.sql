-- Seed the legacy built-in executors into executor_config (spec §3 R2, ADR-0008).
--
-- executor_config becomes the single source of truth: the code-side
-- DEFAULT_EXECUTORS array is deleted in the same change. 6 rows are seeded,
-- each carrying the current built-in values verbatim (including
-- max_concurrency for executor/codex). The `reviewer` entry is NOT migrated
-- (spec §3 R3 removes it): reviewer is a role, not an executor — it must not
-- appear in executor_config at all.
--
-- R3 also clears any stale participant.executor_key = 'reviewer' binding left
-- over from the pre-config era (when reviewer was registered as a fake
-- built-in executor), so no participant points at a non-existent config.
--
-- Idempotency: ON CONFLICT (key) DO NOTHING — re-running the migration on an
-- existing install must not duplicate rows nor overwrite user-edited rows; the
-- UPDATE below only touches rows that still carry executor_key = 'reviewer',
-- so a second run is a no-op.
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

-- R3:reviewer 不再是执行器配置——清掉指向不存在配置的悬空绑定。
-- 幂等:仅命中 executor_key = 'reviewer' 的行,重复执行是 no-op。
UPDATE "participant" SET "executor_key" = NULL WHERE "executor_key" = 'reviewer';
