#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
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

Run \`pnpm coagenthub:init\` with the role/runtime allocation to probe the
platform, align participants, create or continue the group, install skills,
and write the returned \`groupId\` back to \`AGENTS.md\`.

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

New projects use \`/init\` for the scaffold and, when the platform is reachable,
complete participant/group onboarding. If the platform is unavailable, the
scaffold remains usable and a later \`/init\` continues the network steps. The
only persisted project fact for CoAgentHub is \`groupId\` in the
\`## CoAgentHub\` section of \`AGENTS.md\`; group membership, roles, API
addresses, and participant identities remain runtime or machine-level facts.

## Consequences

- Platform unavailability leaves a clear, non-zero continuation point rather
  than pretending that onboarding completed.
- The command creates the group and adds members through the existing API, then
  writes the returned group id into \`AGENTS.md\` as its final step.
- Runtimes may need a manual prompt to read the marker section because there is
  no universal startup file-loading mechanism.
`;

const CURSORRULES = `# CoAgentHub project conventions

- Read \`AGENTS.md\` and \`CONTEXT.md\` before changing project code.
- Keep the \`## CoAgentHub\` marker limited to its \`groupId\` field.
- Use the existing project formatter, linter, type checker, and test commands.
`;

export const ONBOARDING_GUIDANCE = `# CoAgentHub project onboarding

Use the repository command to complete onboarding in one run. In a TTY it asks
for the allocation; for an agent or other non-TTY caller, provide every
allocation as an argument so the command never waits for input:

\`pnpm coagenthub:init . --title PROJECT --creator NAME:ROLE:RUNTIME \\
  --member NAME:ROLE:RUNTIME\`

## Variables

- \`COAGENTHUB_API_BASE\`: API base URL, for example
  \`http://localhost:3001/api\`.
- \`COAGENTHUB_PARTICIPANT_ID\`: the participant creating the group.
- \`GROUP_TITLE\`: the title for this project group.
- \`MEMBERS\`: participant ids and their one in-group role, for example
  \`[{"participantId":"<uuid>","roles":["executor"]}]\`.

## Instruction

1. The command reads the existing \`AGENTS.md\` and confirms that its \`## CoAgentHub\` section
   contains the fenced \`json coagenthub\` block. Do not run \`/init\` again.
2. It creates the group with \`POST $COAGENTHUB_API_BASE/groups\`, sending
   \`{"title":"$GROUP_TITLE", "creatorRole":"$CREATOR_ROLE"}\` and the
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

The command reuses participants by exact name, installs role skills into known
runtime roots, and exits non-zero for an unavailable platform, a conflicting
participant, or a manual skill-install item. A non-empty marker \`groupId\` is
validated and never silently replaced; rerunning after a platform outage
continues from the existing scaffold.
`;

const MARKER_FENCE =
  /^[ \t]*```json[ \t]+coagenthub[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/m;

const DEFAULT_API_BASE = "http://localhost:3001/api";
const ONBOARDING_ROLES = new Set([
  "coordinator",
  "executor",
  "bugfix",
  "reviewer",
]);

class OnboardingError extends Error {
  constructor(message, { step, cause } = {}) {
    super(message, { cause });
    this.name = "OnboardingError";
    this.step = step;
  }
}

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
  return `\`\`\`json coagenthub
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

/** Read the persisted group id, returning an empty string for a fresh marker. */
export function readCoAgentHubGroupId(projectPath) {
  const contents = readFileSync(resolve(projectPath, "AGENTS.md"), "utf8");
  const section = findCoAgentHubSection(contents);
  if (!section) return null;
  const fence = MARKER_FENCE.exec(section.content);
  if (!fence) return null;

  try {
    const marker = JSON.parse(fence[1]);
    return typeof marker.groupId === "string" ? marker.groupId : null;
  } catch {
    return null;
  }
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

function apiUrl(apiBase, path) {
  return `${apiBase.replace(/\/+$/, "")}${path}`;
}

function requestHeaders(participantId) {
  return {
    ...(participantId ? { "X-Participant-Id": participantId } : {}),
  };
}

async function responseError(response) {
  let detail = "";
  try {
    const body = await response.json();
    detail = body?.message || body?.error || body?.code || "";
  } catch {
    // A non-JSON error body is still reported with its HTTP status.
  }
  return `HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
}

