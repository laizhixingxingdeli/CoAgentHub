/**
 * ValidationEngine 端口：命令执行与变更路径观测。
 *
 * 故意与 Executor 自报解耦：changed-paths / diff-size 只信任独立观测。
 * 禁止把 ExecutionResult / EvidenceRecord 当 pass 输入。
 */

export interface CommandRunner {
  run(input: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly timeoutMs: number;
  }): Promise<{
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    output: string;
  }>;
}

export interface ChangedPathReader {
  listChanged(input: {
    readonly missionId: string;
    readonly baseRevision: string;
    readonly projectRoot: string;
  }): Promise<readonly string[]>;
}

/**
 * 可信 diff 行数事实（VAL-002）。
 *
 * 与 `ChangedPathReader` 并列；不经 Executor evidence。
 * `changedLines` 缺省且 `unknown` 含 `'changedLines'` = 无法计量。
 */
export interface DiffLineFacts {
  readonly changedLines?: number;
  readonly unknown: readonly 'changedLines'[];
}

export interface DiffFactReader {
  measureLines(input: {
    readonly missionId: string;
    readonly baseRevision: string;
    readonly projectRoot: string;
  }): Promise<DiffLineFacts>;
}
