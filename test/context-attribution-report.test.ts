/**
 * B4 离线归因：固定合成快照 × 手写 expected。
 * 不把 CLI 输出回写成 expected；投影缺信号时不得填 0。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildContextAttributionReport } from '../src/application/context-attribution-report.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const script = join(repoRoot, 'src/context-attribution-report.ts');
const fixtures = join(repoRoot, 'test/fixtures/context-attribution');
const mainStatePath = join(fixtures, 'main-state.json');
const archivePath = join(fixtures, 'archive-M-arch.json');
const expectedHappyPath = join(fixtures, 'expected-happy.json');

const SENTINELS = [
  'sk-ant-fake-not-a-real-key',
  'FAKE-PROMPT-SYNTH-BODY',
  'FAKE-TOOL-STDOUT-BODY',
  'SENSITIVE-RESUME-REF',
  'SENSITIVE-PROFILE-ID',
  '/var/secret/synth/auth.json',
  'resumeRef',
  'profile',
  '../../secret',
  'credentialPath',
  'omittedSources',
  'msg-trunc-1',
  'msg-arch-trunc-1',
];

const PATH_DIGEST = 'ab'.repeat(32);
const CONTENT_DIGEST = 'cd'.repeat(32);
const METRICS_LEAKS = [
  PATH_DIGEST,
  CONTENT_DIGEST,
  'pathDigest',
  'contentDigest',
  'Authorization',
  'x-api-key',
  'Bearer fake',
];

const CONTEXT_METRICS_ABSENT = 'context_metrics_absent';
const CONTEXT_METRICS_UNTRUSTED = 'context_metrics_untrusted';

const VALID_COMPLETE_METRICS = {
  version: 1 as const,
  coverage: 'complete' as const,
  brief: {
    renderedUtf8Bytes: 1200,
    sources: [
      { source: 'project_rules', estimatedTokens: 40, truncated: false },
      { source: 'work_order', truncated: true },
    ],
  },
  tools: [
    { kind: 'read', calls: 2, returnedUtf8Bytes: 80 },
    { kind: 'grep', calls: 1, returnedUtf8Bytes: 12 },
    { kind: 'find', calls: 1, returnedUtf8Bytes: 0 },
    { kind: 'ls', calls: 3, returnedUtf8Bytes: 40 },
    { kind: 'bash', calls: 1, returnedUtf8Bytes: 9 },
  ],
  reads: [{ pathDigest: PATH_DIGEST, contentDigest: CONTENT_DIGEST, repeats: 2 }],
};

type ReportShape = {
  version: unknown;
  liveCoverage: unknown;
  archiveCoverage: unknown;
  reasons: unknown;
  rows: Array<Record<string, unknown> & {
    missionId: string;
    attemptId: string;
    contextMetricsCoverage?: string;
    contextMetrics?: unknown;
    reasons: string[];
  }>;
};

function stripNewMetricsFields(report: ReportShape) {
  return {
    version: report.version,
    rows: report.rows.map((row) => {
      const rest = { ...row };
      delete rest.contextMetrics;
      delete rest.contextMetricsCoverage;
      return {
        ...rest,
        reasons: row.reasons.filter(
          (reason) => reason !== CONTEXT_METRICS_ABSENT && reason !== CONTEXT_METRICS_UNTRUSTED,
        ),
      };
    }),
    liveCoverage: report.liveCoverage,
    archiveCoverage: report.archiveCoverage,
    reasons: report.reasons,
  };
}

function assertLegacyUnknownMetrics(report: ReportShape) {
  for (const row of report.rows) {
    assert.equal(row.contextMetricsCoverage, 'unknown');
    assert.equal('contextMetrics' in row, false);
    assert.equal(row.reasons.includes(CONTEXT_METRICS_ABSENT), true);
  }
}

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    cwd: repoRoot,
  });
}

function assertSafeOutput(text: string, extra: readonly string[] = []) {
  for (const sentinel of [...SENTINELS, ...extra]) {
    assert.equal(text.includes(sentinel), false, `leaked ${sentinel}`);
  }
}

function assertFixedError(run: ReturnType<typeof runCli>, extra: readonly string[] = []) {
  assert.equal(run.status, 2, run.stderr);
  assert.equal(run.stderr.trim(), 'CONTEXT_ATTRIBUTION_INPUT_ERROR');
  assertSafeOutput(run.stdout, extra);
  assertSafeOutput(run.stderr, extra);
}

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function liveRowsOf(report: { rows: readonly { missionId: string }[] }) {
  return report.rows.filter((row) => row.missionId === 'M-live');
}

describe('context-attribution-report CLI', () => {
  test('固定快照逐字段对照手写 expected，输入字节不变且输出白名单', async () => {
    const expected = await loadJson(expectedHappyPath);
    const archiveBuf = await readFile(archivePath);
    const state = (await loadJson(mainStatePath)) as {
      archivedMissions: { bytes: number; sha256: string }[];
    };
    assert.equal(state.archivedMissions[0]!.bytes, archiveBuf.byteLength);
    assert.equal(
      state.archivedMissions[0]!.sha256,
      createHash('sha256').update(archiveBuf).digest('hex'),
    );

    const beforeMain = await readFile(mainStatePath);
    const beforeArchive = await readFile(archivePath);
    const run = runCli(['--input', mainStatePath, '--archive', archivePath]);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout) as ReportShape;
    assertLegacyUnknownMetrics(report);
    assert.deepStrictEqual(stripNewMetricsFields(report), expected);
    assert.deepStrictEqual(await readFile(mainStatePath), beforeMain);
    assert.deepStrictEqual(await readFile(archivePath), beforeArchive);
    const leakExtra = [fixtures, mainStatePath, archivePath, repoRoot];
    assertSafeOutput(run.stdout, leakExtra);
    assertSafeOutput(run.stderr, leakExtra);
  });

  test('缺归档时 archiveCoverage 为 unknown，不投影归档 Attempt', async () => {
    const expectedHappy = (await loadJson(expectedHappyPath)) as {
      version: 1;
      rows: unknown[];
      liveCoverage: string;
    };
    const beforeMain = await readFile(mainStatePath);
    const run = runCli(['--input', mainStatePath]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepStrictEqual(await readFile(mainStatePath), beforeMain);
    const report = JSON.parse(run.stdout) as ReportShape;
    assertLegacyUnknownMetrics(report);
    assert.deepStrictEqual(stripNewMetricsFields(report), {
      version: 1,
      rows: expectedHappy.rows.filter((row) => (row as { missionId: string }).missionId === 'M-live'),
      liveCoverage: 'complete',
      archiveCoverage: 'unknown',
      reasons: ['archive_package_missing'],
    });
    assertSafeOutput(run.stdout, [mainStatePath, fixtures]);
    assertSafeOutput(run.stderr, [mainStatePath, fixtures]);
  });

  test('索引与 package 字节不符时 archiveCoverage 非 complete', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ctx-attr-mismatch-'));
    try {
      const expectedHappy = (await loadJson(expectedHappyPath)) as Record<string, unknown>;
      const tampered = join(dir, 'archive.json');
      const original = await readFile(archivePath);
      await writeFile(tampered, Buffer.concat([original, Buffer.from('\n')]));
      const beforeMain = await readFile(mainStatePath);
      const beforeTampered = await readFile(tampered);
      const run = runCli(['--input', mainStatePath, '--archive', tampered]);
      assert.equal(run.status, 0, run.stderr);
      assert.deepStrictEqual(await readFile(mainStatePath), beforeMain);
      assert.deepStrictEqual(await readFile(tampered), beforeTampered);
      const report = JSON.parse(run.stdout) as ReportShape;
      assertLegacyUnknownMetrics(report);
      assert.deepStrictEqual(stripNewMetricsFields(report), {
        ...expectedHappy,
        archiveCoverage: 'partial',
        reasons: ['archive_integrity_unverified'],
      });
      assertSafeOutput(run.stdout, [dir, tampered, mainStatePath]);
      assertSafeOutput(run.stderr, [dir, tampered, mainStatePath]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('缺 live events 时不把未见裁剪/工具读次数填成 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ctx-attr-noevents-'));
    try {
      const state = (await loadJson(mainStatePath)) as Record<string, unknown>;
      delete state.events;
      const input = join(dir, 'state.json');
      await writeFile(input, `${JSON.stringify(state)}\n`);
      const before = await readFile(input);
      const beforeArchive = await readFile(archivePath);
      const run = runCli(['--input', input, '--archive', archivePath]);
      assert.equal(run.status, 0, run.stderr);
      assert.deepStrictEqual(await readFile(input), before);
      assert.deepStrictEqual(await readFile(archivePath), beforeArchive);
      const report = JSON.parse(run.stdout) as {
        liveCoverage: string;
        archiveCoverage: string;
        reasons: string[];
        rows: Array<{
          missionId: string;
          attemptId: string;
          usageCoverage: string;
          toolCoverage: string;
          truncationCoverage: string;
          truncation?: unknown;
          usage?: unknown;
          toolCounts: unknown[];
          reasons: string[];
        }>;
      };
      assert.equal(report.liveCoverage, 'partial');
      assert.equal(report.archiveCoverage, 'complete');
      assert.deepStrictEqual(report.reasons, ['live_data_incomplete']);
      const live = liveRowsOf(report);
      assert.equal(live.length, 4);
      for (const row of live) {
        assert.equal(row.truncationCoverage, 'unknown');
        assert.equal('truncation' in row, false);
        assert.equal(row.reasons.includes('truncation_audit_absent'), true);
        assert.equal(row.reasons.includes('live_data_incomplete'), true);
      }
      const noUsage = live.find((row) => row.attemptId === 'A-exec-nousage')!;
      assert.equal(noUsage.usageCoverage, 'unknown');
      assert.equal('usage' in noUsage, false);
      assert.equal(noUsage.toolCoverage, 'partial');
      assert.deepStrictEqual(noUsage.toolCounts, [{ name: 'read', count: 200 }]);
      const estimated = live.find((row) => row.attemptId === 'A-coord-estimated')!;
      assert.equal(estimated.toolCoverage, 'unknown');
      assert.deepStrictEqual(estimated.toolCounts, []);
      const archCoord = report.rows.find((row) => row.attemptId === 'A-arch-coord')!;
      assert.equal(archCoord.truncationCoverage, 'complete');
      assertSafeOutput(run.stdout, [dir, input, archivePath]);
      assertSafeOutput(run.stderr, [dir, input, archivePath]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('events 为空数组时覆盖仍 complete，但不假定零读取', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ctx-attr-empty-events-'));
    try {
      const state = (await loadJson(mainStatePath)) as Record<string, unknown>;
      state.events = [];
      const input = join(dir, 'state.json');
      await writeFile(input, `${JSON.stringify(state)}\n`);
      const before = await readFile(input);
      const run = runCli(['--input', input, '--archive', archivePath]);
      assert.equal(run.status, 0, run.stderr);
      assert.deepStrictEqual(await readFile(input), before);
      const report = JSON.parse(run.stdout) as {
        liveCoverage: string;
        reasons: string[];
        rows: Array<{
          missionId: string;
          attemptId: string;
          truncationCoverage: string;
          toolCoverage: string;
          usageCoverage: string;
          truncation?: unknown;
          usage?: unknown;
          toolCounts: unknown[];
          reasons: string[];
        }>;
      };
      assert.equal(report.liveCoverage, 'complete');
      assert.equal(report.reasons.includes('live_data_incomplete'), false);
      const estimated = liveRowsOf(report).find((row) => row.attemptId === 'A-coord-estimated')!;
      assert.equal(estimated.toolCoverage, 'unknown');
      assert.equal(estimated.truncationCoverage, 'unknown');
      assert.equal('truncation' in estimated, false);
      assert.deepStrictEqual(estimated.toolCounts, []);
      const noUsage = liveRowsOf(report).find((row) => row.attemptId === 'A-exec-nousage')!;
      assert.equal(noUsage.usageCoverage, 'unknown');
      assert.equal('usage' in noUsage, false);
      assert.equal(noUsage.toolCoverage, 'partial');
      assert.deepStrictEqual(noUsage.toolCounts, [{ name: 'read', count: 200 }]);
      assertSafeOutput(run.stdout, [dir, input]);
      assertSafeOutput(run.stderr, [dir, input]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('出错只打固定码且非零，stderr 不含路径或夹具原文', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ctx-attr-err-'));
    try {
      const extra = [dir, fixtures, mainStatePath, repoRoot];
      assertFixedError(runCli([]), extra);
      assertFixedError(runCli(['--archive', archivePath]), extra);
      const missing = join(dir, 'sk-ant-fake-not-a-real-key.json');
      assertFixedError(runCli(['--input', missing]), [...extra, missing]);
      const bad = join(dir, 'bad.json');
      await writeFile(
        bad,
        JSON.stringify({
          secret: 'sk-ant-fake-not-a-real-key',
          resumeRef: 'SENSITIVE-RESUME-REF',
          profile: 'SENSITIVE-PROFILE-ID',
          prompt: 'FAKE-PROMPT-SYNTH-BODY',
        }),
      );
      const beforeBad = await readFile(bad);
      assertFixedError(runCli(['--input', bad]), [...extra, bad]);
      assert.deepStrictEqual(await readFile(bad), beforeBad);
      const badArchive = join(dir, 'bad-archive.json');
      await writeFile(
        badArchive,
        JSON.stringify({
          version: 2,
          projectId: 'P-synth',
          missionId: 'M-arch',
          mission: { id: 'M-arch' },
          events: [],
          output: 'FAKE-TOOL-STDOUT-BODY',
        }),
      );
      const beforeMain = await readFile(mainStatePath);
      assertFixedError(runCli(['--input', mainStatePath, '--archive', badArchive]), [
        ...extra,
        badArchive,
      ]);
      assert.deepStrictEqual(await readFile(mainStatePath), beforeMain);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function synthState(events: unknown[], extraAttempt?: Record<string, unknown>): {
  version: 1;
  projects: unknown[];
  events: unknown[];
} {
  return {
    version: 1,
    projects: [
      {
        id: 'P-synth',
        missions: [
          {
            id: 'M-live',
            coordinatorAttempts: [
              {
                id: 'A-coord',
                kind: 'coordinator',
                status: 'succeeded',
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 2,
                  quality: 'reported',
                },
                ...extraAttempt,
              },
            ],
            workItems: [],
          },
        ],
      },
    ],
    events,
  };
}

function endedEvent(data: unknown, attemptId = 'A-coord', extra: Record<string, unknown> = {}) {
  return {
    at: '2026-01-01T00:00:00.000Z',
    projectId: 'P-synth',
    missionId: 'M-live',
    attemptId,
    kind: 'attempt.ended',
    data,
    ...extra,
  };
}

describe('context-attribution-report projection', () => {
  test('纯投影无原始字节时 archiveCoverage 不应 complete', async () => {
    const expectedHappy = (await loadJson(expectedHappyPath)) as {
      version: 1;
      rows: unknown[];
      liveCoverage: string;
    };
    const state = await loadJson(mainStatePath);
    const pkg = await loadJson(archivePath);
    const report = buildContextAttributionReport(state, [pkg]) as unknown as ReportShape;
    assertLegacyUnknownMetrics(report);
    assert.deepStrictEqual(stripNewMetricsFields(report), {
      version: 1,
      rows: expectedHappy.rows,
      liveCoverage: 'complete',
      archiveCoverage: 'partial',
      reasons: ['archive_integrity_unverified'],
    });
  });

  test('合成 v1 attempt.ended 只投影白名单摘要与 read 重复聚合', () => {
    const report = buildContextAttributionReport(
      synthState([endedEvent({ contextMetrics: VALID_COMPLETE_METRICS })]),
    );
    assert.equal(report.version, 1);
    assert.equal(report.rows.length, 1);
    const row = report.rows[0]!;
    assert.equal(row.contextMetricsCoverage, 'complete');
    assert.deepStrictEqual(row.contextMetrics, {
      brief: {
        renderedUtf8Bytes: 1200,
        sources: [
          { source: 'project_rules', estimatedTokens: 40, truncated: false },
          { source: 'work_order', truncated: true },
        ],
      },
      tools: [
        { kind: 'bash', calls: 1, returnedUtf8Bytes: 9 },
        { kind: 'find', calls: 1, returnedUtf8Bytes: 0 },
        { kind: 'grep', calls: 1, returnedUtf8Bytes: 12 },
        { kind: 'ls', calls: 3, returnedUtf8Bytes: 40 },
        { kind: 'read', calls: 2, returnedUtf8Bytes: 80 },
      ],
      reads: { totalRepeats: 2, bucketCount: 1 },
    });
    assert.equal(row.reasons.includes(CONTEXT_METRICS_ABSENT), false);
    const dumped = JSON.stringify(report);
    assertSafeOutput(dumped, METRICS_LEAKS);
  });

  test('未见 v1 事件时 coverage 为 unknown，不捏造零摘要', () => {
    const report = buildContextAttributionReport(synthState([]));
    const row = report.rows[0]!;
    assert.equal(row.contextMetricsCoverage, 'unknown');
    assert.equal('contextMetrics' in row, false);
    assert.equal(row.reasons.includes(CONTEXT_METRICS_ABSENT), true);
  });

  test('自称 complete 但缺 reads 不可冒充 complete', () => {
    const { reads: _reads, ...partial } = VALID_COMPLETE_METRICS;
    const report = buildContextAttributionReport(
      synthState([endedEvent({ contextMetrics: { ...partial, coverage: 'complete' } })]),
    );
    const row = report.rows[0]!;
    assert.equal(row.contextMetricsCoverage, 'unknown');
    assert.equal('contextMetrics' in row, false);
    assert.equal(row.reasons.includes(CONTEXT_METRICS_UNTRUSTED), true);
  });

  test('多余字段与敏感哨兵不得进入报告', () => {
    const report = buildContextAttributionReport(
      synthState([
        endedEvent({
          output: 'FAKE-TOOL-STDOUT-BODY',
          Authorization: 'Bearer fake',
          contextMetrics: {
            ...VALID_COMPLETE_METRICS,
            path: '/var/secret/synth/auth.json',
            secret: 'sk-ant-fake-not-a-real-key',
          },
        }),
      ]),
    );
    const row = report.rows[0]!;
    assert.equal(row.contextMetricsCoverage, 'unknown');
    assert.equal('contextMetrics' in row, false);
    const dumped = JSON.stringify(report);
    assertSafeOutput(dumped, METRICS_LEAKS);
    assertSafeOutput(dumped, SENTINELS);
  });

  test('同 Attempt 多条事件不累计 read 重复', () => {
    const second = {
      ...VALID_COMPLETE_METRICS,
      reads: [
        { pathDigest: PATH_DIGEST, contentDigest: CONTENT_DIGEST, repeats: 9 },
        {
          pathDigest: 'ef'.repeat(32),
          contentDigest: '11'.repeat(32),
          repeats: 4,
        },
      ],
    };
    const report = buildContextAttributionReport(
      synthState([
        endedEvent({ contextMetrics: VALID_COMPLETE_METRICS }, 'A-coord', { messageId: 'm-1' }),
        endedEvent({ contextMetrics: second }, 'A-coord', { messageId: 'm-2' }),
      ]),
    );
    const row = report.rows[0]!;
    assert.equal(row.contextMetricsCoverage, 'complete');
    assert.deepStrictEqual(row.contextMetrics?.reads, { totalRepeats: 2, bucketCount: 1 });
    const dumped = JSON.stringify(report);
    assertSafeOutput(dumped, ['ef'.repeat(32), '11'.repeat(32), ...METRICS_LEAKS]);
  });

  test('live 事件流不完整时不得把见到的 complete 当全量', () => {
    const state = synthState([endedEvent({ contextMetrics: VALID_COMPLETE_METRICS })]);
    state.projects.push('not-a-project');
    const report = buildContextAttributionReport(state);
    const row = report.rows[0]!;
    assert.equal(report.liveCoverage, 'partial');
    assert.equal(row.contextMetricsCoverage, 'partial');
    assert.equal(row.contextMetrics?.reads?.totalRepeats, 2);
    assert.equal(row.reasons.includes('live_data_incomplete'), true);
    assert.equal(row.reasons.includes(CONTEXT_METRICS_ABSENT), false);
  });

  test('read 桶内多余键或非哈希摘要视为不可信', () => {
    const poisoned = {
      ...VALID_COMPLETE_METRICS,
      reads: [
        {
          pathDigest: PATH_DIGEST,
          contentDigest: CONTENT_DIGEST,
          repeats: 2,
          path: '/var/secret/synth/auth.json',
        },
      ],
    };
    const badDigest = {
      ...VALID_COMPLETE_METRICS,
      reads: [{ pathDigest: '../../secret', contentDigest: CONTENT_DIGEST, repeats: 1 }],
    };
    for (const payload of [poisoned, badDigest]) {
      const report = buildContextAttributionReport(synthState([endedEvent({ contextMetrics: payload })]));
      const row = report.rows[0]!;
      assert.equal(row.contextMetricsCoverage, 'unknown');
      assert.equal('contextMetrics' in row, false);
      assertSafeOutput(JSON.stringify(report), METRICS_LEAKS);
    }
  });
});

describe('context-attribution-report CLI contextMetrics', () => {
  test('CLI 合成 v1 摘要保持只读且不泄露哈希或路径', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ctx-attr-metrics-'));
    try {
      const input = join(dir, 'state.json');
      await writeFile(
        input,
        `${JSON.stringify(synthState([endedEvent({ contextMetrics: VALID_COMPLETE_METRICS })]))}\n`,
      );
      const before = await readFile(input);
      const run = runCli(['--input', input]);
      assert.equal(run.status, 0, run.stderr);
      assert.deepStrictEqual(await readFile(input), before);
      const report = JSON.parse(run.stdout) as ReportShape;
      assert.equal(report.rows[0]!.contextMetricsCoverage, 'complete');
      assert.deepStrictEqual((report.rows[0]!.contextMetrics as { reads: unknown }).reads, {
        totalRepeats: 2,
        bucketCount: 1,
      });
      assertSafeOutput(run.stdout, [...METRICS_LEAKS, dir, input]);
      assertSafeOutput(run.stderr, [...METRICS_LEAKS, dir, input]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
