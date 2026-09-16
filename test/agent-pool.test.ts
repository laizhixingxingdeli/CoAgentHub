/**
 * 候选池：端口、三种实现、播种、HTTP 面。
 *
 * 为什么把断言写成一份、三种实现各跑一遍：这三种实现**必须**给出同一套语义，
 * 否则就是同一个 bug 的三个版本 —— InMemory 允许而 PG 因唯一索引拒绝，意味着
 * 「测试里跑得通的配置，上了数据库才炸」。分开写三份断言正好会把这种分歧当成
 * 理所当然。
 *
 * PG 那组没有可用的库时整组 skip，不报红：文件版仍是默认存储，
 * 「装了数据库才能跑测试」会让这个仓库变难上手（同 test/pg-store.test.ts）。
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import {
  AgentPoolError,
  InMemoryAgentPoolRepository,
  loadPoolOrSeed,
} from '../src/application/agent-pool.ts';
import type {
  AgentPoolRepository,
  AgentPoolSnapshot,
} from '../src/application/agent-pool.ts';
import { FileAgentPoolRepository, FileStateStore } from '../src/application/file-store.ts';
import { PgAgentPoolRepository, PgStateStore } from '../src/application/pg-store.ts';
import { ensureTestDatabase } from './helpers/pg.ts';
import { createApi } from '../src/api/server.ts';
import { buildPlatform } from '../src/main.ts';

/** 缺省那四条。字面量在这里出现是刻意的：断言的就是「与原来那四条一致」。 */
const DEFAULT_COORDINATOR = 'coordinator-grok';
const DEFAULT_EXECUTORS = ['exec-qwen-flash', 'exec-hy3', 'exec-mimo'];

/** node:test 的 t，只用到 skip。 */
type T = { skip: (reason?: string) => void };

async function expectPoolError(
  run: () => Promise<unknown>,
  code: string,
  messageParts: readonly string[],
): Promise<AgentPoolError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AgentPoolError, `该抛 AgentPoolError，实际：${String(caught)}`);
  const error = caught as AgentPoolError;
  assert.equal(error.code, code);
  assert.equal(error.name, 'AgentPoolError');
  // message 是给界面与模型**原样显示**的话，所以它必须说清是哪一条、为什么。
  // 只断言 code 的话一句 "invalid" 也能过，而那句话对人没用。
  for (const part of messageParts) {
    assert.ok(
      error.message.includes(part),
      `message 里该有「${part}」，实际：${error.message}`,
    );
  }
  return error;
}

/**
 * 一份端口契约的断言，三种实现共用。
 *
 * 工厂每个用例调一次，拿到的是**干净的**仓储（用例之间不共享数据）。
 * skip 是 PG 那组用的：没有库就整组跳，而不是让它红。
 */
