import {
  ChevronRight,
  Folder,
  ListChecks,
  PanelRight,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useIsDesktop } from "@/hooks/use-mobile";
import {
  readStoredPanelOpen,
  useContextPanelStore,
} from "@/lib/stores/context-panel";
import { cn } from "@/lib/utils";
import { MembersTab } from "./context-panel/members-tab";
import { ProjectTab } from "./context-panel/project-tab";
import { TasksTab } from "./context-panel/tasks-tab";

/**
 * 右栏上下文面板(布局重构 enhancement + 右栏可用性 enhancement):成员与
 * 分工 / 任务 / 项目三个 Tab 聚合群相关操作,减少页面跳转。响应式:
 *   - lg+(≥1024px):常驻 300px 右栏,可收起(标题栏「面板」开关),
 *     开合状态存 localStorage(coagenthub.contextPanelOpen);
 *   - md(768-1023px):默认折叠,主区页头「面板」按钮唤起为 overlay 抽屉;
 *   - <md(<768px):全屏 overlay(侧边栏行为不变)。
 * 开合状态由 useContextPanelStore 提供,页面标题栏按钮与面板共享
 * (迁移自原 GroupContextPanelProvider 的 context,行为不变)。
 */

/** lg+ 右栏开合的持久化键(收起后刷新保持)。 */
export { CONTEXT_PANEL_OPEN_KEY } from "@/lib/stores/context-panel";

type ContextPanelState = {
  /** lg+ 右栏是否展开(持久化);<lg 时仅反映偏好,驱动标题栏图标。 */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** <lg overlay 抽屉是否打开(临时,不持久化)。 */
  overlayOpen: boolean;
  setOverlayOpen: (open: boolean) => void;
};

/** 右栏开合状态,直接来自全局 store(单例,无需 Provider)。 */
export function useGroupContextPanel(): ContextPanelState {
  const open = useContextPanelStore((s) => s.open);
  const setOpen = useContextPanelStore((s) => s.setOpen);
  const overlayOpen = useContextPanelStore((s) => s.overlayOpen);
  const setOverlayOpen = useContextPanelStore((s) => s.setOverlayOpen);
  return { open, setOpen, overlayOpen, setOverlayOpen };
}

/** 兼容壳:开合状态已移入全局 store。挂载时按 localStorage 重新初始化
 * (等价于原 context 实现每次挂载独立 useState 初始化 —— 同文件多次渲染/
 * 测试间状态互不泄漏),之后由全局 store 驱动。 */
export function GroupContextPanelProvider({
  children,
}: {
  children: ReactNode;
}) {
  useEffect(() => {
    useContextPanelStore.setState({
      open: readStoredPanelOpen(),
      overlayOpen: false,
    });
  }, []);
  return <>{children}</>;
}

/** 主区页头的「面板」开关:lg+ 开合右栏;<lg 唤起 overlay 抽屉。
 * 面板展开时显示收起图标(ChevronRight),收起时显示 PanelRight。 */
export function ContextPanelTrigger() {
  const { open, setOpen, setOverlayOpen } = useGroupContextPanel();
  const isDesktop = useIsDesktop();
  const expanded = isDesktop && open;
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={expanded ? "收起面板" : "打开面板"}
      title={expanded ? "收起面板" : "打开面板"}
      onClick={() => (isDesktop ? setOpen(!open) : setOverlayOpen(true))}
      className="shrink-0 gap-1"
    >
      {expanded ? (
        <ChevronRight className="size-4" />
      ) : (
        <PanelRight className="size-4" />
      )}
      <span className="hidden sm:inline">面板</span>
    </Button>
  );
}

const TABS = [
  { id: "members", label: "成员与分工", icon: Users },
  { id: "tasks", label: "任务", icon: ListChecks },
  { id: "project", label: "项目", icon: Folder },
] as const;

type TabId = (typeof TABS)[number]["id"];

function PanelTabs({ groupId }: { groupId: string }) {
  const [tab, setTab] = useState<TabId>("members");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="上下文面板"
        className="flex shrink-0 border-b"
      >
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`context-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              className={cn(
                "inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 border-b-2 px-2 py-2.5 text-xs font-medium transition-colors",
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate">{t.label}</span>
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "members" && <MembersTab groupId={groupId} />}
        {tab === "tasks" && <TasksTab groupId={groupId} />}
        {tab === "project" && <ProjectTab groupId={groupId} />}
      </div>
    </div>
  );
}

export default function ContextPanel({ groupId }: { groupId: string }) {
  const isDesktop = useIsDesktop();
  const { open, overlayOpen, setOverlayOpen } = useGroupContextPanel();
  const tabs = <PanelTabs groupId={groupId} />;

  if (isDesktop) {
    // lg+ 常驻右栏:open=false(收起)时整体隐藏、主区占满;开合统一经标题栏
    // 「面板」开关(Ticket 44:移除原头部折叠按钮,入口只保留一个)。
    if (!open) {
      return null;
    }
    return (
      <aside
        data-testid="context-panel"
        className="hidden h-full w-[300px] shrink-0 flex-col border-l bg-background lg:flex"
      >
        <div className="min-h-0 flex-1">{tabs}</div>
      </aside>
    );
  }

  // md/<md:Sheet overlay —— <768 全屏,md 起 300px 抽屉。
  return (
    <Sheet open={overlayOpen} onOpenChange={setOverlayOpen}>
      <SheetContent
        side="right"
        className="w-full p-0 md:w-[300px]"
        data-testid="context-panel-sheet"
      >
        {tabs}
      </SheetContent>
    </Sheet>
  );
}
