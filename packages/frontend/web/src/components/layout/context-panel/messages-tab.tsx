import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMessagesPage } from "@/hooks/use-messages-page";
import { t } from "@/lib/i18n";
import { MessageList } from "@/pages/app/groups/messages/MessageList";

/**
 * 右栏「消息」Tab:聊天流降级后的只读流水(消息主区改版)。纯展示组件 ——
 * 消息流 hook 由 ContextPanel 顶层持有(useMessagesPage 实例随面板组件常驻,
 * 面板收起/抽屉关闭也不断 WS 订阅/通知/未读清零),本组件只消费其返回值。
 *
 * 只读:不渲染输入框或发送入口;消息搜索(原主区标题栏)随流一并搬入,
 * 搜索框在 Tab 内切换。MessageList 的回复/复制/编辑/删除操作条原样保留
 * (归档/软删群的只读由 isReadOnly 驱动,与搬移前一致)。
 */
export function MessagesTab({
  stream,
}: {
  /** ContextPanel 持有的 useMessagesPage 返回值。 */
  stream: ReturnType<typeof useMessagesPage>;
}) {
  const {
    messages,
    members,
    loading,
    error,
    myParticipantId,
    isReadOnly,
    expandedIds,
    collapsedRootIds,
    threadTree,
    openActionsId,
    setOpenActionsId,
    copiedId,
    editingId,
    savingEdit,
    editBody,
    setEditBody,
    scrollRef,
    handleStreamScroll,
    pendingCount,
    handleJumpToBottom,
    handleCopy,
    handleEditStart,
    handleEditSave,
    handleEditCancel,
    handleDelete,
    toggleCollapsed,
    toggleFold,
    searchBoxOpen,
    setSearchBoxOpen,
    searchQuery,
    setSearchQuery,
    searchActive,
    searchActiveQuery,
    handleSearch,
    handleClearSearch,
  } = stream;

  return (
    <div
      data-testid="messages-tab"
      className="flex h-full min-h-0 flex-col"
    >
      {searchBoxOpen ? (
        <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
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
            className="h-8 min-w-0 flex-1"
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
        <div className="flex shrink-0 items-center justify-between gap-1 border-b px-2 py-1.5">
          <span className="truncate text-xs font-medium text-muted-foreground">
            消息流水
          </span>
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
        </div>
      )}

      {searchActive && (
        <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">
            {t("messages.search.label")}{" "}
            <span className="font-medium text-foreground">
              {searchActiveQuery}
            </span>
          </span>
          <button
            type="button"
            onClick={() => {
              handleClearSearch();
              setSearchBoxOpen(false);
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
            {t("common.clear")}
          </button>
        </div>
      )}

      {error && (
        <div className="mx-2 mt-2 shrink-0 rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">
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
        handleReply={() => {}}
        handleCopy={handleCopy}
        handleEditStart={handleEditStart}
        handleEditSave={handleEditSave}
        handleEditCancel={handleEditCancel}
        handleDelete={handleDelete}
        toggleCollapsed={toggleCollapsed}
        toggleFold={toggleFold}
      />
    </div>
  );
}