function behavesLikeThePort(
  makeRepo: () => Promise<AgentPoolRepository> | AgentPoolRepository,
  skip?: (t: T) => boolean,
) {
  test('空仓的 list 形状对，两个 role 都是空数组', async (t: T) => {
    if (skip?.(t)) return;
    const repo = await makeRepo();
    const snapshot: AgentPoolSnapshot = await repo.list();
    assert.deepEqual(snapshot, { coordinator: [], executor: [] });
  });

  test('add 返回刚落库的那条：runtime 恒为 pi，order 从 0 起、按 role 独立计数', async (t: T) => {
    if (skip?.(t)) return;
    const repo = await makeRepo();
    const first = await repo.add({ role: 'executor', profileId: 'a', endpoint: 'local' });
    assert.deepEqual(first, {
      profileId: 'a',
      endpoint: 'local',
      runtime: 'pi',
      order: 0,
      facts: [],
    });
    const second = await repo.add({ role: 'executor', profileId: 'b', endpoint: 'local' });
    assert.equal(second.order, 1, '同 role 内递增');
    const other = await repo.add({ role: 'coordinator', profileId: 'c', endpoint: 'local' });
    assert.equal(other.order, 0, '另一个 role 从头计');

    const snapshot = await repo.list();
    assert.deepEqual(snapshot.executor.map((row) => row.order), [0, 1], 'list 按 order 升序');
    assert.deepEqual(snapshot.coordinator.map((row) => row.profileId), ['c']);
  });

  test('非法 role 被挡，message 说清只接受哪两个、收到了什么', async (t: T) => {
    if (skip?.(t)) return;
    const repo = await makeRepo();
    await expectPoolError(
      () => repo.add({ role: 'watcher', profileId: 'a', endpoint: 'local' }),
      'INVALID_ROLE',
      ['coordinator', 'executor', 'watcher'],
    );
    // 没填也算非法 role，不能悄悄当成 coordinator。
    await expectPoolError(
      () => repo.add({ profileId: 'a', endpoint: 'local' } as never),
      'INVALID_ROLE',
      ['undefined'],
    );
    assert.deepEqual(await repo.list(), { coordinator: [], executor: [] }, '被挡的不该留下半个字');
  });

  test('同 role 下重复 profileId 被挡，message 点名 role 与 profileId', async (t: T) => {
    if (skip?.(t)) return;
    const repo = await makeRepo();
    await repo.add({ role: 'coordinator', profileId: 'same', endpoint: 'local' });
    await expectPoolError(
      () => repo.add({ role: 'coordinator', profileId: 'same', endpoint: 'other' }),
      'DUPLICATE_PROFILE',
      ['coordinator', 'same'],
    );
  });

  test('不同 role 允许相同 profileId —— 两套候选列表是各自独立的', async (t: T) => {
    if (skip?.(t)) return;
    const repo = await makeRepo();
    const asCoord = await repo.add({ role: 'coordinator', profileId: 'twin', endpoint: 'local' });
    const asExec = await repo.add({ role: 'executor', profileId: 'twin', endpoint: 'local' });
    assert.deepEqual(
      { coord: asCoord.order, exec: asExec.order },
      { coord: 0, exec: 0 },
    );
    const snapshot = await repo.list();
    assert.deepEqual(snapshot.coordinator.map((row) => row.profileId), ['twin']);
    assert.deepEqual(snapshot.executor.map((row) => row.profileId), ['twin']);
  });

  test('profileId / endpoint 缺或空串都拒 —— 空串存进去会在界面上凭空多一条', async (t: T) => {
    if (skip?.(t)) return;
    const repo = await makeRepo();
    await expectPoolError(
      () => repo.add({ role: 'executor', profileId: '   ', endpoint: 'local' }),
      'INVALID_PROFILE',
      ['profileId'],
    );
    await expectPoolError(
      () => repo.add({ role: 'executor', endpoint: 'local' } as never),
      'INVALID_PROFILE',
      ['profileId'],
    );
    await expectPoolError(
      () => repo.add({ role: 'executor', profileId: 'x', endpoint: '' }),
      'INVALID_ENDPOINT',
      ['endpoint'],
    );
    assert.deepEqual(await repo.list(), { coordinator: [], executor: [] });
  });

  test('首尾空白被收掉，不会被当成两条不同的候选', async (t: T) => {
    if (skip?.(t)) return;
    const repo = await makeRepo();
    const added = await repo.add({
      role: 'executor',
      profileId: '  padded  ',
      endpoint: ' local ',
    });
    assert.equal(added.profileId, 'padded');
    assert.equal(added.endpoint, 'local');
    await expectPoolError(
      () => repo.add({ role: 'executor', profileId: 'padded', endpoint: 'local' }),
      'DUPLICATE_PROFILE',
      ['padded'],
    );
  });

  test('facts 原样存原样取：平台不解释它，但也不能丢它', async (t: T) => {
    if (skip?.(t)) return;
    const repo = await makeRepo();
    const facts = [
      { key: 'anything', value: 'from-adapter' },
      { key: 'another', value: '第二個' },
    ];
    await repo.add({ role: 'executor', profileId: 'with-facts', endpoint: 'local', facts });
    const [row] = (await repo.list()).executor;
    assert.deepEqual(row.facts, facts, '键与值都必须一字不改');

    // 形状不对的必须挡：存进去会在**别人**那里炸，报错点离写它的地方十万八千里。
    await expectPoolError(
      () =>
        repo.add({
          role: 'executor',
          profileId: 'bad-1',
          endpoint: 'local',
          facts: { key: 'k' } as never,
        }),
      'INVALID_FACTS',
      ['facts'],
    );
    await expectPoolError(
      () => repo.add({ role: 'executor', profileId: 'bad-2', endpoint: 'local', facts: ['k'] as never }),
      'INVALID_FACTS',
      ['facts'],
    );
    assert.deepEqual(
      (await repo.list()).executor.map((row2) => row2.profileId),
      ['with-facts'],
      '被拒的那条不该留下',
    );
  });

  test('取回来的快照改了不影响仓储里的内容（否则会凭空改配置）', async (t: T) => {
    if (skip?.(t)) return;
    const repo = await makeRepo();
    await repo.add({
      role: 'executor',
      profileId: 'mutable',
      endpoint: 'local',
      facts: [{ key: 'k', value: 'v' }],
    });
    const snapshot = await repo.list();
    snapshot.executor[0].facts.push({ key: 'injected', value: 'x' });
    snapshot.executor.pop();
    const again = await repo.list();
    assert.deepEqual(again.executor.map((row) => row.profileId), ['mutable']);
    assert.deepEqual(again.executor[0].facts, [{ key: 'k', value: 'v' }]);
  });
}

/* ------------------------------- 内存实现 ------------------------------- */

describe('InMemoryAgentPoolRepository', () => {
  behavesLikeThePort(() => new InMemoryAgentPoolRepository());
});

/* -------------------------------- 文件实现 -------------------------------- */

