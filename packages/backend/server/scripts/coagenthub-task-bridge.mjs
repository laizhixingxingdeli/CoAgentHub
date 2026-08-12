#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
/**
 * CoAgentHub 任务执行桥(纯 Node,零第三方依赖)—— ticket 30。
 *
 * 把网页群变成任务控制台:
 *   @hermes    → 无头 Hermes 多轮讨论(每群一个 session,--resume 续接)
 *   @执行器    → 生成任务书,全局串行队列后台执行,状态回传群
 *   「停止/取消/停一下」→ 清空队列(并终止执行中的子进程组)
 *   「回滚 [taskId]」→ 恢复工作区到任务执行前快照(refs/coagenthub-cp/<taskId>)
 *
 * 可靠性(2026-08-12):消息在 handleMessage 入口按群幂等去重(processedIds 持久化,
 * webhook+增量拉取双路径只执行一次);每个任务执行前打 git 快照,完成后回传 diff 摘要。
 *
 * 执行器配置化:executors.json 定义「一个 AI 工具 = 一个 agent 身份」,桥启动时
 * 为每个执行器自动注册 agent(幂等;Hermes 规划/AtomCode 执行器/Reasoning 执行器…),
 * 群里 @ 到哪个 agent 就调对应 CLI,加工具不用改代码。
 * id+token 持久化在 .bridge-state.json(与脚本同目录,已 gitignore)。
 * 桥只通过 HTTP API 与 CoAgentHub 交互,不 import server 源码。
 *
 * 用法:
 *   node coagenthub-task-bridge.mjs
 * 管理端点(无鉴权,局域网信任模型,与 /hook 一致;前端管理界面用):
 *   GET    /executors       查看执行器配置列表(含注册状态,不含敏感信息)
 *   POST   /executors       添加/更新执行器(body: {key,label,bin,args?,agentName?,type?})
 *                           → 写回 executors.json + 热重载(新执行器立即注册可用)
 *   DELETE /executors/:key  删除执行器(不再调度;已注册的 agent 保留在 CoAgentHub,不注销)
 * 环境变量(均有默认值):
 *   API_BASE         默认 http://localhost:5173/api
 *   HOOK_PORT        默认 9199(webhook 接收端口,路径 /hook)
 *   HOOK_URL         注册 agent 时的 webhook 地址,默认 http://localhost:9199/hook
 *   HERMES_TIMEOUT_MS 默认 120000(单次 hermes -z 调用超时)
 *   EXECUTORS_FILE    默认 <脚本目录>/executors.json(执行器配置;缺失/损坏时退回内置默认)
 *
 * 实测结论(2026-08-10):
 *   hermes --pass-session-id 只是把 session id 注入 system prompt,不会打印到
 *   stdout/stderr(模型可能回显旧 id,不可靠);可靠取法是调用后
 *   `hermes sessions list --workspace <仓库> --limit 1` 解析行尾 id(格式
 *   `YYYYMMDD_HHMMSS_hex`),--resume <id> 可续接同一会话。
 */
import { createServer } from "node:http";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..", "..");
const API_BASE = (process.env.API_BASE ?? "http://localhost:5173/api").replace(
  /\/+$/,
  "",
);
const HOOK_PORT = Number(process.env.HOOK_PORT ?? "9199");
const HOOK_URL = process.env.HOOK_URL ?? `http://localhost:${HOOK_PORT}/hook`;
const HERMES_TIMEOUT_MS = Number(process.env.HERMES_TIMEOUT_MS ?? "120000");
const HERMES_BIN = process.env.HERMES_BIN ?? "hermes";
const ATOMCODE_BIN = process.env.ATOMCODE_BIN ?? "atomcode";
const STATE_FILE = resolve(SCRIPT_DIR, ".bridge-state.json");
const LOG_FILE = resolve(SCRIPT_DIR, "bridge.log");
const EXECUTORS_FILE =
  process.env.EXECUTORS_FILE ?? resolve(SCRIPT_DIR, "executors.json");

/**
 * 内置默认执行器(= ticket 25 行为):executors.json 缺失/解析失败时的兜底。
 * 提交到仓库的 executors.json 才是正式配置(用户可改),二者差异只在默认只含 atomcode。
 */
const DEFAULT_EXECUTORS = [
  {
    key: "executor",
    agentName: "executor-bridge",
    type: "agent",
    bin: ATOMCODE_BIN,
    label: "atomcode",
  },
];

/** 读执行器配置:EXECUTORS_FILE 可覆盖默认路径;缺失/损坏时退回内置默认。 */
function loadExecutors() {
  try {
    if (existsSync(EXECUTORS_FILE)) {
      const parsed = JSON.parse(readFileSync(EXECUTORS_FILE, "utf8"));
      const list = Array.isArray(parsed.executors) ? parsed.executors : [];
      if (list.length > 0) return normalizeExecutors(list);
      log("warn", `executors.json 无有效 executors 数组,用内置默认执行器`);
    } else {
      log("info", `未找到 ${EXECUTORS_FILE},用内置默认执行器(= 旧行为)`);
    }
  } catch (e) {
    log("warn", `executors.json 读取失败(${e}),用内置默认执行器`);
  }
  return DEFAULT_EXECUTORS;
}

/** 字段兜底:key/agentName/bin/label 缺失时补默认;重复 key 告警。 */
function normalizeExecutors(list) {
  const seen = new Set();
  return list.map((e, i) => {
    const key = String(e.key ?? `executor${i + 1}`);
    const ex = {
      key,
      agentName: String(e.agentName ?? `${key}-bridge`),
      type: String(e.type ?? "agent"),
      bin: String(e.bin ?? (i === 0 ? ATOMCODE_BIN : key)),
      label: String(e.label ?? key),
      args: Array.isArray(e.args) ? e.args.map(String) : undefined,
    };
    if (seen.has(ex.key))
      log("warn", `执行器 key 重复: ${ex.key}(后者覆盖前者)`);
    seen.add(ex.key);
    return ex;
  });
}

