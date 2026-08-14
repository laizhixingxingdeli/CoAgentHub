import {
  groupMessage as groupMessageTable,
  groups as groupsTable,
  participant as participantTable,
} from "@laizhixingxingdeli/database/schema";
import {
  type GroupMessageView,
  isMessageVisibleToMember,
  messageVisibleToMemberSql,
  visibleMemberIds,
} from "@server/lib/group-visibility";
import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testDb } from "./db";

/**
 * JS/SQL 双实现一致性测试(单一来源是 JS 实现,SQL 谓词是其派生):
 * 对同一批消息(跨多个群、不同成员角色、不同 audience、归档/删除状态、
 * 含父消息的线程),分别用 JS 实现(visibleMemberIds / isMessageVisibleToMember)
 * 与 SQL 实现(messageVisibleToMemberSql 查询)计算可见集合,断言完全一致。
 * 与 visibility-sql.test.ts 相比:更大样本(≥20 条)、多群、归档/删除群、
 * 父消息(parentId)场景,且直接比较消息 id 集合而非仅行数。
 */

const G1 = "00000000-0000-7000-8000-000000000001"; // active
const G2 = "00000000-0000-7000-8000-000000000002"; // archived
const G3 = "00000000-0000-7000-8000-000000000003"; // deleted

const P1 = "10000000-0000-7000-8000-000000000001";
const P2 = "10000000-0000-7000-8000-000000000002";
const P3 = "10000000-0000-7000-8000-000000000003";
const P4 = "10000000-0000-7000-8000-000000000004";
const P5 = "10000000-0000-7000-8000-000000000005";
const P6 = "10000000-0000-7000-8000-000000000006";
const P7 = "10000000-0000-7000-8000-000000000007";
const P8 = "10000000-0000-7000-8000-000000000008"; // 无任何角色(外部旁观者)
const PHUMAN = "10000000-0000-7000-8000-0000000000aa"; // human:看全部

/** 每个群的成员名单:同一个人在不同群可有不同角色。 */
const MEMBERS_BY_GROUP: Record<
  string,
  Array<{ participantId: string; roles: string[] }>
> = {
  [G1]: [
    { participantId: P1, roles: ["coordinator"] },
    { participantId: P2, roles: ["reviewer"] },
    { participantId: P3, roles: ["executor"] },
    { participantId: PHUMAN, roles: ["human"] },
  ],
  [G2]: [
    { participantId: P2, roles: ["coordinator"] },
    { participantId: P5, roles: ["executor"] },
    { participantId: P6, roles: ["reviewer"] },
  ],
  [G3]: [
    { participantId: P3, roles: ["executor"] },
    { participantId: P4, roles: ["reviewer"] },
    { participantId: P5, roles: ["coordinator"] },
    { participantId: P7, roles: ["executor"] },
  ],
};

interface MessageSeed extends GroupMessageView {
  id: string;
  groupId: string;
  parentId: string | null;
}

const M = (
  id: number,
  groupId: string,
  senderId: string,
  audience: MessageSeed["audience"],
  audienceRef: string | null,
  parentId: string | null = null,
): MessageSeed => ({
  id: `30000000-0000-7000-8000-${String(id).padStart(12, "0")}`,
  groupId,
  senderId,
  audience,
  audienceRef,
  parentId,
});

/** 22 条消息:3 个群 × 混合 audience × 部分带 parentId(线程) × 归档/删除群。 */
const MESSAGES: MessageSeed[] = [
  // --- G1 (active) ---
  M(1, G1, P1, "broadcast", null),
  M(2, G1, P2, "role", "reviewer"),
  M(3, G1, P3, "role", "executor"),
  M(4, G1, P1, "participant", P3),
  M(5, G1, P2, "participant", P4), // P4 不是 G1 成员:点名群外成员
  M(6, G1, P3, "role", "coordinator"),
  M(7, G1, P1, "participant", P1), // 点名自己
  M(8, G1, P4, "broadcast", null, "30000000-0000-7000-8000-000000000001"), // 回复 m1
  // --- G2 (archived) ---
  M(9, G2, P5, "broadcast", null),
  M(10, G2, P6, "role", "coordinator"),
  M(11, G2, P2, "role", "executor"),
  M(12, G2, P5, "participant", P6),
  M(13, G2, P6, "participant", P2, "30000000-0000-7000-8000-000000000009"), // 回复 m9
  M(14, G2, P2, "role", "reviewer", "30000000-0000-7000-8000-000000000010"), // 回复 m10
  M(15, G2, P5, "broadcast", null, "30000000-0000-7000-8000-000000000012"), // 回复 m12
  // --- G3 (deleted) ---
  M(16, G3, P7, "broadcast", null),
  M(17, G3, P3, "role", "executor"),
  M(18, G3, P4, "role", "coordinator"),
  M(19, G3, P5, "participant", P7),
  M(20, G3, P7, "role", "reviewer", "30000000-0000-7000-8000-000000000016"), // 回复 m16
  M(21, G3, P3, "participant", P3), // 点名自己
  M(22, G3, P5, "broadcast", null, "30000000-0000-7000-8000-000000000019"), // 回复 m19
];

