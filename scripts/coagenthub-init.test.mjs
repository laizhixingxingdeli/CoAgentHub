import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasCoAgentHubSection,
  initializeCoAgentHubProject,
  isCoAgentHubProject,
  onboardProject,
  parseCliArgs,
  RUNTIME_SKILL_LAYOUTS,
  readCoAgentHubGroupId,
  resolveSkillInstallPath,
  updateCoAgentHubGroupId,
  writeCoAgentHubGroupId,
} from "./coagenthub-init.mjs";
import { planSync } from "./coagenthub-sync-skills.mjs";
import { RUNTIME_SKILL_LAYOUTS as SOURCE_RUNTIME_SKILL_LAYOUTS } from "./runtime-skills-dirs.mjs";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "coagenthub-init-"));
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function routeFetch(routes, calls) {
  return async (url, init = {}) => {
    const path = new URL(url).pathname.replace(/^\/api(?=\/|$)/, "");
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, headers: init.headers });
    const route = routes.find(
      (candidate) =>
        candidate.method === method &&
        (typeof candidate.path === "function"
          ? candidate.path(path, body)
          : candidate.path === path),
    );
    if (!route) throw new Error(`unexpected request: ${method} ${path}`);
    return typeof route.response === "function"
      ? route.response(path, body)
      : jsonResponse(route.response, route.status);
  };
}

describe("CoAgentHub project onboarding", () => {
  it("creates the offline scaffold with an empty groupId", () => {
    const projectPath = tempProject();
    const result = initializeCoAgentHubProject(projectPath);

    expect(result.created).toEqual([
      "AGENTS.md marker section",
      "CONTEXT.md",
      "docs/adr/0001-coagenthub-onboarding.md",
      "specs/.gitkeep",
      ".cursorrules",
      "docs/agents/coagenthub-project-onboarding.md",
    ]);
    const agents = readFileSync(join(projectPath, "AGENTS.md"), "utf8");
    expect(agents).toContain('"groupId": ""');
    expect(agents).not.toMatch(/role|apiBase|participantId/);
    expect(readFileSync(join(projectPath, "CONTEXT.md"), "utf8")).toContain(
      "no universal startup mechanism",
    );
    expect(
      readFileSync(
        join(projectPath, "docs/agents/coagenthub-project-onboarding.md"),
        "utf8",
      ),
    ).toMatch(/POST \$COAGENTHUB_API_BASE\/groups/);
  });

  it("does not overwrite existing documentation", () => {
    const projectPath = tempProject();
    const context = "project-owned context\n";
    writeFileSync(join(projectPath, "CONTEXT.md"), context);

    initializeCoAgentHubProject(projectPath);
    const result = initializeCoAgentHubProject(projectPath);

    expect(readFileSync(join(projectPath, "CONTEXT.md"), "utf8")).toBe(context);
    expect(result.skipped).toContain("CONTEXT.md");
  });

  it("uses the marker section rather than AGENTS.md existence for detection", () => {
    const projectPath = tempProject();
    writeFileSync(
      join(projectPath, "AGENTS.md"),
      "# Other project instructions\n",
    );
    expect(isCoAgentHubProject(projectPath)).toBe(false);
    expect(
      hasCoAgentHubSection(
        readFileSync(join(projectPath, "AGENTS.md"), "utf8"),
      ),
    ).toBe(false);

    initializeCoAgentHubProject(projectPath);
    expect(isCoAgentHubProject(projectPath)).toBe(true);
  });

  it("writes the real group id back without adding other project facts", () => {
    const contents = `# Instructions\n\n## CoAgentHub\n\n\`\`\`json coagenthub\n{ "groupId": "" }\n\`\`\`\n\n## Other\nKeep this.\n`;
    const updated = updateCoAgentHubGroupId(
      contents,
      "019abc00-0000-7000-8000-000000000001",
    );

    expect(updated).toContain(
      '"groupId": "019abc00-0000-7000-8000-000000000001"',
    );
    expect(updated).toContain("## Other\nKeep this.");
    expect(updated).not.toMatch(/role|apiBase|participantId/);
  });

  it("writes the returned id into the project's AGENTS.md", () => {
    const projectPath = tempProject();
    initializeCoAgentHubProject(projectPath);
    const groupId = "019abc00-0000-7000-8000-000000000002";

    writeCoAgentHubGroupId(projectPath, groupId);

    expect(readFileSync(join(projectPath, "AGENTS.md"), "utf8")).toContain(
      `"groupId": "${groupId}"`,
    );
  });
});

