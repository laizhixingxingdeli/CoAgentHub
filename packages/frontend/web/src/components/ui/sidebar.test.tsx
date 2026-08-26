import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SidebarInset, SidebarProvider } from "./sidebar";

describe("SidebarInset layout", () => {
  it("uses the remaining flex width instead of forcing the viewport width", () => {
    render(
      <SidebarProvider>
        <SidebarInset data-testid="sidebar-inset" />
      </SidebarProvider>,
    );

    const inset = screen.getByTestId("sidebar-inset");
    expect(inset).toHaveClass("flex-1", "min-w-0");
    expect(inset).not.toHaveClass("w-full");
  });
});
