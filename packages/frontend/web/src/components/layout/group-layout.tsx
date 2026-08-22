import type { ReactNode } from "react";
import { GroupHeaderContext, useGroupHeader } from "@/hooks/use-group-header";
import ContextPanel, { GroupContextPanelProvider } from "./context-panel";

/**
 * 群相关页面(消息页 / 成员页)的三栏布局壳:左栏 Sidebar(由 AppSidebar
 * 提供)+ 主区(children)+ 右栏上下文面板。非群页面不包此壳(两栏)。
 *
 * 头部数据(群标题/状态/改名)由本壳持有唯一实例并经 context 共享:页面标题栏
 * 与右栏消息 Tab 消费同一份,避免重复 GET 与改名后状态分叉。
 */
export default function GroupLayout({
  groupId,
  children,
}: {
  groupId: string;
  children: ReactNode;
}) {
  const header = useGroupHeader(groupId);
  return (
    <GroupContextPanelProvider>
      <GroupHeaderContext.Provider value={header}>
        <div className="flex h-[calc(100dvh-4rem)] w-full min-w-0">
          <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
          <ContextPanel groupId={groupId} />
        </div>
      </GroupHeaderContext.Provider>
    </GroupContextPanelProvider>
  );
}
