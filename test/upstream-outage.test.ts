/**
 * 上游网络中断的纯函数判定（契约验收 1/2 的判定部分）。
 *
 * 为什么需要它：适配层连不上上游时会连着死好几次，那几次的 failureMessage 措辞各不相同
 * （fetch / 超时 / DNS / 连接被掐）。以前平台只有 platform_unreachable 一种「平台不可达」，
 * 判不出「上游网络断了」，于是每条 Mission 都得 L3 手动续跑。这里把「疑似断网」的指纹、
 * 断链边界（别的 attempt.ended、30 分钟间隔）和退避出口钉死。
 *
 * 断言里同时钉了「不该判中断」的一侧：证据不足返回 undefined，宁可漏判——
 * 把偶发失败当成断网只会白白多等一轮，把真实故障当成断网的多算一次没人受伤。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { upstreamOutageStop } from '../src/application/platform/auto-resume.ts';

const NOW = '2026-06-01T12:00:00.000Z';

interface ProbeEvent {
  readonly kind: string;
  readonly at: string;
  readonly attemptId?: string;
  readonly data: unknown;
}

/** 一条 attempt.started：provider 在 data.profile.facts，key 为 provider。 */
function started(attemptId: string, profileId: string, provider?: string, at = NOW): ProbeEvent {
  return {
    kind: 'attempt.started',
    at,
    attemptId,
    data: {
      kind: 'executor',
      profile: {
        profileId,
        ...(provider !== undefined ? { facts: [{ key: 'provider', value: provider }] } : {}),
      },
    },
  };
}

function upstreamFailure(attemptId: string, at: string, message: string): ProbeEvent {
  return {
    kind: 'attempt.ended',
    at,
    attemptId,
    data: { endedBy: 'upstream_failure', failureMessage: message, usage: { total: 12 } },
  };
}

function killedIdle(attemptId: string, at: string, usage?: unknown): ProbeEvent {
  return {
    kind: 'attempt.ended',
    at,
    attemptId,
    data: { endedBy: 'killed_idle', ...(usage !== undefined ? { usage } : {}) },
  };
}

const at = (minutesBeforeNow: number): string =>
  new Date(Date.parse(NOW) - minutesBeforeNow * 60_000).toISOString();

