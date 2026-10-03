/** 零依赖 stdio MCP；业务与持久状态只经 HTTP，由服务保持单写者。 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

const text = { type: 'string', minLength: 1 };
const generation = { type: 'integer', minimum: 1 };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tools = [
  { name: 'coagenthub_reviewer_todos', description: '读取统一待办，不消费或 ACK Delivery', inputSchema: schema({ projectId: text }) },
  { name: 'coagenthub_reviewer_duty', description: '领取、续约、交接或释放项目值守；操作需要真实会话标识',
    inputSchema: schema({ projectId: text, owner: text, generation, nextOwner: text, action: { enum: ['claim', 'renew', 'release', 'handoff'] } }, ['projectId', 'owner', 'action']) },
  { name: 'coagenthub_reviewer_wait', description: '有界守候统一待办，交接或过期会拒绝旧会话',
    inputSchema: schema({ projectId: text, owner: text, generation, cursor: text, waitMs: { type: 'integer', minimum: 0, maximum: 25000 } }, ['projectId', 'owner', 'generation']) },
  { name: 'coagenthub_reviewer_todo_decide', description: '确认通知或等用户；确认不解除门禁，等用户会 park Mission',
    inputSchema: schema({ todoId: text, reviewer: text, generation, reason: text, action: { enum: ['acknowledge', 'wait_user', 'reopen'] } }, ['todoId', 'reviewer', 'reason', 'action']) },
  { name: 'coagenthub_plan_run_decide', description: '仅决定当前服务真实承载的 PlanRun；不支持通过或合并',
    inputSchema: schema({ runId: text, escalationId: text, decidedBy: text, generation,
      action: { enum: ['answer', 'skip', 'rescope', 'stop', 'rerun_isolated'] }, reason: text, answer: text,
      dropFeatures: { type: 'array', items: text } }, ['runId', 'escalationId', 'decidedBy', 'action']) },
  { name: 'coagenthub_master_brief', description: '读取合 master 简报及前置检查，始终要求用户签名，不执行合并',
    inputSchema: schema({ projectId: text }, ['projectId']) },
];

function validate(name: string, args: Record<string, unknown>) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error('UNKNOWN_TOOL');
  for (const field of tool.inputSchema.required) if (!(field in args)) throw new Error(`MISSING_ARGUMENT:${field}`);
  for (const [field, value] of Object.entries(args)) {
    const rule = tool.inputSchema.properties[field] as { type?: string; minLength?: number; enum?: string[]; minimum?: number; maximum?: number } | undefined;
    if (!rule || rule.enum && !rule.enum.includes(value as string)
      || rule.type === 'string' && (typeof value !== 'string' || !value.trim())
      || rule.type === 'integer' && (!Number.isSafeInteger(value) || Number(value) < rule.minimum! || Number(value) > (rule.maximum ?? Infinity))
      || rule.type === 'array' && (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim()))) {
      throw new Error(`INVALID_ARGUMENT:${field}`);
    }
  }
}

export function createReviewerMcpHandler(base = 'http://127.0.0.1:3101', request: typeof fetch = fetch) {
  const endpoint = new URL(base);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('MCP_BASE_MUST_BE_LOOPBACK_ORIGIN');
  }
  let initialized = false;
  let ready = false;
  async function call(name: string, args: Record<string, unknown>) {
    validate(name, args);
    const { projectId, todoId, runId, ...body } = args;
    let path: string;
    let method = 'GET';
    if (name === 'coagenthub_reviewer_todos') path = `/api/reviewer/todos${projectId ? `?projectId=${encodeURIComponent(String(projectId))}` : ''}`;
    else if (name === 'coagenthub_reviewer_wait') path = `/api/reviewer/wait?${new URLSearchParams(Object.entries(args).map(([key, value]) => [key, String(value)]))}`;
    else if (name === 'coagenthub_master_brief') path = `/api/projects/${encodeURIComponent(String(projectId))}/master-brief`;
    else {
      method = 'POST';
      path = name === 'coagenthub_reviewer_duty' ? `/api/projects/${encodeURIComponent(String(projectId))}/reviewer-duty`
        : name === 'coagenthub_reviewer_todo_decide' ? `/api/reviewer/todos/${encodeURIComponent(String(todoId))}`
        : `/api/plan-runs/${encodeURIComponent(String(runId))}/decide`;
    }
    const response = await request(`${endpoint.origin}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(35000),
      headers: { 'content-type': 'application/json', ...(args.generation ? {
        'x-coagent-reviewer': String(args.owner ?? args.reviewer ?? args.decidedBy),
        'x-coagent-reviewer-generation': String(args.generation) } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? `HTTP_${response.status}`);
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  }
  return async (message: unknown) => {
    const row = message as { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> };
    if (!row || typeof row !== 'object' || row.jsonrpc !== '2.0' || typeof row.method !== 'string'
        || (row.id !== undefined && typeof row.id !== 'string' && typeof row.id !== 'number')) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }
    if (row.id === undefined) {
      if (row.method === 'notifications/initialized' && initialized) ready = true;
      return undefined;
    }
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: row.id, result });
    if (row.method === 'ping') return reply({});
    if (row.method === 'initialize') {
      initialized = true; ready = false;
      return reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'coagenthub-reviewer-workflow', version: '0.1.0' } });
    }
    if (!ready) return { jsonrpc: '2.0', id: row.id, error: { code: -32000, message: 'Initialization required' } };
    if (row.method === 'tools/list') return reply({ tools });
    if (row.method !== 'tools/call') return { jsonrpc: '2.0', id: row.id, error: { code: -32601, message: 'Method not found' } };
    try {
      const args = row.params?.arguments ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('INVALID_ARGUMENTS');
      return reply(await call(String(row.params?.name), args as Record<string, unknown>));
    } catch (error) {
      return reply({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'TOOL_FAILED' }] });
    }
  };
}

export async function serveReviewerMcp(input: Readable, output: Writable, base?: string) {
  const handle = createReviewerMcpHandler(base);
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    let response;
    try { response = await handle(JSON.parse(line)); }
    catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
    if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
  }
}
