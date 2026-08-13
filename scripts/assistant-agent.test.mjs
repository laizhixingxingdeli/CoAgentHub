import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// 共享临时状态目录:必须在导入被测模块【之前】设置。assistant-agent.mjs 在
// 模块顶层就调用 loadState(),且绑定命令成功时会 saveState();若不设 STATE_FILE,
// 这些读写都会落到真实的 scripts/.assistant-state.json,覆盖运行时助手身份。
// 指向临时文件后所有读写都在临时目录,跑完由 afterAll 统一清理,不污染真实文件。
const STATE_DIR = mkdtempSync(join(tmpdir(), "coagent-test-state-"));
process.env.STATE_FILE = join(STATE_DIR, "state.json");
const participant = await import("./assistant-agent.mjs");

const ME = { id: "me-0001", token: "tok" };
const ENV_KEYS = [
  "MEMORY",
  "WINDOW_MESSAGES",
  "MAX_CONTEXT_TOKENS",
  "PROJECT_DOCS_TOKENS",
  "PROJECT_DOCS_ALLOWED_ROOTS",
  "DEEPSEEK_API_KEY",
  "STATE_FILE",
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
  // 服务器侧群属性:projectPath 由 PATCH 写入、GET 读出(模拟真实 server 状态)。
  const groups = new Map();
  // 群成员:默认空分工;用例可按群设置 roles+prompt。
  const membersByGroup = new Map();
  const posted = [];
  const deepseekCalls = [];
  // PATCH /groups/:id 的模拟响应状态:默认 200;用例设 ≥400 模拟服务器拒绝绑定。
  let patchGroupStatus = 200;
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
    const membersMatch = urlObj.pathname.match(
      /^\/api\/groups\/([^/]+)\/members$/,
    );
    if (membersMatch) {
      // 默认只有助手自己且无分工信息;用例可按群设置成员(roles+prompt)。
      return jsonResponse(
        membersByGroup.get(membersMatch[1]) ?? [
          { participantId: ME.id, roles: [] },
        ],
      );
    }
    // 群详情:GET 读服务器侧 projectPath,PATCH 写入(绑定指令落库的位置)。
    const groupMatch = urlObj.pathname.match(/^\/api\/groups\/([^/]+)$/);
    if (method === "GET" && groupMatch) {
      const gid = groupMatch[1];
      return jsonResponse(groups.get(gid) ?? { id: gid, projectPath: null });
    }
    if (method === "PATCH" && groupMatch) {
      if (patchGroupStatus >= 400) {
        return {
          ok: false,
          status: patchGroupStatus,
          json: async () => ({
            code: "INVALID_REQUEST",
            message: "projectPath 非法",
          }),
          text: async () => "INVALID_REQUEST",
        };
      }
      const gid = groupMatch[1];
      const body = JSON.parse(init.body);
      const group = { id: gid, projectPath: body.projectPath };
      groups.set(gid, group);
      return jsonResponse(group);
    }
    throw new Error(`unexpected call: ${method} ${u}`);
  });
  return {
    messagesByGroup,
    groups,
    membersByGroup,
    posted,
    deepseekCalls,
    fetchMock,
    get patchGroupStatus() {
      return patchGroupStatus;
    },
    set patchGroupStatus(v) {
      patchGroupStatus = v;
    },
  };
}

const savedEnv = {};
let tempDir = null;
const tempDirs = [];

/** 在临时目录里造一个项目目录(支持子目录),登记进 afterEach 统一清理。 */
function makeTempProject(files) {
  const dir = mkdtempSync(join(tmpdir(), "coagent-proj-"));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // 固定记忆相关配置与 DEEPSEEK_API_KEY,避免宿主环境影响用例确定性。
  // 默认固定 test-key,保证 deepseek 调用被记录;需要测「无 key 模板回复」
  // 的用例在内部显式 delete process.env.DEEPSEEK_API_KEY。
  process.env.MEMORY = "per-group";
  process.env.DEEPSEEK_API_KEY = "test-key";
  delete process.env.WINDOW_MESSAGES;
  delete process.env.MAX_CONTEXT_TOKENS;
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: 测试按用例切换环境变量,不参与 turbo 缓存任务
  delete process.env.PROJECT_DOCS_TOKENS;
  delete process.env.PROJECT_DOCS_ALLOWED_ROOTS;
  // 注意:STATE_FILE 不在此处删除——它必须始终指向临时状态文件,否则
  // 绑定命令触发的 saveState() 会写回真实 scripts/.assistant-state.json。
  // 各用例结束后由 afterEach 从 savedEnv 还原到顶层共享的临时路径。
  const s = participant.getState();
  s.participant = { ...ME };
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
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(STATE_DIR, { recursive: true, force: true });
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
    expect(participant.estimateTokens("")).toBe(0);
    expect(participant.estimateTokens("abcd")).toBe(1);
    expect(participant.estimateTokens("abcdefghij")).toBe(3);
  });
});