let EXECUTORS = loadExecutors();
/** 所有 agent 身份键:hermes + 每个执行器的 key(拉消息/查回环都要用)。 */
let AGENT_KEYS = ["hermes", ...EXECUTORS.map((ex) => ex.key)];
/** 桥注册的全部 agent,由配置生成:hermes + executors.json 里的每个执行器。 */
let AGENTS = [
  { key: "hermes", name: "Hermes 规划", type: "hermes" },
  ...EXECUTORS.map((ex) => ({
    key: ex.key,
    name: ex.agentName,
    type: ex.type,
  })),
];
const EXEC_ALLOWED_ROLES = ["coordinator", "human"];
const SESSION_ID_RE = /(\d{8}_\d{6}_[0-9a-f]+)\s*$/;
const ANSI_RE =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/* ---------------- 状态与日志 ---------------- */

let state = { agents: {}, groups: {}, checkpoints: [] };

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      state = {
        agents: parsed.agents ?? {},
        groups: parsed.groups ?? {},
        checkpoints: parsed.checkpoints ?? [],
      };
    }
  } catch (e) {
    log("warn", `状态文件解析失败,从空状态开始: ${e}`);
    state = { agents: {}, groups: {}, checkpoints: [] };
  }
}

function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log("error", `状态写入失败: ${e}`);
  }
}

/**
 * 老 state(ticket 25)里执行器键名是 "executor";新格式按 executors[].key 存。
 * 默认配置第一个执行器 key 恰好也是 "executor",天然兼容;仅当用户改了第一个
 * 执行器的 key 时才把旧键搬过去。不搬也不影响功能——最多多留一个旧键,
 * 新 key 会走重新注册。
 */
function migrateLegacyExecutorState() {
  const first = EXECUTORS[0];
  if (!first || state.agents[first.key]) return;
  if (state.agents.executor) {
    log("info", `迁移旧 state: agents.executor → agents.${first.key}`);
    state.agents[first.key] = state.agents.executor;
    delete state.agents.executor;
    saveState();
  }
}

function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    /* 日志写失败不阻塞 */
  }
}

/* ---------------- HTTP API(按 agent 身份) ---------------- */

async function api(agentKey, method, path, body) {
  const agent = state.agents[agentKey];
  if (!agent?.token) throw new Error(`agent ${agentKey} 未就绪(无 token)`);
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${agent.token}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
  }
  return res.json();
}

/** 公开端点(不需要 agent token,如 GET /agents)。 */
async function publicApi(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
  }
  return res.json();
}

/* ---------------- agent 自注册(幂等) ---------------- */

async function ensureAgent(cfg) {
  const existing = state.agents[cfg.key];
  if (existing?.id && existing?.token) {
    try {
      await api(cfg.key, "PUT", `/agents/${existing.id}/heartbeat`);
      log("info", `${cfg.name}: 复用已注册 agent ${existing.id}`);
      return;
    } catch (e) {
      log("warn", `${cfg.name}: 既有 token 失效(${e}),重新注册`);
    }
  }
  let found = null;
  try {
    const list = await publicApi("GET", "/agents");
    found = list.find((a) => a.name === cfg.name) ?? null;
  } catch (e) {
    log("warn", `${cfg.name}: 查询 agent 列表失败(${e}),直接注册`);
  }
  if (found) {
    log(
      "warn",
      `${cfg.name}: 服务端已存在同名 agent(${found.id})但 token 丢失,注册新实例(同名允许)`,
    );
  }
  const created = await publicApi("POST", "/agents", {
    name: cfg.name,
    type: cfg.type,
    device: "mac",
    webhookUrl: HOOK_URL,
    capabilities: ["task-bridge"],
  });
  state.agents[cfg.key] = { id: created.id, token: created.token };
  saveState();
  log("info", `${cfg.name}: 注册成功 agent ${created.id}`);
}

/* ---------------- 消息处理(按群串行) ---------------- */

const groupChains = new Map();
let hermesChain = Promise.resolve();
const queue = [];
let runningTask = null;

function enqueueGroup(gid) {
  const prev = groupChains.get(gid) ?? Promise.resolve();
  const next = prev
    .then(() => pullAndProcess(gid))
    .catch((e) => log("error", `群 ${gid.slice(0, 8)} 处理失败: ${e}`));
  groupChains.set(gid, next);
  return next;
}

async function pullAndProcess(gid) {
  const gs = (state.groups[gid] ??= {
    title: "",
    hermesSession: null,
    cursors: {},
    processedIds: [],
  });
  const seen = new Set();
  const all = [];
  // 每个 agent 身份各拉一遍再合并:可见性不同,单身份看不到对方定向的消息。
  for (const key of AGENT_KEYS) {
    const after = gs.cursors[key] ?? "";
    let msgs;
    try {
      msgs = await api(
        key,
        "GET",
        `/groups/${gid}/messages${after ? `?after=${after}` : ""}`,
      );
    } catch (e) {
      log("warn", `群 ${gid.slice(0, 8)} ${key} 增量拉取失败: ${e}`);
      continue;
    }
    for (const m of msgs) {
      seen.add(m.id);
      all.push(m);
      const cur = gs.cursors[key];
      if (!cur || m.id > cur) gs.cursors[key] = m.id;
    }
  }
  all.sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const m of all) {
    await handleMessage(gid, gs, m);
  }
  saveState();
}

