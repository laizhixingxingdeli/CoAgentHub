import { Redirect, Route, Switch } from "wouter";
import AppSidebar from "./components/sidebar";
import AgentsPage from "./pages/app/agents";
import FilesPage from "./pages/app/files";
import GroupsPage from "./pages/app/groups";
import GroupMembersPage from "./pages/app/groups/members";
import GroupMessagesPage from "./pages/app/groups/messages";

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
        <Switch>
          <Route path="/files" component={FilesPage} />
          {/* /agents 与 /groups 一样平铺声明:避免 wouter v3 nest 的 base
              前缀导致页面内绝对路径失配(见下方 /groups 注释)。 */}
          <Route path="/agents" component={AgentsPage} />
          {/* /groups routes are declared flat (no `nest`): wouter v3 nested
              Routes wrap children in a Router with base="/groups", which
              base-strips the location — any full-path useRoute("/groups/:id")
              or navigate("/groups/...") inside would then fail to match or
              produce /groups/groups/<id>. Flat routes keep base="" so the
              pages' absolute paths work as written. */}
          <Route path="/groups" component={GroupsPage} />
          <Route path="/groups/:id" component={() => <GroupMessagesPage />} />
          <Route
            path="/groups/:id/members"
            component={() => <GroupMembersPage />}
          />
          <Route path="/:rest*">404:页面不存在</Route>
        </Switch>
      </AppSidebar>
    </Switch>
  </>
);

export default App;
