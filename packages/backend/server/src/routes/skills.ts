import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SKILL_NAMES,
  SKILLS_DIR,
  skillVersion,
} from "@server/lib/skill-digest";
import { Hono } from "hono";

export { SKILL_NAMES, SKILLS_DIR };

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