describe("会话记忆:只记相关消息", () => {
  it("只记定向给助手与 broadcast 的消息;问别人/角色消息/自己的不入记忆", async () => {
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", { audience: "broadcast", senderId: "user-1" }),
      msg("m002", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "直接问我",
      }),
      msg("m003", {
        audience: "participant",
        audienceRef: "other-participant",
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
    await participant.processGroup({ id: "gA" });
    const recent = participant.getState().sessions.gA.recent;
    expect(recent.map((m) => m.id)).toEqual(["m001", "m002"]);
    expect(participant.getState().cursors.gA).toBe("m005");
  });
});

describe("会话记忆:同一群连续问答", () => {
  it("第二问的 prompt 里能看到第一问(有记忆)", async () => {
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "第一问:我们的项目代号是什么?",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    expect(
      participant.getState().sessions.gA.recent.map((m) => m.body),
    ).toEqual(["第一问:我们的项目代号是什么?"]);

    server.messagesByGroup.set("gA", [
      ...server.messagesByGroup.get("gA"),
      msg("m002", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "第二问:刚才那个代号还在用吗?",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
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
    await participant.processGroup({ id: "gA" });
    await participant.processGroup({ id: "gB" });
    const sessions = participant.getState().sessions;
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
    await participant.processGroup({ id: "gA" });
    const s = participant.getState().sessions.gA;
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
    await participant.processGroup({ id: "gA" });
    const s = participant.getState().sessions.gA;
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
    await participant.processGroup({ id: "gA" });
    const s = participant.getState().sessions.gA;
    // 回退默认窗口 40:45 条 → 压缩一次(去最老一半)→ 剩 22 条
    expect(s.recent.length).toBeLessThanOrEqual(40);
    expect(s.summary.length).toBeGreaterThan(0);
  });
});

describe("会话记忆:持久化", () => {
  it("saveState + reloadState(模拟重启)后记忆仍在,且能继续引用", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "coagent-state-"));
    process.env.STATE_FILE = join(tempDir, "state.json");
    process.env.DEEPSEEK_API_KEY = "test-key";
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "记住:仓库代号是 wave",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    participant.saveState();
    const onDisk = JSON.parse(readFileSync(process.env.STATE_FILE, "utf8"));
    expect(onDisk.sessions.gA.recent).toHaveLength(1);

    // 模拟重启:从磁盘重新加载
    participant.reloadState();
    const s = participant.getState();
    expect(s.participant.id).toBe(ME.id);
    expect(s.sessions.gA.recent.map((m) => m.body)).toEqual([
      "记住:仓库代号是 wave",
    ]);

    // 重启后的第二轮提问仍能看到第一轮内容
    server.messagesByGroup.set("gA", [
      ...server.messagesByGroup.get("gA"),
      msg("m002", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "代号是什么?",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
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
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "一个问题",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    expect(participant.getState().sessions).toEqual({});
    expect(server.posted).toHaveLength(1);
    expect(server.deepseekCalls[0].messages.at(-1).content).toBe("一个问题");
  });

  it("无 DEEPSEEK_API_KEY 时回模板回复,记忆仍积累", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "你好",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    expect(server.posted[0].body).toContain("(模板回复)");
    expect(participant.getState().sessions.gA.recent).toHaveLength(1);
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
    await participant.processGroup({ id: "gA" });
    const s = participant.getState().sessions.gA;
    expect(s.summary).toContain("消息1");
    expect(s.summary.length).toBeGreaterThan(0);
    expect(s.recent).toHaveLength(1);
  });
});

describe("parseBindCommand", () => {
  it("识别绑定命令并提取路径;非命令/非绝对路径返回 null", () => {
    expect(participant.parseBindCommand("绑定项目")).toEqual({ path: "" });
    expect(participant.parseBindCommand("绑定项目 /a/b")).toEqual({
      path: "/a/b",
    });
    expect(participant.parseBindCommand("  绑定项目 /a/b  ")).toEqual({
      path: "/a/b",
    });
    expect(participant.parseBindCommand("绑定项目是什么?")).toBeNull();
    expect(participant.parseBindCommand("绑定项目 怎么样?")).toBeNull();
    expect(participant.parseBindCommand("绑定项目 ./x")).toBeNull();
    expect(participant.parseBindCommand("普通消息")).toBeNull();
    expect(participant.parseBindCommand("")).toBeNull();
  });
});

describe("项目文档记忆:绑定项目", () => {
  it("「绑定项目 <绝对路径>」:校验目录、写入会话状态并确认,不调 deepseek", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const project = makeTempProject({ "CONTEXT.md": "项目架构:前后端分离" });
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: `绑定项目 ${project}`,
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    const s = participant.getState().sessions.gA;
    expect(s.projectPath).toBe(realpathSync(project));
    expect(server.posted).toHaveLength(1);
    expect(server.posted[0].body).toContain("已绑定项目");
    // 绑定命令只处理绑定并回复结果,不入 normal 应答
    expect(server.deepseekCalls).toHaveLength(0);
  });

  it("绑定不存在的路径 → 明确报错且不改变群状态", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "绑定项目 /no/such/dir-xyz-1786558476797",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    const s = participant.getState().sessions.gA;
    expect(s.projectPath).toBeUndefined();
    expect(server.posted).toHaveLength(1);
    expect(server.posted[0].body).toContain("绑定失败");
    expect(server.posted[0].body).toContain("不存在或不是目录");
    expect(server.deepseekCalls).toHaveLength(0);
  });

  it("绑定普通文件路径(不是目录)→ 报错", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const project = makeTempProject({});
    const file = join(project, "a.txt");
    writeFileSync(file, "x");
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: `绑定项目 ${file}`,
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    expect(participant.getState().sessions.gA.projectPath).toBeUndefined();
    expect(server.posted[0].body).toContain("绑定失败");
  });

  it("仅「绑定项目」缺少路径 → 提示需要绝对路径", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "绑定项目",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    expect(participant.getState().sessions.gA.projectPath).toBeUndefined();
    expect(server.posted[0].body).toContain("绝对路径");
    expect(server.deepseekCalls).toHaveLength(0);
  });

  it("「绑定项目 <相对路径>」按普通问题处理,不劫持为绑定命令", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "绑定项目 ./some-dir",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    expect(participant.getState().sessions.gA.projectPath).toBeUndefined();
    expect(replyCalls(server)).toHaveLength(1);
  });

  it("「绑定项目 怎么样?」这类自然问句不被劫持,按普通问题应答", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "绑定项目 怎么样?",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    expect(participant.getState().sessions.gA.projectPath).toBeUndefined();
    expect(replyCalls(server)).toHaveLength(1);
  });

  it("PROJECT_DOCS_ALLOWED_ROOTS 白名单:白名单外被拒,白名单内成功", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const inside = makeTempProject({});
    const outside = makeTempProject({});
    process.env.PROJECT_DOCS_ALLOWED_ROOTS = inside;
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: `绑定项目 ${outside}`,
      }),
      msg("m002", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: `绑定项目 ${inside}`,
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    const s = participant.getState().sessions.gA;
    // 白名单外被拒:回复明确报错且未绑定
    expect(server.posted[0].body).toContain("白名单");
    expect(server.posted[0].body).not.toContain("已绑定项目");
    // 白名单内成功
    expect(server.posted[1].body).toContain("已绑定项目");
    expect(s.projectPath).toBe(realpathSync(inside));
  });

  it("绑定命令不入 recent 记忆(避免绝对路径被持久化并反复外发)", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const project = makeTempProject({ "CONTEXT.md": "C" });
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: `绑定项目 ${project}`,
      }),
      msg("m002", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "问题A",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    const recent = participant.getState().sessions.gA.recent;
    expect(recent.map((m) => m.body)).toEqual(["问题A"]);
  });

  it("「绑定项目是什么」按普通问题处理,不劫持为绑定命令", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "绑定项目是什么?",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    expect(participant.getState().sessions.gA.projectPath).toBeUndefined();
    expect(replyCalls(server)).toHaveLength(1);
  });

  it("MEMORY=none 时绑定命令明确回复无法绑定,不读文档", async () => {
    process.env.MEMORY = "none";
    process.env.DEEPSEEK_API_KEY = "test-key";
    const project = makeTempProject({ "CONTEXT.md": "内容" });
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: `绑定项目 ${project}`,
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    expect(server.posted[0].body).toContain("记忆已关闭");
    expect(participant.getState().sessions).toEqual({});
    expect(server.deepseekCalls).toHaveLength(0);
  });
});

