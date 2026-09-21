/**
 * ValidationEngine 端口：命令执行与变更路径观测。
 *
 * 故意与 Executor 自报解耦：changed-paths 只信任 WorkspaceManager.diff 的独立观测。
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
