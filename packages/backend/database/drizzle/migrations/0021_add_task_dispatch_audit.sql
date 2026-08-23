CREATE TABLE "task_dispatch_warning" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"recipient_participant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "dispatch_audit" jsonb;--> statement-breakpoint
ALTER TABLE "task_dispatch_warning" ADD CONSTRAINT "task_dispatch_warning_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dispatch_warning" ADD CONSTRAINT "task_dispatch_warning_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dispatch_warning" ADD CONSTRAINT "task_dispatch_warning_recipient_participant_id_participant_id_fk" FOREIGN KEY ("recipient_participant_id") REFERENCES "public"."participant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_dispatch_warning_recipient_participant_id_created_at_index" ON "task_dispatch_warning" USING btree ("recipient_participant_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "task_dispatch_warning_task_id_recipient_participant_id_index" ON "task_dispatch_warning" USING btree ("task_id","recipient_participant_id");
