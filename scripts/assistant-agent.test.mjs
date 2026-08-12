import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as agent from "./assistant-agent.mjs";

const ME = { id: "me-0001", token: "tok" };
const ENV_KEYS = [
  "MEMORY",
  "WINDOW_MESSAGES",
  "MAX_CONTEXT_TOKENS",
  "DEEPSEEK_API_KEY",
  "ASSISTANT_STATE_FILE",
];

function jsonResponse(data) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function msg(
  id,
  {
    groupId = "gA",
    senderId = "user-1",
    body = `body-${id}`,
    audience = "broadcast",
    audienceRef = null,
  } = {},
) {
  return {
    id,
    groupId,
    senderId,
    body,
    audience,
    audienceRef,
    parentId: null,
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

/** 内存版 API server + DeepSeek 的 fetch mock,记录回复与 DeepSeek 调用。 */
function makeServer() {
  const messagesByGroup = new Map();
  const posted = [];
  const deepseekCalls = [];
  const fetchMock = vi.fn(async (url, init = {}) => {
    const u = String(url);
    const method = init.method ?? "GET";
    if (u.startsWith("https://api.deepseek.com/")) {
      const body = JSON.parse(init.body);
      deepseekCalls.push(body);
      const user = body.messages.at(-1).content;
      const isCompress = user.includes("【已有摘要】");
      const content = isCompress
        ? "【压缩摘要】旧消息已合并"
        : `回复:「${user.slice(0, 40)}」`;
      return jsonResponse({ choices: [{ message: { content } }] });
    }
    const urlObj = new URL(u);
    const messagesMatch = urlObj.pathname.match(
      /^\/api\/groups\/([^/]+)\/messages$/,
    );
    if (method === "GET" && messagesMatch) {
      const gid = messagesMatch[1];
      const after = urlObj.searchParams.get("after") ?? "";
      return jsonResponse(
        (messagesByGroup.get(gid) ?? []).filter((m) => m.id > after),
      );
    }
    if (method === "POST" && messagesMatch) {
      const body = JSON.parse(init.body);
      posted.push({ groupId: messagesMatch[1], ...body });
      return jsonResponse({ id: `msg-${posted.length}`, ...body });
    }
    if (urlObj.pathname.endsWith("/members")) {
      return jsonResponse([{ agentId: ME.id, roles: [] }]);
    }
    throw new Error(`unexpected call: ${method} ${u}`);
  });
  return { messagesByGroup, posted, deepseekCalls, fetchMock };
}

const savedEnv = {};
let tempDir = null;

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // 固定记忆相关配置,避免宿主环境(如 DEEPSEEK_API_KEY)影响用例确定性
  process.env.MEMORY = "per-group";
  delete process.env.WINDOW_MESSAGES;
  delete process.env.MAX_CONTEXT_TOKENS;
  delete process.env.ASSISTANT_STATE_FILE;
  const s = agent.getState();
  s.agent = { ...ME };
  s.cursors = {};
  s.sessions = {};
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  vi.unstubAllGlobals();
});

function stubFetch(server) {
  vi.stubGlobal("fetch", server.fetchMock);
}

const replyCalls = (server) =>
  server.deepseekCalls.filter(
    (c) => !c.messages[0].content.includes("滚动摘要"),
  );

describe("estimateTokens", () => {
  it("按字符数/4 近似估算", () => {
    expect(agent.estimateTokens("")).toBe(0);
    expect(agent.estimateTokens("abcd")).toBe(1);
    expect(agent.estimateTokens("abcdefghij")).toBe(3);
  });
});

describe("会话记忆:只记相关消息", () => {
  it("只记定向给助手与 broadcast 的消息;问别人/角色消息/自己的不入记忆", async () => {
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", { audience: "broadcast", senderId: "user-1" }),
      msg("m002", {
        audience: "agent",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "直接问我",
      }),
      msg("m003", {
        audience: "agent",
        audienceRef: "other-agent",
        senderId: "user-1",
        body: "问别人",
      }),
      msg("m004", {
        audience: "role",
        audienceRef: "reviewer",
        senderId: "user-1",
        body: "角色消息",
      }),
      msg("m005", {
        audience: "broadcast",
        senderId: ME.id,
        body: "我自己发的",
      }),
    ]);
    await agent.processGroup({ id: "gA" });
    const recent = agent.getState().sessions.gA.recent;
    expect(recent.map((m) => m.id)).toEqual(["m001", "m002"]);
    expect(agent.getState().cursors.gA).toBe("m005");
  });
});

