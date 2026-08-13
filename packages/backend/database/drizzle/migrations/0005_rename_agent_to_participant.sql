ALTER TABLE "agent" RENAME TO "participant";
--> statement-breakpoint
ALTER TABLE "participant" RENAME CONSTRAINT "agent_pkey" TO "participant_pkey";
--> statement-breakpoint
ALTER TABLE "group_members" RENAME COLUMN "agent_id" TO "participant_id";
--> statement-breakpoint
ALTER TABLE "group_members" RENAME CONSTRAINT "group_members_group_id_agent_id_pk" TO "group_members_group_id_participant_id_pk";
--> statement-breakpoint
ALTER TABLE "group_members" RENAME CONSTRAINT "group_members_agent_id_agent_id_fk" TO "group_members_participant_id_participant_id_fk";
--> statement-breakpoint
ALTER TABLE "groups" RENAME CONSTRAINT "groups_created_by_agent_id_fk" TO "groups_created_by_participant_id_fk";
--> statement-breakpoint
ALTER TABLE "group_message" RENAME CONSTRAINT "group_message_sender_id_agent_id_fk" TO "group_message_sender_id_participant_id_fk";
--> statement-breakpoint
ALTER TABLE "task" RENAME COLUMN "executor_agent_id" TO "executor_participant_id";
--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "task_executor_agent_id_agent_id_fk" TO "task_executor_participant_id_participant_id_fk";
--> statement-breakpoint
UPDATE "group_message" SET "audience" = 'participant' WHERE "audience" = 'agent';