async function handleMessage(gid, gs, m) {
  const body = (m.body ?? "").trim();
  const mine = [
    state.agents.hermes?.id,
    ...EXECUTORS.map((ex) => state.agents[ex.key]?.id),
  ].filter(Boolean);
  log(
    "info",
    `群 ${gid.slice(0, 8)} 消息 ${m.id.slice(0, 8)} sender=${m.senderId.slice(
      0,
      8,
    )} audience=${m.audience} ref=${m.audienceRef ?? ""} body=${body.slice(
      0,
      40,
    )}`,
  );
  if (mine.includes(m.senderId) && m.audience === "broadcast") {
    log("info", "桥自身广播,跳过(防回环)");
    return;
  }
  // T2 幂等去重:webhook 立即处理 + 增量拉取两条路径都会进这里,同一消息可能重复
  // 触发动作(2026-08-11 曾发生同一任务执行两遍)。只对会触发动作的消息(@hermes 讨论、
  // @执行器任务、停止/回滚指令)去重;桥自身广播已在上方跳过,不受影响。processedIds
  // 持久化在 state.groups[gid] 内,重启桥不丢。路由判定与去重共用同一份,保证不会
  // 记录「其他消息」。
  const hermes =
    m.audience === "agent" && m.audienceRef === state.agents.hermes?.id;
  // 按 @ 到的 agent 路由到对应执行器:一个 AI 工具 = 一个 agent 身份。
  const ex =
    !hermes &&
    m.audience === "agent" &&
    EXECUTORS.find((e) => m.audienceRef === state.agents[e.key]?.id);
  const rollback = !hermes && !ex ? body.match(/^回滚\s*(\S+)?/) : null;
  const cancel =
    !hermes && !ex && !rollback && /^(停止|取消|停一下)/.test(body);
  const acts = hermes || ex || rollback || cancel;
  if (acts) {
    const processed = gs.processedIds ?? (gs.processedIds = []);
    if (processed.includes(m.id)) {
      log("info", `消息 ${m.id.slice(0, 8)} 已触发过动作,幂等跳过(双路径去重)`);
      return;
    }
  }
  if (hermes) {
    await handleHermes(gid, gs, m);
  } else if (ex) {
    await handleExecutor(gid, m, ex);
  } else if (rollback) {
    await handleRollback(gid, m, rollback[1] ?? null);
  } else if (cancel) {
    await handleCancel(gid, m);
  } else {
    log("info", "其他消息,忽略");
    return;
  }
  if (acts) {
    gs.processedIds.push(m.id);
    saveState();
  }
}

/**
 * T26: 按正文前缀区分回传消息类型——状态类(📋🚀✅❌🛑)→ task_status,
 * hermes 讨论回复(💬)→ discussion,其余(如 ⛔ 权限拒绝)保持 text/plain。
 * 前端按 contentType 渲染不同类型的气泡。
 */
function contentTypeFor(body) {
  if (/^[📋🚀✅❌🛑]/u.test(body)) return "task_status";
  if (/^💬/.test(body)) return "discussion";
  return "text/plain";
}

async function reply(agentKey, gid, body) {
  try {
    await api(agentKey, "POST", `/groups/${gid}/messages`, {
      body,
      audience: "broadcast",
      contentType: contentTypeFor(body),
    });
    log("info", `回传 [${agentKey}] ${body.slice(0, 80)}`);
  } catch (e) {
    log("error", `回传失败: ${e}`);
  }
}

/** 状态回传按入链顺序串行发出,保证同一任务的 📋/🚀/✅/❌ 不乱序。 */
let statusChain = Promise.resolve();
function enqueueStatus(gid, body, agentKey) {
  statusChain = statusChain.then(() => reply(agentKey, gid, body));
}

/* ---------------- ② @hermes 讨论 ---------------- */

async function handleHermes(gid, gs, m) {
  // 全局串行:hermes 调用 + session 查询必须互斥,否则会取错 session。
  hermesChain = hermesChain.then(async () => {
    try {
      await doHermes(gid, gs, m);
    } catch (e) {
      log("error", `hermes 处理异常: ${e}`);
    }
  });
  await hermesChain;
}

async function doHermes(gid, gs, m) {
  if (!gs.title) {
    try {
      const groups = await api("hermes", "GET", "/groups");
      const g = groups.find((x) => x.id === gid);
      if (g) {
        gs.title = g.title;
        saveState();
      }
    } catch (e) {
      log("warn", `群标题获取失败: ${e}`);
    }
  }
  const executorId = state.agents[EXECUTORS[0]?.key]?.id ?? "";
  const prompt = [
    `[上下文] 你在 CoAgentHub 群「${gs.title || gid}」中作为规划 agent 与用户讨论。`,
    `当前仓库:${REPO_ROOT}。用户消息:${m.body}`,
    `[能力] 你可以读仓库文件分析方案;讨论清楚后,若用户明确表达执行意图(如「执行吧」「发布」「开始」「可以」),调用 CoAgentHub API 发送 audience=agent&audienceRef=${executorId} 的消息来发布任务给执行者。`,
    `发布任务消息格式:body 里写明任务目标+约束。API:POST ${API_BASE}/groups/${gid}/messages,Authorization: Bearer {hermesToken}。不要擅自发布——只有用户明确同意才发。`,
    `[要求] 回复中文,简洁,直接给方案或问题。`,
  ].join("\n");

  const resumed = !!gs.hermesSession;
  log(
    "info",
    `@hermes 调用 ${resumed ? `resume ${gs.hermesSession}` : "新会话(--pass-session-id)"}`,
  );
  const result = await runHermes(prompt, gs.hermesSession);

  if (result.timeout) {
    await reply("hermes", gid, "💬 (hermes 思考超时,请重试或简化问题)");
    return;
  }
  if (result.error) {
    await reply("hermes", gid, `💬 hermes 调用失败: ${result.error}`);
    return;
  }

  const sid = latestHermesSessionId();
  if (sid) {
    gs.hermesSession = sid;
    saveState();
    log("info", `hermes session 更新: ${sid}`);
  }
  const text = String(result.stdout ?? "")
    .replace(ANSI_RE, "")
    .trim()
    .slice(0, 2000);
  await reply("hermes", gid, `💬 ${text || "(hermes 无输出)"}`);
}

