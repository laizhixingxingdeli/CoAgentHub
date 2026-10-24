#!/usr/bin/env node
// 从运行中的平台读一个 Mission 的事实指标（只读 HTTP，不读状态文件）。
// 用法：node collect.mjs <missionId> [--base http://127.0.0.1:3101]
// 控制面开了鉴权时，把令牌放进环境变量 COAGENT_TOKEN。

const missionId = process.argv[2];
if (!missionId) {
  console.error('用法：node collect.mjs <missionId> [--base http://127.0.0.1:3101]');
  process.exit(2);
}
const baseIndex = process.argv.indexOf('--base');
const base = baseIndex > 0 ? process.argv[baseIndex + 1] : 'http://127.0.0.1:3101';
const headers = process.env.COAGENT_TOKEN ? { Authorization: `Bearer ${process.env.COAGENT_TOKEN}` } : {};

async function get(path) {
  let response;
  try {
    response = await fetch(`${base}${path}`, { headers });
  } catch {
    console.error(`连不上平台 ${base}：先用 node scripts/coagent.mjs start 启动服务。`);
    process.exit(1);
  }
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return response.json();
}

const enc = encodeURIComponent(missionId);
const mission = await get(`/api/missions/${enc}`);
const activity = await get(`/api/missions/${enc}/activity`).catch(() => []);
const usage = await get(`/api/usage?missionId=${enc}`).catch(() => undefined);

const times = (Array.isArray(activity) ? activity : []).map((e) => Date.parse(e.at)).filter(Number.isFinite);
const first = times.length ? Math.min(...times) : undefined;
const last = times.length ? Math.max(...times) : undefined;
const workItems = mission.workItems ?? [];
const executorAttempts = workItems.reduce((sum, w) => sum + (w.attempts ?? 0), 0);
const coordinatorAttempts = (mission.coordinatorAttemptIds ?? []).length;
const rejects = (Array.isArray(activity) ? activity : []).filter((e) => /review/.test(e.kind ?? '') && e.data?.verdict === 'reject').length;

const summary = {
  missionId,
  status: mission.status,
  coordinationMode: mission.coordinationMode,
  executionMode: mission.executionMode,
  firstEventAt: first ? new Date(first).toISOString() : null,
  lastEventAt: last ? new Date(last).toISOString() : null,
  wallMinutes: first && last ? Math.round(((last - first) / 60000) * 10) / 10 : null,
  occupiedMinutes:
    mission.timeAttribution?.totalOccupiedMs == null ? null : Math.round((mission.timeAttribution.totalOccupiedMs / 60000) * 10) / 10,
  timeCoverage: mission.timeAttribution?.coverage ?? null,
  workItems: workItems.length,
  executorAttempts,
  coordinatorAttempts,
  modelSessions: executorAttempts + coordinatorAttempts,
  workItemRejects: rejects,
  escalations: mission.escalations ?? null,
  platformUsage: usage?.total ?? null,
  platformUsageByRole: usage?.byRole ?? null,
  note:
    mission.coordinationMode === 'direct'
      ? 'direct 模式下主控会话的用量平台看不到，请在主控会话里另记（Claude Code 用 /cost，Codex 用 /status）。'
      : '协调者与执行者的用量都在 platformUsage 里；检视者会话的用量另记。',
};
console.log(JSON.stringify(summary, null, 2));
