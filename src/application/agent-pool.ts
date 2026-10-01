/**
 * 候选池端口 —— 「谁能当协调者、谁能当执行者」从代码里搬出来变成配置。
 *
 * 为什么要这一层：那四条候选原先硬编码在 `run-mission.ts` 里，换一个候选就得
 * 改代码重启。可它们本质是运维数据，不是领域规则 —— 运维数据写进代码，等于
 * 每次调整都要走一遍发布。
 *
 * 为什么不放进 `ports.ts`：那里放的是用例层**依赖**的端口（ProjectRepository、
 * AgentRuntime…），而候选池只有装配层与 HTTP 面用得到，Platform 一个字都不
 * 依赖它。混在一起会让「谁真的需要这个接口」变模糊。
 *
 * 为什么不进 `src/kernel/`：候选池整个是 runtime 侧概念，内核连这类词都不许
 * 出现（架构红线）。
 *
 * 只支持追加。删除/改/重排在「有正在跑的 attempt」时语义上有的说（动的是这一跳
 * 还是下一跳？），那不是这次的范围 —— 而且这个界面没有鉴权。
 */

import type { UsageRow } from './runtime-catalog.ts';

/* ------------------------------ 类型 ------------------------------ */

export type AgentRole = 'coordinator' | 'executor' | 'independent_reviewer';

/**
 * runtime 只有 'pi'。
 *
 * 刻意写成字面量而不是 `string`，也不留扩展点：接第二种 runtime 应该是一次
 * 有意的改动（连带适配层、候选语义一起想清楚），而不是往一个已经是 `string`
 * 的字段里随手塞个新值 —— 后者会让「这条候选跑得起来吗」重新变成只有运行时
 * 才知道答案的事。
 */
export type AgentPoolRuntime = 'pi';

/**
 * 一条候选上挂的不透明键值。
 *
 * 平台**不解释**它：键与值都由适配层定义，这一层只负责原样存取、原样传给
 * `ExecutionProfile.facts`。在这里写死任何具体键名，就等于把适配层的知识
 * 抄了一份，而抄的那份从写下那一刻就开始过期。
 */
export interface AgentPoolFact {
  readonly key: string;
  readonly value: string;
}

/** 一条候选。不带 role —— role 由它落在快照里哪个数组决定。 */
export interface AgentPoolCandidate {
  readonly profileId: string;
  readonly endpoint: string;
  readonly runtime: AgentPoolRuntime;
  /** 同 role 内的顺序，从 0 起。调度器按它做「只有上游失败才往后换」。 */
  readonly order: number;
  /** 不透明键值。没有就是空数组 —— 不给界面留 undefined 分支。 */
  readonly facts: readonly AgentPoolFact[];
}

/** 存储里的一行 = 候选 + 它属于哪个 role。三种实现内部共用这个形状。 */
export interface AgentPoolRow extends AgentPoolCandidate {
  readonly role: AgentRole;
}

export interface AgentPoolSnapshot {
  readonly coordinator: readonly AgentPoolCandidate[];
  readonly executor: readonly AgentPoolCandidate[];
  /** 老池缺这一行时 list 仍给出 []，不能当成「可以自审」。 */
  readonly independent_reviewer: readonly AgentPoolCandidate[];
}

/**
 * GET /api/pools 在原候选上附加的只读健康；不进仓储、不影响 POST。
 *
 * 后面三个可选键只有读到了才有：**取不到就不给，不编一个。** 额度那两句话
 * 是给人抄着执行的，凭空编出来的复位命令比没有更糟。
 */
