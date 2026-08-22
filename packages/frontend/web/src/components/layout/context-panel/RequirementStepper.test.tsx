import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RequirementStepper from "./RequirementStepper";

/** 取某一步的 SVG 图标节点(断言 SVG 画法而不是文本符号)。 */
function iconSvg(index: number): SVGSVGElement {
  const wrapper = screen.getByTestId(`requirement-stepper-icon-${index}`);
  const svg = wrapper.querySelector("svg");
  if (!svg) {
    throw new Error(`step ${index} has no svg icon`);
  }
  return svg as SVGSVGElement;
}

describe("RequirementStepper 精细阶梯状态条 (UI-04b-1)", () => {
  it("空 steps 不渲染任何内容", () => {
    const { container } = render(<RequirementStepper steps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("每一步渲染一个 SVG 图标 + 通用「步骤 N」标签", () => {
    render(<RequirementStepper steps={["done", "running", "pending"]} />);
    expect(screen.getByTestId("requirement-stepper")).toBeInTheDocument();
    expect(screen.getByText("步骤 1")).toBeInTheDocument();
    expect(screen.getByText("步骤 2")).toBeInTheDocument();
    expect(screen.getByText("步骤 3")).toBeInTheDocument();
    for (const i of [0, 1, 2]) {
      expect(iconSvg(i)).toBeInTheDocument();
    }
  });

  it("使用执行者与任务名标签,不暴露步骤编号", () => {
    render(
      <RequirementStepper
        steps={["done", "running"]}
        labels={["atomcode · 修复时间线", "协调者 · L2 验收"]}
      />,
    );
    expect(screen.getByText("atomcode · 修复时间线")).toBeInTheDocument();
    expect(screen.getByText("协调者 · L2 验收")).toBeInTheDocument();
    expect(screen.queryByText("步骤 1")).not.toBeInTheDocument();
  });

  it("完成态:实心圆(--status-done)+ 白色对勾 stroke path(圆头加粗)", () => {
    render(<RequirementStepper steps={["done"]} />);
    const svg = iconSvg(0);
    expect(svg.querySelector("circle")).toHaveAttribute(
      "fill",
      "var(--status-done)",
    );
    const check = svg.querySelector("path");
    expect(check).toHaveAttribute("stroke", "white");
    expect(check).toHaveAttribute("stroke-linecap", "round");
    expect(Number(check?.getAttribute("stroke-width"))).toBeGreaterThan(2);
    expect(check).toHaveAttribute("fill", "none");
  });

  it("失败态:圆比其他步骤放大一档 + 白色叉 + 失败色光晕外圈", () => {
    render(<RequirementStepper steps={["done", "failed"]} />);
    const doneIcon = screen.getByTestId("requirement-stepper-icon-0");
    const failedIcon = screen.getByTestId("requirement-stepper-icon-1");
    // 其他步骤 24px(size-6),失败步骤 32px(size-8)—— 视觉上更「重」。
    expect(doneIcon).toHaveClass("size-6");
    expect(failedIcon).toHaveClass("size-8");
    // 光晕:4px ring(box-shadow 实现),颜色引用 --status-failed token。
    expect(failedIcon).toHaveClass("ring-4");
    expect(failedIcon).toHaveClass("ring-status-failed/15");
    const svg = iconSvg(1);
    expect(svg.querySelector("circle")).toHaveAttribute(
      "fill",
      "var(--status-failed)",
    );
    expect(svg.querySelector("path")).toHaveAttribute("stroke", "white");
  });

  it("进行中态:青环 + 呼吸动画,且 prefers-reduced-motion 下关掉动画", () => {
    render(<RequirementStepper steps={["running"]} />);
    const icon = screen.getByTestId("requirement-stepper-icon-0");
    expect(icon).toHaveClass("animate-pulse");
    // motion-reduce:animate-none 编译为 @media (prefers-reduced-motion: reduce)
    // 下 animation: none。
    expect(icon).toHaveClass("motion-reduce:animate-none");
    expect(icon).toHaveClass("ring-status-running/25");
    const circle = iconSvg(0).querySelector("circle");
    expect(circle).toHaveAttribute("stroke", "var(--status-running)");
    expect(circle).toHaveAttribute("fill", "none");
  });

  it("待开始态:空心灰圈(--border 描边,背景透明),无动画", () => {
    render(<RequirementStepper steps={["pending"]} />);
    const icon = screen.getByTestId("requirement-stepper-icon-0");
    expect(icon).not.toHaveClass("animate-pulse");
    const circle = iconSvg(0).querySelector("circle");
    expect(circle).toHaveAttribute("stroke", "var(--border)");
    expect(circle).toHaveAttribute("fill", "none");
    expect(icon.querySelector("path")).toBeNull();
  });

  it("步骤下标与状态挂在 data-status 上,便于上层断言视觉分支", () => {
    render(
      <RequirementStepper steps={["done", "failed", "running", "pending"]} />,
    );
    expect(screen.getByTestId("requirement-stepper-step-0")).toHaveAttribute(
      "data-status",
      "done",
    );
    expect(screen.getByTestId("requirement-stepper-step-1")).toHaveAttribute(
      "data-status",
      "failed",
    );
    expect(screen.getByTestId("requirement-stepper-step-2")).toHaveAttribute(
      "data-status",
      "running",
    );
    expect(screen.getByTestId("requirement-stepper-step-3")).toHaveAttribute(
      "data-status",
      "pending",
    );
  });

  it("连接线:走过的段落用上一步状态色,未走到的用 --border 灰", () => {
    render(
      <RequirementStepper steps={["done", "running", "pending", "pending"]} />,
    );
    const first = screen.getByTestId("requirement-stepper-connector-1");
    expect(first).toHaveClass("bg-status-done");
    expect(first).toHaveAttribute("data-walked", "true");
    expect(screen.getByTestId("requirement-stepper-connector-2")).toHaveClass(
      "bg-status-running",
    );
    // 上一步是 pending → 尚未走到,用灰色且不标记 walked。
    const unwalked = screen.getByTestId("requirement-stepper-connector-3");
    expect(unwalked).toHaveClass("bg-border");
    expect(unwalked).not.toHaveAttribute("data-walked");
  });

  it("单步时不渲染连接线", () => {
    render(<RequirementStepper steps={["done"]} />);
    expect(
      screen.queryByTestId("requirement-stepper-connector-1"),
    ).not.toBeInTheDocument();
  });
});