describe("会话记忆:同一群连续问答", () => {
  it("第二问的 prompt 里能看到第一问(有记忆)", async () => {
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "agent",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "第一问:我们的项目代号是什么?",
      }),
    ]);
    await agent.processGroup({ id: "gA" });
    expect(agent.getState().sessions.gA.recent.map((m) => m.body)).toEqual([
      "第一问:我们的项目代号是什么?",
    ]);

    server.messagesByGroup.set("gA", [
      ...server.messagesByGroup.get("gA"),
      msg("m002", {
        audience: "agent",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "第二问:刚才那个代号还在用吗?",
      }),
    ]);
    await agent.processGroup({ id: "gA" });
    const last = replyCalls(server).at(-1);
    expect(last.messages.at(-1).content).toContain(
      "第一问:我们的项目代号是什么?",
    );
    expect(last.messages.at(-1).content).toContain(
      "第二问:刚才那个代号还在用吗?",
    );
    expect(server.posted).toHaveLength(2);
  });
});

describe("会话记忆:按群隔离", () => {
  it("不同群各自独立 summary/recent,互不串扰", async () => {
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", { senderId: "user-1", body: "A 群的事" }),
    ]);
    server.messagesByGroup.set("gB", [
      msg("m001", { senderId: "user-2", body: "B 群的事" }),
    ]);
    await agent.processGroup({ id: "gA" });
    await agent.processGroup({ id: "gB" });
    const sessions = agent.getState().sessions;
    expect(Object.keys(sessions).sort()).toEqual(["gA", "gB"]);
    expect(sessions.gA.recent.map((m) => m.body)).toEqual(["A 群的事"]);
    expect(sessions.gB.recent.map((m) => m.body)).toEqual(["B 群的事"]);
  });
});

describe("会话记忆:窗口上限触发压缩", () => {
  it("WINDOW_MESSAGES=5 + 大量消息:摘要被更新、窗口被裁剪、合并调用发生", async () => {
    process.env.WINDOW_MESSAGES = "5";
    process.env.DEEPSEEK_API_KEY = "test-key";
    const server = makeServer();
    stubFetch(server);
    const list = [];
    for (let i = 1; i <= 12; i += 1) {
      list.push(
        msg(`m${String(i).padStart(3, "0")}`, {
          audience: "broadcast",
          senderId: "user-1",
          body: `第 ${i} 条广播消息`,
        }),
      );
    }
    server.messagesByGroup.set("gA", list);
    await agent.processGroup({ id: "gA" });
    const s = agent.getState().sessions.gA;
    // 12 → 压缩两次(去最老一半) → 剩最近 3 条
    expect(s.recent.map((m) => m.id)).toEqual(["m010", "m011", "m012"]);
    expect(s.summary.length).toBeGreaterThan(0);
    const comp = server.deepseekCalls.filter((c) =>
      c.messages[0].content.includes("滚动摘要"),
    );
    expect(comp).toHaveLength(2);
    // 第一次合并请求带着最老一批消息
    expect(comp[0].messages.at(-1).content).toContain("第 1 条广播消息");
    // 第二次合并请求把旧摘要也带上
    expect(comp[1].messages.at(-1).content).toContain(
      "【压缩摘要】旧消息已合并",
    );
  });
});

describe("会话记忆:预算触发压缩", () => {
  it("摘要+窗口估算超 MAX_CONTEXT_TOKENS 时压缩,回复成功", async () => {
    process.env.MAX_CONTEXT_TOKENS = "8";
    process.env.DEEPSEEK_API_KEY = "test-key";
    const server = makeServer();
    stubFetch(server);
    const list = [];
    for (let i = 1; i <= 6; i += 1) {
      list.push(
        msg(`m${String(i).padStart(3, "0")}`, {
          audience: "broadcast",
          senderId: "user-1",
          body: "这是一个足够长的消息内容以撑大 token 预算,abcdefghijklmnopqrstuvwxyz 0123456789",
        }),
      );
    }
    server.messagesByGroup.set("gA", list);
    await agent.processGroup({ id: "gA" });
    const s = agent.getState().sessions.gA;
    // 6 → 3 → 1(预算仍超但窗口只剩 1 条,停止)
    expect(s.recent).toHaveLength(1);
    expect(s.summary.length).toBeGreaterThan(0);
  });
});

