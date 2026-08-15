import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { MentionCandidate } from "./lib";
import type { Member } from "./types";

interface ComposerProps {
  replyTo: { id: string; senderName: string; preview: string } | null;
  setReplyTo: (
    reply: { id: string; senderName: string; preview: string } | null,
  ) => void;
  mention: { start: number; query: string } | null;
  mentionCandidates: MentionCandidate[];
  highlightIndex: number;
  setHighlightIndex: (index: number) => void;
  insertMention: (candidate: MentionCandidate) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  body: string;
  handleBodyChange: (value: string, selectionStart: number) => void;
  handleComposerKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  isReadOnly: boolean;
  audiencePreview: string | null;
  handleSend: () => Promise<void>;
  sending: boolean;
  /** 测试执行器选择(纯辅助,不改消息 schema):"auto" | "same" | participantId。 */
  testExecutor: string;
  setTestExecutor: (value: string) => void;
  /** 群内 executor/specialist 角色成员,供「测试执行器」下拉显式选择。 */
  executorMembers: Member[];
}

/**
 * Zone 3: the bottom composer — reply quote bar, "@ mention" candidate
 * popover, the textarea, an audience preview, and the send button.
 */
export function Composer(props: ComposerProps) {
  const {
    replyTo,
    setReplyTo,
    mention,
    mentionCandidates,
    highlightIndex,
    setHighlightIndex,
    insertMention,
    textareaRef,
    body,
    handleBodyChange,
    handleComposerKeyDown,
    isReadOnly,
    audiencePreview,
    handleSend,
    sending,
    testExecutor,
    setTestExecutor,
    executorMembers,
  } = props;

  return (
    <div className="shrink-0 border-t bg-card px-4 py-3">
      {replyTo && (
        <div
          data-testid="reply-quote-bar"
          className="mb-2 flex items-center gap-2 rounded-md border-l-4 border-primary bg-muted/60 px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-foreground">
              {t("messages.reply.to", { name: replyTo.senderName })}
            </p>
            {replyTo.preview && (
              <p className="truncate text-xs text-muted-foreground">
                {replyTo.preview}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label={t("messages.reply.cancelAria")}
            onClick={() => setReplyTo(null)}
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
      <div className="relative">
        {mention && mentionCandidates.length > 0 && (
          <ul
            role="listbox"
            aria-label={t("messages.mention.aria")}
            data-testid="mention-list"
            className="absolute bottom-full left-0 right-0 mb-2 max-h-56 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"
          >
            {mentionCandidates.map((candidate, idx) => (
              <li key={`${candidate.kind}:${candidate.token}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={idx === highlightIndex}
                  onMouseEnter={() => setHighlightIndex(idx)}
                  onClick={() => insertMention(candidate)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm",
                    idx === highlightIndex && "bg-muted",
                  )}
                >
                  <span className="font-medium">@{candidate.token}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {candidate.kind === "role"
                      ? t("messages.mention.role")
                      : t("messages.mention.member")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          aria-label={t("messages.send.aria")}
          value={body}
          onChange={(e) =>
            handleBodyChange(
              e.target.value,
              e.target.selectionStart ?? e.target.value.length,
            )
          }
          onKeyDown={handleComposerKeyDown}
          placeholder={
            isReadOnly
              ? t("messages.send.archivedPlaceholder")
              : t("messages.send.placeholder")
          }
          rows={2}
          disabled={isReadOnly}
          className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <select
            aria-label={t("messages.send.testExecutor")}
            value={testExecutor}
            onChange={(e) => setTestExecutor(e.target.value)}
            disabled={isReadOnly}
            className="shrink-0 rounded-md border bg-background px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="auto">{t("messages.send.testExecutor.auto")}</option>
            <option value="same">{t("messages.send.testExecutor.same")}</option>
            {executorMembers.map((m) => (
              <option key={m.participantId} value={m.participantId}>
                {m.name}
              </option>
            ))}
          </select>
          <div
            data-testid="audience-preview"
            className="min-w-0 truncate text-xs text-muted-foreground"
          >
            {audiencePreview
              ? t("messages.send.audience", { audience: audiencePreview })
              : ""}
          </div>
        </div>
        <Button
          onClick={handleSend}
          disabled={isReadOnly || sending || !body.trim()}
          size="sm"
          className="shrink-0"
        >
          {sending ? t("common.sending") : t("messages.send.button")}
        </Button>
      </div>
    </div>
  );
}