export interface AgentPoolCandidateHealth {
  readonly circuit:
    | { readonly state: 'closed' }
    /**
     * openUntil 为 null 只发生在 quota 上（见 candidate-circuit.ts）：预付额度
     * 用完、适配层也没给出重置时间，它不会自己恢复。写成 `string` 会把 null
     * 挤成 "null" 或让整条健康序列化失败 —— 那正是最该看得见的那一格。
     */
    | { readonly state: 'open'; readonly failureClass: string; readonly openUntil: string | null }
    | {
        readonly state: 'half_open';
        readonly failureClass: string;
        readonly openUntil: string;
        readonly probeClaimed: true;
      }
    | { readonly state: 'unknown'; readonly reason: string };
  readonly lastFailure: {
    readonly failureClass: string;
    readonly at: string | null;
    readonly source: string;
    readonly unknownReason?: string;
  };
  readonly window7d: {
    readonly attempts: number;
    readonly successes: number;
    /** 只累加 quality=reported 且带数字 cost 的用量；没有就 null，不编 0。 */
    readonly reportedCost: number | null;
  };
  readonly runtime:
    | { readonly running: true; readonly hopId: string; readonly runtimeKind: string }
    | { readonly running: false; readonly reason: string };
  /**
   * 对上该候选 provider 的那条适配层用量（PI-Q1 的 UsageRow 原样）。
   *
   * 原样转出去，平台不解释字段 —— 界面才能显示适配层后来新加的套餐、重置时间
   * 之类。摘几个字段出来重命名，等于又抄一份会过期的表。
   */
  readonly usage?: UsageRow;
  /** 熔断原因是 quota 时给人看的一句话：说清是等定时重置还是得人工复位。 */
  readonly quotaReason?: string;
  /** 上一条走到「人工复位」分支时才带的、可直接复制执行的命令。 */
  readonly resetCommand?: string;
}

export interface AgentPoolCandidateWithHealth extends AgentPoolCandidate {
  readonly health: AgentPoolCandidateHealth;
}

export interface AgentPoolSnapshotWithHealth {
  readonly coordinator: readonly AgentPoolCandidateWithHealth[];
  readonly executor: readonly AgentPoolCandidateWithHealth[];
  readonly independent_reviewer: readonly AgentPoolCandidateWithHealth[];
}

export function withCandidateHealth(
  snapshot: AgentPoolSnapshot,
  healthOf: (candidate: AgentPoolCandidate) => AgentPoolCandidateHealth,
): AgentPoolSnapshotWithHealth {
  const attach = (row: AgentPoolCandidate): AgentPoolCandidateWithHealth => ({ ...row, health: healthOf(row) });
  return {
    coordinator: snapshot.coordinator.map(attach),
    executor: snapshot.executor.map(attach),
    independent_reviewer: snapshot.independent_reviewer.map(attach),
  };
}

/**
 * 追加输入。
 *
 * role 故意不写成 `AgentRole`：它的来源是 HTTP 请求体，什么都有可能。写成
 * `AgentRole` 只是骗自己 —— 非法值照样能在运行时进来，而那恰恰是必须挡住的。
 * 类型收窄发生在校验里。
 */
export interface AgentPoolAddInput {
  readonly role: string;
  readonly profileId: string;
  readonly endpoint: string;
  /** 可选：不带 = 空数组。 */
  readonly facts?: readonly AgentPoolFact[];
}

export interface AgentPoolRepository {
  /** 每个 role 内按 order 升序。 */
  list(): Promise<AgentPoolSnapshot>;
  /** 追加一条，返回刚落库的那条。非法 role / 同 role 重复 → throw AgentPoolError。 */
  add(input: AgentPoolAddInput): Promise<AgentPoolCandidate>;
}

/** 候选池规则被违反。形状仿 PlatformRuleError：靠 instanceof + code 判别。 */
export class AgentPoolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgentPoolError';
    this.code = code;
  }
}

/* ------------------------ 三种实现共用的规则 ------------------------ */

/** 把任意取值写成错误信息里看得懂的样子（undefined 与字符串 "undefined" 不是一回事）。 */
function show(value: unknown): string {
  if (value === undefined) return 'undefined（没填）';
  if (typeof value === 'string') return value === '' ? '空串' : `"${value}"`;
  return `${String(value)}（类型 ${value === null ? 'null' : typeof value}）`;
}