describe("项目文档记忆:文档并入 prompt", () => {
  it("未绑定群 prompt 不含【项目文档】段,只有摘要+窗口+问题", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "普通问题",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    const content = replyCalls(server).at(-1).messages.at(-1).content;
    expect(content).not.toContain("【项目文档】");
    expect(content).toContain("【群摘要】");
    expect(content).toContain("【最近消息】");
    expect(content).toContain("普通问题");
  });

  it("绑定后提问,【项目文档】段包含 CONTEXT.md 内容,回复成功", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const project = makeTempProject({
      "CONTEXT.md": "CONTEXT 内容:本项目是前后端分离的 CoAgentHub。",
    });
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: `绑定项目 ${project}`,
      }),
      msg("m002", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "这个项目的架构/约定是什么?",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    const call = replyCalls(server).at(-1);
    const content = call.messages.at(-1).content;
    expect(content).toContain("【项目文档】");
    expect(content).toContain("CONTEXT 内容");
    // 文档作为不可信输入:system prompt 明确其仅为参考资料
    expect(call.messages[0].content).toContain("参考资料");
    expect(server.posted).toHaveLength(2);
  });

  it("按优先级读取;预算不足时不读更低优先级文件", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    process.env.PROJECT_DOCS_TOKENS = "8"; // 3 份文档共 6+7+5 token,只够 CONTEXT 全文 + AGENTS 开头
    const project = makeTempProject({
      "CONTEXT.md": "CONTEXT-AAAA-BBBB-CCCC", // 21 字符 → 6 token
      "AGENTS.md": "AGENTS-BBBB-CCCC-DDDD-EEEE", // 26 字符 → 7 token
      "README.md": "README-XXXX-YYYY-ZZZZ", // 20 字符 → 5 token
    });
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: `绑定项目 ${project}`,
      }),
      msg("m002", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "项目的约定是什么?",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    const content = replyCalls(server).at(-1).messages.at(-1).content;
    expect(content).toContain("CONTEXT-AAAA-BBBB-CCCC");
    expect(content).toContain("AGENTS-B"); // 预算内截断部分
    expect(content).not.toContain("CCCC-DDDD-EEEE"); // 预算外尾部
    expect(content).not.toContain("README");
  });

  it("超预算文档只读入预算内部分,回复成功", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    process.env.PROJECT_DOCS_TOKENS = "8"; // 2 token → 8 字符
    const longContent = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // 36 字符 → 9 token
    const project = makeTempProject({ "CONTEXT.md": longContent });
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: `绑定项目 ${project}`,
      }),
      msg("m002", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "项目的约定是什么?",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    const content = replyCalls(server).at(-1).messages.at(-1).content;
    expect(content).toContain("01234567"); // 预算内前 8 字符
    expect(content).not.toContain("WXYZ"); // 预算外尾部
    expect(server.posted).toHaveLength(2);
  });

  it("docs/adr/*.md 按序读入:在 CLAUDE.md 之后、README.md 之前", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    process.env.PROJECT_DOCS_TOKENS = "100";
    const project = makeTempProject({
      "CONTEXT.md": "C",
      "AGENTS.md": "A",
      "CLAUDE.md": "L",
      "docs/adr/0002-b.md": "B2",
      "docs/adr/0001-a.md": "B1",
      "README.md": "R",
    });
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: `绑定项目 ${project}`,
      }),
      msg("m002", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "架构约定?",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    const content = replyCalls(server).at(-1).messages.at(-1).content;
    const at = (t) => content.indexOf(t);
    expect(at("L")).toBeGreaterThan(at("A"));
    expect(at("B1")).toBeGreaterThan(at("L"));
    expect(at("B2")).toBeGreaterThan(at("B1"));
    expect(at("R")).toBeGreaterThan(at("B2"));
  });

  it("符号链接指向项目根外 → 跳过该文件,仍读根内文档", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const outside = join(tmpdir(), `coagent-outside-${Date.now()}.md`);
    tempDirs.push(outside);
    writeFileSync(outside, "外部秘密内容:绝密");
    const project = makeTempProject({ "CONTEXT.md": "根内内容" });
    symlinkSync(outside, join(project, "CONTEXT-MAP.md"));
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: `绑定项目 ${project}`,
      }),
      msg("m002", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "项目文档里写了什么?",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    const content = replyCalls(server).at(-1).messages.at(-1).content;
    expect(content).toContain("根内内容");
    expect(content).not.toContain("外部秘密内容");
  });

  it("绑定目录被删除后再提问 → 仍能应答,文档段降级为空", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const project = makeTempProject({ "CONTEXT.md": "C" });
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: `绑定项目 ${project}`,
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    expect(participant.getState().sessions.gA.projectPath).toBeTruthy();
    // 绑定后项目目录被删除,再提问
    rmSync(project, { recursive: true, force: true });
    server.messagesByGroup.set("gA", [
      ...server.messagesByGroup.get("gA"),
      msg("m002", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "还有问题",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    const call = replyCalls(server).at(-1);
    expect(call.messages.at(-1).content).toContain("还有问题");
    expect(call.messages.at(-1).content).not.toContain("【项目文档】");
    expect(server.posted).toHaveLength(2);
  });
});

