ALTER TABLE "task" ADD COLUMN "supersedes_task_id" uuid;
ALTER TABLE "task" ADD CONSTRAINT "task_supersedes_task_id_task_id_fk"
  FOREIGN KEY ("supersedes_task_id") REFERENCES "task"("id");
