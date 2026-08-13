import { Folder, ListChecks, Users } from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useIsDesktop } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { MembersTab } from "./context-panel/members-tab";
import { ProjectTab } from "./context-panel/project-tab";
import { TasksTab } from "./context-panel/tasks-tab";

/**
 * 右栏上下文面板(整体布局重构 enhancement):成员与分工 / 任务 / 项目三个
 * Tab 聚合群相关操作,减少页面跳转。响应式:
 *   - lg+(≥1024px):常驻 300px 右栏(三栏布局);
 *   - md(768-1023px):默认折叠,主区页头「上下文」按钮唤起为 overlay 抽屉;
 *   - <md(<768px):全屏 overlay(侧边栏行为不变)。
 * 开合状态由 GroupContextPanelProvider 提供,页面标题栏按钮与面板共享。
 */

type ContextPanelState = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

const GroupContextPanelContext = createContext<ContextPanelState | null>(null);

/** 右栏开合状态。无 Provider(如页面单独渲染)时返回安全 no-op。 */
export function useGroupContextPanel(): ContextPanelState {
  const ctx = useContext(GroupContextPanelContext);
  return ctx ?? { open: false, setOpen: () => {} };
}

/** 提供右栏开合状态,由布局壳(GroupLayout)包住页面与右栏。 */
export function GroupContextPanelProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <GroupContextPanelContext.Provider value={{ open, setOpen }}>
      {children}
    </GroupContextPanelContext.Provider>
  );
}

/** 主区页头的「上下文」按钮(lg+ 常驻右栏,按钮隐藏)。 */
export function ContextPanelTrigger() {
  const { setOpen } = useGroupContextPanel();
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="上下文"
      title="上下文"
      onClick={() => setOpen(true)}
      className="shrink-0 gap-1 lg:hidden"
    >
      <ListChecks className="size-4" />
      <span className="hidden sm:inline">上下文</span>
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
  const { open, setOpen } = useGroupContextPanel();
  const tabs = <PanelTabs groupId={groupId} />;

  if (isDesktop) {
    // lg+ 常驻右栏:三栏布局的一部分,不随开合状态变化。
    return (
      <aside
        data-testid="context-panel"
        className="hidden h-full w-[300px] shrink-0 border-l bg-background lg:flex"
      >
        {tabs}
      </aside>
    );
  }

  // md/<md:Sheet overlay —— <768 全屏,md 起 300px 抽屉。
  return (
    <Sheet open={open} onOpenChange={setOpen}>
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
