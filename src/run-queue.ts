/** Mission 清单只是提交输入；全部状态与调度由持锁服务中的 Mission 承载。 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    console.log('node src/run-queue.ts <missions.json> --confirmed-by "真实确认原文" [--service-url http://127.0.0.1:3101] [--check]\n输入：{projectId, config?, missions:[{missionId,contract?,dependsOn?}]}。--check 只预览，不提交、不读主状态文件。');
    return;
  }
  const input = JSON.parse(readFileSync(resolve(args[0]), 'utf8'));
  if (typeof input.projectId !== 'string' || !input.projectId.trim() || !Array.isArray(input.missions) || input.missions.length === 0) throw new Error('必须提供 projectId 和非空 missions 列表');
  if (args.includes('--check')) {
    console.log(JSON.stringify({ projectId: input.projectId, missions: input.missions.map((row: { missionId: string; dependsOn?: string[] }) => ({ missionId: row.missionId, dependsOn: row.dependsOn ?? [] })), submitted: false }, null, 2));
    return;
  }
  const confirmedBy = args[args.indexOf('--confirmed-by') + 1];
  if (!args.includes('--confirmed-by') || !confirmedBy || confirmedBy.startsWith('--')) throw new Error('提交前必须给 --confirmed-by，使用真实确认原文');
  const urlIndex = args.indexOf('--service-url');
  const url = new URL(urlIndex < 0 ? 'http://127.0.0.1:3101' : args[urlIndex + 1]);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('只接受无凭据的本机 HTTP 服务地址');
  const endpoint = new URL(`/api/projects/${encodeURIComponent(input.projectId)}/mission-queue`, url);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const [flag, header] of [['--reviewer', 'x-coagent-reviewer'], ['--generation', 'x-coagent-reviewer-generation']]) {
    const index = args.indexOf(flag);
    if (index >= 0) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${flag} 必须有值`);
      headers[header] = args[index + 1];
    }
  }
  const current = await fetch(endpoint, { signal: AbortSignal.timeout(10_000) });
  if (!current.ok) throw new Error(`读取项目队列失败：HTTP ${current.status}`);
  const queue = await current.json();
  const response = await fetch(endpoint, { method: 'POST', headers,
    body: JSON.stringify({ expectedRevision: queue.revision, confirmedBy, config: input.config, missions: input.missions }), signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${result.error ?? 'QUEUE_SUBMIT_FAILED'}：${result.message ?? response.status}`);
  console.log(JSON.stringify({ projectId: result.projectId, revision: result.revision, missions: result.entries.map((row: { missionId: string }) => row.missionId) }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
