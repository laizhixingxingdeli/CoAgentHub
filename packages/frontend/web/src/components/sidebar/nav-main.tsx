import type { LucideIcon } from "lucide-react";
import { useLocation } from "wouter";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

/** Whether the nav item covers the current route. /groups 及其子路由
 *  (/groups/:id、/groups/:id/members)统一高亮「群组」,其余项精确匹配。 */
function itemIsActive(url: string, location: string): boolean {
  return location === url || location.startsWith(`${url}/`);
}

export function NavMain({
  items,
}: {
  items: {
    title: string;
    url: string;
    icon: LucideIcon;
    items?: {
      title: string;
      url: string;
    }[];
  }[];
}) {
  const [location] = useLocation();

  return (
    <SidebarGroup>
      <SidebarGroupLabel>平台</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const active = itemIsActive(item.url, location);
          return (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton asChild tooltip={item.title} isActive={active}>
                <a href={item.url}>
                  <item.icon />
                  <span>{item.title}</span>
                </a>
              </SidebarMenuButton>
              {item.items?.length ? (
                <ul className="mt-1 space-y-0.5">
                  {item.items.map((subItem) => (
                    <li key={subItem.title}>
                      <a
                        href={subItem.url}
                        className="text-muted-foreground hover:text-foreground block rounded-md px-6 py-1.5 text-sm"
                      >
                        {subItem.title}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}
