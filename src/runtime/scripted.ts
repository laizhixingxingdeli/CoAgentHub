/**
 * ScriptedRuntime —— AgentRuntime 端口的第二个实现。
 *
 * **它存在的理由不是测试方便，是让"为别的 agent 预留"这句话可证伪。**
 * 只有一个实现的接口一定会长成那个实现的形状；判据不是接口存在，是第二个
 * 实现存在，而且用例层的测试跑在它上面——在一台没装 pi 的机器上也能全绿。
 *
 * 它按预设脚本调用平台工具，走的是**真实 HTTP 面**，与 pi 完全同一条路径。
 * 它替身的是 agent，不是平台。
 */

import type {
  AgentRun,
  AgentRunSpec,
  AgentRuntime,
  RuntimeEvent,
  RuntimeOutcome,
} from '../application/ports.ts';
import type { AttemptEndReason, TokenUsage } from '../kernel/index.ts';

export interface ScriptStep {
  readonly tool: string;
  /** 静态请求体，或按当前工具返回值动态算出来的。 */
  readonly body: unknown | ((previous: Record<string, unknown>) => unknown);
  /** 期待这一步失败（用来验平台守卫）。默认期待成功。 */
  readonly expectFailure?: boolean;
}

export interface Script {
  readonly steps: readonly ScriptStep[];
  /** 不走脚本、直接模拟上游失败。 */
  readonly upstreamFailure?: string;
  /**
   * 模拟**连不上平台**：直接抛，像 fetch 真的失败那样。
   *
   * 和 upstreamFailure 是两码事，所以不能复用它——上游失败是"那个候选
   * 不可用"，连不上是"平台自己坏了"，调度器对这两件事的处置相反。
   */
  readonly connectionError?: string;
  /**
   * 一直跑不完，直到被 abort 收掉。
   *
   * 用来验墙钟闸。要守的性质是"**一直在产出**的 agent 也要被拦下来"——
   * upstreamFailure 模拟的是立刻失败，那条路径压根走不到闸门。
   */
  readonly hangs?: boolean;
  /**
   * 先把 steps 跑完（于是平台上留下了证据），**然后**挂住不收尾。
   *
   * 守的是和 hangs 相反的那条性质：交过东西的不该在第一次到点就被掐。
   */
  readonly hangsAfterSteps?: boolean;
  readonly usage?: TokenUsage;
  /** query 角色：覆盖默认输出（否则从 tool 步骤拼）。 */
  readonly output?: string;
  /** query 角色：结构化终态，透传进 RuntimeOutcome.queryOutcome。 */
  readonly queryOutcome?: 'answered' | 'failed' | 'needs_mutation';
}

/** 按 `${role}:${workItemId ?? '-'}:${第几次}` 取脚本。 */
export type ScriptTable = Record<string, Script>;

const DEFAULT_USAGE: TokenUsage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  total: 15,
  quality: 'reported',
};

export class ScriptedRuntime implements AgentRuntime {
  readonly kind = 'scripted';
  /** 明确可承接独立只读 QueryRun；其它 runtime 不得凭 kind 仿冒。 */
  readonly supportsQuery = true;
  #scripts: ScriptTable;
  #counts = new Map<string, number>();
  /** 每一步的实际结果，便于测试断言平台回了什么。 */
  readonly transcript: { key: string; tool: string; status: number; json: unknown }[] = [];
  /** 每次被叫起来时收到的话。用于验证「唤醒语要说清楚为什么叫你」。 */
  readonly instructions: string[] = [];
  /**
   * 每次被叫起来时拿到的续跑句柄。
   *
   * 记下来是为了能断言"**没有**续跑"：协调者不再接着上一跳的会话说，
   * 而这件事没有任何外部可见的症状——不记录就只能靠读代码确认，
   * 下一个人顺手把 resumeRef 加回去也不会有测试变红。
   */
  readonly resumeRefs: (string | undefined)[] = [];

  constructor(scripts: ScriptTable) {
    this.#scripts = scripts;
  }

  /** 每次 start 收到的完整 spec，便于断言 role/tools 等。 */
  readonly specs: AgentRunSpec[] = [];

