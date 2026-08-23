import { cn } from "@/lib/utils";
import { roleLabel } from "./types";

const ROLE_BADGE_CLASSES: Record<string, string> = {
  coordinator:
    "border-role-coordinator/35 bg-role-coordinator/10 text-role-coordinator",
  reviewer: "border-role-reviewer/35 bg-role-reviewer/10 text-role-reviewer",
  executor: "border-role-executor/35 bg-role-executor/10 text-role-executor",
  human: "border-role-human/60 bg-role-human/30 text-role-human-foreground",
};

/** 角色的可访问文字徽章:颜色只做辅助,文字始终直接呈现角色。 */
export function RoleBadge({
  role,
  className,
}: {
  role: string;
  className?: string;
}) {
  return (
    <span
      data-role={role}
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none",
        ROLE_BADGE_CLASSES[role] ??
          "border-border bg-muted text-muted-foreground",
        className,
      )}
    >
      {roleLabel(role) || role}
    </span>
  );
}
