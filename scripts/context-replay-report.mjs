#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const ERROR = 'CONTEXT_REPLAY_INPUT_ERROR';
const safeError = () => { console.error(ERROR); process.exitCode = 2; };
const fields = ['input', 'output', 'cacheRead', 'cacheWrite'];
const labels = new Set(['E1', 'main']);

function validUsage(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && value.quality === 'reported'
    && fields.every((key) => Number.isInteger(value[key]) && value[key] >= 0);
}

function collect(state, label, groups) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1 || !Array.isArray(state.projects)) throw new Error('invalid');
  const add = (attempt, pathRole, missionId) => {
    if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt) || !['coordinator', 'executor'].includes(attempt.kind) || attempt.kind !== pathRole || typeof missionId !== 'string') return;
    const role = attempt.kind;
    const key = JSON.stringify([label, missionId, role]);
    let row = groups.get(key);
    if (!row) {
      row = { sourceLabel: label, missionId, role, attemptsTotal: 0, usageReportedCount: 0, usageUnknownCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      groups.set(key, row);
    }
    row.attemptsTotal++;
    if (!validUsage(attempt.usage)) { row.usageUnknownCount++; return; }
    row.usageReportedCount++;
    for (const field of fields) row[field] += attempt.usage[field];
  };
  for (const project of state.projects) {
    if (!project || typeof project !== 'object' || !Array.isArray(project.missions)) continue;
    for (const mission of project.missions) {
      if (!mission || typeof mission !== 'object' || typeof mission.id !== 'string') continue;
      if (Array.isArray(mission.coordinatorAttempts)) for (const attempt of mission.coordinatorAttempts) add(attempt, 'coordinator', mission.id);
      if (Array.isArray(mission.workItems)) for (const item of mission.workItems) {
        if (item && typeof item === 'object' && Array.isArray(item.attempts)) for (const attempt of item.attempts) add(attempt, 'executor', mission.id);
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2), inputs = [];
  let report;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1] && args[i + 2] && !args[i + 2].startsWith('--')) { inputs.push([args[i + 1], args[i + 2]]); i += 2; }
    else if (args[i] === '--report' && args[i + 1]) report = args[++i];
    else { safeError(); return; }
  }
  if (!inputs.length || inputs.some(([label]) => !labels.has(label))) { safeError(); return; }
  try {
    const groups = new Map();
    for (const [label, path] of inputs) collect(JSON.parse((await readFile(path)).toString('utf8')), label, groups);
    const text = `${JSON.stringify([...groups.values()], null, 2)}\n`;
    if (report) await writeFile(report, text, { flag: 'w' });
    process.stdout.write(text);
  } catch { safeError(); }
}
await main();