describe("项目文档记忆:持久化", () => {
  it("saveState + reloadState(模拟重启)后 projectPath 仍在,文档继续并入 prompt", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "coagent-state-"));
    process.env.STATE_FILE = join(tempDir, "state.json");
    process.env.DEEPSEEK_API_KEY = "test-key";
    const project = makeTempProject({ "CONTEXT.md": "CONTEXT:架构与约定" });
    const server = makeServer();
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: `绑定项目 ${project}`,
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    participant.saveState();
    const onDisk = JSON.parse(
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: 测试按用例切换环境变量,不参与 turbo 缓存任务
      readFileSync(process.env.STATE_FILE, "utf8"),
    );
    expect(onDisk.sessions.gA.projectPath).toBe(realpathSync(project));

    // 模拟重启:从磁盘重新加载
    participant.reloadState();
    expect(participant.getState().sessions.gA.projectPath).toBe(
      realpathSync(project),
    );

    server.messagesByGroup.set("gA", [
      ...server.messagesByGroup.get("gA"),
      msg("m002", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "这个项目的约定是什么?",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    const content = replyCalls(server).at(-1).messages.at(-1).content;
    expect(content).toContain("【项目文档】");
    expect(content).toContain("架构与约定");
  });
});

describe("buildDivisionOfLabor", () => {
  it("成员带 roles+prompt 生成 role=name(提示词);无 prompt 只有 role=name", () => {
    expect(
      participant.buildDivisionOfLabor([
        {
          participantId: "a1",
          name: "coord",
          roles: ["coordinator"],
          prompt: "负责调度与裁决",
        },
        { participantId: "a2", name: "exec", roles: ["executor"] },
      ]),
    ).toBe("coordinator=coord(负责调度与裁决);executor=exec");
  });

  it("多角色逗号连接;无 roles 但有 prompt 用 member 占位", () => {
    expect(
      participant.buildDivisionOfLabor([
        {
          participantId: "a1",
          name: "multi",
          roles: ["reviewer", "specialist"],
          prompt: "审阅+领域专家",
        },
        {
          participantId: "a2",
          name: "only-prompt",
          roles: [],
          prompt: "纯分工说明",
        },
      ]),
    ).toBe(
      "reviewer,specialist=multi(审阅+领域专家);member=only-prompt(纯分工说明)",
    );
  });

  it("无任何分工信息时返回空串", () => {
    expect(
      participant.buildDivisionOfLabor([{ participantId: "a1", roles: [] }]),
    ).toBe("");
    expect(participant.buildDivisionOfLabor([])).toBe("");
    expect(participant.buildDivisionOfLabor(undefined)).toBe("");
  });
});

