/**
 * 工单验收历史（只读、分页）。
 *
 * 守住：
 *   - 历史按 `item.reviews` 的顺序给全：先 reject 后 accept，两条都在
 *   - 每条带着它当时验的那次提交（submittedAttemptId）与逐条验收原文，
 *     不被后来那次评审覆盖
 *   - `reviewId` 跨页、跨追加都稳定；`lastReview` 仍是视图里那条「当前结论」
 *   - 返回的是深拷贝 + 脱敏：改返回值不影响平台状态，凭据不外露
 *   - 分页参数写错一律 400（空串 / 1.5 / NaN / 负数），只有「不传」才是缺省
 *   - 未知 Mission / 工单 404、缺凭据 401、且这些拒绝都没有写副作用
 *
 * 为什么要有这个接口：视图里的 `lastReview` 只给最后一条。一次 reject 之后
 * accept 的工单，人看不到当初为什么被打回——而那正是复盘要读的东西。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';

import { createApi } from '../src/api/server.ts';
import type { ControlPrincipal, ControlPrincipalResolver } from '../src/api/control-auth.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { InMemoryAgentPoolRepository } from '../src/application/agent-pool.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import { Project } from '../src/kernel/index.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '把 foo 修好',
  acceptance: ['foo() === 1'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const PLAN = { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] };

const ORDER: WorkOrder = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['A 行为成立', 'B 在真机上验过'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
};

const CANARY = 'sk-live-CANARY-must-not-leak-0123456789';

function makePlatform() {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const activity = new InMemoryActivityLog(clock);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    activity,
    clock,
    ids,
  });
  return { platform, activity };
}

/**
 * 走到「工单已提交、等验收」，返回协调者 attempt 与这次提交的 attempt id。
 *
 * 照 test/review-acceptance.test.ts 的 submitted helper 写：missionId 显式给，
 * Standard 派发前先交契约核对（W-334），执行者交卷要有证据（S11.1）。
 */
async function submitted(
  platform: Platform,
  missionId = 'M1',
  projectId = 'P',
): Promise<{ coord: string; workItemId: string; exec: string }> {
  await platform.createMission({ projectId, missionId, contract: CONTRACT });
  const coord = await platform.startCoordinatorAttempt(missionId);
  await platform.updatePlan(missionId, coord.attemptId, PLAN);
  const { workItemId } = await platform.createWorkItem(missionId, coord.attemptId, {
    title: 'W',
    order: ORDER,
  });
  await platform.submitContractCheck(missionId, coord.attemptId, {
    verdict: 'ok',
    summary: '测试契约已核对',
  });
  await platform.dispatchWorkItems(missionId, coord.attemptId, [workItemId]);
  const exec = await platform.startExecutorAttempt(missionId, workItemId);
  await platform.submitEvidence(missionId, exec.attemptId, {
    kind: 'test',
    summary: '绿',
    command: 'node --test',
    exitCode: 0,
  });
  await platform.submitExecutionResult(missionId, exec.attemptId, {
    outcome: 'completed',
    summary: '好了',
    changedFiles: ['src/foo.ts'],
    evidenceIds: [],
    notes: '无',
  });
  await platform.finishAttempt(missionId, exec.attemptId, { endedBy: 'structured_submit' });
  return { coord: coord.attemptId, workItemId, exec: exec.attemptId };
}