  async start(spec: AgentRunSpec): Promise<AgentRun> {
    const base = `${spec.role}:${spec.workItemId ?? '-'}`;
    const seen = this.#counts.get(base) ?? 0;
    this.#counts.set(base, seen + 1);
    const key = `${base}:${seen}`;
    this.instructions.push(spec.instruction);
    this.resumeRefs.push(spec.resumeRef);
    this.specs.push(spec);
    const script = this.#scripts[key] ?? this.#scripts[base];
    if (!script) {
      throw new Error(`ScriptedRuntime: 没有脚本匹配 ${key}（也没有 ${base}）`);
    }

    const handlers: ((event: RuntimeEvent) => void)[] = [];
    const emit = (event: RuntimeEvent) => {
      for (const handler of handlers) handler(event);
    };

    // hangs 的脚本靠这个收尾。SpawnRuntime 那边对应的是 killTree 之后
    // 子进程 close 回来的那次 settle —— 同样是"被杀掉"而不是"跑完了"。
    let killed: (() => void) | undefined;

    const run = async (): Promise<RuntimeOutcome> => {
      if (script.connectionError) throw new Error(script.connectionError);
      if (script.hangs) {
        // 先让出一拍再发。`const pending = run()` 是同步启动的，而调用方要拿到
        // 返回的 AgentRun 之后才能 .on() 订阅——在这之前发的事件没有任何人收。
        // 真实运行时是靠子进程输出驱动的，天然在订阅之后。
        await new Promise<void>((tick) => setImmediate(tick));
        emit({ kind: 'output', text: '还在干活…' });
        // 挂住之前报一次用量 —— pi 在每个工具边界都会报。被杀的进程来不及
        // 回传结果行，这一次就是账上唯一的凭据。
        emit({ kind: 'usage', usage: script.usage ?? DEFAULT_USAGE });
        await new Promise<void>((resolve) => {
          killed = resolve;
        });
        return {
          endedBy: 'upstream_failure',
          // 被杀的进程**来不及回传结果行**，所以这里必须是全零的 unknown，
          // 不能顺手给一份漂亮的用量——SpawnRuntime 的 close 分支就是这么补的。
          // 给了的话，"账上记成 0"这个真实的洞在测试里根本复现不出来。
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, quality: 'unknown' },
          failureMessage: '进程被杀且没有回传结果',
        };
      }
      if (script.upstreamFailure) {
        return {
          endedBy: 'upstream_failure',
          usage: script.usage ?? DEFAULT_USAGE,
          failureMessage: script.upstreamFailure,
        };
      }

      let submitted = false;
      const previous: Record<string, unknown> = {};
      for (const step of script.steps) {
        emit({ kind: 'tool.started', name: step.tool, callId: step.tool });

        // query 路径的只读本地工具：不走 Mission HTTP 面（也没有 run token）。
        if (spec.role === 'query' && QUERY_LOCAL_TOOLS.has(step.tool)) {
          const json = { ok: true, tool: step.tool };
          this.transcript.push({ key, tool: step.tool, status: 200, json });
          emit({ kind: 'tool.completed', name: step.tool, callId: step.tool });
          Object.assign(previous, json);
          continue;
        }

        const body =
          typeof step.body === 'function'
            ? (step.body as (p: Record<string, unknown>) => unknown)(previous)
            : step.body;
        const res = await fetch(`${spec.endpoint.baseUrl}/api/agent/${step.tool}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-coagent-run': spec.endpoint.token,
          },
          body: JSON.stringify(body ?? {}),
        });
        const json: unknown = await res.json().catch(() => null);
        this.transcript.push({ key, tool: step.tool, status: res.status, json });
        emit({ kind: 'tool.completed', name: step.tool, callId: step.tool });

        if (step.expectFailure) {
          if (res.ok) throw new Error(`ScriptedRuntime: ${step.tool} 本该被平台拒绝，却成功了`);
          continue;
        }
        if (!res.ok) {
          const detail = json as { message?: string } | null;
          throw new Error(`ScriptedRuntime: ${step.tool} 失败 —— ${detail?.message ?? res.status}`);
        }
        Object.assign(previous, json as Record<string, unknown>);
        if (TERMINAL.has(step.tool)) submitted = true;
      }

      // 步骤跑完之后再挂住：模拟"交过东西、还在干、但就是不收尾"。
      // 和 hangs 分开，因为要守的是相反的那条性质——有进展的不该被掐。
      if (script.hangsAfterSteps) {
        emit({ kind: 'usage', usage: script.usage ?? DEFAULT_USAGE });
        await new Promise<void>((resolve) => {
          killed = resolve;
        });
        return {
          endedBy: 'upstream_failure',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, quality: 'unknown' },
          failureMessage: '进程被杀且没有回传结果',
        };
      }

      const usage = script.usage ?? DEFAULT_USAGE;
      emit({ kind: 'usage', usage });
      const endedBy: AttemptEndReason =
        script.queryOutcome === 'failed'
          ? 'upstream_failure'
          : submitted
            ? 'structured_submit'
            : script.queryOutcome === 'answered' || script.queryOutcome === 'needs_mutation'
              ? 'structured_submit'
              : 'no_structured_result';
      return {
        endedBy,
        usage,
        resumeRef: `scripted:${key}`,
        // 给一段假的原始输出，好让 Timeline 第三层也有东西可验。
        output:
          script.output ??
          script.steps.map((step) => `[tool] ${step.tool}`).join(String.fromCharCode(10)),
        toolCalls: script.steps.map((step) => step.tool),
        ...(script.queryOutcome ? { queryOutcome: script.queryOutcome } : {}),
        ...(script.queryOutcome === 'failed'
          ? { failureMessage: script.upstreamFailure ?? 'query failed' }
          : {}),
      };
    };

    const pending = run();
    return {
      resumeRef: `scripted:${key}`,
      on(handler) {
        handlers.push(handler);
        return () => {
          const i = handlers.indexOf(handler);
          if (i >= 0) handlers.splice(i, 1);
        };
      },
      async abort() {
        // 普通脚本跑得很快，没有可取消的窗口；hangs 的那种就靠这一下收掉。
        killed?.();
      },
      wait: () => pending,
    };
  }
}

const TERMINAL = new Set([
  'coagent_dispatch_work_item',
  'coagent_submit_execution_result',
  'coagent_submit_mission_result',
  'coagent_report_blocked',
  'coagent_escalate_to_l3',
]);

/** query 路径只读本地工具：不打 Mission HTTP。 */
const QUERY_LOCAL_TOOLS = new Set(['read', 'grep', 'find', 'ls']);
