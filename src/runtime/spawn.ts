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
      activityClass?: unknown;
      commandActivityClassification?: unknown;
      usage?: TokenUsage;
    };
    // BUDGET-001-S4: accept only exact v1 classification capability. Anything else drops.
    if (raw.t === 'runtime.capabilities') {
      if (raw.commandActivityClassification === 'v1') {
        return { kind: 'runtime.capabilities', commandActivityClassification: 'v1' };
      }
      return undefined;
    }
    if (raw.t === 'tool.started' && raw.name) {
      const event: {
        kind: 'tool.started';
        name: string;
        callId: string;
        detail?: string;
        activityClass?: 'command' | 'other';
      } = {
        kind: 'tool.started',
        name: raw.name,
        callId: raw.callId ?? raw.name,
        detail: raw.detail,
      };
      // Preserve only exact adapter classifications. Never coerce from tool name.
      if (raw.activityClass === 'command' || raw.activityClass === 'other') {
        event.activityClass = raw.activityClass;
      }
      return event;
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

/**
 * 子进程环境基线：OS 启动 + 代理。缺任一项会把失败伪装成「adapter/模型挂了」。
 * 不含任何宿主凭证名；额外名必须由部署方经 COAGENT_AGENT_ENV_PASSTHROUGH 显式声明。
 */
export const SPAWN_ENV_BASE_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'SYSTEMDRIVE',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
]);

/** 部署方声明「额外透传哪些宿主环境变量名」的 env 键。值是逗号分隔的名字，不是值本身。 */
export const SPAWN_ENV_PASSTHROUGH_VAR = 'COAGENT_AGENT_ENV_PASSTHROUGH';

/**
 * 未声明透传列表时的拒绝文案。构造/接线共用同一句，避免「这里 throw、那里 warn」两套说法。
 * 不提任何厂商凭证名：名单由部署方自己填，Hub 不预设。
 */
export const SPAWN_ENV_PASSTHROUGH_NONE = '-';

export const SPAWN_ENV_UNDECLARED_MESSAGE =
  'SpawnRuntime 拒绝启动：未声明子进程环境变量透传列表。请把 `COAGENT_AGENT_ENV_PASSTHROUGH` 设为逗号分隔的变量名（部署方声明要交给 agent 子进程的额外变量）；确实一个都不透传就设为 `-`，只保留 OS/代理基线。未声明时不得把完整 `process.env` 交给子进程。';

/**
 * 解析部署方声明的额外透传名单。
 *
 * - 键缺失 / `undefined` / 空串 / 纯空白 → 未声明（fail-closed）
 * - `-`（`SPAWN_ENV_PASSTHROUGH_NONE`）→ 已声明「一个都不透传」
 * - 逗号分隔 → trim 后丢掉空 token；`*` 只是字面量，不展开成「全部」
 *
 * **为什么空串不算已声明。** 原先空串表示「声明了，但名单为空」，与未声明区分开。
 * 那个区分在 PowerShell 里表达不出来：`$env:VAR = ""` 会**删掉**变量，Node 侧拿到的
 * 是 `undefined`。于是「我明明声明了空」和「我忘了声明」在用户的 shell 里是同一个动作，
 * 却被给了不同语义——实跑时就是这么撞上的：照文档设了空串，仍然被 fail-closed 拦下，
 * 而报错说的是「未声明」，看起来像平台有 bug。
 *
 * 所以空串归到「忘了」那一侧，要表达「真的不透传」必须显式写 `-`。每个 shell 都造得出
 * 这个值，且忘记与声明不再可能混淆。
 *
 * SpawnRuntime 自己不读这个 env 键（和 supportsQuery 不读 COAGENT_QUERY_ENABLED 同理）；
 * 解析发生在接线层，数组再显式传进来。
 */
export function parseAgentEnvPassthrough(
  raw: string | undefined,
): string[] | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (trimmed === SPAWN_ENV_PASSTHROUGH_NONE) return [];
  return raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * 按「基线 ∪ 透传名单」过滤子进程 env。
 *
 * 匹配永远大小写不敏感，但**保留源里的原始键名**：Windows 上是 `Path` 不是 `PATH`，
 * POSIX 上 `http_proxy` 与 `HTTP_PROXY` 可能同时存在且都要留下。源里没有的名字直接跳过，
 * 不造空字符串——空值有时比缺键更糟（覆盖掉工具自己的默认查找）。
 */
export function filterSpawnEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
  passthrough: readonly string[],
): Record<string, string> {
  const allowed = new Set([
    ...SPAWN_ENV_BASE_ALLOWLIST.map((name) => name.toUpperCase()),
    ...passthrough.map((name) => name.toUpperCase()),
  ]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!allowed.has(key.toUpperCase())) continue;
    out[key] = value;
  }
  return out;
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
  /**
   * 额外允许透传的宿主环境变量名（加到 SPAWN_ENV_BASE_ALLOWLIST 之上）。
   *
   * **运行时必填**：类型在 strip-only 下不存在，权威是 `Array.isArray`。
   * 省略 / `undefined` / 非数组 → 构造即抛，杜绝「忘了声明就整份 process.env 漏下去」。
   * 空数组是合法的封锁声明（只要 OS/代理基线）。
   */
  readonly envPassthrough?: readonly string[];
  /**
   * 过滤用的源 env。测试可注入；生产省略，start() 时读当时的 process.env。
   * 在 start() 快照而不是 construct——construct 到 start 之间宿主 env 仍可能被接线层改。
   */
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
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
    // 类型注解在 Node strip-only 下不存在：不在这里拦，忘声明的调用方会把整份
    // process.env（含宿主凭证）漏进 agent 子进程。空数组是合法声明，undefined 不是。
    if (!Array.isArray(options.envPassthrough)) {
      throw new Error(SPAWN_ENV_UNDECLARED_MESSAGE);
    }
  }

  async start(spec: AgentRunSpec): Promise<AgentRun> {
    const options = this.#options;
    const handlers: ((event: RuntimeEvent) => void)[] = [];
    const emit = (event: RuntimeEvent) => {
      for (const handler of handlers) handler(event);
    };

    // envPassthrough 构造期已是数组；这里再读一次只为满足类型窄化，并作为漏斗
    // 最后一道：哪怕以后有人绕过构造检查，也绝不能把宿主环境整份下发。
    const envPassthrough = options.envPassthrough;
    if (!Array.isArray(envPassthrough)) {
      throw new Error(SPAWN_ENV_UNDECLARED_MESSAGE);
    }
    // 源 env 先收进局部再过滤，禁止 spawn 选项里直接挂宿主环境整份引用
    //（源码锁 / 评审都靠「不再出现整份下发」形态识别回退）。测试可经 options.env 注入。
    const envSource = options.env !== undefined ? options.env : process.env;

    const child: ChildProcess = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      // 只下发「OS/代理基线 ∪ 部署方声明的额外名」。整份宿主环境会把
      // 凭证泄漏给 agent；而代理（见 SPAWN_ENV_BASE_ALLOWLIST）若不传，子进程
      // 直连超时，症状会伪装成「模型什么都没干」。
      env: filterSpawnEnv(envSource, envPassthrough),
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