function runHermes(prompt, sessionId) {
  return new Promise((resolvePromise) => {
    const args = ["-z", prompt];
    if (sessionId) args.push("--resume", sessionId);
    else args.push("--pass-session-id");
    let child;
    try {
      child = spawn(HERMES_BIN, args, { cwd: REPO_ROOT });
    } catch (e) {
      resolvePromise({ error: String(e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      log("warn", `hermes 调用超时(${HERMES_TIMEOUT_MS}ms),SIGKILL`);
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    }, HERMES_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolvePromise({ error: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) resolvePromise({ timeout: true });
      else if (code !== 0)
        resolvePromise({
          error: `exit=${code} ${String(stderr ?? "")
            .replace(ANSI_RE, "")
            .trim()
            .slice(0, 200)}`,
        });
      else resolvePromise({ stdout });
    });
  });
}

/** 调用后立刻取该仓库 workspace 最新一条 session(与调用互斥,见 hermesChain)。 */
function latestHermesSessionId() {
  const needles = [REPO_ROOT, basename(REPO_ROOT)];
  for (const n of needles) {
    try {
      const out = spawnSync(
        HERMES_BIN,
        ["sessions", "list", "--workspace", n, "--limit", "1"],
        { encoding: "utf8", timeout: 20_000 },
      );
      const lines = (out.stdout ?? "").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const match = lines[i].match(SESSION_ID_RE);
        if (match) return match[1];
      }
    } catch {
      /* 试下一个 needle */
    }
  }
  return null;
}

/* ---------------- ③ @执行器 任务 ---------------- */

/**
 * T35:任务状态单一源迁到 server。spawn 前先登记任务行(POST /tasks,
 * message_id 唯一 → 幂等,重复触发返回既有任务);执行完成/失败/取消再
 * PATCH 状态与 diffSummary。桥本地 .bridge-state.json 不再持有任务状态。
 */

/** 登记任务行;失败返回 null(不入队)。 */
async function createServerTask(gid, m, ex) {
  try {
    const task = await api(ex.key, "POST", `/groups/${gid}/tasks`, {
      messageId: m.id,
      executorAgentId: state.agents[ex.key]?.id ?? "",
    });
    log("info", `任务已登记 server: ${task.id} (message ${m.id.slice(0, 8)})`);
    return task;
  } catch (e) {
    log("error", `[${ex.label}] 任务登记失败: ${e}`);
    return null;
  }
}

/** PATCH 任务行(best-effort:失败只记日志,不阻塞主流程)。 */
function patchTask(gid, taskId, body, agentKey) {
  return api(agentKey, "PATCH", `/groups/${gid}/tasks/${taskId}`, body).catch(
    (e) => log("warn", `任务状态回传失败 ${JSON.stringify(body)}: ${e}`),
  );
}

async function handleExecutor(gid, m, ex) {
  // 权限:发送者须持 coordinator / human 角色(所有执行器统一)。
  let members = [];
  try {
    members = await api(ex.key, "GET", `/groups/${gid}/members`);
  } catch (e) {
    log("warn", `成员查询失败: ${e}`);
    return;
  }
  const sender = members.find((x) => x.agentId === m.senderId);
  const roles = sender?.roles ?? [];
  if (!roles.some((r) => EXEC_ALLOWED_ROLES.includes(r))) {
    log("info", `发送者角色 [${roles.join(",")}] 无权限发布任务,拒绝`);
    await reply(
      ex.key,
      gid,
      "⛔ 无权限发布任务(需要 coordinator 或 human 角色)",
    );
    return;
  }
  // T35 spawn 前登记任务行(message_id 幂等,同消息不重复建任务)。
  const serverTask = await createServerTask(gid, m, ex);
  if (!serverTask) {
    await reply(ex.key, gid, `❌ [${ex.label}] 任务登记失败,未入队`);
    return;
  }
  enqueueTask(gid, m, ex, serverTask);
}

function enqueueTask(gid, m, ex, serverTask) {
  const summary = m.body.replace(/\s+/g, " ").slice(0, 40);
  queue.push({
    gid,
    message: m,
    summary,
    executorKey: ex.key,
    label: ex.label,
    taskId: serverTask?.id ?? null,
  });
  const ahead = (runningTask ? 1 : 0) + queue.length - 1;
  log("info", `任务入队[${ex.label}](前面还有 ${ahead} 个): ${summary}`);
  if (ahead > 0) {
    // 只有真正排队才回传 📋;走状态链,保证它先于后续 🚀 送达。
    enqueueStatus(
      gid,
      `📋 [${ex.label}] 任务已排队(前面还有 ${ahead} 个): ${summary}`,
      ex.key,
    );
  }
  pumpQueue();
}

function buildTicket(body, label) {
  return [
    `# CoAgentHub 任务(网页 @executor 发布)`,
    ``,
    `你是 ${label}。任务:${body}`,
    `仓库:${REPO_ROOT}(分支 canary)`,
    `默认约束(除非消息里明确说明):不动 schema/迁移/scripts/ 下其他脚本、不删数据;测试全绿后提交,commit message 按功能写。`,
    `汇报:中文,做了什么/测试结果/commit hash。`,
  ].join("\n");
}

function readLogTail(logPath, lines) {
  try {
    const text = readFileSync(logPath, "utf8").replace(ANSI_RE, "");
    const arr = text.split("\n").filter((l) => l.trim());
    return arr.slice(-lines).join("\n");
  } catch {
    return "(日志不可读)";
  }
}

/** 从内存文本取最后 N 行(去 ANSI 转义)。 */
function lastLinesOf(text, lines) {
  const clean = (text ?? "").replace(ANSI_RE, "").trim();
  const arr = clean.split("\n").filter((l) => l.trim());
  return arr.slice(-lines).join("\n");
}

function findCommitHash(logText) {
  const full = logText.match(/[0-9a-f]{40}/);
  if (full) return full[0].slice(0, 12);
  const short = logText.match(/(?:commit|hash)\s*[:：]?\s*([0-9a-f]{7,12})/i);
  return short ? short[1] : null;
}

function extractSummary(tail) {
  const lines = tail.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/汇报|做了什么|测试结果|commit/.test(lines[i])) {
      start = i;
      break;
    }
  }
  const slice = start >= 0 ? lines.slice(start) : lines.slice(-15);
  let text = slice.join("\n").trim();
  if (text.length > 2000) text = text.slice(0, 2000) + "\n…(截断)";
  return text;
}

