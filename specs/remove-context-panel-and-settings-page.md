# Spec: 删除右栏,群设置并入一页

> **状态**: Ready for Implementation
> **版本**: 1.1
> **日期**: 2026-08-23
> **协作模式**: 三层
> **取代**: `specs/group-detail-readability.md` 的问题三(那节写的是「移除任务 tab、
> 其余 tab 保留」,现已作废——整个右栏都要删)

## 背景

右栏四个 tab 里,「任务」是**完全冗余的重复渲染**:`tasks-tab.tsx:10` 就是

```tsx
<RequirementWorkspace groupId={groupId} listClassName="w-28" />
```

——主区那套需求两栏原封不动塞进 112px 宽的列里,文字被压成一列一个字。

而设置类内容散在**三处**,其中一处也是重复:

| 设置项 | 现在在哪 |
|---|---|
| 项目路径绑定 | 右栏「项目」tab |
| 成员角色 / 分工 prompt | 右栏「成员与分工」tab(轻量) **+** `/groups/:id/members` 整页(能力最全) |
| 重命名 / 归档 | 群**列表**页 |

在群详情里想改群名,得退回列表页。

**判断原则:右栏适合「看」,不适合「改」。** 一栏 160–320px,拿来填绝对路径、
编辑分工 prompt 本来就别扭;而设置是低频、需专注、需校验反馈的操作
(`projectPath` 必须是存在的绝对目录,失败得说清为什么)。

---

## 要求

### R1. 删除右栏

- 删除 `components/layout/context-panel.tsx` 及其四个 tab
- 删除 `context-panel/tasks-tab.tsx`(纯冗余)
- `members-tab.tsx` / `project-tab.tsx` 的能力**并入设置页后**删除
- 群内页布局从三栏变两栏,主区占满

⚠️ **`context-panel/` 目录下不是所有东西都属于右栏。**
`requirement-workspace.tsx` / `RequirementDetailPanel.tsx` / `RequirementTimeline.tsx` /
`RequirementList.tsx` / `RequirementStepper.tsx` / `group-tasks-by-spec.ts` /
`merge-requirement-timeline.ts` 是**主区**在用的,只是历史原因放在这个目录里。
**一个都不能删。** 若顺手挪目录,`RequirementTimeline.tsx:24-25` 反向 import 了
`TaskPanel` 的类型与常量,注意别绕成循环依赖。

### R2. WS 订阅与桌面通知必须先上提(唯一有风险的地方)

`context-panel.tsx:155` 注释写明:`useMessagesPage` 由 `ContextPanel` **顶层持有**,
因为该组件随群内页常驻——WS 实时订阅与桌面通知挂在它身上,即使面板收起也不丢。

**面板删了,这些副作用不能跟着没。** 先把 `useMessagesPage` 上提到群内页层级
(`group-layout.tsx` 或消息页),确认订阅与通知仍在,再删面板。

- 上提后 WS 实时订阅仍生效
- 桌面通知仍生效
- `markRead` 的既有位置**不要动**(它在 `GroupMessagesPage`,
  刻意不放在面板里——进成员页不应误清零,注释同上)

### R3. 群设置并入一页

`/groups/:id/settings` —— **就地扩容现有的 `pages/app/groups/members.tsx`**
(823 行,是能力最全的那份),**不要重写**:

```
群设置 /groups/:id/settings
├ 基本信息    群名称 · 状态 · 归档
├ 项目绑定    projectPath + 校验反馈    ← 从右栏「项目」tab 搬来
└ 成员与分工  角色 · prompt · 送达档位   ← 原地不动
```

- 入口:群标题栏的齿轮,**唯一入口**
- **路由改成 `/groups/:id/settings`**(v1.1 定稿,不再自行判断):
  页面已不只是成员管理,`members` 这个名字与内容不符
- `/groups/:id/members` **重定向**到新路由,既有链接不得 404。已知的站内引用:
  - `router.tsx:15,90` —— 路由声明与 lazy import
  - `pages/app/groups/members.tsx:56` —— `useRoute("/groups/:id/members")`
  - `pages/app/groups/index.tsx:426` —— 群列表页的跳转按钮
  - `components/sidebar/nav-main.tsx:12`、`components/sidebar/conversations.tsx:46`
    —— 侧栏高亮的子路由匹配,**改路由后高亮会失效,必须同步**
  - `context-panel/members-tab.tsx:194` —— 该文件本票会删除,无需处理
  (以上是 grep 结果,**不保证穷尽**,自行再查一遍)
- 项目绑定搬过来时,`PATCH /groups/:id` 的校验反馈要保留
  (路径非法时说清为什么,不是静默失败)

### R4. 列表页的重命名 / 归档保留

群列表页的重命名与归档**两边都留**——列表里批量归档是顺手的操作,不要搬走。
两处改的是同一份数据,注意改完状态同步。

---

## 验收标准

- [ ] 右栏及其四个 tab 已删除,群内页为两栏,主区占满
- [ ] `tasks-tab.tsx` / `members-tab.tsx` / `project-tab.tsx` / `context-panel.tsx` 已删
- [ ] 主区在用的 Requirement* 组件**一个都没被误删**
- [ ] **WS 实时订阅在删面板后仍生效**(有测试或明确验证说明)
- [ ] **桌面通知在删面板后仍生效**
- [ ] `markRead` 仍在 `GroupMessagesPage`,未被挪动
- [ ] `/groups/:id/settings` 含基本信息 / 项目绑定 / 成员与分工三区
- [ ] 设置页由 `members.tsx` 扩容而来,未重写
- [ ] 群标题栏有齿轮入口
- [ ] 路由为 `/groups/:id/settings`
- [ ] `/groups/:id/members` 重定向到新路由,不 404
- [ ] **侧栏在设置页上仍正确高亮「群组」**(两处匹配器已同步)
- [ ] 群列表页的跳转按钮指向新路由
- [ ] 项目路径非法时有明确报错,不是静默失败
- [ ] 列表页的重命名 / 归档仍可用
- [ ] `pnpm --filter @laizhixingxingdeli/web test` 全绿(先跑一次确认基线;
      删组件会带走其测试,**在汇报里列出删了哪些测试文件、剩余用例数**)
- [ ] `pnpm --filter @laizhixingxingdeli/web build` 通过

## 不涉及

- **不改**后端、不加接口(`PATCH /groups/:id` 是现成的)
- **不改**需求聚合逻辑(`groupTasksBySpec` 按 specRef 分组是对的)
- **不做**时间线可读性改造(另一票 `timeline-readability`)
- **不做**实时日志接线(另一票 `live-output-in-timeline`)
- 不引入新依赖

## 执行环境提示

- 本仓是 **pnpm** 项目
- 前端可实测:`http://localhost:5173/groups/01a029c4-b67f-...`(有真实任务数据)
- 沙箱执行器注意:需监听本地端口的测试会报 `listen EPERM`,那是环境限制不是回归;
  **全量由协调者代跑**