describe("skill-sync runtime mapping reuse (spec: 复用同一份目录约定)", () => {
  it("installer imports the shared runtime layout table, not its own copy", () => {
    // The installer re-exports the single source of truth rather than defining
    // its own copy (skill-sync-mechanism acceptance: 未各写一份).
    expect(RUNTIME_SKILL_LAYOUTS).toBe(SOURCE_RUNTIME_SKILL_LAYOUTS);
    expect(RUNTIME_SKILL_LAYOUTS).toEqual([
      { runtime: "Claude Code", subdir: ".claude/skills" },
      { runtime: "codex", subdir: ".codex/skills" },
      { runtime: "atomcode", subdir: ".atomcode/skills" },
      { runtime: "codebuddy", subdir: ".codebuddy/skills" },
      { runtime: "pi", subdir: ".pi/skills" },
    ]);
  });

  it("installer resolves the same skill-install path the sync command computes", () => {
    const homeRoot = mkdtempSync(join(tmpdir(), "coagenthub-reuse-"));
    // Create each runtime's skills root so planSync yields install paths.
    for (const { subdir } of RUNTIME_SKILL_LAYOUTS)
      mkdirSync(join(homeRoot, subdir), { recursive: true });

    const verdicts = planSync(homeRoot, ["executor"], {});
    const syncPaths = new Map();
    for (const v of verdicts)
      if (v.runtime && v.status === "missing") syncPaths.set(v.runtime, v.path);

    for (const { runtime } of RUNTIME_SKILL_LAYOUTS) {
      const installerPath = resolveSkillInstallPath(
        homeRoot,
        runtime,
        "executor",
      );
      expect(installerPath).toBe(syncPaths.get(runtime));
      expect(installerPath).toBe(
        join(
          homeRoot,
          runtimeSubdir(runtime),
          "coagenthub-executor",
          "SKILL.md",
        ),
      );
    }
  });

  it("returns null for an unknown runtime instead of guessing a path", () => {
    const homeRoot = mkdtempSync(join(tmpdir(), "coagenthub-unknown-"));
    expect(resolveSkillInstallPath(homeRoot, "nonsense", "executor")).toBe(
      null,
    );
  });
});

