import { expect, test } from "@playwright/test";
import {
  bindIdentity,
  createGroup,
  registerParticipant,
  uniqueName,
} from "./helpers";

/**
 * 核心路径 2:建群(标题输入 → POST → 群列表出现,状态 active)。
 * 身份经 API 注册 + localStorage 绑定(注册流程本身在 register.spec 覆盖),
 * 建群动作走真实 UI。
 */
test("建群:标题输入 → POST → 群列表出现,状态 active", async ({
  page,
  request,
}) => {
  const participant = await registerParticipant(
    request,
    uniqueName("e2e-creator"),
  );
  await bindIdentity(page, participant.id);

  const title = uniqueName("e2e-group");
  await page.goto("/groups");

  await page.locator("#group-title-input").fill(title);
  await page.getByRole("button", { name: "创建群组" }).first().click();

  // 成功提示
  await expect(page.getByText(`群组「${title}」创建成功`)).toBeVisible();

  // 群列表出现,状态 active(「进行中」徽标)
  const row = page.locator("tr", { hasText: title });
  await expect(row).toBeVisible();
  await expect(row.getByText("进行中")).toBeVisible();
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
  await bindIdentity(page, participant.id);

  await page.goto("/groups");
  const row = page.locator("tr", { hasText: group.title });
  await expect(row).toBeVisible();

  // 接受归档确认对话框
  page.once("dialog", (dialog) => void dialog.accept());
  await row.getByRole("button", { name: "归档" }).click();
  await expect(page.getByText(`群组「${group.title}」已归档`)).toBeVisible();

  // 进入群 → 只读横幅 + 发送禁用(composer 禁用、发送按钮禁用)
  await page.goto(`/groups/${group.id}`);
  await expect(page.getByText(/该群组已归档,处于只读状态/)).toBeVisible();

  const composer = page.getByLabel("消息内容");
  await expect(composer).toBeDisabled();
  await expect(page.getByRole("button", { name: "发送" })).toBeDisabled();
});
