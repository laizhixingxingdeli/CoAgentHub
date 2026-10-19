/**
 * 同一 Mission 重复启动的占位守卫。
 *
 * 答复升级的 auto-resume 与手动 start 会同时进 runMission：两边都以为自己是这条 Mission
 * 的唯一驱动者，于是互相写 project_busy。守卫要在第一个 await 与任何 adapter / Mission /
 * 工作区副作用之前，用 body.spec.missionId 原子占位。
 *
 * 守四件事：
 *   1. 同 ID 两并发只跑一次底层，第一个不受影响（返回值原样透出）；
 *   2. 重复请求安全地回 0 并给出已在运行的提示，不删别人的占位；
 *   3. 不同 ID 可以并发；
 *   4. 正常结束或抛异常后占位都释放，同 ID 可以重试。
 * 另外确认 main.ts 真的把守卫接在 runMission 外层（HTTP / 自动恢复 / 队列共用这一份闭包）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createHostedMissionGuard,
  type HostedMissionEmitLine,
} from '../src/application/hosted-mission-guard.ts';

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const missionBody = (missionId: string): Record<string, unknown> => ({
  spec: { projectId: 'P-guard', missionId, contract: {} },
  cwd: '/tmp/guard',
  adapter: '/tmp/guard/adapter',
});

test('同 ID 并发只跑一次底层、不同 ID 并行、结束或抛错后释放占位', async () => {
  const guard = createHostedMissionGuard();
  const calls: string[] = [];
  const lines: string[] = [];
  const failures = new Set<string>();
  let gate = deferred();

  const emit: HostedMissionEmitLine = (channel, line) => {
    lines.push(`${channel}:${line}`);
  };

  const run = guard.wrap(async (body) => {
    const spec = body.spec as { missionId?: unknown } | undefined;
    const missionId = typeof spec?.missionId === 'string' ? spec.missionId : '<invalid>';
    calls.push(missionId);
    // 非法 body 不占位、直接进底层（由底层原有的参数校验拒绝）。
    if (missionId === '<invalid>') return 3;
    await gate.promise;
    if (failures.has(missionId)) throw new Error(`boom:${missionId}`);
    return 7;
  });

  // —— 同 ID 两并发：占位发生在首个 await 之前，所以第二次同步就命中 ——
  const first = run(missionBody('M-1'), emit);
  const duplicate = run(missionBody('M-1'), emit);
  // —— 不同 ID 不受影响 ——
  const other = run(missionBody('M-2'), emit);
  // —— 重复请求不删占位：第三条同 ID 仍然是重复 ——
  const third = run(missionBody('M-1'), emit);
  // —— 非法 body 走原有校验路径，不被守卫吞掉 ——
  const invalid = run({ spec: {} }, emit);

  assert.deepEqual(
    calls,
    ['M-1', 'M-2', '<invalid>'],
    '底层只应被同 ID 的第一次、另一个 ID、以及非法 body 各调一次',
  );
  assert.equal(await duplicate, 0, '重复启动应安全回 0');
  assert.equal(await third, 0, '重复请求不能释放别人的占位');
  assert.equal(await invalid, 3, '非法 body 必须落到原参数校验');
  assert.equal(lines.filter((line) => line.includes('M-1') && line.includes('已在运行')).length, 2);
  assert.equal(lines.some((line) => line.includes('M-2') && line.includes('已在运行')), false);

  gate.resolve();
  assert.equal(await first, 7, '首个请求的返回值必须原样透出');
  assert.equal(await other, 7, '不同 ID 的并发运行不受影响');

  // —— 正常结束后释放：同 ID 可以重试 ——
  gate = deferred();
  calls.length = 0;
  const retried = run(missionBody('M-1'), emit);
  assert.deepEqual(calls, ['M-1']);
  gate.resolve();
  assert.equal(await retried, 7);

  // —— 抛异常后也释放：同 ID 仍可重试 ——
  failures.add('M-3');
  gate = deferred();
  calls.length = 0;
  const failing = run(missionBody('M-3'), emit);
  const failingDuplicate = run(missionBody('M-3'), emit);
  assert.deepEqual(calls, ['M-3']);
  assert.equal(await failingDuplicate, 0);
  gate.resolve();
  await assert.rejects(failing, /boom:M-3/);

  failures.delete('M-3');
  gate = deferred();
  calls.length = 0;
  const afterFailure = run(missionBody('M-3'), emit);
  assert.deepEqual(calls, ['M-3'], '异常路径必须释放占位，重试才会真的进底层');
  gate.resolve();
  assert.equal(await afterFailure, 7);
});

test('main.ts 把守卫接在 runMission 外层（HTTP / 自动恢复 / 队列共用一份闭包）', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/main.ts', import.meta.url)),
    'utf8',
  );
  assert.match(
    source,
    /import\s*\{[^}]*createHostedMissionGuard[^}]*\}\s*from\s*'\.\/application\/hosted-mission-guard\.ts'/,
    'main.ts 必须导入生产守卫模块',
  );
  const declared = source.indexOf('createHostedMissionGuard()');
  const wrapped = source.indexOf('hostedMissionGuard.wrap(');
  const adapterRemembered = source.indexOf('rememberHostedAdapter(body)');
  const handlerDecl = source.indexOf("const runMission: NonNullable<ApiDeps['runMission']>");
  assert.ok(declared > 0, '守卫必须在服务装配里只建一次');
  assert.ok(wrapped > declared, 'runMission 必须经守卫包装');
  assert.ok(handlerDecl > 0 && wrapped > handlerDecl, '包装必须落在 runMission 闭包上');
  assert.ok(
    adapterRemembered > wrapped,
    'rememberHostedAdapter 等副作用必须在占位之后（守卫在闭包最外层）',
  );
});