const tempDirs: string[] = [];
function tempPath(name = 'state.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-pool-'));
  tempDirs.push(dir);
  return join(dir, name);
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('FileAgentPoolRepository', () => {
  behavesLikeThePort(() => new FileAgentPoolRepository(new FileStateStore(tempPath())));

  test('跨进程可见：A 写入，另一个 store 实例 list 看得到', async () => {
    const path = tempPath();
    const a = new FileAgentPoolRepository(new FileStateStore(path));
    const b = new FileAgentPoolRepository(new FileStateStore(path));

    await a.add({ role: 'coordinator', profileId: 'from-a', endpoint: 'local' });
    const seen = await b.list();
    assert.deepEqual(seen.coordinator.map((row) => row.profileId), ['from-a']);
    // 光"读得到"还不够：B 必须知道这条已被占用，否则它会再插一条同名的，
    // 而 A 下一次读到的就是两条一样的候选。
    await expectPoolError(
      () => b.add({ role: 'coordinator', profileId: 'from-a', endpoint: 'local' }),
      'DUPLICATE_PROFILE',
      ['from-a'],
    );
  });

  test('两个实例交替追加，order 连续且不覆盖对方的行', async () => {
    const path = tempPath();
    const a = new FileAgentPoolRepository(new FileStateStore(path));
    const b = new FileAgentPoolRepository(new FileStateStore(path));

    await a.add({ role: 'executor', profileId: 'one', endpoint: 'local' });
    await b.add({ role: 'executor', profileId: 'two', endpoint: 'local' });
    await a.add({ role: 'executor', profileId: 'three', endpoint: 'local' });
    assert.deepEqual((await a.list()).executor.map((row) => row.profileId), [
      'one',
      'two',
      'three',
    ]);
    assert.deepEqual((await a.list()).executor.map((row) => row.order), [0, 1, 2]);
  });

  test('落在状态文件里且不 bump version；旧状态文件照样能读', async () => {
    const path = tempPath();
    const store = new FileStateStore(path);
    await new FileAgentPoolRepository(store).add({
      role: 'executor',
      profileId: 'persisted',
      endpoint: 'local',
      facts: [{ key: 'opaque', value: 'yes' }],
    });

    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number;
      agentPool: Record<string, unknown>[];
    };
    // #load() 已经是 { ...emptyState(), ...parsed }，所以加字段不需要 bump version；
    // bump 反而会让所有人现有的状态文件读不了。
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.agentPool[0].profileId, 'persisted');
    assert.deepEqual(parsed.agentPool[0].facts, [{ key: 'opaque', value: 'yes' }]);

    // 没有 agentPool 这个键的旧文件必须照样能读。
    const legacy = tempPath('legacy.json');
    writeFileSync(legacy, JSON.stringify({ version: 1, projects: [], idCounters: {} }), 'utf8');
    const reopened = new FileAgentPoolRepository(new FileStateStore(legacy));
    assert.deepEqual(await reopened.list(), { coordinator: [], executor: [] });
    const added = await reopened.add({
      role: 'executor',
      profileId: 'after-legacy',
      endpoint: 'local',
    });
    assert.equal(added.order, 0);
  });

  test('播种过的文件 store，换一个新进程实例读得到且不再播', async () => {
    const path = tempPath();
    const seeded = await loadPoolOrSeed(new FileAgentPoolRepository(new FileStateStore(path)));
    const reopened = await loadPoolOrSeed(
      new FileAgentPoolRepository(new FileStateStore(path)),
    );
    assert.deepEqual(reopened, seeded);
    assert.equal(reopened.coordinator.length, 1);
    assert.equal(reopened.executor.length, DEFAULT_EXECUTORS.length);
  });
});

/* ------------------------------ Postgres 实现 ------------------------------ */

let pgStore: PgStateStore | undefined;
let pgAvailable = false;
let pgDsn = '';

