/**
 * Browser desktop notifications for group messages.
 *
 * When the WS hub delivers a new `group_message` while the tab is hidden, show
 * a system Notification so the user notices incoming messages without staring
 * at the page (LAN multi-participant collaboration scenario).
 *
 * Policies:
 * - Only fire while `document.hidden` is true — a visible page already appends
 *   the message in-stream, no extra popups.
 * - Never notify the user's own messages (senderId === bound participant id).
 * - Permission is requested lazily on the first notifiable message, never at
 *   app load; a denied permission degrades silently (no re-requesting).
 * - Clicking the notification focuses the window and jumps to the group's
 *   message page (`/groups/:id`).
 * - Every Notification call is wrapped in try/catch — an unsupported browser
 *   or a revoked permission must never throw into the WS handler.
 */

/** Notification body summary cap (characters). */
export const NOTIFICATION_BODY_MAX = 80;
/** Body placeholder for fileRef messages. */
export const FILE_MESSAGE_PLACEHOLDER = "📎 文件";

/** Minimal message shape the notifier needs (structural — no page imports). */
export type NotifyMessage = {
  senderId: string;
  body: string;
  fileRef: { name: string } | null;
};

/** Session flag: set once the user declines permission, so we never ask again. */
let permissionDenied = false;

/** Strip common markdown markup and collapse whitespace to one line. */
export function toPlainText(body: string): string {
  return body
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** One-line body summary: 「📎 文件」 for fileRef messages, else plain text
 *  truncated to NOTIFICATION_BODY_MAX characters. */
export function notificationSummary(
  message: Pick<NotifyMessage, "body" | "fileRef">,
): string {
  if (message.fileRef) {
    return FILE_MESSAGE_PLACEHOLDER;
  }
  const text = toPlainText(message.body);
  return text.length > NOTIFICATION_BODY_MAX
    ? `${text.slice(0, NOTIFICATION_BODY_MAX)}…`
    : text;
}

export type NotifyGroupMessageOptions = {
  /** Group id — the target of the notification-click navigation. */
  groupId: string;
  /** Group title; falls back to "群组消息" when not loaded yet. */
  groupTitle: string | null;
  /** Resolved sender display name (member name, else id prefix). */
  senderName: string;
  message: NotifyMessage;
  /** Bound participant id; null means no identity — never treat as own. */
  myParticipantId: string | null;
  /** Navigate to the group page (wouter). */
  navigate: (to: string) => void;
};

/**
 * Show a desktop notification for an incoming group message when every gate
 * passes: tab hidden, not our own message, permission available. Any failure
 * (unsupported browser, revoked permission) degrades to a silent no-op.
 */
export function maybeNotifyGroupMessage(opts: NotifyGroupMessageOptions): void {
  const {
    groupId,
    groupTitle,
    senderName,
    message,
    myParticipantId,
    navigate,
  } = opts;
  try {
    // Visible tab: the message already appears in-stream — no popup.
    if (!document.hidden) {
      return;
    }
    // Own message (including the sender's own WS echo): never notify.
    if (myParticipantId && message.senderId === myParticipantId) {
      return;
    }
    // Unsupported browser or permission already declined: zero noise.
    if (
      typeof Notification === "undefined" ||
      permissionDenied ||
      Notification.permission === "denied"
    ) {
      return;
    }

    const title = groupTitle ?? "群组消息";
    const summary = notificationSummary(message);
    const body = summary ? `${senderName}: ${summary}` : senderName;

    const show = () => {
      try {
        const notification = new Notification(title, { body });
        // Click: focus the window and jump to the group's message page.
        notification.onclick = () => {
          try {
            window.focus();
            navigate(`/groups/${groupId}`);
            notification.close();
          } catch {
            // Click handling must never throw either.
          }
        };
      } catch {
        // Constructor failure (unsupported API): silent.
      }
    };

    if (Notification.permission === "granted") {
      show();
      return;
    }
    // permission === "default": the first notifiable message requests lazily;
    // if granted, the triggering message is shown — otherwise degrade silently.
    Notification.requestPermission()
      .then((result) => {
        if (result === "granted") {
          show();
        } else {
          permissionDenied = true;
        }
      })
      .catch(() => {
        permissionDenied = true;
      });
  } catch {
    // Last-resort guard: nothing here may escape into the WS handler.
  }
}

/** Test-only: reset the module-level permission flag. */
export function __resetNotificationState(): void {
  permissionDenied = false;
}
