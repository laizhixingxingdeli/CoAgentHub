/**
 * 文件持久化。
 *
 * 为什么现在就要：`run-mission` 跑完进程就退，全内存的状态跟着没了——
 * 收件箱的全部意义是"结果留着等人来取"，存在内存里等于没有。
 *
 * 为什么**不是** PostgreSQL：单机、单用户、量级是几十条 Mission。整份状态
 * 一次写完全够，而且没有迁移、没有 schema、没有额外进程。真到并发写或者
 * 状态大到一次写不动的时候再换——接口不用改。
 *
 * 写入用"临时文件 + rename"：rename 在同一卷上是原子的，进程半路被杀不会
 * 留下半份 JSON。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { Project } from '../kernel/index.ts';
import type { ValidationReport } from '../kernel/index.ts';
import type { ChangeRequest } from './change-request.ts';
import type { ChangeImpact } from './change-impact.ts';
import type { MissionSnapshot, ProjectSnapshot } from '../kernel/snapshot.ts';
import type {
  ActivityEvent,
  ActivityLog,
  Clock,
  QueuedHopCapacityRepository,
  CommandTransaction,
  FencedCommandTransaction,
  IdGenerator,
  ProjectRepository,
  CandidateCircuitRepository,
} from './ports.ts';
import type { Delivery, DeliveryRepository } from './delivery.ts';
import { withDeliveryKey } from './delivery.ts';
import type {
  AgentPoolAddInput,
  AgentPoolCandidate,
  AgentPoolRepository,
  AgentPoolRow,
  AgentPoolSnapshot,
} from './agent-pool.ts';
import { agentPoolSnapshot, toAgentPoolCandidate, validateAgentPoolAdd, replaceAgentPoolRole, type AgentPoolReplaceInput } from './agent-pool.ts';
import type { QueryRunRecord, QueryRunRepository } from './query-run.ts';
import { claimHop, claimHopWithCandidate, cloneQueuedHop, completeHop, decideCapacityClaim, holdsCurrentClaim, renewHop, reportHopFailure, validateEnqueueHop } from './durable-scheduler.ts';
import type { CapacityClaimResult, ClaimAvailableHopInput, ClaimFence, QueuedHop, ReportHopFailureInput } from './durable-scheduler.ts';
import type { CandidateCircuit, OpenCandidateCircuitInput, ClaimCandidateProbeInput, ResolveCandidateProbeInput } from './candidate-circuit.ts';
import { closedCandidateCircuit, openCandidateCircuit, claimCandidateProbe, resolveCandidateProbe, validateOpenCandidateCircuit, validateClaimCandidateProbe, validateResolveCandidateProbe } from './candidate-circuit.ts';
import {
  cloneValidationReport,
  ValidationReportConflictError,
  validationReportsEqual,
  type ValidationReportRepository,
} from './validation/report-repository.ts';

/** archive 路径段：防目录穿越，也限制文件名长度。 */
const ARCHIVE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface ArchivedMissionRef {
  projectId: string;
  missionId: string;
  archivedAt: string;
  bytes: number;
  sha256: string;
}

/** 旁路 package：mission 快照 + 只属于它的 events/deliveries。 */
interface ArchivedMissionPackage {
  version: 1;
  projectId: string;
  missionId: string;
  archivedAt: string;
  mission: MissionSnapshot;
  events: ActivityEvent[];
  deliveries: Delivery[];
}

interface StateFile {
  version: 1;
  projects: ProjectSnapshot[];
  deliveries: Delivery[];
  events: ActivityEvent[];
  /** id 计数器也要存：不存的话重启后会从 1 重新发号，撞上已有的 id。 */
  idCounters: Record<string, number>;
  /**
   * 候选池。存成带上级 role 的扁平数组，而不是 coordinator / executor 两个数组：
   * 与 PG 那张表同构，换存储不用重排数据，而且 role 只有一个地方能说清楚。
   *
   * 不 bump version：#load() 已经是 `{ ...emptyState(), ...parsed }`，旧文件
   * 缺这个键自然拿到 [] —— bump 只会让所有人的现有状态文件读不了。
   */
  agentPool: AgentPoolRow[];
  /** 已归档索引；package 在 `.coagent-archive/missions/...`。旧文件缺键补 []。 */
  archivedMissions: ArchivedMissionRef[];
  /**
   * 独立 QueryRun 记录。不进 projects / activity / deliveries。
   * 旧文件缺键补 []，不 bump StateFile.version。
   */
  queryRuns: QueryRunRecord[];
  /**
   * 独立 ValidationReport（append-only 机器事实）。
   * 不进 projects / activity / deliveries / archive package。
   * 旧文件缺键补 []，不 bump StateFile.version。
   */
  validationReports: ValidationReport[];
  /**
   * L3 确认的原始变更（append-only）。旧文件缺键补 []，不 bump StateFile.version。
   */
  changeRequests: ChangeRequest[];
  /**
   * 变更影响的判断结论（append-only）。
   * 不进 projects / activity / deliveries / archive package：它是听从侧面、
   * 跟着 ChangeRequest.changeId 走的独立机器事实。旧文件缺键补 []，不 bump。
   */
  changeImpacts: ChangeImpact[];
  queuedHops: QueuedHop[];
  candidateCircuits: CandidateCircuit[];
  candidateCircuitResetEvents?: Array<{ profileId: string; actor: string; at: string; reason: string }>;
}

function packageKey(projectId: string, missionId: string): string {
  return `${projectId}/${missionId}`;
}

/** `dirname(state)/.coagent-archive/missions/<projectId>/<missionId>.json` + containment。 */
function archivedMissionPath(statePath: string, projectId: string, missionId: string): string {
  if (!ARCHIVE_ID_RE.test(projectId)) throw new Error(`状态损坏：archive project id 非法：${projectId}`);
  if (!ARCHIVE_ID_RE.test(missionId)) throw new Error(`状态损坏：archive mission id 非法：${missionId}`);
  const root = resolve(dirname(statePath), '.coagent-archive', 'missions');
  const file = resolve(root, projectId, `${missionId}.json`);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!file.startsWith(prefix)) throw new Error(`状态损坏：archive 路径越界：${projectId}/${missionId}`);
  return file;
}

