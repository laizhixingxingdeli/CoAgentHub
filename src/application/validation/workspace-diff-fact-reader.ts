/**
 * 生产 DiffFactReader：git diff --numstat + 未跟踪文件只读行数。
 *
 * 不解析 diff.stat；不 mutate index；不读 Executor 自报。
 * worktree 路径与 WorkspaceChangedPathReader / GitWorktreeManager.diff 对齐。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { WorkspaceManager } from '../workspace.ts';
import type { DiffFactReader, DiffLineFacts } from './ports.ts';

const run = promisify(execFile);

export class WorkspaceDiffFactReader implements DiffFactReader {
  #workspace: WorkspaceManager;

  constructor(workspace: WorkspaceManager) {
    this.#workspace = workspace;
  }

  async measureLines(input: {
    readonly missionId: string;
    readonly baseRevision: string;
    readonly projectRoot: string;
  }): Promise<DiffLineFacts> {
    const cwd = resolveWorktreeCwd(this.#workspace, input.missionId, input.projectRoot);
    if (!cwd || !existsSync(cwd)) {
      return { unknown: Object.freeze(['changedLines']) as readonly 'changedLines'[] };
    }

    let trackedSum = 0;
    let unknown = false;

    try {
      const numstat = (
        await run('git', ['diff', '--numstat', input.baseRevision], {
          cwd,
          maxBuffer: 16 * 1024 * 1024,
        })
      ).stdout;
      for (const raw of numstat.split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (!line) continue;
        const tab1 = line.indexOf('\t');
        const tab2 = tab1 >= 0 ? line.indexOf('\t', tab1 + 1) : -1;
        if (tab1 < 0 || tab2 < 0) {
          unknown = true;
          continue;
        }
        const insertions = line.slice(0, tab1);
        const deletions = line.slice(tab1 + 1, tab2);
        if (insertions === '-' || deletions === '-') {
          unknown = true;
          continue;
        }
        const ins = Number(insertions);
        const del = Number(deletions);
        if (!Number.isFinite(ins) || !Number.isFinite(del)) {
          unknown = true;
          continue;
        }
        trackedSum += ins + del;
      }
    } catch {
      return { unknown: Object.freeze(['changedLines']) as readonly 'changedLines'[] };
    }

    let untrackedSum = 0;
    let untrackedPaths: string[] = [];
    try {
      const listed = (
        await run('git', ['ls-files', '--others', '--exclude-standard'], {
          cwd,
          maxBuffer: 16 * 1024 * 1024,
        })
      ).stdout;
      untrackedPaths = listed
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return { unknown: Object.freeze(['changedLines']) as readonly 'changedLines'[] };
    }

    for (const rel of untrackedPaths) {
      try {
        const buf = await readFile(join(cwd, rel));
        if (buf.includes(0)) {
          unknown = true;
          continue;
        }
        untrackedSum += countTextLines(buf.toString('utf8'));
      } catch {
        unknown = true;
      }
    }

    if (unknown) {
      return { unknown: Object.freeze(['changedLines']) as readonly 'changedLines'[] };
    }
    return {
      changedLines: trackedSum + untrackedSum,
      unknown: Object.freeze([]) as readonly 'changedLines'[],
    };
  }
}

function resolveWorktreeCwd(
  workspace: WorkspaceManager,
  missionId: string,
  projectRoot: string,
): string | undefined {
  if (typeof workspace.worktreePath === 'function') {
    return workspace.worktreePath(missionId, projectRoot);
  }
  // 无 worktreePath 的实现（如 InPlace）：无法定位隔离工作区。
  return undefined;
}

/** 文本行数：空文件 0；末行无换行仍计 1 行（与常见 wc/git 语义对齐）。 */
export function countTextLines(text: string): number {
  if (text.length === 0) return 0;
  const parts = text.split(/\r?\n/);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}
