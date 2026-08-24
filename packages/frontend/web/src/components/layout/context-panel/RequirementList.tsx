/**
 * 简化版「需求列表」(UI-04a):一行一个需求,显示 label + 阶梯指示器(圆点 +
 * 连线,用 index.css 的 --status-* token 上色)+ 更新时间。点击一行切换选中态。
 *
 * 这是基础展示组件,不做完整主从布局 / 精细 SVG 阶梯图标(勾叉 / 呼吸动画)/
 * 右侧沟通详情面板 —— 那些是 UI-04b 的范围。当前选中态只用来做行内高亮,
 * 不驱动任何详情展示。
 *
 * 列表头部是「需求 / 修复」二态标签(requirement-list-kind-tabs spec R1/R3):
 * 每个标签显示计数;当前标签为空时显示空态但**不隐藏标签本身**;切换标签由
 * 上层把过滤后的可见列表传进来,本组件只负责展示。
 */

import { Fragment } from "react";
import { formatMessageTime } from "@/pages/app/groups/messages/lib";
import type { Requirement, StepStatus } from "./group-tasks-by-spec";
import type { RequirementKind } from "./requirement-kind";

/** 阶梯每步圆点的配色:done/failed/running 实心 / pending 空心(边框)。 */
const STEP_DOT_CLASS: Record<StepStatus, string> = {
  done: "bg-status-done",
  failed: "bg-status-failed",
  running: "bg-status-running",
  pending: "border border-muted-foreground/40",
};

const KIND_LABEL: Record<RequirementKind, string> = {
  requirement: "需求",
  fix: "修复",
};

type RequirementListProps = {
  /** 当前标签下可见的需求(已按 kind 过滤,由上层计算)。 */
  visibleRequirements: Requirement[];
  /** 两个标签各自的计数(null dispatchKind 计入「需求」)。 */
  kindCounts: Record<RequirementKind, number>;
  /** 当前选中的需求 id(null = 无选中)。 */
  selectedId: string | null;
  /** 当前激活的标签。 */
  kind: RequirementKind;
  /** 点击标签回调;切换后原选中若不在新列表,由上层回落为未选中。 */
  onKindChange: (kind: RequirementKind) => void;
  /** 点击一行时回调,传入该需求 id(null 仅用于上层清空选中)。 */
  onSelect: (id: string | null) => void;
};

export default function RequirementList({
  visibleRequirements,
  kindCounts,
  selectedId,
  kind,
  onKindChange,
  onSelect,
}: RequirementListProps) {
  return (
    <div className="flex flex-col">
      {/* 「需求 / 修复」二态切换:计数随全量需求变化,标签始终可见可点(R3)。 */}
      <div
        data-testid="requirement-kind-tabs"
        className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5"
      >
        {(Object.keys(KIND_LABEL) as RequirementKind[]).map((k) => {
          const active = kind === k;
          return (
            <button
              key={k}
              type="button"
              data-testid={`requirement-kind-tab-${k}`}
              data-active={active || undefined}
              onClick={() => onKindChange(k)}
              aria-pressed={active}
              className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                active
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
            >
              {KIND_LABEL[k]} ({kindCounts[k]})
            </button>
          );
        })}
      </div>
      {visibleRequirements.length === 0 ? (
        // 当前标签下没有内容:显示空态,不隐藏标签本身(R3)。
        <div
          data-testid="requirement-kind-empty"
          className="px-4 py-6 text-center text-sm text-muted-foreground"
        >
          暂无{KIND_LABEL[kind]}任务
        </div>
      ) : (
        <ul data-testid="requirement-list" className="flex flex-col border-b">
          {visibleRequirements.map((req) => {
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
      )}
    </div>
  );
}