function pumpQueue() {
  if (runningTask) return;
  const task = queue.shift();
  if (!task) return;
  const ex = EXECUTORS.find((e) => e.key === task.executorKey) ?? {
    key: task.executorKey,
    bin: ATOMCODE_BIN,
    label: task.label,
  };
  task.executor = ex;
  runningTask = task;
  task.cancelled = false;
  const ts = Date.now();
  const ticketPath = `/tmp/coagenthub-ticket-${ts}.md`;
  const logPath = `/tmp/coagenthub-task-${ts}.log`;
  try {
    writeFileSync(ticketPath, buildTicket(task.message.body, ex.label));
  } catch (e) {
    log("error", `任务书写入失败: ${e}`);
    // T35 任务行已登记为 running,须回传 failed,避免留下幽灵 running 任务。
    if (task.taskId) {
      void patchTask(task.gid, task.taskId, { status: "failed" }, ex.key);
    }
    runningTask = null;
    void pumpQueue();
    return;
  }
  // T3 执行前 checkpoint 快照:失败则中止任务,不做无回滚保护的执行。
  try {
    task.checkpoint = createCheckpoint(task.message.id);
  } catch (e) {
    log("error", `[${ex.label}] 执行前快照失败,任务中止: ${e}`);
    enqueueStatus(
      task.gid,
      `❌ [${ex.label}] 任务失败: 执行前快照失败 (${e})`,
      ex.key,
    );
    if (task.taskId) {
      void patchTask(task.gid, task.taskId, { status: "failed" }, ex.key);
    }
    runningTask = null;
    void pumpQueue();
    return;
  }
  // T35 checkpoint ref 写入 server 任务行(回滚时从 server 读)。
  if (task.taskId) {
    void patchTask(
      task.gid,
      task.taskId,
      { checkpointRef: task.checkpoint.ref },
      ex.key,
    );
  }
  enqueueStatus(task.gid, `🚀 [${ex.label}] 开始执行:${task.summary}`, ex.key);
  log(
    "info",
    `[${ex.label}] 开始执行任务: ${task.summary} (ticket=${ticketPath})`,
  );

  let child;
  let childOutput = ""; // 内存尾部备份(失败回传兜底,防日志文件写入失败)
  const CHILD_OUTPUT_MAX = 512 * 1024;
  try {
    // createWriteStream 的 fd 异步打开(创建时 fd=null),不能直接作为 stdio;
    // 改用 pipe 手动接管 stdout/stderr:边收边写日志文件,并保留内存尾部。
    // 每个执行器用自己的参数模板(executors.json 的 args,{ticket} = 任务书路径);
    // args 缺失/为空时回退旧模板(直接内联任务书内容)。
    const exArgs =
      Array.isArray(ex.args) && ex.args.length > 0
        ? ex.args.map((a) => a.replaceAll("{ticket}", ticketPath))
        : ["-y", "-p", readFileSync(ticketPath, "utf8")];
    child = spawn(ex.bin, exArgs, {
      cwd: REPO_ROOT,
      detached: true, // 独立进程组,停止时可整体 kill
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (chunk) => {
      const text = chunk.toString();
      if (childOutput.length < CHILD_OUTPUT_MAX) {
        childOutput += text.slice(0, CHILD_OUTPUT_MAX - childOutput.length);
      }
      try {
        appendFileSync(logPath, text);
      } catch {
        /* 日志写失败不阻塞 */
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
  } catch (e) {
    log("error", `[${ex.label}] 执行器启动失败: ${e}`);
    enqueueStatus(
      task.gid,
      `❌ [${ex.label}] 任务失败: 无法启动 ${ex.bin} (${e})`,
      ex.key,
    );
    runningTask = null;
    void pumpQueue();
    return;
  }
  task.child = child;
  child.on("error", (e) => {
    log("error", `[${ex.label}] 进程错误: ${e}`);
    enqueueStatus(
      task.gid,
      `❌ [${ex.label}] 任务失败: 无法启动 ${ex.bin} (${e})`,
      ex.key,
    );
    // spawn 失败时 close 事件不保证触发,这里直接回传 failed。
    if (task.taskId) {
      void patchTask(task.gid, task.taskId, { status: "failed" }, ex.key);
    }
    runningTask = null;
    void pumpQueue();
  });
  child.on("close", (code) => {
    if (task.cancelled) {
      log("info", `[${ex.label}] 任务已被取消(不再回传失败): ${task.summary}`);
      // T35「停止」→ server 任务行置 cancelled。
      if (task.taskId) {
        void patchTask(task.gid, task.taskId, { status: "cancelled" }, ex.key);
      }
    } else if (code === 0) {
      const logText = readLogTail(logPath, 5000);
      const hash = findCommitHash(logText);
      const summary = extractSummary(readLogTail(logPath, 50));
      // T3 完成回传附 diff 摘要:相对执行前快照 ref 的改动文件数/行数。
      const diffStat = task.checkpoint?.ref
        ? (gitSync(["diff", "--stat", task.checkpoint.ref]).stdout ?? "").trim()
        : "";
      // T35 状态回传 server:done + diff 摘要。
      if (task.taskId) {
        void patchTask(
          task.gid,
          task.taskId,
          { status: "done", diffSummary: { hash, diffStat, summary } },
          ex.key,
        );
      }
      const body = `✅ [${ex.label}] 任务完成${hash ? ` (commit ${hash})` : ""}${diffStat ? `\n改动: ${diffStat}` : ""}\n${summary}`;
      log(
        "info",
        `[${ex.label}] 任务完成: ${task.summary}${hash ? ` hash=${hash}` : ""}`,
      );
      enqueueStatus(task.gid, body.slice(0, 2000), ex.key);
    } else {
      // 优先内存尾部(日志文件可能写入失败),回退文件尾部。
      const memTail = lastLinesOf(childOutput, 20);
      const tail = memTail || readLogTail(logPath, 20);
      log("error", `[${ex.label}] 任务失败 exit=${code}: ${task.summary}`);
      if (task.taskId) {
        void patchTask(task.gid, task.taskId, { status: "failed" }, ex.key);
      }
      enqueueStatus(
        task.gid,
        `❌ [${ex.label}] 任务失败 (exit ${code})\n${tail.slice(0, 1500)}`,
        ex.key,
      );
    }
    runningTask = null;
    void pumpQueue();
  });
}

/* ---------------- ⑤ 停止/取消 ---------------- */

async function handleCancel(gid, m) {
  const hadWork = queue.length > 0 || !!runningTask;
  if (!hadWork) {
    log("info", "收到停止指令,但无排队/执行中任务,忽略");
    return;
  }
  const cancelledTasks = queue.splice(0, queue.length);
  const cancelled = cancelledTasks.length;
  let killed = false;
  // T35「停止」→ 排队中的任务行也置 cancelled(它们已在 server 登记为 running)。
  for (const t of cancelledTasks) {
    if (t.taskId) {
      void patchTask(t.gid, t.taskId, { status: "cancelled" }, t.executorKey);
    }
  }
  if (runningTask?.child && !runningTask.child.killed) {
    runningTask.cancelled = true;
    try {
      process.kill(-runningTask.child.pid, "SIGTERM"); // 整个进程组
      killed = true;
    } catch {
      try {
        runningTask.child.kill("SIGTERM");
        killed = true;
      } catch {
        /* 已退出 */
      }
    }
  }
  const cancelKey = runningTask?.executor?.key ?? EXECUTORS[0]?.key;
  const cancelLabel = runningTask?.executor?.label ?? "";
  log(
    "info",
    `取消指令: 清空排队 ${cancelled} 个${killed ? `, 已终止执行中的 [${cancelLabel}] 进程组` : ""}`,
  );
  await reply(
    cancelKey,
    gid,
    `🛑 已取消排队的任务(取消 ${cancelled} 个排队${killed ? ` + 1 个执行中 [${cancelLabel}]` : ""})`,
  );
}

/* ---------------- ⑥ 回滚:T3 执行前快照 + 显式回滚指令 ---------------- */

const CHECKPOINT_REF_PREFIX = "refs/coagenthub-cp/";

/** taskId(任务消息 id)转隐藏 ref;git ref 不允许的字符替换成 "-",防御异常 id。 */
function checkpointRef(taskId) {
  const safe = String(taskId ?? "")
    .replace(/[^0-9a-zA-Z._-]/g, "-")
    .replace(/^\./, "-")
    .slice(0, 120);
  return `${CHECKPOINT_REF_PREFIX}${safe || "unknown"}`;
}

/** 同步跑 git(纯 node:child_process,不引入依赖)。 */
function gitSync(args) {
  return spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

/**
 * 任务执行前打快照:git add -A → write-tree → commit-tree -p HEAD,把工作区
 * 树挂到隐藏 ref refs/coagenthub-cp/<taskId> 下,不动 HEAD/工作区(仅暂存 index)。
 * 元数据(sha/taskId/原消息 id/时间)记入 state.checkpoints 并持久化,重启桥不丢。
 * 注:不加 -q(git 2.50 的 git add 无 -q/--quiet 选项,会 exit 129)。
 */
function createCheckpoint(taskId) {
  const ref = checkpointRef(taskId);
  const add = gitSync(["add", "-A"]);
  if (add.status !== 0) {
    throw new Error(`git add -A 失败: ${(add.stderr ?? "").trim()}`);
  }
  const tree = gitSync(["write-tree"]);
  if (tree.status !== 0) {
    throw new Error(`git write-tree 失败: ${(tree.stderr ?? "").trim()}`);
  }
  const commit = gitSync([
    "commit-tree",
    tree.stdout.trim(),
    "-p",
    "HEAD",
    "-m",
    `coagenthub checkpoint ${taskId}`,
  ]);
  if (commit.status !== 0) {
    throw new Error(`git commit-tree 失败: ${(commit.stderr ?? "").trim()}`);
  }
  const sha = commit.stdout.trim();
  const upd = gitSync(["update-ref", ref, sha]);
  if (upd.status !== 0) {
    throw new Error(`git update-ref ${ref} 失败: ${(upd.stderr ?? "").trim()}`);
  }
  state.checkpoints.push({
    ref,
    sha,
    taskId: String(taskId),
    messageId: String(taskId),
    time: new Date().toISOString(),
  });
  saveState();
  log("info", `执行前快照: ${ref} → ${sha}`);
  return { ref, sha };
}

/**
 * 群指令「回滚 [taskId]」:git reset --hard 到快照 ref 恢复工作区。显式指令才
 * 触发,从不自动执行;taskId 缺省时回滚最近一次快照。taskId 即任务消息 id。
 */
async function handleRollback(gid, m, taskId) {
  const key = EXECUTORS[0]?.key ?? "hermes";
  // 回滚会 git reset --hard,与发布任务同权限门槛:须 coordinator / human 角色。
  let members = [];
  try {
    members = await api(key, "GET", `/groups/${gid}/members`);
  } catch (e) {
    log("warn", `成员查询失败: ${e}`);
    await reply(key, gid, "⛔ 成员查询失败,无法验证权限");
    return;
  }
  const sender = members.find((x) => x.agentId === m.senderId);
  const roles = sender?.roles ?? [];
  if (!roles.some((r) => EXEC_ALLOWED_ROLES.includes(r))) {
    log("info", `发送者角色 [${roles.join(",")}] 无权限回滚,拒绝`);
    await reply(key, gid, "⛔ 无权限回滚(需要 coordinator 或 human 角色)");
    return;
  }
  // 有任务在执行/排队时禁止回滚:reset --hard 会破坏进行中的写入。
  if (runningTask || queue.length > 0) {
    await reply(key, gid, "⛔ 有任务执行中或排队中,请先「停止」再回滚");
    return;
  }
  // T35「回滚 <taskId>」读取 server 任务数据(checkpoint_ref),不再依赖桥本地
  // state.checkpoints;缺省 taskId 时取该群最近一个带快照的任务。
  let ref;
  try {
    const tasks = await api(key, "GET", `/groups/${gid}/tasks`);
    if (taskId) {
      const found = tasks.find(
        (t) => t.id === taskId || t.messageId === taskId,
      );
      ref = found?.checkpointRef ?? null;
      if (!ref) {
        // 兼容:server 未登记到该任务(如登记前就已打快照)时回退旧命名约定。
        ref = checkpointRef(taskId);
      }
    } else {
      const latest = tasks.find((t) => t.checkpointRef);
      if (!latest) {
        // server 字段是 best-effort 异步回写,可能缺失;回退本地最新快照,
        // 避免「有快照却说没有」。
        const localLatest = state.checkpoints[state.checkpoints.length - 1];
        if (!localLatest) {
          await reply(key, gid, "⛔ 没有可回滚的快照(尚无任务执行过)");
          return;
        }
        ref = localLatest.ref;
      } else {
        ref = latest.checkpointRef;
      }
    }
  } catch (e) {
    log("warn", `任务数据读取失败,回退本地快照列表: ${e}`);
    if (taskId) {
      ref = checkpointRef(taskId);
    } else {
      const latest = state.checkpoints[state.checkpoints.length - 1];
      if (!latest) {
        await reply(key, gid, "⛔ 没有可回滚的快照(尚无任务执行过)");
        return;
      }
      ref = latest.ref;
    }
  }
  const verify = gitSync(["rev-parse", "--verify", ref]);
  if (verify.status !== 0) {
    await reply(key, gid, `⛔ 快照不存在: ${ref}(任务 id 可能不对)`);
    return;
  }
  const sha = verify.stdout.trim().slice(0, 12);
  const reset = gitSync(["reset", "--hard", ref]);
  if (reset.status !== 0) {
    await reply(key, gid, `❌ 回滚失败: ${(reset.stderr ?? "").trim()}`);
    return;
  }
  log("info", `回滚完成: ${ref}(${sha})`);
  await reply(key, gid, `✅ 已回滚到快照 ${ref}(${sha})`);
}

/* ---------------- webhook 接收 + 执行器管理端点(ticket 31) ---------------- */

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

/** 管理视图:配置字段 + 注册状态,不含 token 等敏感信息。 */
function executorListView() {
  return EXECUTORS.map((ex) => ({
    key: ex.key,
    agentName: ex.agentName,
    type: ex.type,
    bin: ex.bin,
    args: ex.args ?? null,
    label: ex.label,
    registered: Boolean(state.agents[ex.key]?.id),
  }));
}

/** 写回 executors.json(保留既有条目;同 key 覆盖)。 */
function saveExecutorsFile(list) {
  writeFileSync(
    EXECUTORS_FILE,
    JSON.stringify({ executors: list }, null, 2) + "\n",
  );
}

/**
 * 热重载:替换内存配置并重建派生列表(AGENT_KEYS/AGENTS),为新执行器幂等
 * 注册 agent(已注册的 key 复用既有 id+token,不重复注册)。分发逻辑遍历
 * EXECUTORS 内存数组,替换引用后新执行器立即可用;队列里已有任务带
 * executorKey/label 快照,不受影响。
 */
async function reloadExecutors(list) {
  EXECUTORS = normalizeExecutors(list);
  AGENT_KEYS = ["hermes", ...EXECUTORS.map((ex) => ex.key)];
  AGENTS = [
    { key: "hermes", name: "Hermes 规划", type: "hermes" },
    ...EXECUTORS.map((ex) => ({
      key: ex.key,
      name: ex.agentName,
      type: ex.type,
    })),
  ];
  for (const ex of EXECUTORS) {
    if (!state.agents[ex.key]?.id || !state.agents[ex.key]?.token) {
      await ensureAgent({ key: ex.key, name: ex.agentName, type: ex.type });
    }
  }
  log("info", `执行器已更新: ${EXECUTORS.length} 个`);
}

const EXECUTOR_KEY_RE = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_EXECUTOR_ARGS = ["-y", "-p", "{ticket}"];

/** bin 不在 PATH 时提示但不阻止(可能稍后才安装)。 */
function binWarning(bin) {
  try {
    const r = spawnSync("which", [bin], { encoding: "utf8" });
    if (r.status !== 0) {
      return `命令 ${bin} 当前不在 PATH 中(已保存,安装后即可用)`;
    }
  } catch {
    /* which 不可用时静默 */
  }
  return null;
}

async function handleWebhook(req, res) {
  const raw = await readBody(req).catch(() => "");
  res.writeHead(200);
  res.end("ok");
  try {
    const payload = JSON.parse(raw);
    // T13 负载 {type, groupId, message:{...}};兼容旧扁平负载。
    const m = payload.message ?? payload;
    const gid = payload.groupId ?? m.groupId ?? "";
    if (!gid || payload.type !== "group_message") return;
    log(
      "info",
      `webhook 收到 type=${payload.type} groupId=${gid.slice(0, 8)} messageId=${(m.id ?? "").slice(0, 8)}`,
    );
    void enqueueGroup(gid);
  } catch (e) {
    log("warn", `webhook 解析失败: ${e}`);
  }
}

/** POST /executors:添加或更新执行器(同 key 覆盖),热重载后立即生效。 */
async function handleUpsertExecutor(req, res) {
  const raw = await readBody(req).catch(() => "");
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJson(res, 400, { message: "JSON body 解析失败" });
  }
  const key = String(body.key ?? "").trim();
  if (!key || !EXECUTOR_KEY_RE.test(key)) {
    return sendJson(res, 400, {
      message: "key 必填,且只能包含字母/数字/_/-",
    });
  }
  const bin = String(body.bin ?? "").trim();
  if (!bin) {
    return sendJson(res, 400, { message: "bin 必填" });
  }
  if (body.args !== undefined && !Array.isArray(body.args)) {
    return sendJson(res, 400, { message: "args 必须是字符串数组" });
  }
  const entry = {
    key,
    label: body.label !== undefined ? String(body.label) : key,
    bin,
    agentName:
      body.agentName !== undefined ? String(body.agentName) : `${key}-bridge`,
    type: body.type !== undefined ? String(body.type) : "agent",
    args:
      Array.isArray(body.args) && body.args.length > 0
        ? body.args.map(String)
        : DEFAULT_EXECUTOR_ARGS,
  };
  const list = EXECUTORS.filter((e) => e.key !== key).concat([entry]);
  const warnings = [];
  const warn = binWarning(bin);
  if (warn) warnings.push(warn);
  try {
    saveExecutorsFile(list);
  } catch (e) {
    return sendJson(res, 500, { message: `executors.json 写入失败: ${e}` });
  }
  await reloadExecutors(list);
  log(
    "info",
    `管理 API: 添加/更新执行器 ${key}(label=${entry.label}, bin=${bin})`,
  );
  const payload = { executors: executorListView() };
  if (warnings.length > 0) payload.warning = warnings.join("; ");
  return sendJson(res, 200, payload);
}

/** DELETE /executors/:key:移除配置并热重载;已注册 agent 保留在 CoAgentHub(不注销)。 */
async function handleDeleteExecutor(req, res, key) {
  if (!EXECUTOR_KEY_RE.test(key)) {
    return sendJson(res, 400, { message: "key 只能包含字母/数字/_/-" });
  }
  if (!EXECUTORS.some((e) => e.key === key)) {
    return sendJson(res, 404, { message: `执行器 ${key} 不存在` });
  }
  const list = EXECUTORS.filter((e) => e.key !== key);
  try {
    saveExecutorsFile(list);
  } catch (e) {
    return sendJson(res, 500, { message: `executors.json 写入失败: ${e}` });
  }
  await reloadExecutors(list);
  log("info", `管理 API: 删除执行器 ${key}(agent 保留注册,不再调度)`);
  return sendJson(res, 200, { executors: executorListView() });
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (req.method === "POST" && path === "/hook") {
        await handleWebhook(req, res);
        return;
      }
      if (path === "/executors") {
        if (req.method === "GET") {
          sendJson(res, 200, { executors: executorListView() });
          return;
        }
        if (req.method === "POST") {
          await handleUpsertExecutor(req, res);
          return;
        }
      }
      const delMatch = path.match(/^\/executors\/([^/]+)$/);
      if (delMatch && req.method === "DELETE") {
        await handleDeleteExecutor(req, res, decodeURIComponent(delMatch[1]));
        return;
      }
      sendJson(res, 405, { message: "method not allowed" });
    } catch (e) {
      log("error", `HTTP 处理异常: ${e}`);
      sendJson(res, 500, { message: `内部错误: ${e}` });
    }
  })();
});

/* ---------------- 启动 ---------------- */

async function main() {
  loadState();
  migrateLegacyExecutorState();
  log("info", "CoAgentHub 任务执行桥启动");
  console.log(`🚀 CoAgentHub 任务执行桥 (ticket 30: configurable executors)`);
  for (const cfg of AGENTS) {
    await ensureAgent(cfg);
  }
  console.log(`    hermes agent id:   ${state.agents.hermes?.id ?? "-"}`);
  for (const ex of EXECUTORS) {
    console.log(
      `    ${ex.label.padEnd(10)} agent id: ${state.agents[ex.key]?.id ?? "-"} (${ex.agentName}, bin=${ex.bin})`,
    );
  }
  console.log(`    仓库: ${REPO_ROOT}`);
  console.log(`    状态文件: ${STATE_FILE}`);
  console.log(`    日志文件: ${LOG_FILE}`);
  server.listen(HOOK_PORT, "0.0.0.0", () => {
    console.log(`    监听 :${HOOK_PORT}/hook (API_BASE=${API_BASE})`);
    log("info", `监听 :${HOOK_PORT}/hook`);
  });
}

main().catch((e) => {
  log("error", `启动失败: ${e}`);
  process.exit(1);
});
