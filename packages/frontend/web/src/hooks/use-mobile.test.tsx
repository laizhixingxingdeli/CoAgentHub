import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsMobile } from "./use-mobile";

function Probe() {
  const isMobile = useIsMobile();
  return <div data-testid="probe">{isMobile ? "mobile" : "desktop"}</div>;
}

/** Controllable matchMedia mock that captures the change listener. */
function mockMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_type: string, cb: () => void) => {
        listeners.add(cb);
      },
      removeEventListener: (_type: string, cb: () => void) => {
        listeners.delete(cb);
      },
      dispatchEvent: vi.fn(),
    })),
  });
  return {
    setMatches(value: boolean) {
      matches = value;
      for (const cb of listeners) cb();
    },
  };
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Restore a sane default viewport for other tests.
  delete (window as { innerWidth?: number }).innerWidth;
});

describe("useIsMobile 双端断点", () => {
  it("移动端视口(<768px)判定为 mobile", async () => {
    mockMatchMedia(true);
    setViewport(375);
    render(<Probe />);
    expect(await screen.findByTestId("probe")).toHaveTextContent("mobile");
  });

  it("桌面视口(≥768px)判定为 desktop", async () => {
    mockMatchMedia(false);
    setViewport(1024);
    render(<Probe />);
    expect(await screen.findByTestId("probe")).toHaveTextContent("desktop");
  });

  it("matchMedia change 事件触发后重新判定", () => {
    const mql = mockMatchMedia(true);
    setViewport(375);
    render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("mobile");

    // Simulate the viewport crossing the breakpoint: width grows and the
    // media query flips, which fires the registered change listener.
    setViewport(1024);
    act(() => mql.setMatches(false));

    expect(screen.getByTestId("probe")).toHaveTextContent("desktop");
  });
});
