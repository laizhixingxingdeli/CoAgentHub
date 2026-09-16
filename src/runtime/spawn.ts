/**
 * SpawnRuntime —— 用子进程跑外部 agent 适配器。
 *
 * 平台**不 import 任何 agent SDK**：spec 从 stdin 进去，outcome 从 stdout
 * 最后一行出来。进程边界就是依赖边界，所以 kernel/application 里永远不会
 * 出现 provider、model 或某个 SDK 的类型。
 *
 * 子进程而不是同进程，还换来两件事：一个 agent 死循环或 OOM 不会带走平台；
 * 平台永远可以 kill 掉它。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type {
  AgentRun,
  AgentRunSpec,
  AgentRuntime,
  RuntimeEvent,
  RuntimeOutcome,
} from '../application/ports.ts';
import type { AttemptEndReason, TokenUsage } from '../kernel/index.ts';

const OUTCOME_PREFIX = '__COAGENT_OUTCOME__ ';
/** 结构化事件行前缀。与适配层里的常量必须一致（S11.4 的映射就走这条线）。 */
const EVENT_PREFIX = '__COAGENT_EVENT__ ';

/**
 * 把一行事件 JSON 变成 RuntimeEvent。
 *
 * 解析失败就当没看见：一行坏 JSON 不该让整跳失败，它只是少了一条观测数据。
 */
function parseEvent(json: string): RuntimeEvent | undefined {
  try {
    const raw = JSON.parse(json) as {
      t?: string;
      name?: string;
      callId?: string;
      usage?: TokenUsage;
    };
    if (raw.t === 'tool.started' && raw.name) {
      return { kind: 'tool.started', name: raw.name, callId: raw.callId ?? raw.name };
    }
    if (raw.t === 'tool.completed' && raw.name) {
      return { kind: 'tool.completed', name: raw.name, callId: raw.callId ?? raw.name };
    }
    if (raw.t === 'usage' && raw.usage) return { kind: 'usage', usage: raw.usage };
    return undefined;
  } catch {
    return undefined;
  }
}

/** 给人看的一行。协议行本身不该直接糊到终端上。 */
function render(event: RuntimeEvent): string {
  if (event.kind === 'tool.started') return `\n  · ${event.name}\n`;
  if (event.kind === 'usage') {
    return `  [tok ${event.usage.total}]\n`;
  }
  return '';
}

export interface SpawnRuntimeOptions {
  readonly kind: string;
  /** 可执行文件，例如 npx。 */
  readonly command: string;
  /** 参数，例如 ['tsx', 'C:/program1/coagent-pi/src/agent-entry.ts']。 */
  readonly args: readonly string[];
  /** 子进程工作目录（不是 Mission worktree —— 那个走 spec.cwd）。 */
  readonly cwd?: string;
  /** 硬超时；到点 kill。 */
  readonly timeoutMs?: number;
  /** 把子进程输出转发到平台 stdout。 */
  readonly stream?: boolean;
}

const UNKNOWN_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  quality: 'unknown',
};

export class SpawnRuntime implements AgentRuntime {
  readonly kind: string;
  #options: SpawnRuntimeOptions;

  constructor(options: SpawnRuntimeOptions) {
    this.kind = options.kind;
    this.#options = options;
  }

  async start(spec: AgentRunSpec): Promise<AgentRun> {
    const options = this.#options;
    const handlers: ((event: RuntimeEvent) => void)[] = [];
    const emit = (event: RuntimeEvent) => {
      for (const handler of handlers) handler(event);
    };

    const child: ChildProcess = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      // 代理变量必须传下去：子进程拿不到代理，就会直连超时，
      // 而且症状会伪装成「模型什么都没干」。
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    child.stdin?.end(JSON.stringify(spec));

    let outcomeLine: string | undefined;
    let stderr = '';
    let buffer = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      buffer += text;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.startsWith(OUTCOME_PREFIX)) {
          outcomeLine = line.slice(OUTCOME_PREFIX.length);
        } else if (line.startsWith(EVENT_PREFIX)) {
          // 结构化事件（S11.4）。**不要当成 output 再发一遍**——
          // 那样同一件事在界面上会出现两次：一个芯片加一行原始文本。
          const event = parseEvent(line.slice(EVENT_PREFIX.length));
          if (event) {
            emit(event);
            // 转人话再打给看 run-mission 的人；原始 JSON 行不往外露。
            if (options.stream) process.stdout.write(render(event));
          }
        } else if (line.trim()) {
          emit({ kind: 'output', text: line });
          if (options.stream) process.stdout.write(`${line}\n`);
        }
        index = buffer.indexOf('\n');
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const timer = options.timeoutMs
      ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
      : undefined;

    const pending = new Promise<RuntimeOutcome>((resolve) => {
      const settle = (fallback: RuntimeOutcome) => {
        if (timer) clearTimeout(timer);
        if (buffer.startsWith(OUTCOME_PREFIX)) outcomeLine = buffer.slice(OUTCOME_PREFIX.length);
        if (!outcomeLine) return resolve(fallback);
        try {
          const parsed = JSON.parse(outcomeLine) as {
            endedBy: AttemptEndReason;
            usage?: TokenUsage;
            failureMessage?: string;
            resumeRef?: string;
            output?: string;
            toolNames?: string[];
            resolvedProfile?: RuntimeOutcome['resolvedProfile'];
          };
          if (parsed.usage) emit({ kind: 'usage', usage: parsed.usage });
          resolve({
            endedBy: parsed.endedBy,
            usage: parsed.usage ?? UNKNOWN_USAGE,
            failureMessage: parsed.failureMessage,
            resumeRef: parsed.resumeRef,
            output: parsed.output,
            toolCalls: parsed.toolNames,
            resolvedProfile: parsed.resolvedProfile,
          });
        } catch {
          resolve(fallback);
        }
      };

      child.on('error', (error) =>
        settle({
          endedBy: 'upstream_failure',
          usage: UNKNOWN_USAGE,
          failureMessage: `起子进程失败：${error.message}`,
        }),
      );

      child.on('close', (code, signal) => {
        // 拿不到 outcome 行就是**上游失败**（进程崩了 / 被 kill），
        // 不是 no_structured_result —— 后者的含义是「模型跑完了但没提交」，
        // 归错类会让调度器拒绝重试一个其实该重试的情况。
        settle({
          endedBy: 'upstream_failure',
          usage: UNKNOWN_USAGE,
          failureMessage:
            signal === 'SIGKILL'
              ? `子进程超时被杀（${options.timeoutMs} ms）`
              : `子进程退出 code=${code} 且没有回传结果。stderr: ${stderr.slice(-500) || '(空)'}`,
        });
      });
    });

    return {
      resumeRef: undefined,
      on(handler) {
        handlers.push(handler);
        return () => {
          const i = handlers.indexOf(handler);
          if (i >= 0) handlers.splice(i, 1);
        };
      },
      async abort() {
        child.kill('SIGKILL');
      },
      wait: () => pending,
    };
  }
}
