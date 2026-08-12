CREATE TABLE "executor_config" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"agent_name" text NOT NULL,
	"type" text NOT NULL,
	"kind" text DEFAULT 'cli' NOT NULL,
	"bin" text NOT NULL,
	"url" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "executor_config_key_unique" UNIQUE("key"),
	CONSTRAINT "executor_config_agent_name_unique" UNIQUE("agent_name")
);