/** 一次 reject 之后重派、重做、accept：工单上留下两条评审。 */
async function rejectThenAccept(
  platform: Platform,
  missionId = 'M1',
  projectId = 'P',
): Promise<{ coord: string; workItemId: string; rejectedAttemptId: string; acceptedAttemptId: string }> {
  const first = await submitted(platform, missionId, projectId);
  await platform.reviewExecutionResult(missionId, first.coord, {
    workItemId: first.workItemId,
    verdict: 'reject',
    reasons: [`测试没真跑，日志里带着 token=${CANARY}`],
    requiredChanges: ['把 verification 里的命令实际执行并交退出码'],
    acceptanceResults: ORDER.acceptance.map((criterion) => ({
      criterion,
      status: 'fail' as const,
      note: '没有退出码',
    })),
  });

  await platform.dispatchWorkItems(missionId, first.coord, [first.workItemId]);
  const second = await platform.startExecutorAttempt(missionId, first.workItemId);
  await platform.submitEvidence(missionId, second.attemptId, {
    kind: 'test',
    summary: '绿',
    command: 'node --test',
    exitCode: 0,
  });
  await platform.submitExecutionResult(missionId, second.attemptId, {
    outcome: 'completed',
    summary: '改好了',
    changedFiles: ['src/foo.ts'],
    evidenceIds: [],
    notes: '无',
  });
  await platform.finishAttempt(missionId, second.attemptId, { endedBy: 'structured_submit' });
  await platform.reviewExecutionResult(missionId, first.coord, {
    workItemId: first.workItemId,
    verdict: 'accept',
    reasons: ['逐条核过'],
    requiredChanges: [],
    acceptanceResults: [
      { criterion: 'A 行为成立', status: 'pass', evidence: 'node --test 退出码 0' },
      { criterion: 'B 在真机上验过', status: 'unverified', note: '没有真机' },
    ],
  });
  return {
    coord: first.coord,
    workItemId: first.workItemId,
    rejectedAttemptId: first.exec,
    acceptedAttemptId: second.attemptId,
  };
}

const codeOf = (e: unknown) => (e as { code?: string }).code;

