import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

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

export const SKILLS_DIR = resolveSkillsDir();
export const SKILL_NAMES = [
  "coordinator",
  "executor",
  "bugfix",
  "reviewer",
] as const;

function readSkillDescription(name: string): string {
  const content = readFileSync(resolve(SKILLS_DIR, name, "SKILL.md"), "utf8");
  const match = content.match(/^description:\s*(.+)$/m);
  return match?.[1]?.trim() ?? "";
}

/**
 * 内容哈希指纹:sha256(SKILL.md 内容)前 12 位十六进制。
 * 由文件内容算出、不依赖 git(打包后的 dist 里没有 .git),供 skill 同步
 * 比对使用(见 specs/skill-sync-mechanism.md R1)。
 */
function skillVersion(name: string): string {
  const content = readFileSync(resolve(SKILLS_DIR, name, "SKILL.md"), "utf8");
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/**
 * 一次性读取全部 skill(接入参与方时投递用):返回 name/description/content/path。
 * 形状与 GET /api/skills 的 items 协调(同源同字段),只是多了 content 字段,
 * 供无消息通道的接入场景把全套 skill 内容随注册响应一次带回。
 */
export function readSkillBundle() {
  return SKILL_NAMES.map((name) => ({
    name,
    description: readSkillDescription(name),
    content: readFileSync(resolve(SKILLS_DIR, name, "SKILL.md"), "utf8"),
    path: `skills/${name}/SKILL.md`,
  }));
}

const app = new Hono()
  .get("/", (c) => {
    const items = SKILL_NAMES.map((name) => ({
      name,
      description: readSkillDescription(name),
      path: `skills/${name}/SKILL.md`,
    }));
    return c.json({ items });
  })
  .get("/:name/digest", (c) => {
    const name = c.req.param("name");
    if (!SKILL_NAMES.includes(name as any)) {
      return c.json({ code: "NOT_FOUND", message: "Skill not found" }, 404);
    }
    // 只回指纹、不下发全文:轮询/同步比对不用下载整份 SKILL.md。
    return c.json({ name, version: skillVersion(name) });
  })
  .get("/:name", (c) => {
    const name = c.req.param("name");
    if (!SKILL_NAMES.includes(name as any)) {
      return c.json({ code: "NOT_FOUND", message: "Skill not found" }, 404);
    }
    const content = readFileSync(resolve(SKILLS_DIR, name, "SKILL.md"), "utf8");
    return c.json({ name, content, version: skillVersion(name) });
  });

export default app;
