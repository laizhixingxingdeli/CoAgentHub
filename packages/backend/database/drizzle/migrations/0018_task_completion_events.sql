-- Durable Task Completion Events (specs/durable-task-completion-events.md)
-- 1) callbackRef JSONB on task
ALTER TABLE "task" ADD COLUMN "callback_ref" jsonb;--> statement-breakpoint
-- 2) uuidv7 generator for event IDs (PGlite/Postgres, no pgcrypto dependency)
CREATE OR REPLACE FUNCTION "uuid_generate_v7"() RETURNS uuid AS $$
DECLARE
  ts_hex text;
  rand_hex text;
  uuid_hex text;
BEGIN
  ts_hex := lpad(to_hex((floor(extract(epoch from clock_timestamp()) * 1000))::bigint), 12, '0');
  rand_hex := substring(md5(random()::text || clock_timestamp()::text) from 1 for 8) ||
              substring(md5(random()::text || random()::text) from 1 for 8) ||
              substring(md5(clock_timestamp()::text) from 1 for 4);
  uuid_hex := ts_hex || rand_hex;
  uuid_hex := overlay(uuid_hex placing '7' from 13 for 1);
  uuid_hex := overlay(uuid_hex placing '8' from 17 for 1);
  RETURN uuid_hex::uuid;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- 3) task_completion_event table
CREATE TABLE "task_completion_event" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT "uuid_generate_v7"(),
  "task_id" uuid NOT NULL,
  "group_id" uuid NOT NULL,
  "dispatcher_participant_id" text,
  "dispatcher_session_id" text,
  "callback_ref" jsonb,
  "state" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone,
  CONSTRAINT "task_completion_event_task_id_unique" UNIQUE("task_id"),
  CONSTRAINT "task_completion_event_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX "task_completion_event_state_idx" ON "task_completion_event" USING btree ("state");--> statement-breakpoint
CREATE INDEX "task_completion_event_dispatcher_participant_idx" ON "task_completion_event" USING btree ("dispatcher_participant_id");--> statement-breakpoint
CREATE INDEX "task_completion_event_next_attempt_at_idx" ON "task_completion_event" USING btree ("next_attempt_at");--> statement-breakpoint
-- 4) Trigger: first transition from non-terminal -> terminal creates one event.
--    The task_id UNIQUE constraint makes concurrent/repeat fires idempotent.
CREATE OR REPLACE FUNCTION "trg_task_completion_event"() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('done','failed','cancelled')
     AND OLD.status NOT IN ('done','failed','cancelled')
     AND NEW.dispatcher_participant_id IS NOT NULL THEN
    INSERT INTO "task_completion_event" (
      "task_id","group_id","dispatcher_participant_id","dispatcher_session_id",
      "callback_ref","state","attempts"
    ) VALUES (
      NEW.id, NEW.group_id, NEW.dispatcher_participant_id, NEW.dispatcher_session_id,
      NEW.callback_ref, 'pending', 0
    )
    ON CONFLICT ("task_id") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "task_completion_event_trigger"
  AFTER UPDATE ON "task"
  FOR EACH ROW
  EXECUTE FUNCTION "trg_task_completion_event"();