describe("分工记忆:本群分工并入 prompt", () => {
  it("成员带 roles+prompt 时,【本群分工】段出现在群摘要之前且内容正确", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const server = makeServer();
    stubFetch(server);
    server.membersByGroup.set("gA", [
      {
        participantId: ME.id,
        name: "assistant",
        roles: ["executor"],
        prompt: "执行任务并回复结果",
      },
      {
        participantId: "u-0001",
        name: "coord",
        roles: ["coordinator"],
        prompt: "负责调度与分工",
      },
    ]);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "u-0001",
        body: "本群怎么分工的?",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    // 分工文本存入会话状态(每次处理刷新)
    expect(participant.getState().sessions.gA.divisionOfLabor).toBe(
      "executor=assistant(执行任务并回复结果);coordinator=coord(负责调度与分工)",
    );
    const content = replyCalls(server).at(-1).messages.at(-1).content;
    expect(content).toContain("【本群分工】");
    expect(content).toContain("coordinator=coord(负责调度与分工)");
    // 置于群摘要之前
    expect(content.indexOf("【本群分工】")).toBeLessThan(
      content.indexOf("【群摘要】"),
    );
  });

  it("MEMORY=none 时不生成分工记忆,prompt 只有问题本身", async () => {
    process.env.MEMORY = "none";
    process.env.DEEPSEEK_API_KEY = "test-key";
    const server = makeServer();
    stubFetch(server);
    server.membersByGroup.set("gA", [
      {
        participantId: ME.id,
        name: "assistant",
        roles: ["executor"],
        prompt: "执行任务",
      },
    ]);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "u-0001",
        body: "分工是什么?",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    expect(participant.getState().sessions).toEqual({});
    const content = replyCalls(server).at(-1).messages.at(-1).content;
    expect(content).toBe("分工是什么?");
    expect(content).not.toContain("【本群分工】");
  });
});