describe('Platform.getWorkItemReviewHistory', () => {
  test('reject → accept 两条都在：各自的 submittedAttemptId 与逐条结论保留，lastReview 不变', async () => {
    const { platform } = makePlatform();
    const { workItemId, rejectedAttemptId, acceptedAttemptId } = await rejectThenAccept(platform);

    const history = await platform.getWorkItemReviewHistory('M1', workItemId);
    assert.equal(history.total, 2);
    assert.equal(history.nextCursor, null);
    assert.deepEqual(
      history.items.map((entry) => entry.reviewIndex),
      [0, 1],
    );
    assert.deepEqual(
      history.items.map((entry) => entry.review.verdict),
      ['reject', 'accept'],
    );
    // 每条绑的是「当时验的那次提交」，不是最后那次。
    assert.equal(history.items[0]!.review.submittedAttemptId, rejectedAttemptId);
    assert.equal(history.items[1]!.review.submittedAttemptId, acceptedAttemptId);
    assert.deepEqual(
      history.items[0]!.review.acceptanceResults?.map((r) => r.status),
      ['fail', 'fail'],
    );
    assert.deepEqual(
      history.items[1]!.review.acceptanceResults?.map((r) => r.status),
      ['pass', 'unverified'],
    );
    assert.deepEqual(history.items[0]!.review.requiredChanges, [
      '把 verification 里的命令实际执行并交退出码',
    ]);

    // 视图里的 lastReview 仍是最后一条：历史接口不改它。
    const view = await platform.getMissionView('M1');
    const item = view.workItems.find((w) => w.id === workItemId);
    assert.equal(item?.lastReview?.verdict, 'accept');
    assert.deepEqual(item?.lastReview, history.items[1]!.review);
  });

  test('分页：cursor/limit 切页、reviewId 稳定、追加后旧页内容不变', async () => {
    const { platform } = makePlatform();
    const { workItemId, coord } = await rejectThenAccept(platform);

    const firstPage = await platform.getWorkItemReviewHistory('M1', workItemId, {
      cursor: 0,
      limit: 1,
    });
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.nextCursor, 1);
    assert.equal(firstPage.total, 2);

    const secondPage = await platform.getWorkItemReviewHistory('M1', workItemId, {
      cursor: 1,
      limit: 1,
    });
    assert.equal(secondPage.items.length, 1);
    assert.equal(secondPage.nextCursor, null);
    assert.equal(secondPage.total, 2);

    // 跨页取到的是两条不同的记录，id 不撞。
    assert.notEqual(firstPage.items[0]!.reviewId, secondPage.items[0]!.reviewId);
    const firstId = firstPage.items[0]!.reviewId;

    // 再追加一条评审：旧 cursor 重新读，同一个 index 的 reviewId 不变。
    await platform.dispatchWorkItems('M1', coord, [workItemId]);
    const third = await platform.startExecutorAttempt('M1', workItemId);
    await platform.submitEvidence('M1', third.attemptId, {
      kind: 'test',
      summary: '绿',
      command: 'node --test',
      exitCode: 0,
    });
    await platform.submitExecutionResult('M1', third.attemptId, {
      outcome: 'completed',
      summary: '再改',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '无',
    });
    await platform.finishAttempt('M1', third.attemptId, { endedBy: 'structured_submit' });
    await platform.reviewExecutionResult('M1', coord, {
      workItemId,
      verdict: 'accept',
      reasons: ['再看一遍'],
      requiredChanges: [],
      acceptanceResults: [
        { criterion: 'A 行为成立', status: 'pass', evidence: '复跑绿' },
        { criterion: 'B 在真机上验过', status: 'not_applicable', note: '这次没动那部分' },
      ],
    });

    const replay = await platform.getWorkItemReviewHistory('M1', workItemId, {
      cursor: 0,
      limit: 1,
    });
    assert.equal(replay.items[0]!.reviewId, firstId);
    assert.equal(replay.total, 3);
    assert.equal(replay.nextCursor, 1);

    // 越界 cursor 回空页，不是错误：历史只会变长，旧 cursor 重放是正常调用。
    const beyond = await platform.getWorkItemReviewHistory('M1', workItemId, { cursor: 99 });
    assert.deepEqual(beyond.items, []);
    assert.equal(beyond.nextCursor, null);
    assert.equal(beyond.total, 3);
  });

  test('返回深拷贝且脱敏：改返回值不污染平台，canary 不外露', async () => {
    const { platform } = makePlatform();
    const { workItemId } = await rejectThenAccept(platform);

    const history = await platform.getWorkItemReviewHistory('M1', workItemId);
    const raw = JSON.stringify(history);
    assert.equal(raw.includes(CANARY), false, '评审理由里的凭据必须脱敏');

    // 改返回值（数组、字符串）都不能回写到平台。
    (history.items[0]!.review.reasons as string[]).push('篡改');
    (history.items[0]!.review.requiredChanges as string[])[0] = '篡改';

    const again = await platform.getWorkItemReviewHistory('M1', workItemId);
    assert.equal(again.items[0]!.review.reasons.length, 1);
    assert.equal(again.items[0]!.review.requiredChanges[0], '把 verification 里的命令实际执行并交退出码');

    // 视图里的 lastReview 与历史互不影响。
    const view = await platform.getMissionView('M1');
    assert.equal(view.workItems.find((w) => w.id === workItemId)?.lastReview?.verdict, 'accept');

    // authority 同样不能是 domain 里那个引用：它是 deep freeze 的，交出去调用方一改
    // 就撞只读对象，「深拷贝」名不副实。两种形状各来一条：coordinator / validator。
    const seeded = new InMemoryProjectRepository();
    await seeded.save(
      Project.restore({
        id: 'P',
        missions: [
          {
            id: 'M1',
            projectId: 'P',
            status: 'executing',
            contractRevision: 0,
            planRevision: 0,
            escalations: [],
            workItems: [
              {
                id: 'W-AUTH',
                missionId: 'M1',
                title: 'W',
                status: 'accepted',
                submitted: true,
                reviews: [
                  {
                    attemptId: 'coord-1',
                    authority: { kind: 'coordinator', attemptId: 'coord-1' },
                    verdict: 'accept',
                    reasons: ['协调者验收'],
                    requiredChanges: [],
                  },
                  {
                    submittedAttemptId: 'exec-1',
                    authority: { kind: 'validator', reportId: 'VR-1', policyRevision: 2 },
                    verdict: 'accept',
                    reasons: ['机器验收'],
                    requiredChanges: [],
                  },
                ],
                attempts: [],
                executorSeq: 0,
              },
            ],
            coordinatorAttempts: [],
            coordinatorSeq: 0,
          },
        ],
      }),
    );
    const seededClock = new FixedClock();
    const seededPlatform = new Platform({
      projects: seeded,
      deliveries: new InMemoryDeliveryRepository(seededClock, new SequentialIds()),
      activity: new InMemoryActivityLog(seededClock),
      clock: seededClock,
      ids: new SequentialIds(),
    });
    const withAuthority = await seededPlatform.getWorkItemReviewHistory('M1', 'W-AUTH');
    const domainReviews = (await seeded.get('P'))?.missions[0]?.workItem('W-AUTH')?.reviews ?? [];
    assert.equal(domainReviews.length, 2);

    const coordReturned = withAuthority.items[0]!.review.authority;
    const coordDomain = domainReviews[0]!.authority;
    assert.deepEqual(coordReturned, { kind: 'coordinator', attemptId: 'coord-1' });
    assert.ok(Object.isFrozen(coordDomain), 'domain 里的 authority 是 frozen 的');
    assert.notEqual(coordReturned, coordDomain, 'coordinator authority 必须是新对象');

    const validatorReturned = withAuthority.items[1]!.review.authority;
    const validatorDomain = domainReviews[1]!.authority;
    assert.deepEqual(validatorReturned, {
      kind: 'validator',
      reportId: 'VR-1',
      policyRevision: 2,
    });
    assert.ok(Object.isFrozen(validatorDomain), 'domain 里的 authority 是 frozen 的');
    assert.notEqual(validatorReturned, validatorDomain, 'validator authority 必须是新对象');

    // 改返回值不回写 domain：证明是复制，不是换了层壳。
    (validatorReturned as { policyRevision: number }).policyRevision = 99;
    assert.deepEqual(validatorDomain, {
      kind: 'validator',
      reportId: 'VR-1',
      policyRevision: 2,
    });
  });

  test('未知 Mission / 工单 → 规则错误；非法 cursor/limit → 规则错误', async () => {
    const { platform } = makePlatform();
    const { workItemId } = await rejectThenAccept(platform);

    await assert.rejects(
      () => platform.getWorkItemReviewHistory('M-NOPE', workItemId),
      (e: unknown) => codeOf(e) === 'UNKNOWN_MISSION',
    );
    await assert.rejects(
      () => platform.getWorkItemReviewHistory('M1', 'W-NOPE'),
      (e: unknown) => codeOf(e) === 'UNKNOWN_WORK_ITEM',
    );

    for (const cursor of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        () => platform.getWorkItemReviewHistory('M1', workItemId, { cursor }),
        (e: unknown) => codeOf(e) === 'INVALID_CURSOR',
        `cursor=${String(cursor)} 必须被拒`,
      );
    }
    for (const limit of [0, -1, 1.5, Number.NaN, 101]) {
      await assert.rejects(
        () => platform.getWorkItemReviewHistory('M1', workItemId, { limit }),
        (e: unknown) => codeOf(e) === 'INVALID_LIMIT',
        `limit=${String(limit)} 必须被拒`,
      );
    }
    assert.ok(new PlatformRuleError('INVALID_CURSOR', 'x') instanceof Error);
  });
});

