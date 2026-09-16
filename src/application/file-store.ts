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

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Project } from '../kernel/index.ts';
import type { ProjectSnapshot } from '../kernel/snapshot.ts';
import type { ActivityEvent, ActivityLog, Clock, IdGenerator, ProjectRepository } from './ports.ts';
import type { Delivery, DeliveryRepository } from './delivery.ts';
import type {
  AgentPoolAddInput,
  AgentPoolCandidate,
  AgentPoolRepository,
  AgentPoolRow,
  AgentPoolSnapshot,
} from './agent-pool.ts';
import { agentPoolSnapshot, toAgentPoolCandidate, validateAgentPoolAdd } from './agent-pool.ts';

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
  };
}

/**
 * 整份状态的持有者。三个仓储都挂在它上面，任何一个写完都触发一次落盘。
 */
export class FileStateStore {
  #path: string;
  #state: StateFile;
  /** 还原出来的聚合实例。落盘时重新取快照，读的时候直接给活对象。 */
  #projects = new Map<string, Project>();
  /** 上次读到/写出的文件 mtime，用来判断有没有被别的进程改过。 */
  #stamp = 0;

  constructor(path: string) {
    this.#path = resolve(path);
    this.#state = this.#load();
    this.#hydrate();
    this.#stamp = this.#mtime();
  }

  #hydrate(): void {
    this.#projects.clear();
    for (const snapshot of this.#state.projects) {
      this.#projects.set(snapshot.id, Project.restore(snapshot));
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
      return { ...emptyState(), ...parsed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      // 读不动但文件存在 = 数据可能损坏。**不要静默重置**：那会把用户的
      // Mission 历史一声不吭地抹掉。直接失败，让人看见。
      throw new Error(
        `状态文件读取失败：${this.#path} —— ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 把当前活对象的快照写回磁盘。 */
  flush(): void {
    this.#state.projects = [...this.#projects.values()].map((project) => project.toSnapshot());
    mkdirSync(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.#state, null, 2)}\n`, 'utf8');
    renameSync(temp, this.#path);
    // 自己写的不算外部改动：不更新这个戳，下一次读会把刚写的再读一遍，
    // 白白丢掉内存里的活对象。
    this.#stamp = this.#mtime();
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
    this.#store.projectsMap().set(project.id, project);
    this.#store.flush();
  }

  async list(): Promise<readonly Project[]> {
    this.#store.refreshIfChanged();
    return [...this.#store.projectsMap().values()];
  }

  async ensure(projectId: string): Promise<Project> {
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
    const rows = this.#store.raw().deliveries;
    const existing = rows.find(
      (row) => row.missionId === input.missionId && row.outcome === input.outcome,
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
    return this.#store.raw().deliveries.find((row) => row.id === deliveryId);
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
    this.#store.raw().events.push({ ...event, at: this.#clock.now().toISOString() });
    this.#store.flush();
  }

  async list(missionId: string): Promise<readonly ActivityEvent[]> {
    this.#store.refreshIfChanged();
    return this.#store.raw().events.filter((event) => event.missionId === missionId);
  }

  async all(): Promise<readonly ActivityEvent[]> {
    return [...this.#store.raw().events];
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

  async add(input: AgentPoolAddInput): Promise<AgentPoolCandidate> {
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