describe("interactive /init onboarding flow", () => {
  it("creates, aligns, installs skills, and writes the exact group id", async () => {
    const projectPath = tempProject();
    const homeRoot = mkdtempSync(join(tmpdir(), "coagenthub-home-"));
    mkdirSync(join(homeRoot, ".codex/skills"), { recursive: true });
    mkdirSync(join(homeRoot, ".atomcode/skills"), { recursive: true });
    mkdirSync(join(homeRoot, ".codex/skills/coagenthub-reviewer"), {
      recursive: true,
    });
    writeFileSync(
      join(homeRoot, ".codex/skills/coagenthub-reviewer/SKILL.md"),
      "old reviewer skill",
    );
    const calls = [];
    const fetchImpl = routeFetch(
      [
        {
          method: "GET",
          path: "/participants",
          response: [{ id: "p-reviewer", name: "reviewer", device: "mac" }],
        },
        {
          method: "POST",
          path: "/participants",
          response: { id: "p-executor", name: "executor", device: "mac" },
        },
        {
          method: "POST",
          path: "/groups",
          response: { id: "group-1" },
        },
        {
          method: "GET",
          path: "/groups/group-1/members",
          response: [{ participantId: "p-reviewer", roles: ["reviewer"] }],
        },
        {
          method: "POST",
          path: "/groups/group-1/members",
          response: { participantId: "p-executor", roles: ["executor"] },
        },
        {
          method: "GET",
          path: "/skills/reviewer",
          response: { content: "reviewer skill" },
        },
        {
          method: "GET",
          path: "/skills/executor",
          response: { content: "executor skill" },
        },
      ],
      calls,
    );

    const result = await onboardProject({
      projectPath,
      apiBase: "http://fake.test/api",
      title: "Project one",
      homeRoot,
      creator: {
        name: "reviewer",
        role: "reviewer",
        runtime: "codex",
        device: "mac",
      },
      members: [
        {
          name: "executor",
          role: "executor",
          runtime: "atomcode",
          device: "mac",
        },
      ],
      fetchImpl,
    });

    expect(result.status, result.report).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.reusedParticipants).toEqual(["reviewer"]);
    expect(result.registeredParticipants).toEqual(["executor"]);
    expect(readCoAgentHubGroupId(projectPath)).toBe("group-1");
    expect(
      readFileSync(
        join(homeRoot, ".codex/skills/coagenthub-reviewer/SKILL.md"),
        "utf8",
      ),
    ).toBe("reviewer skill");
    expect(
      readFileSync(
        join(homeRoot, ".atomcode/skills/coagenthub-executor/SKILL.md"),
        "utf8",
      ),
    ).toBe("executor skill");
    expect(result.report).toContain("已更新 skill");

    const groupCall = calls.find(
      (call) => call.method === "POST" && call.path === "/groups",
    );
    expect(groupCall.body).toEqual({
      title: "Project one",
      creatorRole: "reviewer",
    });
    expect(
      calls.filter(
        (call) =>
          call.method === "POST" && call.path === "/groups/group-1/members",
      ),
    ).toHaveLength(1);
  });

  it("keeps only the scaffold and exits non-zero when the platform is unreachable", async () => {
    const projectPath = tempProject();
    const result = await onboardProject({
      projectPath,
      apiBase: "http://offline.test/api",
      creator: { name: "reviewer", role: "reviewer", runtime: "codex" },
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });

    expect(result.platformUnavailable).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.completedSteps).toEqual(["脚手架"]);
    expect(readCoAgentHubGroupId(projectPath)).toBe("");
    expect(result.report).toContain(
      "COAGENTHUB_API_BASE 当前取值为 http://offline.test/api",
    );
  });

  it("rejects an exact-name participant whose explicit device conflicts", async () => {
    const projectPath = tempProject();
    const calls = [];
    const result = await onboardProject({
      projectPath,
      creator: {
        name: "reviewer",
        role: "reviewer",
        runtime: "codex",
        device: "mac",
      },
      fetchImpl: routeFetch(
        [
          {
            method: "GET",
            path: "/participants",
            response: [{ id: "p-reviewer", name: "reviewer", device: "linux" }],
          },
        ],
        calls,
      ),
    });

    expect(result.status).toBe("failed");
    expect(result.report).toContain("属性冲突");
    expect(calls.some((call) => call.path === "/groups")).toBe(false);
    expect(readCoAgentHubGroupId(projectPath)).toBe("");
  });

  it("continues an existing group without creating a replacement group", async () => {
    const projectPath = tempProject();
    const homeRoot = mkdtempSync(join(tmpdir(), "coagenthub-home-"));
    mkdirSync(join(homeRoot, ".codex/skills"), { recursive: true });
    initializeCoAgentHubProject(projectPath);
    writeCoAgentHubGroupId(projectPath, "existing-group");
    const calls = [];
    const result = await onboardProject({
      projectPath,
      homeRoot,
      creator: { name: "reviewer", role: "reviewer", runtime: "codex" },
      fetchImpl: routeFetch(
        [
          {
            method: "GET",
            path: "/groups/existing-group",
            response: { id: "existing-group" },
          },
          {
            method: "GET",
            path: "/participants",
            response: [{ id: "p-reviewer", name: "reviewer", device: null }],
          },
          {
            method: "GET",
            path: "/groups/existing-group/members",
            response: [{ participantId: "p-reviewer", roles: ["reviewer"] }],
          },
          {
            method: "GET",
            path: "/skills/reviewer",
            response: { content: "latest reviewer skill" },
          },
        ],
        calls,
      ),
    });

    expect(result.status, result.report).toBe("completed");
    expect(calls.some((call) => call.path === "/groups")).toBe(false);
    expect(
      calls.some(
        (call) =>
          call.path === "/groups/existing-group/members" &&
          call.method === "POST",
      ),
    ).toBe(false);
    expect(readCoAgentHubGroupId(projectPath)).toBe("existing-group");
  });

  it("reports an unknown runtime for manual skill installation and exits non-zero", async () => {
    const projectPath = tempProject();
    const calls = [];
    const result = await onboardProject({
      projectPath,
      creator: { name: "reviewer", role: "reviewer", runtime: "hermes" },
      fetchImpl: routeFetch(
        [
          {
            method: "GET",
            path: "/participants",
            response: [],
          },
          {
            method: "POST",
            path: "/participants",
            response: { id: "p-reviewer", name: "reviewer" },
          },
          {
            method: "POST",
            path: "/groups",
            response: { id: "group-unknown" },
          },
          {
            method: "GET",
            path: "/groups/group-unknown/members",
            response: [],
          },
          {
            method: "POST",
            path: "/groups/group-unknown/members",
            response: { participantId: "p-reviewer", roles: ["reviewer"] },
          },
        ],
        calls,
      ),
    });

    expect(result.status).toBe("completed-with-warnings");
    expect(result.exitCode).toBe(1);
    expect(result.manualInstall).toEqual([
      {
        member: "reviewer",
        role: "reviewer",
        runtime: "hermes",
        reason: "unknown-runtime",
      },
    ]);
    expect(result.report).toContain("以下成员的 skill 需手工安装: reviewer");
    expect(readCoAgentHubGroupId(projectPath)).toBe("group-unknown");
    expect(calls.some((call) => call.path === "/skills/reviewer")).toBe(false);
  });

  it("requires explicit allocation in non-TTY mode and skips option values as paths", () => {
    expect(() =>
      parseCliArgs(["--title", "Project", "--member", "e:executor:codex"], {
        isTTY: false,
      }),
    ).toThrow(/非 TTY/);
    const options = parseCliArgs(
      [
        "project",
        "--title",
        "Project",
        "--creator",
        "r:reviewer:codex",
        "--member",
        "e:executor:atomcode",
      ],
      { isTTY: false },
    );
    expect(options.projectPath).toBe("project");
    expect(options.creator).toEqual({
      name: "r",
      role: "reviewer",
      runtime: "codex",
    });
    expect(options.members).toEqual([
      { name: "e", role: "executor", runtime: "atomcode" },
    ]);
  });
});

function runtimeSubdir(runtime) {
  return RUNTIME_SKILL_LAYOUTS.find((l) => l.runtime === runtime)?.subdir;
}
