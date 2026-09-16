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