/* ------------------------------- HTTP 面 ------------------------------- */

const OP_TOKEN = 'operator-token';

const resolveFromHeader: ControlPrincipalResolver = (req: IncomingMessage) => {
  const raw = req.headers['x-coagent-control'];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (token !== OP_TOKEN) return undefined;
  return { id: 'op-1', role: 'operator' } satisfies ControlPrincipal;
};

interface Harness {
  readonly base: string;
  readonly server: ReturnType<typeof createApi>;
  readonly platform: Platform;
  readonly workItemId: string;
  readonly missionId: string;
  readonly reviewsBefore: number;
}

/**
 * 起一个真 HTTP 服务（node:http + listenLoopback，不用代理）。
 *
 * 走 127.0.0.1 直连：这台机器上若配了 HTTP 代理，`fetch` 默认会把它带去代理，
 * 回环请求就变成 external。--noproxy 是 curl 的说法；这里靠的是直连回环地址。
 */
async function startHarness(): Promise<Harness> {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
  const { workItemId } = await rejectThenAccept(platform);
  const server = createApi({
    platform,
    tokens: new RunTokenRegistry(),
    deliveries,
    agentPool: new InMemoryAgentPoolRepository(),
    resolveControlPrincipal: resolveFromHeader,
  });
  await listenLoopback(server, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, server, platform, workItemId, missionId: 'M1', reviewsBefore: 2 };
}

async function stopHarness(h: Harness): Promise<void> {
  h.server.closeAllConnections?.();
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
}

async function get(
  base: string,
  path: string,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`${base}${path}`, {
    headers: token === undefined ? {} : { 'x-coagent-control': token },
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-json */
  }
  return { status: res.status, json, text };
}

