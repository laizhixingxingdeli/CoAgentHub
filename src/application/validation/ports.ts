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

/** 一个二进制文件的可信事实。授权与否由引擎拿工单范围去判，读取器不知道范围。 */
export interface DiffBinaryFileFact {
  readonly path: string;
  /** 被删除的文件没有大小。 */
  readonly bytes?: number;
  readonly sha256?: string;
  readonly deleted?: true;
}

/**
 * 可信 diff 行数事实（VAL-002）。
 *
 * 与 `ChangedPathReader` 并列；不经 Executor evidence。
 * `changedLines` 只数文本行，二进制文件单列在 `binaryFiles`，不让它们把文本行数拖成 unknown。
 * `changedLines` 缺省且 `unknown` 含 `'changedLines'` = 有文本文件量不出来，`unmeasurable`
 * 点名是哪个文件、为什么。
 */
export interface DiffLineFacts {
  readonly changedLines?: number;
  readonly unknown: readonly 'changedLines'[];
  /** 旧读取器 / 测试替身没有这两项：缺省按「没看到二进制、没有量不出的文件」处理。 */
  readonly binaryFiles?: readonly DiffBinaryFileFact[];
  readonly unmeasurable?: readonly { readonly path: string; readonly reason: string }[];
}

export interface DiffFactReader {
  measureLines(input: {
    readonly missionId: string;
    readonly baseRevision: string;
    readonly projectRoot: string;
  }): Promise<DiffLineFacts>;
}
