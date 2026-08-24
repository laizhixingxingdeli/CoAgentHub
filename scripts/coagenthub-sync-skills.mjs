#!/usr/bin/env node

// scripts/coagenthub-sync-skills.mjs
//
// Make stale installed skill copies visible and easy to fix (spec
// skill-sync-mechanism.md R3). It is a *report-and-fix* tool, NOT an
// auto-sync mechanism (R4): no polling, no startup fetch, no dispatch-time
// refresh.
//
// Behaviour:
//   - default (--check): only report differences, never write files
//   - --write: overwrite out-of-date / missing local copies, listing each path
//
// The runtime-directory mapping is the shared single source of truth from
// runtime-skills-dirs.mjs (reused with project-onboarding-interactive R6), so
// the installer and this command cannot drift apart.
//
// Injectable for tests: `homeRoot` (no real home writes) and `fetchImpl`
// (no real backend). Never writes to a user home directory in tests.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_SKILL_LAYOUTS,
  resolveRuntimeSkillRoot,
  roleSkillPath,
} from "./runtime-skills-dirs.mjs";

const DEFAULT_API_BASE = "http://localhost:3001/api";

// Roles tracked by the platform (mirrors SKILL_NAMES in
// packages/backend/server/src/routes/skills.ts). The content hash the platform
// returns is computed per role; a new role here is a new sync target.
export const SYNC_ROLES = ["coordinator", "executor", "bugfix", "reviewer"];

