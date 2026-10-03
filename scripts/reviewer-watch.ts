/** 显式启动的守候客户端；不创建定时任务，不读取状态或凭据文件。 */
const [projectId, owner] = process.argv.slice(2);
if (!projectId || !owner) {
  console.error('用法：node scripts/reviewer-watch.ts <projectId> <会话ID>；COAGENT_BASE 可选，默认本机3101');
  process.exitCode = 1;
} else {
  const base = process.env.COAGENT_BASE ?? 'http://127.0.0.1:3101';
  let generation = 0;
  let stopped = false;
  process.once('SIGINT', () => { stopped = true; });
  process.once('SIGTERM', () => { stopped = true; });
  async function request(path: string, body?: unknown) {
    const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(35000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
  }
  const dutyPath = `/api/projects/${encodeURIComponent(projectId)}/reviewer-duty`;
  try {
    const duty = await request(dutyPath, { action: 'claim', owner });
    generation = duty.generation;
    let renewedAt = Date.now();
    let cursor;
    while (!stopped) {
      if (Date.now() - renewedAt >= 60000) {
        await request(dutyPath, { action: 'renew', owner, generation }); renewedAt = Date.now();
      }
      const query = new URLSearchParams({ projectId, owner, generation: String(generation), waitMs: '25000', ...(cursor ? { cursor } : {}) });
      const result = await request(`/api/reviewer/wait?${query}`);
      cursor = result.cursor;
      if (result.changed && result.todos.length) console.log(JSON.stringify({ kind: 'reviewer_todos', todos: result.todos }));
    }
  } catch (error) { console.error(error instanceof Error ? error.message : '守候失败'); process.exitCode = 1; }
  finally {
    if (generation) await request(dutyPath, { action: 'release', owner, generation }).catch(() => undefined);
  }
}