/** 键序归一化后再比，避免同一快照因插入顺序被误判漂移。 */
function canonicalJson(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) out[k] = canon((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(canon(value));
}

function sortArchiveRefs(refs: readonly ArchivedMissionRef[]): ArchivedMissionRef[] {
  return refs
    .map((ref, index) => ({ ref, index }))
    .sort((a, b) =>
      a.ref.archivedAt < b.ref.archivedAt ? -1 : a.ref.archivedAt > b.ref.archivedAt ? 1 : a.index - b.index,
    )
    .map((row) => row.ref);
}

/**
 * 每次都造一份新的。
 *
 * 不要写成模块级常量再 `{ ...EMPTY }`：那是浅拷贝，里面的数组会被所有实例
 * 共享，于是两个本该隔离的状态文件互相串数据——测试里表现为「另一个
 * Mission 的事件出现在我的 Timeline 里」。
 */
function emptyState(): StateFile {
  return {
    version: 1,
    projects: [],
    deliveries: [],
    events: [],
    idCounters: {},
    agentPool: [],
    archivedMissions: [],
    queryRuns: [],
    validationReports: [],
    changeRequests: [],
    changeImpacts: [],
    queuedHops: [],
    candidateCircuits: [],
  };
}

/** 从已有 Q-N 抬高 idCounters.Q，避免重启后 next('Q') 撞号。只在 load 时跑一次。 */
function seedQueryRunIdCounter(state: StateFile): void {
  let high = state.idCounters.Q ?? 0;
  for (const run of state.queryRuns) {
    if (!run || typeof run.id !== 'string') continue;
    const match = /^Q-(\d+)$/.exec(run.id);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > high) high = n;
  }
  if (high > (state.idCounters.Q ?? 0)) state.idCounters.Q = high;
}

/** 从已有 VR-N 抬高 idCounters.VR，避免重启后 next('VR') 撞号。只在 load 时跑一次。 */
function seedValidationReportIdCounter(state: StateFile): void {
  let high = state.idCounters.VR ?? 0;
  for (const report of state.validationReports) {
    if (!report || typeof report.id !== 'string') continue;
    const match = /^VR-(\d+)$/.exec(report.id);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > high) high = n;
  }
  if (high > (state.idCounters.VR ?? 0)) state.idCounters.VR = high;
}

function cloneQueryRunRecord(run: QueryRunRecord): QueryRunRecord {
  return {
    ...run,
    usage: { ...run.usage },
    ...(run.toolCalls ? { toolCalls: Object.freeze([...run.toolCalls]) } : {}),
  };
}

/**
 * 开事务那一刻的样子：回滚就回到这里（C2）。
 *
 * 发号计数不在内：单调递增，跳号无害；回滚反而会让已经发出去的号被重发。
 */
interface OpenTransaction {
  readonly projects: Map<string, ProjectSnapshot>;
  readonly events: ActivityEvent[];
  readonly deliveries: Delivery[];
  readonly queryRuns: QueryRunRecord[];
  readonly validationReports: ValidationReport[];
  readonly changeRequests: ChangeRequest[];
  readonly changeImpacts: ChangeImpact[];
  readonly agentPool: AgentPoolRow[];
  readonly archivedMissions: ArchivedMissionRef[];
  readonly queuedHops: QueuedHop[];
  readonly candidateCircuits: CandidateCircuit[];
  /** 事务结束（提交或回滚）时兑现：事务外的写在这上面等。 */
  readonly done: Promise<void>;
  readonly finish: () => void;
}

/**
 * Windows 上杀软 / 索引器 / 同步盘会**短暂**占住刚写完的临时文件或目标文件，
 * 让 rename 抛 EPERM / EBUSY / EACCES。这不是真失败，隔几毫秒再来就好。
 * 为什么只认这三个码：其它错误（权限真不对、路径不存在、盘满）重试也没用，
 * 早抛能让上层事务立刻回滚，而不是被白白拖满两秒。
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** 最多试 10 次（含首次）；退避总等待 < 1s，封顶 2s，绝不让一次落盘卡住常驻服务。 */
const RENAME_MAX_ATTEMPTS = 10;
const RENAME_MAX_WAIT_MS = 2_000;