function requiredText(value: unknown, field: string, role: AgentRole, code: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new AgentPoolError(
      code,
      `往候选池 ${role} 追加候选时 ${field} 必须是非空字符串，收到：${show(value)}。`,
    );
  }
  // 存 trim 后的值：留着 ' x ' 与 'x' 两份，库里是两行、界面上看着是同一个候选，
  // 而重复检查会放过去 —— 不一致比直接报错更难查。
  return text;
}

/**
 * 不透明键值只过**形状**关，不过语义关。
 *
 * 形状要挡：`facts` 来自请求体，写成 `{"key":...}`（对象而不是数组）或塞进
 * 非字符串值，都会原样存进库，然后在某个不相干的时刻以「适配层收到的不是
 * 数组」的形式炸出来 —— 离出错的地方十万八千里。
 *
 * 语义不挡：键名对不对只有适配层知道。在这里校验键名等于把适配层的表抄一遍。
 */
function normalizeFacts(value: unknown): AgentPoolFact[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AgentPoolError(
      'INVALID_FACTS',
      `facts 必须是 [{key, value}] 形式的数组，收到：${show(value)}。` +
        '这些键值是给适配层看的不透明标识，平台不解释内容，但形状得对。',
    );
  }
  const out: AgentPoolFact[] = [];
  for (const raw of value) {
    const key = (raw as AgentPoolFact | undefined)?.key;
    const itemValue = (raw as AgentPoolFact | undefined)?.value;
    if (typeof key !== 'string' || !key.trim() || typeof itemValue !== 'string') {
      throw new AgentPoolError(
        'INVALID_FACTS',
        `facts 每一项都要有非空的字符串 key 与字符串 value，收到：${show(raw)}。`,
      );
    }
    // 同一个键出现两次时，取到哪一个取决于数组顺序 —— 而适配层只会取第一个。
    // 直接拒掉比"存两份但只有一份生效"诚实。
    if (out.some((fact) => fact.key === key.trim())) {
      throw new AgentPoolError(
        'INVALID_FACTS',
        `facts 里键 "${key.trim()}" 出现了两次；一个键只能有一个值。`,
      );
    }
    out.push({ key: key.trim(), value: itemValue });
  }
  return out;
}

/**
 * 校验 + 归一化 + 定 order。**三种实现必须共用这一个函数。**
 *
 * 各写一份的结局是可预见的：InMemory 允许、PG 因唯一索引拒绝，于是同一份配置
 * 在测试里跑得通、上了数据库就炸。规则只该有一份实现，这条对候选池同样成立。
 *
 * 传入已有的全部行（几十行的配置表读全表不心疼），返回可直接落库的新行。
 */
export function validateAgentPoolAdd(
  input: AgentPoolAddInput,
  existing: readonly AgentPoolRow[],
): AgentPoolRow {
  const role: unknown = input?.role;
  if (role !== 'coordinator' && role !== 'executor' && role !== 'independent_reviewer') {
    throw new AgentPoolError(
      'INVALID_ROLE',
      `候选池的 role 只接受 coordinator、executor 或 independent_reviewer，收到：${show(role)}。` +
        '三种角色是互相独立的候选列表；独立检视者不能复用终审签名的 reviewer。',
    );
  }
  const profileId = requiredText(input?.profileId, 'profileId', role, 'INVALID_PROFILE');
  const endpoint = requiredText(input?.endpoint, 'endpoint', role, 'INVALID_ENDPOINT');
  const facts = normalizeFacts(input?.facts);

  if (existing.some((row) => row.role === role && row.profileId === profileId)) {
    throw new AgentPoolError(
      'DUPLICATE_PROFILE',
      `候选池 ${role} 里已经有 profileId=${profileId}，同一个 role 下不能重复追加。` +
        '要加另一个候选请换一个新的 profileId；' +
        '同一个 profileId 存两份会让 failover 顺序变得说不清。',
    );
  }

  return {
    role,
    profileId,
    endpoint,
    runtime: 'pi',
    facts,
    // order = 该 role 当前条数。只追加不删除，所以它恒等于「插到末尾」。
    order: existing.filter((row) => row.role === role).length,
  };
}

