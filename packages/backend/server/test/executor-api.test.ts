import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./app";

/**
 * 执行器配置管理 API(ticket: 网页 @executor 发布):
 *  - POST /api/executors 新增配置 + 自动注册 participant(名字唯一,重复 → 409;
 *    token 认证已移除,响应绝不含 token);
 *  - GET /api/executors 返回 DB 全部(0028 seed 携带旧内置 6 条,不含 token);
 *  - DELETE /api/executors/:key 删除 DB 配置(无内置禁令,全部可删);
 *  - PATCH /api/executors/:key 编辑配置(无内置禁令,全部可改);
 *  - 定向消息调度新增执行器:建 task + spawn(与 DB 配置同链路)。
 *
 * fixture:显式插入 6 条旧内置配置(幂等,ON CONFLICT DO NOTHING)——测试不依赖
 * 「系统自带某个 key」(spec R5)。
 */

const fakeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-exec-bin-"));
const fakeBin = path.join(fakeDir, "fake-clitest.sh");
writeFileSync(
  fakeBin,
  [
    "#!/bin/sh",
    // 弱验收要求工作树干净 + HEAD 有新提交:真正提交一次(显式身份,CI 无全局
    // git config 也能跑)。
    'git add -A && git -c user.name=coagenthub-test -c user.email=coagenthub-test@example.com commit -q --allow-empty -m "fake bin change"',
    'echo "commit 0123456789abcdef0123456789abcdef01234567"',
    'echo "汇报:建文件完成"',
    "exit 0",
  ].join("\n"),
);
chmodSync(fakeBin, 0o755);
// 新增执行器 key=clitest,bin 用 env 覆盖指向 fake 脚本(spawn 才能完成)。
process.env.EXECUTOR_BIN_CLITEST = fakeBin;

