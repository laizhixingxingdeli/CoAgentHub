import * as Sentry from "@sentry/react";
import { lazy, Suspense } from "react";
import { Redirect, Route, Switch } from "wouter";
import GroupLayout from "./components/layout/group-layout";
import AppSidebar from "./components/sidebar";
import { Button } from "./components/ui/button";
import { Skeleton } from "./components/ui/skeleton";

// 路由级 code-split:页面组件按需加载,首屏只取当前路由的 chunk。
// 布局(sidebar/layout)保持静态 import,首屏必需。
const ParticipantsPage = lazy(() => import("./pages/app/participants"));
const HelpPage = lazy(() => import("./pages/app/help"));
const FeedbackPage = lazy(() => import("./pages/app/feedback"));
const GroupsPage = lazy(() => import("./pages/app/groups"));
const GroupMembersPage = lazy(() => import("./pages/app/groups/members"));
const GroupMessagesPage = lazy(() => import("./pages/app/groups/messages"));

// Suspense fallback:轻量骨架占位,复用项目已有 Skeleton,不引入新依赖。
const pageFallback = (
  <div className="flex h-full w-full items-center justify-center p-8">
    <Skeleton className="h-6 w-48" />
  </div>
);

const App = () => (
  <>
    {/* 
      Routes below are matched exclusively -
      the first matched route gets rendered
    */}
    <Switch>
      <Route path="/">
        <Redirect to="/groups" />
      </Route>

      <AppSidebar>
        {/*
          Routes below are matched exclusively. The 404 catch-all must live
          INSIDE the sidebar group: the outer Switch matches <AppSidebar>
          (a pathless child matches every route), so any sibling 404 route
          at the top level would never be reached.
        */}
        {/* 路由级错误边界:chunk 加载失败(如部署后旧 chunk 被回收)只影响当前
            页面区域,不冒泡到根级边界整页替换;fallback 提供重试(重置后重新
            走 lazy import)。 */}
        <Sentry.ErrorBoundary
          fallback={({ resetError }) => (
            <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8">
              <p className="text-sm text-muted-foreground">页面加载失败</p>
              <Button variant="outline" size="sm" onClick={resetError}>
                重试
              </Button>
            </div>
          )}
        >
          <Suspense fallback={pageFallback}>
            <Switch>
              {/* /participants 与 /groups 一样平铺声明:避免 wouter v3 nest 的 base
                前缀导致页面内绝对路径失配(见下方 /groups 注释)。 */}
              {/* /agents 是术语改名前的旧路由(agent 为 participant 的旧名):
                  重定向到 /participants,收藏夹里的旧链接不 404。 */}
              <Route path="/agents">
                <Redirect to="/participants" />
              </Route>
              {/* /files 已从 UI 移除(文件信令保留在 API 层):旧链接重定向到群列表。 */}
              <Route path="/files">
                <Redirect to="/groups" />
              </Route>
              <Route path="/participants" component={ParticipantsPage} />
              <Route path="/help" component={HelpPage} />
              <Route path="/feedback" component={FeedbackPage} />
              {/* /groups routes are declared flat (no `nest`): wouter v3 nested
                Routes wrap children in a Router with base="/groups", which
                base-strips the location — any full-path useRoute("/groups/:id")
                or navigate("/groups/...") inside would then fail to match or
                produce /groups/groups/<id>. Flat routes keep base="" so the
                pages' absolute paths work as written. */}
              <Route path="/groups" component={GroupsPage} />
              {/* 群相关路由(消息/成员)包上带右栏的布局(三栏);其它路由保持两栏。
                wouter v3 的 component 会收到 { params },据此取 groupId 传给右栏。 */}
              <Route
                path="/groups/:id"
                component={({ params }: { params: { id: string } }) => (
                  <GroupLayout groupId={params.id}>
                    <GroupMessagesPage />
                  </GroupLayout>
                )}
              />
              <Route
                path="/groups/:id/members"
                component={({ params }: { params: { id: string } }) => (
                  <GroupLayout groupId={params.id}>
                    <GroupMembersPage />
                  </GroupLayout>
                )}
              />
              <Route path="/:rest*">404:页面不存在</Route>
            </Switch>
          </Suspense>
        </Sentry.ErrorBoundary>
      </AppSidebar>
    </Switch>
  </>
);

export default App;
