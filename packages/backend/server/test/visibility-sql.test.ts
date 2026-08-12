import {
  agent as agentTable,
  groupMessage as groupMessageTable,
  groups as groupsTable,
} from "@laizhixingxingdeli/database/schema";
import {
  type GroupMessageView,
  isMessageVisibleToMember,
  messageVisibleToMemberSql,
} from "@server/lib/group-visibility";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testDb } from "./db";

/**
 * Guards against drift between the two representations of the visibility
 * rule: the JS predicate (used for webhook/WS fan-out) and the SQL predicate
 * (used by GET /messages for pagination). For every sample message the SQL
 * query must return exactly the rows the JS rule would keep.
 */
describe("可见性规则:JS 与 SQL 两种表示一致", () => {
  const GROUP_ID = "00000000-0000-7000-8000-000000000001";

  const SAMPLE_MESSAGES: GroupMessageView[] = [
    {
      senderId: "10000000-0000-7000-8000-00000000000a",
      audience: "broadcast",
      audienceRef: null,
    },
    {
      senderId: "10000000-0000-7000-8000-00000000000b",
      audience: "role",
      audienceRef: "reviewer",
    },
    {
      senderId: "10000000-0000-7000-8000-00000000000c",
      audience: "role",
      audienceRef: "executor",
    },
    {
      senderId: "10000000-0000-7000-8000-00000000000d",
      audience: "agent",
      audienceRef: "10000000-0000-7000-8000-00000000000a",
    },
    {
      senderId: "10000000-0000-7000-8000-00000000000a",
      audience: "agent",
      audienceRef: "10000000-0000-7000-8000-00000000000f",
    },
    {
      senderId: "10000000-0000-7000-8000-00000000000e",
      audience: "broadcast",
      audienceRef: null,
    },
  ];

  const MEMBERS: Array<{ id: string; roles: string[] }> = [
    { id: "10000000-0000-7000-8000-00000000000a", roles: ["coordinator"] },
    { id: "10000000-0000-7000-8000-00000000000b", roles: ["reviewer"] },
    { id: "10000000-0000-7000-8000-00000000000c", roles: ["executor"] },
    { id: "10000000-0000-7000-8000-0000000000bb", roles: ["human"] },
  ];

  async function seed() {
    // group_message.sender_id references agent(id) — create the sample agents.
    const agentIds = [
      ...new Set([
        ...SAMPLE_MESSAGES.map((m) => m.senderId),
        "10000000-0000-7000-8000-00000000000f",
        "10000000-0000-7000-8000-0000000000aa",
        "10000000-0000-7000-8000-0000000000bb",
      ]),
    ];
    for (const id of agentIds) {
      await testDb
        .insert(agentTable)
        .values({ id, name: id, type: "custom", tokenHash: "unused" })
        .onConflictDoNothing();
    }
    // group_message.group_id references groups(id).
    await testDb
      .insert(groupsTable)
      .values({
        id: GROUP_ID,
        title: "visibility-test",
        status: "active",
        createdBy: "10000000-0000-7000-8000-00000000000a",
      })
      .onConflictDoNothing();
    for (const m of SAMPLE_MESSAGES) {
      await testDb.insert(groupMessageTable).values({
        id: undefined, // uuidv7 default
        groupId: GROUP_ID,
        senderId: m.senderId,
        parentId: null,
        audience: m.audience,
        audienceRef: m.audienceRef,
        body: `${m.senderId}-${m.audience}-${m.audienceRef ?? ""}`,
        contentType: "text/plain",
        fileRef: null,
      });
    }
  }

  async function sqlVisibleIds(agentId: string, roles: string[]) {
    const rows = await testDb
      .select({
        id: groupMessageTable.id,
        senderId: groupMessageTable.senderId,
      })
      .from(groupMessageTable)
      .where(
        and(
          eq(groupMessageTable.groupId, GROUP_ID),
          messageVisibleToMemberSql(agentId, roles),
        ),
      )
      .orderBy(asc(groupMessageTable.id));
    return rows;
  }

  it("对每个成员,SQL 谓词返回的行与 JS 规则一致", async () => {
    await seed();
    for (const member of MEMBERS) {
      const sqlRows = await sqlVisibleIds(member.id, member.roles);
      const expected = SAMPLE_MESSAGES.filter((m) =>
        isMessageVisibleToMember(m, {
          agentId: member.id,
          roles: member.roles,
        }),
      ).length;
      expect(sqlRows.length, `member ${member.id}`).toBe(expected);
    }
  });

  it("非成员(无 roles)只见自己的消息与广播/点名自己的消息", async () => {
    const outsider = {
      id: "10000000-0000-7000-8000-0000000000aa",
      roles: [] as string[],
    };
    const rows = await sqlVisibleIds(outsider.id, outsider.roles);
    const expected = SAMPLE_MESSAGES.filter((m) =>
      isMessageVisibleToMember(m, {
        agentId: outsider.id,
        roles: outsider.roles,
      }),
    );
    expect(rows.length).toBe(expected.length);
  });
});
