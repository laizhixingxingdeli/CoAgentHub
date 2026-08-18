# Spec: Skill 安装引导 API (Skill Installation API)

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-18

## 1. 背景与目标

当前 agent 接入 CoAgentHub 时，需要从仓库手动复制 `skills/` 下的 SKILL.md 到
各自的 skills 目录。这个流程依赖文档引导，不够自动化。

**目标**：服务端提供一个轻量 API，agent 接入后调用该 API 即可获取对应 skill
的内容，自动安装到自己的 skills 目录。

## 2. 改动范围

- 新增路由文件: `packages/backend/server/src/routes/skills.ts`
- 挂载到入口: `packages/backend/server/src/index.ts`
- 新增测试: `packages/backend/server/test/skills.test.ts`
- 更新 onboarding 文档: `docs/agents/coagenthub-onboarding.md`

## 3. 详细改动

### 3.1 新增 `GET /api/skills` — 列出可用 skills

响应：
```json
{
  "items": [
    {
      "name": "coordinator",
      "description": "Coordinate tasks on CoAgentHub — write a spec, freeze it, dispatch to executors, then grill the results.",
      "path": "skills/coordinator/SKILL.md"
    },
    {
      "name": "executor",
      "description": "Execute tasks dispatched through CoAgentHub — read the spec, implement, run tests, self-review.",
      "path": "skills/executor/SKILL.md"
    },
    {
      "name": "bugfix",
      "description": "Diagnose and fix bugs through CoAgentHub — reproduce, isolate root cause, write a fix spec, dispatch, verify.",
      "path": "skills/bugfix/SKILL.md"
    }
  ]
}
```

### 3.2 新增 `GET /api/skills/:name` — 获取单个 skill 内容

响应（`name` 为 coordinator/executor/bugfix）：
```json
{
  "name": "executor",
  "content": "# CoAgentHub Executor\n\nYou are an **executor**..."
}
```

- `:name` 不存在 → 404 `{ code: "NOT_FOUND", message: "Skill not found" }`
- 路径穿越防护：只允许白名单 `coordinator | executor | bugfix`

### 3.3 实现方式

在 `packages/backend/server/src/routes/skills.ts`:

```typescript
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";

const SKILLS_DIR = resolve(process.cwd(), "skills");
const SKILL_NAMES = ["coordinator", "executor", "bugfix"] as const;

// 元数据：从 SKILL.md frontmatter 读取 description
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
```

在 `index.ts` 中挂载：
```typescript
import skillsRouter from "./routes/skills";
// ...
.route("/skills", skillsRouter)
```

### 3.4 更新 onboarding 文档

在"自己接入流程"第 4 步，改为调用 API 安装 skill：

```markdown
4. **安装 CoAgentHub Skills** — 调用 `GET ${COAGENTHUB_URL}/api/skills` 查看可用 skills，
   然后 `GET ${COAGENTHUB_URL}/api/skills/:name` 获取内容，写入自己的 skills 目录：
   - 协调者 → `GET /api/skills/coordinator` → 写入 `~/.hermes/skills/coagenthub-coordinator/SKILL.md`
   - 执行器 → `GET /api/skills/executor` → 写入 `~/.hermes/skills/coagenthub-executor/SKILL.md`
   - 修 Bug → `GET /api/skills/bugfix` → 写入 `~/.hermes/skills/coagenthub-bugfix/SKILL.md`
```

### 3.5 测试

新增 `packages/backend/server/test/skills.test.ts`:
- 列出 skills 返回 3 个，每个含 name/description/path
- 获取存在的 skill 返回 name + content
- 获取不存在的 skill 返回 404
- 路径穿越尝试（`../../etc/passwd`）返回 404（白名单拒绝）

## 4. 验收标准

- [ ] `GET /api/skills` 返回 3 个 skill（coordinator/executor/bugfix）
- [ ] `GET /api/skills/:name` 返回 skill 内容
- [ ] 不存在的 name 返回 404
- [ ] 路径穿越被白名单拒绝
- [ ] onboarding 文档更新为 API 安装流程
- [ ] pnpm test 全绿、check-types 通过、build 通过

## 5. 不涉及的改动

- 不修改前端
- 不修改现有 skill 内容
- 不引入新的 npm 依赖
- 不修改 MCP 插件

## 6. 兼容性

- 新增只读 API，不影响现有端点
- skill 内容仍可从 git 仓库直接获取（双通道）
- agent 可自由选择 API 安装或手动复制
