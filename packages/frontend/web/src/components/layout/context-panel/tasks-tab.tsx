import { RequirementWorkspace } from "./requirement-workspace";

/**
 * 右栏「任务」Tab:需求工作区(RequirementWorkspace)的窄列容器 —— 左列
 * 需求列表取窄列(w-28),其余行为与群内页主区完全一致(共享同一组件)。
 */
export function TasksTab({ groupId }: { groupId: string }) {
  return (
    <div data-testid="tasks-tab" className="flex h-full min-h-0 flex-col">
      <RequirementWorkspace groupId={groupId} listClassName="w-28 shrink-0" />
    </div>
  );
}
