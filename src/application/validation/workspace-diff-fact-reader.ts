/**
 * 生产 DiffFactReader：git diff --numstat + 未跟踪文件只读行数。
 *
 * 不解析 diff.stat；不 mutate index；不读 Executor 自报。
 * worktree 路径与 WorkspaceChangedPathReader / GitWorktreeManager.diff 对齐。
 *
 * 文本与二进制分开计量：文本按行数，二进制只记路径 / 大小 / 哈希。以前 numstat 里
 * 出现一个 `-`（授权的 AAR、Gradle Wrapper JAR，或没人要的 `.pyc`）就让整份
 * changedLines 变成笼统的 unknown，文本改动也跟着量不出来。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { WorkspaceManager } from '../workspace.ts';
import type { DiffBinaryFileFact, DiffFactReader, DiffLineFacts } from './ports.ts';

const run = promisify(execFile);

const GIT_BUFFER = 16 * 1024 * 1024;
/** git 判二进制只看文件头这么多字节里有没有 NUL；这里照同一口径。 */
const BINARY_SNIFF_BYTES = 8000;
/** 超过这个大小的二进制不算哈希：为一次校验把整个大文件读一遍不值得，大小与路径照记。 */
const HASH_SIZE_LIMIT_BYTES = 512 * 1024 * 1024;

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
      return unmeasurableWhole('Mission 工作区不存在，无法计量');
    }

    let numstat: string;
    let untrackedPaths: string[];
    try {
      // -z 与 --no-renames：路径不被引号转义，改名也按「删一个 + 增一个」拆开，
      // 二进制行恒为 `-\t-\t<path>`。
      numstat = (
        await run('git', ['diff', '--numstat', '-z', '--no-renames', input.baseRevision], {
          cwd,
          maxBuffer: GIT_BUFFER,
        })
      ).stdout;
      untrackedPaths = (
        await run('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
          cwd,
          maxBuffer: GIT_BUFFER,
        })
      ).stdout
        .split('\0')
        .filter(Boolean);
    } catch (error) {
      return unmeasurableWhole(`git 读取失败：${firstLine(error)}`);
    }

    let textLines = 0;
    const binaryPaths: string[] = [];
    const unmeasurable: { path: string; reason: string }[] = [];

    for (const record of numstat.split('\0').filter(Boolean)) {
      const parsed = parseNumstatRecord(record);
      if (!parsed) {
        unmeasurable.push({ path: record.slice(0, 120), reason: '无法解析 git numstat 输出' });
      } else if (parsed.binary) {
        binaryPaths.push(parsed.path);
      } else {
        textLines += parsed.lines;
      }
    }

    for (const rel of untrackedPaths) {
      const outcome = await countUntracked(join(cwd, rel));
      if (outcome.kind === 'binary') binaryPaths.push(rel);
      else if (outcome.kind === 'text') textLines += outcome.lines;
      else unmeasurable.push({ path: rel, reason: outcome.reason });
    }

    const binaryFiles: DiffBinaryFileFact[] = [];
    for (const rel of binaryPaths) binaryFiles.push(await measureBinary(cwd, rel));

    return {
      // 文本行数只在每个文本文件都量得出来时才算数：缺一个就不报一个偏小的数。
      ...(unmeasurable.length === 0 ? { changedLines: textLines } : {}),
      unknown: Object.freeze(unmeasurable.length === 0 ? [] : ['changedLines']) as readonly 'changedLines'[],
      binaryFiles,
      unmeasurable,
    };
  }
}

function unmeasurableWhole(reason: string): DiffLineFacts {
  return {
    unknown: Object.freeze(['changedLines']) as readonly 'changedLines'[],
    binaryFiles: [],
    unmeasurable: [{ path: '(整个工作区)', reason }],
  };
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split(/\r?\n/)[0]!.slice(0, 200);
}

/** `ins\tdel\tpath`；二进制是 `-\t-\tpath`。 */
function parseNumstatRecord(
  record: string,
): { binary: true; path: string } | { binary: false; lines: number; path: string } | undefined {
  const tab1 = record.indexOf('\t');
  const tab2 = tab1 >= 0 ? record.indexOf('\t', tab1 + 1) : -1;
  if (tab1 < 0 || tab2 < 0) return undefined;
  const insertions = record.slice(0, tab1);
  const deletions = record.slice(tab1 + 1, tab2);
  const path = record.slice(tab2 + 1);
  if (path === '') return undefined;
  if (insertions === '-' && deletions === '-') return { binary: true, path };
  const ins = Number(insertions);
  const del = Number(deletions);
  if (!Number.isFinite(ins) || !Number.isFinite(del)) return undefined;
  return { binary: false, lines: ins + del, path };
}

type UntrackedOutcome =
  | { kind: 'binary' }
  | { kind: 'text'; lines: number }
  | { kind: 'unreadable'; reason: string };

async function countUntracked(absolute: string): Promise<UntrackedOutcome> {
  try {
    if (await looksBinary(absolute)) return { kind: 'binary' };
    const buf = await readFile(absolute);
    return { kind: 'text', lines: countTextLines(buf.toString('utf8')) };
  } catch (error) {
    return { kind: 'unreadable', reason: `读取失败：${firstLine(error)}` };
  }
}

async function looksBinary(absolute: string): Promise<boolean> {
  const handle = await open(absolute, 'r');
  try {
    const head = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(head, 0, BINARY_SNIFF_BYTES, 0);
    return head.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

async function measureBinary(cwd: string, rel: string): Promise<DiffBinaryFileFact> {
  const absolute = join(cwd, rel);
  let size: number;
  try {
    size = (await stat(absolute)).size;
  } catch {
    // 工作区里已经没有这个文件：被删掉的二进制，没有大小可量。
    return { path: rel, deleted: true };
  }
  if (size > HASH_SIZE_LIMIT_BYTES) return { path: rel, bytes: size };
  try {
    return { path: rel, bytes: size, sha256: await sha256Of(absolute) };
  } catch {
    return { path: rel, bytes: size };
  }
}

function sha256Of(absolute: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolute);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
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
