/**
 * direct 主控的事务边界：真实文件状态下的成功链与回滚。
 *
 * 与 `direct-control-http.test.ts` 的分工：那一份守 HTTP 面（凭据、actor 来源、
 * 非法字段、状态码），用全内存 Platform；这一份只守**文件持久化下的事务语义**：
 *
 *   1. 成功链 plan → contract_check → create_work_item → dispatch 每一条命令
 *      都开一张 host coordinator Attempt，且**每条都已收尾**（structured_submit），
 *      profile.endpoint='host'，usage 不被伪造成「reported 0」。
 *   2. 业务错误（dispatch 一个不存在的工单 → UNKNOWN_WORK_ITEM）整体回滚：视图、活动流、
 *      state.json 字节三者都**一个字节不动**，也不留 in_progress host Attempt。
 *      这是 performDirectControl 把 host Attempt 的开/收尾放进同一命令事务的
 *      直接可观测后果——没有这一层，失败会留下 in_progress 把下一条命令永久挡住。
 *   3. 有活动执行者时主控 plan 被 ACTIVE_EXECUTOR_PRESENT 拒绝，且不新增 host Attempt。
 *   4. 换第二个 buildPersistentPlatform 读同一份隔离 state（第一份没有 exclusive 锁，
 *      不是主状态），确认 direct / plan / workItems / host Attempt 收尾都落盘了。
 *
 * fixture 刻意保持最小：一个 tempdir、一份 state.json、一条 direct Mission。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';

import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { buildPersistentPlatform } from '../src/main.ts';
import { Platform } from '../src/application/platform.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { ValidationEngine } from '../src/application/validation/engine.ts';
import { InMemoryValidationReportRepository } from '../src/application/validation/report-repository.ts';
import type { ChangedPathReader, CommandRunner } from '../src/application/validation/ports.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

const TEMP_PREFIX = 'coagent-direct-control-';
const MISSION = 'M-direct';
const ACTOR = 'external-controller';

const CONTRACT: MissionContract = {
  intent: 'direct 主控事务测试',
  acceptance: ['ok'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const ORDER: WorkOrder = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
};

const PLAN = { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] };

const CHECK = { verdict: 'ok' as const, summary: '契约核对通过' };

/** 临时目录必须真的在 tmpdir 下、且带本测试的前缀，才允许 rmSync。 */
function assertTempContainment(dir: string): void {
  const root = realpathSync(tmpdir());
  const real = realpathSync(dir);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  assert.ok(real.startsWith(prefix), `临时目录越界，拒绝清理：${real}`);
  assert.ok(
    basename(real).startsWith(TEMP_PREFIX),
    `临时目录前缀不符，拒绝清理：${basename(real)}`,
  );
}

function snapshotOfView(view: {
  coordinatorAttemptIds: readonly string[];
  workItems: readonly { id: string; status: string; attemptIds: readonly string[] }[];
}) {
  return {
    coordinatorAttemptIds: [...view.coordinatorAttemptIds],
    workItems: view.workItems.map((item) => ({
      id: item.id,
      status: item.status,
      attemptIds: [...item.attemptIds],
    })),
  };
}