describe("服务器绑定:拒绝与解绑语义", () => {
  it("服务器拒绝绑定(PATCH 400)→ 回复失败且不回写本地 projectPath", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const project = makeTempProject({ "CONTEXT.md": "C" });
    const server = makeServer();
    server.patchGroupStatus = 400;
    stubFetch(server);
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: `绑定项目 ${project}`,
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    const s = participant.getState().sessions.gA;
    // 服务器拒绝:本地不回写、不出现成功确认
    expect(s.projectPath).toBeUndefined();
    expect(server.posted).toHaveLength(1);
    expect(server.posted[0].body).toContain("绑定失败");
    expect(server.posted[0].body).toContain("服务器未接受该路径");
    expect(server.posted[0].body).not.toContain("已绑定项目");
    expect(server.deepseekCalls).toHaveLength(0);
  });

  it("服务器解绑(projectPath 为 null)后不回退本地旧绑定,文档不再并入", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const project = makeTempProject({ "CONTEXT.md": "C" });
    const server = makeServer();
    stubFetch(server);
    // 第一轮:绑定成功(服务器 + 本地都有)
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: `绑定项目 ${project}`,
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    expect(participant.getState().sessions.gA.projectPath).toBeTruthy();

    // 服务器侧解绑:projectPath 清为 null(模拟 PATCH { projectPath: null })
    server.groups.set("gA", { id: "gA", projectPath: null });

    // 第二轮提问:服务器明确 null,不能复活本地旧绑定
    server.messagesByGroup.set("gA", [
      ...server.messagesByGroup.get("gA"),
      msg("m002", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "还有问题",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    const call = replyCalls(server).at(-1);
    expect(call.messages.at(-1).content).toContain("还有问题");
    expect(call.messages.at(-1).content).not.toContain("【项目文档】");
  });

  it("服务器 projectPath 不在白名单内 → 读取前拦截,文档不并入", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const inside = makeTempProject({});
    const outside = makeTempProject({ "CONTEXT.md": "外部项目秘密" });
    process.env.PROJECT_DOCS_ALLOWED_ROOTS = inside;
    const server = makeServer();
    stubFetch(server);
    // 服务器已绑定到白名单外的路径(模拟其它客户端 PATCH 写入)
    server.groups.set("gA", { id: "gA", projectPath: outside });
    server.messagesByGroup.set("gA", [
      msg("m001", {
        audience: "participant",
        audienceRef: ME.id,
        senderId: "user-1",
        body: "项目里写了什么?",
      }),
    ]);
    await participant.processGroup({ id: "gA" });
    const call = replyCalls(server).at(-1);
    expect(call.messages.at(-1).content).not.toContain("外部项目秘密");
    expect(call.messages.at(-1).content).not.toContain("【项目文档】");
  });
});
