import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTestApp } from "./app";

/**
 * 执行器配置管理 API(ticket: 网页 @executor 发布):
 *  - POST /api/executors 新增配置 + 自动注册 participant(名字唯一,重复 → 409;
 *    token 后端生成写 EXECUTOR_STATE_FILE 指向的文件,响应绝不含 token);
 *  - GET /api/executors 返回内置 + DB 全部(不含 token);
 *  - DELETE /api/executors/:key 删除 DB 配置(内置 key → 409);
 *  - 定向消息调度新增执行器:建 task + spawn(与内置执行器同链路)。
 *
 * 状态文件用 EXECUTOR_STATE_FILE 指向临时目录,避免污染仓库内
 * scripts/.executor-participants.json。ENV 在 import 前设置(executors.ts 的
 * env 覆盖在调用时求值,顶层设置即可)。
 */

const stateDir = mkdtempSync(path.join(tmpdir(), "coagenthub-exec-state-"));
const stateFile = path.join(stateDir, "executor-participants.json");
process.env.EXECUTOR_STATE_FILE = stateFile;

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-exec-bin-"));
const fakeBin = path.join(fakeDir, "fake-clitest.sh");
writeFileSync(
  fakeBin,
  [
    "#!/bin/sh",
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:建文件完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeBin, 0o755);
// 新增执行器 key=clitest,bin 用 env 覆盖指向 fake 脚本(spawn 才能完成)。
process.env.EXECUTOR_BIN_CLITEST = fakeBin;

import { testDb } from "./db";

const app = createTestApp();

async function createExecutor(body: Record<string, unknown>) {
  const res = await app.request("/api/executors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

describe("执行器配置管理 API(ticket: 接入 Participant)", () => {
  afterAll(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(fakeDir, { recursive: true, force: true });
  });

  it("POST /api/executors 创建配置并注册 participant,响应不含 token", async () => {
    const res = await createExecutor({
      agentName: "CLI Tester",
      type: "custom",
      kind: "cli",
      bin: fakeBin,
      args: ["-y", "-p", "{ticket}"],
      label: "cli-tester",
      device: "mac-mini",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.key).toBe("cli-tester"); // agentName 的 slug
    expect(body.agentName).toBe("CLI Tester");
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(body)).not.toContain("tokenHash");

    // participant 已注册进 participant 表(token 明文只落 state 文件)。
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<
      string,
      string
    >;
    expect(state["CLI Tester"]).toMatch(/^[0-9a-f]{64}$/);
    const [participant] = await testDb.query.participant.findMany({
      where: (t, { eq }) => eq(t.name, "CLI Tester"),
    });
    expect(participant).toBeDefined();
    expect(participant.device).toBe("mac-mini");
  });

  it("POST 重复 agentName → 409(内置与 DB 同名都算重复)", async () => {
    // 与内置执行器重名
    const dup = await createExecutor({
      agentName: "AtomCode 执行器",
      type: "custom",
      kind: "cli",
      bin: fakeBin,
    });
    expect(dup.status).toBe(409);

    // 与刚新增的 DB 配置重名
    const dup2 = await createExecutor({
      agentName: "CLI Tester",
      type: "custom",
      kind: "cli",
      bin: fakeBin,
    });
    expect(dup2.status).toBe(409);
  });

  it("GET /api/executors 返回内置 + 新增,不含 token", async () => {
    const res = await app.request("/api/executors");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(6); // 5 内置 + 1 新增

    const builtin = list.find((x) => x.key === "executor");
    expect(builtin).toBeTruthy();
    expect(builtin!.builtin).toBe(true);

    const added = list.find((x) => x.key === "cli-tester");
    expect(added).toBeTruthy();
    expect(added!.builtin).toBe(false);
    expect(added!.kind).toBe("cli");
    expect(added!.args).toEqual(["-y", "-p", "{ticket}"]);

    // 任何条目都不带 token/tokenHash 字段。
    for (const item of list) {
      expect(item).not.toHaveProperty("token");
      expect(item).not.toHaveProperty("tokenHash");
    }
    expect(JSON.stringify(list)).not.toContain("token_hash");
  });

  it("DELETE /api/executors/:key 删除 DB 配置;内置 key → 409", async () => {
    const del = await app.request("/api/executors/cli-tester", {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    const after = await app.request("/api/executors");
    const list = (await after.json()) as Array<{ key: string }>;
    expect(list.some((x) => x.key === "cli-tester")).toBe(false);

    const delBuiltin = await app.request("/api/executors/executor", {
      method: "DELETE",
    });
    expect(delBuiltin.status).toBe(409);
  });

  it("DELETE 不存在的 key → 404", async () => {
    const res = await app.request("/api/executors/no-such-key", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("定向消息命中新增执行器 → 自动建 task(executor_key=新 key)+ spawn 完成", async () => {
    // 通过 API 新增一个 cli 执行器,key 由 agentName slug 生成。
    const res = await createExecutor({
      agentName: "clitest",
      type: "custom",
      kind: "cli",
      bin: fakeBin,
      args: [],
    });
    expect(res.status).toBe(200);

    // 注册 coordinator + 取新增执行器 participant 的 id。
    const reg = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "coord-exec-api", type: "hermes" }),
    });
    const { id: coordinatorId, token } = (await reg.json()) as {
      id: string;
      token: string;
    };

    const participantsRes = await app.request("/api/participants");
    const participants = (await participantsRes.json()) as Array<{
      id: string;
      name: string;
    }>;
    const target = participants.find((a) => a.name === "clitest");
    expect(target).toBeTruthy();

    const groupRes = await app.request("/api/groups", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title: "新增执行器调度测试" }),
    });
    const group = (await groupRes.json()) as { id: string };

    const memberRes = await app.request(`/api/groups/${group.id}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ participantId: target!.id, roles: ["executor"] }),
    });
    expect(memberRes.status).toBe(200);

    const msgRes = await app.request(`/api/groups/${group.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        body: "建一个文件 hello.txt",
        audience: "participant",
        audienceRef: target!.id,
      }),
    });
    expect(msgRes.status).toBe(200);
    const msg = (await msgRes.json()) as { id: string };

    // 轮询 task 直到终态(与 executor-trigger 同模式)。
    const deadline = Date.now() + 10_000;
    let task:
      | {
          messageId: string;
          status: string;
          executorParticipantId: string;
          executorKey: string | null;
          diffSummary: unknown;
        }
      | undefined;
    for (;;) {
      const tasksRes = await app.request(`/api/groups/${group.id}/tasks`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const tasks = (await tasksRes.json()) as (typeof task)[];
      task = tasks.find((t) => t?.messageId === msg.id);
      if (task && ["done", "failed", "cancelled"].includes(task.status)) break;
      if (Date.now() > deadline) throw new Error("task 未在 10s 内达到终态");
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(task!.executorParticipantId).toBe(target!.id);
    expect(task!.executorKey).toBe("clitest");
    expect(task!.status).toBe("done");
    const diff = task!.diffSummary as Record<string, unknown> | null;
    expect(diff!.hash).toBe("0123456789ab");
    expect(coordinatorId).toBeTruthy();
  });
});
