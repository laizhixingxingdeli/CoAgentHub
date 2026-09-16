/**
 * HTTP 面。零依赖，直接用 node:http。
 *
 * 两组端点：
 *   /api/agent/*   —— coagent_* 工具的真实实现。身份来自 run token，不来自请求体。
 *   /api/missions* —— 客户端（L3 / Web / CLI）读写 Mission。
 *
 * 工具实现放在平台侧、而不是各个 runtime 适配包里，是为了接第二个 agent 时
 * 不用把这十来个工具重写一遍。
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Platform, PlatformRuleError } from '../application/platform.ts';
import { AgentPoolError, InMemoryAgentPoolRepository } from '../application/agent-pool.ts';
import type { AgentPoolAddInput, AgentPoolRepository } from '../application/agent-pool.ts';
import { KernelError } from '../kernel/index.ts';
import { RunTokenRegistry } from './run-tokens.ts';
import { WEB_PAGE } from './web.ts';
import { serveStatic } from './static.ts';
import { listRuntimeModels } from '../application/runtime-catalog.ts';
import { NoLiveOutput } from '../application/live.ts';
import type { LiveOutput } from '../application/live.ts';
import type { DeliveryRepository } from '../application/delivery.ts';
import type { RunContext } from './run-tokens.ts';

/** 客户端 API 版本。破坏性改动时要加。 */
export const API_VERSION = 'v1';

export interface ApiDeps {
  platform: Platform;
  tokens: RunTokenRegistry;
  deliveries: DeliveryRepository;
  /**
   * 每次成功的写请求之后调用。
   *
   * 落盘放在这一个地方，而不是散在各个用例里：用例直接改活对象，
   * 漏掉一处就是"重启后这条改动没了"，而且很难发现。
   */
  onMutation?: () => void | Promise<void>;
  /** 实时输出来源。不配就是没有实时——界面那一栏会显示「还没有实时输出」。 */
  live?: LiveOutput;
  /**
   * 每次读请求之前调用，用来把别的进程写过的东西读进来。
   *
   * 不做这件事的话，常驻服务器会一直显示启动那一刻的快照——文件版踩过一次
   * （靠 mtime 修的），换成数据库之后同一个坑还在，只是判据换了。
   */
  beforeRead?: () => Promise<void> | void;
  /** Web 资源根目录。缺省 src/web/；测试用临时目录，免得几个测试文件互相看见。 */
  webRoot?: string;
  /**
   * 候选池仓储。不传就是内存版（进程退了配置就没了）。
   *
   * 为什么是可选的：这一堆 createApi 调用点里绝大多数只关心 Mission 流转，
   * 把候选池做成必填会让十几个测试文件为了一个它们根本不碰的端点改一遍。
   * 少一个默认实现，比少一类调用点便宜。
   */
  agentPool?: AgentPoolRepository;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'BAD_JSON', '请求体不是合法 JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    'x-coagent-api': API_VERSION,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createApi(deps: ApiDeps): Server {
  const { platform, tokens, deliveries, onMutation, beforeRead } = deps;
  const live: LiveOutput = deps.live ?? new NoLiveOutput();
  const agentPool: AgentPoolRepository = deps.agentPool ?? new InMemoryAgentPoolRepository();

  const requireRun = (req: IncomingMessage): RunContext => {
    const header = req.headers['x-coagent-run'];
    const token = Array.isArray(header) ? header[0] : header;
    const context = tokens.resolve(token);
    if (!context) {
      throw new HttpError(401, 'UNKNOWN_RUN_TOKEN', 'x-coagent-run 缺失或已失效');
    }
    return context;
  };

  const requireWorkItem = (run: RunContext): string => {
    if (!run.workItemId) {
      throw new HttpError(409, 'ATTEMPT_NOT_BOUND', '本次运行没有绑定工作项');
    }
    return run.workItemId;
  };

