import { Archive, ArrowLeft, Pencil } from "lucide-react";
import { useEffect } from "react";
import { useRoute } from "wouter";
import { ContextPanelTrigger } from "@/components/layout/context-panel";
import { RequirementWorkspace } from "@/components/layout/context-panel/requirement-workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGroupHeader } from "@/hooks/use-group-header";
import { markRead, setActiveGroupId } from "@/hooks/use-unread";
import {
  PARTICIPANT_COLORS,
  colorForId as participantColor,
} from "@/lib/avatar-color";
import { t } from "@/lib/i18n";

// Ticket 32/33: 头像色板与哈希已抽到 lib(通用 colorForId),这里保持
// `participantColor`/`PARTICIPANT_COLORS` 的既有导出面,页面内调用与旧测试均不变。

/**
 * 群内页(需求主区改版):主区从「聊天流 + 输入框」改为「需求列表 | 需求详情」
 * 两栏(RequirementWorkspace,与右栏任务 Tab 共享同一组件)。聊天流降级为右栏
 * 上下文面板「消息」Tab 的只读流水(MessageList 无 Composer),消息搜索随流
 * 一并搬入该 Tab;页面标题栏仅保留返回 / 群名改名 / 面板开关。群状态(归档/
 * 软删)由 useGroupHeader 提供,驱动只读横幅。
 */
export default function GroupMessagesPage() {
  const [, params] = useRoute("/groups/:id");
  const groupId = params?.id;

  // Ticket 23: 进入消息页即清零该群侧栏未读徽标。常驻消息流 hook(右栏
  // ContextPanel 顶层)不负责此项 —— 成员页也共享该面板,进入成员页不应误清零。
  useEffect(() => {
    if (!groupId) {
      return;
    }
    setActiveGroupId(groupId);
    markRead(groupId);
  }, [groupId]);

  const {
    groupTitle,
    editingTitle,
    setEditingTitle,
    titleDraft,
    setTitleDraft,
    savingTitle,
    handleRenameTitle,
    isReadOnly,
    isDeleted,
    error,
  } = useGroupHeader(groupId);

  return (
    <div className="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-[1440px] flex-col px-4 sm:px-6">
      {/* ── Zone 1: title bar ─────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <a
          href="/groups"
          aria-label={t("messages.back.aria")}
          className="inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          <span className="hidden sm:inline">{t("messages.back.label")}</span>
        </a>
        {editingTitle ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <Input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleRenameTitle();
                } else if (e.key === "Escape") {
                  setEditingTitle(false);
                }
              }}
              aria-label={t("groups.renameInputAria")}
              className="h-8 min-w-0 flex-1"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={savingTitle || !titleDraft.trim()}
              onClick={() => void handleRenameTitle()}
              className="shrink-0"
            >
              {savingTitle ? t("common.saving") : t("groups.renameSave")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditingTitle(false)}
              className="shrink-0"
            >
              {t("groups.renameCancel")}
            </Button>
          </div>
        ) : (
          <h2
            data-testid="group-title-bar"
            className="flex min-w-0 flex-1 items-center gap-1 truncate text-base font-semibold"
          >
            <span className="truncate">
              {groupTitle ?? t("messages.titleFallback")}
            </span>
            {!isReadOnly && (
              <Pencil
                data-testid="rename-group-title"
                className="size-3.5 shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                aria-label={t("groups.renameAria")}
                onClick={() => {
                  setTitleDraft(groupTitle ?? "");
                  setEditingTitle(true);
                }}
              />
            )}
          </h2>
        )}
        <ContextPanelTrigger />
      </div>

      {isReadOnly && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <Archive className="size-4 shrink-0" />
          {isDeleted
            ? t("messages.readOnly.deleted")
            : t("messages.readOnly.archived")}
        </div>
      )}

      {error && (
        <div className="mx-4 mt-3 shrink-0 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {/* ── Zone 2: 需求主区(需求列表 | 需求详情两栏,含停止/回滚控制条)── */}
      {groupId && (
        <RequirementWorkspace
          groupId={groupId}
          listClassName="min-w-48 w-96 shrink"
        />
      )}
    </div>
  );
}

export { detectMention, formatMessageTime, resolveAudience } from "./lib";
// Re-exports kept for the test suite (pre-split module surface).
export { PARTICIPANT_COLORS, participantColor };
