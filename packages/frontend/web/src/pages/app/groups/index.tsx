import {
  Archive,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  SearchX,
  Settings,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGroupsPage } from "@/hooks/use-groups-page";
import { useIdentityPanel } from "@/hooks/use-identity-panel";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { RoleBadge } from "./messages/types";

/**
 * Group list page (ticket 02): shows all groups with status and member
 * counts, lets the operator create a new group and archive finished ones.
 * The web viewer acts as a human participant: an identity (participant id) can
 * be selected at the top of the page, and every request carries it as
 * `X-Participant-Id` so the identity middleware treats the browser session as
 * that participant. All state and data fetching live in useGroupsPage — this
 * component only orchestrates the hook and renders the sections.
 */

/**
 * 相对时间(清单行右侧):把群创建时间格式化为「刚刚 / x 分钟前 / x 小时前 /
 * x 天前 / x 个月前 / x 年前」。跟随运行环境的默认 locale(与浏览器语言一致),
 * 不引入 dayjs 之类的新依赖。
 */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const diffMs = then - Date.now();
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const diffMin = Math.round(diffMs / 60_000);
  const absMin = Math.abs(diffMin);
  if (absMin < 60) {
    return rtf.format(diffMin, "minute");
  }
  const diffHour = Math.round(diffMin / 60);
  if (Math.abs(diffHour) < 24) {
    return rtf.format(diffHour, "hour");
  }
  const diffDay = Math.round(diffHour / 24);
  if (Math.abs(diffDay) < 30) {
    return rtf.format(diffDay, "day");
  }
  const diffMonth = Math.round(diffDay / 30);
  if (Math.abs(diffMonth) < 12) {
    return rtf.format(diffMonth, "month");
  }
  return rtf.format(Math.round(diffMonth / 12), "year");
}