describe('上游网络中断判定：断网指纹、断链边界、退避出口', () => {
  test('疑似断网指纹、连续三条才判中断、间隔 30 分钟与 provider 数决定退避出口', () => {
    // ---- 三条 upstream_failure、含 fetch failed（大小写不同）、间隔 29 分钟、同一 provider。 ----
    {
      const result = upstreamOutageStop(
        [
          started('a1', 'prof-a', 'vendor-a', at(58)),
          upstreamFailure('a1', at(58), 'Fetch Failed: getaddrinfo'),
          started('a2', 'prof-a', 'vendor-a', at(29)),
          upstreamFailure('a2', at(29), 'FETCH FAILED'),
          started('a3', 'prof-a', 'vendor-a', NOW),
          upstreamFailure('a3', NOW, 'fetch failed (ECONNRESET)'),
        ],
        NOW,
      );
      assert.ok(result, '连续三次疑似断网要判中断');
      assert.equal(result.exhausted, 'no_available_agent');
      assert.equal(result.count, 3);
      assert.equal(result.resumeAt, new Date(Date.parse(NOW) + 5 * 60_000).toISOString());
      assert.deepEqual([...result.providers], ['vendor-a']);
      assert.ok(result.detail.includes('第3次'), `detail 要写第几次：${result.detail}`);
      assert.ok(result.detail.includes('约5分钟'), `detail 要写等多久：${result.detail}`);
      // parts 按链从旧到新。
      assert.ok(result.detail.includes('prof-a「Fetch Failed: getaddrinfo」'), result.detail);
      assert.ok(
        result.detail.indexOf('getaddrinfo') < result.detail.indexOf('约5分钟'),
        '较旧的失败排在前面',
      );
    }

    // ---- 两条、两个不同 provider：条数够 2 且涉及 2 个 provider，判中断，第一次退避。 ----
    {
      const result = upstreamOutageStop(
        [
          started('b1', 'prof-b', 'vendor-b', at(29)),
          upstreamFailure('b1', at(29), 'socket hang up'),
          started('b2', 'prof-c', 'vendor-c', NOW),
          upstreamFailure('b2', NOW, 'UND_ERR_SOCKET other side closed'),
        ],
        NOW,
      );
      assert.ok(result, '两条且跨 provider 要判中断');
      assert.equal(result.count, 2);
      assert.equal(result.resumeAt, new Date(Date.parse(NOW) + 60_000).toISOString());
      assert.deepEqual([...result.providers], ['vendor-b', 'vendor-c'], 'provider 去重后按字典序');
    }

    // ---- 两条、同一 provider：证据不足，返回 undefined。 ----
    {
      const result = upstreamOutageStop(
        [
          started('c1', 'prof-d', 'vendor-d', at(29)),
          upstreamFailure('c1', at(29), 'Request timed out'),
          started('c2', 'prof-d', 'vendor-d', NOW),
          upstreamFailure('c2', NOW, 'request timed out'),
        ],
        NOW,
      );
      assert.equal(result, undefined, '两条同一 provider 不到阈值，宁可漏判');
    }

    // ---- 一条：无论文案多像，都不判。 ----
    {
      const result = upstreamOutageStop(
        [
          started('d1', 'prof-e', 'vendor-e', NOW),
          upstreamFailure('d1', NOW, 'connect ETIMEDOUT 10.0.0.1:443'),
        ],
        NOW,
      );
      assert.equal(result, undefined, '单条疑似断网一律不判中断');
    }

    // ---- killed_idle 且 usage.total 恰好为数字 0 计入；没有 usage 的不计入，并把链打断。 ----
    {
      const result = upstreamOutageStop(
        [
          started('e1', 'prof-f', 'vendor-f', at(58)),
          // 没有 usage：不算疑似断网，尾部倒到这里就断，更旧的不再纳入。
          killedIdle('e1', at(58)),
          started('e2', 'prof-g', 'vendor-g', at(29)),
          killedIdle('e2', at(29), { total: 0 }),
          started('e3', 'prof-h', 'vendor-h', NOW),
          killedIdle('e3', NOW, { total: 0 }),
        ],
        NOW,
      );
      assert.ok(result, 'usage.total===0 的 killed_idle 要计入');
      assert.equal(result.count, 2, '没有 usage 的 killed_idle 之后的更旧事件不再计入');
      assert.equal(result.resumeAt, new Date(Date.parse(NOW) + 60_000).toISOString());
    }

    // ---- 中间夹一条 「HTTP 503 Service Unavailable」：链断，只算它之后的。 ----
    {
      const result = upstreamOutageStop(
        [
          started('f1', 'prof-i', 'vendor-i', at(87)),
          upstreamFailure('f1', at(87), 'fetch failed'),
          started('f2', 'prof-i', 'vendor-i', at(58)),
          upstreamFailure('f2', at(58), 'HTTP 503 Service Unavailable'),
          started('f3', 'prof-j', 'vendor-j', at(29)),
          upstreamFailure('f3', at(29), 'fetch failed'),
          started('f4', 'prof-k', 'vendor-k', NOW),
          upstreamFailure('f4', NOW, 'fetch failed'),
        ],
        NOW,
      );
      assert.ok(result, '503 之后的两次跨 provider 疑似失败要判中断');
      assert.equal(result.count, 2, '503 不算疑似断网，链在它那里断');
      assert.equal(
        result.detail.includes('503'),
        false,
        '被断链排除的那条不该出现在 detail 里',
      );
    }

    // ---- 相邻两条相隔 30 分钟 + 1 毫秒：断链；恰好 30 分钟仍连续。 ----
    {
      const overThirty = new Date(Date.parse(NOW) - 30 * 60_000 - 1).toISOString();
      const gapPlusOneMs = upstreamOutageStop(
        [
          started('g1', 'prof-l', 'vendor-l', overThirty),
          upstreamFailure('g1', overThirty, 'fetch failed'),
          started('g2', 'prof-m', 'vendor-m', NOW),
          upstreamFailure('g2', NOW, 'fetch failed'),
        ],
        NOW,
      );
      assert.equal(gapPlusOneMs, undefined, '超过 30 分钟就不算同一次断网');

      const exactlyThirty = upstreamOutageStop(
        [
          started('h1', 'prof-n', 'vendor-n', at(30)),
          upstreamFailure('h1', at(30), 'fetch failed'),
          started('h2', 'prof-o', 'vendor-o', NOW),
          upstreamFailure('h2', NOW, 'fetch failed'),
        ],
        NOW,
      );
      assert.ok(exactlyThirty, '恰好 30 分钟仍算连续');
      assert.equal(exactlyThirty.count, 2);
    }

    // ---- 五条疑似断网：退避表用尽，停下来等人。 ----
    {
      const result = upstreamOutageStop(
        [
          started('i1', 'prof-p', 'vendor-p', at(4)),
          upstreamFailure('i1', at(4), 'fetch failed'),
          started('i2', 'prof-p', 'vendor-p', at(3)),
          upstreamFailure('i2', at(3), 'fetch failed'),
          started('i3', 'prof-p', 'vendor-p', at(2)),
          upstreamFailure('i3', at(2), 'fetch failed'),
          started('i4', 'prof-p', 'vendor-p', at(1)),
          upstreamFailure('i4', at(1), 'fetch failed'),
          started('i5', 'prof-p', 'vendor-p', NOW),
          upstreamFailure('i5', NOW, 'fetch failed'),
        ],
        NOW,
      );
      assert.ok(result, '五条疑似断网要判中断');
      assert.equal(result.exhausted, 'attempt_limit_reached');
      assert.equal(result.count, 5);
      assert.equal(Object.hasOwn(result, 'resumeAt'), false, '退避用尽时不要带 resumeAt 字段');
      assert.ok(
        result.detail.includes('已自动等过 1、5、15 分钟'),
        `detail 要写清已经等过的档位：${result.detail}`,
      );
    }
  });
});
