import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * 修复:任务书显式声明目标仓库(`仓库:`/`仓库路径:`/`Repository:`/`Repo:`)时,
 * spawn cwd / 执行前快照 / 弱验收统一落到该仓库,而非仅用群绑定 projectPath。
 *
 * 纯函数 resolveTaskRepo 单测 + 集成测试(fake bin 把任务书拷出供断言,在 cwd
 * 真实提交一次以通过弱验收;COAGENTHUB_REPO_ROOT 覆盖 findRepoRoot 兜底)。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-repo-bin-"));
const fakeBin = path.join(fakeDir, "fake-codebuddy.sh");
writeFileSync(
  fakeBin,
  [
    "#!/bin/sh",
    // 捕获任务书全文供断言($3 = {ticket} 路径)。
    'if [ -n "$FAKE_TICKET_COPY" ]; then cp "$3" "$FAKE_TICKET_COPY"; fi',
    // 弱验收要求工作树干净 + HEAD 有新提交:在 cwd(=解析出的仓库)真正提交一次。
    'git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin change"',
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:修改完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeBin, 0o755);
process.env.EXECUTOR_BIN_CODEBUDDY = fakeBin;

/** 造一个真实 git 仓库(至少 seedCommits 个提交,供弱验收 checkpointRef^ 解析)。 */
function makeRepo(seedCommits: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "coagenthub-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@coagenthub.local"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "coagenthub-test"], { cwd: dir });
  for (let i = 0; i < Math.max(1, seedCommits); i++) {
    writeFileSync(path.join(dir, `f${i}.txt`), `v${i}\n`);
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", `seed${i}`], { cwd: dir });
  }
  return dir;
}

// 兜底仓库(findRepoRoot 指向);声明仓库是独立仓库,用于验证「声明优先」。
const baseRepo = makeRepo(1);
process.env.COAGENTHUB_REPO_ROOT = baseRepo;
const declaredRepo = makeRepo(2); // 2 个提交 → checkpointRef^ 可解析,弱验收走完整 HEAD 比对。

// 顶层 await 动态 import:env 设置先于模块求值。
const { createTestApp } = await import("./app");
const { __resetExecutorQueueForTests, resolveTaskRepo } = await import(
  "@server/lib/executor-task"
);

describe("resolveTaskRepo 纯函数(行级声明解析)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rtr-dir-"));
  const file = path.join(dir, "notdir.txt");
  writeFileSync(file, "x");
  const dir2 = mkdtempSync(path.join(tmpdir(), "rtr-dir2-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  });

  it("命中 `仓库:` → 返回绝对目录", () => {
    expect(resolveTaskRepo(`修复 bug\n\n仓库: ${dir}`, null)).toBe(dir);
  });
  it("命中 `仓库路径:` → 返回绝对目录", () => {
    expect(resolveTaskRepo(`仓库路径: ${dir}`, null)).toBe(dir);
  });
  it("命中 `Repository:` / `Repo:`(大小写不敏感)", () => {
    expect(resolveTaskRepo(`Repository: ${dir}`, null)).toBe(dir);
    expect(resolveTaskRepo(`repo: ${dir}`, null)).toBe(dir);
    expect(resolveTaskRepo(`REPO: ${dir}`, null)).toBe(dir);
  });
  it("取行内第一个路径 token(忽略后续文本)", () => {
    expect(resolveTaskRepo(`仓库: ${dir} 一些多余文字 /other`, null)).toBe(dir);
  });
  it("声明相对路径 → 回退 groupProjectPath", () => {
    expect(resolveTaskRepo(`仓库: ./local/path`, dir)).toBe(dir);
  });
  it("声明不存在的绝对路径 → 回退 groupProjectPath", () => {
    expect(resolveTaskRepo(`仓库: /no/such/path/here`, dir)).toBe(dir);
  });
  it("声明指向文件(非目录) → 回退 groupProjectPath", () => {
    expect(resolveTaskRepo(`仓库: ${file}`, dir)).toBe(dir);
  });
  it("无声明 → 回退 groupProjectPath(可为 null)", () => {
    expect(resolveTaskRepo("普通任务书,无仓库声明", dir)).toBe(dir);
    expect(resolveTaskRepo("普通任务书,无仓库声明", null)).toBeNull();
  });
  it("关键字非行首(前有其他字) → 不命中,回退", () => {
    expect(resolveTaskRepo(`我的仓库: ${dir}`, null)).toBeNull();
  });
  it("多个声明 → 取第一个命中", () => {
    expect(resolveTaskRepo(`仓库: ${dir}\n仓库路径: ${dir2}`, null)).toBe(dir);
  });
});

