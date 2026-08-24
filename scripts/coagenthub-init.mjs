#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Single source of truth for the runtime -> skills-directory mapping, shared
// with the skill-sync command (spec skill-sync-mechanism R3) and the
// project-onboarding-interactive R6 installer. We import it here rather than
// duplicating the table so the installer and the sync command cannot drift
// apart (spec: 复用同一份目录约定, 不要各写一份).
import {
  coagenthubRoleDir,
  RUNTIME_SKILL_LAYOUTS,
  resolveRuntimeSkillRoot,
  roleSkillPath,
} from "./runtime-skills-dirs.mjs";

export {
  coagenthubRoleDir,
  RUNTIME_SKILL_LAYOUTS,
  resolveRuntimeSkillRoot,
  roleSkillPath,
};

export const COAGENTHUB_SECTION = `## CoAgentHub

\`\`\`json coagenthub
{
  "groupId": ""
}
\`\`\``;

const INITIAL_CONTEXT = `# Project Context

This project is connected to CoAgentHub for participant coordination and task
messaging. Keep project-specific domain terms and architectural decisions here.

## CoAgentHub onboarding

The \`## CoAgentHub\` section in \`AGENTS.md\` is the project marker. It stores only
the current \`groupId\`; roles, API addresses, and participant identities are
runtime facts and must not be copied into this file.

After a group is created, use the onboarding guidance in
\`docs/agents/coagenthub-project-onboarding.md\` to add its members and write
the returned \`groupId\` back to \`AGENTS.md\`.

## Runtime loading limitation

There is no universal startup mechanism that reads this file. Runtime
conventions differ: Codex reads \`AGENTS.md\`, Claude Code uses \`CLAUDE.md\`, and
some runtimes do not load either automatically. The marker is a shared
criterion, while loading is a runtime-specific adapter. If an agent does not
automatically see this section after onboarding, prompt it to read the section
once manually.
`;

const INITIAL_ADR = `# ADR 0001: Project onboarding marker

## Status

Accepted

## Decision

New projects use an offline \`/init\` scaffold. The only persisted project fact
for CoAgentHub is \`groupId\` in the \`## CoAgentHub\` section of \`AGENTS.md\`.
Group membership, roles, API addresses, and participant identities remain
runtime or machine-level facts.

## Consequences

- Initialization works without a running CoAgentHub server.
- The separate onboarding guidance creates the group and adds members through
  the existing API, then writes the returned group id into \`AGENTS.md\`.
- Runtimes may need a manual prompt to read the marker section because there is
  no universal startup file-loading mechanism.
`;

const CURSORRULES = `# CoAgentHub project conventions

- Read \`AGENTS.md\` and \`CONTEXT.md\` before changing project code.
- Keep the \`## CoAgentHub\` marker limited to its \`groupId\` field.
- Use the existing project formatter, linter, type checker, and test commands.
`;

export const ONBOARDING_GUIDANCE = `# CoAgentHub project onboarding

Give this instruction to an agent that can call the CoAgentHub HTTP API. This
is the post-init network step; the \`/init\` scaffold itself is offline.

## Variables

- \`COAGENTHUB_API_BASE\`: API base URL, for example
  \`http://localhost:3001/api\`.
- \`COAGENTHUB_PARTICIPANT_ID\`: the participant creating the group.
- \`GROUP_TITLE\`: the title for this project group.
- \`MEMBERS\`: participant ids and their one in-group role, for example
  \`[{"participantId":"<uuid>","roles":["executor"]}]\`.

## Instruction

1. Read the existing \`AGENTS.md\` and confirm that its \`## CoAgentHub\` section
   contains the fenced \`json coagenthub\` block. Do not run \`/init\` again.
2. Create the group with \`POST $COAGENTHUB_API_BASE/groups\`, sending
   \`{"title":"$GROUP_TITLE"}\` and the
   \`X-Participant-Id: $COAGENTHUB_PARTICIPANT_ID\` header. Save the returned
   group \`id\` as \`groupId\`.
3. For every entry in \`MEMBERS\`, call
   \`POST $COAGENTHUB_API_BASE/groups/$groupId/members\` with its
   \`participantId\`, \`roles\`, and optional in-group \`prompt\`. Use the
   existing member endpoint; do not create a second membership mechanism.
4. As the final step, update only the \`groupId\` value in the fenced block in
   \`AGENTS.md\` to the real id returned by group creation. Preserve the rest
   of the file and do not add \`role\`, \`apiBase\`, or \`participantId\` to the
   CoAgentHub section.
5. Read the file back and verify that the section contains the exact returned
   \`groupId\`. Report the group id and the members added.

The web UI is an alternative: create the group and add members in the group
management page, then perform the same final \`groupId\` write-back.
`;

