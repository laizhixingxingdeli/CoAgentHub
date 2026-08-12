/**
 * Shared WS-frame builder for tests: a `group_message` frame exactly as the
 * server hub pushes it (tickets 13/22/23). Used by the unread-store,
 * conversation-list and message-page tests so the frame shape lives in one
 * place.
 */
export function groupMessageFrame(
  groupId: string,
  body: string,
  type = "group_message",
): string {
  return JSON.stringify({
    type,
    groupId,
    message: {
      id: `msg-${groupId}-${body}`,
      groupId,
      senderId: "agent-1",
      parentId: null,
      audience: "broadcast",
      audienceRef: null,
      body,
      depth: 0,
      createdAt: "2026-08-10T00:00:00.000Z",
    },
  });
}
