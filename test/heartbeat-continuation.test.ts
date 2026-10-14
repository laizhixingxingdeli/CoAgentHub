/**
 * 心跳窗口续跑（W-685，契约第 3 条 (b) 路）：判定函数与「读审计取 D」两件事。
 *
 * 不起 startServer、不碰运行中的状态文件、不请求端口：这里只锁纯函数与锁审计
 * 读取的形状。接线（并入同一次 requestInterruptedContinuations）由 startServer
 * 的装配契约保证，另见 test/interrupted-continuation.test.ts。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  qualifiesForHeartbeatContinuation,
  readPreviousServiceHeartbeatAt,
} from '../src/application/platform/heartbeat-continuation.ts';
import { lockAuditPathFor } from '../src/application/lock.ts';

const STOPPED_AT = '2026-10-14T14:13:37.842Z';
const BEFORE_MS = 20 * 60 * 1000;
const AFTER_MS = 2 * 60 * 1000;

/** 基准是一份「应当续跑」的输入；每条断言只改其中一项，改哪项就是哪项在起作用。 */
function baseline() {
  return {
    mission: {
      status: 'executing',
      waitReason: undefined as string | undefined,
      paused: false,
      parked: false,
      openEscalations: 0,
    },
    hosted: { hasRunRequest: true, queued: false },
  };
}

function ms(iso: string, deltaMs: number): string {
  return new Date(Date.parse(iso) + deltaMs).toISOString();
}

test('心跳窗口续跑判定：窗口内的纳入与各项排除条件', () => {
  // ---- 基准：死前那一刻还在动，应当纳入。 ----
  {
    const { mission, hosted } = baseline();
    assert.equal(
      qualifiesForHeartbeatContinuation(mission, STOPPED_AT, STOPPED_AT, hosted),
      true,
      '最近事件就在 D、其余条件齐备时必须纳入',
    );
  }

  // ---- 闭区间边界：两端点都算在窗口内。 ----
  for (const [label, delta] of [['D−20 分钟', -BEFORE_MS], ['D+2 分钟', AFTER_MS]] as const) {
    const { mission, hosted } = baseline();
    assert.equal(
      qualifiesForHeartbeatContinuation(mission, ms(STOPPED_AT, delta), STOPPED_AT, hosted),
      true,
      `${label} 恰好落在闭区间端点，必须纳入`,
    );
  }

  // ---- 另两种可续跑状态在其余字段同基准时同样纳入。 ----
  for (const status of ['planning', 'investigating']) {
    const { mission, hosted } = baseline();
    assert.equal(
      qualifiesForHeartbeatContinuation({ ...mission, status }, STOPPED_AT, STOPPED_AT, hosted),
      true,
      `${status} 与 executing 同为可续跑状态`,
    );
  }

  // ---- 排除：各改一项，其余同基准，都必须为 false（宁可漏判）。 ----
  const exclusions: Array<{ name: string; run: () => boolean }> = [
    {
      name: 'status completed',
      run: () => {
        const { mission, hosted } = baseline();
        return qualifiesForHeartbeatContinuation({ ...mission, status: 'completed' }, STOPPED_AT, STOPPED_AT, hosted);
      },
    },
    {
      name: 'waitReason retry_backoff',
      run: () => {
        const { mission, hosted } = baseline();
        return qualifiesForHeartbeatContinuation({ ...mission, waitReason: 'retry_backoff' }, STOPPED_AT, STOPPED_AT, hosted);
      },
    },
    {
      name: 'paused',
      run: () => {
        const { mission, hosted } = baseline();
        return qualifiesForHeartbeatContinuation({ ...mission, paused: true }, STOPPED_AT, STOPPED_AT, hosted);
      },
    },
    {
      name: 'parked',
      run: () => {
        const { mission, hosted } = baseline();
        return qualifiesForHeartbeatContinuation({ ...mission, parked: true }, STOPPED_AT, STOPPED_AT, hosted);
      },
    },
    {
      name: 'openEscalations 1',
      run: () => {
        const { mission, hosted } = baseline();
        return qualifiesForHeartbeatContinuation({ ...mission, openEscalations: 1 }, STOPPED_AT, STOPPED_AT, hosted);
      },
    },
    {
      name: 'hasRunRequest false',
      run: () => {
        const { mission, hosted } = baseline();
        return qualifiesForHeartbeatContinuation(mission, STOPPED_AT, STOPPED_AT, { ...hosted, hasRunRequest: false });
      },
    },
    {
      name: 'queued true',
      run: () => {
        const { mission, hosted } = baseline();
        return qualifiesForHeartbeatContinuation(mission, STOPPED_AT, STOPPED_AT, { ...hosted, queued: true });
      },
    },
    {
      name: '早于 D−20 分钟 1 毫秒',
      run: () => {
        const { mission, hosted } = baseline();
        return qualifiesForHeartbeatContinuation(mission, ms(STOPPED_AT, -BEFORE_MS - 1), STOPPED_AT, hosted);
      },
    },
    {
      name: '晚于 D+2 分钟 1 毫秒',
      run: () => {
        const { mission, hosted } = baseline();
        return qualifiesForHeartbeatContinuation(mission, ms(STOPPED_AT, AFTER_MS + 1), STOPPED_AT, hosted);
      },
    },
    {
      name: 'latestEventAt 空串',
      run: () => {
        const { mission, hosted } = baseline();
        return qualifiesForHeartbeatContinuation(mission, '', STOPPED_AT, hosted);
      },
    },
    {
      name: 'stoppedAt 无法解析',
      run: () => {
        const { mission, hosted } = baseline();
        return qualifiesForHeartbeatContinuation(mission, STOPPED_AT, 'not-a-date', hosted);
      },
    },
  ];
  for (const item of exclusions) {
    assert.equal(item.run(), false, `${item.name} 时必须排除`);
  }
});