describe('GET /api/missions/:missionId/work-items/:workItemId/reviews', () => {
  test('分页读两条评审：结构与权限、脱敏、无写副作用', { timeout: 15000 }, async () => {
    const h = await startHarness();
    try {
      const path = `/api/missions/${h.missionId}/work-items/${h.workItemId}/reviews`;
      const page = await get(h.base, `${path}?cursor=0&limit=1`, OP_TOKEN);
      assert.equal(page.status, 200);
      assert.equal(page.text.includes(CANARY), false, 'HTTP 应答不得回显凭据');
      assert.equal(page.json.total, 2);
      assert.equal(page.json.nextCursor, 1);
      const items = page.json.items as Array<Record<string, unknown>>;
      assert.equal(items.length, 1);
      assert.equal(items[0]!.reviewIndex, 0);
      assert.equal(typeof items[0]!.reviewId, 'string');
      assert.equal((items[0]!.review as { verdict: string }).verdict, 'reject');

      const rest = await get(h.base, `${path}?cursor=1&limit=1`, OP_TOKEN);
      assert.equal(rest.status, 200);
      assert.equal(rest.json.nextCursor, null);
      const restItems = rest.json.items as Array<Record<string, unknown>>;
      assert.equal((restItems[0]!.review as { verdict: string }).verdict, 'accept');

      // 不传参数：缺省页（cursor=0、limit=50），两条一次给全。
      const defaults = await get(h.base, path, OP_TOKEN);
      assert.equal(defaults.status, 200);
      assert.equal((defaults.json.items as unknown[]).length, 2);

      // 只读：评审条数与 lastReview 都没变。
      const view = await h.platform.getMissionView(h.missionId);
      const item = view.workItems.find((w) => w.id === h.workItemId);
      assert.equal(item?.lastReview?.verdict, 'accept');
      const after = await h.platform.getWorkItemReviewHistory(h.missionId, h.workItemId);
      assert.equal(after.total, h.reviewsBefore);
    } finally {
      await stopHarness(h);
    }
  });

  test('非法分页参数 400；未知工单 404；缺凭据 401，且都无写副作用', { timeout: 15000 }, async () => {
    const h = await startHarness();
    try {
      const path = `/api/missions/${h.missionId}/work-items/${h.workItemId}/reviews`;

      for (const query of [
        'cursor=',
        'cursor=1.5',
        'cursor=abc',
        'cursor=NaN',
        'cursor=-1',
        'limit=',
        'limit=1.5',
        'limit=abc',
        'limit=NaN',
        'limit=-1',
        'limit=0',
        'limit=101',
      ]) {
        const res = await get(h.base, `${path}?${query}`, OP_TOKEN);
        assert.equal(res.status, 400, `${query} 必须 400`);
        assert.match(String(res.json.error), /^INVALID_(CURSOR|LIMIT)$/);
      }

      const unknown = await get(
        h.base,
        `/api/missions/${h.missionId}/work-items/W-NOPE/reviews`,
        OP_TOKEN,
      );
      assert.equal(unknown.status, 404);
      assert.equal(unknown.json.error, 'UNKNOWN_WORK_ITEM');

      const unknownMission = await get(
        h.base,
        `/api/missions/M-NOPE/work-items/${h.workItemId}/reviews`,
        OP_TOKEN,
      );
      assert.equal(unknownMission.status, 404);
      assert.equal(unknownMission.json.error, 'UNKNOWN_MISSION');

      const unauthorized = await get(h.base, path);
      assert.equal(unauthorized.status, 401);
      assert.equal(unauthorized.json.error, 'CONTROL_UNAUTHORIZED');
      assert.equal(unauthorized.text.includes(OP_TOKEN), false);

      // 以上全是拒绝路径：评审历史与视图都没动。
      const after = await h.platform.getWorkItemReviewHistory(h.missionId, h.workItemId);
      assert.equal(after.total, h.reviewsBefore);
      const view = await h.platform.getMissionView(h.missionId);
      assert.equal(view.workItems.find((w) => w.id === h.workItemId)?.lastReview?.verdict, 'accept');
    } finally {
      await stopHarness(h);
    }
  });
});
