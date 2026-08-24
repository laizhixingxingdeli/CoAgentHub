// scripts/runtime-skills-dirs.mjs
//
// Single source of truth for the runtime -> skills-directory mapping. Reused by:
//   - scripts/coagenthub-init.mjs          (project-onboarding-interactive R6 skill install)
//   - scripts/coagenthub-sync-skills.mjs    (skill-sync-mechanism R3 skill sync)
//
// Do NOT duplicate this table in either caller — keep one definition so the
// installer and the sync command never drift apart (spec: 复用同一份目录约定,
// 不要各写一份).
//
// Known runtime skill layouts (本机实测存在, see
// specs/project-onboarding-interactive.md R6 and specs/skill-sync-mechanism.md R3).
// Each maps a runtime to the subdirectory (relative to a home root) that holds
// `coagenthub-<role>/SKILL.md` files.

import { resolve } from "node:path";

export const RUNTIME_SKILL_LAYOUTS = [
  { runtime: "Claude Code", subdir: ".claude/skills" },
  { runtime: "codex", subdir: ".codex/skills" },
  { runtime: "atomcode", subdir: ".atomcode/skills" },
  { runtime: "codebuddy", subdir: ".codebuddy/skills" },
];

export const ROLE_SKILL_FILE_NAME = "SKILL.md";

/**
 * The directory name a role's skill lives in, e.g. "executor" -> "coagenthub-executor".
 */
export function coagenthubRoleDir(role) {
  return `coagenthub-${role}`;
}

/**
 * Resolve the absolute path of a role's installed SKILL.md under a runtime root.
 */
export function roleSkillPath(runtimeRoot, role) {
  return resolve(runtimeRoot, coagenthubRoleDir(role), ROLE_SKILL_FILE_NAME);
}

/**
 * Resolve a runtime's skills root directory given a home root (e.g. os.homedir()
 * or, in tests, a temporary directory). Returns null for an unknown runtime so
 * callers can skip (and list) it rather than guessing a path.
 */
export function resolveRuntimeSkillRoot(homeRoot, runtime) {
  const layout = RUNTIME_SKILL_LAYOUTS.find((l) => l.runtime === runtime);
  if (!layout) return null;
  return resolve(homeRoot, layout.subdir);
}
