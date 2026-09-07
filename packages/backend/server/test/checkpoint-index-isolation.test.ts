/**
 * 定向验收 specs/checkpoint-must-not-touch-real-index.md(R7)。
 *
 * 判据全部读**真实 git 状态**(status --porcelain / diff --cached --stat /
 * ls-files --stage / ls-tree),不只看 createCheckpoint 的返回值 —— 本票的缺陷
 * 恰恰是「返回值对、真实暂存区被改写」。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCheckpoint, gitExec } from "@server/lib/executor-runner";
import { afterAll, describe, expect, it } from "vitest";

/** 与 executor-runner.ts 中临时 index 的前缀保持一致,用于残留检测。 */
const TMP_INDEX_PREFIX = "coagenthub-cp-index-";

const madeDirs: string[] = [];

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * 造一个含四类状态的仓库:①已暂存改动 ②未暂存改动 ③同一文件部分暂存
 * ④未跟踪文件(另加一个被 .gitignore 忽略的文件,供快照内容断言)。
 */
function makeRepo(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  madeDirs.push(dir);
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@coagenthub.local"], dir);
  git(["config", "user.name", "coagenthub-test"], dir);
  writeFileSync(path.join(dir, "staged.txt"), "l1\nl2\n");
  writeFileSync(path.join(dir, "unstaged.txt"), "l1\nl2\n");
  writeFileSync(
    path.join(dir, "partial.txt"),
    "line1\nline2\nline3\nline4\nline5\nline6\n",
  );
  writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
  git(["add", "-A"], dir);
  git(["commit", "-qm", "seed"], dir);

  // ① 已暂存的改动(index 与 HEAD 不同,与工作区相同)
  writeFileSync(path.join(dir, "staged.txt"), "l1\nl2\nl3-staged\n");
  git(["add", "--", "staged.txt"], dir);
  // ② 未暂存的改动(index 与 HEAD 相同,与工作区不同)
  writeFileSync(path.join(dir, "unstaged.txt"), "l1\nl2\nl3-unstaged\n");
  // ③ 部分暂存:先 add 一版,再改工作区 → HEAD / index / 工作区三者互不相同(MM)
  writeFileSync(
    path.join(dir, "partial.txt"),
    "line1-modified\nline2\nline3\nline4\nline5\nline6\n",
  );
  git(["add", "--", "partial.txt"], dir);
  writeFileSync(
    path.join(dir, "partial.txt"),
    "line1-modified\nline2\nline3\nline4\nline5\nline6-worktree\n",
  );
  // ④ 未跟踪文件(spec §1.2 里被平台误 add 的就是这一类)
  writeFileSync(path.join(dir, "untracked.txt"), "untracked\n");
  // ⑤ 被忽略的文件:不得进快照
  writeFileSync(path.join(dir, "ignored.txt"), "ignored\n");
  return dir;
}

/** 真实暂存区的三份指纹,打快照前后必须逐字相同。 */
function indexState(dir: string) {
  return {
    status: git(["status", "--porcelain"], dir),
    cachedStat: git(["diff", "--cached", "--stat"], dir),
    lsFiles: git(["ls-files", "--stage"], dir),
  };
}

/** 系统临时目录里属于本票的临时 index 文件(含 git 自己建的 .lock)。 */
function tempIndexLeftovers(): string[] {
  try {
    return readdirSync(tmpdir()).filter((n) => n.startsWith(TMP_INDEX_PREFIX));
  } catch {
    return [];
  }
}

afterAll(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true });
});

