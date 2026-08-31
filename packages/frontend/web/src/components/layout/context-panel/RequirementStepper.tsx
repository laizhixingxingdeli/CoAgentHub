/**
 * 精细阶梯状态条:把一条需求的固定三层 `steps` 画成
 * 「圆形图标 + 连接线 + 步骤标签」的横向阶梯。四种状态的图标全部用 SVG 绘制
 * (勾 / 叉 / 环),不用 emoji 或 unicode 符号:
 *
 *  - done    实心圆 + 白色对勾(stroke path,圆头加粗),底色 --status-done
 *  - failed  比其他步骤放大一档(32px vs 24px)的实心圆 + 白色叉,外圈 4px
 *            失败色光晕(Tailwind ring = box-shadow;透明度用 /15 修饰符,
 *            由 Tailwind 编译成 color-mix,不写 oklch(from …) 相对色语法)
 *  - running 青色空心环 + 呼吸动画(animate-pulse 的 opacity @keyframes);
 *            `motion-reduce:animate-none` 编译为 @media (prefers-reduced-motion:
 *            reduce) 下 animation: none,即减少动效偏好时静止
 *  - pending 空心灰圈(--border 描边,背景透明)
 *  - na-* 中性实心圈 + 横杠,与 pending 的未开始灰圈视觉区分
 *
 * 颜色全部走 index.css 注册的 --status-* token,不硬编码色值。
 * 状态仍由上层计算;本组件只负责把执行者与任务标题绘制成紧凑标签。
 */

import { Fragment } from "react";
import { RoleBadge } from "@/pages/app/groups/messages/types";
import type { StepStatus } from "./group-tasks-by-spec";

/** 图标外圈:尺寸 + 光晕 / 呼吸动画(失败态视觉上比其他步骤更「重」)。 */
const STEP_WRAPPER_CLASS: Record<StepStatus, string> = {
  done: "size-6",
  failed: "size-8 ring-4 ring-status-failed/15",
  running:
    "size-6 ring-4 ring-status-running/25 animate-pulse motion-reduce:animate-none",
  pending: "size-6",
  "na-declared": "size-6",
  "na-no-reviewer": "size-6",
};

/** 连接线配色:上一步走过了就用它的状态色,没走到用 --border 灰。 */
const CONNECTOR_CLASS: Record<StepStatus, string> = {
  done: "bg-status-done",
  failed: "bg-status-failed",
  running: "bg-status-running",
  pending: "bg-border",
  "na-declared": "bg-border",
  "na-no-reviewer": "bg-border",
};

/** 白色勾/叉的描边宽度(加粗 + 圆头,小尺寸下也清晰)。 */
const MARK_STROKE_WIDTH = 2.6;

/** 单步图标(纯 SVG):done 勾 / failed 叉 / running 青环 / pending 灰圈。 */
function StepIcon({ status }: { status: StepStatus }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className="size-full"
    >
      {status === "done" && (
        <>
          <circle cx="12" cy="12" r="12" fill="var(--status-done)" />
          <path
            d="M7 12.4 L10.4 15.8 L17 8.8"
            fill="none"
            stroke="white"
            strokeWidth={MARK_STROKE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {status === "failed" && (
        <>
          <circle cx="12" cy="12" r="12" fill="var(--status-failed)" />
          <path
            d="M8.4 8.4 L15.6 15.6 M15.6 8.4 L8.4 15.6"
            fill="none"
            stroke="white"
            strokeWidth={MARK_STROKE_WIDTH}
            strokeLinecap="round"
          />
        </>
      )}
      {status === "running" && (
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke="var(--status-running)"
          strokeWidth={3}
        />
      )}
      {status === "pending" && (
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke="var(--border)"
          strokeWidth={2}
        />
      )}
      {(status === "na-declared" || status === "na-no-reviewer") && (
        <>
          <circle
            cx="12"
            cy="12"
            r="10"
            fill="var(--muted)"
            stroke="var(--muted-foreground)"
            strokeWidth={2}
          />
          <path
            d="M8 12 H16"
            fill="none"
            stroke="var(--muted-foreground)"
            strokeWidth={2}
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}

type RequirementStepperProps = {
  /** 每步状态,直接消费,不在这里重算。 */
  steps: StepStatus[];
  /** 面向人的「执行者 · 任务名」标签;缺省保持旧调用方兼容。 */
  labels?: string[];
  /** 每步对应的真实群内角色;仅用于可访问的文字徽章。 */
  stepRoles?: Array<string | null>;
};

export default function RequirementStepper({
  steps,
  labels = [],
  stepRoles = [],
}: RequirementStepperProps) {
  if (steps.length === 0) {
    return null;
  }
  return (
    <ol
      data-testid="requirement-stepper"
      className="flex items-start px-1 py-2"
    >
      {steps.map((step, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 阶梯步骤只有层级位置身份
        <Fragment key={i}>
          {i > 0 && (
            // 连接线纵向对齐 32px 图标行的中心(mt-4);颜色取上一步状态。
            <span
              data-testid={`requirement-stepper-connector-${i}`}
              data-walked={steps[i - 1] !== "pending" || undefined}
              className={`mt-4 h-0.5 min-w-4 flex-1 rounded-full ${
                CONNECTOR_CLASS[steps[i - 1]]
              }`}
            />
          )}
          <li
            data-testid={`requirement-stepper-step-${i}`}
            data-status={step}
            className="flex shrink-0 flex-col items-center gap-1"
          >
            {/* 固定 32px 高的图标行:failed 放大到 32px 时其余步骤仍居中对齐。 */}
            <span className="flex h-8 items-center justify-center">
              <span
                data-testid={`requirement-stepper-icon-${i}`}
                className={`inline-flex items-center justify-center rounded-full ${STEP_WRAPPER_CLASS[step]}`}
              >
                <StepIcon status={step} />
              </span>
            </span>
            <span className="flex max-w-40 items-center gap-1 truncate text-[11px] leading-none text-muted-foreground">
              {stepRoles[i] && <RoleBadge role={stepRoles[i]} />}
              <span className="truncate" title={labels[i] ?? `步骤 ${i + 1}`}>
                {labels[i] ?? `步骤 ${i + 1}`}
              </span>
            </span>
          </li>
        </Fragment>
      ))}
    </ol>
  );
}
