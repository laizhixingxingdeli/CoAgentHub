import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** 群状态徽标(active=绿 / archived=灰),抽自群列表页,供移动卡片与桌面表格复用。 */
export function StatusBadge({ status }: { status: "active" | "archived" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        status === "active"
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
          : "bg-muted text-muted-foreground",
      )}
    >
      {status === "active"
        ? t("groups.status.active")
        : t("groups.status.archived")}
    </span>
  );
}