const MARKER_FENCE =
  /^[ \t]*```json[ \t]+coagenthub[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/m;

function findCoAgentHubSection(contents) {
  const heading = /^##[ \t]+CoAgentHub[ \t]*$/m.exec(contents);
  if (!heading || heading.index === undefined) return null;

  const sectionContentStart = heading.index + heading[0].length;
  const remainder = contents.slice(sectionContentStart);
  const nextHeading = /^##[ \t]+/m.exec(remainder);
  const sectionContentEnd =
    nextHeading?.index === undefined
      ? contents.length
      : sectionContentStart + nextHeading.index;

  return {
    content: contents.slice(sectionContentStart, sectionContentEnd),
    contentStart: sectionContentStart,
    contentEnd: sectionContentEnd,
  };
}

/** Return whether text contains the exact CoAgentHub section marker. */
export function hasCoAgentHubSection(contents) {
  const section = findCoAgentHubSection(contents);
  return section !== null && MARKER_FENCE.test(section.content);
}

/** Return whether a directory is marked as a CoAgentHub project. */
export function isCoAgentHubProject(projectPath) {
  try {
    const agentsPath = resolve(projectPath, "AGENTS.md");
    return hasCoAgentHubSection(readFileSync(agentsPath, "utf8"));
  } catch {
    return false;
  }
}

function markerSectionForGroup(groupId) {
  return `## CoAgentHub

\`\`\`json coagenthub
${JSON.stringify({ groupId }, null, 2)}
\`\`\``;
}

/** Update only the marker's groupId payload, preserving the rest of AGENTS.md. */
export function updateCoAgentHubGroupId(contents, groupId) {
  if (typeof groupId !== "string" || groupId.trim() === "") {
    throw new Error("groupId must be a non-empty string");
  }

  const section = findCoAgentHubSection(contents);
  if (!section)
    throw new Error("AGENTS.md is missing the ## CoAgentHub section");

  const fence = MARKER_FENCE.exec(section.content);
  if (!fence || fence.index === undefined) {
    throw new Error(
      "AGENTS.md is missing the fenced json coagenthub marker block",
    );
  }

  const start = section.contentStart + fence.index;
  const end = start + fence[0].length;
  return `${contents.slice(0, start)}${markerSectionForGroup(groupId)}${contents.slice(end)}`;
}

/** Write the returned group id into a project's existing marker section. */
export function writeCoAgentHubGroupId(projectPath, groupId) {
  const agentsPath = resolve(projectPath, "AGENTS.md");
  const contents = readFileSync(agentsPath, "utf8");
  writeFileSync(agentsPath, updateCoAgentHubGroupId(contents, groupId));
}

function writeIfMissing(projectPath, relativePath, contents) {
  const target = resolve(projectPath, relativePath);
  if (existsSync(target)) return false;
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, contents);
  return true;
}

function ensureAgentsMarker(projectPath) {
  const target = resolve(projectPath, "AGENTS.md");
  if (!existsSync(target)) {
    writeFileSync(target, `${COAGENTHUB_SECTION}\n`);
    return true;
  }

  const contents = readFileSync(target, "utf8");
  if (hasCoAgentHubSection(contents)) return false;
  const separator =
    contents.length > 0 && !contents.endsWith("\n") ? "\n\n" : "\n";
  writeFileSync(target, `${contents}${separator}${COAGENTHUB_SECTION}\n`);
  return true;
}

/** Create the offline project scaffold without overwriting existing files. */
export function initializeCoAgentHubProject(projectPath = ".") {
  const absolutePath = resolve(projectPath);
  mkdirSync(absolutePath, { recursive: true });

  const created = [];
  const skipped = [];
  const markerChanged = ensureAgentsMarker(absolutePath);
  (markerChanged ? created : skipped).push("AGENTS.md marker section");

  const files = [
    ["CONTEXT.md", INITIAL_CONTEXT],
    ["docs/adr/0001-coagenthub-onboarding.md", INITIAL_ADR],
    ["specs/.gitkeep", ""],
    [".cursorrules", CURSORRULES],
    ["docs/agents/coagenthub-project-onboarding.md", ONBOARDING_GUIDANCE],
  ];
  for (const [relativePath, contents] of files) {
    if (writeIfMissing(absolutePath, relativePath, contents))
      created.push(relativePath);
    else skipped.push(relativePath);
  }

  return { projectPath: absolutePath, created, skipped };
}

/**
 * Resolve the absolute install path of a member's skill file under a home
 * root, given the member's runtime and role. This is the R6 (skill install)
 * directory resolution: it reuses the shared runtime-directory mapping so the
 * installer and the sync command resolve exactly the same paths.
 *
 * Returns null for an unknown runtime so callers can list the member as a
 * manual-install item rather than guessing a path (project-onboarding-interactive
 * R6: 不猜、不创建).
 */
export function resolveSkillInstallPath(homeRoot, runtime, role) {
  const root = resolveRuntimeSkillRoot(homeRoot, runtime);
  if (root === null) return null;
  return roleSkillPath(root, role);
}

function usage() {
  return `Usage:
  pnpm coagenthub:init [project-path]
  node scripts/coagenthub-init.mjs [project-path]

The command is offline and creates only missing project scaffold files.`;
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }
  if (argv.some((arg) => arg.startsWith("-"))) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const result = initializeCoAgentHubProject(argv[0] ?? ".");
  console.log(`CoAgentHub scaffold ready: ${result.projectPath}`);
  for (const relativePath of result.created)
    console.log(`created: ${relativePath}`);
  for (const relativePath of result.skipped)
    console.log(`kept: ${relativePath}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
