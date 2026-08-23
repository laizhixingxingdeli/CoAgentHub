ALTER TABLE "task" ADD COLUMN "parent_task_id" uuid;
ALTER TABLE "task" ADD CONSTRAINT "task_parent_task_id_task_id_fk"
  FOREIGN KEY ("parent_task_id") REFERENCES "task"("id");
CREATE INDEX "task_parent_task_id_index" ON "task" USING btree ("parent_task_id");
