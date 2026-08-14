import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

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

// i18n: 测试默认断言中文文案,固定语言为 zh(jsdom navigator.language 是 en-US)。
// 使用 Object.defineProperty 而非 localStorage.setItem:测试文件可能清理
// localStorage,且部分用例会显式测语言切换(设置 coagenthub.lang)。
beforeEach(() => {
  try {
    localStorage.setItem("coagenthub.lang", "zh");
  } catch {
    // localStorage 不可用时忽略(jsdom 一般可用)
  }
});