async function requestJson(
  fetchImpl,
  apiBase,
  path,
  { method = "GET", body, participantId, step } = {},
) {
  let response;
  try {
    response = await fetchImpl(apiUrl(apiBase, path), {
      method,
      headers: {
        ...requestHeaders(participantId),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (cause) {
    throw new OnboardingError(
      `${step || "平台请求"}失败: ${cause?.message || String(cause)}`,
      { step, cause },
    );
  }

  if (!response.ok) {
    throw new OnboardingError(
      `${step || "平台请求"}失败: ${await responseError(response)}`,
      {
        step,
      },
    );
  }

  try {
    return await response.json();
  } catch (cause) {
    throw new OnboardingError(`${step || "平台请求"}返回了无效 JSON`, {
      step,
      cause,
    });
  }
}

function validateAssignment(assignment, label) {
  if (!assignment || typeof assignment !== "object")
    throw new Error(`${label}必须是对象`);
  if (typeof assignment.name !== "string" || assignment.name.trim() === "")
    throw new Error(`${label}.name 不能为空`);
  if (!ONBOARDING_ROLES.has(assignment.role))
    throw new Error(
      `${label}.role 必须是 coordinator、executor、bugfix 或 reviewer`,
    );
  if (
    typeof assignment.runtime !== "string" ||
    assignment.runtime.trim() === ""
  )
    throw new Error(`${label}.runtime 不能为空`);
  if (
    assignment.device !== undefined &&
    assignment.device !== null &&
    typeof assignment.device !== "string"
  ) {
    throw new Error(`${label}.device 必须是字符串`);
  }
}

function normalizeAssignments({ creator, members = [] }) {
  validateAssignment(creator, "creator");
  if (!Array.isArray(members)) throw new Error("members 必须是数组");
  members.forEach((member, index) => {
    validateAssignment(member, `members[${index}]`);
  });

  const names = new Set();
  for (const assignment of [creator, ...members]) {
    if (names.has(assignment.name))
      throw new Error(`参与方名字重复: ${assignment.name}`);
    names.add(assignment.name);
  }
  return [creator, ...members];
}

function participantAttributesConflict(existing, assignment) {
  return (
    assignment.device !== undefined &&
    (existing.device ?? null) !== (assignment.device ?? null)
  );
}

function registrationBody(assignment) {
  return {
    name: assignment.name,
    ...(assignment.device !== undefined ? { device: assignment.device } : {}),
    ...(assignment.capabilities !== undefined
      ? { capabilities: assignment.capabilities }
      : {}),
  };
}

async function alignParticipants(
  assignments,
  { apiBase, fetchImpl, participantId, result },
) {
  const existing = await requestJson(fetchImpl, apiBase, "/participants", {
    participantId,
    step: "读取参与方",
  });
  if (!Array.isArray(existing))
    throw new OnboardingError("读取参与方失败: 返回格式不是数组", {
      step: "参与方对齐",
    });

  let activeParticipantId = participantId;
  const resolved = new Map();
  for (const assignment of assignments) {
    const match = existing.find((item) => item?.name === assignment.name);
    if (match) {
      if (participantAttributesConflict(match, assignment)) {
        throw new OnboardingError(
          `参与方名字「${assignment.name}」已存在但属性冲突，请由用户决定是否复用`,
          { step: "参与方对齐" },
        );
      }
      resolved.set(assignment.name, {
        assignment,
        participant: match,
        reused: true,
      });
      result.reusedParticipants.push(assignment.name);
    } else {
      const participant = await requestJson(
        fetchImpl,
        apiBase,
        "/participants",
        {
          method: "POST",
          body: registrationBody(assignment),
          participantId: activeParticipantId,
          step: `注册参与方「${assignment.name}」`,
        },
      );
      if (!participant?.id)
        throw new OnboardingError(
          `注册参与方「${assignment.name}」失败: 返回缺少 id`,
          {
            step: "参与方对齐",
          },
        );
      resolved.set(assignment.name, {
        assignment,
        participant,
        reused: false,
      });
      result.registeredParticipants.push(assignment.name);
      existing.push(participant);
    }
  }

  const creator = resolved.get(assignments[0].name);
  if (!creator?.participant?.id)
    throw new OnboardingError("创建者参与方缺少 id", { step: "参与方对齐" });
  if (participantId && participantId !== creator.participant.id) {
    throw new OnboardingError(
      `COAGENTHUB_PARTICIPANT_ID 与 creator「${assignments[0].name}」不一致`,
      { step: "参与方对齐" },
    );
  }
  activeParticipantId = creator.participant.id;
  return { activeParticipantId, resolved };
}

async function installSkills(assignments, { apiBase, fetchImpl, result }) {
  const skillContents = new Map();
  for (const assignment of assignments) {
    const homeRoot = assignment.homeRoot ?? result.homeRoot;
    const installPath = resolveSkillInstallPath(
      homeRoot,
      assignment.runtime,
      assignment.role,
    );

    if (installPath === null) {
      result.manualInstall.push({
        member: assignment.name,
        role: assignment.role,
        runtime: assignment.runtime,
        reason: "unknown-runtime",
      });
      continue;
    }

    const runtimeRoot = resolveRuntimeSkillRoot(homeRoot, assignment.runtime);
    if (!existsSync(runtimeRoot)) {
      result.manualInstall.push({
        member: assignment.name,
        role: assignment.role,
        runtime: assignment.runtime,
        reason: "runtime-dir-missing",
      });
      continue;
    }

    let content = skillContents.get(assignment.role);
    if (!content) {
      try {
        const body = await requestJson(
          fetchImpl,
          apiBase,
          `/skills/${encodeURIComponent(assignment.role)}`,
          { step: `获取 ${assignment.role} skill` },
        );
        if (typeof body?.content !== "string")
          throw new Error("返回缺少 content");
        content = body.content;
        skillContents.set(assignment.role, content);
      } catch (error) {
        result.skillFailures.push({
          member: assignment.name,
          role: assignment.role,
          reason: error.message,
        });
        continue;
      }
    }

    try {
      const existed = existsSync(installPath);
      mkdirSync(resolve(installPath, ".."), { recursive: true });
      writeFileSync(installPath, content);
      result.skillInstalls.push({
        member: assignment.name,
        role: assignment.role,
        runtime: assignment.runtime,
        path: installPath,
        status: existed ? "updated" : "installed",
      });
    } catch (error) {
      result.skillFailures.push({
        member: assignment.name,
        role: assignment.role,
        runtime: assignment.runtime,
        reason: error.message,
      });
    }
  }
}

function formatManualInstall(item) {
  return `以下成员的 skill 需手工安装: ${item.member}(${item.role}, ${item.runtime})`;
}

function formatOnboardingReport(result) {
  const lines = [
    `CoAgentHub /init: ${result.status}`,
    `平台: ${result.apiBase}`,
    `已完成: ${result.completedSteps.length ? result.completedSteps.join(" → ") : "无"}`,
  ];
  if (result.groupId) lines.push(`groupId: ${result.groupId}`);
  if (result.reusedParticipants.length)
    lines.push(`已复用参与方: ${result.reusedParticipants.join(", ")}`);
  if (result.registeredParticipants.length)
    lines.push(`已注册参与方: ${result.registeredParticipants.join(", ")}`);
  for (const install of result.skillInstalls)
    lines.push(
      `${install.status === "updated" ? "已更新" : "已安装"} skill: ${install.member} → ${install.path}`,
    );
  for (const item of result.manualInstall)
    lines.push(formatManualInstall(item));
  for (const failure of result.skillFailures)
    lines.push(
      `skill 安装失败: ${failure.member}(${failure.role}): ${failure.reason}`,
    );
  for (const error of result.errors) lines.push(`错误: ${error}`);
  if (result.platformUnavailable) {
    lines.push(`平台不可达，COAGENTHUB_API_BASE 当前取值为 ${result.apiBase}`);
    lines.push(
      "groupId 仍为空；平台恢复后重跑 /init，它会复用已有脚手架并补做联网部分。",
    );
  }
  return lines.join("\n");
}

/**
 * Run the complete interactive onboarding flow.
 *
 * All network access is behind fetchImpl and all filesystem roots are inputs,
 * which keeps the command testable without a running backend or real home.
 */
export async function onboardProject({
  projectPath = ".",
  // This is a standalone CLI entry point, not a Turborepo task input.
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: runtime CLI configuration
  apiBase = process.env.COAGENTHUB_API_BASE || DEFAULT_API_BASE,
  creator,
  members = [],
  title,
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: runtime CLI identity
  participantId = process.env.COAGENTHUB_PARTICIPANT_ID,
  homeRoot = homedir(),
  fetchImpl = fetch,
} = {}) {
  const scaffold = initializeCoAgentHubProject(projectPath);
  const result = {
    status: "failed",
    exitCode: 1,
    projectPath: scaffold.projectPath,
    apiBase,
    homeRoot,
    scaffold,
    completedSteps: ["脚手架"],
    groupId: readCoAgentHubGroupId(scaffold.projectPath),
    reusedParticipants: [],
    registeredParticipants: [],
    skillInstalls: [],
    manualInstall: [],
    skillFailures: [],
    errors: [],
    platformUnavailable: false,
  };

  let assignments;
  try {
    assignments = normalizeAssignments({ creator, members });
  } catch (error) {
    result.errors.push(error.message);
    result.report = formatOnboardingReport(result);
    return result;
  }

  let activeParticipantId = participantId;
  try {
    // A non-empty marker is an idempotent continuation, not permission to
    // create a replacement group.
    if (result.groupId) {
      await requestJson(fetchImpl, apiBase, `/groups/${result.groupId}`, {
        participantId: activeParticipantId,
        step: `校验已有群 ${result.groupId}`,
      });
      result.completedSteps.push("校验已有群");
    } else {
      try {
        await requestJson(fetchImpl, apiBase, "/participants", {
          participantId: activeParticipantId,
          step: "探测 CoAgentHub 平台",
        });
        result.completedSteps.push("探测平台");
      } catch (error) {
        result.platformUnavailable = true;
        result.errors.push(error.message);
        result.report = formatOnboardingReport(result);
        return result;
      }
    }

    const aligned = await alignParticipants(assignments, {
      apiBase,
      fetchImpl,
      participantId: activeParticipantId,
      result,
    });
    activeParticipantId = aligned.activeParticipantId;
    result.completedSteps.push("参与方对齐");

    if (!result.groupId) {
      const group = await requestJson(fetchImpl, apiBase, "/groups", {
        method: "POST",
        participantId: activeParticipantId,
        body: {
          title: title || basename(scaffold.projectPath),
          // This is intentionally explicit; omitting it silently creates a
          // coordinator when the caller is a reviewer.
          creatorRole: assignments[0].role,
        },
        step: "创建群",
      });
      if (!group?.id)
        throw new OnboardingError("创建群失败: 返回缺少 groupId", {
          step: "建群",
        });
      result.groupId = group.id;
      result.completedSteps.push("建群");
    }

    let groupMembers = [];
    try {
      groupMembers = await requestJson(
        fetchImpl,
        apiBase,
        `/groups/${result.groupId}/members`,
        { participantId: activeParticipantId, step: "读取群成员" },
      );
      if (!Array.isArray(groupMembers)) groupMembers = [];
    } catch (error) {
      throw new OnboardingError(error.message, { step: "成员对齐" });
    }
    const memberById = new Map(
      groupMembers.map((member) => [member.participantId, member]),
    );
    for (const assignment of assignments) {
      const participant = aligned.resolved.get(assignment.name).participant;
      const current = memberById.get(participant.id);
      if (
        current &&
        Array.isArray(current.roles) &&
        current.roles.length === 1 &&
        current.roles[0] === assignment.role
      ) {
        continue;
      }
      const body = {
        participantId: participant.id,
        roles: [assignment.role],
        ...(assignment.prompt !== undefined
          ? { prompt: assignment.prompt }
          : {}),
      };
      await requestJson(
        fetchImpl,
        apiBase,
        `/groups/${result.groupId}/members`,
        {
          method: "POST",
          participantId: activeParticipantId,
          body,
          step: `加入成员「${assignment.name}」`,
        },
      );
    }
    result.completedSteps.push("成员对齐");

    await installSkills(assignments, { apiBase, fetchImpl, result });
    result.completedSteps.push("安装 skill");

    writeCoAgentHubGroupId(scaffold.projectPath, result.groupId);
    const writtenGroupId = readCoAgentHubGroupId(scaffold.projectPath);
    if (writtenGroupId !== result.groupId) {
      throw new OnboardingError(
        `AGENTS.md groupId 回读不一致: expected ${result.groupId}, got ${writtenGroupId}`,
        { step: "回填 groupId" },
      );
    }
    result.completedSteps.push("回填 groupId");
    result.status =
      result.manualInstall.length || result.skillFailures.length
        ? "completed-with-warnings"
        : "completed";
    result.exitCode =
      result.manualInstall.length || result.skillFailures.length ? 1 : 0;
  } catch (error) {
    result.errors.push(error.message);
    result.status = "failed";
  }

  result.report = formatOnboardingReport(result);
  return result;
}

function parseAssignment(value, label) {
  const parts = value.split(":");
  if (parts.length !== 3 || parts.some((part) => part.trim() === ""))
    throw new Error(`${label} 格式必须为 name:role:runtime`);
  return { name: parts[0], role: parts[1], runtime: parts[2] };
}

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  if (index + 1 >= argv.length) throw new Error(`${name} 缺少参数`);
  return argv[index + 1];
}

function readRepeatedFlag(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== name) continue;
    if (index + 1 >= argv.length) throw new Error(`${name} 缺少参数`);
    values.push(argv[index + 1]);
  }
  return values;
}

function positionalProjectPath(argv) {
  const valueFlags = new Set([
    "--title",
    "--creator",
    "--member",
    "--api-base",
    "--participant-id",
    "--home-root",
  ]);
  for (let index = 0; index < argv.length; index++) {
    if (valueFlags.has(argv[index])) {
      index++;
      continue;
    }
    if (!argv[index].startsWith("-")) return argv[index];
  }
  return ".";
}

export function parseCliArgs(argv, { isTTY = process.stdin.isTTY } = {}) {
  const projectPath = positionalProjectPath(argv);
  const creatorValue = readFlag(argv, "--creator");
  if (!creatorValue && !isTTY)
    throw new Error(
      "非 TTY 下必须提供 --creator name:role:runtime（不会提示或阻塞）",
    );
  if (!creatorValue)
    throw new Error("TTY 交互模式请由 main 提示收集 creator 分配");

  return {
    projectPath,
    title: readFlag(argv, "--title"),
    apiBase: readFlag(argv, "--api-base"),
    participantId: readFlag(argv, "--participant-id"),
    homeRoot: readFlag(argv, "--home-root"),
    creator: parseAssignment(creatorValue, "--creator"),
    members: readRepeatedFlag(argv, "--member").map((value, index) =>
      parseAssignment(value, `--member[${index}]`),
    ),
  };
}

async function collectInteractiveOptions(argv) {
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const projectPath = positionalProjectPath(argv);
    const title =
      readFlag(argv, "--title") ||
      (await input.question(
        `群标题（默认 ${basename(resolve(projectPath))}）: `,
      )) ||
      undefined;
    const creatorValue =
      readFlag(argv, "--creator") ||
      (await input.question("创建者分配（name:role:runtime）: "));
    const memberValues = readRepeatedFlag(argv, "--member");
    if (memberValues.length === 0) {
      const members = await input.question(
        "其他成员分配（逗号分隔 name:role:runtime，留空结束）: ",
      );
      if (members.trim()) memberValues.push(...members.split(","));
    }
    return {
      projectPath,
      title,
      apiBase: readFlag(argv, "--api-base"),
      participantId: readFlag(argv, "--participant-id"),
      homeRoot: readFlag(argv, "--home-root"),
      creator: parseAssignment(creatorValue, "creator"),
      members: memberValues
        .filter((value) => value.trim())
        .map((value, index) =>
          parseAssignment(value.trim(), `member[${index}]`),
        ),
    };
  } finally {
    input.close();
  }
}

function usage() {
  return `Usage:
  pnpm coagenthub:init [project-path] --creator name:role:runtime [options]
  node scripts/coagenthub-init.mjs [project-path] --creator name:role:runtime [options]

Complete project onboarding. In a non-TTY, --creator is required and the
command never prompts or blocks.

  --title TITLE                  group title (defaults to project directory)
  --creator NAME:ROLE:RUNTIME   creator allocation; creatorRole is always sent
  --member NAME:ROLE:RUNTIME    repeat for each additional allocation
  --api-base URL                 default: COAGENTHUB_API_BASE or ${DEFAULT_API_BASE}
  --participant-id ID            identity for X-Participant-Id
  --home-root DIR                skill root for local runtime installs`;
}

export async function main(argv, { isTTY = process.stdin.isTTY } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }

  let options;
  try {
    options =
      isTTY && readFlag(argv, "--creator") === undefined
        ? await collectInteractiveOptions(argv)
        : parseCliArgs(argv, { isTTY });
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  if (options.apiBase === undefined) delete options.apiBase;
  if (options.participantId === undefined) delete options.participantId;
  if (options.homeRoot === undefined) delete options.homeRoot;

  const result = await onboardProject(options);
  console.log(result.report);
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
