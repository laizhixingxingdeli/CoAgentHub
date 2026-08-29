ALTER TABLE "executor_config" ADD COLUMN "max_concurrency" integer;
ALTER TABLE "executor_config" ADD COLUMN "input_mode" text;
ALTER TABLE "executor_config" ADD COLUMN "env" jsonb;
ALTER TABLE "executor_config" ADD COLUMN "output_profile" jsonb;
