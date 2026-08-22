import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

// skills 目录锚定到本模块所在仓库,而不是 process.cwd()/COAGENTHUB_REPO_ROOT:
// cwd 可能不是仓库根(serve.mjs 之外的启动方式),而 COAGENTHUB_REPO_ROOT 在
// 测试里被重定向到临时 git 仓库(executor 快照用),两种情况下按仓库根解析
// skills 都会落到不存在的目录 → 500。模块路径是唯一确定不变的位置。
// 本文件位于 packages/backend/server/src/routes/skills.ts,上溯 5 级 = 仓库根
// (第一个 ../ 连同文件名一起被 URL 解析消耗,故 5 个 ../ 即到仓库根)。
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const SKILLS_DIR = resolve(REPO_ROOT, "skills");
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
  .get("/:name", (c) => {
    const name = c.req.param("name");
    if (!SKILL_NAMES.includes(name as any)) {
      return c.json({ code: "NOT_FOUND", message: "Skill not found" }, 404);
    }
    const content = readFileSync(resolve(SKILLS_DIR, name, "SKILL.md"), "utf8");
    return c.json({ name, content });
  });

export default app;
