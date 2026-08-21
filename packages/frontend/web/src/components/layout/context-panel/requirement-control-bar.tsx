/**
 * 需求详情控制条(UI-04b-2):master-detail 右栏顶部一小条,独立于
 * RequirementDetailPanel(展示只读),承载「停止 / 回滚」控制。复用 TaskPanel
 * 抽出的共享 ControlButton + 同款 canStop/canRollback 判定,行为与此前一致:
 * 点停止/回滚 = 发一条 broadcast 命令消息(由父组件 sendCommand/handleRollback
 * 落地),发送中/回滚中/已恢复态同步。
 *
 * 控制目标取当前选中需求的全部任务(每条一个控制行)—— 保留此前提到的「每个任务
 * 独立停止/回滚」能力;历史任务同样可在此操作(其执行记录已在下方
 * RequirementTimeline 展示)。无选中需求或该需求无任务时渲染空。
 */
import type { ReactElement } from "react";
import { t } from "@/lib/i18n";
import { ControlButton } from "@/pages/app/groups/messages/control-button";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
import type { Requirement } from "./group-tasks-by-spec";

type RequirementControlBarProps = {
  /** 当前选中需求(null = 未选中)。 */
  requirement: Requirement | null;
  /** 是否有 coordinator/human 权限:false 时停止/回滚禁用。 */
  canControl: boolean;
  /** 归档/软删群只读:即使有控制权限,停止/回滚也禁用并提示。 */
  readOnly: boolean;
  /** 正在发送命令的任务 id(null = 空闲),驱动按钮的「发送中…」。 */
  commandSending: string | null;
  /** 回滚状态(taskId → rolling=回滚中… | done=已恢复)。 */
  rollbackStates: Record<string, "rolling" | "done">;
  onStop: (task: TaskItem) => void;
  onRollback: (task: TaskItem) => void;
};

export function RequirementControlBar({
  requirement,
  canControl,
  readOnly,
  commandSending,
  rollbackStates,
  onStop,
  onRollback,
}: RequirementControlBarProps): ReactElement | null {
  if (!requirement || requirement.tasks.length === 0) {
    return null;
  }
  return (
    <div
      data-testid="requirement-control-bar"
      className="flex shrink-0 flex-col gap-1 border-b px-4 py-2"
    >
      <span className="text-xs font-medium">{requirement.label} · 控制</span>
      {requirement.tasks.map((task) => {
        const busy = commandSending === task.id;
        // 与 TaskPanel 同款判定:queued/running 可停止;done/failed 且带 checkpoint
        // 可回滚。保证行为一致。
        const canStop = task.status === "queued" || task.status === "running";
        const canRollback =
          (task.status === "done" || task.status === "failed") &&
          Boolean(task.checkpointRef);
        const rollbackState = rollbackStates[task.id];
        const rolling = rollbackState === "rolling";
        const rollbackDone = rollbackState === "done";
        return (
          <div
            key={task.id}
            data-testid={`requirement-control-row-${task.id}`}
            className="flex items-center gap-2"
          >
            <span className="flex-1 truncate text-xs text-muted-foreground">
              {task.executorKey ?? task.id}
            </span>
            <span className="flex shrink-0 gap-1.5">
              {canStop && (
                <ControlButton
                  size="sm"
                  variant="outline"
                  data-testid={`task-stop-${task.id}`}
                  disabled={busy}
                  canControl={canControl}
                  readOnly={readOnly}
                  onClick={() => onStop(task)}
                >
                  {busy ? t("common.sending") : t("tasks.stop")}
                </ControlButton>
              )}
              {canRollback && (
                <ControlButton
                  size="sm"
                  variant="outline"
                  data-testid={`task-rollback-${task.id}`}
                  disabled={busy || rolling || rollbackDone}
                  canControl={canControl}
                  readOnly={readOnly}
                  onClick={() => onRollback(task)}
                >
                  {rolling
                    ? t("tasks.rollbacking")
                    : rollbackDone
                      ? t("tasks.rollbackDone")
                      : t("tasks.rollback")}
                </ControlButton>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
