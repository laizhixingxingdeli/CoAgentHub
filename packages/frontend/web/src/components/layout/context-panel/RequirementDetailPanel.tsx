/**
 * 需求详情面板(UI-04b-1):选中的需求 = 顶部精细阶梯状态条 + 下方沟通记录
 * 时间线。未选中(requirement === null)时显示空态提示。
 *
 * 本票只交付组件本身;把它嵌进主从两栏布局(替换 tasks-tab 现在的临时并排)
 * 是 UI-04b-2 的范围。文案沿用同目录组件的现状(RequirementList 亦未接 i18n),
 * 不为这一票单独引入词典条目。
 */

import type { Requirement } from "./group-tasks-by-spec";
import RequirementStepper from "./RequirementStepper";
import RequirementTimeline from "./RequirementTimeline";

type RequirementDetailPanelProps = {
  /** 当前选中的需求(null = 未选中)。 */
  requirement: Requirement | null;
};

export default function RequirementDetailPanel({
  requirement,
}: RequirementDetailPanelProps) {
  if (!requirement) {
    return (
      <div
        data-testid="requirement-detail-empty"
        className="px-4 py-8 text-center text-sm text-muted-foreground"
      >
        选择左侧一个需求查看详情
      </div>
    );
  }
  return (
    <div
      data-testid="requirement-detail-panel"
      className="flex flex-col gap-2 px-4 py-3"
    >
      <p className="truncate text-sm font-medium">{requirement.label}</p>
      <RequirementStepper steps={requirement.steps} />
      <RequirementTimeline tasks={requirement.tasks} />
    </div>
  );
}