/** sha256(SKILL.md content) first 12 hex chars — matches the platform fingerprint. */
export function sha256Short(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/** Content hash of a local installed skill file. */
export function localSkillVersion(path) {
  return sha256Short(readFileSync(path, "utf8"));
}

/**
 * Fetch the platform-side fingerprint for each role via the lightweight
 * `/digest` endpoint (no full SKILL.md download). `fetchImpl` is injectable so
 * tests can run without a backend. Returns { [role]: { version } | { error } }.
 */
export async function fetchRemoteDigests(apiBase, roles, fetchImpl = fetch) {
  const base = apiBase.replace(/\/+$/, "");
  const results = {};
  await Promise.all(
    roles.map(async (role) => {
      try {
        const res = await fetchImpl(`${base}/skills/${role}/digest`);
        if (!res.ok) {
          results[role] = { error: `HTTP ${res.status}` };
          return;
        }
        const body = await res.json();
        results[role] = { version: body.version };
      } catch (err) {
        results[role] = { error: String(err?.message || err) };
      }
    }),
  );
  return results;
}

/**
 * Plan the sync for every (runtime × role) target under a home root. Pure
 * read/compare — never writes. Returns one verdict per target:
 *   { status: "skipped",      runtime, role: null, reason }
 *   { status: "up-to-date",   runtime, role, path, localVersion }
 *   { status: "outdated",     runtime, role, path, localVersion, remoteVersion }
 *   { status: "missing",      runtime, role, path, remoteVersion }
 *   { status: "remote-error", runtime, role, error }
 */
export function planSync(homeRoot, roles, remoteDigests) {
  const verdicts = [];
  for (const { runtime } of RUNTIME_SKILL_LAYOUTS) {
    const root = resolveRuntimeSkillRoot(homeRoot, runtime);
    if (root === null) {
      verdicts.push({
        status: "skipped",
        runtime,
        role: null,
        reason: "unknown-runtime",
      });
      continue;
    }
    if (!existsSync(root)) {
      verdicts.push({
        status: "skipped",
        runtime,
        role: null,
        reason: "runtime-dir-missing",
      });
      continue;
    }
    for (const role of roles) {
      const path = roleSkillPath(root, role);
      const installed = existsSync(path);
      const remote = remoteDigests[role];
      if (remote?.error) {
        verdicts.push({
          status: "remote-error",
          runtime,
          role,
          error: remote.error,
        });
      } else if (!installed) {
        verdicts.push({
          status: "missing",
          runtime,
          role,
          path,
          remoteVersion: remote?.version ?? null,
        });
      } else {
        const localVersion = localSkillVersion(path);
        if (localVersion === remote?.version) {
          verdicts.push({
            status: "up-to-date",
            runtime,
            role,
            path,
            localVersion,
          });
        } else {
          verdicts.push({
            status: "outdated",
            runtime,
            role,
            path,
            localVersion,
            remoteVersion: remote ? remote.version : null,
          });
        }
      }
    }
  }
  return verdicts;
}

/**
 * Apply --write: for every "outdated"/"missing" verdict, fetch the full skill
 * content and overwrite the local file. Returns the list of updated absolute
 * paths. Only the role subdir is created (under an already-existing runtime
 * root); a missing *runtime* root is never created (see planSync: it yields
 * "skipped", not "missing").
 */
export async function applyWrite(verdicts, apiBase, fetchImpl = fetch) {
  const base = apiBase.replace(/\/+$/, "");
  const updated = [];
  for (const v of verdicts) {
    if (v.status !== "outdated" && v.status !== "missing") continue;
    try {
      const res = await fetchImpl(`${base}/skills/${v.role}`);
      if (!res.ok) continue;
      const body = await res.json();
      mkdirSync(resolve(v.path, ".."), { recursive: true });
      writeFileSync(v.path, body.content);
      updated.push(v.path);
    } catch {
      // leave verdict as-is; report will still show the unchanged target
    }
  }
  return updated;
}

/**
 * End-to-end sync. Orchestrates the injectable pieces so tests can exercise the
 * whole flow without a real backend or home directory.
 */
export async function syncSkills({
  homeRoot,
  apiBase = DEFAULT_API_BASE,
  roles = SYNC_ROLES,
  write = false,
  fetchImpl = fetch,
} = {}) {
  const remoteDigests = await fetchRemoteDigests(apiBase, roles, fetchImpl);
  const verdicts = planSync(homeRoot, roles, remoteDigests);
  const updated = write ? await applyWrite(verdicts, apiBase, fetchImpl) : [];
  return { verdicts, updated };
}

function formatReport({ verdicts, updated }) {
  const lines = [];
  let upToDate = 0;
  let outdated = 0;
  let missing = 0;
  let skipped = 0;
  let remoteError = 0;

  for (const v of verdicts) {
    switch (v.status) {
      case "up-to-date":
        upToDate++;
        if (updated.length === 0)
          lines.push(`已是最新: ${v.path} (${v.localVersion})`);
        break;
      case "outdated":
        outdated++;
        if (updated.length > 0) lines.push(`已更新: ${v.path}`);
        else
          lines.push(
            `需要更新: ${v.path} (本地 ${v.localVersion} ≠ 平台 ${v.remoteVersion})`,
          );
        break;
      case "missing":
        missing++;
        if (updated.length > 0) lines.push(`已更新: ${v.path}`);
        else lines.push(`缺失: ${v.path} (平台版本 ${v.remoteVersion})`);
        break;
      case "skipped":
        skipped++;
        lines.push(
          `跳过: ${v.runtime} (${v.reason === "unknown-runtime" ? "未知 runtime" : "runtime 目录不存在"})`,
        );
        break;
      case "remote-error":
        remoteError++;
        lines.push(`错误: ${v.runtime}/${v.role} 获取平台指纹失败: ${v.error}`);
        break;
    }
  }

  lines.push(
    `共 ${verdicts.length} 项: 已是最新 ${upToDate}, 需更新 ${outdated}, 缺失 ${missing}, 跳过 ${skipped}` +
      (remoteError ? `, 平台错误 ${remoteError}` : ""),
  );
  return lines.join("\n");
}

function usage() {
  return `Usage:
  node scripts/coagenthub-sync-skills.mjs [--check | --write] [--api-base URL] [--home-root DIR]

Make stale installed skill copies visible and easy to fix.

  --check       (默认) 只报告差异,不写文件
  --write       覆盖过期/缺失的本地副本,逐条输出已更新路径
  --api-base    平台 API 基址 (默认 ${DEFAULT_API_BASE}, 可用 COAGENTHUB_API_BASE)

目录根(home root)默认取 os.homedir(),可用 --home-root 或 COAGENTHUB_HOME_ROOT
注入(测试用,绝不写真实用户 home)。
`;
}

export async function main(argv) {
  const help = argv.includes("--help") || argv.includes("-h");
  if (help) {
    console.log(usage());
    return;
  }

  const write = !argv.includes("--check") && argv.includes("--write");
  const apiBase =
    (envFlag(argv, "--api-base") ?? process.env.COAGENTHUB_API_BASE) ||
    DEFAULT_API_BASE;
  const homeRoot =
    (envFlag(argv, "--home-root") ?? process.env.COAGENTHUB_HOME_ROOT) ||
    homedir();

  const result = await syncSkills({ homeRoot, apiBase, write });
  console.log(formatReport(result));

  // Exit non-zero only as a signal that a --check found drift (so it can gate
  // CI). After --write the fixable targets are fixed; --check with clean
  // copies, or any "skipped" (missing runtime dir), never fails.
  const needsChange = result.verdicts.some(
    (v) => v.status === "outdated" || v.status === "missing",
  );
  const remoteError = result.verdicts.some((v) => v.status === "remote-error");
  if ((!write && needsChange) || remoteError) {
    process.exitCode = 1;
  }
}

/** Extract `--key value` from argv; returns undefined if absent. */
function envFlag(argv, key) {
  const i = argv.indexOf(key);
  if (i === -1 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
