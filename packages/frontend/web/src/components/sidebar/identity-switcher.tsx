import { ChevronsUpDown, KeyRound, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { useIdentityPanel } from "@/hooks/use-identity-panel";
import { t } from "@/lib/i18n";

/**
 * 侧栏身份切换器(ticket 29 搬家):群组页顶部的身份面板收敛为侧栏底部一行,
 * 收起态只显示当前绑定身份(未绑定显示提示),点开才弹出完整的切换/管理能力:
 * ① 当前身份 + 清除 ② 已有参与方列表(点即绑定) ③ 手动输入 id 绑定
 * ④ 注册新参与方(二级展开)。
 *
 * 展开态用 DropdownMenu(向右弹出):侧栏只有约 224px 宽,四个子区在栏内纵向
 * 展开会挤压导航;Radix DropdownMenu 的 Content 自带 Portal + 可用高度上限 +
 * 滚动,是现成组件里最适合「从窄侧栏向主区弹出」的选型,不引入新依赖。
 */
export function IdentitySwitcher() {
  const {
    boundParticipantId,
    identityInput,
    setIdentityInput,
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
    message,
    error,
    handleSaveIdentity,
    handleClearIdentity,
    handleBind,
    handleRegister,
    currentParticipant,
  } = useIdentityPanel();

  // 收起态显示名:名册里能找到 → name(device);刚绑定还没拉到名册 → 裸 id;
  // 未绑定 → 提示文案。
  const displayName = currentParticipant
    ? `${currentParticipant.name}${
        currentParticipant.device ? `(${currentParticipant.device})` : ""
      }`
    : boundParticipantId || t("sidebar.identity.unbound");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="sm" aria-label={t("sidebar.identity.aria")}>
          <KeyRound className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">{displayName}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        sideOffset={12}
        align="start"
        className="w-72 p-1"
      >
        {/* ① 当前身份:已绑定显示「使用中: name(device)」,未绑定提示 */}
        <div className="flex items-center justify-between gap-2 border-b px-2 py-2">
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

        {/* ② 已有 Participant 列表:选择身份(全信模型,声明即绑定,无服务端调用) */}
        <div className="border-b px-2 py-2">
          <div className="mb-1.5 flex items-center justify-between">
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
            <p className="mb-1.5 text-xs text-red-600">{participantsError}</p>
          )}
          {participants.length === 0 && !participantsLoading ? (
            <p className="text-sm text-muted-foreground">
              {t("groups.identity.empty")}
            </p>
          ) : (
            <ul className="max-h-44 space-y-1 overflow-y-auto pr-1">
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
        <div className="border-b px-2 py-2">
          <div className="flex flex-col gap-2">
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
            />
            <Button
              size="sm"
              onClick={handleSaveIdentity}
              disabled={!identityInput.trim()}
              className="self-end"
            >
              {t("groups.identity.bind")}
            </Button>
          </div>
        </div>

        {/* ④ 注册新 Participant(ticket 28):替代终端 curl 注册;成功即自动绑定并切换身份 */}
        <div className="px-2 py-2">
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
            <div className="mt-2 flex flex-col gap-2">
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
              />
              <Button
                size="sm"
                onClick={handleRegister}
                disabled={registering}
                className="self-end"
              >
                {registering
                  ? t("groups.identity.registering")
                  : t("groups.identity.registerButton")}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t("groups.identity.registerHint")}
              </p>
            </div>
          )}
        </div>

        {/* 身份区反馈(切换/注册/清除) */}
        {message && (
          <div className="mx-1 mb-1 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
            {message}
          </div>
        )}
        {error && (
          <div className="mx-1 mb-1 rounded-md border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