/** 同步退避：#write 是同步路径，不能 await；也不引依赖。 */
function renameBackoff(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 原子替换文件的函数签名；默认 renameSync，测试注入假实现。 */
export type RenameFile = (from: string, to: string) => void;

/**
 * 整份状态的持有者。三个仓储都挂在它上面，任何一个写完都触发一次落盘。
 *
 * **单事务命令（C2）。** `run(fn)` 里的写（活对象、事件、投递、各记录、发号）不单独落盘，
 * fn 结束后一次原子写（临时文件 + rename）；fn 抛错或这次写失败，内存回到开事务时的样子、
 * 盘上还是之前的文件。事务外的异步写先等开着的事务结束（`settle`），同步落盘推迟到它结束——
 * 否则别处的一次落盘会把事务的半截改动带下去，或者被它的回滚一起抹掉。
 */
export class FileStateStore implements CommandTransaction, FencedCommandTransaction {
  #path: string;
  #state: StateFile;
  /** 还原出来的聚合实例。落盘时重新取快照，读的时候直接给活对象。 */
  #projects = new Map<string, Project>();
  /** 已加载 package；events/deliveries 只活在这里，不进 raw main。 */
  #archivedPackages = new Map<string, ArchivedMissionPackage>();
  /** hydrate 时 archived mission 基线（restore→toSnapshot）；flush 前比对防漂移。 */
  #archivedBaselines = new Map<string, MissionSnapshot>();
  /** 上次读到/写出的文件 mtime，用来判断有没有被别的进程改过。 */
  #stamp = 0;
  /** 开着的命令事务；同一时刻至多一个。 */
  #tx: OpenTransaction | undefined;
  /** 事务里的调用链带着它：据此分清「事务里的写」和「事务开着时别处的写」。 */
  #txContext = new AsyncLocalStorage<OpenTransaction>();
  /** 事务串行：后一个等前一个结束。 */
  #txQueue: Promise<void> = Promise.resolve();
  /** 事务开着时别处要落盘：推迟到事务结束一起写。 */
  #deferredFlush = false;
  /** 原子替换文件的实现；默认 renameSync，测试可注入以模拟 Windows 短暂拒绝。 */
  #rename: RenameFile;

  constructor(path: string, options: { rename?: RenameFile } = {}) {
    this.#path = resolve(path);
    this.#rename = options.rename ?? renameSync;
    this.#state = this.#load();
    this.#hydrate();
    this.#stamp = this.#mtime();
  }

  #hydrate(): void {
    this.#projects.clear();
    this.#archivedPackages.clear();
    this.#archivedBaselines.clear();
    if (!Array.isArray(this.#state.archivedMissions)) this.#state.archivedMissions = [];
    const refs = this.#state.archivedMissions;
    for (const ref of refs) {
      const key = packageKey(ref.projectId, ref.missionId);
      if (this.#archivedPackages.has(key)) {
        throw new Error(`状态损坏：archive index 重复：${key}`);
      }
      this.#archivedPackages.set(key, this.#readArchivedPackage(ref));
    }

    const merged = new Map<string, ProjectSnapshot>();
    for (const snapshot of this.#state.projects) {
      merged.set(snapshot.id, { id: snapshot.id, missions: [...(snapshot.missions ?? [])] });
    }
    for (const ref of sortArchiveRefs(refs)) {
      const key = packageKey(ref.projectId, ref.missionId);
      const pkg = this.#archivedPackages.get(key)!;
      let project = merged.get(ref.projectId);
      if (!project) {
        project = { id: ref.projectId, missions: [] };
        merged.set(ref.projectId, project);
      }
      if (project.missions.some((m) => m.id === ref.missionId)) {
        throw new Error(`状态损坏：archived mission 与 working 重复：${key}`);
      }
      project.missions.push(pkg.mission);
    }

    for (const snapshot of merged.values()) {
      const project = Project.restore(snapshot);
      this.#projects.set(project.id, project);
      for (const mission of project.toSnapshot().missions) {
        const key = packageKey(project.id, mission.id);
        if (this.#archivedPackages.has(key)) this.#archivedBaselines.set(key, mission);
      }
    }
  }

  #readArchivedPackage(ref: ArchivedMissionRef): ArchivedMissionPackage {
    const label = `${ref.projectId}/${ref.missionId}`;
    const path = archivedMissionPath(this.#path, ref.projectId, ref.missionId);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`状态损坏：archive package 缺失：${label}`);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`状态损坏：archive package 读取失败：${label} —— ${detail}`);
    }
    if (bytes.byteLength !== ref.bytes) throw new Error(`状态损坏：archive package bytes 不匹配：${label}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== ref.sha256) throw new Error(`状态损坏：archive package hash 不匹配：${label}`);
    let parsed: ArchivedMissionPackage;
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as ArchivedMissionPackage;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`状态损坏：archive package JSON 无效：${label} —— ${detail}`);
    }
    if (parsed.version !== 1) {
      throw new Error(`状态损坏：archive package 版本不认识：${parsed.version}（${label}）`);
    }
    if (parsed.projectId !== ref.projectId || parsed.missionId !== ref.missionId) {
      throw new Error(`状态损坏：archive package id 与 index 不一致：${label}`);
    }
    if (parsed.archivedAt !== ref.archivedAt) {
      throw new Error(`状态损坏：archive package archivedAt 与 index 不一致：${label}`);
    }
    if (!parsed.mission || typeof parsed.mission !== 'object') {
      throw new Error(`状态损坏：archive package mission 无效：${label}`);
    }
    if (parsed.mission.id !== ref.missionId) {
      throw new Error(`状态损坏：archive package mission.id 与 index 不一致：${label}`);
    }
    if (
      'projectId' in parsed.mission &&
      parsed.mission.projectId !== undefined &&
      parsed.mission.projectId !== ref.projectId
    ) {
      throw new Error(`状态损坏：archive package mission.projectId 与 index 不一致：${label}`);
    }
    if (!Array.isArray(parsed.events)) {
      throw new Error(`状态损坏：archive package events 无效：${label}`);
    }
    if (!Array.isArray(parsed.deliveries)) {
      throw new Error(`状态损坏：archive package deliveries 无效：${label}`);
    }
    for (const delivery of parsed.deliveries) {
      if (delivery.status !== 'acknowledged') {
        throw new Error(`状态损坏：archive package 含未确认投递：${label}（${delivery.id}）`);
      }
    }
    return parsed;
  }

  /** 归档体被改过就不能写 main：先 hydrate 回滚，再抛 ARCHIVED_MISSION_MUTATED。 */
  #assertArchivedUnchanged(): void {
    try {
      for (const project of this.#projects.values()) {
        for (const mission of project.toSnapshot().missions) {
          const baseline = this.#archivedBaselines.get(packageKey(mission.projectId, mission.id));
          if (!baseline) continue;
          if (canonicalJson(mission) !== canonicalJson(baseline)) {
            throw new Error(`ARCHIVED_MISSION_MUTATED: ${mission.projectId}/${mission.id}`);
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('ARCHIVED_MISSION_MUTATED')) {
        this.#state = this.#load();
        this.#hydrate();
      }
      throw error;
    }
  }

  #mtime(): number {
    try {
      return statSync(this.#path).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * 如果文件被**别的进程**改过，就重新读一遍。
   *
   * 为什么需要：观测面是常驻的，而 `run-mission` 是另一个进程在写。不重载
   * 的话，页面上看到的永远是服务器启动那一刻的快照——跑着的 Mission 在
   * 界面上纹丝不动，比没有界面更误导。
   *
   * 只在**读路径**上调用。自己写完之后 #stamp 会同步更新，不会把自己的
   * 改动当成外部改动再读回来。
   */
  refreshIfChanged(): void {
    // 事务开着时不重读：重读会换掉事务正在改的活对象，提交时写下去的就不是这个事务了。
    if (this.#tx) return;
    const mtime = this.#mtime();
    if (mtime === this.#stamp) return;
    this.#state = this.#load();
    this.#hydrate();
    this.#stamp = mtime;
  }

  #load(): StateFile {
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as StateFile;
      if (parsed.version !== 1) {
        throw new Error(`状态文件版本不认识：${parsed.version}（本程序只认 1）`);
      }
      const state = { ...emptyState(), ...parsed };
      if (!Array.isArray(state.archivedMissions)) state.archivedMissions = [];
      if (!Array.isArray(state.queryRuns)) state.queryRuns = [];
      if (!Array.isArray(state.validationReports)) state.validationReports = [];
      if (!Array.isArray(state.changeRequests)) state.changeRequests = [];
      if (!Array.isArray(state.changeImpacts)) state.changeImpacts = [];
      if (!Array.isArray(state.queuedHops)) state.queuedHops = [];
      if (!Array.isArray(state.candidateCircuits)) state.candidateCircuits = [];
      // 加键之前写下的投递行按旧规则补键：去重从此只看键（C1）。
      state.deliveries = state.deliveries.map(withDeliveryKey);
      seedQueryRunIdCounter(state);
      seedValidationReportIdCounter(state);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      // 读不动但文件存在 = 数据可能损坏。**不要静默重置**：那会把用户的
      // Mission 历史一声不吭地抹掉。直接失败，让人看见。
      throw new Error(
        `状态文件读取失败：${this.#path} —— ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 把当前活对象的快照写回磁盘。
   *
   * 事务开着时不写：事务里的写等提交时一起落盘；事务外的写推迟到事务结束（提交或回滚之后）。
   */
  flush(): void {
    if (this.#tx) {
      if (this.#txContext.getStore() !== this.#tx) this.#deferredFlush = true;
      return;
    }
    this.#write();
  }

  /**
   * 命令事务（C2）。嵌套调用并进外层事务；事务之间串行。
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#tx && this.#txContext.getStore() === this.#tx) return fn();
    const previous = this.#txQueue;
    let release!: () => void;
    this.#txQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const tx = this.#begin();
    this.#tx = tx;
    try {
      let result: T;
      try {
        result = await this.#txContext.run(tx, fn);
      } catch (error) {
        this.#abort(tx);
        throw error;
      }
      this.#tx = undefined;
      try {
        this.#write();
      } catch (error) {
        // 提交写失败：临时文件没写成或没 rename，盘上还是之前的文件；内存也回去。
        this.#abort(tx);
        throw error;
      }
      return result;
    } finally {
      this.#tx = undefined;
      this.#deferredFlush = false;
      tx.finish();
      release();
    }
  }

  /**
   * 同一命令事务内核对领取后再跑 fn。失败抛错，走 run 的回滚；不要在这里 catch，
   * 嵌套进外层 run 时吞掉错误会让外层把半截写入提交掉。
   */
  async runFenced<T>(fence: ClaimFence, fn: () => Promise<T>): Promise<T> {
    return this.run(async () => {
      const rows = this.#state.queuedHops;
      const hop = Array.isArray(rows) ? rows.find((row) => row.id === fence.id) : undefined;
      if (!holdsCurrentClaim(hop, fence)) throw new Error('claim fence rejected');
      return fn();
    });
  }

  /**
   * 事务外的写先等开着的事务结束：写进一个开着的事务，它回滚时会被一起抹掉。事务里的调用直接过。
   */
  async settle(): Promise<void> {
    while (this.#tx && this.#txContext.getStore() !== this.#tx) await this.#tx.done;
  }

  #begin(): OpenTransaction {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const s = this.#state;
    return {
      projects: new Map([...this.#projects].map(([id, project]) => [id, project.toSnapshot()])),
      events: [...s.events],
      deliveries: [...s.deliveries],
      queryRuns: [...s.queryRuns],
      validationReports: [...s.validationReports],
      changeRequests: [...s.changeRequests],
      changeImpacts: [...s.changeImpacts],
      agentPool: [...s.agentPool],
      archivedMissions: [...s.archivedMissions],
      queuedHops: [...s.queuedHops],
      candidateCircuits: [...s.candidateCircuits],
      done,
      finish,
    };
  }

  /** 回到开事务时的样子。只换掉改过的活对象：没动过的实例原样留着，别处手里的引用照样有效。 */
  #abort(tx: OpenTransaction): void {
    for (const [id, project] of [...this.#projects]) {
      const before = tx.projects.get(id);
      if (!before) {
        this.#projects.delete(id);
        continue;
      }
      if (JSON.stringify(project.toSnapshot()) !== JSON.stringify(before)) {
        this.#projects.set(id, Project.restore(before));
      }
    }
    for (const [id, before] of tx.projects) {
      if (!this.#projects.has(id)) this.#projects.set(id, Project.restore(before));
    }
    const s = this.#state;
    s.events = tx.events;
    s.deliveries = tx.deliveries;
    s.queryRuns = tx.queryRuns;
    s.validationReports = tx.validationReports;
    s.changeRequests = tx.changeRequests;
    s.changeImpacts = tx.changeImpacts;
    s.agentPool = tx.agentPool;
    s.archivedMissions = tx.archivedMissions;
    s.queuedHops = tx.queuedHops;
    s.candidateCircuits = tx.candidateCircuits;
    this.#tx = undefined;
    if (this.#deferredFlush) {
      this.#deferredFlush = false;
      try {
        this.#write();
      } catch {
        // 别处推迟的那次写：内存里的状态是对的，下一次落盘会带上。
      }
    }
  }

  #write(): void {
    this.#assertArchivedUnchanged();

    const archivedIds = new Map<string, Set<string>>();
    for (const ref of this.#state.archivedMissions) {
      const set = archivedIds.get(ref.projectId) ?? new Set<string>();
      set.add(ref.missionId);
      archivedIds.set(ref.projectId, set);
    }

    // 内存含完整史；落 main 时滤掉已索引 archived，不得嵌回。
    this.#state.projects = [...this.#projects.values()].map((project) => {
      const snapshot = project.toSnapshot();
      const drop = archivedIds.get(snapshot.id);
      return {
        id: snapshot.id,
        missions: drop ? snapshot.missions.filter((m) => !drop.has(m.id)) : snapshot.missions,
      };
    });

    mkdirSync(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.#state, null, 2)}\n`, 'utf8');
    this.#renameRetryingTransient(temp, this.#path);
    // 自己写的不算外部改动：不更新这个戳，下一次读会把刚写的再读一遍，
    // 白白丢掉内存里的活对象。
    this.#stamp = this.#mtime();
  }

  /**
   * 主状态 temp → path 的原子替换：只对短暂错误码作有界退避重试。
   *
   * 重试耗尽或遇到非短暂错误都原样抛出——调用方（run 的提交 / flush）据此走
   * 原有的事务内存回滚，盘上仍是旧文件。所以这里**不能**吞错，也不能自作主张
   * 换文件名落盘。
   */
  #renameRetryingTransient(from: string, to: string): void {
    let wait = 5;
    let waited = 0;
    for (let attempt = 1; ; attempt += 1) {
      try {
        this.#rename(from, to);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        const transient = TRANSIENT_RENAME_CODES.has(code);
        if (!transient || attempt >= RENAME_MAX_ATTEMPTS || waited + wait > RENAME_MAX_WAIT_MS) {
          throw error;
        }
        renameBackoff(wait);
        waited += wait;
        wait = Math.min(wait * 2, 200);
      }
    }
  }

  get path(): string {
    return this.#path;
  }

  /* -------- 下面三个是给各仓储用的内部访问口，不是公共 API -------- */

  projectsMap(): Map<string, Project> {
    return this.#projects;
  }

  raw(): StateFile {
    return this.#state;
  }

  hasArchivedMission(missionId: string): boolean {
    return this.#state.archivedMissions.some((ref) => ref.missionId === missionId);
  }

  archivedEvents(missionId: string): readonly ActivityEvent[] {
    for (const pkg of this.#archivedPackages.values()) {
      if (pkg.missionId === missionId) return pkg.events;
    }
    return [];
  }

  /** main + package events；package 按 archivedAt/index 稳定接上。 */
  allEventsMerged(): ActivityEvent[] {
    const merged = [...this.#state.events];
    for (const ref of sortArchiveRefs(this.#state.archivedMissions)) {
      const pkg = this.#archivedPackages.get(packageKey(ref.projectId, ref.missionId));
      if (pkg) merged.push(...pkg.events);
    }
    return merged;
  }

  findArchivedDelivery(deliveryId: string): Delivery | undefined {
    for (const pkg of this.#archivedPackages.values()) {
      const found = pkg.deliveries.find((row) => row.id === deliveryId);
      // 归档包有 sha256 钉着，不改盘上内容；读出来的副本补键。
      if (found) return withDeliveryKey(found);
    }
    return undefined;
  }

  /**
   * 显式归档单条终态 Mission：package 旁路落盘后从 main working set 裁掉。
   * 不自动触发；重复调用幂等。
   */
  archiveMission(projectId: string, missionId: string): void {
    if (this.#tx) throw new Error('命令事务进行中，不能归档');
    this.refreshIfChanged();

    // id 合法性 / 路径 containment 与 A 同一套。
    const finalPath = archivedMissionPath(this.#path, projectId, missionId);
    const key = packageKey(projectId, missionId);

    if (
      this.#state.archivedMissions.some(
        (ref) => ref.projectId === projectId && ref.missionId === missionId,
      )
    ) {
      return;
    }

    const project = this.#projects.get(projectId);
    if (!project) throw new Error(`不可归档：Project 不存在：${projectId}`);
    const mission = project.missions.find((row) => row.id === missionId);
    if (!mission) throw new Error(`不可归档：Mission 不存在：${key}`);
    const documents = new Map<string, { state: string }>();
    for (const event of this.#state.events) {
      if (event.missionId === missionId && event.kind === 'document.proposal_changed') {
        const data = event.data as { id: string; state: string }; documents.set(data.id, data);
      }
    }
    if ([...documents.values()].some((row) => !['committed', 'withdrawn'].includes(row.state))) {
      throw new Error(`不可归档：Mission 尚有未处理的文档提议：${key}`);
    }

    if (mission.isPaused) {
      throw new Error(`不可归档：Mission 已暂停：${key}`);
    }
    if (mission.status !== 'completed' && mission.status !== 'blocked') {
      throw new Error(`不可归档：Mission 非终态（completed|blocked）：${mission.status}`);
    }

    const missionSnap = mission.toSnapshot();
    const attempts = [
      ...missionSnap.coordinatorAttempts,
      ...missionSnap.workItems.flatMap((item) => item.attempts),
    ];
    if (attempts.some((attempt) => attempt.status === 'in_progress')) {
      throw new Error(`不可归档：存在进行中的 Attempt：${key}`);
    }

    if (
      this.#state.deliveries.some(
        (row) => row.missionId === missionId && row.status === 'pending',
      )
    ) {
      throw new Error(`不可归档：存在未确认投递：${key}`);
    }

    const events = this.#state.events.filter((event) => event.missionId === missionId);
    const deliveries = this.#state.deliveries.filter((row) => row.missionId === missionId);

    const mainStamp = this.#stamp;
    const stable = {
      projectId,
      missionId,
      mission: missionSnap,
      events,
      deliveries,
    };

    let pkg: ArchivedMissionPackage;
    let bytes: number;
    let sha256: string;

    if (existsSync(finalPath)) {
      const existingBytes = readFileSync(finalPath);
      let existing: ArchivedMissionPackage;
      try {
        existing = JSON.parse(existingBytes.toString('utf8')) as ArchivedMissionPackage;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`COMPACT_PACKAGE_CONFLICT: ${key} —— package JSON 无效：${detail}`);
      }
      if (existing.version !== 1) {
        throw new Error(`COMPACT_PACKAGE_CONFLICT: ${key} —— package 版本不认识`);
      }
      const existingStable = {
        projectId: existing.projectId,
        missionId: existing.missionId,
        mission: existing.mission,
        events: existing.events,
        // 加键之前写下的包：主状态那边的同一批投递已在读入时补键，这边按同一规则补了再比。
        deliveries: Array.isArray(existing.deliveries) ? existing.deliveries.map(withDeliveryKey) : existing.deliveries,
      };
      if (canonicalJson(existingStable) !== canonicalJson(stable)) {
        throw new Error(`COMPACT_PACKAGE_CONFLICT: ${key}`);
      }
      pkg = existing;
      bytes = existingBytes.byteLength;
      sha256 = createHash('sha256').update(existingBytes).digest('hex');
    } else {
      pkg = {
        version: 1,
        projectId,
        missionId,
        archivedAt: new Date().toISOString(),
        mission: missionSnap,
        events,
        deliveries,
      };
      const body = `${JSON.stringify(pkg)}\n`;
      const buf = Buffer.from(body, 'utf8');
      bytes = buf.byteLength;
      sha256 = createHash('sha256').update(buf).digest('hex');
      this.#writeArchivedPackageAtomic(finalPath, body);
    }

    // package 已落盘（或复用）后、改 index/内存前核对 main 未被并发改写。
    if (this.#mtime() !== mainStamp) {
      this.#state = this.#load();
      this.#hydrate();
      this.#stamp = this.#mtime();
      throw new Error('COMPACT_RACE');
    }

    this.#state.archivedMissions.push({
      projectId,
      missionId,
      archivedAt: pkg.archivedAt,
      bytes,
      sha256,
    });
    this.#archivedPackages.set(key, pkg);

    const baseline = project.toSnapshot().missions.find((row) => row.id === missionId);
    if (baseline) this.#archivedBaselines.set(key, baseline);

    this.#state.events = this.#state.events.filter((event) => event.missionId !== missionId);
    this.#state.deliveries = this.#state.deliveries.filter((row) => row.missionId !== missionId);

    try {
      this.flush();
    } catch (error) {
      this.#state = this.#load();
      this.#hydrate();
      this.#stamp = this.#mtime();
      throw error;
    }
  }

  /** package：temp write → fsync → rename final；调用方保证 final 尚不存在。 */
  #writeArchivedPackageAtomic(finalPath: string, body: string): void {
    mkdirSync(dirname(finalPath), { recursive: true });
    const temp = `${finalPath}.tmp`;
    const fd = openSync(temp, 'w');
    try {
      writeSync(fd, body, undefined, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (existsSync(finalPath)) {
      try {
        // 竞态下 final 已出现：不覆盖；留给上层复用/冲突逻辑。清理 temp。
        unlinkSync(temp);
      } catch {
        /* ignore */
      }
      throw new Error(`COMPACT_PACKAGE_EXISTS: ${finalPath}`);
    }
    renameSync(temp, finalPath);
  }
}

export class FileProjectRepository implements ProjectRepository {
  #store: FileStateStore;

  constructor(store: FileStateStore) {
    this.#store = store;
  }

  async get(projectId: string): Promise<Project | undefined> {
    this.#store.refreshIfChanged();
    return this.#store.projectsMap().get(projectId);
  }

  async save(project: Project): Promise<void> {
    await this.#store.settle();
    this.#store.projectsMap().set(project.id, project);
    this.#store.flush();
  }

  async list(): Promise<readonly Project[]> {
    this.#store.refreshIfChanged();
    return [...this.#store.projectsMap().values()];
  }

  async ensure(projectId: string): Promise<Project> {
    await this.#store.settle();
    const existing = this.#store.projectsMap().get(projectId);
    if (existing) return existing;
    const created = Project.create({ id: projectId });
    this.#store.projectsMap().set(projectId, created);
    this.#store.flush();
    return created;
  }

  /**
   * 落盘。
   *
   * 平台的用例直接改活对象，很多路径不会调 save()——所以需要一个显式的
   * "现在写下去"。调用方是 API 层：每个写请求处理完调一次。比在每个用例里
   * 散落 flush 更难漏。
   */
  persist(): void {
    this.#store.flush();
  }
}

export class FileDeliveryRepository implements DeliveryRepository {
  #store: FileStateStore;
  #clock: Clock;
  #ids: IdGenerator;

  constructor(store: FileStateStore, clock: Clock, ids: IdGenerator) {
    this.#store = store;
    this.#clock = clock;
    this.#ids = ids;
  }

  async create(
    input: Omit<Delivery, 'id' | 'createdAt' | 'status' | 'acknowledgedAt'>,
  ): Promise<Delivery> {
    await this.#store.settle();
    if (this.#store.hasArchivedMission(input.missionId)) {
      throw new Error(`已归档 Mission 不可新建投递：${input.missionId}`);
    }
    const rows = this.#store.raw().deliveries;
    const existing = rows.find(
      (row) => row.missionId === input.missionId && withDeliveryKey(row).idempotencyKey === input.idempotencyKey,
    );
    if (existing) return existing;
    const delivery: Delivery = {
      ...input,
      id: this.#ids.next('D'),
      createdAt: this.#clock.now().toISOString(),
      status: 'pending',
    };
    rows.push(delivery);
    this.#store.flush();
    return delivery;
  }

  async pending(recipient?: string): Promise<readonly Delivery[]> {
    this.#store.refreshIfChanged();
    return this.#store
      .raw()
      .deliveries.filter(
        (row) => row.status === 'pending' && (!recipient || row.recipient === recipient),
      );
  }

  async acknowledge(deliveryId: string): Promise<Delivery | undefined> {
    await this.#store.settle();
    const rows = this.#store.raw().deliveries;
    const index = rows.findIndex((row) => row.id === deliveryId);
    if (index < 0) return undefined;
    if (rows[index].status === 'acknowledged') return rows[index];
    rows[index] = {
      ...rows[index],
      status: 'acknowledged',
      acknowledgedAt: this.#clock.now().toISOString(),
    };
    this.#store.flush();
    return rows[index];
  }

  async get(deliveryId: string): Promise<Delivery | undefined> {
    this.#store.refreshIfChanged();
    const main = this.#store.raw().deliveries.find((row) => row.id === deliveryId);
    if (main) return main;
    return this.#store.findArchivedDelivery(deliveryId);
  }

  async listForMission(missionId: string): Promise<readonly Delivery[]> {
    this.#store.refreshIfChanged();
    // 只看工作集：归档包有 hash 钉着，补建不得靠读包来「已存在」而漏掉跳过。
    return this.#store
      .raw()
      .deliveries.filter((row) => row.missionId === missionId)
      .map(withDeliveryKey);
  }
}

export class FileActivityLog implements ActivityLog {
  #store: FileStateStore;
  #clock: Clock;

  constructor(store: FileStateStore, clock: Clock) {
    this.#store = store;
    this.#clock = clock;
  }

  async append(event: Omit<ActivityEvent, 'at'>): Promise<void> {
    await this.#store.settle();
    if (this.#store.hasArchivedMission(event.missionId)) {
      throw new Error(`已归档 Mission 不可追加事件：${event.missionId}`);
    }
    this.#store.raw().events.push({ ...event, at: this.#clock.now().toISOString() });
    this.#store.flush();
  }

  async list(missionId: string): Promise<readonly ActivityEvent[]> {
    this.#store.refreshIfChanged();
    if (this.#store.hasArchivedMission(missionId)) {
      return this.#store.archivedEvents(missionId);
    }
    return this.#store.raw().events.filter((event) => event.missionId === missionId);
  }

  async all(): Promise<readonly ActivityEvent[]> {
    this.#store.refreshIfChanged();
    return this.#store.allEventsMerged();
  }
}

/**
 * 会跨重启继续的发号器。
 *
 * 内存版每次重启都从 1 开始，会发出已经存在的 id——Mission 里的 W-1 被重复
 * 使用时，DUPLICATE_ID 是最好的结果，最坏的是写进别人的工作项。
 */
export class PersistentIds implements IdGenerator {
  #store: FileStateStore;

  constructor(store: FileStateStore) {
    this.#store = store;
  }

  next(prefix: string): string {
    const counters = this.#store.raw().idCounters;
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    this.#store.flush();
    return `${prefix}-${counters[prefix]}`;
  }
}

/**
 * QueryRun 的文件仓储。
 *
 * 与 deliveries / events 同挂在 StateFile 上，走既有 flush / 原子写；
 * 同 id replace/upsert，不进 projects / activity / deliveries。
 */
export class FileQueryRunRepository implements QueryRunRepository {
  #store: FileStateStore;

  constructor(store: FileStateStore) {
    this.#store = store;
  }

  async save(run: QueryRunRecord): Promise<void> {
    await this.#store.settle();
    this.#store.refreshIfChanged();
    const rows = this.#rows();
    const copy = cloneQueryRunRecord(run);
    const index = rows.findIndex((row) => row.id === run.id);
    if (index >= 0) rows[index] = copy;
    else rows.push(copy);
    this.#store.flush();
  }

  async get(id: string): Promise<QueryRunRecord | undefined> {
    this.#store.refreshIfChanged();
    const found = this.#rows().find((row) => row.id === id);
    return found ? cloneQueryRunRecord(found) : undefined;
  }

  async list(projectId?: string): Promise<readonly QueryRunRecord[]> {
    this.#store.refreshIfChanged();
    const rows = this.#rows();
    const filtered =
      projectId === undefined ? rows : rows.filter((row) => row.projectId === projectId);
    return filtered.map(cloneQueryRunRecord);
  }

  #rows(): QueryRunRecord[] {
    const state = this.#store.raw();
    if (!Array.isArray(state.queryRuns)) state.queryRuns = [];
    return state.queryRuns;
  }
}

/**
 * ValidationReport 的文件仓储。
 *
 * append-only：同 id 结构相同幂等；不同则 conflict。不进 archive package。
 */
export class FileQueuedHopRepository implements QueuedHopCapacityRepository {
  #store: FileStateStore;
  constructor(store: FileStateStore) { this.#store = store; }

  async enqueue(hop: QueuedHop): Promise<QueuedHop> {
    const { status: _status, owner: _owner, leaseUntil: _leaseUntil, claimGeneration: _generation, ...input } = hop;
    validateEnqueueHop(input);
    if (typeof hop.id !== 'string' || hop.id.trim().length === 0 || hop.status !== 'queued' ||
        typeof hop.createdAt !== 'string' || !Number.isFinite(Date.parse(hop.createdAt)) ||
        typeof hop.updatedAt !== 'string' || !Number.isFinite(Date.parse(hop.updatedAt))) {
      throw new Error('queued hop record is invalid');
    }
    return this.#store.run(async () => {
      const rows = this.#rows();
      const existing = rows.find((row) => row.idempotencyKey === hop.idempotencyKey);
      if (existing) return { ...existing };
      const copy = { ...hop };
      rows.push(copy);
      return { ...copy };
    });
  }

  async claim(id: string, owner: string, now: string, leaseUntil: string): Promise<QueuedHop | undefined> {
    return this.#transition(id, (row) => claimHop(row, owner, now, leaseUntil));
  }

  /**
   * 容量占用只认盘上有效租约。必须在同一单写者临界段里读完整队列再写回选中项：
   * 先 list 再 claim 会让两个领取都看见同一个空位，把五维上限打穿。
   * 等待或空队列不改任何行，避免把候选 B 的 runtime/profile 写到候选 A 上。
   */
  async claimAvailable(input: ClaimAvailableHopInput): Promise<CapacityClaimResult> {
    return this.#store.run(async () => {
      const rows = this.#rows();
      const decision = decideCapacityClaim(rows, input.now, input.limits, input.eligible);
      if (decision.kind !== 'select') {
        if (decision.kind === 'waiting') {
          return { kind: 'waiting' as const, hop: { ...decision.hop }, wait: decision.wait };
        }
        return { kind: 'empty' as const };
      }
      const updated = claimHopWithCandidate(
        decision.hop,
        input.owner,
        input.now,
        input.leaseUntil,
        decision.candidate,
      );
      if (!updated) return { kind: 'empty' as const };
      const index = rows.findIndex((row) => row.id === updated.id);
      if (index < 0) return { kind: 'empty' as const };
      rows[index] = updated;
      return { kind: 'claimed' as const, hop: { ...updated } };
    });
  }

  async renew(id: string, owner: string, claimGeneration: number, now: string, leaseUntil: string): Promise<QueuedHop | undefined> {
    return this.#transition(id, (row) => renewHop(row, owner, claimGeneration, now, leaseUntil));
  }

  async complete(id: string, owner: string, claimGeneration: number, now: string): Promise<QueuedHop | undefined> {
    return this.#transition(id, (row) => completeHop(row, owner, claimGeneration, now));
  }

  async reportFailure(input: ReportHopFailureInput): Promise<QueuedHop | undefined> {
    return this.#transition(input.id, (row) => reportHopFailure(row, input));
  }

  async #transition(id: string, transition: (row: QueuedHop) => QueuedHop | undefined): Promise<QueuedHop | undefined> {
    return this.#store.run(async () => {
      const rows = this.#rows();
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return undefined;
      const current = rows[index]!;
      const updated = transition(current);
      if (!updated) return undefined;
      // Same reference = idempotent/no-op: writing would still be a new snapshot.
      if (updated !== current) rows[index] = updated;
      return cloneQueuedHop(updated);
    });
  }

  async get(id: string): Promise<QueuedHop | undefined> {
    this.#store.refreshIfChanged();
    const row = this.#rows().find((item) => item.id === id);
    return row ? cloneQueuedHop(row) : undefined;
  }

  async list(): Promise<readonly QueuedHop[]> {
    this.#store.refreshIfChanged();
    return this.#rows().map((row) => cloneQueuedHop(row));
  }

  #rows(): QueuedHop[] {
    const state = this.#store.raw();
    if (!Array.isArray(state.queuedHops)) state.queuedHops = [];
    return state.queuedHops;
  }
}

