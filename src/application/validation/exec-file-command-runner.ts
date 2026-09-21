/**
 * 生产 CommandRunner：node:child_process.execFile，无 shell。
 *
 * 非 0 / timeout / 启动失败一律结构化返回，不抛给 engine 误判通过。
 */

import { execFile } from 'node:child_process';
import type { CommandRunner } from './ports.ts';

export class ExecFileCommandRunner implements CommandRunner {
  run(input: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly timeoutMs: number;
  }): Promise<{
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    output: string;
  }> {
    const argv = [...input.argv];
    const file = argv[0];
    const args = argv.slice(1);
    if (!file) {
      return Promise.resolve({
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        output: '',
      });
    }

    const started = Date.now();
    return new Promise((resolve) => {
      execFile(
        file,
        args,
        {
          cwd: input.cwd,
          timeout: input.timeoutMs,
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          shell: false,
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - started;
          const output = `${stdout ?? ''}${stderr ?? ''}`;
          if (!error) {
            resolve({ exitCode: 0, timedOut: false, durationMs, output });
            return;
          }

          const err = error as NodeJS.ErrnoException & {
            code?: string | number | null;
            killed?: boolean;
            signal?: NodeJS.Signals | null;
          };

          // timeout：Node 会 kill 子进程；killed=true 且无数值 exit code。
          const timedOut =
            err.killed === true && (typeof err.code !== 'number' || err.code === null);

          let exitCode: number | null = null;
          if (typeof err.code === 'number') {
            exitCode = err.code;
          }

          resolve({ exitCode, timedOut, durationMs, output });
        },
      );
    });
  }
}
