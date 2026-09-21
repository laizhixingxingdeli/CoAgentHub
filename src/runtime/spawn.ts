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
      detail?: string;
      usage?: TokenUsage;
    };
    if (raw.t === 'tool.started' && raw.name) {
      return {
        kind: 'tool.started',
        name: raw.name,
        callId: raw.callId ?? raw.name,
        detail: raw.detail,
      };
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

/**
 * 连同子孙进程一起杀。
 *
 * `child.kill()` 在这里**杀不干净**：Windows 上我们开了 `shell: true`，
 * spawn 起的是 `cmd.exe`，底下才是 `npx` → `node`。杀掉壳，孙子进程
 * 照样跑——实测一个本该 20 分钟超时的 attempt 跑了 45 分钟还在输出。
 * 于是"平台永远可以 kill 掉它"这句话是假的。
 *
 * Windows 用 `taskkill /T` 按进程树杀；POSIX 用负 pid 杀整个进程组。
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    // **不要在这里顺手 child.kill()。** taskkill /T 靠父子关系枚举整棵树；
    // 先把壳杀了它就找不到孙子，于是孙子活下来握着 stdout 管道——
    // 而 `close` 要等所有 stdio 关闭才触发，结果永远不 settle。
    // 实测就是这么挂住的：taskkill 单独跑完全正常，加上那句"兜底"反而失效。
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    killer.on('error', () => child.kill('SIGKILL'));
    // 树杀失败（进程已经没了、或权限不够）才退回单杀。
    killer.on('exit', (code) => {
      if (code !== 0) child.kill('SIGKILL');
    });
    return;
  }

  try {
    // 子进程是进程组长（spawn 时 detached），负 pid 打的是整组。
    process.kill(-pid, 'SIGKILL');
  } catch {
    // 组没了就单杀。
    child.kill('SIGKILL');
  }
}

/** 给人看的一行。协议行本身不该直接糊到终端上。 */
function render(event: RuntimeEvent): string {
  if (event.kind === 'tool.started') {
    return `\n  · ${event.name}${event.detail ? ` · ${event.detail}` : ''}\n`;
  }
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
  /**
   * **静默**超时：多久没有任何输出就判为卡住，连同子孙进程一起杀。
   *
   * 不是总时长上限。实测长任务连续产出 45 分钟是正常的——按总时长砍，
   * 砍掉的正是这种活；而真卡住的特征是不再产出任何东西。
   */
  readonly timeoutMs?: number;
  /** 把子进程输出转发到平台 stdout。 */
  readonly stream?: boolean;
  /**
   * 显式 opt-in：本 SpawnRuntime 实例可承接独立只读 QueryRun。
   *
   * 仅 `true` 有意义。默认 fail-closed——不按 kind / 适配器路径猜测，
   * 也不因 child 是 coagent-pi 就自动开启。生产 Mission 构造不得设此字段。
   */
  readonly supportsQuery?: true;
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
  /**
   * 仅 constructor option `supportsQuery === true` 时为 true；
   * 默认 `undefined`，QueryRunner 构造 fail-closed。
   */
  readonly supportsQuery?: true;
  #options: SpawnRuntimeOptions;

  constructor(options: SpawnRuntimeOptions) {
    this.kind = options.kind;
    this.#options = options;
    if (options.supportsQuery === true) this.supportsQuery = true;
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
      // POSIX 上让子进程自成进程组，这样 kill(-pid) 才收得掉整棵树。
      // 不加的话负 pid 打不到任何东西，超时照样杀不干净。
      detached: process.platform !== 'win32',
    });

    child.stdin?.end(JSON.stringify(spec));

    /** 收到输出就续一次静默超时。真正的定义在下面 arm() 里。 */
    let bumpIdle: () => void = () => {};
    let outcomeLine: string | undefined;
    let stderr = '';
    let buffer = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      // 有动静就说明没卡住。
      bumpIdle();
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

    /**
     * 静默超时：**多久没动静**就判死，不是总共跑了多久。
     *
     * 原先是总时长上限（20 分钟）。实测第一次用平台给自己写 Web 端时，
     * 执行者连续产出了 45 分钟——读代码、写文件、跑测试、发现自己的断言
     * 写错了再改回来。那是正常工作，不是卡住。**按总时长砍，砍掉的正是
     * 这种活。** 而真正卡住的 agent 的特征是"不再产出任何东西"。
     *
     * 每来一行输出就续一次。判据换成这个之后，长任务不受影响，
     * 真死循环仍然在几分钟内被收掉。
     */
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const arm = () => {
      if (!options.timeoutMs) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, options.timeoutMs);
    };
    arm();
    bumpIdle = arm;

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
            /** query 角色：原样透传，不由 endedBy 在此推导。 */
            queryOutcome?: RuntimeOutcome['queryOutcome'];
          };
          if (parsed.usage) emit({ kind: 'usage', usage: parsed.usage });
          const queryOutcome =
            parsed.queryOutcome === 'answered' ||
            parsed.queryOutcome === 'failed' ||
            parsed.queryOutcome === 'needs_mutation'
              ? parsed.queryOutcome
              : undefined;
          resolve({
            endedBy: parsed.endedBy,
            usage: parsed.usage ?? UNKNOWN_USAGE,
            failureMessage: parsed.failureMessage,
            resumeRef: parsed.resumeRef,
            output: parsed.output,
            toolCalls: parsed.toolNames,
            resolvedProfile: parsed.resolvedProfile,
            ...(queryOutcome ? { queryOutcome } : {}),
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
        //
        // 但**是我们自己按静默超时掐的**，那就不是上游的问题，要如实说。
        // `timedOut` 是这里唯一知道真相的地方：再往上只剩一个被杀的进程，
        // 分不出是它崩了还是我们掐的。归错类的代价是好候选被白白冷却。
        const idleKilled = timedOut;
        settle({
          endedBy: idleKilled ? 'killed_idle' : 'upstream_failure',
          usage: UNKNOWN_USAGE,
          failureMessage: idleKilled
            ? `子进程静默超过 ${options.timeoutMs} ms，判为卡住并连同子孙进程一起杀掉`
            : signal === 'SIGKILL'
              ? `子进程被 ${signal} 杀掉且没有回传结果`
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
        // 同样要连子孙一起杀，理由见 killTree。
        killTree(child);
      },
      wait: () => pending,
    };
  }
}
