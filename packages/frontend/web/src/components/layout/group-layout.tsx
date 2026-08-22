import type { ReactNode } from "react";
import { useMessagesPage } from "@/hooks/use-messages-page";

/**
 * 群相关页面的布局壳。消息订阅在这里常驻，使设置页或其它群子路由切换时
 * 不会丢失 WebSocket 与桌面通知；群页面本身只负责渲染主区内容。
 */
export default function GroupLayout({
  groupId,
  children,
}: {
  groupId: string;
  children: ReactNode;
}) {
  useMessagesPage(groupId);
  return (
    <div className="flex h-[calc(100dvh-4rem)] w-full min-w-0">
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
