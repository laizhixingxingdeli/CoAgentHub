import { Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { syncUnreadConnection, useUnread } from "@/hooks/use-unread";
import { agentAuthHeaders } from "@/lib/api-client";
import { colorForId } from "@/lib/avatar-color";
import { cn } from "@/lib/utils";

/** Active-group row shape from GET /api/groups?status=active (ticket 23). */
type ConversationItem = {
  id: string;
  title: string;
  status: "active" | "archived";
  memberCount: number;
  createdAt: string;
};

/** 微信/QQ-style preview: clip to ~12 characters. */
function truncatePreview(body: string): string {
  return body.length > 12 ? `${body.slice(0, 12)}…` : body;
}

/**
 * Sidebar conversation list (ticket 23): the active groups as a WeChat-style
 * list with a last-message preview and a live unread badge.
 *
 * The list itself is fetched on mount and re-fetched on every navigation —
 * previews intentionally update on reload/navigation only (no per-frame
 * refetch); the unread badge is driven in real time by the global store's WS
 * connection. Fetch failures are silent: a missing/invalid agent token must
 * never block the rest of the sidebar.
 *
 * The always-mounted section also owns `activeGroupId` in the unread store
 * (it reads the current route), so entering/leaving a group clears its badge
 * and the resident WS picks up a token bound on the groups page.
 */
export function ConversationList() {
  const [location, navigate] = useLocation();
  // Match /groups/:id and its subroutes (/groups/:id/members) so the highlight
  // and activeGroupId stay on the group while its members page is open.
  const routeGroupId = location.match(/^\/groups\/([^/]+)/)?.[1] ?? null;
  const { unread, lastMessageByGroup, markRead, setActiveGroupId } =
    useUnread();

  // null = not loaded yet (or the fetch failed/unauthorized) — keep silent.
  const [groups, setGroups] = useState<ConversationItem[] | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation pulse — refetch the list when the route changes (location deliberately watched)
  useEffect(() => {
    let cancelled = false;
    // Navigation pulse: a token bound on the groups page (same-tab localStorage
    // writes fire no event) starts the unread store's resident socket here.
    syncUnreadConnection();
    (async () => {
      try {
        const res = await fetch("/api/groups?status=active", {
          headers: agentAuthHeaders(),
        });
        if (!res.ok) {
          return; // silent: token missing/invalid or server error
        }
        const data = (await res.json()) as {
          items: ConversationItem[];
          total: number;
        };
        if (!cancelled) {
          setGroups(data.items);
        }
      } catch {
        // silent
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [location]);

  useEffect(() => {
    setActiveGroupId(routeGroupId);
  }, [routeGroupId, setActiveGroupId]);

  const handleOpen = (groupId: string) => {
    markRead(groupId);
    navigate(`/groups/${groupId}`);
  };

  return (
    <SidebarGroup className="flex min-h-0 flex-1 flex-col">
      <SidebarGroupLabel>会话</SidebarGroupLabel>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups === null ? null : groups.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-2 py-4 text-center text-muted-foreground">
            <Users className="size-5" />
            <p className="text-xs">还没有群组</p>
          </div>
        ) : (
          <SidebarMenu>
            {groups.map((group) => {
              const unreadCount = unread.get(group.id) ?? 0;
              const preview = lastMessageByGroup.get(group.id)?.body ?? null;
              return (
                <SidebarMenuItem key={group.id}>
                  <SidebarMenuButton
                    asChild
                    isActive={routeGroupId === group.id}
                    className="h-auto py-2"
                  >
                    <a
                      href={`/groups/${group.id}`}
                      onClick={(event) => {
                        event.preventDefault();
                        handleOpen(group.id);
                      }}
                    >
                      {/* Ticket 33: 群首字圆标(类微信群头像),背景色按群 id 哈希取色 */}
                      <span
                        className={cn(
                          "flex size-8 shrink-0 select-none items-center justify-center rounded-full text-sm font-semibold",
                          colorForId(group.id),
                        )}
                      >
                        {group.title.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="grid min-w-0 flex-1 gap-0.5 text-left">
                        <span className="truncate text-sm">{group.title}</span>
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                            {preview ? truncatePreview(preview) : "暂无消息"}
                          </span>
                          {unreadCount > 0 && (
                            <span className="bg-red-500 text-white flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-medium tabular-nums">
                              {unreadCount > 99 ? "99+" : unreadCount}
                            </span>
                          )}
                        </span>
                      </span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        )}
      </div>
    </SidebarGroup>
  );
}