describe("任务书声明仓库 → spawn cwd/快照/弱验收落到声明仓库(集成)", () => {
  const app = createTestApp();

  beforeEach(() => {
    __resetExecutorQueueForTests();
  });

  async function registerParticipant(body: Record<string, unknown>) {
    const res = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      const list = (await (await app.request("/api/participants")).json()) as {
        id: string;
        name: string;
      }[];
      const existing = list.find((p) => p.name === body.name);
      if (existing) return { id: existing.id, name: existing.name };
    }
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; name: string };
  }

  async function createGroup(participantId: string, title: string) {
    const res = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  async function addMember(
    participantId: string,
    groupId: string,
    memberParticipantId: string,
    roles: string[],
  ) {
    const res = await app.request(`/api/groups/${groupId}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify({ participantId: memberParticipantId, roles }),
    });
    expect(res.status).toBe(200);
  }

  async function postMessage(
    participantId: string,
    groupId: string,
    body: Record<string, unknown>,
  ) {
    const res = await app.request(`/api/groups/${groupId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": participantId,
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string };
  }

  async function listTasks(participantId: string, groupId: string) {
    const res = await app.request(`/api/groups/${groupId}/tasks`, {
      headers: { "X-Participant-Id": participantId },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Array<{
      id: string;
      messageId: string;
      status: string;
    }>;
  }

  async function waitForTaskStatus(
    participantId: string,
    groupId: string,
    messageId: string,
    status: string,
    timeoutMs = 15_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tasks = await listTasks(participantId, groupId);
      const t = tasks.find((x) => x.messageId === messageId);
      if (t && t.status === status) return t;
      if (Date.now() > deadline) {
        throw new Error(
          `task(message=${messageId}) 未在 ${timeoutMs}ms 内达到 ${status}`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function setupGroup() {
    const coordinator = await registerParticipant({ name: "coord-repo" });
    const codebuddy = await registerParticipant({ name: "CodeBuddy 执行器" });
    const group = await createGroup(coordinator.id, "仓库解析测试");
    await addMember(coordinator.id, group.id, codebuddy.id, ["executor"]);
    return { coordinator, codebuddy, group };
  }

  it("任务书声明其他仓库 → 「项目:」显示该仓库且弱验收在该仓库通过(done)", async () => {
    const capture = path.join(fakeDir, "ticket-declared.md");
    process.env.FAKE_TICKET_COPY = capture;
    try {
      const { coordinator, codebuddy, group } = await setupGroup();
      const msg = await postMessage(coordinator.id, group.id, {
        body: `修复 dsh 仓库的 bug\n\n仓库: ${declaredRepo}`,
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const task = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "done",
      );
      expect(task.status).toBe("done");
      const ticket = readFileSync(capture, "utf8");
      // 「项目:」必须是任务书声明的仓库,而非群绑定/兜底仓库。
      expect(ticket).toContain(`项目: ${declaredRepo}`);
      expect(ticket).not.toContain(`项目: ${baseRepo}`);
    } finally {
      delete process.env.FAKE_TICKET_COPY;
    }
  }, 30_000);

  it("任务书未声明 → 回退群 projectPath(绑定明确仓库时命中它)", async () => {
    const capture = path.join(fakeDir, "ticket-fallback.md");
    process.env.FAKE_TICKET_COPY = capture;
    const altRepo = makeRepo(1);
    try {
      const { coordinator, codebuddy, group } = await setupGroup();
      // 绑定群 projectPath 到一个明确仓库,验证未声明时回退命中它(而非兜底)。
      const patchRes = await app.request(`/api/groups/${group.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath: altRepo }),
      });
      expect(patchRes.status).toBe(200);
      const msg = await postMessage(coordinator.id, group.id, {
        body: "普通任务,无仓库声明",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const task = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "done",
      );
      expect(task.status).toBe("done");
      const ticket = readFileSync(capture, "utf8");
      expect(ticket).toContain(`项目: ${altRepo}`);
      expect(ticket).not.toContain(`项目: ${baseRepo}`);
    } finally {
      delete process.env.FAKE_TICKET_COPY;
      rmSync(altRepo, { recursive: true, force: true });
    }
  }, 30_000);

  it("任务书精简:含「执行方式」段,不含「执行流程(必读)」/「Code Review 自检」", async () => {
    const capture = path.join(fakeDir, "ticket-slim.md");
    process.env.FAKE_TICKET_COPY = capture;
    try {
      const { coordinator, codebuddy, group } = await setupGroup();
      const msg = await postMessage(coordinator.id, group.id, {
        body: "修复 bug",
        audience: "participant",
        audienceRef: codebuddy.id,
      });
      const task = await waitForTaskStatus(
        coordinator.id,
        group.id,
        msg.id,
        "done",
      );
      expect(task.status).toBe("done");
      const ticket = readFileSync(capture, "utf8");
      // Skill 触发替代完整流程:必须含「执行方式」且引用 coagenthub-executor skill。
      expect(ticket).toContain("## 执行方式");
      expect(ticket).toContain("coagenthub-executor");
      // 过度固化的流程/自检段已回退,不得再出现。
      expect(ticket).not.toContain("## 执行流程（必读）");
      expect(ticket).not.toContain("## Code Review 自检（完成前必做）");
      // 保留:汇报格式 / 默认约束 段仍存在。
      expect(ticket).toContain("## 汇报格式要求");
    } finally {
      delete process.env.FAKE_TICKET_COPY;
    }
  }, 30_000);
});

afterAll(() => {
  rmSync(fakeDir, { recursive: true, force: true });
  rmSync(baseRepo, { recursive: true, force: true });
  rmSync(declaredRepo, { recursive: true, force: true });
});
