import { Separator } from "@radix-ui/react-separator";
import { Bot, Command, LifeBuoy, Send, Users } from "lucide-react";
import type * as React from "react";
import { useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { t } from "@/lib/i18n";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../ui/breadcrumb";
import { ConversationList } from "./conversations";
import { NavMain } from "./nav-main";
import { NavSecondary } from "./nav-secondary";
import { ThemeToggle } from "./theme-toggle";

function useNavData() {
  // t() 每次调用按当前语言解析
  return {
    navMain: [
      { title: t("sidebar.groups"), url: "/groups", icon: Users },
      { title: t("sidebar.participants"), url: "/participants", icon: Bot },
    ],
    navSecondary: [
      { title: t("sidebar.help"), url: "/help", icon: LifeBuoy },
      { title: t("sidebar.feedback"), url: "/feedback", icon: Send },
    ],
  };
}

export default function AppSidebar({
  children,
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const navData = useNavData();
  const [location] = useLocation();
  // 面包屑当前页:按路由映射,群组及其子页统一显示「群组」。
  const pageLabel = location.startsWith("/groups")
    ? "群组"
    : location.startsWith("/participants")
      ? "接入 Participant(参与者)"
      : "首页";

  return (
    <SidebarProvider>
      <Sidebar variant="inset" {...props}>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <a href="/groups">
                  <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                    <Command className="size-4" />
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">CoAgentHub</span>
                    <span className="truncate text-xs">局域网 AI 助手</span>
                  </div>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <NavMain items={navData.navMain} />
          {/* Ticket 23: WeChat-style active-group list with unread badges. It
              sits between the platform nav and the bottom links and scrolls
              independently when there are many groups. */}
          <ConversationList />
          <NavSecondary items={navData.navSecondary} />
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <ThemeToggle />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-[orientation=vertical]:h-4"
            />
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink href="/groups">CoAgentHub</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbItem>
                  <BreadcrumbPage>{pageLabel}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
