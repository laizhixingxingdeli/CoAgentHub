-- R1/R2(specs/l3-request-delivery-and-scope.md):完成事件的投递对象由**载荷**
-- 决定,不再由下发者决定。
--
-- 收件人一律由**应用层**在任务落终态时裁定,并写入 task.recipient_participant_ids
-- (与 status 同一条 UPDATE,trigger 触发时即可见)。trigger 保持「哑」——只搬运
-- 该列,不查 group_members、不理解角色:角色语义留在应用层这一个权威源。
--
-- 未裁定的路径(队列完成 / 停止 / 控制回滚 / 孤儿收敛等)回落下发者,与既有
-- 行为逐字一致;R2 回填保证既有事件的归属也不变。
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "recipient_participant_ids" text[];--> statement-breakpoint
ALTER TABLE "task_completion_event" ADD COLUMN IF NOT EXISTS "recipient_participant_id" text;--> statement-breakpoint
-- R2 回填:既有事件的收件人 = 下发者,投递关系逐字不变。
UPDATE "task_completion_event"
SET "recipient_participant_id" = "dispatcher_participant_id"
WHERE "recipient_participant_id" IS NULL;--> statement-breakpoint
-- 群内多个 reviewer 时每人一条事件:唯一约束由 task_id 改为
-- (task_id, recipient_participant_id),去重粒度随之变为「每收件人一条」。
ALTER TABLE "task_completion_event"
  DROP CONSTRAINT IF EXISTS "task_completion_event_task_id_unique";--> statement-breakpoint
ALTER TABLE "task_completion_event"
  ADD CONSTRAINT "task_completion_event_task_id_recipient_participant_id_unique"
  UNIQUE("task_id","recipient_participant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_completion_event_recipient_participant_idx"
  ON "task_completion_event" USING btree ("recipient_participant_id");--> statement-breakpoint
-- trigger:仅搬运已裁定列。裁定为空 → 回落下发者(既有行为);同一收件人重复
-- 触发由唯一约束吸收(DO NOTHING),保持幂等。
CREATE OR REPLACE FUNCTION "trg_task_completion_event"() RETURNS trigger AS $$
DECLARE
  recipients text[];
BEGIN
  IF NEW.status IN ('done','failed','cancelled')
     AND OLD.status NOT IN ('done','failed','cancelled')
     AND NEW.dispatcher_participant_id IS NOT NULL THEN
    recipients := CASE
      WHEN coalesce(array_length(NEW.recipient_participant_ids, 1), 0) > 0
      THEN NEW.recipient_participant_ids
      ELSE ARRAY[NEW.dispatcher_participant_id]
    END;
    INSERT INTO "task_completion_event" (
      "task_id","group_id","recipient_participant_id","dispatcher_participant_id",
      "dispatcher_session_id","callback_ref","state","attempts"
    )
    SELECT NEW.id, NEW.group_id, r, NEW.dispatcher_participant_id,
           NEW.dispatcher_session_id, NEW.callback_ref, 'pending', 0
    FROM unnest(array_remove(recipients, NULL::text)) AS r
    ON CONFLICT ("task_id", "recipient_participant_id") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