/** 行 → 候选（剥掉 role、复制 facts）。三种实现返回给调用方的都是这一步的结果。 */
export function toAgentPoolCandidate(row: AgentPoolRow): AgentPoolCandidate {
  const { role: _role, ...candidate } = row;
  // facts 必须复制：否则调用方（或一个不小心的界面代码）push 一下，
  // 内存里那行配置就被改了 —— 文件版下次 flush 还会把它写下去。
  return { ...candidate, facts: [...row.facts] };
}

/** 行集 → 按 role 分组、组内 order 升序的快照。三种实现共用。 */
export function agentPoolSnapshot(rows: readonly AgentPoolRow[]): AgentPoolSnapshot {
  const ofRole = (role: AgentRole): AgentPoolCandidate[] =>
    rows
      .filter((row) => row.role === role)
      // 排序在这里做，不依赖存储的返回顺序：PG 不写 ORDER BY 时行序不保证，
      // 而候选顺序直接就是 failover 顺序。
      .slice()
      .sort((a, b) => a.order - b.order)
      .map(toAgentPoolCandidate);
  return {
    coordinator: ofRole('coordinator'),
    executor: ofRole('executor'),
    independent_reviewer: ofRole('independent_reviewer'),
  };
}

/* ------------------------------ 缺省候选 ------------------------------ */

/**
 * 缺省候选 —— 从 run-mission.ts 原来那段硬编码原样搬来，**顺序与内容都不能变**。
 *
 * 这些 profileId 是适配层那边认的身份标识，不是本仓库的内部字符串。写在这一处
 * 只是为了「第一次启动的默认行为与今天完全一致」；换它们应该改候选池而不是改
 * 代码 —— 这正是这一层的存在理由。
 */
export const DEFAULT_AGENT_POOL: readonly {
  readonly role: AgentRole;
  readonly profileId: string;
  readonly endpoint: string;
}[] = [
  { role: 'coordinator', profileId: 'coordinator-grok', endpoint: 'local' },
  { role: 'executor', profileId: 'exec-qwen-flash', endpoint: 'local' },
  { role: 'executor', profileId: 'exec-hy3', endpoint: 'local' },
  { role: 'executor', profileId: 'exec-mimo', endpoint: 'local' },
];

/**
 * 空仓时写入缺省候选，否则原样返回。
 *
 * **只在 `run-mission` 这种"真的要开跑了"的入口调用。不要在 GET 或
 * startServer 里调用**：读路径带副作用，意味着「打开界面看一眼」就会按观察者
 * 那套默认值改写别人的配置，而观测面本来是只读的。
 *
 * 判据是「两边都空」而不是「coordinator 空」：只清空一侧是有人有意为之，
 * 平台不该替他猜要什么候选。
 */
export async function loadPoolOrSeed(repo: AgentPoolRepository): Promise<AgentPoolSnapshot> {
  const snapshot = await repo.list();
  if (snapshot.coordinator.length > 0 || snapshot.executor.length > 0) return snapshot;
  for (const candidate of DEFAULT_AGENT_POOL) await repo.add(candidate);
  return repo.list();
}

/* ------------------------------ 内存实现 ------------------------------ */

/** 一次性运行与测试用。重启即丢 —— 那是它的用途，不是缺陷。 */
export class InMemoryAgentPoolRepository implements AgentPoolRepository {
  #rows: AgentPoolRow[] = [];

  async list(): Promise<AgentPoolSnapshot> {
    return agentPoolSnapshot(this.#rows);
  }

  async add(input: AgentPoolAddInput): Promise<AgentPoolCandidate> {
    const row = validateAgentPoolAdd(input, this.#rows);
    this.#rows.push(row);
    return toAgentPoolCandidate(row);
  }
}
