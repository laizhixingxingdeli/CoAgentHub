import { participant as participantTable } from "@laizhixingxingdeli/database/schema";
import type { GroupRole } from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { eq } from "drizzle-orm";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 能力标签的轻量提示校验 (ticket 17): 已知能力目录 + 能力→建议角色映射。
 * 仅做提示性校验,绝不硬性拒绝 —— 加成员时若声明的能力含未知标签,或能力
 * 与分配角色完全不匹配,在响应里附 capabilityHint 提示,仍照常放行。
 */
export const KNOWN_CAPABILITIES = [
  "text-generation",
  "code-review",
  "model-training",
  "file-serving",
  "human-interface",
] as const;

/** 已知能力 → 与该能力最契合的角色建议(提示用,非强制)。 */
export const CAPABILITY_ROLE_SUGGESTIONS: Record<string, readonly GroupRole[]> =
  {
    "text-generation": ["executor", "specialist"],
    "code-review": ["reviewer", "coordinator"],
    "model-training": ["specialist", "executor"],
    "file-serving": ["executor"],
    "human-interface": ["human"],
  };

/**
 * 对加成员请求做能力↔角色匹配提示。返回 null 表示无需提示(未声明能力,
 * 或声明的能力全部已知且与分配角色有交集)。不抛错、不影响加成员本身。
 */
export function capabilityHint(
  capabilities: string[] | null | undefined,
  assignedRoles: readonly string[],
): string | null {
  if (!capabilities || capabilities.length === 0) return null;

  const hints: string[] = [];
  const known = KNOWN_CAPABILITIES as readonly string[];
  const unknown = capabilities.filter((c) => !known.includes(c));
  if (unknown.length > 0) {
    hints.push(
      `未知能力标签: ${unknown.join(", ")} (已知: ${known.join(", ")})`,
    );
  }

  const suggested = [
    ...new Set(
      capabilities.flatMap((c) => CAPABILITY_ROLE_SUGGESTIONS[c] ?? []),
    ),
  ];
  if (
    suggested.length > 0 &&
    !suggested.some((r) => assignedRoles.includes(r))
  ) {
    hints.push(`能力与角色匹配提示: 建议角色 ${suggested.join("/")}`);
  }

  return hints.length > 0 ? hints.join("; ") : null;
}

/**
 * skill 类型 → capability 标签映射。agent 安装 skill 后,按其 skill 类型把
 * 对应 capability 幂等追加到 participant.capabilities,供后续调度/加群提示参考。
 */
export const COAGENTHUB_SKILL_CAPABILITIES = {
  executor: "coagenthub-executor",
  coordinator: "coagenthub-coordinator",
  bugfix: "coagenthub-bugfix",
} as const;

/**
 * 识别 agent 的 skill 安装确认消息(如 "✅ skill 已安装" 或 "✅ skill 已安装: executor"),
 * 并幂等追加对应 capability 到发送者 participant.capabilities。
 * 不匹配或未知 skill 类型时静默返回(不抛错、不阻塞消息发送)。fire-and-forget 调用。
 */
export async function handleSkillInstallConfirmation(
  db: DataBase,
  senderId: string,
  body: string,
): Promise<void> {
  // 匹配 "✅ skill 已安装" 或 "✅ skill 已安装: executor" 等。
  const match = body.match(/^✅\s*(?:skill|技能)?\s*已安装(?:\s*[:：]\s*(\w+))?/i);
  if (!match) return;

  // 推断 skill 类型:显式指定或用默认 executor。
  const skillKey = (match[1]?.toLowerCase() ?? "executor") as
    | keyof typeof COAGENTHUB_SKILL_CAPABILITIES
    | string;
  const capability =
    skillKey in COAGENTHUB_SKILL_CAPABILITIES
      ? COAGENTHUB_SKILL_CAPABILITIES[
          skillKey as keyof typeof COAGENTHUB_SKILL_CAPABILITIES
        ]
      : undefined;
  if (!capability) return;

  // 更新 participant capabilities(幂等追加)。
  const participant = await db.query.participant.findFirst({
    where: (t, { eq: eqFn }) => eqFn(t.id, senderId),
  });
  if (!participant) return;

  const current = participant.capabilities ?? [];
  if (!current.includes(capability)) {
    await db
      .update(participantTable)
      .set({ capabilities: [...current, capability] })
      .where(eq(participantTable.id, senderId));
  }
}

/**
 * 检查项目是否已初始化 Matt 文档脚手架。返回缺失的相对路径列表(空数组 = 已初始化)。
 * 检查项:AGENTS.md / CONTEXT.md / docs/adr/ / specs/ / .cursorrules(或等效)。
 */
export function findMissingProjectDocs(projectPath: string): string[] {
  const required = [
    "AGENTS.md",
    "CONTEXT.md",
    "docs/adr/",
    "specs/",
    ".cursorrules",
  ];
  return required.filter((p) => !existsSync(resolve(projectPath, p)));
}