export default function GroupsPage() {
  const {
    navigate,
    groups,
    loading,
    total,
    loadingMore,
    creating,
    newTitle,
    setNewTitle,
    editingTitleId,
    setEditingTitleId,
    titleDraft,
    setTitleDraft,
    savingTitle,
    error,
    message,
    statusFilter,
    setStatusFilter,
    searchQuery,
    setSearchQuery,
    debouncedQuery,
    previewFor,
    handleCreate,
    startRenameTitle,
    handleRenameTitle,
    handleArchive,
    handleRestore,
    handleDelete,
    loadMore,
  } = useGroupsPage();
  // 身份面板已搬去侧栏(IdentitySwitcher);本页仅保留「参与方设置」区,
  // 绑定状态与侧栏共享 useIdentityPanel(store 为唯一数据源)。
  const {
    boundParticipantId,
    participantInfo,
    settingsOpen,
    setSettingsOpen,
    nameInput,
    setNameInput,
    deviceInput,
    setDeviceInput,
    savingSettings,
    settingsMessage,
    settingsError,
    handleSaveSettings,
  } = useIdentityPanel();

  return (
    <div className="mx-auto w-full max-w-[1440px] p-4 sm:p-6">
      <div className="mb-6 flex flex-col gap-3">
        <div>
          <h2 className="text-xl font-semibold">{t("groups.title")}</h2>
          <p className="text-muted-foreground text-sm">
            {t("groups.subtitle")}
          </p>
        </div>
        {/* 群列表搜索(enhancement):按标题关键词过滤,输入防抖 300ms 后拉取;
            带清除按钮,清空恢复全量;下方显示当前结果数。 */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            placeholder={t("groups.search.placeholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label={t("groups.search.aria")}
            className="pl-9 pr-9"
          />
          {searchQuery && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSearchQuery("")}
              aria-label={t("groups.search.clearAria")}
              className="absolute right-1 top-1/2 -translate-y-1/2 p-1"
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {loading
            ? t("common.loading")
            : debouncedQuery
              ? t("groups.count.matched", {
                  count: groups.length,
                  query: debouncedQuery,
                })
              : t("groups.count.total", { count: groups.length })}
        </p>
      </div>

      {/* Participant 设置(ticket 20):绑定后可见,展示并编辑自己的注册信息 */}
      {boundParticipantId && participantInfo && (
        <div className="mb-6 rounded-lg border bg-card p-4">
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            className="flex w-full items-center justify-between text-sm font-medium"
            aria-expanded={settingsOpen}
          >
            <span className="inline-flex items-center gap-2">
              <Settings className="size-4" />
              {t("groups.settings.title")}
            </span>
            <span className="text-xs text-muted-foreground">
              {settingsOpen ? t("common.collapse") : t("common.expand")}
            </span>
          </button>
          {settingsOpen && (
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {t("groups.settings.name")}
                  {participantInfo.name}
                </span>
                <span>
                  {t("groups.settings.device")}
                  {participantInfo.device ?? "-"}
                </span>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  type="text"
                  placeholder={t("groups.settings.namePlaceholder")}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  aria-label={t("groups.settings.nameAria")}
                  className="sm:max-w-xs"
                />
                <Input
                  type="text"
                  placeholder={t("groups.settings.devicePlaceholder")}
                  value={deviceInput}
                  onChange={(e) => setDeviceInput(e.target.value)}
                  aria-label={t("groups.settings.deviceAria")}
                  className="sm:max-w-xs"
                />
                <Button
                  size="sm"
                  onClick={handleSaveSettings}
                  disabled={savingSettings}
                  className="shrink-0"
                >
                  {savingSettings ? t("common.saving") : t("common.save")}
                </Button>
              </div>
              {settingsMessage && (
                <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
                  {settingsMessage}
                </div>
              )}
              {settingsError && (
                <div className="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">
                  {settingsError}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Create group */}
      <div className="mb-6 flex flex-col gap-2 sm:flex-row">
        <Input
          id="group-title-input"
          placeholder={t("groups.create.placeholder")}
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              handleCreate();
            }
          }}
          aria-label={t("groups.create.aria")}
        />
        <Button
          onClick={handleCreate}
          disabled={creating || !newTitle.trim()}
          className="shrink-0"
        >
          <Plus />
          {creating ? t("common.creating") : t("groups.create.button")}
        </Button>
      </div>

      {message && (
        <div className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
          {message}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {/* Status filter tabs */}
      <div className="mb-4 flex gap-1 rounded-lg border bg-card p-1">
        {(
          [
            ["all", t("groups.filter.all")],
            ["active", t("groups.filter.active")],
            ["archived", t("groups.filter.archived")],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setStatusFilter(value)}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              statusFilter === value
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border bg-card shadow-sm">
        {groups.length === 0 ? (
          <div className="flex flex-col items-center gap-3 p-10 text-center text-sm text-muted-foreground">
            {loading ? (
              t("common.loading")
            ) : debouncedQuery ? (
              // 搜索无结果:与「暂无群组」区分开的空态文案。
              <>
                <SearchX className="size-8" />
                <p>{t("groups.empty.notFound")}</p>
              </>
            ) : (
              <>
                <Users className="size-8" />
                <p>
                  {statusFilter === "archived"
                    ? t("groups.empty.archived")
                    : statusFilter === "active"
                      ? t("groups.empty.active")
                      : t("groups.empty.all")}
                </p>
                {statusFilter === "all" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      document.getElementById("group-title-input")?.focus()
                    }
                  >
                    <Plus />
                    {t("groups.empty.createCta")}
                  </Button>
                )}
              </>
            )}
          </div>
        ) : (
          <>
            {/* 群列表:单套自适应清单行(窄屏/宽屏共用,不再有双套实现)。
                一行 = 状态圆点 + 群名(可进入/行内改名) + 摘要行 + 相对时间;
                操作按钮收敛为纯图标,桌面端 hover 行时显现(移动端无 hover,常显)。 */}
            <ul data-testid="groups-list" className="flex flex-col gap-1 p-3">
              {groups.map((group) => (
                <li
                  key={group.id}
                  className="group flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-3 transition-colors hover:bg-muted/60"
                >
                  {/* 状态圆点:active 用 --status-running + 淡色光晕(同 RequirementStepper
                      running 手法),archived 用中性灰 --border。 */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-[7px] shrink-0 rounded-full",
                      group.status === "active"
                        ? "bg-status-running ring-4 ring-status-running/25 animate-pulse motion-reduce:animate-none"
                        : "bg-border",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    {editingTitleId === group.id ? (
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Input
                          autoFocus
                          value={titleDraft}
                          onChange={(e) => setTitleDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              void handleRenameTitle();
                            } else if (e.key === "Escape") {
                              setEditingTitleId(null);
                            }
                          }}
                          aria-label={t("groups.renameInputAria")}
                          className="h-8 flex-1"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={savingTitle || !titleDraft.trim()}
                          onClick={() => void handleRenameTitle()}
                        >
                          {savingTitle
                            ? t("common.saving")
                            : t("groups.renameSave")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingTitleId(null)}
                        >
                          {t("groups.renameCancel")}
                        </Button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-left text-sm font-medium hover:underline"
                        onClick={() => navigate(`/groups/${group.id}`)}
                      >
                        <span className="truncate">{group.title}</span>
                        <Pencil
                          data-testid={`rename-title-${group.id}`}
                          className="size-3.5 shrink-0 text-muted-foreground hover:text-foreground"
                          onClick={(e) => {
                            e.stopPropagation();
                            startRenameTitle(group);
                          }}
                          aria-label={t("groups.renameAria")}
                        />
                      </button>
                    )}
                    {/* 摘要行:成员数 + 最近消息预览(需求维度摘要留待后续票,当前接口无该数据)。 */}
                    <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                      <span className="shrink-0">
                        {t("groups.memberCount", { count: group.memberCount })}
                      </span>
                      {group.memberRoles && (
                        <span
                          data-testid={`group-mode-${group.id}`}
                          className="inline-flex items-center gap-1"
                        >
                          {group.memberRoles.includes("reviewer") &&
                          group.memberRoles.includes("coordinator") ? (
                            <>
                              <RoleBadge role="coordinator" />
                              <RoleBadge role="reviewer" />
                              <span className="sr-only">三层协作</span>
                            </>
                          ) : (
                            <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                              两层协作
                            </span>
                          )}
                        </span>
                      )}
                      {previewFor(group) && (
                        <span className="min-w-0 truncate">
                          {previewFor(group)}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* 相对时间:当前数据仅有群创建时间 createdAt,先用它。 */}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTime(group.createdAt)}
                  </span>
                  {/* 操作(成员管理/归档|恢复/删除):图标化收敛;桌面端 hover 行时显现,
                      键盘焦点移入(focus-within)同样显现;移动端无 hover 保持常显。 */}
                  <div className="flex shrink-0 items-center gap-0.5 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("groups.members.manage")}
                      title={t("groups.members.manage")}
                      onClick={() => navigate(`/groups/${group.id}/settings`)}
                    >
                      <Users />
                    </Button>
                    {group.status === "active" ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("groups.archive")}
                        title={t("groups.archive")}
                        onClick={() => handleArchive(group)}
                      >
                        <Archive />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("groups.restore")}
                        title={t("groups.restore")}
                        onClick={() => handleRestore(group)}
                      >
                        <RotateCcw />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("common.delete")}
                      title={t("common.delete")}
                      className="text-red-600 hover:text-red-700"
                      onClick={() => handleDelete(group)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            {/* 分页:还有更多时才显示「加载更多」,加载中禁用防重复点击 */}
            {groups.length > 0 && groups.length < total && (
              <div className="flex justify-center border-t p-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? t("common.loading") : t("groups.loadMore")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
