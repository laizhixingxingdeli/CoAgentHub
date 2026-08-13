import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetNotificationState,
  FILE_MESSAGE_PLACEHOLDER,
  maybeNotifyGroupMessage,
  NOTIFICATION_BODY_MAX,
  notificationSummary,
  toPlainText,
} from "./notifications";

/**
 * Minimal controllable Notification for jsdom (no Notification implementation).
 * Tests drive permission state via the static field and inspect created
 * instances (title/options) and their click handlers.
 */
class MockNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(
    async () => "granted" as NotificationPermission,
  );
  static instances: MockNotification[] = [];

  title: string;
  options: NotificationOptions | undefined;
  onclick: (() => void) | null = null;
  close = vi.fn();

  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    MockNotification.instances.push(this);
  }

  static reset() {
    MockNotification.permission = "granted";
    MockNotification.requestPermission = vi.fn(
      async () => "granted" as NotificationPermission,
    );
    MockNotification.instances = [];
  }
}

const MESSAGE = {
  senderId: "agent-2",
  body: "任务完成了,请评审",
  fileRef: null,
};

const BASE_OPTS = {
  groupId: "group-1",
  groupTitle: "评审任务",
  senderName: "win-hermes",
  message: MESSAGE,
  myAgentId: "agent-1",
  navigate: vi.fn(),
};

/** jsdom document.hidden 默认 false — 用例里显式设置页面隐藏/可见。 */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: hidden,
  });
}

beforeEach(() => {
  __resetNotificationState();
  MockNotification.reset();
  setHidden(false);
  vi.stubGlobal("Notification", MockNotification);
  BASE_OPTS.navigate = vi.fn();
  vi.spyOn(window, "focus").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("toPlainText 纯文本化", () => {
  it("去掉 markdown 标记、折叠空白、单行化", () => {
    expect(toPlainText("**加粗** 和 `代码`")).toBe("加粗 和 代码");
    expect(toPlainText("## 标题\n第二行")).toBe("标题 第二行");
    expect(toPlainText("[链接](https://x.com)")).toBe("链接");
    expect(toPlainText("  a\t b\n\n c  ")).toBe("a b c");
  });
});

describe("notificationSummary 正文摘要", () => {
  it("fileRef 消息显示 📎 文件 占位", () => {
    expect(
      notificationSummary({ body: "正文", fileRef: { name: "a.pdf" } }),
    ).toBe(FILE_MESSAGE_PLACEHOLDER);
  });

  it("短正文原样返回(纯文本化后)", () => {
    expect(notificationSummary({ body: "hi\nworld", fileRef: null })).toBe(
      "hi world",
    );
  });

  it("超过 80 字符截断并加省略号", () => {
    const long = "字".repeat(NOTIFICATION_BODY_MAX + 10);
    const summary = notificationSummary({ body: long, fileRef: null });
    expect(summary.length).toBe(NOTIFICATION_BODY_MAX + 1);
    expect(summary.endsWith("…")).toBe(true);
    expect(summary.slice(0, NOTIFICATION_BODY_MAX)).toBe(
      "字".repeat(NOTIFICATION_BODY_MAX),
    );
  });
});

describe("maybeNotifyGroupMessage 桌面通知", () => {
  it("页面隐藏 + 他人消息 → 创建通知(标题=群标题,正文=发送者: 摘要)", () => {
    setHidden(true);
    maybeNotifyGroupMessage(BASE_OPTS);

    expect(MockNotification.instances).toHaveLength(1);
    const n = MockNotification.instances[0];
    expect(n.title).toBe("评审任务");
    expect(n.options?.body).toBe("win-hermes: 任务完成了,请评审");
  });

  it("页面可见时不发通知(不打扰)", () => {
    setHidden(false);
    maybeNotifyGroupMessage(BASE_OPTS);
    expect(MockNotification.instances).toHaveLength(0);
  });

  it("自己发的消息不发通知", () => {
    setHidden(true);
    maybeNotifyGroupMessage({
      ...BASE_OPTS,
      message: { ...MESSAGE, senderId: "agent-1" },
    });
    expect(MockNotification.instances).toHaveLength(0);
  });

  it("myAgentId 为 null(未绑定)时不跳过任何消息", () => {
    setHidden(true);
    maybeNotifyGroupMessage({
      ...BASE_OPTS,
      myAgentId: null,
      message: { ...MESSAGE, senderId: "agent-1" },
    });
    expect(MockNotification.instances).toHaveLength(1);
  });

  it("点击通知 → 聚焦窗口 + 跳转 /groups/:id + 关闭通知", () => {
    setHidden(true);
    maybeNotifyGroupMessage(BASE_OPTS);
    const n = MockNotification.instances[0];

    n.onclick?.();

    expect(window.focus).toHaveBeenCalled();
    expect(BASE_OPTS.navigate).toHaveBeenCalledWith("/groups/group-1");
    expect(n.close).toHaveBeenCalled();
  });

  it("权限未定(default)时首次需要才请求,允许后补发当前这条", async () => {
    MockNotification.permission = "default";
    MockNotification.requestPermission = vi.fn(
      async () => "granted" as NotificationPermission,
    );
    setHidden(true);
    maybeNotifyGroupMessage(BASE_OPTS);

    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(MockNotification.instances).toHaveLength(0); // 授权结果落地前不发
    await vi.waitFor(() => expect(MockNotification.instances).toHaveLength(1));
  });

  it("权限被拒绝 → 静默降级,不再请求也不再打扰", async () => {
    MockNotification.permission = "default";
    MockNotification.requestPermission = vi.fn(
      async () => "denied" as NotificationPermission,
    );
    setHidden(true);
    maybeNotifyGroupMessage(BASE_OPTS);
    await vi.waitFor(() =>
      expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1),
    );

    // 同一会话后续消息不再请求
    maybeNotifyGroupMessage(BASE_OPTS);
    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(MockNotification.instances).toHaveLength(0);
  });

  it("权限已是 denied → 直接不发也不请求", () => {
    MockNotification.permission = "denied";
    setHidden(true);
    maybeNotifyGroupMessage(BASE_OPTS);
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
    expect(MockNotification.instances).toHaveLength(0);
  });

  it("浏览器不支持 Notification(undefined)→ 零报错", () => {
    vi.stubGlobal("Notification", undefined);
    setHidden(true);
    expect(() => maybeNotifyGroupMessage(BASE_OPTS)).not.toThrow();
  });

  it("群标题未加载时回退为默认标题", () => {
    setHidden(true);
    maybeNotifyGroupMessage({ ...BASE_OPTS, groupTitle: null });
    expect(MockNotification.instances[0].title).toBe("群组消息");
  });
});
