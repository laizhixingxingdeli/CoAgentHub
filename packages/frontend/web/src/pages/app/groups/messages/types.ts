export const GROUP_ROLES = [
  "human",
  "coordinator",
  "reviewer",
  "executor",
  "observer",
  "specialist",
] as const;

export type Audience = "broadcast" | "role" | "agent";

export type Member = {
  agentId: string;
  name: string;
  type: string;
  device: string | null;
  roles: string[];
};

export type FileRef = {
  name: string;
  size: number;
  sha256: string;
  fetchUrl: string;
  expiresAt?: string;
};

export type MessageItem = {
  id: string;
  groupId: string;
  senderId: string;
  parentId: string | null;
  audience: "broadcast" | "role" | "agent";
  audienceRef: string | null;
  body: string;
  /** T26: 后端行形状自带,旧消息可能为 null/undefined → 按 text/plain 处理。 */
  contentType?: string | null;
  fileRef: FileRef | null;
  depth: number;
  createdAt: string;
  /** Locally marked soft-deleted placeholder (ticket 22) — the WS deleted
   * event carries only the id, so the UI marks it here. */
  deleted?: boolean;
};

/** Server-side soft-delete placeholder body (ticket 22), mirrored locally. */
export const DELETED_MESSAGE_BODY = "[消息已删除]";

/** Ticket 26 long-message fold: bodies longer than this collapse to a preview. */
export const FOLD_THRESHOLD = 200;
export const FOLD_PREVIEW_LENGTH = 100;

/** T26 状态条配色:✅ 完成=绿、❌ 失败=红、🛑 取消=黄、📋/🚀 进行中=蓝。 */
export type TaskStatusKind = "done" | "failed" | "running" | "cancelled";