before(async () => {
  try {
    const target = await ensureTestDatabase();
    if (!target) return;
    pgDsn = target;
    pgStore = await PgStateStore.open({ connectionString: pgDsn });
    // 只清自己这张表。别的表是本仓库其它 PG 用例的，碰不得（见 helpers/pg.ts）。
    await pgStore.pool.query('TRUNCATE agent_pool');
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

after(async () => {
  // 测完清场：常驻的观测面与别人手工建的候选不该被测试留在库里。
  if (pgAvailable && pgStore) {
    await pgStore.pool.query('TRUNCATE agent_pool').catch(() => undefined);
  }
  await pgStore?.close();
});

function skipIfNoPg(t: T): boolean {
  if (!pgAvailable) {
    t.skip('没有可用的 Postgres —— 文件版仍是默认存储，这组跳过');
    return true;
  }
  return false;
}

describe('PgAgentPoolRepository', () => {
  /**
   * 共用一个 store 连接池、每个用例前清表。
   *
   * 不每个用例 open 一个新 store：那会漏掉一堆连接池，测试跑完进程退不干净。
   * 跨进程那几个用例自己 open 第二个 store 并在 finally 里 close。
   */
  const repoForCase = async (): Promise<AgentPoolRepository> => {
    const store = pgStore as PgStateStore;
    await store.pool.query('TRUNCATE agent_pool');
    return new PgAgentPoolRepository(store);
  };

  behavesLikeThePort(repoForCase, skipIfNoPg);

  test('跨进程可见：两个 store 实例对同一个库互相看得见', async (t) => {
    if (skipIfNoPg(t)) return;
    const store = pgStore as PgStateStore;
    await store.pool.query('TRUNCATE agent_pool');
    const a = new PgAgentPoolRepository(store);
    const other = await PgStateStore.open({ connectionString: pgDsn });
    try {
      const b = new PgAgentPoolRepository(other);
      await a.add({ role: 'coordinator', profileId: 'pg-from-a', endpoint: 'local' });
      const seen = await b.list();
      assert.deepEqual(seen.coordinator.map((row) => row.profileId), ['pg-from-a']);
      await expectPoolError(
        () => b.add({ role: 'coordinator', profileId: 'pg-from-a', endpoint: 'local' }),
        'DUPLICATE_PROFILE',
        ['pg-from-a'],
      );
      // 反向也要成立：B 写的 A 看得见，而且 order 接着走，不是各算各的。
      await b.add({ role: 'coordinator', profileId: 'pg-from-b', endpoint: 'local' });
      assert.deepEqual((await a.list()).coordinator.map((row) => row.order), [0, 1]);
    } finally {
      await other.close();
    }
  });

  test('list 每次都真查库，不走 projects 那套内存缓存', async (t) => {
    if (skipIfNoPg(t)) return;
    const store = pgStore as PgStateStore;
    await store.pool.query('TRUNCATE agent_pool');
    const repo = new PgAgentPoolRepository(store);
    assert.equal((await repo.list()).executor.length, 0);

    const other = await PgStateStore.open({ connectionString: pgDsn });
    try {
      await new PgAgentPoolRepository(other).add({
        role: 'executor',
        profileId: 'written-elsewhere',
        endpoint: 'local',
      });
      const after = await repo.list();
      assert.deepEqual(after.executor.map((row) => row.profileId), ['written-elsewhere']);
    } finally {
      await other.close();
    }
  });

  test('facts 落 jsonb 再读回来，一字不改', async (t) => {
    if (skipIfNoPg(t)) return;
    const repo = await repoForCase();
    const facts = [{ key: 'opaque-key', value: '值 with 空格' }];
    await repo.add({ role: 'executor', profileId: 'facts-row', endpoint: 'local', facts });
    const [row] = (await repo.list()).executor;
    assert.deepEqual(row.facts, facts);
  });

  test('主键是最后一道防线：绕过校验的双写不会存出两行', async (t) => {
    if (skipIfNoPg(t)) return;
    const store = pgStore as PgStateStore;
    await store.pool.query('TRUNCATE agent_pool');
    const insert = () =>
      store.pool.query(
        `INSERT INTO agent_pool (role, profile_id, endpoint, runtime, ord)
         VALUES ('executor', 'race', 'local', 'pi', 0)`,
      );
    await insert();
    // 两个进程同时算出 order=0 并同时 INSERT：第二条必须被主键挡下。
    await assert.rejects(
      () => insert(),
      (error: unknown) => (error as { code?: string }).code === '23505',
    );
    const rows = await store.pool.query(
      "SELECT ord FROM agent_pool WHERE role = 'executor' AND profile_id = 'race'",
    );
    assert.equal(rows.rowCount, 1);
    // 经仓储再走一次，拿到的是可懂的 409 语义而不是数据库错误码。
    await expectPoolError(
      () => new PgAgentPoolRepository(store).add({ role: 'executor', profileId: 'race', endpoint: 'local' }),
      'DUPLICATE_PROFILE',
      ['race'],
    );
  });
});

/* --------------------------------- 播种 --------------------------------- */

describe('loadPoolOrSeed', () => {
  test('空仓写入那四条缺省，顺序与原来 run-mission 的硬编码一致', async () => {
    const snapshot = await loadPoolOrSeed(new InMemoryAgentPoolRepository());
    assert.deepEqual(snapshot.coordinator.map((row) => row.profileId), [DEFAULT_COORDINATOR]);
    assert.deepEqual(snapshot.executor.map((row) => row.profileId), DEFAULT_EXECUTORS);
    assert.deepEqual(snapshot.coordinator.map((row) => row.endpoint), ['local']);
    assert.deepEqual(snapshot.executor.map((row) => row.endpoint), [
      'local',
      'local',
      'local',
    ]);
    assert.deepEqual(snapshot.coordinator.map((row) => row.order), [0]);
    assert.deepEqual(snapshot.executor.map((row) => row.order), [0, 1, 2]);
    for (const row of [...snapshot.coordinator, ...snapshot.executor]) {
      assert.equal(row.runtime, 'pi');
    }
  });

  test('再调一次不会重复播种', async () => {
    const repo = new InMemoryAgentPoolRepository();
    const first = await loadPoolOrSeed(repo);
    const again = await loadPoolOrSeed(repo);
    assert.deepEqual(again, first);
    assert.equal(again.coordinator.length, 1);
    assert.equal(again.executor.length, 3);
  });

  test('非空仓不覆盖：只有一侧为空时也不动它', async () => {
    const repo = new InMemoryAgentPoolRepository();
    await repo.add({ role: 'executor', profileId: 'mine', endpoint: 'local' });
    const snapshot = await loadPoolOrSeed(repo);
    assert.deepEqual(snapshot.executor.map((row) => row.profileId), ['mine']);
    // 判据是「两边都空」。只清了 coordinator 的人是有意的，不该替他猜。
    assert.deepEqual(snapshot.coordinator, []);
  });
});

/* -------------------------- run-mission 不再硬编码 -------------------------- */

describe('run-mission.ts 改用候选池', () => {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const source = readFileSync(join(repoRoot, 'src/run-mission.ts'), 'utf8');

  test('调用 loadPoolOrSeed 并把快照交给调度器', () => {
    assert.match(source, /loadPoolOrSeed\(/, '空仓播种必须发生在 run-mission 这一侧');
    assert.match(source, /pool\.coordinator/, '协调者候选来自快照');
    assert.match(source, /pool\.executor/, '执行者候选来自快照');
  });

  test('四条缺省候选的字面量只该出现在 agent-pool.ts', () => {
    const literals = [DEFAULT_COORDINATOR, ...DEFAULT_EXECUTORS];
    for (const literal of literals) {
      assert.ok(!source.includes(literal), `run-mission.ts 里还留着 ${literal}`);
    }
    // 扫整棵 src/ 的 TS 源码：这是"默认值"，只该有一份定义处。散落多处时
    // 改一处忘另一处，于是播种出来的东西取决于哪条代码先跑。
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return walk(full);
        return name.endsWith('.ts') ? [full] : [];
      });
    const offenders = walk(join(repoRoot, 'src'))
      .filter((file) => !file.endsWith('agent-pool.ts'))
      .filter((file) => literals.some((literal) => readFileSync(file, 'utf8').includes(literal)));
    assert.deepEqual(offenders, [], `${offenders.join(', ')} 里不该再出现缺省候选的字面量`);
  });
});

/* --------------------------------- HTTP --------------------------------- */

describe('候选池 API', () => {
  async function withApi(agentPool?: AgentPoolRepository) {
    const built = buildPlatform();
    const server = createApi({
      platform: built.platform,
      tokens: built.tokens,
      deliveries: built.deliveries,
      ...(agentPool ? { agentPool } : {}),
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, close: () => server.close() };
  }

  async function get(base: string, path: string) {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, json: (await res.json()) as Record<string, never> };
  }

  async function post(base: string, path: string, body: unknown) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, never> };
  }

  test('GET 空仓形状对；POST 追加后 GET 看得见，每条含 profileId/endpoint/runtime/order', async () => {
    const { base, close } = await withApi(new InMemoryAgentPoolRepository());
    try {
      const empty = await get(base, '/api/pools');
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.json, { coordinator: [], executor: [] });

      const created = await post(base, '/api/pools', {
        role: 'coordinator',
        profileId: DEFAULT_COORDINATOR,
        endpoint: 'local',
      });
      assert.equal(created.status, 201);
      assert.deepEqual(created.json, {
        role: 'coordinator',
        profileId: DEFAULT_COORDINATOR,
        endpoint: 'local',
        runtime: 'pi',
        order: 0,
        facts: [],
      });

      await post(base, '/api/pools', { role: 'executor', profileId: 'e1', endpoint: 'local' });
      await post(base, '/api/pools', {
        role: 'executor',
        profileId: 'e2',
        endpoint: 'local',
        facts: [{ key: 'opaque', value: 'v' }],
      });

      const list = await get(base, '/api/pools');
      assert.equal(list.status, 200);
      const snapshot = list.json as unknown as AgentPoolSnapshot & {
        coordinator: { role?: string }[];
      };
      assert.equal(snapshot.coordinator.length, 1);
      assert.equal(snapshot.executor.length, 2);
      assert.deepEqual(snapshot.executor.map((row) => row.order), [0, 1]);
      for (const row of [...snapshot.coordinator, ...snapshot.executor]) {
        assert.equal(typeof row.profileId, 'string');
        assert.equal(typeof row.endpoint, 'string');
        assert.equal(row.runtime, 'pi', 'runtime 恒为 pi');
        assert.equal(typeof row.order, 'number');
      }
      assert.deepEqual(snapshot.executor[1].facts, [{ key: 'opaque', value: 'v' }]);
      assert.equal(snapshot.coordinator[0].role, undefined, '元素不带 role，看它在哪个数组就知道');
    } finally {
      close();
    }
  });

  test('非法 role 与同 role 重复都返回 409，message 非空', async () => {
    const { base, close } = await withApi(new InMemoryAgentPoolRepository());
    try {
      const badRole = await post(base, '/api/pools', {
        role: 'overseer',
        profileId: 'x',
        endpoint: 'local',
      });
      assert.equal(badRole.status, 409);
      assert.equal(badRole.json.error, 'INVALID_ROLE');
      assert.ok(String(badRole.json.message).includes('overseer'));

      await post(base, '/api/pools', { role: 'executor', profileId: 'dup', endpoint: 'local' });
      const dup = await post(base, '/api/pools', {
        role: 'executor',
        profileId: 'dup',
        endpoint: 'local',
      });
      assert.equal(dup.status, 409);
      assert.equal(dup.json.error, 'DUPLICATE_PROFILE');
      assert.ok(String(dup.json.message).length > 0, '界面会原样显示这句话，空串等于没报错');
      assert.ok(String(dup.json.message).includes('dup'));
    } finally {
      close();
    }
  });

  test('GET /api/pools 不播种 —— 只读路径不能带副作用', async () => {
    const { base, close } = await withApi(new InMemoryAgentPoolRepository());
    try {
      for (const _round of [1, 2, 3]) {
        const list = await get(base, '/api/pools');
        assert.deepEqual(list.json, { coordinator: [], executor: [] });
      }
    } finally {
      close();
    }
  });

  test('接在文件实现上的 API 与另一个进程共享同一份配置', async () => {
    const path = tempPath();
    const { base, close } = await withApi(
      new FileAgentPoolRepository(new FileStateStore(path)),
    );
    try {
      await post(base, '/api/pools', {
        role: 'executor',
        profileId: 'via-http',
        endpoint: 'local',
      });
      // 另一个 store 实例 = 另一个进程。
      const elsewhere = await new FileAgentPoolRepository(
        new FileStateStore(path),
      ).list();
      assert.deepEqual(elsewhere.executor.map((row) => row.profileId), ['via-http']);
    } finally {
      close();
    }
  });

  test('不传 agentPool 的 createApi 照样能起来（回归：这个参数必须是可选的）', async () => {
    const { base, close } = await withApi(undefined);
    try {
      const health = await get(base, '/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);

      const list = await get(base, '/api/pools');
      assert.equal(list.status, 200);
      assert.deepEqual(list.json, { coordinator: [], executor: [] });

      const created = await post(base, '/api/pools', {
        role: 'coordinator',
        profileId: 'default-repo',
        endpoint: 'local',
      });
      assert.equal(created.status, 201);
    } finally {
      close();
    }
  });

  test('POST 之外没有别的写方法，也不支持改/删', async () => {
    const { base, close } = await withApi(new InMemoryAgentPoolRepository());
    try {
      await post(base, '/api/pools', { role: 'executor', profileId: 'keep', endpoint: 'local' });
      for (const method of ['DELETE', 'PATCH', 'PUT']) {
        const res = await fetch(`${base}/api/pools`, { method });
        assert.ok(
          res.status === 404 || res.status === 405,
          `${method} /api/pools 不该被支持，实际 ${res.status}`,
        );
      }
      const after = await get(base, '/api/pools');
      assert.deepEqual(
        (after.json as unknown as AgentPoolSnapshot).executor.map((row) => row.profileId),
        ['keep'],
      );
    } finally {
      close();
    }
  });
});