describe("R7 快照不得动用户的真实暂存区", () => {
  it("验收#1 打快照前后真实 index 的三份指纹逐字不变(四类文件齐备)", async () => {
    const dir = makeRepo("coagenthub-cpiso-core-");
    const before = indexState(dir);
    // 前置条件:四类状态真的造出来了,否则这条用例没在测东西。
    expect(before.status).toContain("M  staged.txt");
    expect(before.status).toContain(" M unstaged.txt");
    expect(before.status).toContain("MM partial.txt");
    expect(before.status).toContain("?? untracked.txt");

    const cp = await createCheckpoint("task-core", dir);
    expect(cp.ref).toBe("refs/coagenthub-cp/task-core");

    const after = indexState(dir);
    expect(after).toEqual(before);
  }, 30_000);

  it("验收#2 新旧实现产出同一 tree sha,且快照含未跟踪/未暂存改动、不含被忽略文件", async () => {
    const dir = makeRepo("coagenthub-cpiso-tree-");
    const cp = await createCheckpoint("task-tree", dir);
    const treeNew = git(["rev-parse", `${cp.ref}^{tree}`], dir).trim();

    // 旧配方(真实 index):add -A → write-tree,与上面的 tree sha 必须相同。
    const add = await gitExec(["add", "-A"], dir);
    expect(add.status).toBe(0);
    const tree = await gitExec(["write-tree"], dir);
    expect(tree.status).toBe(0);
    expect(tree.stdout.trim()).toBe(treeNew);

    const listing = git(["ls-tree", "-r", "--name-only", cp.ref], dir);
    expect(listing).toContain("untracked.txt");
    expect(listing).toContain("unstaged.txt");
    expect(listing).toContain("partial.txt");
    expect(listing).not.toContain("ignored.txt");
    // 部分暂存的文件按**工作区**版本入快照(与旧实现一致)
    expect(git(["show", `${cp.ref}:partial.txt`], dir)).toContain(
      "line6-worktree",
    );
  }, 30_000);

  it("验收#4 同一仓库并发打快照:两个 ref 都成立、真实 index 不变、无 index.lock 报错", async () => {
    const dir = makeRepo("coagenthub-cpiso-conc-");
    const before = indexState(dir);
    const [a, b] = await Promise.all([
      createCheckpoint("task-conc-a", dir),
      createCheckpoint("task-conc-b", dir),
    ]);
    // 任一方抛错(index.lock 争用等)都会让 Promise.all 直接 reject。
    expect(git(["rev-parse", "--verify", a.ref], dir).trim()).toBe(a.sha);
    expect(git(["rev-parse", "--verify", b.ref], dir).trim()).toBe(b.sha);
    expect(a.ref).not.toBe(b.ref);
    expect(indexState(dir)).toEqual(before);
  }, 30_000);

  it("验收#5 任一步 git 失败:抛错且含子命令名、真实 index 不变、无临时文件与半成品 ref", async () => {
    const dir = makeRepo("coagenthub-cpiso-fail-");
    const before = indexState(dir);
    const leftoversBefore = tempIndexLeftovers();

    // 把系统临时目录指到一个不存在的路径 → 临时 index 不可写。
    const keys = ["TMPDIR", "TEMP", "TMP"] as const;
    const saved = new Map<string, string | undefined>();
    for (const k of keys) saved.set(k, process.env[k]);
    for (const k of keys) process.env[k] = path.join(dir, "no-such-tmp-dir");

    let caught: unknown;
    try {
      await createCheckpoint("task-fail", dir);
    } catch (e) {
      caught = e;
    } finally {
      for (const k of keys) {
        const v = saved.get(k);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    expect(caught).toBeInstanceOf(Error);
    const message = String((caught as Error).message);
    // 错误信息可读,且包含失败的 git 子命令。
    expect(message).toMatch(/git [a-z-]+/);
    expect(message).toMatch(/失败/);
    expect(indexState(dir)).toEqual(before);
    // 无临时 index 残留(含 git 可能留下的 .lock)
    const added = tempIndexLeftovers().filter(
      (n) => !leftoversBefore.includes(n),
    );
    expect(added).toEqual([]);
    // 无半成品 ref
    expect(
      git(["for-each-ref", "--format=%(refname)", "refs/coagenthub-cp/"], dir),
    ).toBe("");
  }, 30_000);
});
