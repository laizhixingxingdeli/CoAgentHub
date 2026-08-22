import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { participantIdentityHeaders } from "@/lib/api-client";
import { t } from "@/lib/i18n";

export type GroupHeader = {
  groupTitle: string | null;
  groupStatus: "active" | "archived" | "deleted" | null;
  isReadOnly: boolean;
  isDeleted: boolean;
  editingTitle: boolean;
  setEditingTitle: (v: boolean) => void;
  titleDraft: string;
  setTitleDraft: (v: string) => void;
  savingTitle: boolean;
  handleRenameTitle: () => Promise<void>;
  error: string | null;
  setError: (v: string | null) => void;
};

/**
 * 群页头部状态共享 context。GroupLayout 持有唯一实例并向下提供;页面标题栏
 * 与消息 Tab 内的 useMessagesPage 各自调用 useGroupHeader 时消费同一份 ——
 * 避免同一群出现两次 GET /groups/:id,以及「标题栏改名后桌面通知仍用旧群名」
 * 的状态分叉。无 Provider 时(单独渲染页面/面板的测试)退化为自建实例。
 */
export const GroupHeaderContext = createContext<GroupHeader | null>(null);

/**
 * 群页头部数据 hook:群标题 + 群状态 + 行内改名。从 useMessagesPage 抽出,
 * 供群内页主区(标题栏/只读横幅)与右栏消息 Tab 的消息 hook 共用 —— 聊天流
 * 搬进 Tab 后,消息 hook 不再由页面调用,标题/状态这类头部数据与消息流解耦;
 * 若上层(GroupLayout)已提供共享实例则直接复用,不重复拉取。
 *
 * 行为与原 useMessagesPage 中对应部分完全一致:挂载时 GET /groups/:id 拉
 * 群状态(archived/soft-deleted → 只读)与标题;铅笔 → 输入 → PATCH 改名,
 * 仅 active 群可改名。rename 失败的错误经 error 返回,由页面横幅展示。
 */
export function useGroupHeader(groupId: string | undefined): GroupHeader {
  const provided = useContext(GroupHeaderContext);
  const [groupStatus, setGroupStatus] = useState<
    "active" | "archived" | "deleted" | null
  >(null);
  const [groupTitle, setGroupTitle] = useState<string | null>(null);
  // 群名行内改名(网页体验批次):标题栏铅笔图标 → 输入 → PATCH /groups/:id {title}。
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Archived AND soft-deleted groups are read-only (the backend rejects any
  // non-active group with 400): fetch the single-group status so the page can
  // render a banner and lock the composer (history stays browsable). The same
  // response carries the title for the chat header.
  const loadGroup = useCallback(async () => {
    if (!groupId) {
      return;
    }
    try {
      const res = await fetch(`/api/groups/${groupId}`, {
        headers: participantIdentityHeaders(),
      });
      if (!res.ok) {
        return;
      }
      const group = (await res.json()) as {
        status: "active" | "archived" | "deleted";
        title?: string;
      };
      setGroupStatus(group.status);
      if (group.title) {
        setGroupTitle(group.title);
      }
    } catch {
      // Status is only needed for the read-only banner; a failure just leaves
      // the composer unlocked (the server still enforces the 400 on writes).
    }
  }, [groupId]);

  /** 群名行内改名(网页体验批次):标题栏铅笔图标 → 输入 → PATCH /groups/:id
   *  {title};仅 active 群可改名(归档/软删只读)。 */
  const handleRenameTitle = async () => {
    const title = titleDraft.trim();
    if (!groupId || !title || savingTitle || isReadOnly) {
      return;
    }
    setSavingTitle(true);
    setError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...participantIdentityHeaders(),
        },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      setGroupTitle(title);
      setEditingTitle(false);
    } catch (e) {
      setError(
        t("groups.error.renameFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setSavingTitle(false);
    }
  };

  useEffect(() => {
    // 已由上层(GroupLayout)共享实例负责加载,不再重复 GET。
    if (provided) {
      return;
    }
    void loadGroup();
  }, [loadGroup, provided]);

  // Lock the composer for every non-active status (archived or soft-deleted):
  // the backend rejects writes to either with 400, so the UI must not offer
  // the send affordance at all. `null` (status not yet loaded) stays unlocked.
  const isReadOnly = groupStatus !== null && groupStatus !== "active";
  const isDeleted = groupStatus === "deleted";

  // 有共享实例时直接复用(GroupLayout 持有唯一一份,改名即时同步到通知路径)。
  if (provided) {
    return provided;
  }
  return {
    groupTitle,
    groupStatus,
    isReadOnly,
    isDeleted,
    editingTitle,
    setEditingTitle,
    titleDraft,
    setTitleDraft,
    savingTitle,
    handleRenameTitle,
    error,
    setError,
  };
}
