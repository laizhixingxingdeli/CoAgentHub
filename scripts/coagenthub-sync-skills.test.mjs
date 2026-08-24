import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyWrite,
  fetchRemoteDigests,
  localSkillVersion,
  planSync,
  sha256Short,
  syncSkills,
} from "./coagenthub-sync-skills.mjs";
import {
  RUNTIME_SKILL_LAYOUTS,
  resolveRuntimeSkillRoot,
  roleSkillPath,
} from "./runtime-skills-dirs.mjs";

let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "coagenthub-sync-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Build a fake `fetch` backed by an in-memory role -> {version,content} map. */
function fakeFetch(map) {
  return async (url) => {
    const m = /\/skills\/([^/]+)(\/digest)?$/.exec(url);
    const role = m?.[1];
    const digest = m?.[2];
    const entry = map[role];
    if (!entry) {
      return {
        ok: false,
        status: 404,
        json: async () => ({ code: "NOT_FOUND" }),
      };
    }
    if (digest) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: role, version: entry.version }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        name: role,
        version: entry.version,
        content: entry.content,
      }),
    };
  };
}

function writeInstalled(root, role, content) {
  const p = roleSkillPath(root, role);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  return p;
}

describe("hash fingerprint", () => {
  it("is stable for identical content and changes for a one-char edit", () => {
    const a = sha256Short("hello skill");
    const b = sha256Short("hello skill");
    const c = sha256Short("hello skilX");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(sha256Short("x").length).toBe(12);
  });
});

describe("shared runtime-directory mapping (reused with R6)", () => {
  it("resolves a known runtime root and is null for an unknown one", () => {
    expect(resolveRuntimeSkillRoot("/h", "codex")).toBe(
      join("/h", ".codex", "skills"),
    );
    expect(resolveRuntimeSkillRoot("/h", "codebuddy")).toBe(
      join("/h", ".codebuddy", "skills"),
    );
    expect(resolveRuntimeSkillRoot("/h", "nope")).toBeNull();
  });

  it("lists exactly the four known runtimes", () => {
    expect(RUNTIME_SKILL_LAYOUTS.map((l) => l.runtime)).toEqual([
      "Claude Code",
      "codex",
      "atomcode",
      "codebuddy",
    ]);
  });
});

describe("planSync verdicts", () => {
  it("reports up-to-date when local hash matches the platform", () => {
    const root = join(home, ".codex", "skills");
    const content = "description: x\n";
    writeInstalled(root, "executor", content);
    const verdicts = planSync(home, ["executor"], {
      executor: { version: sha256Short(content) },
    });
    const v = verdicts.find((x) => x.role === "executor");
    expect(v).toEqual({
      status: "up-to-date",
      runtime: "codex",
      role: "executor",
      path: roleSkillPath(root, "executor"),
      localVersion: sha256Short(content),
    });
  });

  it("reports outdated when the local hash differs from the platform", () => {
    const root = join(home, ".claude", "skills");
    writeInstalled(root, "reviewer", "old content v1");
    const verdicts = planSync(home, ["reviewer"], {
      reviewer: { version: sha256Short("new content v2") },
    });
    const v = verdicts.find((x) => x.role === "reviewer");
    expect(v.status).toBe("outdated");
    expect(v.localVersion).not.toBe(v.remoteVersion);
  });

  it("reports missing when the role subdir is absent but the runtime root exists", () => {
    mkdirSync(join(home, ".codebuddy", "skills"), { recursive: true });
    const verdicts = planSync(home, ["executor"], {
      executor: { version: "deadbeef0000" },
    });
    const v = verdicts.find((x) => x.role === "executor");
    expect(v.status).toBe("missing");
    expect(v.remoteVersion).toBe("deadbeef0000");
  });

  it("skips a runtime whose root directory does not exist (no creation)", () => {
    // home is empty: no .codex/.claude/.atomcode/.codebuddy present
    const verdicts = planSync(home, ["executor"], {
      executor: { version: "deadbeef0000" },
    });
    expect(
      verdicts.filter((v) => v.status === "skipped").map((v) => v.runtime),
    ).toEqual(["Claude Code", "codex", "atomcode", "codebuddy"]);
    // nothing was created
    expect(
      RUNTIME_SKILL_LAYOUTS.every((l) => !existsSync(join(home, l.subdir))),
    ).toBe(true);
  });

  it("flags a remote error instead of inventing a verdict", () => {
    const root = join(home, ".codex", "skills");
    writeInstalled(root, "executor", "local");
    const verdicts = planSync(home, ["executor"], {
      executor: { error: "HTTP 500" },
    });
    const v = verdicts.find((x) => x.role === "executor");
    expect(v.status).toBe("remote-error");
  });
});