/* --------------------------- 资源池页（src/web/pool.js） --------------------------- */

/**
 * 资源池页的渲染。
 *
 * 正式页在这个仓库里**不在测试的浏览器里**，所以"字段名读错了"在界面上是
 * 没有声音的：ExecutionProfile 那一列永远是 —，页面照样跑。纯函数能在 node 里
 * 把真 JSON 灌进去，把它抓出来（同 test/web-task.test.ts）。
 *
 * 另外两条只在源码上钉：
 *   1. 这一页只有"加一条" —— 一个 DELETE / PATCH / PUT 都不许有。候选池动了
 *      删除与重排之后，"这一跳用谁"的语义立刻要和正在跑的 attempt 一起想，
 *      而那不是这次的范围（这一页还没有鉴权）。
 *   2. 文件形状 —— pool.js 的名字要满足静态服务的 SAFE_NAME，外壳要认 #/pool。
 *      写错是浏览器里一个 404 或一块白屏，控制台之外没人知道。
 */

describe('资源池页（src/web/pool.js）', () => {
  const webRoot = fileURLToPath(new URL('../src/web/', import.meta.url));
  const readWeb = (name: string): string =>
    readFileSync(join(webRoot, name), 'utf8').replace(/\r\n/g, '\n');

  const loaded = import('../src/web/pool.js');

  /** GET /api/runtime/models 的形状（src/application/runtime-catalog.ts）。 */
  const catalog = {
    available: true,
    runtime: 'pi',
    models: [{ provider: 'a', model: 'b', label: 'A / B' }],
  };

  /** GET /api/pools 的形状：两条 coordinator、一条 executor。 */
  const snapshot = {
    coordinator: [
      {
        profileId: 'coord-a',
        endpoint: 'local',
        runtime: 'pi',
        order: 0,
        facts: [
          { key: 'provider', value: 'p1' },
          { key: 'model', value: 'm1' },
        ],
      },
      {
        profileId: 'coord-b',
        endpoint: 'http://127.0.0.1:9/send',
        runtime: 'pi',
        order: 1,
        facts: [],
      },
    ],
    executor: [
      {
        profileId: 'exec-a',
        endpoint: 'local',
        runtime: 'pi',
        order: 0,
        facts: [
          { key: 'provider', value: 'p' },
          { key: 'model', value: 'm' },
        ],
      },
    ],
  };

  /** 取某一行的四个单元格。用 data-pool-row 定位：下标记行会串到别人身上。 */
  function cellsOf(html: string, profileId: string): string[] {
    const hit = new RegExp(`<tr data-pool-row="${profileId}"[^>]*>([\\s\\S]*?)</tr>`).exec(html);
    assert.ok(hit, `页面里没有 ${profileId} 那一行`);
    return [...hit[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
  }

  /** option 的 value 是被 esc 过的 JSON，断言前先还原。 */
  const unesc = (s: string): string =>
    s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  test('两条 coordinator、一条 executor：计数 2/1，每行出现 profileId 与 endpoint，适配层是 pi', async () => {
    const { poolPageHtml } = await loaded;
    const html = poolPageHtml(snapshot, catalog);
    assert.match(html, /data-count="coordinator">2</);
    assert.match(html, /data-count="executor">1</);
    for (const row of [...snapshot.coordinator, ...snapshot.executor]) {
      const cells = cellsOf(html, row.profileId);
      assert.equal(cells.length, 4, '四列');
      assert.equal(cells[0], row.profileId, '第一列是候选名称 = profileId');
      assert.equal(cells[1], row.endpoint, '第二列是接入点 = endpoint');
      assert.equal(cells[2], 'pi', '第三列是适配层（原来的 Runtime）');
    }
  });

  test('运行时列显示 facts 里的 provider/model，facts 里没有时是 — 带一句解释', async () => {
    const { poolPageHtml } = await loaded;
    const html = poolPageHtml(snapshot, catalog);
    assert.equal(cellsOf(html, 'exec-a')[3], 'p / m');
    assert.equal(cellsOf(html, 'coord-a')[3], 'p1 / m1');
    // facts=[]：— 仍可用，但不能是孤零零一个横杠。
    const empty = cellsOf(html, 'coord-b')[3];
    assert.equal(empty, '—');
    assert.ok(html.includes('title="还没配模型身份"'), '空单元格要解释为什么空');
    // **不要**退回显示 profileId：那一列会让人以为身份已经配好了，
    // 而派发时交给适配层的其实是空 facts。
    assert.equal(empty.includes('coord-b'), false, '运行时列显示了 profileId');
  });

  test('空仓照样能渲染：两个 0 与表单都在，入参整个缺了也不崩', async () => {
    const { poolPageHtml } = await loaded;
    const html = poolPageHtml({ coordinator: [], executor: [] }, catalog);
    assert.match(html, /data-count="coordinator">0</);
    assert.match(html, /data-count="executor">0</);
    assert.ok(html.includes('data-pool-form'), '空仓也要能加第一条');
    assert.ok(html.includes('还没有候选'));
    // 首帧还没拉到数据时 snapshot/catalog 都是空：崩在这儿就是一块白屏。
    assert.ok(poolPageHtml(null, null).length > 0);
    assert.match(poolPageHtml(null, null), /data-pool-form/);
  });

  test('外部输入一律转义：profileId 里的 <script> 进不了 DOM', async () => {
    const { poolPageHtml } = await loaded;
    const evil = '<script>alert(1)</script>';
    const html = poolPageHtml(
      {
        coordinator: [],
        executor: [{ profileId: evil, endpoint: evil, runtime: 'pi', order: 0, facts: [] }],
      },
      catalog,
    );
    assert.equal(html.includes('<script>'), false, 'profileId 被当标签解析了');
    assert.ok(html.includes('&lt;script&gt;'), '该看到转义后的形式');
  });

  test('表头四列齐（人话名）；表单有角色、模型、候选名称、接入点（默认 local）', async () => {
    const { poolPageHtml, POOL_COLUMNS } = await loaded;
    assert.deepEqual(
      [...POOL_COLUMNS],
      ['候选名称', '接入点', '适配层', '运行时'],
    );
    const html = poolPageHtml(snapshot, catalog);
    for (const name of POOL_COLUMNS) {
      assert.ok(html.includes('<th>' + name + '</th>'), `表头缺「${name}」`);
    }
    // 接口名不该当表头：看到 provider/model 而不知道那是「身份」的人得去读代码。
    for (const raw of ['AgentEndpoint', 'ExecutionProfile']) {
      assert.equal(html.includes('>' + raw + '<'), false, `表头里还在裸写 ${raw}`);
    }
    assert.match(html, /<select[^>]*data-pool-role[^>]*>/);
    assert.ok(html.includes('>协调者<') && html.includes('>执行者<'), '角色下拉显示中文');
    assert.match(html, /<select[^>]*data-pool-model[^>]*>/);
    assert.match(html, /<input[^>]*data-pool-profile[^>]*>/);
    assert.match(html, /<input[^>]*data-pool-endpoint[^>]*value="local"/);
    assert.match(html, /<button[^>]*data-pool-submit/);
    // 模型名不许手输：输入框只该有两个（候选名称与接入点）。
    const inputs = [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
    assert.equal(inputs.length, 2, `表单里的输入框该只有两个，实际：${inputs.join(' ')}`);
    assert.equal(
      inputs.some((tag) => tag.includes('model')),
      false,
      '有一个能手输模型名的输入框',
    );
  });

  test('用量卡：走 GET /api/usage 的 total，用同一个 usageLine；读不到要说出来', async () => {
    const { poolPageHtml, usageCardHtml } = await loaded;
    const html = poolPageHtml(
      snapshot,
      catalog,
      { input: 100, output: 50, cacheRead: 850, cacheWrite: 0, total: 1000, cost: 1.2345 },
    );
    for (const fragment of ['新增 150', '缓存命中 850', '85%', '$1.2345']) {
      assert.ok(html.includes(fragment), `用量卡里该有「${fragment}」：${html}`);
    }
    assert.ok(html.includes('缓存部分计费便宜得多'), '高缓存要有便宜说明');
    // 读不到、还没读到，两种都不能留空白。
    assert.ok(usageCardHtml(null).includes('读不到用量'), '读失败要说读不到用量');
    assert.ok(usageCardHtml(undefined).includes('读取中'), '首帧要有一句读取中');
  });

  test('模型下拉的选项来自 catalog.models[].label，value 能还原出 provider/model', async () => {
    const { poolPageHtml, poolModelValue, factsFromModel } = await loaded;
    const html = poolPageHtml(snapshot, catalog);
    const select = /<select[^>]*data-pool-model[^>]*>([\s\S]*?)<\/select>/.exec(html);
    assert.ok(select, '没有模型下拉');
    assert.equal(/disabled/.test(select[0]), false, '清单可用时不该停用下拉');
    const options = [...select[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)];
    assert.equal(options.length, 1, `下拉该只有清单里那一条，实际 ${options.length} 条`);
    assert.equal(options[0][2], 'A / B', 'option 上的文字是 label');
    // 选完不用再手输：value 里带着 provider 与 model，提交时拆得回来。
    const value = unesc(options[0][1]);
    assert.equal(value, poolModelValue({ provider: 'a', model: 'b' }));
    assert.deepEqual(factsFromModel(value), [
      { key: 'provider', value: 'a' },
      { key: 'model', value: 'b' },
    ]);
  });

  test('catalog.available=false：note 原样出现，模型下拉与提交按钮都停用', async () => {
    const { poolPageHtml } = await loaded;
    const html = poolPageHtml(snapshot, { available: false, note: '适配层不在' });
    assert.ok(html.includes('适配层不在'), 'note 要原样出现');
    assert.ok(
      html.indexOf('适配层不在') < html.indexOf('data-pool-form'),
      'note 要在表单上方 —— 摆在按钮下面等于没提醒',
    );
    assert.match(html, /<select[^>]*data-pool-model[^>]*disabled/, '模型下拉要停用');
    assert.match(html, /<button[^>]*data-pool-submit[^>]*disabled/, '提交按钮要停用');
    // 停用归停用，两张表照画：这一条不该把整页变成一句 note。
    assert.match(html, /data-count="coordinator">2</);
  });

  test('这一页只有"加一条"：不发 DELETE / PATCH / PUT，读接口不缓存', () => {
    const src = readWeb('pool.js');
    assert.equal(/DELETE|PATCH|PUT/.test(src), false, '这一页不许出现删除/改/重排');
    assert.match(src, /method: 'POST'/, '唯一的写操作是加一条');
    assert.match(src, /cache: 'no-store'/, '读接口不该被缓存住');
    assert.match(src, /\/api\/pools/);
    assert.match(src, /\/api\/runtime\/models/);
    assert.match(src, /\/api\/usage/, '用量卡的数据来自 GET /api/usage');
  });

  test('提交组装出 provider/model 两个 fact；失败路径读响应 JSON 的 message', async () => {
    const src = readWeb('pool.js');
    // 拆 facts 是**界面**的事：平台存的是不透明键值，application 层不该认识模型。
    assert.match(src, /key: 'provider'/);
    assert.match(src, /key: 'model'/);
    assert.match(src, /fetch\('\/api\/pools'/);
    assert.match(src, /facts/, 'body 里要带 facts');

    const { factsFromModel, errorText } = await loaded;
    assert.deepEqual(factsFromModel('{"provider":"a","model":"b"}'), [
      { key: 'provider', value: 'a' },
      { key: 'model', value: 'b' },
    ]);
    // 拆不出来回 null，调用方据此拒绝提交 —— 不兜底成空 facts：
    // 那种候选存进去像配好了，要到第一次派发失败才说话。
    assert.equal(factsFromModel(''), null);
    assert.equal(factsFromModel('{"provider":"a"}'), null);
    assert.equal(factsFromModel('不是 JSON'), null);

    // message 是后端写给界面看的"下一步该干什么"，原样显示。
    assert.equal(
      errorText({ message: 'coordinator 下已经有同名候选：dup' }, 409),
      'coordinator 下已经有同名候选：dup',
    );
    assert.equal(errorText(null, 500), 'HTTP 500', '拿不到 JSON 时也要说得出是哪个状态码');
  });

  test('文件形状：pool.js 是可服务的扁平小写名，外壳接到 #/pool', () => {
    assert.ok(existsSync(join(webRoot, 'pool.js')), '缺 src/web/pool.js');
    assert.match(
      'pool.js',
      /^[a-z0-9][a-z0-9._-]*\.(html|css|js|svg)$/,
      'SAFE_NAME 不认的名字就是浏览器里一个 404',
    );

    const html = readWeb('index.html');
    assert.match(html, /<link rel="modulepreload" href="\/pool\.js" \/>/);
    // app.js 会 import 它；再写一个会执行的 <script> 就是执行两遍、监听注册两次。
    assert.equal(/<script[^>]+src="\/pool\.js"/.test(html), false, 'pool.js 被写成会执行的 script');
    assert.match(html, /href="#\/pool"[^>]*data-route="pool"/);
    assert.ok(html.includes('>资源池</a>'), '可见文字仍是「资源池」');
    assert.equal(existsSync(join(webRoot, 'pool.css')), false, '不另起 pool.css');

    const shell = readWeb('app.js');
    assert.match(shell, /from '\.\/pool\.js'/);
    assert.match(shell, /renderPoolPage/);
    assert.ok(shell.includes("'/pool'"), 'parseRoute 要认 #/pool');
    assert.equal(shell.includes('/resources'), false, '占位路由要删掉：两个地址指同一页，迟早分叉');
    // 认不出的 hash 仍打回项目页（回归：加路由时别把这条弄丢）。
    assert.ok(shell.includes("location.hash = '#/projects'"));
  });
});
