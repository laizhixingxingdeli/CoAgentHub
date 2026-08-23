import { ChevronDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type FoldableContentProps = {
  /** Stable test id for the toggle button. */
  toggleTestId: string;
  /** Stable test id for the expanded content region. */
  detailTestId: string;
  textForMeasurement: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
};

function contentSizeLabel(text: string): string {
  const lineCount = text.match(/\r?\n/g)?.length ?? 0;
  if (lineCount > 0) {
    return `${lineCount + 1} 行`;
  }
  return `${text.length} 字`;
}

/** Shared affordance and bounded viewport for long requirement content. */
export function FoldableContent({
  toggleTestId,
  detailTestId,
  textForMeasurement,
  expanded,
  onToggle,
  children,
  className,
}: FoldableContentProps) {
  return (
    <>
      <button
        type="button"
        data-testid={toggleTestId}
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          "mt-1.5 inline-flex items-center gap-1 rounded-md border bg-muted/50 px-2 py-1 text-sm font-medium text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "hover:bg-muted motion-reduce:transition-none",
          className,
        )}
      >
        {expanded ? (
          <ChevronUp className="size-4" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-4" aria-hidden="true" />
        )}
        <span>{expanded ? "收起" : "展开"}</span>
        {!expanded && (
          <span className="text-xs font-normal text-muted-foreground">
            · {contentSizeLabel(textForMeasurement)}
          </span>
        )}
      </button>
      {expanded && (
        <div
          id={detailTestId}
          data-testid={detailTestId}
          className="mt-1.5 max-h-[60vh] overflow-y-auto space-y-1.5 border-t pt-1.5"
        >
          {children}
        </div>
      )}
    </>
  );
}
