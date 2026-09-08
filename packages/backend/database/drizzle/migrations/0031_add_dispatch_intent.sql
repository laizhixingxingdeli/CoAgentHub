-- specs/persist-dispatch-intent-with-the-message.md R1–R5:
-- Durable dispatch intent written in the same transaction as the group message.
-- Intent ≠ task: records "should dispatch" (or permanent reject) so a crash
-- between message commit and task create is recoverable without scanning
-- historical messages to guess.
--
-- Historical messages are NOT backfilled — only new directed posts write intents.
CREATE TABLE IF NOT EXISTS "dispatch_intent" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"audience" text NOT NULL,
	"audience_ref" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reject_reason" text,
	"resolved_participant_id" uuid,
	"task_id" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"stall_alerted" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "dispatch_intent_message_id_unique" UNIQUE("message_id")
);--> statement-breakpoint
ALTER TABLE "dispatch_intent" ADD CONSTRAINT "dispatch_intent_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_intent" ADD CONSTRAINT "dispatch_intent_message_id_group_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."group_message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_intent" ADD CONSTRAINT "dispatch_intent_resolved_participant_id_participant_id_fk" FOREIGN KEY ("resolved_participant_id") REFERENCES "public"."participant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_intent" ADD CONSTRAINT "dispatch_intent_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dispatch_intent_status_created_at_idx" ON "dispatch_intent" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dispatch_intent_group_id_idx" ON "dispatch_intent" USING btree ("group_id");