export class FileValidationReportRepository implements ValidationReportRepository {
  #store: FileStateStore;

  constructor(store: FileStateStore) {
    this.#store = store;
  }

  async save(report: ValidationReport): Promise<void> {
    await this.#store.settle();
    this.#store.refreshIfChanged();
    const rows = this.#rows();
    const existing = rows.find((row) => row.id === report.id);
    if (existing) {
      if (validationReportsEqual(existing, report)) return;
      throw new ValidationReportConflictError(report.id);
    }
    // 存 clone；不 freeze/mutate caller 原对象。
    rows.push(cloneValidationReport(report));
    this.#store.flush();
  }

  async get(reportId: string): Promise<ValidationReport | undefined> {
    this.#store.refreshIfChanged();
    const found = this.#rows().find((row) => row.id === reportId);
    return found ? cloneValidationReport(found) : undefined;
  }

  #rows(): ValidationReport[] {
    const state = this.#store.raw();
    if (!Array.isArray(state.validationReports)) state.validationReports = [];
    return state.validationReports;
  }
}

/**
 * 候选池的文件实现。
 *
 * 为什么不并进 ProjectRepository / Platform：候选池是运维配置，不是 Mission
 * 状态。塞进聚合快照等于让「谁可用」跟着 Mission 历史一起被重写、被版本号
 * 管并发冲突 —— 改一次配置会把所有在途 Project 的版本顶旧。
 *
 * 读路径先 refreshIfChanged()：写配置的可能是另一个进程（run-mission 播种、
 * API 追加），而观测面是常驻的。不重载就永远看不见对方追加的候选。
 */
