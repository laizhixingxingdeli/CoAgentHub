/**
 * 角色 Context Bundle：确定性、按角色、来源可追溯；投影不得改旧简报语义。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COORDINATOR_SOURCE_ORDER,
  EXECUTOR_SOURCE_ORDER,
  buildContextBundle,
  projectStartupBriefFields,
  type BoundWorkItem,
  type WorkItemIndexEntry,
  type SinceLastHopEntry,
} from '../src/application/context-builder.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import type { FinalReview, MissionContract, PlanBody, WorkOrder } from '../src/kernel/index.ts';

const SHA256_HEX = /^[0-9a-f]{64}$/;

const CONTRACT: MissionContract = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
};

const PLAN: PlanBody = {
  findings: 'f',
  rejectedHypotheses: [],
  decisions: [],
  direction: 'd',
  risks: [],
};

const W1_REFS: WorkOrder['contextRefs'] = [
  'src/does-not-exist-w1.ts',
  { kind: 'living_spec', ref: 'missing-spec', why: '规格在这儿' },
  { kind: 'contract', ref: 'contract', why: '验收标准在这儿' },
  { kind: 'previous_result', ref: 'W-prev', why: '上一工单结果' },
];

const ORDER: WorkOrder = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: W1_REFS,
};

const WORK_ITEM = { id: 'W1', title: 'W', order: ORDER };

const WORK_ITEMS_INDEX: readonly WorkItemIndexEntry[] = [
  { id: 'W1', title: 'W', status: 'dispatched', attempts: 1, lastReviewVerdict: 'approved' },
  { id: 'W2', title: 'W2', status: 'pending', attempts: 0 },
];

const SINCE_LAST_HOP: SinceLastHopEntry = [
  { summary: 'W1 已通过，建议进入 merged 放行。' },
];

const REVIEW: FinalReview = {
  verdict: 'send_back',
  reasons: ['Contract 已更新，需要重新规划'],
};

const NOTES = ['Windows：bash 的 `/tmp` 和 Node 的 `/tmp` 不是同一个目录。'];

function identities(bundle: ReturnType<typeof buildContextBundle>) {
  return bundle.entries.map((entry) => ({
    source: entry.source,
    revision: entry.revision,
    hash: entry.hash,
  }));
}

function coordinatorInput(overrides: Partial<Parameters<typeof buildContextBundle>[0]> = {}) {
  return {
    role: 'coordinator' as const,
    projectRules: 'kernel 不得依赖任何第三方包。',
    environmentNotes: NOTES,
    contract: CONTRACT,
    contractRevision: 1,
    plan: PLAN,
    planRevision: 1,
    finalReview: REVIEW,
    workItem: WORK_ITEM,
    ...overrides,
  };
}

function executorInput(overrides: Partial<Parameters<typeof buildContextBundle>[0]> = {}) {
  return {
    role: 'executor' as const,
    projectRules: 'kernel 不得依赖任何第三方包。',
    environmentNotes: NOTES,
    contract: CONTRACT,
    contractRevision: 1,
    plan: PLAN,
    planRevision: 1,
    finalReview: REVIEW,
    workItem: WORK_ITEM,
    ...overrides,
  };
}

function makePlatform() {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    workspace: new InPlaceWorkspaceManager(),
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
  return platform;
}

function repoWithRules(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coagent-ctx-rules-'));
  mkdirSync(join(dir, '.coagent'), { recursive: true });
  writeFileSync(
    join(dir, '.coagent', 'project.md'),
    '# 架构约束\n\nkernel 不得依赖任何第三方包。\n',
    'utf8',
  );
  return dir;
}

async function upTo(platform: Platform, root: string) {
  await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
  await platform.recordWorkspace('M1', { projectRoot: root, branch: 'b', baseRevision: 'x' });
  const coord = await platform.startCoordinatorAttempt('M1');
  await platform.updatePlan('M1', coord.attemptId, PLAN);
  const { workItemId } = await platform.createWorkItem('M1', coord.attemptId, {
    title: 'W',
    order: ORDER,
  });
  await platform.dispatchWorkItems('M1', coord.attemptId, [workItemId]);
  const exec = await platform.startExecutorAttempt('M1', workItemId);
  return { coordId: coord.attemptId, execId: exec.attemptId, workItemId };
}

describe('buildContextBundle', () => {
  test('简报仅向协调者投影 mission.routed 分类事实', async () => {
    const platform = makePlatform();
    await platform.createClassifiedMission({
      projectId: 'P', missionId: 'M-route', contract: CONTRACT,
      facts: {
        mutationSideEffect: true, readOnlyProven: 'unknown',
        highAssurance: { productionDeployRelease: false, externalPaidOp: false, destructiveData: false, credentialsPermissionsSecurity: false, schemaPublicApiPersistenceCompat: false, unrecoverableExternalSideEffect: false },
        standardFloor: { publicInterface: true, buildSystemOrDependency: false, multipleDomainModules: false, acceptanceNotCheckableUpfront: false, rootCauseOrCompetingDesigns: false },
      } as never,
      assessment: {
        goalUncertainty: 1, changeScope: 1, operationalRisk: 1,
        verificationDifficulty: 1, coordinationNeed: 1, recoveryDifficulty: 2,
        reasons: ['评估说明'], decidedBy: 'rule', assessedAt: '2026-03-21T12:00:00.000Z',
      } as never,
    });
    const coord = await platform.startCoordinatorAttempt('M-route');
    const brief = await platform.getStartupBrief('M-route', coord.attemptId);
    const entry = brief.contextBundle.entries.find((item) => item.source === 'classification');
    assert.ok(entry);
    assert.ok(entry.estimatedTokens > 0);
    const content = String(entry.content);
    assert.match(content, /mutationSideEffect/);
    assert.match(content, /unknown/);
    assert.doesNotMatch(content, /productionDeployRelease/);
    assert.match(content, /publicInterface/);
    assert.doesNotMatch(content, /multipleDomainModules/);
    assert.match(content, /unknowns:/);
    assert.match(content, /reasons:/);
    assert.match(content, /评估说明/);

    await platform.updatePlan('M-route', coord.attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem('M-route', coord.attemptId, {
      title: 'W', order: ORDER,
    });
    await platform.dispatchWorkItems('M-route', coord.attemptId, [workItemId]);
    const exec = await platform.startExecutorAttempt('M-route', workItemId);
    const executorBrief = await platform.getStartupBrief('M-route', exec.attemptId);
    assert.equal(executorBrief.contextBundle.entries.some((item) => item.source === 'classification'), false);

    await platform.createMission({ projectId: 'P', missionId: 'M-plain', contract: CONTRACT });
    const plainCoord = await platform.startCoordinatorAttempt('M-plain');
    const plainBrief = await platform.getStartupBrief('M-plain', plainCoord.attemptId);
    assert.equal(plainBrief.contextBundle.entries.some((item) => item.source === 'classification'), false);

    await platform.createMission({ projectId: 'P', missionId: 'M-long', contract: CONTRACT });
    await platform.recordStandardFallbackRoute('M-long', {
      classification: {
        recommended: 'standard', confidence: 'high', facts: { confirmed: true },
        unknowns: [], criticalUnknowns: [], reasons: ['理由'.repeat(3000)],
      } as never,
      fallbackReason: 'fallback',
    });
    const longCoord = await platform.startCoordinatorAttempt('M-long');
    const longBrief = await platform.getStartupBrief('M-long', longCoord.attemptId);
    const longContent = String(longBrief.contextBundle.entries.find((item) => item.source === 'classification')?.content);
    assert.ok(longContent.length <= 2000);
    assert.match(longContent, /已截断/);
  });
  test('相同输入重复构造深度相等', () => {
    const input = coordinatorInput();
    assert.deepEqual(buildContextBundle(input), buildContextBundle(input));
    const exec = executorInput();
    assert.deepEqual(buildContextBundle(exec), buildContextBundle(exec));
  });

  test('两个角色来源固定顺序，多喂的字段按角色丢掉', () => {
    const coord = buildContextBundle(coordinatorInput());
    const exec = buildContextBundle(executorInput());
    assert.deepEqual(
      coord.entries.map((e) => e.source),
      COORDINATOR_SOURCE_ORDER.filter((source) => source !== 'classification'),
    );
    assert.deepEqual(
      exec.entries.map((e) => e.source),
      [...EXECUTOR_SOURCE_ORDER],
    );
    assert.equal(coord.entries.some((e) => e.source === 'work_order'), false);
    assert.equal(exec.entries.some((e) => e.source === 'contract'), false);
    assert.equal(exec.entries.some((e) => e.source === 'plan'), false);
    assert.equal(exec.entries.some((e) => e.source === 'final_review'), false);
  });

  test('classification 仅作为显式 coordinator 来源并投影', () => {
    const classification = '分类阶段已查明：问题来自上下文投影。';
    const coord = buildContextBundle(coordinatorInput({ classification }));
    const entry = coord.entries.find((item) => item.source === 'classification');
    assert.ok(entry);
    assert.ok(entry.estimatedTokens > 0);
    assert.equal(projectStartupBriefFields(coord).classification, classification);
    assert.deepEqual(
      coord.entries.map((item) => item.source),
      [...COORDINATOR_SOURCE_ORDER],
    );

    const exec = buildContextBundle(executorInput({ classification }));
    assert.equal(exec.entries.some((item) => item.source === 'classification'), false);
    assert.equal(projectStartupBriefFields(exec).classification, undefined);
  });

  test('协调者显式喂两项索引/增量时按序追加并投影，plan 完整；执行者不含两项', () => {
    const coord = buildContextBundle(
      coordinatorInput({ workItemsIndex: WORK_ITEMS_INDEX, sinceLastHop: SINCE_LAST_HOP }),
    );
    assert.deepEqual(
      coord.entries.map((e) => e.source),
      [...COORDINATOR_SOURCE_ORDER.filter((s) => s !== 'classification'), 'work_items_index', 'since_last_hop'],
    );
    const idx = coord.entries.find((e) => e.source === 'work_items_index');
    const since = coord.entries.find((e) => e.source === 'since_last_hop');
    assert.ok(idx);
    assert.ok(since);
    assert.ok(idx.estimatedTokens > 0);
    assert.ok(since.estimatedTokens > 0);
    assert.match(idx.hash ?? '', SHA256_HEX);
    assert.match(since.hash ?? '', SHA256_HEX);
    assert.ok(idx.reason.length > 0);
    assert.ok(since.reason.length > 0);
    // hash 反映内容：换一份索引得到不同的 hash。
    const otherCoord = buildContextBundle(
      coordinatorInput({
        workItemsIndex: [{ id: 'W9', title: '别的', status: 'pending', attempts: 0 }],
        sinceLastHop: SINCE_LAST_HOP,
      }),
    );
    const otherIdx = otherCoord.entries.find((e) => e.source === 'work_items_index');
    assert.notEqual(otherIdx?.hash, idx.hash);
    const plan = coord.entries.find((e) => e.source === 'plan');
    assert.equal(plan?.revision, 1);
    assert.deepEqual(plan?.content, PLAN);
    const projected = projectStartupBriefFields(coord);
    assert.deepEqual(projected.workItemsIndex, WORK_ITEMS_INDEX);
    assert.deepEqual(projected.sinceLastHop, SINCE_LAST_HOP);
    assert.deepEqual(projected.plan, PLAN);
    assert.equal(projected.planRevision, 1);

    const emptyCoord = buildContextBundle(
      coordinatorInput({ workItemsIndex: [], sinceLastHop: [] }),
    );
    assert.equal(emptyCoord.entries.some((e) => e.source === 'work_items_index'), true);
    assert.equal(emptyCoord.entries.some((e) => e.source === 'since_last_hop'), true);

    const exec = buildContextBundle(
      executorInput({ workItemsIndex: WORK_ITEMS_INDEX, sinceLastHop: SINCE_LAST_HOP }),
    );
    assert.equal(exec.entries.some((e) => e.source === 'work_items_index'), false);
    assert.equal(exec.entries.some((e) => e.source === 'since_last_hop'), false);
    const execProjected = projectStartupBriefFields(exec);
    assert.equal(execProjected.workItemsIndex, undefined);
    assert.equal(execProjected.sinceLastHop, undefined);
  });

  test('每条含 source、revision 或 SHA-256 hash、reason、estimatedTokens', () => {
    const bundle = buildContextBundle(coordinatorInput());
    for (const entry of bundle.entries) {
      assert.equal(typeof entry.source, 'string');
      assert.equal(typeof entry.reason, 'string');
      assert.ok(entry.reason.length > 0);
      assert.equal(typeof entry.estimatedTokens, 'number');
      assert.ok(Number.isInteger(entry.estimatedTokens));
      assert.ok(entry.estimatedTokens >= 0);
      const hasRevision = typeof entry.revision === 'number';
      const hasHash = typeof entry.hash === 'string';
      assert.equal(hasRevision || hasHash, true, `${entry.source} 要有 revision 或 hash`);
      assert.equal(hasRevision && hasHash, false, `${entry.source} 不能两个标识一起用`);
      if (hasHash) assert.match(entry.hash as string, SHA256_HEX);
    }
    const contract = bundle.entries.find((e) => e.source === 'contract');
    const plan = bundle.entries.find((e) => e.source === 'plan');
    const rules = bundle.entries.find((e) => e.source === 'project_rules');
    assert.equal(contract?.revision, 1);
    assert.equal(plan?.revision, 1);
    assert.equal(contract?.hash, undefined);
    assert.equal(rules?.revision, undefined);
    assert.match(rules?.hash ?? '', SHA256_HEX);
  });

  test('改契约只动契约来源标识，改红线只动红线 hash', () => {
    const base = coordinatorInput();
    const orig = buildContextBundle(base);
    const afterContract = buildContextBundle(
      coordinatorInput({
        contract: { ...CONTRACT, intent: '改了目标' },
        contractRevision: 2,
      }),
    );
    const afterRules = buildContextBundle(
      coordinatorInput({ projectRules: 'kernel 仍然零依赖，但红线换了措辞。' }),
    );

    const origIds = identities(orig);
    const contractIds = identities(afterContract);
    const rulesIds = identities(afterRules);

    assert.notEqual(
      contractIds.find((i) => i.source === 'contract')?.revision,
      origIds.find((i) => i.source === 'contract')?.revision,
    );
    for (const source of ['project_rules', 'environment_notes', 'plan', 'final_review'] as const) {
      assert.deepEqual(
        contractIds.find((i) => i.source === source),
        origIds.find((i) => i.source === source),
        `改契约不应改 ${source} 的标识`,
      );
    }

    assert.notEqual(
      rulesIds.find((i) => i.source === 'project_rules')?.hash,
      origIds.find((i) => i.source === 'project_rules')?.hash,
    );
    for (const source of ['environment_notes', 'contract', 'plan', 'final_review'] as const) {
      assert.deepEqual(
        rulesIds.find((i) => i.source === source),
        origIds.find((i) => i.source === source),
        `改红线不应改 ${source} 的标识`,
      );
    }
  });

  test('来源标识不暴露原文、Mission/Attempt id 或凭据形状', () => {
    const leak = 'sk-ant-testvalue1234567890';
    const bundle = buildContextBundle(
      coordinatorInput({
        projectRules: `红线含凭据 ${leak} 以及 M-LEAK 与 A-LEAK`,
        contract: { ...CONTRACT, intent: `目标 M-LEAK ${leak}` },
        workItem: { id: 'W-LEAK', title: 'M-LEAK', order: ORDER },
      }),
    );
    for (const entry of bundle.entries) {
      const meta = `${entry.source}\n${entry.revision ?? ''}\n${entry.hash ?? ''}`;
      assert.equal(meta.includes(leak), false, '凭据不得出现在标识里');
      assert.equal(meta.includes('M-LEAK'), false);
      assert.equal(meta.includes('A-LEAK'), false);
      assert.equal(meta.includes('W-LEAK'), false);
      assert.equal(meta.includes('红线含凭据'), false);
      assert.equal(meta.includes(CONTRACT.intent), false);
    }
  });

  test('无记忆时仍可构造，红线内容缺省', () => {
    const bundle = buildContextBundle(
      coordinatorInput({ projectRules: undefined, finalReview: undefined }),
    );
    const projected = projectStartupBriefFields(bundle);
    assert.equal(projected.projectRules, undefined);
    assert.deepEqual(projected.environmentNotes, NOTES);
    assert.deepEqual(projected.contract, CONTRACT);
    assert.equal(projected.finalReview, undefined);
    const rules = bundle.entries.find((e) => e.source === 'project_rules');
    assert.equal(rules?.content, undefined);
    assert.match(rules?.hash ?? '', SHA256_HEX);
  });

  test('执行者工单保留四种 contextRefs 原样，不预取正文', () => {
    const bundle = buildContextBundle(executorInput());
    const work = bundle.entries.find((e) => e.source === 'work_order');
    const bound = work?.content as { id: string; title: string; order: WorkOrder };
    assert.deepEqual(bound.order.contextRefs, W1_REFS);
    const dumped = JSON.stringify(work?.content);
    assert.equal(dumped.includes('"body"'), false);
    assert.equal(dumped.includes('kernel 不得依赖'), false);
    // 构造器自己不读盘：引用指向不存在的文件也不会炸。
    assert.equal(bound.order.contextRefs[0], 'src/does-not-exist-w1.ts');
  });

  test('红线 hash 等于内容 SHA-256，不等于原文', () => {
    const rules = 'kernel 不得依赖任何第三方包。';
    const bundle = buildContextBundle(coordinatorInput({ projectRules: rules }));
    const entry = bundle.entries.find((e) => e.source === 'project_rules');
    assert.equal(entry?.hash, createHash('sha256').update(rules, 'utf8').digest('hex'));
    assert.notEqual(entry?.hash, rules);
  });
});

describe('projectStartupBriefFields', () => {
  test('协调者投影契约/规划/打回，执行者投影工单', () => {
    const coord = projectStartupBriefFields(buildContextBundle(coordinatorInput()));
    const exec = projectStartupBriefFields(buildContextBundle(executorInput()));
    assert.equal(coord.contract?.intent, CONTRACT.intent);
    assert.equal(coord.contractRevision, 1);
    assert.equal(coord.plan?.direction, PLAN.direction);
    assert.equal(coord.planRevision, 1);
    assert.equal(coord.finalReview?.verdict, 'send_back');
    assert.equal(coord.workItem, undefined);
    assert.equal(exec.workItem?.id, 'W1');
    assert.equal(exec.contract, undefined);
    assert.equal(exec.plan, undefined);
    assert.equal(exec.finalReview, undefined);
    assert.equal(exec.contractRevision, undefined);
  });
});

function utf8Tokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function bundleTotal(bundle: ReturnType<typeof buildContextBundle>): number {
  return bundle.entries.reduce((sum, entry) => sum + entry.estimatedTokens, 0);
}

describe('buildContextBundle 预算裁剪', () => {
  const RULES = '架构红线：内核禁止第三方依赖。';
  const ENV = ['环境：工作区路径含中文「临时」。'];

  test('非 ASCII 固定文本按 UTF-8 字节 / 4 上取整；恰等于 N 全留，N-1 先去掉 plan', () => {
    const input = coordinatorInput({ projectRules: RULES, environmentNotes: ENV });
    const full = buildContextBundle(input);
    const rules = full.entries.find((e) => e.source === 'project_rules');
    const notes = full.entries.find((e) => e.source === 'environment_notes');
    assert.equal(rules?.estimatedTokens, utf8Tokens(RULES));
    assert.notEqual(utf8Tokens(RULES), Math.ceil(RULES.length / 4));
    assert.equal(notes?.estimatedTokens, utf8Tokens(JSON.stringify(ENV)));
    assert.notEqual(utf8Tokens(JSON.stringify(ENV)), Math.ceil(JSON.stringify(ENV).length / 4));

    const N = bundleTotal(full);
    const atBudget = buildContextBundle(input, N);
    assert.deepEqual(
      atBudget.entries.map((e) => e.source),
      COORDINATOR_SOURCE_ORDER.filter((source) => source !== 'classification'),
    );
    assert.deepEqual(atBudget.entries, full.entries);
    assert.deepEqual(atBudget.budgetReport?.omittedSources, []);
    assert.equal(atBudget.budgetReport?.budget, N);
    assert.equal(atBudget.budgetReport?.estimatedBefore, N);
    assert.equal(atBudget.budgetReport?.estimatedAfter, N);
    assert.equal(atBudget.budgetReport?.overflow, false);
    assert.equal(atBudget.budgetReport?.remainingOverBudget, 0);

    const planTokens = full.entries.find((e) => e.source === 'plan')?.estimatedTokens ?? 0;
    assert.ok(planTokens >= 1);
    const trimmed = buildContextBundle(input, N - 1);
    assert.deepEqual(trimmed.entries.map((e) => e.source), [
      'project_rules',
      'environment_notes',
      'contract',
      'final_review',
    ]);
    assert.deepEqual(trimmed.budgetReport?.omittedSources, ['plan']);
    assert.equal(trimmed.budgetReport?.estimatedBefore, N);
    assert.equal(trimmed.budgetReport?.estimatedAfter, N - planTokens);
    assert.equal(trimmed.budgetReport?.estimatedAfter, bundleTotal(trimmed));
    assert.equal(trimmed.budgetReport?.overflow, false);
    assert.equal(trimmed.budgetReport?.remainingOverBudget, 0);
  });

  test('超预算时不丢不截协调者契约/红线/打回与执行者工单/contextRefs/红线', () => {
    const coordInput = coordinatorInput({ projectRules: RULES, environmentNotes: ENV });
    const coordFull = buildContextBundle(coordInput);
    const planTokens =
      coordFull.entries.find((e) => e.source === 'plan')?.estimatedTokens ?? 0;
    const notesTokens =
      coordFull.entries.find((e) => e.source === 'environment_notes')?.estimatedTokens ?? 0;
    const requiredBudget = bundleTotal(coordFull) - planTokens - notesTokens;
    const coord = buildContextBundle(coordInput, Math.max(0, requiredBudget - 1));

    assert.deepEqual(coord.budgetReport?.omittedSources, ['plan', 'environment_notes']);
    assert.deepEqual(coord.entries.map((e) => e.source), [
      'project_rules',
      'contract',
      'final_review',
    ]);
    assert.equal(coord.entries.find((e) => e.source === 'project_rules')?.content, RULES);
    assert.deepEqual(coord.entries.find((e) => e.source === 'contract')?.content, CONTRACT);
    assert.deepEqual(coord.entries.find((e) => e.source === 'final_review')?.content, REVIEW);
    const contract = coord.entries.find((e) => e.source === 'contract')?.content as MissionContract;
    assert.equal(contract.intent, CONTRACT.intent);
    assert.deepEqual(contract.acceptance, CONTRACT.acceptance);
    assert.deepEqual(contract.constraints, CONTRACT.constraints);
    assert.deepEqual(contract.guardrails, CONTRACT.guardrails);
    assert.deepEqual(contract.nonGoals, CONTRACT.nonGoals);

    const coordProjected = projectStartupBriefFields(coord);
    assert.equal(coordProjected.projectRules, RULES);
    assert.deepEqual(coordProjected.contract, CONTRACT);
    assert.deepEqual(coordProjected.finalReview, REVIEW);
    assert.equal(coordProjected.plan, undefined);
    assert.equal(coordProjected.environmentNotes, undefined);

    const execInput = executorInput({ projectRules: RULES, environmentNotes: ENV });
    const execFull = buildContextBundle(execInput);
    const execNotes =
      execFull.entries.find((e) => e.source === 'environment_notes')?.estimatedTokens ?? 0;
    const exec = buildContextBundle(execInput, bundleTotal(execFull) - execNotes);
    assert.deepEqual(exec.budgetReport?.omittedSources, ['environment_notes']);
    assert.deepEqual(exec.entries.map((e) => e.source), ['project_rules', 'work_order']);
    assert.equal(exec.entries.find((e) => e.source === 'project_rules')?.content, RULES);
    const work = exec.entries.find((e) => e.source === 'work_order')?.content as typeof WORK_ITEM;
    assert.deepEqual(work, WORK_ITEM);
    assert.deepEqual(work.order.contextRefs, W1_REFS);
    const execProjected = projectStartupBriefFields(exec);
    assert.equal(execProjected.projectRules, RULES);
    assert.deepEqual(execProjected.workItem, WORK_ITEM);
    assert.equal(execProjected.environmentNotes, undefined);
  });

  test('只有必需内容仍超预算时完整返回 overflow，未配置预算无裁剪报告', () => {
    const input = coordinatorInput({ projectRules: RULES, environmentNotes: ENV });
    const full = buildContextBundle(input);
    assert.equal('budgetReport' in full, false);
    assert.deepEqual(
      full.entries.map((e) => e.source),
      COORDINATOR_SOURCE_ORDER.filter((source) => source !== 'classification'),
    );
    const projected = projectStartupBriefFields(full);
    assert.equal(projected.projectRules, RULES);
    assert.deepEqual(projected.environmentNotes, ENV);
    assert.deepEqual(projected.contract, CONTRACT);
    assert.deepEqual(projected.plan, PLAN);
    assert.deepEqual(projected.finalReview, REVIEW);

    const requiredOnly = buildContextBundle(input, 0);
    const estimatedAfter = bundleTotal(requiredOnly);
    assert.ok(estimatedAfter > 0);
    assert.equal(requiredOnly.budgetReport?.budget, 0);
    assert.equal(requiredOnly.budgetReport?.estimatedBefore, bundleTotal(full));
    assert.equal(requiredOnly.budgetReport?.estimatedAfter, estimatedAfter);
    assert.equal(requiredOnly.budgetReport?.overflow, true);
    assert.equal(requiredOnly.budgetReport?.remainingOverBudget, estimatedAfter - 0);
    assert.deepEqual(requiredOnly.budgetReport?.omittedSources, ['plan', 'environment_notes']);
    assert.deepEqual(requiredOnly.entries.find((e) => e.source === 'contract')?.content, CONTRACT);
    assert.equal(requiredOnly.entries.find((e) => e.source === 'project_rules')?.content, RULES);
    assert.deepEqual(requiredOnly.entries.find((e) => e.source === 'final_review')?.content, REVIEW);

    const execFull = buildContextBundle(executorInput({ projectRules: RULES, environmentNotes: ENV }));
    assert.equal('budgetReport' in execFull, false);
    assert.deepEqual(
      execFull.entries.map((e) => e.source),
      [...EXECUTOR_SOURCE_ORDER],
    );
    const execOverflow = buildContextBundle(
      executorInput({ projectRules: RULES, environmentNotes: ENV }),
      0,
    );
    assert.equal(execOverflow.budgetReport?.overflow, true);
    assert.equal(
      execOverflow.budgetReport?.remainingOverBudget,
      bundleTotal(execOverflow) - 0,
    );
    assert.deepEqual(execOverflow.entries.find((e) => e.source === 'work_order')?.content, WORK_ITEM);
  });
});

describe('getStartupBrief 从 Bundle 投影旧字段', () => {
  test('协调者和执行者旧字段逐字段不变，并带上 contextBundle', async () => {
    const platform = makePlatform();
    const root = repoWithRules();
    const { coordId, execId, workItemId } = await upTo(platform, root);

    const exec = await platform.getStartupBrief('M1', execId);
    const coord = await platform.getStartupBrief('M1', coordId);

    assert.equal(exec.role, 'executor');
    assert.equal(exec.workItem?.id, workItemId);
    assert.equal(exec.workItem?.order?.objective, ORDER.objective);
    assert.match(exec.projectRules ?? '', /kernel 不得依赖任何第三方包/);
    assert.equal(exec.contract, undefined);
    assert.equal(exec.plan, undefined);
    assert.deepEqual(exec.workItem?.order?.contextRefs, W1_REFS);
    assert.equal(exec.contextBundle.role, 'executor');
    assert.deepEqual(
      exec.contextBundle.entries.map((e) => e.source),
      [...EXECUTOR_SOURCE_ORDER],
    );

    assert.equal(coord.role, 'coordinator');
    assert.equal(coord.contract?.intent, CONTRACT.intent);
    assert.equal(coord.contractRevision, 1);
    assert.equal(coord.plan?.direction, PLAN.direction);
    assert.equal(coord.workItem, undefined);
    assert.match(coord.projectRules ?? '', /kernel 不得依赖/);
    assert.equal(coord.contextBundle.role, 'coordinator');
    assert.deepEqual(
      coord.contextBundle.entries.map((e) => e.source),
      COORDINATOR_SOURCE_ORDER.filter((source) => source !== 'classification'),
    );

    const execProjected = projectStartupBriefFields(exec.contextBundle);
    assert.equal(execProjected.projectRules, exec.projectRules);
    assert.deepEqual(execProjected.environmentNotes, exec.environmentNotes);
    assert.deepEqual(execProjected.workItem, exec.workItem);

    const coordProjected = projectStartupBriefFields(coord.contextBundle);
    assert.equal(coordProjected.projectRules, coord.projectRules);
    assert.deepEqual(coordProjected.environmentNotes, coord.environmentNotes);
    assert.deepEqual(coordProjected.contract, coord.contract);
    assert.equal(coordProjected.contractRevision, coord.contractRevision);
    assert.deepEqual(coordProjected.plan, coord.plan);
    assert.equal(coordProjected.planRevision, coord.planRevision);
    assert.deepEqual(coordProjected.finalReview, coord.finalReview);
  });

  test('没有架构红线时不报错，projectRules 缺省，其余照给', async () => {
    const platform = makePlatform();
    const empty = mkdtempSync(join(tmpdir(), 'coagent-ctx-norules-'));
    const { coordId } = await upTo(platform, empty);
    const brief = await platform.getStartupBrief('M1', coordId);
    assert.equal(brief.projectRules, undefined);
    assert.equal(brief.contract?.intent, CONTRACT.intent);
    assert.equal(brief.contextBundle.entries.find((e) => e.source === 'project_rules')?.content, undefined);
  });

  test('执行者简报不预取 contextRefs 正文，getContext 仍按需取', async () => {
    const platform = makePlatform();
    const root = repoWithRules();
    const { execId } = await upTo(platform, root);
    const brief = await platform.getStartupBrief('M1', execId);
    const dumped = JSON.stringify(brief.workItem);
    assert.equal(dumped.includes('"body"'), false);
    assert.deepEqual(brief.workItem?.order?.contextRefs, W1_REFS);
    // 四种引用只作为 order 引用留下；契约正文和上一工单结果都不预取。
    assert.equal(dumped.includes('修 X'), false);
    assert.equal(dumped.includes('executionResult'), false);

    const file = await platform.getContext('M1', execId, 'src/does-not-exist-w1.ts');
    assert.equal(file.found, true);
    assert.equal(file.kind, 'file');
    assert.equal(file.body, undefined);
    assert.match(file.note ?? '', /file/);

    const spec = await platform.getContext('M1', execId, 'missing-spec');
    assert.equal(spec.found, false);
    assert.equal(spec.body, undefined);
    assert.match(spec.note ?? '', /没有 missing-spec/);

    const contract = await platform.getContext('M1', execId, 'contract');
    assert.equal(contract.found, true);
    assert.equal(contract.kind, 'contract');
    assert.match(contract.body ?? '', /修 X/);

    const prev = await platform.getContext('M1', execId, 'W-prev');
    assert.equal(prev.found, false);
    assert.equal(prev.body, undefined);
    assert.match(prev.note ?? '', /还没有执行结果/);

    const undeclared = await platform.getContext('M1', execId, 'src/not-in-order.ts');
    assert.equal(undeclared.found, false);
    assert.equal(undeclared.body, undefined);
    assert.match(undeclared.note ?? '', /没有声明/);
  });
});

describe('执行者工单持久问答', () => {
  test('已答问答进入 work_order 内容；未答不泄漏；不改冻结 order 与来源顺序', () => {
    const answered: BoundWorkItem = {
      ...WORK_ITEM,
      question: '真正的路径是哪个？',
      answer: 'src/foo.ts',
      answeredAt: '2026-01-01T00:00:00.000Z',
    };
    const bundle = buildContextBundle(executorInput({ workItem: answered }));
    assert.deepEqual(
      bundle.entries.map((entry) => entry.source),
      [...EXECUTOR_SOURCE_ORDER],
    );
    const content = bundle.entries.find((entry) => entry.source === 'work_order')?.content as BoundWorkItem;
    assert.equal(content.question, '真正的路径是哪个？');
    assert.equal(content.answer, 'src/foo.ts');
    assert.equal(content.answeredAt, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(content.order, ORDER);
    assert.equal('question' in (content.order as object), false);

    const unanswered = buildContextBundle(executorInput());
    const raw = unanswered.entries.find((entry) => entry.source === 'work_order')?.content as BoundWorkItem;
    assert.equal('question' in raw, false);
    assert.equal('answer' in raw, false);
    assert.equal('answeredAt' in raw, false);
    assert.deepEqual(raw.order, ORDER);
    assert.deepEqual(
      unanswered.entries.map((entry) => entry.source),
      [...EXECUTOR_SOURCE_ORDER],
    );
  });

  test('新执行者 getWorkOrder 与 getStartupBrief 都带已答原文，未答不泄漏，冻结 order 不变', async () => {
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const projects = new InMemoryProjectRepository();
    const platform = new Platform({
      projects,
      deliveries: new InMemoryDeliveryRepository(clock, ids),
      workspace: new InPlaceWorkspaceManager(),
      activity: new InMemoryActivityLog(clock),
      clock,
      ids,
    });
    const project = await projects.ensure('P');
    project.createMission({
      id: 'M-lw',
      contract: CONTRACT,
      executionMode: 'lightweight',
      runKind: 'mutation',
      origin: { clientType: 'cli', conversationRef: 'me' },
    });
    await projects.save(project);
    const { workItemId } = await platform.createLightweightWorkItem('M-lw', {
      title: 'W',
      order: ORDER,
    });
    await platform.dispatchLightweightWorkItem('M-lw', workItemId);
    const first = await platform.startExecutorAttempt('M-lw', workItemId);
    const question = '真正的路径是哪个？';
    const answer = '就改 src/foo.ts，不要动别的。';
    await platform.reportBlocked('M-lw', first.attemptId, {
      reason: '工单里的路径对不上',
      whatWasTried: ['ls src/', '选 A 改 bar', '选 B 改 foo'],
      needsFromUpstream: question,
    });

    const blockedOrder = await platform.getWorkOrder('M-lw', workItemId);
    assert.equal('question' in blockedOrder, false);
    assert.equal('answer' in blockedOrder, false);
    assert.equal('answeredAt' in blockedOrder, false);
    assert.deepEqual(blockedOrder.order.contextRefs, W1_REFS);
    assert.equal(blockedOrder.order.objective, ORDER.objective);

    const blockedBrief = await platform.getStartupBrief('M-lw', first.attemptId);
    assert.equal('question' in (blockedBrief.workItem ?? {}), false);
    assert.equal('answer' in (blockedBrief.workItem ?? {}), false);
    assert.deepEqual(
      blockedBrief.contextBundle.entries.map((entry) => entry.source),
      [...EXECUTOR_SOURCE_ORDER],
    );
    const blockedWork = blockedBrief.contextBundle.entries.find((entry) => entry.source === 'work_order');
    const blockedDump = JSON.stringify(blockedWork?.content);
    assert.equal(blockedDump.includes(question), false);
    assert.equal(blockedDump.includes(answer), false);

    await platform.finishAttempt('M-lw', first.attemptId, { endedBy: 'no_structured_result' });
    await platform.answerEscalation('M-lw', answer);
    const second = await platform.startExecutorAttempt('M-lw', workItemId);

    const orderView = await platform.getWorkOrder('M-lw', workItemId);
    assert.equal(orderView.question, question);
    assert.equal(orderView.answer, answer);
    assert.equal(typeof orderView.answeredAt, 'string');
    assert.match(orderView.answeredAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(orderView.order.contextRefs, W1_REFS);
    assert.equal(orderView.order.objective, ORDER.objective);
    assert.equal('question' in (orderView.order as object), false);

    const brief = await platform.getStartupBrief('M-lw', second.attemptId);
    assert.equal(brief.workItem?.question, question);
    assert.equal(brief.workItem?.answer, answer);
    assert.equal(brief.workItem?.answeredAt, orderView.answeredAt);
    assert.deepEqual(brief.workItem?.order?.contextRefs, W1_REFS);
    assert.deepEqual(
      brief.contextBundle.entries.map((entry) => entry.source),
      [...EXECUTOR_SOURCE_ORDER],
    );
    const workEntry = brief.contextBundle.entries.find((entry) => entry.source === 'work_order');
    const content = workEntry?.content as BoundWorkItem;
    assert.equal(content.question, question);
    assert.equal(content.answer, answer);
    assert.equal(content.answeredAt, orderView.answeredAt);
    assert.deepEqual(content.order, brief.workItem?.order);
  });
});

describe('构造器自己不读工作区', () => {
  test('源文件不 import fs / path / platform', () => {
    const source = readFileSync(new URL('../src/application/context-builder.ts', import.meta.url), 'utf8');
    assert.equal(/from ['"]node:fs['"]/.test(source), false);
    assert.equal(/from ['"]node:path['"]/.test(source), false);
    assert.equal(/from ['"]\.\/platform\.ts['"]/.test(source), false);
  });
});
