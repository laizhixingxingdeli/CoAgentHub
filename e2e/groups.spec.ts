import { expect, type Page, test } from "@playwright/test";
import { createGroup, registerParticipant, uniqueName } from "./helpers";

/** 群列表行:<ul data-testid="groups-list"> 下按标题过滤的 <li>。 */
function groupRow(page: Page, title: string) {
  return page.getByTestId("groups-list").locator("li", { hasText: title });
}

/**
 * 核心路径 2:建群(标题输入 → POST → 群列表出现,状态 active)。
 * 建群动作走真实 UI。
 *
 * 身份:浏览器一律以服务端建的「Local User」身份访问 —— 2026-08-24
 * (f6dc7b22)起前端不再本地持久化身份,localStorage 绑定那套已废弃
 * (详见 e2e/helpers.ts 的 bindIdentity 与 register.spec.ts 头部)。
 */
test("建群:标题输入 → POST → 群列表出现,状态 active", async ({
  page,
  request,
}) => {
  const participant = await registerParticipant(
    request,
    uniqueName("e2e-creator"),
  );

  const title = uniqueName("e2e-group");
  await page.goto("/groups");

  await page.locator("#group-title-input").fill(title);
  await page.getByRole("button", { name: "创建群组" }).first().click();

  // 成功提示
  await expect(page.getByText(`群组「${title}」创建成功`)).toBeVisible();

  // 群列表出现,状态 active。
  // 列表在 caad8282 之后从 <table>/<tr> 改成了 <ul data-testid="groups-list">/<li>。
  const row = groupRow(page, title);
  await expect(row).toBeVisible();
  // 状态 active 的断言不能再找「进行中」徽标:该徽标已换成一个
  // aria-hidden 的视觉圆点(index.tsx:254),i18n 里 groups.status.active
  // 成了没人引用的死键,状态在无障碍树上不留任何文本。当前 UI 里
  // active 与 archived 的唯一可访问区别是行尾按钮:active 给「归档」,
  // archived 给「恢复」(index.tsx:388-408)。
  await expect(row.getByRole("button", { name: "归档" })).toBeVisible();
});

/**
 * 核心路径 5:归档只读(归档群 → 只读横幅 + 发送禁用)。
 * 归档动作走真实 UI(接受 confirm 对话框),断言进入群页后的只读态。
 */
test("归档只读:归档群 → 只读横幅 + 发送禁用", async ({ page, request }) => {
  const participant = await registerParticipant(
    request,
    uniqueName("e2e-archiver"),
  );
  const group = await createGroup(
    request,
    uniqueName("e2e-archive-group"),
    participant.id,
  );

  await page.goto("/groups");
  const row = groupRow(page, group.title);
  await expect(row).toBeVisible();

  // 接受归档确认对话框
  page.once("dialog", (dialog) => void dialog.accept());
  await row.getByRole("button", { name: "归档" }).click();
  await expect(page.getByText(`群组「${group.title}」已归档`)).toBeVisible();

  // 进入群 → 只读横幅 + 发送禁用(composer 禁用、发送按钮禁用)
  await page.goto(`/groups/${group.id}`);
  await expect(page.getByText(/该群组已归档,处于只读状态/)).toBeVisible();

  // 「发送禁用」这条不能再按原样断言:群页面已经没有消息输入框了。
  // /groups/:id 现在渲染的是标题栏 + 只读横幅 + RequirementWorkspace
  // (需求列表/详情两栏),原来的聊天流组件 MessageList.tsx 全仓无人 import,
  // 是死代码;i18n 的 messages.send.aria(「消息内容」)同样不再被渲染。
  // 当前 UI 里「只读」的可断言表现是:横幅出现(上一行)+ 改名铅笔消失
  // (messages/index.tsx:121 的 {!isReadOnly && <Pencil …/>})。
  await expect(page.getByTestId("rename-group-title")).toHaveCount(0);
});