export class FileAgentPoolRepository implements AgentPoolRepository {
  #store: FileStateStore;

  constructor(store: FileStateStore) {
    this.#store = store;
  }

  async list(): Promise<AgentPoolSnapshot> {
    this.#store.refreshIfChanged();
    return agentPoolSnapshot(this.#rows());
  }

  async replaceRole(input: AgentPoolReplaceInput): Promise<AgentPoolSnapshot> {
    return this.#store.run(async () => {
      this.#store.refreshIfChanged();
      const rows = replaceAgentPoolRole(input, this.#rows());
      this.#store.raw().agentPool = rows;
      this.#store.flush();
      return agentPoolSnapshot(rows);
    });
  }

  async add(input: AgentPoolAddInput): Promise<AgentPoolCandidate> {
    await this.#store.settle();
    // 校验前先看磁盘上的最新内容：不刷新的话，两个进程都以为自己是某个
    // profileId 的首个持有者，各自算出 order=0 往回写，后写的把先写的整片盖掉
    // （文件版是整份 JSON 重写，盖的是整个数组）。
    this.#store.refreshIfChanged();
    const rows = this.#rows();
    const row = validateAgentPoolAdd(input, rows);
    rows.push(row);
    this.#store.flush();
    return toAgentPoolCandidate(row);
  }

