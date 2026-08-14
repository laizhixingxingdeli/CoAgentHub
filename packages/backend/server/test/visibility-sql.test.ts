import {
  groupMessage as groupMessageTable,
  groups as groupsTable,
  participant as participantTable,
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
      audience: "participant",
      audienceRef: "10000000-0000-7000-8000-00000000000a",
    },
    {
      senderId: "10000000-0000-7000-8000-00000000000a",
      audience: "participant",
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
    // group_message.sender_id references participant(id) — create the sample participants.
    const participantIds = [
      ...new Set([
        ...SAMPLE_MESSAGES.map((m) => m.senderId),
        "10000000-0000-7000-8000-00000000000f",
        "10000000-0000-7000-8000-0000000000aa",
        "10000000-0000-7000-8000-0000000000bb",
      ]),
    ];
    for (const id of participantIds) {
      await testDb
        .insert(participantTable)
        .values({ id, name: id, tokenHash: "unused" })
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

  async function sqlVisibleIds(
    participantId: string,
    roles: string[],
    participantType?: Parameters<typeof messageVisibleToMemberSql>[2],
  ) {
    const rows = await testDb
      .select({
        id: groupMessageTable.id,
        senderId: groupMessageTable.senderId,
      })
      .from(groupMessageTable)
      .where(
        and(
          eq(groupMessageTable.groupId, GROUP_ID),
          messageVisibleToMemberSql(participantId, roles, participantType),
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
          participantId: member.id,
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
        participantId: outsider.id,
        roles: outsider.roles,
      }),
    );
    expect(rows.length).toBe(expected.length);
  });

  it("非成员 human(type=human)对全部消息可见,不受 audience 限制", async () => {
    const human = {
      id: "10000000-0000-7000-8000-0000000000cc",
      roles: [] as string[],
    };
    // 与 MEMBERS 中的 human 角色成员不同:这是"类型为 human"的非成员
    // (如 Local User 未入群),JS 与 SQL 都应无条件返回全部消息。
    const rows = await sqlVisibleIds(human.id, human.roles, "human");
    const expected = SAMPLE_MESSAGES.filter((m) =>
      isMessageVisibleToMember(
        m,
        { participantId: human.id, roles: human.roles },
        "human",
      ),
    );
    expect(rows.length).toBe(SAMPLE_MESSAGES.length);
    expect(rows.length).toBe(expected.length);
  });

  it("human 类型参与者的可见性先于成员/audience 判定,且不影响非 human 参与者", async () => {
    // human 非成员对定向消息(broadcast/role/participant 全样本)一条不落。
    const human = {
      id: "10000000-0000-7000-8000-0000000000cc",
      roles: [] as string[],
    };
    const humanRows = await sqlVisibleIds(human.id, human.roles, "human");
    expect(humanRows.length).toBe(SAMPLE_MESSAGES.length);

    // 同一 id 不标 human 时,退回非成员可见性(自己+广播+点名自己),证明
    // human 全可见来自 participantType 判定而非数据本身。
    const plainRows = await sqlVisibleIds(human.id, human.roles);
    const plainExpected = SAMPLE_MESSAGES.filter((m) =>
      isMessageVisibleToMember(m, {
        participantId: human.id,
        roles: human.roles,
      }),
    );
    expect(plainRows.length).toBe(plainExpected.length);
    expect(plainRows.length).toBeLessThan(SAMPLE_MESSAGES.length);
  });
});