test('读审计取 D：按本进程 pid 取最后一条接管记录，失败警告一次', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-audit-'));
  const statePath = join(dir, 'state.json');
  const auditPath = lockAuditPathFor(statePath);
  const PID = 4242;
  try {
    // ---- 没有审计文件（干净启动）：不警告。 ----
    {
      const warnings: string[] = [];
      assert.equal(readPreviousServiceHeartbeatAt(statePath, PID, (m) => warnings.push(m)), undefined);
      assert.deepEqual(warnings, [], '干净启动是常态，不该报警');
    }

    // ---- 记录里没有本进程 pid：不警告，也不把别的进程的记录当成自己的。 ----
    {
      const warnings: string[] = [];
      writeFileSync(
        auditPath,
        `${JSON.stringify({ at: '2026-10-14T14:20:00.000Z', oldPid: 111, newPid: 222, oldHeartbeatAt: STOPPED_AT })}\n`,
      );
      assert.equal(readPreviousServiceHeartbeatAt(statePath, PID, (m) => warnings.push(m)), undefined);
      assert.deepEqual(warnings, []);
    }

    // ---- 追加序里最后一条命中才算数。 ----
    {
      const warnings: string[] = [];
      writeFileSync(
        auditPath,
        [
          JSON.stringify({ at: '2026-10-14T14:20:00.000Z', oldPid: 111, newPid: PID, oldHeartbeatAt: STOPPED_AT }),
          JSON.stringify({ at: '2026-10-14T15:20:00.000Z', oldPid: 333, newPid: PID, oldHeartbeatAt: '2026-10-14T15:13:37.842Z' }),
        ].join('\n') + '\n',
      );
      assert.equal(
        readPreviousServiceHeartbeatAt(statePath, PID, (m) => warnings.push(m)),
        '2026-10-14T15:13:37.842Z',
        '同一 pid 接管过两次时，取最近一次接管记录的 oldHeartbeatAt',
      );
      assert.deepEqual(warnings, []);
    }

    // ---- 命中记录没有可用的 oldHeartbeatAt：警告一次并放弃这一路。 ----
    {
      const warnings: string[] = [];
      writeFileSync(auditPath, `${JSON.stringify({ at: '2026-10-14T14:20:00.000Z', oldPid: 111, newPid: PID })}\n`);
      assert.equal(readPreviousServiceHeartbeatAt(statePath, PID, (m) => warnings.push(m)), undefined);
      assert.equal(warnings.length, 1, '命中本进程但取不到 D 必须报警，否则这一路静默消失');
      assert.match(warnings[0]!, /^\[启动续跑\]/);
    }

    // ---- 内容坏了：警告一次、返回 undefined，不把异常抛给启动流程。 ----
    {
      const warnings: string[] = [];
      writeFileSync(auditPath, '{ this is not json }\n');
      assert.equal(readPreviousServiceHeartbeatAt(statePath, PID, (m) => warnings.push(m)), undefined);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /^\[启动续跑\]/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
