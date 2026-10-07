/**
 * W-501：机器验收事件带命令规格 + 复用比对。
 *
 * 守住：
 *   - validation.reported 带上当时工单的 argv / timeoutMs / allowedScope，且是拷贝
 *   - 命令、timeout、范围任一不等，或老事件缺这些东西，就不能复用旧报告
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { ValidationReport } from '../src/kernel/index.ts';
import { validationReportedData } from '../src/application/platform/standard-validation.ts';
import { reportReuseSpecMatches } from '../src/application/platform/validation-report-views.ts';

describe('validation.reported 携带命令规格与范围', () => {
  test('写入数据是拷贝，事后改入参不动它', () => {
    const argv = ['node', '--test'];
    const data = validationReportedData(
      { id: 'VR-1', passed: true },
      'AT-1',
      {
        objective: 'o',
        allowedScope: ['src/foo.ts'],
        requiredBehaviour: 'r',
        constraints: [],
        acceptance: [],
        verification: [],
        doNot: [],
        validation: { commands: [{ argv, timeoutMs: 5000 }] },
      },
    );
    assert.deepEqual(data, {
      reportId: 'VR-1',
      passed: true,
      submittedAttemptId: 'AT-1',
      commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }],
      allowedScope: ['src/foo.ts'],
    });
    argv[0] = 'nodejs';
    assert.equal(data.commands[0]!.argv[0], 'node');
  });
});

describe('reportReuseSpecMatches 全等判定', () => {
  // 报告侧是 engine 写出来的形状：argv 原文、allowedScope 已规范化。
  const report: ValidationReport = {
    id: 'VR-1',
    policyRevision: 1,
    missionId: 'M-1',
    startedAt: '2026-10-07T00:00:00.000Z',
    endedAt: '2026-10-07T00:00:01.000Z',
    passed: true,
    checks: [
      {
        kind: 'command',
        passed: true,
        startedAt: '2026-10-07T00:00:00.000Z',
        endedAt: '2026-10-07T00:00:01.000Z',
        summary: 'ok',
        command: {
          argv: ['node', '--test'],
          cwd: '/w',
          exitCode: 0,
          timedOut: false,
          durationMs: 12,
          outputTail: '',
        },
      },
      {
        kind: 'changed-paths',
        passed: true,
        startedAt: '2026-10-07T00:00:00.000Z',
        endedAt: '2026-10-07T00:00:01.000Z',
        summary: 'ok',
        changedPaths: {
          allowedScope: ['src/foo.ts'],
          actual: ['src/foo.ts'],
          violations: [],
          unsupportedScope: [],
        },
      },
    ],
  };
  const orderAllowedScope = ['./src/foo.ts'];
  const base = {
    report,
    orderAllowedScope,
    orderCommands: [{ argv: ['node', '--test'], timeoutMs: 5000 }],
  };

  test('全等才复用：原文带 ./ 为 true，timeout/缺 commands/argv 多一段为 false', () => {
    const eventData = {
      reportId: 'VR-1',
      passed: true,
      submittedAttemptId: 'AT-1',
      commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }],
      allowedScope: ['./src/foo.ts'],
    };
    assert.equal(reportReuseSpecMatches({ ...base, eventData }), true);

    // timeout 不同：同一条命令换个时限就是换了判定尺度。
    assert.equal(
      reportReuseSpecMatches({
        ...base,
        eventData: {
          commands: [{ argv: ['node', '--test'], timeoutMs: 1 }],
          allowedScope: ['./src/foo.ts'],
        },
      }),
      false,
    );

    // 老事件没有 commands：猜不出当时跑了什么，按不能复用处理。
    assert.equal(
      reportReuseSpecMatches({ ...base, eventData: { allowedScope: ['./src/foo.ts'] } }),
      false,
    );

    // 报告侧 argv 多一段：跑的不是工单那条命令。
    const withExtra: ValidationReport = {
      ...report,
      checks: report.checks.map((check) =>
        check.kind === 'command'
          ? { ...check, command: { ...check.command!, argv: ['node', '--test', 'extra'] } }
          : check,
      ),
    };
    assert.equal(reportReuseSpecMatches({ ...base, report: withExtra, eventData }), false);
  });
});
