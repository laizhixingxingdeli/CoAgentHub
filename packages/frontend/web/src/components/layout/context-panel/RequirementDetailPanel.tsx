/**
 * 需求详情面板(UI-04b-1):选中的需求 = 顶部精细阶梯状态条 + 下方沟通记录
 * 时间线。未选中(requirement === null)时显示空态提示。
 *
 * 时间线从 UI-04b-1 升级起消费「消息 + 任务」合并流:父级(TasksTab)把群
 * 消息与成员传进来,RequirementTimeline 据此渲染消息卡片(谁发给谁)与任务
 * 汇报卡片(归属规则见 merge-requirement-timeline.ts 的启发式注释)。
 *
 * 文案沿用同目录组件的现状(RequirementList 亦未接 i18n),不为这一票单独
 * 引入词典条目。
 */

import type { Member, MessageItem } from "@/pages/app/groups/messages/types";
import type { Requirement } from "./group-tasks-by-spec";
import RequirementStepper from "./RequirementStepper";
import RequirementTimeline from "./RequirementTimeline";

type RequirementDetailPanelProps = {
  /** 当前选中的需求(null = 未选中)。 */
  requirement: Requirement | null;
  /** 该群全部消息(时间线消息卡片数据源)。 */
  messages: MessageItem[];
  /** 该群成员(真实角色数据源)。 */
  members: Member[];
};

export default function RequirementDetailPanel({
  requirement,
  messages,
  members,
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
      <RequirementTimeline
        tasks={requirement.tasks}
        messages={messages}
        members={members}
      />
    </div>
  );
}
