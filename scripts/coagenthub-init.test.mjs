import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasCoAgentHubSection,
  initializeCoAgentHubProject,
  isCoAgentHubProject,
  updateCoAgentHubGroupId,
  writeCoAgentHubGroupId,
} from "./coagenthub-init.mjs";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "coagenthub-init-"));
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
