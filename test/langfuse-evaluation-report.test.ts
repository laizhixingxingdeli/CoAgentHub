// scripts/langfuse-evaluation-report.mjs 的两条综合验收：
// 1) 用生产导出函数验证分组与口径：executor 只吃 L2、coordinator 只吃 L3，machine 不算质量、
//    infra 单列不否决能力、unknown 不折算；首次/最终通过率各自取 attemptIndex 的首尾，
//    case 返工次数、费用覆盖率与「已完成 case 单位成功成本」（含该案此前所有尝试）逐项对齐；
// 2) 用 CLI 验证同一份输入的稳定去重、内容冲突与 attemptIndex 冲突**明确拒绝**（退出码 2、
//    不出半份报告），以及缺维度记录进 notComparable 而不是被猜成某个组。
// 全部 synthetic，不连 Langfuse、不读凭据、不跑模型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildEvaluationReport, CONFLICT_ERROR, INPUT_ERROR } from '../scripts/langfuse-evaluation-report.mjs';

const script = 'scripts/langfuse-evaluation-report.mjs';

const base = (caseId: string, attemptIndex: number, overrides: Record<string, unknown> = {}) => ({
  caseId,
  attemptId: `${caseId}.${attemptIndex}`,
  attemptIndex,
  role: 'executor',
  taskType: 'bugfix',
  difficulty: 'easy',
  model: 'synthetic-model-a',
  promptVersion: 'prompt-v1',
  codeRevision: 'rev-1',
  rubricVersion: 'rubric-v1',
  outcome: { status: 'accept', source: 'l2' },
  infrastructureFailure: false,
  costUsd: 1,
  ...overrides,
});

const l3 = (caseId: string, attemptIndex: number, overrides: Record<string, unknown> = {}) =>
  base(caseId, attemptIndex, { role: 'coordinator', taskType: 'split', outcome: { status: 'accept', source: 'l3' }, ...overrides });

const rowOf = (report: any, match: Record<string, unknown>) => {
  const rows = report.groups.filter((row: any) =>
    Object.entries(match).every(([key, value]) => row.group[key] === value),
  );
  assert.equal(rows.length, 1, `expected exactly one group for ${JSON.stringify(match)}`);
  return rows[0];
};