describe("fetchRemoteDigests", () => {
  it("returns version for ok responses and error for non-ok", async () => {
    const map = {
      executor: { version: "abc123", content: "x" },
    };
    const digests = await fetchRemoteDigests(
      "http://x/api",
      ["executor", "reviewer"],
      fakeFetch(map),
    );
    expect(digests.executor).toEqual({ version: "abc123" });
    expect(digests.reviewer).toEqual({ error: "HTTP 404" });
  });
});

describe("syncSkills end-to-end (no real backend, no real home)", () => {
  const map = {
    executor: {
      version: sha256Short("platform executor"),
      content: "platform executor",
    },
    reviewer: {
      version: sha256Short("platform reviewer"),
      content: "platform reviewer",
    },
  };

  it("--check does not write files", async () => {
    const root = join(home, ".codex", "skills");
    const local = writeInstalled(root, "executor", "stale executor"); // differs
    expect(localSkillVersion(local)).not.toBe(map.executor.version);

    const result = await syncSkills({
      homeRoot: home,
      apiBase: "http://x/api",
      fetchImpl: fakeFetch(map),
    });
    expect(result.updated).toEqual([]);
    // file unchanged
    expect(readFileSync(local, "utf8")).toBe("stale executor");
    expect(
      result.verdicts.some(
        (v) => v.role === "executor" && v.status === "outdated",
      ),
    ).toBe(true);
  });

  it("--write overwrites outdated and missing copies and lists updated paths", async () => {
    const root = join(home, ".claude", "skills");
    writeInstalled(root, "executor", "stale executor"); // outdated
    mkdirSync(join(home, ".codebuddy", "skills"), { recursive: true }); // reviewer missing

    const result = await syncSkills({
      homeRoot: home,
      apiBase: "http://x/api",
      write: true,
      fetchImpl: fakeFetch(map),
    });

    const updatedSet = new Set(result.updated);
    expect(updatedSet.has(roleSkillPath(root, "executor"))).toBe(true);
    expect(
      updatedSet.has(
        roleSkillPath(join(home, ".codebuddy", "skills"), "reviewer"),
      ),
    ).toBe(true);
    // content now matches platform
    expect(readFileSync(roleSkillPath(root, "executor"), "utf8")).toBe(
      "platform executor",
    );
    expect(
      readFileSync(
        roleSkillPath(join(home, ".codebuddy", "skills"), "reviewer"),
        "utf8",
      ),
    ).toBe("platform reviewer");
  });

  it("writes nothing when local already matches the platform", async () => {
    const root = join(home, ".codex", "skills");
    writeInstalled(root, "reviewer", "platform reviewer");

    const result = await syncSkills({
      homeRoot: home,
      apiBase: "http://x/api",
      roles: ["reviewer"],
      write: true,
      fetchImpl: fakeFetch(map),
    });
    expect(result.updated).toEqual([]);
    expect(
      result.verdicts.some(
        (v) => v.role === "reviewer" && v.status === "up-to-date",
      ),
    ).toBe(true);
  });
});

describe("applyWrite skips non-outdated verdicts", () => {
  it("does not touch up-to-date or skipped targets", async () => {
    const updated = await applyWrite(
      [
        { status: "up-to-date", role: "executor", path: join(home, "e") },
        { status: "skipped", runtime: "codex", role: null },
      ],
      "http://x/api",
      fakeFetch({}),
    );
    expect(updated).toEqual([]);
  });
});
