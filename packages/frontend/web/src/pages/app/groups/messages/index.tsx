import { Archive, ArrowLeft, Pencil, Search, X } from "lucide-react";
import { useRoute } from "wouter";
import { ContextPanelTrigger } from "@/components/layout/context-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMessagesPage } from "@/hooks/use-messages-page";
import {
  PARTICIPANT_COLORS,
  colorForId as participantColor,
} from "@/lib/avatar-color";
import { t } from "@/lib/i18n";

// Ticket 32/33: 头像色板与哈希已抽到 lib(通用 colorForId),这里保持
// `participantColor`/`PARTICIPANT_COLORS` 的既有导出面,页面内调用与旧测试均不变。

import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

/**
 * Group message page (ticket 18): WeChat/QQ-style chat UI — three zones
 * (title bar / scrolling bubble stream / bottom composer). All state, effects
 * and handlers live in useMessagesPage — this component only parses the route,
 * calls the hook and wires MessageList / Composer.
 */
export default function GroupMessagesPage() {
  const [, params] = useRoute("/groups/:id");
  const groupId = params?.id;
  const {
    messages,
    members,
    loading,
    sending,
    error,
    testExecutor,
    setTestExecutor,
    groupTitle,
    editingTitle,
    setEditingTitle,
    titleDraft,
    setTitleDraft,
    savingTitle,
    body,
    collapsedRootIds,
    mention,
    highlightIndex,
    setHighlightIndex,
    pendingCount,
    replyTo,
    setReplyTo,
    openActionsId,
    setOpenActionsId,
    copiedId,
    editingId,
    savingEdit,
    editBody,
    setEditBody,
    expandedIds,
    toggleFold,
    searchBoxOpen,
    setSearchBoxOpen,
    searchQuery,
    setSearchQuery,
    searchActive,
    searchActiveQuery,
    scrollRef,
    textareaRef,
    myParticipantId,
    threadTree,
    toggleCollapsed,
    isReadOnly,
    isDeleted,
    handleRenameTitle,
    handleSearch,
    handleClearSearch,
    handleStreamScroll,
    handleJumpToBottom,
    handleReply,
    handleCopy,
    handleEditStart,
    handleEditSave,
    handleEditCancel,
    handleDelete,
    handleSend,
    executorMembers,
    mentionCandidates,
    insertMention,
    handleBodyChange,
    handleComposerKeyDown,
    audiencePreview,
  } = useMessagesPage(groupId);

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
        {searchBoxOpen ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Input
              type="text"
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSearch();
                } else if (e.key === "Escape") {
                  setSearchBoxOpen(false);
                }
              }}
              placeholder={t("messages.search.placeholder")}
              aria-label={t("messages.search.aria")}
              className="w-44 sm:w-64"
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("messages.search.clearAria")}
              title={t("messages.search.clearAria")}
              onClick={() => {
                handleClearSearch();
                setSearchBoxOpen(false);
              }}
              className="shrink-0"
            >
              <X className="size-4" />
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("messages.search.aria")}
            title={t("messages.search.aria")}
            onClick={() => setSearchBoxOpen(true)}
            className="shrink-0"
          >
            <Search className="size-4" />
          </Button>
        )}
        <ContextPanelTrigger />
      </div>

      {searchActive && (
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-sm text-muted-foreground">
          <span className="min-w-0 truncate">
            {t("messages.search.label")}{" "}
            <span className="font-medium text-foreground">
              {searchActiveQuery}
            </span>
          </span>
          <button
            type="button"
            onClick={handleClearSearch}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
            {t("common.clear")}
          </button>
        </div>
      )}

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

      <MessageList
        loading={loading}
        messages={messages}
        members={members}
        myParticipantId={myParticipantId}
        readOnly={isReadOnly}
        expandedIds={expandedIds}
        collapsedRootIds={collapsedRootIds}
        threadTree={threadTree}
        openActionsId={openActionsId}
        setOpenActionsId={setOpenActionsId}
        copiedId={copiedId}
        editingId={editingId}
        savingEdit={savingEdit}
        editBody={editBody}
        setEditBody={setEditBody}
        scrollRef={scrollRef}
        handleStreamScroll={handleStreamScroll}
        pendingCount={pendingCount}
        handleJumpToBottom={handleJumpToBottom}
        handleReply={handleReply}
        handleCopy={handleCopy}
        handleEditStart={handleEditStart}
        handleEditSave={handleEditSave}
        handleEditCancel={handleEditCancel}
        handleDelete={handleDelete}
        toggleCollapsed={toggleCollapsed}
        toggleFold={toggleFold}
      />
      <Composer
        body={body}
        mention={mention}
        mentionCandidates={mentionCandidates}
        highlightIndex={highlightIndex}
        setHighlightIndex={setHighlightIndex}
        replyTo={replyTo}
        setReplyTo={setReplyTo}
        sending={sending}
        isReadOnly={isReadOnly}
        audiencePreview={audiencePreview}
        textareaRef={textareaRef}
        handleBodyChange={handleBodyChange}
        handleComposerKeyDown={handleComposerKeyDown}
        handleSend={handleSend}
        insertMention={insertMention}
        testExecutor={testExecutor}
        setTestExecutor={setTestExecutor}
        executorMembers={executorMembers}
      />
    </div>
  );
}

export { detectMention, formatMessageTime, resolveAudience } from "./lib";
// Re-exports kept for the test suite (pre-split module surface).
export { PARTICIPANT_COLORS, participantColor };
