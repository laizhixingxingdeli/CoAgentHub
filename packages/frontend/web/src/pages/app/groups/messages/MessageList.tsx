import { ArrowDown, Download, FileText, MessageCircle } from "lucide-react";
import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import { colorForId as participantColor } from "@/lib/avatar-color";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  dayKey,
  dayLabel,
  formatMessageTime,
  formatSize,
  TASK_STATUS_CLASSES,
  taskStatusKind,
} from "./lib";
import {
  DELETED_MESSAGE_BODY,
  FOLD_PREVIEW_LENGTH,
  FOLD_THRESHOLD,
  type Member,
  type MessageItem,
} from "./types";

interface MessageListProps {
  loading: boolean;
  messages: MessageItem[];
  members: Member[];
  myParticipantId: string | null;
  /** 归档/软删群只读:编辑/回复/删除按钮禁用并提示(发送已由 Composer 层禁用)。 */
  readOnly: boolean;
  expandedIds: ReadonlySet<string>;
  collapsedRootIds: ReadonlySet<string>;
  threadTree: {
    byId: Map<string, MessageItem>;
    descendantCount: Map<string, number>;
  };
  openActionsId: string | null;
  setOpenActionsId: React.Dispatch<React.SetStateAction<string | null>>;
  copiedId: string | null;
  editingId: string | null;
  savingEdit: boolean;
  editBody: string;
  setEditBody: React.Dispatch<React.SetStateAction<string>>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  handleStreamScroll: () => void;
  pendingCount: number;
  handleJumpToBottom: () => void;
  handleReply: (message: MessageItem) => void;
  handleCopy: (message: MessageItem) => Promise<void>;
  handleEditStart: (message: MessageItem) => void;
  handleEditSave: (message: MessageItem) => Promise<void>;
  handleEditCancel: () => void;
  handleDelete: (message: MessageItem) => Promise<void>;
  toggleCollapsed: (rootId: string) => void;
  toggleFold: (id: string) => void;
}

/**
 * Zone 2: the scrollable bubble stream — day separators, WeChat-style message
 * bubbles, long-message folding, thread collapse, and the per-message action
 * bar (reply / copy / edit / delete).
 */