import type { DataBase } from "../src/lib/database";
import { seedBuiltinExecutorConfigs, testDb } from "./db";

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
  beforeAll(async () => {
    // 显式 fixture:6 条旧内置配置(与 0028 seed 同值,幂等)。
    await seedBuiltinExecutorConfigs();
  });

  afterAll(() => {
    rmSync(fakeDir, { recursive: true, force: true });
  });

  it("POST /api/executors 创建配置并注册 participant,响应不含 token", async () => {
    const res = await createExecutor({
      agentName: "CLI Tester",
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

    // participant 已注册进 participant 表(token 认证已移除,无 state 文件)。
    const [participant] = await testDb.query.participant.findMany({
      where: (t, { eq }) => eq(t.name, "CLI Tester"),
    });
    expect(participant).toBeDefined();
    expect(participant.device).toBe("mac-mini");
  });

  it("POST 重复 agentName → 409(与 seed/DB 同名都算重复)", async () => {
    // 与 seed 行(executor 的 agentName)重名
    const dup = await createExecutor({
      agentName: "AtomCode",
      kind: "cli",
      bin: fakeBin,
    });
    expect(dup.status).toBe(409);

    // 与刚新增的 DB 配置重名
    const dup2 = await createExecutor({
      agentName: "CLI Tester",
      kind: "cli",
      bin: fakeBin,
    });
    expect(dup2.status).toBe(409);
  });

  it("GET /api/executors 返回 seed 6 条 + 新增,无 builtin 字段,不含 token", async () => {
    const res = await app.request("/api/executors");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(list)).toBe(true);
    // 0028 seed 6 条(executor/reasonix/codebuddy/codex/hermes/win-hermes)+ 新增。
    expect(list.length).toBeGreaterThanOrEqual(7);

    // 无 builtin 字段:内置禁令已移除,所有配置都是普通 DB 行。
    for (const item of list) {
      expect(item).not.toHaveProperty("builtin");
    }

    const executor = list.find((x) => x.key === "executor");
    expect(executor).toBeTruthy();
    expect(executor!.agentName).toBe("AtomCode");
    // 声明式并发上限:executor 串行。
    expect(executor!.maxConcurrency).toBe(1);

    // win-hermes 默认 memory="per-group"(协调器按群记忆);其他执行器无记忆。
    const winHermes = list.find((x) => x.key === "win-hermes");
    expect(winHermes?.memory).toBe("per-group");
    expect(executor!.memory).toBe(null);
    expect(executor).not.toHaveProperty("token");

    const codex = list.find((x) => x.key === "codex");
    expect(codex).toMatchObject({
      agentName: "Codex",
      kind: "cli",
      bin: "codex",
      maxConcurrency: 1,
      // --approve-for-me 自带 workspace-write 沙箱,不能再叠 --sandbox;
      // 旧写法的 --ask-for-approval 在 codex-cli 0.149.0 已不存在。
      // network_access=true:该沙箱默认禁网(连 localhost 也不通),而协调者
      // 必须能 PATCH 回平台才能把 L3 交回检视者,否则三层链路在最后一步断掉。
      args: [
        "exec",
        "--approve-for-me",
        "--ephemeral",
        "--json",
        "-c",
        "sandbox_workspace_write.network_access=true",
        "{ticket}",
      ],
    });

    // 不再有 reviewer 执行器(R3 移除,0028 不 seed)。
    expect(list.some((x) => x.key === "reviewer")).toBe(false);

    const added = list.find((x) => x.key === "cli-tester");
    expect(added).toBeTruthy();
    expect(added!.kind).toBe("cli");
    expect(added!.args).toEqual(["-y", "-p", "{ticket}"]);

    // 任何条目都不带 token/tokenHash 字段。
    for (const item of list) {
      expect(item).not.toHaveProperty("token");
      expect(item).not.toHaveProperty("tokenHash");
    }
    expect(JSON.stringify(list)).not.toContain("token_hash");
  });

  it("执行器 agentName 均不含角色词(执行器/Executor/检视器/规划)", async () => {
    const res = await app.request("/api/executors");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ agentName: string }>;
    expect(list.length).toBeGreaterThanOrEqual(6);
    for (const ex of list) {
      expect(ex.agentName).not.toMatch(/执行器|Executor|检视器|规划/);
    }
  });

  it("effectiveExecutors 返回 seed 的 6 条(无 reviewer;executor/codex maxConcurrency=1)", async () => {
    // 直接走 effectiveExecutors 验证 0028 seed 落库后有效执行器集合包含 6 条
    // DB 行,reviewer 不在其中(spec R3:reviewer 不对应执行器配置)。
    const { effectiveExecutors } = await import("../src/lib/executors");
    const all = await effectiveExecutors(testDb as unknown as DataBase);
    const keys = all.map((x) => x.key);
    for (const key of [
      "codebuddy",
      "codex",
      "executor",
      "hermes",
      "reasonix",
      "win-hermes",
    ]) {
      expect(keys).toContain(key);
    }
    const executor = all.find((x) => x.key === "executor");
    const codex = all.find((x) => x.key === "codex");
    expect(executor!.maxConcurrency).toBe(1);
    expect(codex!.maxConcurrency).toBe(1);
    expect(all.some((x) => x.key === "reviewer")).toBe(false);
  });

  it("DELETE /api/executors/:key 删除 DB 配置(含 seed 行,不再有 409 禁令)", async () => {
    const del = await app.request("/api/executors/cli-tester", {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    const after = await app.request("/api/executors");
    const list = (await after.json()) as Array<{ key: string }>;
    expect(list.some((x) => x.key === "cli-tester")).toBe(false);

    // 内置禁令已移除:seed 行 reasonix 可删除,且真的删除(验收 #4)。
    const delSeed = await app.request("/api/executors/reasonix", {
      method: "DELETE",
    });
    expect(delSeed.status).toBe(200);
    const afterSeed = await app.request("/api/executors");
    const listSeed = (await afterSeed.json()) as Array<{ key: string }>;
    expect(listSeed.some((x) => x.key === "reasonix")).toBe(false);
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
      kind: "cli",
      bin: fakeBin,
      args: [],
    });
    expect(res.status).toBe(200);

    // 注册 coordinator + 取新增执行器 participant 的 id。
    const reg = await app.request("/api/participants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "coord-exec-api" }),
    });
    const { id: coordinatorId } = (await reg.json()) as { id: string };

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
        "X-Participant-Id": coordinatorId,
      },
      body: JSON.stringify({ title: "新增执行器调度测试" }),
    });
    const group = (await groupRes.json()) as { id: string };

    const memberRes = await app.request(`/api/groups/${group.id}/members`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinatorId,
      },
      body: JSON.stringify({ participantId: target!.id, roles: ["executor"] }),
    });
    expect(memberRes.status).toBe(200);

    const msgRes = await app.request(`/api/groups/${group.id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Participant-Id": coordinatorId,
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
        headers: { "X-Participant-Id": coordinatorId },
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

  // ── PATCH /api/executors/:key(编辑配置, 执行器管理增强)──────────────────
  it("POST 携带 model 持久化,GET 返回 model", async () => {
    const res = await createExecutor({
      agentName: "Model Executor",
      kind: "cli",
      bin: fakeBin,
      args: ["run", "-y", "--model", "{model}", "{ticket}"],
      model: "deepseek-v4-flash",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.model).toBe("deepseek-v4-flash");

    const listRes = await app.request("/api/executors");
    const list = (await listRes.json()) as Array<Record<string, unknown>>;
    const item = list.find((x) => x.key === "model-executor");
    expect(item!.model).toBe("deepseek-v4-flash");
  });

  it("POST 携带 memory=per-group 持久化,GET 返回 memory", async () => {
    const res = await createExecutor({
      agentName: "Memory Executor",
      kind: "a2a",
      url: "http://gw.test/",
      bin: "memory-executor",
      args: [],
      memory: "per-group",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.memory).toBe("per-group");

    const listRes = await app.request("/api/executors");
    const list = (await listRes.json()) as Array<Record<string, unknown>>;
    const item = list.find((x) => x.key === "memory-executor");
    expect(item!.memory).toBe("per-group");
  });

  it("POST kind=cli 携带 memory → 400(memory 仅对 a2a 生效)", async () => {
    const res = await createExecutor({
      agentName: "Cli Memory Executor",
      kind: "cli",
      bin: fakeBin,
      args: [],
      memory: "per-group",
    });
    expect(res.status).toBe(400);
  });

  it("POST 不带 memory → 响应与 GET 均为 null(默认无记忆)", async () => {
    const res = await createExecutor({
      agentName: "No Memory Executor",
      kind: "cli",
      bin: fakeBin,
      args: [],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.memory).toBe(null);

    const listRes = await app.request("/api/executors");
    const list = (await listRes.json()) as Array<Record<string, unknown>>;
    const item = list.find((x) => x.key === "no-memory-executor");
    expect(item!.memory).toBe(null);
  });

  it("PATCH /api/executors/:key 部分更新 bin/args/model/device 生效(GET 验证)", async () => {
    const created = await createExecutor({
      agentName: "Patch Target",
      kind: "cli",
      bin: fakeBin,
      args: ["-y", "{ticket}"],
      device: "mac-mini",
    });
    expect(created.status).toBe(200);

    const patchRes = await app.request("/api/executors/patch-target", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bin: fakeBin,
        args: ["run", "-y", "--model", "{model}", "{ticket}"],
        model: "deepseek-v4-flash",
        device: "mac-pro",
      }),
    });
    expect(patchRes.status).toBe(200);
    const updated = (await patchRes.json()) as Record<string, unknown>;
    expect(updated.key).toBe("patch-target"); // key 不变
    expect(updated.model).toBe("deepseek-v4-flash");

    // GET 验证改动已生效
    const listRes = await app.request("/api/executors");
    const list = (await listRes.json()) as Array<Record<string, unknown>>;
    const item = list.find((x) => x.key === "patch-target");
    expect(item!.bin).toBe(fakeBin);
    expect(item!.args).toEqual(["run", "-y", "--model", "{model}", "{ticket}"]);
    expect(item!.model).toBe("deepseek-v4-flash");

    // device 变更同步到已注册 participant(按 agentName 匹配)
    const participantsRes = await app.request("/api/participants");
    const participants = (await participantsRes.json()) as Array<{
      name: string;
      device: string | null;
    }>;
    const participant = participants.find((p) => p.name === "Patch Target");
    expect(participant!.device).toBe("mac-pro");
  });

  it("PATCH seed 行(executor)同时改 args+model → 200 且缓存失效后生效(验收 #3)", async () => {
    // 内置禁令已移除:seed 行 executor 现在可编辑,不再 403。
    const res = await app.request("/api/executors/executor", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        args: ["-y", "-v", "-p", "{ticket}", "--model", "{model}"],
        model: "gpt-4o",
      }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, unknown>;
    expect(updated.model).toBe("gpt-4o");
    expect(updated.args).toEqual([
      "-y",
      "-v",
      "-p",
      "{ticket}",
      "--model",
      "{model}",
    ]);

    // 缓存失效后 effectiveExecutors 读到新值(同时验证 args 与 model)。
    const { effectiveExecutors } = await import("../src/lib/executors");
    const all = await effectiveExecutors(testDb as unknown as DataBase);
    const executor = all.find((x) => x.key === "executor");
    expect(executor!.model).toBe("gpt-4o");
    expect(executor!.args).toEqual([
      "-y",
      "-v",
      "-p",
      "{ticket}",
      "--model",
      "{model}",
    ]);
    // 恢复原值,避免影响同文件其他用例。
    await app.request("/api/executors/executor", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        args: ["-y", "-v", "-p", "{ticket}"],
        model: null,
      }),
    });
  });

  it("PATCH 未知 key → 404", async () => {
    const res = await app.request("/api/executors/no-such-executor", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bin: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH 请求体带 key 字段 → 400(key 不可改)", async () => {
    const res = await app.request("/api/executors/patch-target", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "other-key", bin: fakeBin }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH 部分更新:只改 model,bin/args 保持原值", async () => {
    const res = await app.request("/api/executors/patch-target", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o" }),
    });
    expect(res.status).toBe(200);

    const listRes = await app.request("/api/executors");
    const list = (await listRes.json()) as Array<Record<string, unknown>>;
    const item = list.find((x) => x.key === "patch-target");
    expect(item!.model).toBe("gpt-4o");
    expect(item!.bin).toBe(fakeBin);
    expect(item!.args).toEqual(["run", "-y", "--model", "{model}", "{ticket}"]);
  });

  it("PATCH 改名为已存在名字 → 409", async () => {
    const res = await app.request("/api/executors/patch-target", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentName: "Model Executor" }),
    });
    expect(res.status).toBe(409);
  });

  it("PATCH memory 设置/清空生效(GET 验证;仅 a2a 执行器)", async () => {
    // memory 仅对 a2a 生效:先建一个 a2a 执行器再 PATCH。
    const created = await createExecutor({
      agentName: "Patch A2A",
      kind: "a2a",
      url: "http://gw.test/",
      bin: "patch-a2a",
      args: [],
    });
    expect(created.status).toBe(200);

    // 先设 memory=per-group
    const setRes = await app.request("/api/executors/patch-a2a", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory: "per-group" }),
    });
    expect(setRes.status).toBe(200);
    const setBody = (await setRes.json()) as Record<string, unknown>;
    expect(setBody.memory).toBe("per-group");

    let listRes = await app.request("/api/executors");
    let list = (await listRes.json()) as Array<Record<string, unknown>>;
    expect(list.find((x) => x.key === "patch-a2a")!.memory).toBe("per-group");

    // 再清空(null = 无记忆)
    const clearRes = await app.request("/api/executors/patch-a2a", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory: null }),
    });
    expect(clearRes.status).toBe(200);
    const clearBody = (await clearRes.json()) as Record<string, unknown>;
    expect(clearBody.memory).toBe(null);

    listRes = await app.request("/api/executors");
    list = (await listRes.json()) as Array<Record<string, unknown>>;
    expect(list.find((x) => x.key === "patch-a2a")!.memory).toBe(null);
  });

  it("PATCH kind=cli 执行器设 memory → 400(memory 仅对 a2a 生效)", async () => {
    const res = await app.request("/api/executors/patch-target", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory: "per-group" }),
    });
    expect(res.status).toBe(400);
  });

  // ── prompt(默认分工说明)读写(本票范围)──────────────────
  it("POST 携带 prompt 持久化,GET 返回 prompt", async () => {
    const res = await createExecutor({
      agentName: "Prompt Executor",
      kind: "cli",
      bin: fakeBin,
      args: ["-y", "-p", "{ticket}"],
      prompt: "只负责数据库迁移与 schema 评审",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.prompt).toBe("只负责数据库迁移与 schema 评审");

    const listRes = await app.request("/api/executors");
    const list = (await listRes.json()) as Array<Record<string, unknown>>;
    const item = list.find((x) => x.key === "prompt-executor");
    expect(item!.prompt).toBe("只负责数据库迁移与 schema 评审");
  });

  it("POST 不带 prompt → 响应与 GET 均为 null", async () => {
    const res = await createExecutor({
      agentName: "No Prompt Executor",
      kind: "cli",
      bin: fakeBin,
      args: [],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.prompt).toBe(null);

    const listRes = await app.request("/api/executors");
    const list = (await listRes.json()) as Array<Record<string, unknown>>;
    const item = list.find((x) => x.key === "no-prompt-executor");
    expect(item!.prompt).toBe(null);
  });

  it("PATCH prompt 单独更新生效(GET 验证)", async () => {
    const created = await createExecutor({
      agentName: "Patch Prompt",
      kind: "cli",
      bin: fakeBin,
      args: ["-y", "{ticket}"],
    });
    expect(created.status).toBe(200);

    const patchRes = await app.request("/api/executors/patch-prompt", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "新分工说明" }),
    });
    expect(patchRes.status).toBe(200);
    const updated = (await patchRes.json()) as Record<string, unknown>;
    expect(updated.prompt).toBe("新分工说明");

    const listRes = await app.request("/api/executors");
    const list = (await listRes.json()) as Array<Record<string, unknown>>;
    expect(list.find((x) => x.key === "patch-prompt")!.prompt).toBe(
      "新分工说明",
    );
  });

  it("PATCH 空字符串清空 prompt(与 members.ts 语义一致)", async () => {
    // 先设一个 prompt
    const setRes = await app.request("/api/executors/patch-prompt", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "待清空" }),
    });
    expect(setRes.status).toBe(200);
    expect(((await setRes.json()) as Record<string, unknown>).prompt).toBe(
      "待清空",
    );

    // 再清空:空字符串表示清空(与 routes/group/members.ts 的 PATCH 处理一致)。
    const clearRes = await app.request("/api/executors/patch-prompt", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });
    expect(clearRes.status).toBe(200);
    const cleared = (await clearRes.json()) as Record<string, unknown>;
    expect(cleared.prompt).toBe("");

    const listRes = await app.request("/api/executors");
    const list = (await listRes.json()) as Array<Record<string, unknown>>;
    expect(list.find((x) => x.key === "patch-prompt")!.prompt).toBe("");
  });

  // ── R1:4 个新可选配置字段(executor-config-over-code 批1)────────────────
  it("POST 携带 maxConcurrency/inputMode/env/outputProfile 持久化,GET 返回", async () => {
    const res = await createExecutor({
      agentName: "R1 Executor",
      kind: "cli",
      bin: fakeBin,
      args: ["-y", "{ticket}"],
      maxConcurrency: 1,
      inputMode: "inline",
      env: { FOO: "bar", BAZ: "qux" },
      outputProfile: { parser: "generic" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.maxConcurrency).toBe(1);
    expect(body.inputMode).toBe("inline");
    expect(body.env).toEqual({ FOO: "bar", BAZ: "qux" });
    expect(body.outputProfile).toEqual({ parser: "generic" });

    const listRes = await app.request("/api/executors");
    const list = (await listRes.json()) as Array<Record<string, unknown>>;
    const item = list.find((x) => x.key === "r1-executor");
    expect(item!.maxConcurrency).toBe(1);
    expect(item!.inputMode).toBe("inline");
    expect(item!.env).toEqual({ FOO: "bar", BAZ: "qux" });
    expect(item!.outputProfile).toEqual({ parser: "generic" });
  });

  it("POST 不带 4 个新字段 → 响应与 GET 均为 null(既有行行为不变)", async () => {
    const res = await createExecutor({
      agentName: "R1 Legacy Executor",
      kind: "cli",
      bin: fakeBin,
      args: [],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.maxConcurrency).toBe(null);
    expect(body.inputMode).toBe(null);
    expect(body.env).toBe(null);
    expect(body.outputProfile).toBe(null);

    const listRes = await app.request("/api/executors");
    const list = (await listRes.json()) as Array<Record<string, unknown>>;
    const item = list.find((x) => x.key === "r1-legacy-executor");
    expect(item!.maxConcurrency).toBe(null);
    expect(item!.inputMode).toBe(null);
    expect(item!.env).toBe(null);
    expect(item!.outputProfile).toBe(null);
  });

  it("POST inputMode 非法取值 → 400(仅 path/inline/at-file/stdin)", async () => {
    const res = await createExecutor({
      agentName: "R1 Bad Mode",
      kind: "cli",
      bin: fakeBin,
      args: [],
      inputMode: "script",
    });
    expect(res.status).toBe(400);
  });

  it("POST maxConcurrency 非正整数 → 400", async () => {
    const res = await createExecutor({
      agentName: "R1 Bad MC",
      kind: "cli",
      bin: fakeBin,
      args: [],
      maxConcurrency: 0,
    });
    expect(res.status).toBe(400);
  });

  it("PATCH 更新/清空 4 个新字段生效(GET 验证)", async () => {
    const created = await createExecutor({
      agentName: "R1 Patch",
      kind: "cli",
      bin: fakeBin,
      args: ["-y", "{ticket}"],
    });
    expect(created.status).toBe(200);

    // 设置
    const setRes = await app.request("/api/executors/r1-patch", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        maxConcurrency: 2,
        inputMode: "at-file",
        env: { TOKEN_MODE: "inline" },
        outputProfile: { parser: "generic" },
      }),
    });
    expect(setRes.status).toBe(200);
    const setBody = (await setRes.json()) as Record<string, unknown>;
    expect(setBody.maxConcurrency).toBe(2);
    expect(setBody.inputMode).toBe("at-file");
    expect(setBody.env).toEqual({ TOKEN_MODE: "inline" });
    expect(setBody.outputProfile).toEqual({ parser: "generic" });

    // 清空(null 回缺省)
    const clearRes = await app.request("/api/executors/r1-patch", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        maxConcurrency: null,
        inputMode: null,
        env: null,
        outputProfile: null,
      }),
    });
    expect(clearRes.status).toBe(200);
    const clearBody = (await clearRes.json()) as Record<string, unknown>;
    expect(clearBody.maxConcurrency).toBe(null);
    expect(clearBody.inputMode).toBe(null);
    expect(clearBody.env).toBe(null);
    expect(clearBody.outputProfile).toBe(null);

    const listRes = await app.request("/api/executors");
    const list = (await listRes.json()) as Array<Record<string, unknown>>;
    const item = list.find((x) => x.key === "r1-patch");
    expect(item!.maxConcurrency).toBe(null);
    expect(item!.inputMode).toBe(null);
    expect(item!.env).toBe(null);
    expect(item!.outputProfile).toBe(null);
  });

  it("PATCH 只带 4 个新字段之一 → 放行(不在『至少一个字段』校验中缺失)", async () => {
    const res = await app.request("/api/executors/r1-patch", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputMode: "stdin" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // stdin 只保留取值,不实现执行分支(R1.1)。
    expect(body.inputMode).toBe("stdin");
  });

  // ── R1(specs/executor-availability-visibility-and-queued-child-pinning.md)──
  // GET 每条恒含 available/unavailableReason/cooldownEndMs 三字段;冷却/并发饱和
  // 判定与文案均由 executor-availability.ts 的 executorAvailability 权威导出
  // 产生(单一权威源),测试只与权威导出比对,不手写第二套文案。
  it("R1:非冷却执行器三字段恒出现,值 true/null/null(own 键,非缺失)", async () => {
    const res = await app.request("/api/executors");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThanOrEqual(6);
    for (const item of list) {
      // 「字段缺失(undefined)」与「值为 null」在 JSON 上不可区分,必须同时
      // 验证键存在(hasOwnProperty)且值为 null —— 正是 R1 要消灭的误读路径。
      expect(Object.hasOwn(item, "available")).toBe(true);
      expect(Object.hasOwn(item, "unavailableReason")).toBe(true);
      expect(Object.hasOwn(item, "cooldownEndMs")).toBe(true);
      expect(item.available).toBe(true);
      expect(item.unavailableReason).toBeNull();
      expect(item.cooldownEndMs).toBeNull();
    }
  });

  it("R1:冷却中执行器 available=false,unavailableReason 与权威导出逐字一致,cooldownEndMs 数值", async () => {
    const { executorCooldowns } = await import(
      "../src/lib/executor-task/state"
    );
    const { executorAvailability } = await import(
      "../src/lib/executor-availability"
    );
    const end = Date.now() + 60_000;
    // 直接登记冷却(与既有测试同款:executorCooldowns 即 isInCooldown 的读源)。
    executorCooldowns.set("executor", end);
    try {
      // 期望 reason 由权威导出产生(同一内存冷却表,路由与测试读到同一判定),
      // 不手写「额度冷却至 …」文案 —— 单一权威源,不得第二套。
      const expected = executorAvailability({ key: "executor" });
      const res = await app.request("/api/executors");
      expect(res.status).toBe(200);
      const list = (await res.json()) as Array<Record<string, unknown>>;
      const item = list.find((x) => x.key === "executor");
      expect(item).toBeTruthy();
      expect(item!.available).toBe(expected.available);
      expect(item!.unavailableReason).toBe(expected.unavailableReason);
      expect(item!.cooldownEndMs).toBe(expected.cooldownEndMs);
      expect(item!.cooldownEndMs).toBe(end);
      expect(typeof item!.cooldownEndMs).toBe("number");
      // 冷却只影响该执行器:其余执行器仍是 true/null/null(own 键)。
      for (const other of list) {
        if (other.key === "executor") continue;
        expect(other.available).toBe(true);
        expect(other.unavailableReason).toBeNull();
        expect(other.cooldownEndMs).toBeNull();
      }
    } finally {
      executorCooldowns.delete("executor");
    }
  });

  it("R1:maxConcurrency 饱和执行器 available=false(权威 reason,cooldownEndMs=null)", async () => {
    const { groupQueues } = await import("../src/lib/executor-task/state");
    const { executorAvailability } = await import(
      "../src/lib/executor-availability"
    );
    // 向内存组队列塞一个 running 占位:runningExecutorCount 只读 r.ex.key,
    // executor(seed 行)maxConcurrency=1,1 个 running 即饱和。占位对象仅带
    // 计数所需字段(测试假体,非真实 QueuedRun)。
    groupQueues.set("__r1-saturation__", {
      key: "__r1-saturation__",
      queue: [],
      running: [{ ex: { key: "executor" } }] as unknown as never[],
    });
    try {
      // 期望 reason 由权威导出产生(同一内存运行表,路由与测试读到同一判定),
      // 不手写「正在运行任务」文案 —— 单一权威源,不得第二套。
      const expected = executorAvailability({
        key: "executor",
        maxConcurrency: 1,
      });
      const res = await app.request("/api/executors");
      expect(res.status).toBe(200);
      const list = (await res.json()) as Array<Record<string, unknown>>;
      const item = list.find((x) => x.key === "executor");
      expect(item).toBeTruthy();
      expect(item!.available).toBe(expected.available);
      expect(item!.unavailableReason).toBe(expected.unavailableReason);
      expect(item!.cooldownEndMs).toBe(expected.cooldownEndMs);
      expect(item!.cooldownEndMs).toBeNull();
      // 未饱和执行器不受影响(own 键 true/null/null)。
      const codebuddy = list.find((x) => x.key === "codebuddy");
      expect(codebuddy!.available).toBe(true);
      expect(codebuddy!.unavailableReason).toBeNull();
      expect(codebuddy!.cooldownEndMs).toBeNull();
    } finally {
      groupQueues.delete("__r1-saturation__");
    }
  });
});

describe("GET /api/executors/check-bin(接入表单 bin 即时校验)", () => {
  // 独立 fixture:文件顶部的 fakeDir 已由上一个 describe 的 afterAll 清理,
  // 这里自建自清;同时把 probeDir 临时并入 PATH,确定性覆盖「命令名命中」。
  const probeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-checkbin-"));
  const probeCmd = path.join(probeDir, "probe-cmd");
  const originalPath = process.env.PATH;

  beforeAll(() => {
    writeFileSync(probeCmd, "#!/bin/sh\nexit 0\n");
    chmodSync(probeCmd, 0o755);
    // 存在但无执行位的普通文件:探测应报 found=false(锁定 isFile+X_OK 语义)。
    writeFileSync(path.join(probeDir, "probe-noexec"), "not executable\n");
    chmodSync(path.join(probeDir, "probe-noexec"), 0o644);
    process.env.PATH = `${probeDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
    rmSync(probeDir, { recursive: true, force: true });
  });

  it("PATH 里的命令名 → found=true 且 resolvedPath 为绝对路径", async () => {
    const res = await app.request("/api/executors/check-bin?bin=probe-cmd");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      found: boolean;
      resolvedPath: string | null;
    };
    expect(body.found).toBe(true);
    expect(body.resolvedPath).toBe(probeCmd);
  });

  it("不存在的命令名 → found=false, resolvedPath=null", async () => {
    const res = await app.request(
      "/api/executors/check-bin?bin=no-such-cmd-9f3a",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      found: boolean;
      resolvedPath: string | null;
    };
    expect(body.found).toBe(false);
    expect(body.resolvedPath).toBeNull();
  });

  it("存在的绝对路径 → found=true", async () => {
    const res = await app.request(
      `/api/executors/check-bin?bin=${encodeURIComponent(probeCmd)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      found: boolean;
      resolvedPath: string | null;
    };
    expect(body.found).toBe(true);
    expect(body.resolvedPath).toBe(probeCmd);
  });

  it("不存在的绝对路径 → found=false, resolvedPath=null", async () => {
    const res = await app.request(
      "/api/executors/check-bin?bin=%2Fno%2Fsuch%2Fpath%2Fxyz-9f3a",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      found: boolean;
      resolvedPath: string | null;
    };
    expect(body.found).toBe(false);
    expect(body.resolvedPath).toBeNull();
  });

  it("存在的普通文件但无执行位 → found=false", async () => {
    const res = await app.request(
      `/api/executors/check-bin?bin=${encodeURIComponent(
        path.join(probeDir, "probe-noexec"),
      )}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      found: boolean;
      resolvedPath: string | null;
    };
    expect(body.found).toBe(false);
    expect(body.resolvedPath).toBeNull();
  });

  it("绝对路径指向目录 → found=false", async () => {
    const res = await app.request(
      `/api/executors/check-bin?bin=${encodeURIComponent(probeDir)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      found: boolean;
      resolvedPath: string | null;
    };
    expect(body.found).toBe(false);
    expect(body.resolvedPath).toBeNull();
  });

  it("bin 为空字符串 → 400", async () => {
    const res = await app.request("/api/executors/check-bin?bin=");
    expect(res.status).toBe(400);
  });

  it("缺 bin 参数 → 400", async () => {
    const res = await app.request("/api/executors/check-bin");
    expect(res.status).toBe(400);
  });

  it("bin 超过 200 字符 → 400", async () => {
    const res = await app.request(
      `/api/executors/check-bin?bin=${"a".repeat(201)}`,
    );
    expect(res.status).toBe(400);
  });

  it("bin 含 null 字节(%00)→ 400", async () => {
    const res = await app.request("/api/executors/check-bin?bin=a%00b");
    expect(res.status).toBe(400);
  });
});