test('groups only comparable attempts, keeps L2/L3 authority per role, and reports honest first/final/cost figures', () => {
  const records = [
    // case-1 executor：第 0 次 L2 reject，第 1 次 L2 accept -> 首次未过、最终过、返工 1 次
    base('case-1', 0, { outcome: { status: 'reject', source: 'l2' }, costUsd: 0.5 }),
    base('case-1', 1, { costUsd: 0.5 }),
    // case-2 executor：首次只有 machine pass（不是质量结论）-> 首次 unknown；最终 L2 accept
    base('case-2', 0, { outcome: { status: 'accept', source: 'machine' }, costUsd: 2 }),
    base('case-2', 1, { costUsd: 1 }),
    // case-3 executor：第 0 次 infra failure（L2 reject 也不算能力）-> 整条排除，第 1 次 unknown
    base('case-3', 0, { outcome: { status: 'reject', source: 'l2' }, infrastructureFailure: true, costUsd: 3 }),
    base('case-3', 1, { outcome: { status: 'unknown', source: 'l2' }, costUsd: null }),
    // 难度不同：不能并进 easy 组
    base('case-4', 0, { difficulty: 'hard', costUsd: 4 }),
    // executor 拿到 L3 结论：来源与角色不符，不进 executor 质量组
    base('case-5', 0, { outcome: { status: 'accept', source: 'l3' } }),
    // coordinator 只认 L3
    l3('case-6', 0, { outcome: { status: 'reject', source: 'l3' }, costUsd: 2 }),
    l3('case-6', 1, { costUsd: 2 }),
    // 缺 role / 缺 costUsd：进 notComparable，不猜
    (() => {
      const { role, ...rest } = base('case-7', 0);
      return rest;
    })(),
    (() => {
      const { costUsd, ...rest } = base('case-8', 0);
      return rest;
    })(),
    // 完全重复：稳定折叠
    base('case-1', 0, { outcome: { status: 'reject', source: 'l2' }, costUsd: 0.5 }),
    // 只导出了第 2 次（缺 0、1）：attemptIndex 从 0 开始，没有 0 就没有真实首次
    base('case-9', 2, { difficulty: 'medium', costUsd: 1 }),
    // 0 与 2 有、1 缺：首次有权威结论，但索引不连续，全案成本不能声称完整
    base('case-10', 0, { difficulty: 'medium', costUsd: 1 }),
    base('case-10', 2, { difficulty: 'medium', costUsd: 1 }),
    // 0..1 连续、费用都已知：原样算（首次/最终/全案成本）
    base('case-11', 0, { difficulty: 'medium', costUsd: 1 }),
    base('case-11', 1, { difficulty: 'medium', costUsd: 1 }),
    // 同一 case 的后续尝试换了模型：A 组第 0 次 accept 只是旧结论，整案最后一次在 B 组被 reject
    base('case-12', 0, { difficulty: 'cross-model', model: 'synthetic-model-a', costUsd: 1 }),
    base('case-12', 1, { difficulty: 'cross-model', model: 'synthetic-model-b', outcome: { status: 'reject', source: 'l2' }, costUsd: 1 }),
    // 完整 0 accept + 更晚的第 1 次只剩一条残缺记录（缺 costUsd）：最新一次不可评估
    base('case-13', 0, { difficulty: 'partial-final', costUsd: 1 }),
    (() => {
      const { costUsd, ...rest } = base('case-13', 1, { difficulty: 'partial-final' });
      return rest;
    })(),
    // 只导出了第 2 次且 accept：可以是「输入里的最新权威结论」，但不是首次、全案成本仍未知
    base('case-14', 2, { difficulty: 'latest-only', costUsd: 1 }),
  ];

  const report = buildEvaluationReport(records);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.summary.recordsRead, records.length);
  assert.equal(report.summary.duplicatesCollapsed, 1);
  assert.equal(report.summary.partialRecords, 3);
  assert.equal(report.summary.notComparableRecords, 3);
  assert.equal(report.summary.machineRecords, 1);
  assert.equal(report.summary.sourceRoleMismatchRecords, 1);
  assert.equal(report.summary.infrastructureFailureRecords, 1);
  assert.equal(report.summary.infrastructureFailureKnownCostUsd, 3);
  assert.equal(report.summary.groups, 8, 'easy/hard/medium/cross-model×2/partial-final/latest-only + coordinator L3');

  const easy = rowOf(report, { role: 'executor', difficulty: 'easy', source: 'l2', model: 'synthetic-model-a' });
  assert.equal(easy.attempts, 4, 'case-1(2) + case-2(1) + case-3(1)');
  assert.equal(easy.cases, 3);
  assert.equal(easy.decidedCases, 2, 'case-3 只剩 unknown');
  assert.deepEqual(easy.outcomes, { accept: 2, reject: 1, unknown: 1 });
  // 首次：case-1 reject、case-2 unknown、case-3 unknown -> 1/1
  assert.deepEqual(easy.firstAttempt, { evaluatedCases: 1, acceptedCases: 0, unknownCases: 2, passRate: 0 });
  // 最终：case-1 accept、case-2 accept、case-3 unknown -> 2/2
  assert.deepEqual(easy.finalAttempt, { evaluatedCases: 2, acceptedCases: 2, unknownCases: 1, passRate: 1 });
  assert.deepEqual(easy.rework, { rejectCount: 1, cases: 3, perCase: 0.333333 });
  assert.deepEqual(easy.cost, { knownAttempts: 3, unknownAttempts: 1, coverage: 0.75, knownCostUsd: 2 });
  // 已完成 case（最终 accept）= case-1(0.5+0.5)、case-2(2+1)；case-3 未完成不计
  assert.deepEqual(easy.completedCaseCost, {
    caseCostScope: 'all-attempts-of-case',
    completedCases: 2,
    costKnownCases: 2,
    costUnknownCases: 0,
    coverage: 1,
    totalCostUsd: 4,
    perCompletedCaseUsd: 2,
  });

  const hard = rowOf(report, { role: 'executor', difficulty: 'hard' });
  assert.equal(hard.attempts, 1);
  assert.equal(hard.finalAttempt.passRate, 1);

  // 闭合口径：没有 index 0 就是没有首次；索引不连续就不能声称「全案成本」
  const medium = rowOf(report, { role: 'executor', difficulty: 'medium', source: 'l2' });
  assert.equal(medium.attempts, 5, 'case-9(1) + case-10(2) + case-11(2)');
  assert.equal(medium.cases, 3);
  assert.equal(medium.decidedCases, 3);
  assert.deepEqual(medium.outcomes, { accept: 5, reject: 0, unknown: 0 });
  // case-9 只有 index 2 -> 首次 unknown（不能把第 2 次当首次）；case-10/11 的 index 0 有权威结论
  assert.deepEqual(medium.firstAttempt, { evaluatedCases: 2, acceptedCases: 2, unknownCases: 1, passRate: 1 });
  assert.deepEqual(medium.finalAttempt, { evaluatedCases: 3, acceptedCases: 3, unknownCases: 0, passRate: 1 });
  assert.deepEqual(medium.rework, { rejectCount: 0, cases: 3, perCase: 0 });
  assert.deepEqual(medium.cost, { knownAttempts: 5, unknownAttempts: 0, coverage: 1, knownCostUsd: 5 });
  // 三个 case 最终都 accept，但只有 case-11 的 0..1 连续且费用齐全 -> 只有它算得岀全案成本
  assert.deepEqual(medium.completedCaseCost, {
    caseCostScope: 'all-attempts-of-case',
    completedCases: 3,
    costKnownCases: 1,
    costUnknownCases: 2,
    coverage: 0.333333,
    totalCostUsd: 2,
    perCompletedCaseUsd: 2,
  });

  const coord = rowOf(report, { role: 'coordinator', source: 'l3' });
  assert.equal(coord.attempts, 2);
  assert.deepEqual(coord.outcomes, { accept: 1, reject: 1, unknown: 0 });
  assert.deepEqual(coord.firstAttempt, { evaluatedCases: 1, acceptedCases: 0, unknownCases: 0, passRate: 0 });
  assert.deepEqual(coord.finalAttempt, { evaluatedCases: 1, acceptedCases: 1, unknownCases: 0, passRate: 1 });
  assert.deepEqual(coord.rework, { rejectCount: 1, cases: 1, perCase: 1 });
  assert.deepEqual(coord.cost, { knownAttempts: 2, unknownAttempts: 0, coverage: 1, knownCostUsd: 4 });
  assert.equal(coord.completedCaseCost.perCompletedCaseUsd, 4);

  // 跨模型：A 组第 0 次 accept 不是「最终通过」——同一 case 更晚一次在 B 组被 reject，
  // 所以 A 组的最终不可评估（unknown），完成数 0，成功成本字段全 null，不拿旧 accept 顶上
  const crossA = rowOf(report, { role: 'executor', difficulty: 'cross-model', source: 'l2', model: 'synthetic-model-a' });
  assert.equal(crossA.attempts, 1);
  assert.equal(crossA.cases, 1);
  assert.deepEqual(crossA.finalAttempt, { evaluatedCases: 0, acceptedCases: 0, unknownCases: 1, passRate: null });
  assert.deepEqual(crossA.completedCaseCost, {
    caseCostScope: 'all-attempts-of-case',
    completedCases: 0,
    costKnownCases: 0,
    costUnknownCases: 0,
    coverage: null,
    totalCostUsd: null,
    perCompletedCaseUsd: null,
  });

  const crossB = rowOf(report, { role: 'executor', difficulty: 'cross-model', source: 'l2', model: 'synthetic-model-b' });
  assert.deepEqual(crossB.finalAttempt, { evaluatedCases: 1, acceptedCases: 0, unknownCases: 0, passRate: 0 });
  assert.equal(crossB.completedCaseCost.completedCases, 0);
  assert.equal(crossB.completedCaseCost.perCompletedCaseUsd, null);

  // 完整 0 accept + 更晚的残缺第 1 次：残缺记录的 index 证明还有更晚一次，但它本身不可评估，
  // 所以最终是 unknown、不声称已完成（完成数 0）、成本字段 null；首次仍可保留
  const partialFinal = rowOf(report, { role: 'executor', difficulty: 'partial-final', source: 'l2' });
  assert.equal(partialFinal.attempts, 1);
  assert.deepEqual(partialFinal.firstAttempt, { evaluatedCases: 1, acceptedCases: 1, unknownCases: 0, passRate: 1 });
  assert.deepEqual(partialFinal.finalAttempt, { evaluatedCases: 0, acceptedCases: 0, unknownCases: 1, passRate: null });
  assert.deepEqual(partialFinal.completedCaseCost, {
    caseCostScope: 'all-attempts-of-case',
    completedCases: 0,
    costKnownCases: 0,
    costUnknownCases: 0,
    coverage: null,
    totalCostUsd: null,
    perCompletedCaseUsd: null,
  });
  // 组内已知费用照实报，只是不能当「已完成 case 的成功成本」
  assert.equal(partialFinal.cost.knownCostUsd, 1);

  // 只有 index 2 且 accept：可以表示「输入里的最新权威结论」，但首次 unknown、全案成本 unknown
  const latestOnly = rowOf(report, { role: 'executor', difficulty: 'latest-only', source: 'l2' });
  assert.deepEqual(latestOnly.firstAttempt, { evaluatedCases: 0, acceptedCases: 0, unknownCases: 1, passRate: null });
  assert.deepEqual(latestOnly.finalAttempt, { evaluatedCases: 1, acceptedCases: 1, unknownCases: 0, passRate: 1 });
  assert.deepEqual(latestOnly.completedCaseCost, {
    caseCostScope: 'all-attempts-of-case',
    completedCases: 1,
    costKnownCases: 0,
    costUnknownCases: 1,
    coverage: 0,
    totalCostUsd: null,
    perCompletedCaseUsd: null,
  });

  // 排除项单列，不进任何组的分子分母
  assert.equal(report.excluded.machine.count, 1);
  assert.equal(report.excluded.machine.records[0].caseId, 'case-2');
  assert.equal(report.excluded.sourceRoleMismatch.records[0].caseId, 'case-5');
  assert.deepEqual(report.excluded.infrastructureFailures.records.map((record: any) => record.caseId), ['case-3']);
  assert.equal(report.excluded.infrastructureFailures.records[0].status, 'reject');

  assert.deepEqual(report.notComparable.map((bucket: any) => [bucket.missing, bucket.invalid, bucket.count]), [
    [['costUsd'], [], 2],
    [['role'], [], 1],
  ]);
  assert.deepEqual(report.notComparable[0].examples, [
    { caseId: 'case-8', attemptId: 'case-8.0', attemptIndex: 0 },
    { caseId: 'case-13', attemptId: 'case-13.1', attemptIndex: 1 },
  ]);

  // 输出里没有原始记录正文以外的东西：键序固定，同一输入两次结果一致（可复跑）
  assert.equal(JSON.stringify(buildEvaluationReport(records)), JSON.stringify(report));
});