  /**
   * 拿到磁盘上那份**数组本身**（不是副本）—— add() 要往里 push 后才能被 flush 写回。
   *
   * 状态文件是人会手改的东西，所以两个约不到的字段在这归一化：缺 agentPool 给
   * []，缺 facts 给 []。不归一化的话，组装快照时的 `[...facts]` 会在一个完整的
   * 配置行上招 TypeError —— 而报错的地方离真正写坏的地方隔着一整个重启。
   */
  #rows(): AgentPoolRow[] {
    const state = this.#store.raw();
    if (!Array.isArray(state.agentPool)) state.agentPool = [];
    for (let index = 0; index < state.agentPool.length; index += 1) {
      const row = state.agentPool[index];
      if (!Array.isArray(row?.facts)) state.agentPool[index] = { ...row, facts: [] };
    }
    return state.agentPool;
  }
}

/** File-backed per-profile circuit; serialized by FileStateStore's single-writer transaction discipline. */
export class FileCandidateCircuitRepository implements CandidateCircuitRepository {
  #store: FileStateStore;
  constructor(store: FileStateStore) { this.#store = store; }

  async get(profileId: string): Promise<CandidateCircuit> {
    this.#store.refreshIfChanged();
    const row = this.#rows().find((item) => item.profileId === profileId);
    return row ? { ...row } : closedCandidateCircuit(profileId);
  }

  async open(input: OpenCandidateCircuitInput): Promise<CandidateCircuit> {
    validateOpenCandidateCircuit(input);
    await this.#store.settle();
    this.#store.refreshIfChanged();
    return this.#store.run(async () => {
      const row = openCandidateCircuit(input);
      const rows = this.#rows();
      const index = rows.findIndex((item) => item.profileId === input.profileId);
      if (index < 0) rows.push(row); else rows[index] = row;
      this.#store.flush();
      return { ...row };
    });
  }

  async tryClaimProbe(input: ClaimCandidateProbeInput): Promise<boolean> {
    validateClaimCandidateProbe(input);
    await this.#store.settle();
    this.#store.refreshIfChanged();
    return this.#store.run(async () => {
      const rows = this.#rows();
      const index = rows.findIndex((item) => item.profileId === input.profileId);
      if (index < 0) return false;
      const claimed = claimCandidateProbe(rows[index] as Extract<CandidateCircuit, { state: 'open' | 'half_open' }>, input.now);
      if (!claimed) return false;
      rows[index] = claimed;
      this.#store.flush();
      return true;
    });
  }

  async reset(input: { profileId: string; actor: string; at: string; reason: string }): Promise<CandidateCircuit> {
    for (const key of ['profileId', 'actor', 'at', 'reason'] as const) if (!input[key]?.trim()) throw new Error(`${key} must be non-empty`);
    await this.#store.settle();
    this.#store.refreshIfChanged();
    return this.#store.run(async () => {
      const rows = this.#rows();
      const index = rows.findIndex((item) => item.profileId === input.profileId);
      if (index < 0 || rows[index]?.state === 'closed') throw new Error(index < 0 ? 'candidate circuit does not exist' : 'candidate circuit is closed');
      rows[index] = closedCandidateCircuit(input.profileId);
      const state = this.#store.raw();
      if (!Array.isArray(state.candidateCircuitResetEvents)) state.candidateCircuitResetEvents = [];
      state.candidateCircuitResetEvents.push({ ...input });
      this.#store.flush();
      return { ...rows[index] };
    });
  }

  async listResetEvents(profileId?: string): Promise<Array<{ profileId: string; actor: string; at: string; reason: string }>> {
    this.#store.refreshIfChanged();
    const events = this.#store.raw().candidateCircuitResetEvents ?? [];
    return events.filter((event) => profileId === undefined || event.profileId === profileId).map((event) => ({ ...event }));
  }

  async resolveProbe(input: ResolveCandidateProbeInput): Promise<CandidateCircuit> {
    validateResolveCandidateProbe(input);
    await this.#store.settle();
    this.#store.refreshIfChanged();
    return this.#store.run(async () => {
      const rows = this.#rows();
      const index = rows.findIndex((item) => item.profileId === input.profileId);
      const result = resolveCandidateProbe(index < 0 ? undefined : rows[index], input);
      if (index < 0) rows.push(result); else rows[index] = result;
      this.#store.flush();
      return { ...result };
    });
  }

  #rows(): CandidateCircuit[] {
    const state = this.#store.raw();
    if (!Array.isArray(state.candidateCircuits)) state.candidateCircuits = [];
    return state.candidateCircuits;
  }
}
