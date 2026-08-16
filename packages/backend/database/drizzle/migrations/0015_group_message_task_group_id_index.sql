CREATE INDEX "group_message_group_id_index" ON "group_message" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "task_group_id_index" ON "task" USING btree ("group_id");
