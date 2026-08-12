import type { GroupRole } from "@laizhixingxingdeli/database/schema";

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
