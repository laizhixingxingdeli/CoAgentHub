import {
  Archive,
  KeyRound,
  MessageSquare,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  SearchX,
  Settings,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGroupsPage } from "@/hooks/use-groups-page";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./status-badge";

/**
 * Group list page (ticket 02): shows all groups with status and member
 * counts, lets the operator create a new group and archive finished ones.
 * The web viewer acts as a human participant: an identity (participant id) can
 * be selected at the top of the page, and every request carries it as
 * `X-Participant-Id` so the identity middleware treats the browser session as
 * that participant. All state and data fetching live in useGroupsPage — this
 * component only orchestrates the hook and renders the sections.
 */
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
    boundParticipantId,
    identityInput,
    setIdentityInput,
    participantInfo,
    settingsOpen,
    setSettingsOpen,
    nameInput,
    setNameInput,
    deviceInput,
    setDeviceInput,
    savingSettings,
    registerOpen,
    setRegisterOpen,
    regName,
    setRegName,
    regDevice,
    setRegDevice,
    registering,
    participants,
    participantsLoading,
    participantsError,
    handleSaveIdentity,
    handleClearIdentity,
    handleBind,
    handleRegister,
    handleSaveSettings,
    handleCreate,
    startRenameTitle,
    handleRenameTitle,
    handleArchive,
    handleRestore,
    handleDelete,
    loadMore,
    currentParticipant,
  } = useGroupsPage();

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

      {/* 身份面板(ticket 29):当前身份 + 已有 Participant 选择 + 手动输入 id + 注册 */}
      <div className="mb-6 rounded-lg border bg-card">
        {/* ① 当前身份:已绑定显示「使用中: name(typedevice)」,未绑定提示 */}
        <div className="border-b px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            {boundParticipantId ? (
              <span className="inline-flex min-w-0 items-center gap-2 text-sm font-medium">
                <KeyRound className="size-4 shrink-0" />
                <span className="truncate">
                  {t("groups.identity.inUse")}{" "}
                  {currentParticipant
                    ? `${currentParticipant.name}${
                        currentParticipant.device
                          ? `(${currentParticipant.device})`
                          : ""
                      }`
                    : t("groups.identity.bound")}
                </span>
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">
                {t("groups.identity.unbound")}
              </span>
            )}
            {boundParticipantId && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleClearIdentity}
                className="shrink-0"
              >
                {t("common.clear")}
              </Button>
            )}
          </div>
        </div>

        {/* ② 已有 Participant 列表:选择身份(全信模型,声明即绑定,无服务端调用) */}
        <div className="border-b px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">
              {t("groups.identity.existing")}
            </span>
            <span className="text-xs text-muted-foreground">
              {participantsLoading
                ? t("common.loading")
                : t("groups.identity.count", { count: participants.length })}
            </span>
          </div>
          {participantsError && (
            <p className="mb-2 text-xs text-red-600">{participantsError}</p>
          )}
          {participants.length === 0 && !participantsLoading ? (
            <p className="text-sm text-muted-foreground">
              {t("groups.identity.empty")}
            </p>
          ) : (
            <ul className="max-h-48 space-y-1 overflow-y-auto pr-1">
              {participants.map((participant) => {
                const isBound = participant.id === boundParticipantId;
                return (
                  <li
                    key={participant.id}
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm">{participant.name}</div>
                      {participant.device && (
                        <div className="truncate text-xs text-muted-foreground">
                          {participant.device}
                        </div>
                      )}
                    </div>
                    {isBound ? (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
                        {t("common.inUse")}
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleBind(participant)}
                        className="shrink-0"
                      >
                        {t("common.use")}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ③ 手动输入 participant id(全信模型:任意声称的 id 都被接受) */}
        <div className="border-b px-4 py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              type="text"
              placeholder={t("groups.identity.inputPlaceholder")}
              value={identityInput}
              onChange={(e) => setIdentityInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSaveIdentity();
                }
              }}
              aria-label={t("groups.identity.inputAria")}
              className="sm:max-w-xs"
            />
            <Button
              size="sm"
              onClick={handleSaveIdentity}
              disabled={!identityInput.trim()}
              className="shrink-0"
            >
              {t("groups.identity.bind")}
            </Button>
          </div>
        </div>

        {/* ④ 注册新 Participant(ticket 28):替代终端 curl 注册;成功即自动绑定并切换身份 */}
        <div className="border-t px-4 py-3">
          <button
            type="button"
            onClick={() => setRegisterOpen((v) => !v)}
            className="flex w-full items-center justify-between text-sm font-medium"
            aria-expanded={registerOpen}
          >
            <span className="inline-flex items-center gap-2">
              <UserPlus className="size-4" />
              {t("groups.identity.register")}
            </span>
            <span className="text-xs text-muted-foreground">
              {registerOpen ? t("common.collapse") : t("common.expand")}
            </span>
          </button>
          {registerOpen && (
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  type="text"
                  placeholder={t("groups.identity.regNamePlaceholder")}
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleRegister();
                    }
                  }}
                  aria-label={t("groups.identity.regNameAria")}
                  className="sm:max-w-xs"
                />
                <Input
                  type="text"
                  placeholder={t("groups.identity.regDevicePlaceholder")}
                  value={regDevice}
                  onChange={(e) => setRegDevice(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleRegister();
                    }
                  }}
                  aria-label={t("groups.identity.regDeviceAria")}
                  className="sm:max-w-xs"
                />
                <Button
                  size="sm"
                  onClick={handleRegister}
                  disabled={registering}
                  className="shrink-0"
                >
                  {registering
                    ? t("groups.identity.registering")
                    : t("groups.identity.registerButton")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("groups.identity.registerHint")}
              </p>
            </div>
          )}
        </div>
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
            {/* Mobile: card list */}
            <div className="flex flex-col gap-3 p-3 md:hidden">
              {groups.map((group) => (
                <div
                  key={group.id}
                  className="flex flex-col gap-2 rounded-lg border bg-card p-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    {editingTitleId === group.id ? (
                      <div className="flex min-w-0 flex-1 items-center gap-1.5">
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
                        className="flex min-w-0 flex-1 items-center gap-1 truncate text-left text-sm font-medium hover:underline"
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
                    <StatusBadge status={group.status} />
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Users className="size-3.5" />
                      {t("groups.memberCount", { count: group.memberCount })}
                    </span>
                    {previewFor(group) && (
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <MessageSquare className="size-3.5 shrink-0" />
                        <span className="truncate">{previewFor(group)}</span>
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => navigate(`/groups/${group.id}/members`)}
                    >
                      {t("groups.members.manage")}
                    </Button>
                    {group.status === "active" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => handleArchive(group)}
                      >
                        <Archive />
                        {t("groups.archive")}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => handleRestore(group)}
                      >
                        <RotateCcw />
                        {t("groups.restore")}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-red-600 hover:text-red-700"
                      onClick={() => handleDelete(group)}
                    >
                      <Trash2 />
                      {t("common.delete")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {/* Desktop: table */}
            <table className="hidden w-full text-sm md:table">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">
                    {t("groups.table.name")}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    {t("groups.table.status")}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    {t("groups.table.members")}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    {t("groups.table.lastMessage")}
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    {t("groups.table.actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.id} className="border-b last:border-0">
                    <td className="px-4 py-3">
                      {editingTitleId === group.id ? (
                        <div className="flex items-center gap-1.5">
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
                            className="h-8 w-56"
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
                        <span className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            className="font-medium hover:underline"
                            onClick={() => navigate(`/groups/${group.id}`)}
                          >
                            {group.title}
                          </button>
                          <Pencil
                            data-testid={`rename-title-${group.id}`}
                            className="size-3.5 shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                            onClick={() => startRenameTitle(group)}
                            aria-label={t("groups.renameAria")}
                          />
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={group.status} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {group.memberCount}
                    </td>
                    <td className="max-w-56 px-4 py-3 text-muted-foreground">
                      <span className="block truncate">
                        {previewFor(group) ?? t("common.noMessages")}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            navigate(`/groups/${group.id}/members`)
                          }
                        >
                          <Users />
                          {t("groups.members.manage")}
                        </Button>
                        {group.status === "active" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleArchive(group)}
                          >
                            <Archive />
                            {t("groups.archive")}
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRestore(group)}
                          >
                            <RotateCcw />
                            {t("groups.restore")}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:text-red-700"
                          onClick={() => handleDelete(group)}
                        >
                          <Trash2 />
                          {t("common.delete")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