describe('direct 主控：文件状态下的命令事务', () => {
  test(
    '成功链每条 host Attempt 都已收尾；dispatch 不存在的工单整体回滚（视图/活动/字节不变）；有活动执行者时与形状非法时不新增 host Attempt；第二个平台读回持久化结果',
    { timeout: 20000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
      const statePath = join(dir, 'state.json');
      try {
        /* ================= 第一份：真实文件状态上的命令链 ================= */

        const first = await buildPersistentPlatform(statePath, new InPlaceWorkspaceManager());
        const platform = first.platform;

        await platform.createMission({
          projectId: 'P',
          missionId: MISSION,
          contract: CONTRACT,
          coordinationMode: 'direct',
        });
        const created = await platform.getMissionView(MISSION);
        assert.equal(created.coordinationMode, 'direct');

        /* ---- 成功链：plan → contract_check → create_work_item → dispatch ---- */

        const planResult = await platform.performDirectControl(MISSION, ACTOR, {
          action: 'plan',
          plan: PLAN,
        });
        assert.deepEqual(planResult, { action: 'plan', planRevision: 1 });

        const checkResult = await platform.performDirectControl(MISSION, ACTOR, {
          action: 'contract_check',
          check: CHECK,
        });
        assert.deepEqual(checkResult, { action: 'contract_check', contractRevision: 1, verdict: 'ok' });

        const createResult = await platform.performDirectControl(MISSION, ACTOR, {
          action: 'create_work_item',
          title: 'W-1',
          order: ORDER,
        });
        assert.equal(createResult.action, 'create_work_item');
        const workItemId =
          createResult.action === 'create_work_item' ? createResult.workItemId : assert.fail('unreachable');

        const dispatchResult = await platform.performDirectControl(MISSION, ACTOR, {
          action: 'dispatch',
          workItemIds: [workItemId],
        });
        assert.deepEqual(dispatchResult, { action: 'dispatch', dispatched: [workItemId] });

        /* ---- 每条命令各一张 host Attempt，且都已收尾 ---- */

        const afterChain = await platform.getMissionView(MISSION);
        assert.equal(
          afterChain.coordinatorAttemptIds.length,
          4,
          '四条命令应各开一张 coordinator Attempt',
        );
        for (const attemptId of afterChain.coordinatorAttemptIds) {
          const detail = await platform.getAttemptDetail(MISSION, attemptId);
          assert.equal(detail.kind, 'coordinator', `${attemptId} 应是 coordinator`);
          assert.equal(detail.status, 'succeeded', `${attemptId} 已收尾，不得停在 in_progress`);
          assert.equal(detail.endedBy, 'structured_submit', `${attemptId} 应以 structured_submit 收尾`);
          assert.equal(detail.profile?.endpoint, 'host', `${attemptId} 的 endpoint 应是 host`);
          assert.equal(detail.profile?.profileId, 'external-controller');
          // 平台不启动模型：不传 usage，绝不伪造成「reported 0」。
          assert.equal(detail.usage.quality, 'unknown', `${attemptId} 的 usage 不得是 reported`);
          assert.equal(detail.usage.total, 0, `${attemptId} 的 usage 应为空而非上报 0`);
        }

        // 活动流层面同样成立：每条 host attempt.started 都有对应的 attempt.ended。
        const activityAfterChain = await platform.getActivity(MISSION);
        const startedHost = activityAfterChain.filter(
          (event) =>
            event.kind === 'attempt.started' &&
            (event.data as { kind?: string } | undefined)?.kind === 'coordinator',
        );
        assert.equal(startedHost.length, 4, '活动流里应有四条 host attempt.started');
        for (const started of startedHost) {
          const ended = activityAfterChain.find(
            (event) => event.kind === 'attempt.ended' && event.attemptId === started.attemptId,
          );
          assert.ok(ended, `host attempt ${String(started.attemptId)} 没有 attempt.ended`);
          assert.equal(
            (ended.data as { endedBy?: string }).endedBy,
            'structured_submit',
            `host attempt ${String(started.attemptId)} 的 endedBy 不对`,
          );
        }
        assert.equal(
          activityAfterChain.filter((event) => event.kind === 'direct.controller_action').length,
          4,
          '每条命令应各留一条 direct.controller_action',
        );

        /* ---- 业务错误整体回滚：dispatch 一个不存在的工单 ---- */

        const beforeView = snapshotOfView(await platform.getMissionView(MISSION));
        const beforeActivity = JSON.stringify(await platform.getActivity(MISSION));
        const beforeBytes = readFileSync(statePath);

        await assert.rejects(
          platform.performDirectControl(MISSION, ACTOR, {
            action: 'dispatch',
            workItemIds: ['W-does-not-exist'],
          }),
          (error: unknown) => {
            assert.equal((error as { code?: string }).code, 'UNKNOWN_WORK_ITEM');
            return true;
          },
          'dispatch 不存在的工单必须以 UNKNOWN_WORK_ITEM 拒绝',
        );

        const afterView = snapshotOfView(await platform.getMissionView(MISSION));
        assert.deepEqual(afterView, beforeView, '回滚后视图不得变化（含 host Attempt 列表）');
        assert.equal(
          JSON.stringify(await platform.getActivity(MISSION)),
          beforeActivity,
          '回滚后活动流不得多出任何事件',
        );
        assert.ok(
          readFileSync(statePath).equals(beforeBytes),
          '回滚后 state.json 字节必须逐字节相同',
        );
        // 回滚的 host Attempt 随事务消失，不能留 in_progress：下一条命令照常能开。
        const afterRollback = await platform.getMissionView(MISSION);
        assert.equal(afterRollback.coordinatorAttemptIds.length, 4);
        for (const attemptId of afterRollback.coordinatorAttemptIds) {
          const detail = await platform.getAttemptDetail(MISSION, attemptId);
          assert.equal(detail.status, 'succeeded', `${attemptId} 回滚后仍应是已收尾`);
        }

        /* ---- 有活动执行者时主控 plan 被拒，且不新增 host Attempt ---- */

        await platform.startExecutorAttempt(MISSION, workItemId, {
          profileId: 'exec-fixture',
          endpoint: 'runtime',
        });
        const withExecutor = snapshotOfView(await platform.getMissionView(MISSION));
        const bytesWithExecutor = readFileSync(statePath);

        // 形状解析失败一律在事务与 host Attempt 之前拒：缺 plan、plan 形状不对、
        // 白名单外的顶层字段都不该新增 host Attempt，也不该改动 state。
        const shapeFailures: ReadonlyArray<unknown> = [
          { action: 'plan' },
          { action: 'plan', plan: [] },
          { action: 'plan', plan: PLAN, attemptId: 'coord-99' },
        ];
        for (const bad of shapeFailures) {
          await assert.rejects(
            platform.performDirectControl(MISSION, ACTOR, bad as never),
            (error: unknown) => {
              assert.equal((error as { code?: string }).code, 'INVALID_DIRECT_COMMAND');
              return true;
            },
            `形状非法的命令必须被 INVALID_DIRECT_COMMAND 拒绝：${JSON.stringify(bad)}`,
          );
          assert.equal(
            snapshotOfView(await platform.getMissionView(MISSION)).coordinatorAttemptIds.length,
            withExecutor.coordinatorAttemptIds.length,
            '形状非法不得新增 host Attempt',
          );
          assert.ok(
            readFileSync(statePath).equals(bytesWithExecutor),
            '形状非法不得改动 state.json',
          );
        }

        await assert.rejects(
          platform.performDirectControl(MISSION, ACTOR, { action: 'plan', plan: PLAN }),
          (error: unknown) => {
            assert.equal((error as { code?: string }).code, 'ACTIVE_EXECUTOR_PRESENT');
            return true;
          },
          '有 in_progress 执行者时主控 plan 必须被 ACTIVE_EXECUTOR_PRESENT 拒绝',
        );
        assert.deepEqual(
          snapshotOfView(await platform.getMissionView(MISSION)),
          withExecutor,
          '被拒的 plan 不得新增 host Attempt',
        );
        assert.ok(
          readFileSync(statePath).equals(bytesWithExecutor),
          '被拒的 plan 不得改动 state.json',
        );

        /* ================= 第二份：读同一份隔离 state ================= */

        // 第一份没开 exclusive 锁（不是主状态），可以再开一份读；reconcile:false
        // 让这次读不改盘，执行者 attempt 保持原样，正好核对它也被持久化了。
        const second = await buildPersistentPlatform(statePath, {
          workspace: new InPlaceWorkspaceManager(),
          reconcile: false,
        });
        const reloaded = await second.platform.getMissionView(MISSION);
        assert.equal(reloaded.coordinationMode, 'direct', 'coordinationMode 应持久化');
        assert.equal(reloaded.executionMode, 'standard');
        assert.equal(reloaded.runKind, 'mutation');
        assert.equal(reloaded.planRevision, 1, 'plan 应持久化');
        assert.equal(reloaded.plan?.direction, PLAN.direction, 'plan 正文应持久化');
        assert.equal(reloaded.workItems.length, 1, 'workItems 应持久化');
        assert.equal(reloaded.workItems[0]?.id, workItemId);
        assert.equal(reloaded.workItems[0]?.status, 'dispatched', '派发状态应持久化');
        assert.deepEqual(
          [...reloaded.coordinatorAttemptIds],
          [...withExecutor.coordinatorAttemptIds],
          'host Attempt 列表应持久化',
        );
        for (const attemptId of reloaded.coordinatorAttemptIds) {
          const detail = await second.platform.getAttemptDetail(MISSION, attemptId);
          assert.equal(detail.status, 'succeeded', `${attemptId} 重启后仍是已收尾`);
          assert.equal(detail.endedBy, 'structured_submit');
          assert.equal(detail.profile?.endpoint, 'host');
          assert.equal(detail.usage.quality, 'unknown');
        }
        const executorAttemptIds = reloaded.workItems[0]?.attemptIds ?? [];
        assert.equal(executorAttemptIds.length, 1, '执行者 attempt 应持久化');
        const executorDetail = await second.platform.getAttemptDetail(
          MISSION,
          executorAttemptIds[0]!,
        );
        assert.equal(executorDetail.kind, 'executor');
        assert.equal(executorDetail.status, 'in_progress', 'reconcile:false 下执行者保持原样');
      } finally {
        assertTempContainment(dir);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

/**
 * direct 模式的机器验收门禁必须在**公开 review 入口**上，而不只在 direct 主控命令里。
 *
 * 只挂在 direct-control 的 review 分支上等于留了一条路：外部 controller 直接调
 * platform.reviewExecutionResult（legacy 协调者工具走的就是它）就能用一个没跑过
 * 机器验收的提交换到 accept。这里用真实 Platform + ValidationEngine +
 * InMemoryValidationReportRepository 走完整链：
 *   计划 → 核对 → 工单（带 validation.commands）→ 派发 → 执行者交 completed → 收尾，
 * 此时工单 submitted 且没有任何报告，两条入口的 accept 都必须被拒，且拒绝无副作用。
 * 再记基线、跑真实引擎生成当前报告（exit 0、paths=['src/foo.ts']），direct review 才放行；
 * 最后 direct submit 交卷应停在 awaiting_review 而不是 completed。
 */
const ORDER_WITH_VALIDATION: WorkOrder = {
  ...ORDER,
  validation: { commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }] },
};

function harnessWithValidation(runner: CommandRunner, paths: ChangedPathReader) {
  const clock = new FixedClock('2026-06-01T12:00:00.000Z');
  const ids = new SequentialIds();
  const activity = new InMemoryActivityLog(clock);
  const reports = new InMemoryValidationReportRepository();
  const engine = new ValidationEngine({
    clock,
    ids: new SequentialIds(),
    commandRunner: runner,
    changedPathReader: paths,
  });
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    activity,
    clock,
    ids,
    validation: { engine, reports },
  });
  return { platform, reports };
}

/** direct 链走到「执行者交 completed、工单 submitted」，返回工单 id 与提交 attempt。 */
async function submittedInDirectMode(platform: Platform, missionId: string) {
  await platform.createMission({
    projectId: 'P',
    missionId,
    contract: CONTRACT,
    coordinationMode: 'direct',
  });
  await platform.performDirectControl(missionId, ACTOR, { action: 'plan', plan: PLAN });
  await platform.performDirectControl(missionId, ACTOR, { action: 'contract_check', check: CHECK });
  const created = await platform.performDirectControl(missionId, ACTOR, {
    action: 'create_work_item',
    title: 'W-1',
    order: ORDER_WITH_VALIDATION,
  });
  const workItemId =
    created.action === 'create_work_item' ? created.workItemId : assert.fail('unreachable');
  await platform.performDirectControl(missionId, ACTOR, {
    action: 'dispatch',
    workItemIds: [workItemId],
  });
  const exec = await platform.startExecutorAttempt(missionId, workItemId, {
    profileId: 'exec-fixture',
    endpoint: 'runtime',
  });
  await platform.submitEvidence(missionId, exec.attemptId, {
    kind: 'test',
    summary: '绿',
    command: 'node --test',
    exitCode: 0,
  });
  await platform.submitExecutionResult(missionId, exec.attemptId, {
    outcome: 'completed',
    summary: '改好了',
    changedFiles: ['src/foo.ts'],
    evidenceIds: [],
    notes: '无',
  });
  await platform.finishAttempt(missionId, exec.attemptId, { endedBy: 'structured_submit' });
  return { workItemId, execAttemptId: exec.attemptId };
}

const isCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

describe('direct 模式：机器验收门禁在公开 review 入口同样生效', () => {
  test(
    '没报告时两条入口的 accept 都拒且工单仍 submitted；跑出真实 passed 报告后 direct review 放行，交卷停在 awaiting_review',
    { timeout: 20000 },
    async () => {
      const runner: CommandRunner = {
        async run() {
          return { exitCode: 0, timedOut: false, durationMs: 5, output: 'pass' };
        },
      };
      const paths: ChangedPathReader = {
        async listChanged() {
          return ['src/foo.ts'];
        },
      };
      const { platform, reports } = harnessWithValidation(runner, paths);
      const missionId = 'M-direct-gate';
      const { workItemId, execAttemptId } = await submittedInDirectMode(platform, missionId);

      const before = await platform.getMissionView(missionId);
      assert.equal(before.workItems[0]!.status, 'submitted', '前置：执行者交卷后应是 submitted');
      assert.equal(before.workItems[0]!.hasResult, true, '前置：工单上已有执行结果');
      assert.equal(before.workItems[0]!.lastReview, undefined, '前置：还没有人评审');
      const coordinatorAttemptsBefore = [...before.coordinatorAttemptIds];

      /* ---- 没有报告：direct 主控 review accept 被拒 ---- */

      await assert.rejects(
        platform.performDirectControl(missionId, ACTOR, {
          action: 'review',
          workItemId,
          verdict: 'accept',
          reasons: ['看着没问题'],
          requiredChanges: [],
        }),
        isCode('DIRECT_ACCEPT_REPORT_REQUIRED'),
        'direct review accept 没有报告必须被拒',
      );

      /* ---- 同一事实，legacy 公开入口也必须被拒（本改动要修的绕过） ---- */

      const legacy = await platform.startCoordinatorAttempt(missionId);
      await assert.rejects(
        platform.reviewExecutionResult(missionId, legacy.attemptId, {
          workItemId,
          verdict: 'accept',
          reasons: ['绕过 direct 主控'],
          requiredChanges: [],
        }),
        isCode('DIRECT_ACCEPT_REPORT_REQUIRED'),
        'legacy reviewExecutionResult 也必须有报告才 accept',
      );

      const afterReject = await platform.getMissionView(missionId);
      assert.equal(afterReject.workItems[0]!.status, 'submitted', '被拒后工单仍是 submitted');
      assert.equal(afterReject.workItems[0]!.lastReview, undefined, '被拒后不得留下评审记录');
      // 内存装配没有仓储事务（C4 只在持久化层才有）：被拒的 host Attempt 留在列表里，
      // 但必须已经收尾成 interrupted，**绝不能** stop 在 in_progress。
      const hostAttempt = afterReject.coordinatorAttemptIds.find(
        (id) => !coordinatorAttemptsBefore.includes(id) && id !== legacy.attemptId,
      );
      if (hostAttempt !== undefined) {
        const hostDetail = await platform.getAttemptDetail(missionId, hostAttempt);
        assert.notEqual(hostDetail.status, 'in_progress', '被拒不得留下 in_progress host Attempt');
        assert.equal(hostDetail.endedBy, 'interrupted', '无事务时 host Attempt 以 interrupted 收尾');
      }
      assert.deepEqual(
        [...afterReject.coordinatorAttemptIds],
        [...coordinatorAttemptsBefore, ...(hostAttempt ? [hostAttempt] : []), legacy.attemptId],
        '除被拒的 host Attempt 与测试自己的协调者 attempt 外，不得多出别的 attempt',
      );
      const activityAfterReject = await platform.getActivity(missionId);
      assert.equal(
        activityAfterReject.filter((event) => event.kind === 'review.recorded').length,
        0,
        '被拒不得写 review.recorded',
      );
      assert.equal(
        activityAfterReject.filter((event) => event.kind === 'validation.reported').length,
        0,
        '没有报告时不得凭空出现 validation.reported',
      );
      await platform.finishAttempt(missionId, legacy.attemptId, { endedBy: 'structured_submit' });

      /* ---- 记基线 + 跑真实引擎：报告 passed，规格与当前工单全等 ---- */

      // 引擎要可信项目工作区：projectRoot 由 WorkspaceManager 注入的同一格，测试直接记。
      await platform.recordWorkspace(missionId, {
        projectRoot: '/proj',
        branch: '(in-place)',
        baseRevision: 'base-1',
        targetBranch: '(in-place)',
      });
      await platform.recordStandardValidationBaseline({
        missionId,
        workItemId,
        head: 'base-1',
      });
      const validated = await platform.validateStandardWorkItem({
        missionId,
        workItemId,
        cwd: '/proj',
      });
      assert.equal(validated?.passed, true, '前置：真实引擎应产出 passed 报告');
      const report = await reports.get(validated!.reportId);
      assert.ok(report, '报告应已落盘');
      assert.equal(report.attemptId, execAttemptId, '报告要绑在当前提交 attempt 上');
      assert.equal(report.checks[0]?.kind, 'command');
      assert.equal(report.checks[0]?.command?.exitCode, 0);
      assert.deepEqual(report.checks[1]?.changedPaths?.actual ?? [], ['src/foo.ts']);

      // direct 主控 review：同一条真实新路径放行，host Attempt 由命令自己开与收尾。
      const reviewOut = await platform.performDirectControl(missionId, ACTOR, {
        action: 'review',
        workItemId,
        verdict: 'accept',
        reasons: ['机器报告 passed'],
        requiredChanges: [],
        acceptanceResults: [
          { criterion: 'foo() === 1', status: 'pass', evidence: 'node --test 退出码 0' },
        ],
      });
      assert.equal(reviewOut.action, 'review');
      assert.equal(
        reviewOut.action === 'review' ? reviewOut.status : assert.fail('unreachable'),
        'accepted',
        '有真实 passed 报告时 direct review accept 应放行',
      );
      const accepted = await platform.getMissionView(missionId);
      assert.equal(accepted.workItems[0]!.status, 'accepted');
      assert.equal(
        accepted.workItems[0]!.lastReview?.submittedAttemptId,
        execAttemptId,
        '评审要绑到当前提交 attempt',
      );

      /* ---- direct 交卷：停在 awaiting_review，不是 completed ---- */

      const submitted = await platform.performDirectControl(missionId, ACTOR, {
        action: 'submit',
        result: {
          outcome: 'delivered',
          summary: '交付',
          acceptanceEvidence: ['node --test 绿'],
          memoryDelta: [],
          openRisks: [],
        },
      });
      assert.deepEqual(submitted, { action: 'submit' });
      const finalView = await platform.getMissionView(missionId);
      assert.equal(finalView.status, 'awaiting_review', '交卷后等 L3，不是 completed');
    },
  );
});