  /** 每个工具一个 handler。handler 里没有规则，规则都在 Platform。 */
  const agentTools: Record<
    string,
    (run: RunContext, body: Record<string, never>) => Promise<unknown>
  > = {
    async coagent_get_mission(run) {
      return platform.getMissionView(run.missionId);
    },

    async coagent_get_contract(run) {
      return platform.getContract(run.missionId);
    },

    async coagent_update_findings(run, body) {
      const { findings, rejectedHypotheses } = body as unknown as {
        findings: string;
        rejectedHypotheses?: string[];
      };
      return platform.updateFindings(run.missionId, run.attemptId, findings, rejectedHypotheses);
    },

    async coagent_update_plan(run, body) {
      return platform.updatePlan(run.missionId, run.attemptId, body as never);
    },

    async coagent_create_work_item(run, body) {
      const { title, ...order } = body as unknown as { title: string };
      return platform.createWorkItem(run.missionId, run.attemptId, {
        title,
        order: order as never,
      });
    },

    async coagent_retire_work_item(run, body) {
      const { workItemId, reason } = body as unknown as {
        workItemId: string;
        reason: string;
      };
      // 只有协调者能作废：S14.6 说 cancel-replace 是 L2 的判断。
      // 执行者要是能作废自己手上的工单，"做不完就把它作废掉"会变成一条捷径。
      if (run.role !== 'coordinator') {
        throw new HttpError(409, 'WRONG_ROLE', '只有协调者能作废工作项。');
      }
      return platform.retireWorkItem(run.missionId, workItemId, reason);
    },

    async coagent_dispatch_work_item(run, body) {
      const { workItemIds } = body as unknown as { workItemIds: string[] };
      return platform.dispatchWorkItems(run.missionId, run.attemptId, workItemIds ?? []);
    },

    async coagent_review_execution_result(run, body) {
      return platform.reviewExecutionResult(run.missionId, run.attemptId, body as never);
    },

    async coagent_escalate_to_l3(run, body) {
      await platform.escalateToL3(run.missionId, run.attemptId, body as never);
      return {};
    },

    async coagent_submit_mission_result(run, body) {
      await platform.submitMissionResult(run.missionId, run.attemptId, body as never);
      return {};
    },

    async coagent_get_project_context(run, body) {
      const { slug } = body as unknown as { slug?: string };
      return platform.getProjectContext(run.missionId, slug);
    },

    async coagent_get_work_order(run) {
      return platform.getWorkOrder(run.missionId, requireWorkItem(run));
    },

    async coagent_get_context(run, body) {
      const { ref } = body as unknown as { ref: string };
      return platform.getContext(run.missionId, run.attemptId, ref);
    },

    async coagent_submit_evidence(run, body) {
      return platform.submitEvidence(run.missionId, run.attemptId, body as never);
    },

    async coagent_submit_execution_result(run, body) {
      return platform.submitExecutionResult(run.missionId, run.attemptId, body as never);
    },

    async coagent_report_blocked(run, body) {
      await platform.reportBlocked(run.missionId, run.attemptId, body as never);
      return {};
    },
  };

