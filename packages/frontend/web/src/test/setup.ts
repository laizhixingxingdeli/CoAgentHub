import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom does not implement matchMedia — provide a controllable mock so
// useIsMobile / the shadcn sidebar can evaluate breakpoints in tests.
// NOTE: use Object.defineProperty, NOT vi.stubGlobal — test files call
// vi.unstubAllGlobals() in afterEach, which would revert this global.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  configurable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// jsdom lacks ResizeObserver (used by chat-message-list auto-scroll).
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, "ResizeObserver", {
  writable: true,
  configurable: true,
  value: ResizeObserverMock,
});

// jsdom lacks scrollTo on elements (used by useAutoScroll).
Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  writable: true,
  value: vi.fn(),
});

// jsdom does not implement requestAnimationFrame (used by useAutoScroll).
if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number;
}
if (typeof globalThis.cancelAnimationFrame !== "function") {
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
}

// Unmount rendered trees after each test.
afterEach(() => {
  cleanup();
});
