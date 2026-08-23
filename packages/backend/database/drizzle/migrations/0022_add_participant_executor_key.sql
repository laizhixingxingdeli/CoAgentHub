ALTER TABLE "participant" ADD COLUMN "executor_key" text;
--> statement-breakpoint
UPDATE "participant" AS p
SET "executor_key" = e."key"
FROM "executor_config" AS e
WHERE p."name" = e."agent_name";
--> statement-breakpoint
UPDATE "participant" SET "executor_key" = 'executor' WHERE "name" = 'AtomCode 执行器' AND "executor_key" IS NULL;
--> statement-breakpoint
UPDATE "participant" SET "executor_key" = 'reasonix' WHERE "name" = 'Reasoning 执行器' AND "executor_key" IS NULL;
--> statement-breakpoint
UPDATE "participant" SET "executor_key" = 'codebuddy' WHERE "name" = 'CodeBuddy 执行器' AND "executor_key" IS NULL;
--> statement-breakpoint
UPDATE "participant" SET "executor_key" = 'codex' WHERE "name" = 'Codex 执行器' AND "executor_key" IS NULL;
--> statement-breakpoint
UPDATE "participant" SET "executor_key" = 'reviewer' WHERE "name" = 'Reviewer 检视器' AND "executor_key" IS NULL;
--> statement-breakpoint
UPDATE "participant" SET "executor_key" = 'hermes' WHERE "name" = 'Hermes 规划' AND "executor_key" IS NULL;
--> statement-breakpoint
UPDATE "participant" SET "executor_key" = 'win-hermes' WHERE "name" = 'Win Hermes' AND "executor_key" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "participant_executor_key_unique" ON "participant" USING btree ("executor_key") WHERE "executor_key" IS NOT NULL;
