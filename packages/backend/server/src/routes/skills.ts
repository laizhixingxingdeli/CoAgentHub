import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findRepoRoot } from "@server/lib/executor-runner";
import { Hono } from "hono";

const SKILLS_DIR = resolve(findRepoRoot(), "skills");
const SKILL_NAMES = ["coordinator", "executor", "bugfix"] as const;

function readSkillDescription(name: string): string {
  const content = readFileSync(resolve(SKILLS_DIR, name, "SKILL.md"), "utf8");
  const match = content.match(/^description:\s*(.+)$/m);
  return match?.[1]?.trim() ?? "";
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
