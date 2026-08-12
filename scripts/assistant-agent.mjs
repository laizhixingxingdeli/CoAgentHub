#!/usr/bin/env node
/**
 * CoAgentHub 助手 agent — 一个零依赖的应答器。
 *
 * 行为:
 *   1. 幂等注册自己(身份保存在 .assistant-state.json,与桥同款)。
 *   2. 轮询所有已加入群组的消息(?after= 增量游标)。
 *   3. 对「定向发给本 agent」的消息,用 DeepSeek API 生成回复,以 parentId
 *      挂在原消息下、audience=agent 回给发送者。
 *
 * 环境变量:
 *   API_BASE        默认 http://localhost:3001/api
 *   AGENT_NAME      默认 "CoAgentHub 助手"
 *   DEEPSEEK_API_KEY 设置后启用真实 AI 回复;未设置时回固定模板。
 *   POLL_MS         默认 5000
 *   --once          处理一轮即退出(便于测试/接入其他调度)。
 *
 * 用法:
 *   node scripts/assistant-agent.mjs            # 常驻轮询
 *   node scripts/assistant-agent.mjs --once     # 处理一轮
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = resolve(SCRIPT_DIR, ".assistant-state.json");
const API_BASE = (process.env.API_BASE ?? "http://localhost:3001/api").replace(
  /\/+$/,
  "",
);
const AGENT_NAME = process.env.AGENT_NAME ?? "CoAgentHub 助手";
const POLL_MS = Number(process.env.POLL_MS ?? 5000);
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

const state = { agent: null, cursors: {} };
if (existsSync(STATE_FILE)) {
  Object.assign(state, JSON.parse(readFileSync(STATE_FILE, "utf8")));
}

function saveState() {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function api(method, path, token, body) {
  const res = await fetch(`${API_BASE}${path}`, {
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
  const mine = existing.find((a) => a.name === AGENT_NAME);
  if (mine) {
    throw new Error(
      `agent "${AGENT_NAME}" 已存在(id=${mine.id})但没有本地 token,无法认领。` +
        "删除该 agent 或用 reset-token 接口换新 token 后重试。",
    );
  }
  const created = await api("POST", "/agents", null, {
    name: AGENT_NAME,
    type: "custom",
    device: "mac",
  });
  state.agent = { id: created.id, token: created.token };
  saveState();
  console.log(`[assistant] 已注册 ${AGENT_NAME}: ${created.id}`);
  return state.agent;
}

async function deepseekReply(question) {
  if (!DEEPSEEK_API_KEY) {
    return `(模板回复)收到你的消息:「${question.slice(0, 60)}」。设置 DEEPSEEK_API_KEY 后可获得真实 AI 回复。`;
  }
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content:
            "你是 CoAgentHub 的助手 agent。用简洁中文回答,不要编造事实。",
        },
        { role: "user", content: question },
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

async function processGroup(group) {
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
  for (const m of messages) {
    state.cursors[group.id] = m.id;
    const directed = m.audience === "agent" && m.audienceRef === state.agent.id;
    if (!directed || m.senderId === state.agent.id) continue;

    const reply = await deepseekReply(m.body);
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
  console.log(`[assistant] ${AGENT_NAME} 开始轮询 (${API_BASE}, ${POLL_MS}ms)`);
  for (;;) {
    try {
      await runOnce();
    } catch (err) {
      console.warn("[assistant] 轮询错误:", err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
