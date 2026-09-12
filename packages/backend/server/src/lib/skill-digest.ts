import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// skills 目录按「模块路径向上找 skills/」解析,不用固定层数。
//
// ⚠️ 曾经写死「上溯 5 级 = 仓库根」,那在源码目录 (src/routes/skills.ts) 成立,
// 但打包成 dist/server.mjs 后深度少两级,上溯 5 级会落到仓库的**父目录**,
// 于是去 <父目录>/skills 找 → ENOENT → GET /api/skills 全线 500。
// 实测:src 上溯5级 = .../CoAgentHub/ ✓;dist 上溯5级 = .../Projects/ ✗
//
// 改为从模块所在目录逐级上溯,取第一个含 skills/ 的目录——源码与打包两种
// 布局都成立,且不依赖 process.cwd()(cwd 可能不是仓库根)或
// COAGENTHUB_REPO_ROOT(测试里被重定向到临时 git 仓库)。
function resolveSkillsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = resolve(dir, "skills");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 找不到时返回按模块路径推算的默认值,让 readFileSync 抛出带路径的 ENOENT,
  // 便于定位;不静默返回空目录。
  return resolve(dirname(fileURLToPath(import.meta.url)), "skills");
}

export let SKILLS_DIR = resolveSkillsDir();

/** 测试用:把 skills 根指到临时目录(读盘失败路径等)。 */
export function __setSkillsDirForTests(dir: string): void {
  SKILLS_DIR = dir;
}

/** 测试用:恢复模块加载时解析出的 skills 根。 */
export function __resetSkillsDirForTests(): void {
  SKILLS_DIR = resolveSkillsDir();
}

export const SKILL_NAMES = [
  "coordinator",
  "executor",
  "bugfix",
  "reviewer",
] as const;

/**
 * 内容哈希指纹:sha256(SKILL.md 内容)前 12 位十六进制。
 * 由文件内容算出、不依赖 git(打包后的 dist 里没有 .git),供 skill 同步
 * 比对使用(见 specs/skill-sync-mechanism.md R1)。
 */
export function skillVersion(name: string): string {
  const content = readFileSync(resolve(SKILLS_DIR, name, "SKILL.md"), "utf8");
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/**
 * 任务书平台事实段用的指纹行。无对应 skill / 读盘失败时返回 null
 * (整行不输出,不抛错——派发关键路径,见 specs/skill-self-update.md R1/R5)。
 */
export function skillDigestTicketLine(role: string): string | null {
  if (role === "fallback") return null;
  if (!(SKILL_NAMES as readonly string[]).includes(role)) return null;
  try {
    return `COAGENTHUB_SKILL_DIGEST: ${role}=${skillVersion(role)}`;
  } catch {
    return null;
  }
}
