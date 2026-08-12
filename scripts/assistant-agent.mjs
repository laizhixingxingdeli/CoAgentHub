#!/usr/bin/env node
/**
 * CoAgentHub 助手 agent — 一个零依赖的应答器。
 *
 * 行为:
 *   1. 幂等注册自己(身份保存在 .assistant-state.json,与桥同款)。
 *   2. 轮询所有已加入群组的消息(?after= 增量游标)。
 *   3. 对「定向发给本 agent」的消息,用 DeepSeek API 生成回复,以 parentId
 *      挂在原消息下、audience=agent 回给发送者。
 *   4. 按群维护会话记忆(两层:滚动摘要 + 最近窗口),让同一群内的连续
 *      提问能引用前文;不同群的记忆互相隔离;执行器保持无状态不变。
 *
 * 会话记忆:
 *   - 每个群一个 session = { summary: string, recent: MessageItem[] }。
 *     应答 prompt = 系统提示 + 「群摘要」+「最近 N 条消息」+ 当前问题。
 *   - 只记「对助手可见」的消息(定向给它的 agent 消息 + broadcast),
 *     自己发出的消息不入记忆。
 *   - 预算触发压缩:估算 token(字符数/4 近似);当「摘要+最近窗口」超过
 *     MAX_CONTEXT_TOKENS,或窗口超过 WINDOW_MESSAGES 条时,取窗口最老
 *     一半,用 DeepSeek 把「旧摘要 + 这批消息」合并成一段新摘要,窗口
 *     只留最近一半(无 API key 或合并失败时退化为文本拼接,摘要仍非空)。
 *   - 会话状态随 .assistant-state.json 持久化,重启后记忆仍在。
 *
 * 环境变量:
 *   API_BASE          默认 http://localhost:3001/api
 *   AGENT_NAME        默认 "CoAgentHub 助手"
 *   DEEPSEEK_API_KEY  设置后启用真实 AI 回复;未设置时回固定模板。
 *   POLL_MS           默认 5000
 *   MAX_CONTEXT_TOKENS  摘要+窗口的总 token 预算(字符数/4 近似),默认 6000
 *   WINDOW_MESSAGES   最近窗口消息条数上限,默认 40
 *   MEMORY            默认 "per-group"(按群记忆);设 "none" 回到无记忆
 *   ASSISTANT_STATE_FILE  状态文件路径覆盖(测试/多实例用),默认 scripts/.assistant-state.json
 *   --once            处理一轮即退出(便于测试/接入其他调度)。
 *
 * 用法:
 *   node scripts/assistant-agent.mjs            # 常驻轮询
 *   node scripts/assistant-agent.mjs --once     # 处理一轮
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// 配置统一延迟读取,便于测试按用例切换环境变量。
const getApiBase = () =>
  (process.env.API_BASE ?? "http://localhost:3001/api").replace(/\/+$/, "");
const getAgentName = () => process.env.AGENT_NAME ?? "CoAgentHub 助手";
const getPollMs = () => Number(process.env.POLL_MS ?? 5000);
const getDeepseekKey = () => process.env.DEEPSEEK_API_KEY;
/** 正整数环境变量:非数字/非正数时回退默认值,避免 NaN 静默禁用压缩。 */
function positiveEnvInt(name, fallback) {
  const n = Number(process.env[name] ?? fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const getMaxContextTokens = () => positiveEnvInt("MAX_CONTEXT_TOKENS", 6000);
const getWindowMessages = () => positiveEnvInt("WINDOW_MESSAGES", 40);
const getMemoryMode = () => process.env.MEMORY ?? "per-group";
const getStateFile = () =>
  process.env.ASSISTANT_STATE_FILE ??
  resolve(SCRIPT_DIR, ".assistant-state.json");

function freshState() {
  return { agent: null, cursors: {}, sessions: {} };
}

export function loadState() {
  const file = getStateFile();
  const loaded = freshState();
  if (existsSync(file)) {
    Object.assign(loaded, JSON.parse(readFileSync(file, "utf8")));
  }
  loaded.sessions ??= {};
  return loaded;
}

const state = loadState();

export function getState() {
  return state;
}

/** 从磁盘重新加载状态(等价于进程重启后读到文件内容)。 */
export function reloadState() {
  Object.assign(state, loadState());
  return state;
}

export function saveState() {
  writeFileSync(getStateFile(), JSON.stringify(state, null, 2));
}

async function api(method, path, token, body) {
  const res = await fetch(`${getApiBase()}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function ensureAgent() {
  if (state.agent?.token) {
    return state.agent;
  }
  const existing = await api("GET", "/agents");
  const mine = existing.find((a) => a.name === getAgentName());
  if (mine) {
    throw new Error(
      `agent "${getAgentName()}" 已存在(id=${mine.id})但没有本地 token,无法认领。` +
        "删除该 agent 或用 reset-token 接口换新 token 后重试。",
    );
  }
  const created = await api("POST", "/agents", null, {
    name: getAgentName(),
    type: "custom",
    device: "mac",
  });
  state.agent = { id: created.id, token: created.token };
  saveState();
  console.log(`[assistant] 已注册 ${getAgentName()}: ${created.id}`);
  return state.agent;
}

/** token 近似估算:按 spec 用字符数/4 粗估(中文实际 token 更密,会略低估)。 */
export function estimateTokens(text) {
  return Math.ceil((text ?? "").length / 4);
}

/** 只记「对助手可见」的消息:定向给它的 agent 消息 + broadcast;自己的不入记忆。 */
export function isVisibleToAssistant(message, agentId) {
  if (message.senderId === agentId) return false;
  return (
    message.audience === "broadcast" ||
    (message.audience === "agent" && message.audienceRef === agentId)
  );
}

/** 裁剪入库的消息字段,避免把无关字段带进长期状态文件。 */
export function pickMessage(message) {
  return {
    id: message.id,
    senderId: message.senderId,
    body: message.body,
    audience: message.audience,
    audienceRef: message.audienceRef,
    createdAt: message.createdAt,
  };
}

/** 最近窗口的 prompt 文本表示。 */
export function recentToText(recent) {
  return recent.map((m) => `- ${m.senderId.slice(0, 8)}: ${m.body}`).join("\n");
}

function sessionTokenEstimate(session) {
  return (
    estimateTokens(session.summary) +
    estimateTokens(recentToText(session.recent))
  );
}

/** 无 API key / 合并失败时的退化摘要:保住已积累的旧摘要(头部),
 *  只截断新增文本,保证非空且总量有界。 */
export function fallbackSummary(oldSummary, lines) {
  const combined = [oldSummary?.trim(), lines].filter(Boolean).join("\n");
  return combined.slice(0, 3000) || "(空)";
}

/** 用 DeepSeek 把「旧摘要 + 一批消息」合并成一段新摘要。 */
export async function mergeSummary(groupId, oldSummary, dropped) {
  const lines = recentToText(dropped);
  if (!getDeepseekKey()) {
    return fallbackSummary(oldSummary, lines);
  }
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getDeepseekKey()}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content:
              "你是 CoAgentHub 的助手 agent,负责维护群会话的滚动摘要。把「已有摘要」与「新的一批群消息」合并为一段更精炼、更完整的摘要:保留任务进展、决定、约定与重要事实,省略寒暄和无关细节。直接输出新的摘要正文,不要任何前缀、后缀或解释。",
          },
          {
            role: "user",
            content: `【已有摘要】\n${oldSummary?.trim() || "(空)"}\n\n【新消息】\n${lines}`,
          },
        ],
        max_tokens: 500,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `deepseek ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || fallbackSummary(oldSummary, lines);
  } catch (err) {
    console.warn(
      `[assistant] 群 ${groupId} 摘要合并失败,回退文本拼接:`,
      err.message,
    );
    return fallbackSummary(oldSummary, lines);
  }
}

/** 压缩一步:取窗口最老一半合并进摘要,窗口只留最近一半。 */
export async function compressSession(groupId, session) {
  const half = Math.ceil(session.recent.length / 2);
  const dropped = session.recent.slice(0, half);
  const kept = session.recent.slice(half);
  session.summary = await mergeSummary(groupId, session.summary, dropped);
  session.recent = kept;
}

/** 裁剪 + 预算压缩:窗口超 WINDOW_MESSAGES 或「摘要+窗口」超预算时滚动压缩。 */
export async function trimAndCompress(groupId, session) {
  while (session.recent.length > getWindowMessages()) {
    await compressSession(groupId, session);
  }
  let guard = 0;
  while (
    session.recent.length > 1 &&
    sessionTokenEstimate(session) > getMaxContextTokens() &&
    guard < 5
  ) {
    await compressSession(groupId, session);
    guard += 1;
  }
}

function getSession(groupId) {
  state.sessions[groupId] ??= { summary: "", recent: [] };
  return state.sessions[groupId];
}

async function deepseekReply(question, context) {
  if (!getDeepseekKey()) {
    return `(模板回复)收到你的消息:「${question.slice(0, 60)}」。设置 DEEPSEEK_API_KEY 后可获得真实 AI 回复。`;
  }
  const content = context
    ? [
        "【群会话摘要】",
        context.summary?.trim() || "(暂无)",
        "",
        "【最近对话】",
        recentToText(context.recent),
        "",
        "【当前问题】",
        question,
      ].join("\n")
    : question;
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getDeepseekKey()}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content:
            "你是 CoAgentHub 的助手 agent。用简洁中文回答,不要编造事实。",
        },
        { role: "user", content },
      ],
      max_tokens: 300,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `deepseek ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "(无回复)";
}

export async function processGroup(group) {
  const token = state.agent.token;
  const members = await api("GET", `/groups/${group.id}/members`, token);
  const me = members.find((m) => m.agentId === state.agent.id);
  if (!me) return; // 还没被拉进这个群

  const after = state.cursors[group.id] ?? "";
  const query = after ? `?after=${after}` : "";
  const messages = await api(
    "GET",
    `/groups/${group.id}/messages${query}`,
    token,
  );

  // 处理顺序:拉新消息 → 追加可见消息到 recent(裁剪/压缩)→ 对定向消息生成回复。
  const memoryOn = getMemoryMode() === "per-group";
  const session = memoryOn ? getSession(group.id) : null;
  const directed = [];
  for (const m of messages) {
    state.cursors[group.id] = m.id;
    const isDirected =
      m.audience === "agent" &&
      m.audienceRef === state.agent.id &&
      m.senderId !== state.agent.id;
    if (isDirected) directed.push(m);
    if (session && isVisibleToAssistant(m, state.agent.id)) {
      session.recent.push(pickMessage(m));
    }
  }
  if (session) {
    await trimAndCompress(group.id, session);
  }
  for (const m of directed) {
    const context = session
      ? { summary: session.summary, recent: session.recent }
      : null;
    const reply = await deepseekReply(m.body, context);
    await api("POST", `/groups/${group.id}/messages`, token, {
      body: reply,
      parentId: m.id,
      audience: "agent",
      audienceRef: m.senderId,
    });
    console.log(
      `[assistant] 已回复 ${group.id} 中来自 ${m.senderId.slice(0, 8)} 的消息`,
    );
  }
}

async function runOnce() {
  const agent = await ensureAgent();
  const groups = await api("GET", "/groups?status=active", agent.token);
  for (const g of groups) {
    try {
      await processGroup(g);
    } catch (err) {
      console.warn(`[assistant] 群 ${g.id} 处理失败:`, err.message);
    }
  }
  saveState();
}

async function main() {
  if (process.argv.includes("--once")) {
    await runOnce();
    return;
  }
  console.log(
    `[assistant] ${getAgentName()} 开始轮询 (${getApiBase()}, ${getPollMs()}ms)`,
  );
  for (;;) {
    try {
      await runOnce();
    } catch (err) {
      console.warn("[assistant] 轮询错误:", err.message);
    }
    await new Promise((r) => setTimeout(r, getPollMs()));
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
