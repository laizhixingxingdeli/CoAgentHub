CREATE TABLE "agent" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"device" text,
	"token_hash" text NOT NULL,
	"webhook_url" text,
	"last_seen" timestamp with time zone,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"roles" text[] NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_group_id_agent_id_pk" PRIMARY KEY("group_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "group_message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"parent_id" uuid,
	"audience" text DEFAULT 'broadcast' NOT NULL,
	"audience_ref" text,
	"body" text NOT NULL,
	"content_type" text DEFAULT 'text/plain' NOT NULL,
	"file_ref" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "group_message_closure" (
	"group_id" uuid NOT NULL,
	"ancestor_id" uuid NOT NULL,
	"descendant_id" uuid NOT NULL,
	"depth" integer NOT NULL,
	CONSTRAINT "group_message_closure_ancestor_id_descendant_id_pk" PRIMARY KEY("ancestor_id","descendant_id")
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"executor_agent_id" uuid NOT NULL,
	"executor_key" text,
	"status" text DEFAULT 'running' NOT NULL,
	"checkpoint_ref" text,
	"diff_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "task_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_created_by_agent_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_message" ADD CONSTRAINT "group_message_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_message" ADD CONSTRAINT "group_message_sender_id_agent_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_message" ADD CONSTRAINT "group_message_parent_id_group_message_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."group_message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_message_closure" ADD CONSTRAINT "group_message_closure_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_message_closure" ADD CONSTRAINT "group_message_closure_ancestor_id_group_message_id_fk" FOREIGN KEY ("ancestor_id") REFERENCES "public"."group_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_message_closure" ADD CONSTRAINT "group_message_closure_descendant_id_group_message_id_fk" FOREIGN KEY ("descendant_id") REFERENCES "public"."group_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_executor_agent_id_agent_id_fk" FOREIGN KEY ("executor_agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_message_closure_group_id_index" ON "group_message_closure" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "group_message_closure_ancestor_id_index" ON "group_message_closure" USING btree ("ancestor_id");--> statement-breakpoint
CREATE INDEX "group_message_closure_descendant_id_index" ON "group_message_closure" USING btree ("descendant_id");