describe("会话记忆:环境变量容错", () => {
  it("非数字 WINDOW_MESSAGES/MAX_CONTEXT_TOKENS 回退默认值,不静默禁用压缩", async () => {
    process.env.WINDOW_MESSAGES = "abc";
    process.env.MAX_CONTEXT_TOKENS = "5k";
    process.env.DEEPSEEK_API_KEY = "test-key";
    const server = makeServer();
    stubFetch(server);
    const list = [];
    for (let i = 1; i <= 45; i += 1) {
      list.push(msg(`m${String(i).padStart(3, "0")}`, { body: `消息 ${i}` }));
    }
    server.messagesByGroup.set("gA", list);
    await agent.processGroup({ id: "gA" });
    const s = agent.getState().sessions.gA;
    // 回退默认窗口 40:45 条 → 压缩一次(去最老一半)→ 剩 22 条
    expect(s.recent.length).toBeLessThanOrEqual(40);
    expect(s.summary.length).toBeGreaterThan(0);
  });
});

describe("会话记忆:持久化", () => {
  it("saveState + reloadState(模拟重启)后记忆仍在,且能继续引用", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "coagent-state-"));
    process.env.ASSISTANT_STATE_FILE = join(tempDir, "state.json");
    process.env.DEEPSEEK_API_KEY = "test-key";
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "agent",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "记住:仓库代号是 wave",
      }),
    ]);
    await agent.processGroup({ id: "gA" });
    agent.saveState();
    const onDisk = JSON.parse(
      readFileSync(process.env.ASSISTANT_STATE_FILE, "utf8"),
    );
    expect(onDisk.sessions.gA.recent).toHaveLength(1);

    // 模拟重启:从磁盘重新加载
    agent.reloadState();
    const s = agent.getState();
    expect(s.agent.id).toBe(ME.id);
    expect(s.sessions.gA.recent.map((m) => m.body)).toEqual([
      "记住:仓库代号是 wave",
    ]);

    // 重启后的第二轮提问仍能看到第一轮内容
    server.messagesByGroup.set("gA", [
      ...server.messagesByGroup.get("gA"),
      msg("m002", {
        audience: "agent",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "代号是什么?",
      }),
    ]);
    await agent.processGroup({ id: "gA" });
    const last = replyCalls(server).at(-1);
    expect(last.messages.at(-1).content).toContain("记住:仓库代号是 wave");
  });
});

describe("会话记忆:开关与降级", () => {
  it("MEMORY=none 时行为与旧版一致:不建会话,prompt 只有问题本身", async () => {
    process.env.MEMORY = "none";
    process.env.DEEPSEEK_API_KEY = "test-key";
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "agent",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "一个问题",
      }),
    ]);
    await agent.processGroup({ id: "gA" });
    expect(agent.getState().sessions).toEqual({});
    expect(server.posted).toHaveLength(1);
    expect(server.deepseekCalls[0].messages.at(-1).content).toBe("一个问题");
  });

  it("无 DEEPSEEK_API_KEY 时回模板回复,记忆仍积累", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "agent",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "你好",
      }),
    ]);
    await agent.processGroup({ id: "gA" });
    expect(server.posted[0].body).toContain("(模板回复)");
    expect(agent.getState().sessions.gA.recent).toHaveLength(1);
  });

  it("无 API key 时压缩退化为文本拼接,摘要仍非空", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.WINDOW_MESSAGES = "2";
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", { body: "消息1" }),
      msg("m002", { body: "消息2" }),
      msg("m003", { body: "消息3" }),
    ]);
    await agent.processGroup({ id: "gA" });
    const s = agent.getState().sessions.gA;
    expect(s.summary).toContain("消息1");
    expect(s.summary.length).toBeGreaterThan(0);
    expect(s.recent).toHaveLength(1);
  });
});