async function seed() {
  const participantIds = new Set<string>([
    P1,
    P2,
    P3,
    P4,
    P5,
    P6,
    P7,
    P8,
    PHUMAN,
  ]);
  for (const id of participantIds) {
    await testDb
      .insert(participantTable)
      .values({ id, name: id, tokenHash: "unused" })
      .onConflictDoNothing();
  }
  for (const [id, title, status] of [
    [G1, "g-active", "active"],
    [G2, "g-archived", "archived"],
    [G3, "g-deleted", "deleted"],
  ] as const) {
    await testDb
      .insert(groupsTable)
      .values({ id, title, status, createdBy: P1 })
      .onConflictDoNothing();
  }
  // 父消息先插(外键 parent_id → group_message.id)
  for (const m of MESSAGES) {
    await testDb
      .insert(groupMessageTable)
      .values({
        id: m.id,
        groupId: m.groupId,
        senderId: m.senderId,
        parentId: m.parentId,
        audience: m.audience,
        audienceRef: m.audienceRef,
        body: `${m.id}-${m.audience}-${m.audienceRef ?? ""}`,
        contentType: "text/plain",
        fileRef: null,
      })
      .onConflictDoNothing();
  }
}

/** SQL 谓词查询某群中对某成员可见的消息 id 集合。 */
async function sqlVisibleIds(
  groupId: string,
  participantId: string,
  roles: string[],
) {
  const rows = await testDb
    .select({ id: groupMessageTable.id })
    .from(groupMessageTable)
    .where(
      and(
        eq(groupMessageTable.groupId, groupId),
        messageVisibleToMemberSql(participantId, roles),
      ),
    )
    .orderBy(asc(groupMessageTable.id));
  return rows.map((r) => r.id);
}

const groupMessages = (groupId: string) =>
  MESSAGES.filter((m) => m.groupId === groupId);
const sorted = (ids: Iterable<string>) => [...ids].sort();

describe("group-visibility JS/SQL 双实现一致性", () => {
  it("样本覆盖:≥20 条消息、3 个群(active/archived/deleted)、混合 audience、含父消息", () => {
    expect(MESSAGES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(MESSAGES.map((m) => m.groupId)).size).toBe(3);
    expect(MESSAGES.some((m) => m.parentId !== null)).toBe(true);
  });

  it("对每个群 × 每个成员,SQL 返回的消息 id 集合与 JS 谓词完全一致", async () => {
    await seed();
    for (const [groupId, members] of Object.entries(MEMBERS_BY_GROUP)) {
      for (const member of members) {
        const sqlIds = await sqlVisibleIds(
          groupId,
          member.participantId,
          member.roles,
        );
        const jsIds = groupMessages(groupId)
          .filter((m) =>
            isMessageVisibleToMember(m, {
              participantId: member.participantId,
              roles: member.roles,
            }),
          )
          .map((m) => m.id);
        expect(sqlIds, `${groupId} member ${member.participantId}`).toEqual(
          sorted(jsIds),
        );
      }
    }
  });

  it("对每条消息,visibleMemberIds(JS)与逐成员跑 SQL 的结果完全一致", async () => {
    await seed();
    for (const groupId of [G1, G2, G3]) {
      const members = MEMBERS_BY_GROUP[groupId];
      for (const message of groupMessages(groupId)) {
        const jsIds = sorted(visibleMemberIds(message, members));
        const sqlIds: string[] = [];
        for (const member of members) {
          const rows = await sqlVisibleIds(
            groupId,
            member.participantId,
            member.roles,
          );
          if (rows.includes(message.id)) sqlIds.push(member.participantId);
        }
        expect(sqlIds.sort(), `message ${message.id}`).toEqual(jsIds);
      }
    }
  });

  it("非成员(无角色)在归档/删除群同样只见自己的消息与广播/点名自己的消息", async () => {
    await seed();
    const outsider = { participantId: P8, roles: [] as string[] };
    for (const groupId of [G1, G2, G3]) {
      const sqlIds = await sqlVisibleIds(
        groupId,
        outsider.participantId,
        outsider.roles,
      );
      const jsIds = groupMessages(groupId)
        .filter((m) => isMessageVisibleToMember(m, outsider))
        .map((m) => m.id);
      expect(sqlIds, `${groupId} outsider ${outsider.participantId}`).toEqual(
        sorted(jsIds),
      );
    }
  });
});
