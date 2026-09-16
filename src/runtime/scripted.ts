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
  readonly usage?: TokenUsage;
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

  async start(spec: AgentRunSpec): Promise<AgentRun> {
    const base = `${spec.role}:${spec.workItemId ?? '-'}`;
    const seen = this.#counts.get(base) ?? 0;
    this.#counts.set(base, seen + 1);
    const key = `${base}:${seen}`;
    this.instructions.push(spec.instruction);
    this.resumeRefs.push(spec.resumeRef);
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
        emit({ kind: 'output', text: '还在干活…' });
        await new Promise<void>((resolve) => {
          killed = resolve;
        });
        return {
          endedBy: 'upstream_failure',
          usage: script.usage ?? DEFAULT_USAGE,
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

      const usage = script.usage ?? DEFAULT_USAGE;
      emit({ kind: 'usage', usage });
      const endedBy: AttemptEndReason = submitted ? 'structured_submit' : 'no_structured_result';
      return {
        endedBy,
        usage,
        resumeRef: `scripted:${key}`,
        // 给一段假的原始输出，好让 Timeline 第三层也有东西可验。
        output: script.steps.map((step) => `[tool] ${step.tool}`).join(String.fromCharCode(10)),
        toolCalls: script.steps.map((step) => step.tool),
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
