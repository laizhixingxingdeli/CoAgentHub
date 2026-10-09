/**
 * 测试专用的 Postgres 连接。
 *
 * **测试绝不碰开发库。** 这条是实测换来的：pg 测试原本直接 TRUNCATE
 * 缺省库，而常驻观测面和正在跑的 Mission 用的是同一个——于是整套并行跑时
 * 会零星红在**毫不相干的**测试上（git worktree、调度器主链），而隔离复跑
 * 又全绿，非常难定位。A/B 之后才确认是共用库的锅。
 *
 * 库名走 `COAGENT_PG_TEST`，缺省 `coagenthub_v5_test`；不存在就建。
 * 连不上就让调用方跳过整组——文件版仍是默认存储，"装了数据库才能跑测试"
 * 会让这个仓库变难上手。
 */

import type pg from 'pg';

const ADMIN =
  process.env.COAGENT_PG_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/postgres';

/**
 * @param isolated 另起一个库（`coagenthub_v5_test_<isolated>`）：要改表结构的用例（迁移测试）用，
 *   免得和并行跑的 pg-store 测试在同一个库里互相 TRUNCATE / ALTER。
 */
export function testConnectionString(isolated?: string): string {
  const base = ADMIN.slice(0, ADMIN.lastIndexOf('/'));
  if (isolated) return `${base}/coagenthub_v5_test_${isolated}`;
  if (process.env.COAGENT_PG_TEST) return process.env.COAGENT_PG_TEST;
  const name = 'coagenthub_v5_test';
  return `${base}/${name}`;
}

/** 按需取 pg 运行时；没装 pg 时返回 undefined。模块顶层不静态引用驱动。 */
async function loadPg(): Promise<typeof pg | undefined> {
  try {
    return (await import('pg')).default;
  } catch {
    return undefined;
  }
}

/** 另起一个客户端连测试库。仅在确实要连库的用例里调用；没装 pg 直接抛错。 */
export async function connectPgClient(dsn: string): Promise<pg.Client> {
  const runtime = await loadPg();
  if (!runtime) throw new Error('pg 未安装，无法连接 Postgres');
  return new runtime.Client({ connectionString: dsn });
}

/**
 * 确保测试库存在。返回连接串；连不上 Postgres 时返回 undefined。
 *
 * `CREATE DATABASE` 不能在事务里跑，也没有 IF NOT EXISTS，所以这里用
 * "先查后建 + 吞掉 42P04（已存在）"——并发建库时两边都能拿到可用的库。
 */
export async function ensureTestDatabase(isolated?: string): Promise<string | undefined> {
  const target = testConnectionString(isolated);
  const name = target.slice(target.lastIndexOf('/') + 1);
  const runtime = await loadPg();
  // 没装 pg 与连不上 Postgres 同一种下场：调用方现有的跳过逻辑照旧。
  if (!runtime) return undefined;
  let admin: pg.Client | undefined;
  try {
    admin = new runtime.Client({ connectionString: ADMIN });
    await admin.connect();
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rowCount === 0) {
      // 42P04 = duplicate_database：另一个测试进程抢先建了，这不是错误。
      await admin.query(`CREATE DATABASE "${name}"`).catch((error: { code?: string }) => {
        if (error?.code !== '42P04') throw error;
      });
    }
    return target;
  } catch {
    return undefined;
  } finally {
    await admin?.end().catch(() => undefined);
  }
}
