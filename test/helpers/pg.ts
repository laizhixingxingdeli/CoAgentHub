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

import pg from 'pg';

const ADMIN =
  process.env.COAGENT_PG_ADMIN ?? 'postgresql://postgres:postgres@localhost:5432/postgres';

export function testConnectionString(): string {
  if (process.env.COAGENT_PG_TEST) return process.env.COAGENT_PG_TEST;
  const name = 'coagenthub_v5_test';
  const base = ADMIN.slice(0, ADMIN.lastIndexOf('/'));
  return `${base}/${name}`;
}

/**
 * 确保测试库存在。返回连接串；连不上 Postgres 时返回 undefined。
 *
 * `CREATE DATABASE` 不能在事务里跑，也没有 IF NOT EXISTS，所以这里用
 * "先查后建 + 吞掉 42P04（已存在）"——并发建库时两边都能拿到可用的库。
 */
export async function ensureTestDatabase(): Promise<string | undefined> {
  const target = testConnectionString();
  const name = target.slice(target.lastIndexOf('/') + 1);
  let admin: pg.Client | undefined;
  try {
    admin = new pg.Client({ connectionString: ADMIN });
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