export function MessageList(props: MessageListProps) {
  const {
    loading,
    messages,
    members,
    myParticipantId,
    readOnly,
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
    handleReply,
    handleCopy,
    handleEditStart,
    handleEditSave,
    handleEditCancel,
    handleDelete,
    toggleCollapsed,
    toggleFold,
  } = props;

  const senderName = (senderId: string) => {
    const member = members.find((m) => m.participantId === senderId);
    return member ? member.name : senderId.slice(0, 8);
  };
  const senderDevice = (senderId: string) =>
    members.find((m) => m.participantId === senderId)?.device ?? null;
  const senderRoles = (senderId: string): string[] =>
    members.find((m) => m.participantId === senderId)?.roles ?? [];

  // 当前身份是否 human(全可见):未绑定 = Local User(human);已绑定则看
  // 该 participant 在本群是否持 human 角色。与服务端 participantType 判定一致。
  const isHuman =
    myParticipantId === null ||
    members.some(
      (m) => m.participantId === myParticipantId && m.roles.includes("human"),
    );

  // Ticket 26 audience tag: `→ @<成员名>` for participant-targeted, `→ @<角色名>`
  // for role-targeted, nothing for broadcast.
  // human 视角(全可见)的定向消息额外以「📨 定向给 <执行器名>」标注目标,
  // 非 human 不显示该标签(仅保留通用 → @ 受众徽章)。
  const audienceLabel = (msg: MessageItem) => {
    if (msg.audience === "role" && msg.audienceRef) {
      return `→ @${msg.audienceRef}`;
    }
    if (msg.audience === "participant" && msg.audienceRef) {
      const target = members.find((m) => m.participantId === msg.audienceRef);
      const name = target ? target.name : msg.audienceRef.slice(0, 8);
      if (isHuman) {
        return t("messages.item.directedTo", { name });
      }
      return `→ @${name}`;
    }
    return null;
  };

  // A message is hidden when the root of its parentId chain is collapsed —
  // never the root itself (the toggle lives on the root's own row). A message
  // whose parentId is not in the loaded list (e.g. a WS event that arrived
  // before its parent) has no root to hang under: it renders flat and is
  // never dropped.
  const isCollapsed = (current: MessageItem): boolean => {
    if (collapsedRootIds.size === 0) {
      return false;
    }
    let node = current;
    while (node.parentId) {
      const parent = threadTree.byId.get(node.parentId);
      if (!parent) {
        return false;
      }
      node = parent;
    }
    return node.id !== current.id && collapsedRootIds.has(node.id);
  };

  const visibleMessages = messages.filter((msg) => !isCollapsed(msg));

  return (
    // Zone 2: the scrollable bubble stream.
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleStreamScroll}
        data-testid="message-stream"
        // Ticket 22 WeChat-style chat background: light gray base + a very
        // faint diagonal grid texture; the muted tokens flip automatically
        // in dark mode. Bubbles stay on top with their card contrast.
        className="h-full overflow-y-auto bg-muted/30 dark:bg-muted/15 [background-image:repeating-linear-gradient(45deg,color-mix(in_oklab,var(--color-muted-foreground)_5%,transparent)_0_1px,transparent_1px_14px)]"
      >
        {visibleMessages.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
            {loading ? (
              t("common.loading")
            ) : (
              <>
                <MessageCircle className="size-8" />
                <p>{t("messages.list.empty")}</p>
                <p className="text-xs">{t("messages.list.emptyHint")}</p>
              </>
            )}
          </div>
        ) : (
          <ul className="flex flex-col py-3">
            {visibleMessages.map((msg, i) => {
              const prev = i > 0 ? visibleMessages[i - 1] : undefined;
              const own =
                myParticipantId !== null && msg.senderId === myParticipantId;
              const contentType = msg.contentType ?? "text/plain";
              const isStatus = contentType === "task_status";
              // Ticket 26 long-message fold: bodies over FOLD_THRESHOLD chars
              // show a preview unless expanded; applies to every message type.
              // Array.from splits by code points so an emoji (surrogate pair)
              // straddling the cut is never split into a lone-half "�".
              const bodyLong = (msg.body ?? "").length > FOLD_THRESHOLD;
              const folded = bodyLong && !expandedIds.has(msg.id);
              const displayBody = folded
                ? `${Array.from(msg.body).slice(0, FOLD_PREVIEW_LENGTH).join("")}…`
                : msg.body;
              const replyCount = msg.parentId
                ? 0
                : (threadTree.descendantCount.get(msg.id) ?? 0);
              const isRootWithReplies = !msg.parentId && replyCount > 0;
              const collapsed =
                isRootWithReplies && collapsedRootIds.has(msg.id);
              // Ticket 21 WeChat rule: merge same-sender rows (avatar/name
              // hidden on the follow-ups) while the gap stays within 5 minutes
              // and the parent is the same — never on a root that carries the
              // fold toggle, so the badge stays reachable. A >5min gap (or a
              // sender change) re-opens a header row with a fresh timestamp.
              const compact =
                !isRootWithReplies &&
                prev !== undefined &&
                prev.senderId === msg.senderId &&
                prev.parentId === msg.parentId &&
                Date.parse(msg.createdAt) - Date.parse(prev.createdAt) <=
                  5 * 60 * 1000;
              const label = audienceLabel(msg);
              const deleted =
                msg.deleted === true || msg.body === DELETED_MESSAGE_BODY;
              // Ticket 22: 编辑/删除 are sender-only (own messages); a deleted
              // placeholder shows no action bar at all. Archived/deleted groups
              // are read-only — write actions (edit/reply/delete) are disabled
              // with a hint; copy stays available.
              const writeDisabled = readOnly;
              const writeHint = writeDisabled
                ? t("messages.list.readOnly")
                : undefined;
              const actions = deleted ? null : (
                <>
                  {own && (
                    <button
                      type="button"
                      disabled={writeDisabled}
                      title={writeHint}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEditStart(msg);
                      }}
                      className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t("common.edit")}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={writeDisabled}
                    title={writeHint}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleReply(msg);
                    }}
                    className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {t("messages.item.reply")}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleCopy(msg);
                    }}
                    className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {copiedId === msg.id
                      ? t("messages.item.copied")
                      : t("messages.item.copy")}
                  </button>
                  {own && (
                    <button
                      type="button"
                      disabled={writeDisabled}
                      title={writeHint}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDelete(msg);
                      }}
                      className="rounded-md px-2 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {t("common.delete")}
                    </button>
                  )}
                </>
              );
              return (
                <Fragment key={msg.id}>
                  {prev !== undefined &&
                    dayKey(prev.createdAt) !== dayKey(msg.createdAt) && (
                      <li className="px-3 py-2" data-testid="day-separator">
                        <div className="mx-auto w-fit rounded-full bg-muted px-3 py-0.5 text-xs text-muted-foreground">
                          {dayLabel(msg.createdAt)}
                        </div>
                      </li>
                    )}
                  <li
                    data-message-id={msg.id}
                    data-own={own ? "true" : "false"}
                    // Ticket 35: avatar hugs the bubble top (items-start), not
                    // the bottom edge; own rows keep flex-row-reverse so the
                    // avatar lands top-right, others top-left.
                    className={cn(
                      "group relative flex items-start gap-2 px-3 py-1.5",
                      own && !isStatus && "flex-row-reverse",
                      isStatus && "justify-center",
                    )}
                    // Ticket 34: cap the reply-tree indent so deep threads
                    // keep enough room for a readable bubble on narrow screens.
                    style={{
                      paddingLeft: `${Math.min(msg.depth * 16, 64)}px`,
                    }}
                  >
                    {isStatus ? (
                      deleted ? (
                        /* 已删除的状态消息同样显示灰色占位,不伪装成进行中的状态条。 */
                        <div className="max-w-[85%] rounded-lg border bg-muted/40 px-3 py-1.5 text-xs italic text-muted-foreground">
                          {t("messages.item.deleted")}
                        </div>
                      ) : (
                        /* Ticket 26: 桥回传状态消息 → 微信系统消息风格的居中紧凑
                       状态条(不占大气泡、不分左右);颜色按状态区分。 */
                        <div
                          data-testid="task-status"
                          data-status={taskStatusKind(msg.body)}
                          className={cn(
                            "max-w-[85%] rounded-lg border px-3 py-1.5 shadow-sm",
                            TASK_STATUS_CLASSES[taskStatusKind(msg.body)],
                          )}
                        >
                          <p className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                            {displayBody}
                          </p>
                          {bodyLong && (
                            <button
                              type="button"
                              onClick={() => toggleFold(msg.id)}
                              className="mt-1 inline-flex items-center rounded px-1 text-xs underline underline-offset-2 transition-opacity hover:opacity-80"
                            >
                              {folded
                                ? t("messages.item.expandFull")
                                : t("messages.item.fold")}
                            </button>
                          )}
                          <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted-foreground/80">
                            <span>{formatMessageTime(msg.createdAt)}</span>
                          </div>
                        </div>
                      )
                    ) : (
                      <>
                        {compact ? (
                          /* Ticket 44: compact(同发送者合并)行渲染等宽不可见
                             头像占位,保持与首行(带头像)水平对齐;不可聚焦且
                             aria-hidden,不占 tab 顺序/a11y 树。 */
                          <div
                            aria-hidden="true"
                            className="size-9 shrink-0 invisible"
                          />
                        ) : (
                          <div
                            title={[
                              senderName(msg.senderId),
                              senderDevice(msg.senderId),
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            className={cn(
                              "flex size-9 shrink-0 select-none items-center justify-center rounded-full text-sm font-semibold",
                              participantColor(msg.senderId),
                            )}
                          >
                            {senderName(msg.senderId).slice(0, 1).toUpperCase()}
                          </div>
                        )}
                        <div
                          className={cn(
                            "flex min-w-0 flex-col gap-1",
                            own ? "items-end" : "items-start",
                          )}
                        >
                          {!compact && (
                            <div
                              className={cn(
                                "flex max-w-full flex-wrap items-baseline gap-x-1.5 gap-y-0.5 px-1 text-xs",
                                own && "flex-row-reverse",
                              )}
                            >
                              {/* Ticket 32 info line 1: 昵称 + 我 + 时间(小字,右上) */}
                              <span className="flex min-w-0 items-baseline gap-1">
                                <span className="max-w-40 truncate font-medium text-foreground">
                                  {senderName(msg.senderId)}
                                </span>
                                {own && (
                                  <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
                                    {t("messages.item.me")}
                                  </span>
                                )}
                                <span className="shrink-0 text-[10px] text-muted-foreground">
                                  {formatMessageTime(msg.createdAt)}
                                </span>
                              </span>
                              {/* Ticket 32 info line 2: 角色 / 受众徽章(小字) */}
                              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                {senderRoles(msg.senderId).length > 0 && (
                                  <span className="rounded-full bg-muted px-1.5 py-0.5">
                                    {senderRoles(msg.senderId).join("/")}
                                  </span>
                                )}
                                {label && (
                                  <span className="rounded-full bg-muted px-1.5 py-0.5">
                                    {label}
                                  </span>
                                )}
                              </span>
                              {isRootWithReplies && (
                                <button
                                  type="button"
                                  aria-label={
                                    collapsed
                                      ? t("messages.item.expand")
                                      : t("messages.item.collapse")
                                  }
                                  onClick={() => toggleCollapsed(msg.id)}
                                  className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-muted"
                                >
                                  <span aria-hidden="true">
                                    {collapsed ? "▸" : "▾"}
                                  </span>
                                  {t("messages.item.replyCount", {
                                    count: replyCount,
                                  })}
                                </button>
                              )}
                            </div>
                          )}
                          {/* 气泡容器 relative + w-fit + max-w:宽度贴合内容(短消息
                        与内容同宽、不撑满;长消息在 max-w-75%/sm:max-w-60% 处换行,
                        百分比相对「消息列」解析),内部气泡 w-full 即内容宽;操作条
                        absolute 贴角(bottom-0 贴底、left-full/right-full 贴对应
                        侧边,own 镜像)。Ticket 22:编辑中换为 save/cancel 文本域,
                        已删除消息渲染灰色占位。 */}
                          <div className="relative w-fit max-w-[75%] sm:max-w-[60%]">
                            {editingId === msg.id ? (
                              <div
                                data-testid="message-edit-form"
                                className="w-full rounded-2xl border bg-background px-3.5 py-2.5 text-sm shadow-sm"
                              >
                                <textarea
                                  autoFocus
                                  aria-label={t("messages.item.editAria")}
                                  value={editBody}
                                  onChange={(e) => setEditBody(e.target.value)}
                                  rows={2}
                                  className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                />
                                {msg.fileRef && (
                                  <div className="mt-1.5 flex items-center gap-3 rounded-md border bg-muted/40 px-3 py-2">
                                    <FileText className="size-5 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0 flex-1">
                                      <p
                                        className="truncate text-sm font-medium"
                                        title={msg.fileRef.name}
                                      >
                                        {msg.fileRef.name}
                                      </p>
                                      <p className="text-xs text-muted-foreground">
                                        {formatSize(msg.fileRef.size)}
                                      </p>
                                    </div>
                                  </div>
                                )}
                                <div className="mt-2 flex items-center justify-end gap-2">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={handleEditCancel}
                                  >
                                    {t("messages.edit.cancel")}
                                  </Button>
                                  <Button
                                    size="sm"
                                    onClick={() => void handleEditSave(msg)}
                                    disabled={savingEdit || !editBody.trim()}
                                  >
                                    {savingEdit
                                      ? t("messages.edit.saving")
                                      : t("messages.edit.save")}
                                  </Button>
                                </div>
                              </div>
                            ) : deleted ? (
                              <div
                                className={cn(
                                  "w-full rounded-2xl px-3.5 py-2 text-sm",
                                  own
                                    ? "rounded-br-md bg-muted/40"
                                    : "rounded-bl-md bg-muted/40",
                                )}
                              >
                                <p className="whitespace-pre-wrap break-words text-xs italic text-muted-foreground">
                                  {t("messages.item.deleted")}
                                </p>
                              </div>
                            ) : (
                              <div
                                role="button"
                                tabIndex={0}
                                aria-expanded={openActionsId === msg.id}
                                aria-label={t("messages.item.actionsAria", {
                                  preview: msg.body
                                    ? msg.body.slice(0, 20)
                                    : t("messages.item.messageWord"),
                                })}
                                onClick={() =>
                                  setOpenActionsId((prev) =>
                                    prev === msg.id ? null : msg.id,
                                  )
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    setOpenActionsId((prev) =>
                                      prev === msg.id ? null : msg.id,
                                    );
                                  }
                                }}
                                className={cn(
                                  "relative w-full rounded-2xl px-3.5 py-2.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                  own
                                    ? "rounded-br-md bg-primary text-primary-foreground"
                                    : "rounded-bl-md bg-muted",
                                )}
                              >
                                {/* Ticket 22 WeChat-style bubble tail: a small triangle at
                          the bottom edge (own right, others left), matched to
                          the bubble fill via the same color token. */}
                                <span
                                  aria-hidden="true"
                                  className={cn(
                                    "absolute -bottom-[7px] h-0 w-0 border-l-[8px] border-r-[8px] border-t-[7px] border-l-transparent border-r-transparent",
                                    own
                                      ? "right-3 border-t-primary"
                                      : "left-3 border-t-muted",
                                  )}
                                />
                                {contentType === "discussion" && (
                                  /* Ticket 26: hermes 讨论回复 → 气泡左上角 💬 小标记。 */
                                  <span
                                    aria-hidden="true"
                                    data-testid="discussion-mark"
                                    className="absolute -top-2 left-2 rounded-full border bg-popover px-1.5 py-0.5 text-xs shadow-sm"
                                  >
                                    💬
                                  </span>
                                )}
                                {msg.body && (
                                  <>
                                    <p className="whitespace-pre-wrap break-words">
                                      {displayBody}
                                    </p>
                                    {bodyLong && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          toggleFold(msg.id);
                                        }}
                                        className="mt-1 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-muted"
                                      >
                                        {folded
                                          ? t("messages.item.expandFull")
                                          : t("messages.item.fold")}
                                      </button>
                                    )}
                                  </>
                                )}
                                {msg.fileRef && (
                                  <div className="mt-1.5 flex items-center gap-3 rounded-md border bg-background/50 px-3 py-2">
                                    <FileText className="size-5 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0 flex-1">
                                      <p
                                        className="truncate text-sm font-medium"
                                        title={msg.fileRef.name}
                                      >
                                        {msg.fileRef.name}
                                      </p>
                                      <p className="text-xs text-muted-foreground">
                                        {formatSize(msg.fileRef.size)}
                                        {msg.fileRef.expiresAt
                                          ? t("messages.item.validUntil", {
                                              time: new Date(
                                                msg.fileRef.expiresAt,
                                              ).toLocaleString("zh-CN", {
                                                hour12: false,
                                              }),
                                            })
                                          : ""}
                                      </p>
                                    </div>
                                    <a
                                      href={msg.fileRef.fetchUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                                    >
                                      <Download className="size-3.5" />
                                      {t("common.download")}
                                    </a>
                                  </div>
                                )}
                              </div>
                            )}
                            {/* Ticket 44: hover 操作条(md+)与移动端 tap 弹层共用
                          relative 气泡容器,absolute 贴角:bottom-0 底边=气泡底边,
                          他人 left-full ml-1(按钮左缘=气泡右缘)、自己 right-full
                          mr-1(按钮右缘=气泡左缘,flex-row-reverse 下镜像同规则);
                          `invisible` 保证 hover/focus 前不占 tab 顺序/a11y 树
                          (opacity 单独用会留下不可见但可聚焦的按钮)。 */}
                            {actions && (
                              <div
                                data-testid="message-actions-hover"
                                className={cn(
                                  "absolute bottom-0 z-10 hidden items-center gap-0.5 rounded-lg border bg-popover p-0.5 opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 invisible group-hover:visible group-focus-within:visible md:flex",
                                  own ? "right-full mr-1" : "left-full ml-1",
                                )}
                              >
                                {actions}
                              </div>
                            )}
                            {actions && openActionsId === msg.id && (
                              <div
                                data-testid="message-actions-mobile"
                                className={cn(
                                  "absolute bottom-0 z-10 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-md md:hidden",
                                  own ? "right-full mr-1" : "left-full ml-1",
                                )}
                              >
                                {actions}
                              </div>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </li>
                </Fragment>
              );
            })}
          </ul>
        )}
      </div>
      {pendingCount > 0 && (
        <button
          type="button"
          data-testid="new-message-pill"
          onClick={handleJumpToBottom}
          className="absolute bottom-5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-background px-3 py-1 text-xs shadow-sm transition-colors hover:bg-muted"
        >
          <ArrowDown className="size-3.5" />
          {t("messages.newCount", { count: pendingCount })}
        </button>
      )}
    </div>
  );
}