test('rejects conflicting data instead of overwriting, and never invents missing dimensions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'evaluation-report-'));
  try {
    const write = async (name: string, value: unknown) => {
      const file = join(dir, name);
      await writeFile(file, JSON.stringify(value));
      return file;
    };

    // 同一 caseId+attemptId 内容不同 -> 冲突，整份拒绝
    const conflictingContent = await write('conflict-content.json', [
      base('case-1', 0, { costUsd: 0.5 }),
      base('case-1', 0, { costUsd: 0.6 }),
    ]);
    // 同一 caseId+attemptIndex 两个不同 attemptId -> 冲突
    const conflictingIndex = await write('conflict-index.json', [
      base('case-1', 0),
      base('case-1', 0, { attemptId: 'case-1.retry' }),
    ]);
    // 内容一致但键序/额外元数据不同：只折叠，不报冲突
    const stableDuplicate = await write('duplicate.json', [
      { ...base('case-1', 0), note: 'synthetic extra field' },
      base('case-1', 0),
    ]);
    // 缺 attemptIndex 与非法 status：进 notComparable
    const incomplete = await write('incomplete.json', [
      (() => {
        const { attemptIndex, ...rest } = base('case-1', 0);
        return rest;
      })(),
      base('case-2', 0, { outcome: { status: 'passed', source: 'l2' } }),
      // 同案还有一条残缺记录被剔除：索引看起来完整，但输入没闭合，费用不能声称全案
      base('case-3', 0),
      base('case-3', 1),
      // 同案第 1 次另有一条残缺记录被剔除：它的 index 已知，最新仍是 1，最终结论照算；
      // 但该 case 的输入没闭合，全案成本不能声称完整
      (() => {
        const { role, ...rest } = base('case-3', 1);
        return rest;
      })(),
    ]);

    const outFile = join(dir, 'report.json');
    const run = (file: string) => spawnSync(process.execPath, [script, '--input', file, '--report', outFile], { encoding: 'utf8' });

    const contentConflict = run(conflictingContent);
    assert.equal(contentConflict.status, 2);
    assert.match(contentConflict.stderr, new RegExp(CONFLICT_ERROR));
    assert.match(contentConflict.stderr, /caseId=case-1 attemptId=case-1\.0/);
    assert.equal(contentConflict.stdout, '');
    await assert.rejects(stat(outFile), 'conflict must not leave a partial report');

    const indexConflict = run(conflictingIndex);
    assert.equal(indexConflict.status, 2);
    assert.match(indexConflict.stderr, new RegExp(CONFLICT_ERROR));
    assert.match(indexConflict.stderr, /attemptIndex=0/);

    const dup = run(stableDuplicate);
    assert.equal(dup.status, 0, dup.stderr);
    const dupReport = JSON.parse(dup.stdout);
    assert.equal(dupReport.summary.duplicatesCollapsed, 1);
    assert.equal(dupReport.groups.length, 1);
    assert.equal(dupReport.groups[0].attempts, 1);
    assert.equal(dupReport.groups[0].finalAttempt.passRate, 1);

    const partial = run(incomplete);
    assert.equal(partial.status, 0, partial.stderr);
    const partialReport = JSON.parse(partial.stdout);
    assert.equal(partialReport.groups.length, 1, 'only case-3 has a complete record; no group from guessed dimensions');
    assert.equal(partialReport.summary.notComparableRecords, 3);
    assert.deepEqual(partialReport.notComparable.map((bucket: any) => [bucket.missing, bucket.invalid, bucket.count]), [
      [['attemptIndex'], [], 1],
      [['role'], [], 1],
      [[], ['outcome.status'], 1],
    ]);
    // case-3 的 index 0 确实被权威评审：首次照算；但同案有一条残缺记录被剔除，
    // 全案成本与费用覆盖率都是未知，不能把「看到的那一条」当完整
    assert.deepEqual(partialReport.groups[0].firstAttempt, { evaluatedCases: 1, acceptedCases: 1, unknownCases: 0, passRate: 1 });
    assert.deepEqual(partialReport.groups[0].finalAttempt, { evaluatedCases: 1, acceptedCases: 1, unknownCases: 0, passRate: 1 });
    assert.deepEqual(partialReport.groups[0].completedCaseCost, {
      caseCostScope: 'all-attempts-of-case',
      completedCases: 1,
      costKnownCases: 0,
      costUnknownCases: 1,
      coverage: 0,
      totalCostUsd: null,
      perCompletedCaseUsd: null,
    });
    assert.equal(partialReport.summary.comparableAttempts, 2);
    assert.equal(JSON.parse(await readFile(outFile, 'utf8')).summary.notComparableRecords, 3);

    // 空数组：合法，但没有任何组，也没有「100% 成功」
    const empty = await write('empty.json', []);
    const emptyRun = run(empty);
    assert.equal(emptyRun.status, 0, emptyRun.stderr);
    assert.deepEqual(JSON.parse(emptyRun.stdout).groups, []);

    // 输入不是数组 / 参数不对：固定错误码，不回显路径
    const notArray = await write('not-array.json', { records: [] });
    const notArrayRun = run(notArray);
    assert.equal(notArrayRun.status, 2);
    assert.equal(notArrayRun.stderr.trim(), INPUT_ERROR);
    assert.equal(notArrayRun.stderr.includes(dir), false);

    const badArgs = spawnSync(process.execPath, [script, '--input'], { encoding: 'utf8' });
    assert.equal(badArgs.status, 2);
    assert.match(badArgs.stderr, new RegExp(INPUT_ERROR));

    const missingFile = spawnSync(process.execPath, [script, '--input', join(dir, 'absent.json')], { encoding: 'utf8' });
    assert.equal(missingFile.status, 2);
    assert.equal(missingFile.stderr.trim(), INPUT_ERROR);
    assert.equal(missingFile.stderr.includes(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
