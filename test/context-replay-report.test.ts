import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = 'scripts/context-replay-report.mjs';
const usage = (quality: string, input: unknown = 1, other: Record<string, unknown> = {}) => ({ quality, input, output: 2, cacheRead: 3, cacheWrite: 1, ...other });
test('aggregates only valid snapshot attempts without disclosing source data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-replay-'));
  try {
    const sentinels = ['FAKE-KEY-SENTINEL', 'FAKE-PROMPT-SENTINEL', 'FAKE-TOOL-BODY-SENTINEL'];
    const [keySentinel, promptSentinel, toolSentinel] = sentinels;
    const state = { version: 1, secret: keySentinel, prompt: promptSentinel, events: [toolSentinel], projects: [{ missions: [{ id: 'E1', coordinatorAttempts: [
      { kind: 'coordinator', id: keySentinel, prompt: promptSentinel, tool: toolSentinel, usage: usage('reported', 10) }, { kind: 'coordinator', usage: undefined },
      { kind: 'executor', usage: usage('reported') },
    ], workItems: [{ attempts: [{ kind: 'executor', usage: usage('reported', 4, { output: 1, cacheRead: 0, cacheWrite: 0 }) }, { kind: 'coordinator', usage: usage('reported') }] }] }, { id: 'invalid', coordinatorAttempts: [
      { kind: 'coordinator', usage: usage('estimated') }, { kind: 'coordinator', usage: usage('reported', -1) },
      { kind: 'coordinator', usage: { quality: 'reported', input: 1 } }, { kind: 'coordinator', usage: toolSentinel },
    ] }] }] };
    const file = join(dir, 'state.json'), out = join(dir, 'report.json');
    const original = Buffer.from(JSON.stringify(state)); await writeFile(file, original);
    const run = spawnSync(process.execPath, [script, '--input', 'E1', file, '--input', 'main', file, '--report', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    const expected = (sourceLabel: string, role: string, missionId: string, total: number, reported: number, unknown: number, sums: number[]) => ({ sourceLabel, missionId, role, attemptsTotal: total, usageReportedCount: reported, usageUnknownCount: unknown, input: sums[0], output: sums[1], cacheRead: sums[2], cacheWrite: sums[3] });
    const e1coord = expected('E1', 'coordinator', 'E1', 2, 1, 1, [10, 2, 3, 1]);
    const e1exec = expected('E1', 'executor', 'E1', 1, 1, 0, [4, 1, 0, 0]);
    const maincoord = { ...e1coord, sourceLabel: 'main' }, mainexec = { ...e1exec, sourceLabel: 'main' };
    const invalidRow = (sourceLabel: string) => expected(sourceLabel, 'coordinator', 'invalid', 4, 0, 4, [0, 0, 0, 0]);
    assert.deepEqual(result, [e1coord, e1exec, invalidRow('E1'), maincoord, mainexec, invalidRow('main')]);
    for (const row of result) assert.equal(row.usageReportedCount + row.usageUnknownCount, row.attemptsTotal);
    assert.deepEqual(result.filter((row: any) => row.missionId === 'invalid').map((row: any) => [row.attemptsTotal, row.usageReportedCount, row.usageUnknownCount, row.input, row.output, row.cacheRead, row.cacheWrite]), [[4, 0, 4, 0, 0, 0, 0], [4, 0, 4, 0, 0, 0, 0]]);
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), result);
    assert.deepEqual(await readFile(file), original);
    for (const text of [run.stdout, await readFile(out, 'utf8'), run.stderr]) for (const sentinel of sentinels) assert.equal(text.includes(sentinel), false);
    assert.deepEqual(Object.keys(result[0]).sort(), ['attemptsTotal', 'cacheRead', 'cacheWrite', 'input', 'missionId', 'output', 'role', 'sourceLabel', 'usageReportedCount', 'usageUnknownCount'].sort());
    const missingOut = join(dir, 'missing-report');
    const missing = spawnSync(process.execPath, [script, '--input', 'E1', join(dir, keySentinel), '--report', missingOut], { encoding: 'utf8' });
    assert.equal(missing.status, 2);
    assert.equal(missing.stderr.trim(), 'CONTEXT_REPLAY_INPUT_ERROR');
    assert.equal(missing.stderr.includes(dir), false);
    for (const sentinel of sentinels) assert.equal(missing.stderr.includes(sentinel), false);
    await assert.rejects(stat(missingOut));

    const reportedBaseline = expected('E1', 'coordinator', 'E1', 1, 1, 0, [10, 2, 3, 1]);
    const invalidCases = [
      usage('estimated', 10),
      usage('reported', -1),
      { quality: 'reported', input: 10, output: 2, cacheRead: 3 },
      keySentinel,
    ];
    for (const [index, invalidUsage] of invalidCases.entries()) {
      const isolated = { version: 1, projects: [{ missions: [{ id: 'E1', coordinatorAttempts: [
        { kind: 'coordinator', usage: usage('reported', 10) },
        { kind: 'coordinator', usage: invalidUsage },
      ] }] }] };
      const isolatedFile = join(dir, `isolated-${index}.json`);
      await writeFile(isolatedFile, JSON.stringify(isolated));
      const isolatedRun = spawnSync(process.execPath, [script, '--input', 'E1', isolatedFile], { encoding: 'utf8' });
      assert.equal(isolatedRun.status, 0, isolatedRun.stderr);
      assert.deepEqual(JSON.parse(isolatedRun.stdout), [{ ...reportedBaseline, attemptsTotal: 2, usageReportedCount: 1, usageUnknownCount: 1 }]);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
