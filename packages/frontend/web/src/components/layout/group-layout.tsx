import type { ReactNode } from "react";
import ContextPanel, { GroupContextPanelProvider } from "./context-panel";

/**
 * 群相关页面(消息页 / 成员页)的三栏布局壳:左栏 Sidebar(由 AppSidebar
 * 提供)+ 主区(children)+ 右栏上下文面板。非群页面不包此壳(两栏)。
 */
export default function GroupLayout({
  groupId,
  children,
}: {
  groupId: string;
  children: ReactNode;
}) {
  return (
    <GroupContextPanelProvider>
      <div className="flex h-[calc(100dvh-4rem)] w-full min-w-0">
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
        <ContextPanel groupId={groupId} />
      </div>
    </GroupContextPanelProvider>
  );
}
