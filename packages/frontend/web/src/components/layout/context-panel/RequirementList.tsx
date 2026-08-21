/**
 * 简化版「需求列表」(UI-04a):一行一个需求,显示 label + 阶梯指示器(圆点 +
 * 连线,用 index.css 的 --status-* token 上色)+ 更新时间。点击一行切换选中态。
 *
 * 这是基础展示组件,不做完整主从布局 / 精细 SVG 阶梯图标(勾叉 / 呼吸动画)/
 * 右侧沟通详情面板 —— 那些是 UI-04b 的范围。当前选中态只用来做行内高亮,
 * 不驱动任何详情展示。
 */

import { Fragment } from "react";
import type { Requirement, StepStatus } from "./group-tasks-by-spec";
import { formatMessageTime } from "@/pages/app/groups/messages/lib";

/** 阶梯每步圆点的配色:done/failed/running 实心 / pending 空心(边框)。 */
const STEP_DOT_CLASS: Record<StepStatus, string> = {
  done: "bg-status-done",
  failed: "bg-status-failed",
  running: "bg-status-running",
  pending: "border border-muted-foreground/40",
};

type RequirementListProps = {
  requirements: Requirement[];
  /** 当前选中的需求 id(null = 无选中)。 */
  selectedId: string | null;
  /** 点击一行时回调,传入该需求 id。 */
  onSelect: (id: string) => void;
};

export default function RequirementList({
  requirements,
  selectedId,
  onSelect,
}: RequirementListProps) {
  if (requirements.length === 0) {
    return null;
  }
  return (
    <ul
      data-testid="requirement-list"
      className="flex flex-col border-b"
    >
      {requirements.map((req) => {
        const selected = selectedId === req.id;
        return (
          <li key={req.id}>
            <button
              type="button"
              data-testid={`requirement-row-${req.id}`}
              data-selected={selected || undefined}
              onClick={() => onSelect(req.id)}
              className={`flex w-full flex-col gap-1 px-3 py-2 text-left transition-colors ${
                selected ? "bg-muted" : "hover:bg-muted/50"
              }`}
            >
              <span className="flex items-center gap-2">
                <span className="flex-1 truncate text-sm font-medium">
                  {req.label}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {req.updatedAt ? formatMessageTime(req.updatedAt) : ""}
                </span>
              </span>
              {/* 简化阶梯:圆点 + 连线(● ─ ● ─ ○),颜色按 step 状态上 token。 */}
              <span
                data-testid={`requirement-steps-${req.id}`}
                className="flex items-center gap-1"
              >
                {req.steps.map((step, i) => (
                  <Fragment key={i}>
                    {i > 0 && (
                      <span className="h-px w-3 bg-muted-foreground/40" />
                    )}
                    <span
                      data-testid={`requirement-step-${req.id}-${i}`}
                      data-status={step}
                      className={`size-2 rounded-full ${STEP_DOT_CLASS[step]}`}
                    />
                  </Fragment>
                ))}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