  return createServer((req, res) => {
    void handle(req, res)
      .then(async () => {
        // **要 await**：落盘失败必须能变成这次请求的错误。即发即忘的话，
        // 一个写冲突会以 unhandledRejection 的形式把整个进程带走，
        // 而调用方只看到连接断了。
        if (req.method === 'POST' && onMutation) await onMutation();
      })
      .catch((error) => {
      if (error instanceof HttpError) {
        send(res, error.status, { error: error.code, message: error.message });
      } else if (error instanceof PlatformRuleError) {
        // 409：请求本身合法，是当前状态不允许。工具会把 message 原样回给模型，
        // 所以 message 必须写成「下一步该干什么」，不是一句 invalid state。
        send(res, 409, { error: error.code, message: error.message });
      } else if (error instanceof AgentPoolError) {
        // 与 PlatformRuleError 同构：请求本身合法，是当前候选池容不下它。
        // 界面要把 message 原样显示出来，所以那里写的就是「下一步该干什么」。
        send(res, 409, { error: error.code, message: error.message });
      } else if (error instanceof KernelError) {
        send(res, 409, { error: error.code, message: error.message });
      } else {
        send(res, 500, {
          error: 'INTERNAL',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (method === 'GET' && beforeRead && path.startsWith('/api/')) await beforeRead();

    if (method === 'GET' && path === '/api/health') {
      return send(res, 200, { ok: true, api: API_VERSION });
    }

    // S12.1：客户端 API 带版本。所有客户端（Web / L3 CLI / 别的 Host）
    // 走同一套，没有谁是特权客户端。
    if (method === 'GET' && path === '/api/version') {
      return send(res, 200, { api: API_VERSION });
    }

    // S11.5：用量报表。projectId / missionId 可选，用来收窄范围。
    if (method === 'GET' && path === '/api/usage') {
      return send(
        res,
        200,
        await platform.getUsage({
          projectId: url.searchParams.get('projectId') ?? undefined,
          missionId: url.searchParams.get('missionId') ?? undefined,
        }),
      );
    }

    // 可用模型清单。平台自己不认识模型——这里只是把适配层吐的 JSON 转出去。
    if (method === 'GET' && path === '/api/runtime/models') {
      return send(res, 200, await listRuntimeModels());
    }

    if (method === 'GET' && path === '/api/projects') {
      return send(res, 200, await platform.listProjects());
    }

    /* ---- 候选池（资源池页的原料）。只有列与追加两个动作 ---- */

    // 没有 DELETE / PATCH / PUT，也没有播种：这页没有鉴权，而读路径带副作用
    // 意味着「打开界面看一眼」就能改写别人的配置。
    if (method === 'GET' && path === '/api/pools') {
      return send(res, 200, await agentPool.list());
    }

    if (method === 'POST' && path === '/api/pools') {
      const body = await readJson(req);
      const input: AgentPoolAddInput = body as unknown as AgentPoolAddInput;
      const added = await agentPool.add(input);
      // add 能返回就说明 role 已过校验，回显它才不会与请求里那个是两个字。
      return send(res, 201, { role: input.role, ...added });
    }

    // 正式 Web 端：src/web/ 下的无构建静态文件（ADR-0001）。
    // 只读——放行/打回走 src/l3.ts，规则只该有一份实现。
    if (method === 'GET' && serveStatic(path, res, deps.webRoot)) return;

    // 回退到内置的单页观测面。
    //
    // 留着它不是懒得删：`src/web/` 还没铺好、或者被谁删了的时候，
    // 平台至少还能自证还活着。丢了这条路，一个空目录会表现成整个平台挂了。
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(WEB_PAGE);
      return;
    }

    if (method === 'GET' && path === '/api/missions') {
      return send(res, 200, await platform.listMissions());
    }

    const activityMatch = /^\/api\/missions\/([^/]+)\/activity$/.exec(path);
    if (method === 'GET' && activityMatch) {
      return send(res, 200, await platform.getActivity(activityMatch[1]));
    }

    // 实时输出：游标轮询。
    //
    // 没用 SSE 是想清楚的：生产者（调度器）在另一个进程，服务端拿到新内容
    // 本来就得去存储里取，SSE 只是把「谁来轮询」换了个位置，延迟省不了多少。
    // 而游标轮询天然能续——刷新页面、断线重连都从上次的位置接上，
    // SSE 这些都得自己处理。
    const liveMatch = /^\/api\/missions\/([^/]+)\/live$/.exec(path);
    if (method === 'GET' && liveMatch) {
      const cursor = Number(url.searchParams.get('cursor') ?? 0);
      const chunks = await live.since(liveMatch[1], Number.isFinite(cursor) ? cursor : 0);
      return send(res, 200, {
        // 没有新内容时把游标原样回去，客户端不用判空。
        cursor: chunks.at(-1)?.seq ?? cursor,
        chunks,
      });
    }

    // attempt id 里带点（W-1.exec-1），所以尾段用 (.+) 而不是 ([^/]+)。
    const attemptMatch = /^\/api\/missions\/([^/]+)\/attempts\/(.+)$/.exec(path);
    if (method === 'GET' && attemptMatch) {
      return send(res, 200, await platform.getAttemptDetail(attemptMatch[1], attemptMatch[2]));
    }

    // 开跑简报（S09.1）。**不是工具**——它是适配层在模型开口之前自己取的，
    // 模型不该有"要不要看架构红线"这个选择。身份同样来自 run token。
    if (method === 'GET' && path === '/api/run/brief') {
      const run = requireRun(req);
      return send(res, 200, await platform.getStartupBrief(run.missionId, run.attemptId));
    }

    if (path.startsWith('/api/agent/')) {
      if (method !== 'POST') throw new HttpError(405, 'METHOD', '只接受 POST');
      const tool = path.slice('/api/agent/'.length);
      const handler = agentTools[tool];
      if (!handler) throw new HttpError(404, 'UNKNOWN_TOOL', `没有这个工具：${tool}`);
      const run = requireRun(req);
      const body = await readJson(req);
      return send(res, 200, await handler(run, body as Record<string, never>));
    }

    if (method === 'POST' && path === '/api/missions') {
      const body = await readJson(req);
      return send(res, 201, await platform.createMission(body as never));
    }

    const missionMatch = /^\/api\/missions\/([^/]+)$/.exec(path);
    if (method === 'GET' && missionMatch) {
      return send(res, 200, await platform.getMissionView(missionMatch[1]));
    }

    /* ---- L3 面：最终检视 ---- */

    const diffMatch = /^\/api\/missions\/([^/]+)\/diff$/.exec(path);
    if (method === 'GET' && diffMatch) {
      return send(res, 200, await platform.getMissionDiff(diffMatch[1]));
    }


    const answerMatch = /^\/api\/missions\/([^/]+)\/escalations\/answer$/.exec(path);
    if (method === 'POST' && answerMatch) {
      const body = await readJson(req);
      return send(res, 200, await platform.answerEscalation(answerMatch[1], String(body.answer ?? '')));
    }

    const reviseMatch = /^\/api\/missions\/([^/]+)\/contract$/.exec(path);
    if (method === 'POST' && reviseMatch) {
      const body = await readJson(req);
      return send(res, 200, await platform.reviseContract(reviseMatch[1], body as never));
    }

    const controlMatch = /^\/api\/missions\/([^/]+)\/(cancel|pause|resume)$/.exec(path);
    if (method === 'POST' && controlMatch) {
      const [, id, verb] = controlMatch;
      const body = await readJson(req);
      if (verb === 'cancel') return send(res, 200, await platform.cancelMission(id, String(body.reason ?? '')));
      if (verb === 'pause') return send(res, 200, await platform.pauseMission(id));
      return send(res, 200, await platform.resumeMission(id));
    }

    const finalizeMatch = /^\/api\/missions\/([^/]+)\/finalize$/.exec(path);
    if (method === 'POST' && finalizeMatch) {
      const body = await readJson(req);
      return send(res, 200, await platform.finalizeMission(finalizeMatch[1], body as never));
    }

    /* ---- 收件箱：结果回到发起方。Host 离线时结果就在这儿等着 ---- */

    if (method === 'GET' && path === '/api/inbox') {
      const recipient = url.searchParams.get('recipient') ?? undefined;
      return send(res, 200, { pending: await deliveries.pending(recipient) });
    }

    const ackMatch = /^\/api\/deliveries\/([^/]+)\/ack$/.exec(path);
    if (method === 'POST' && ackMatch) {
      const delivery = await deliveries.acknowledge(ackMatch[1]);
      if (!delivery) throw new HttpError(404, 'UNKNOWN_DELIVERY', `没有这条投递：${ackMatch[1]}`);
      return send(res, 200, delivery);
    }

    /* ---- 控制面：调度器用来开/收一次 attempt 并换取 run token ---- */

    const coordMatch = /^\/api\/missions\/([^/]+)\/coordinator-attempts$/.exec(path);
    if (method === 'POST' && coordMatch) {
      const missionId = coordMatch[1];
      const { attemptId } = await platform.startCoordinatorAttempt(missionId);
      const run = tokens.issue({ missionId, attemptId, role: 'coordinator' });
      return send(res, 201, { attemptId, token: run.token });
    }

    const execMatch = /^\/api\/missions\/([^/]+)\/work-items\/([^/]+)\/executor-attempts$/.exec(path);
    if (method === 'POST' && execMatch) {
      const [, missionId, workItemId] = execMatch;
      const { attemptId } = await platform.startExecutorAttempt(missionId, workItemId);
      const run = tokens.issue({ missionId, attemptId, role: 'executor', workItemId });
      return send(res, 201, { attemptId, token: run.token });
    }

    const finishMatch = /^\/api\/missions\/([^/]+)\/attempts\/([^/]+)\/finish$/.exec(path);
    if (method === 'POST' && finishMatch) {
      const [, missionId, attemptId] = finishMatch;
      const body = await readJson(req);
      await platform.finishAttempt(missionId, attemptId, body as never);
      // 收尾即吊销：迟到的工具调用应该被拒绝，而不是悄悄写进已经结束的 attempt。
      if (typeof body.token === 'string') tokens.revoke(body.token);
      return send(res, 200, {});
    }

    throw new HttpError(404, 'NOT_FOUND', `${method} ${path}`);
  }
}

export { HttpError, RunTokenRegistry };
