import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** A group-level marker for the participant composition, not an individual role. */
export function GroupCompositionBadge({
  memberRoles,
  className,
}: {
  memberRoles: string[];
  className?: string;
}) {
  const isThreeParty =
    memberRoles.includes("reviewer") && memberRoles.includes("coordinator");
  const label = isThreeParty
    ? t("groups.composition.three")
    : t("groups.composition.two");
  const accessibleLabel = isThreeParty
    ? t("groups.composition.threeAria")
    : t("groups.composition.twoAria");

  return (
    <span
      aria-label={accessibleLabel}
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none",
        isThreeParty
          ? "border-primary/35 bg-primary/10 text-primary"
          : "border-border bg-muted/60 text-muted-foreground opacity-75",
        className,
      )}
      data-composition={isThreeParty ? "three-party" : "two-party"}
      role="img"
      title={accessibleLabel}
    >
      {label}
    </span>
  );
}
