import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { writeVibe } from './project-memory.ts';

const execute = promisify(execFile);
export const documentHash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function documentGit(root: string, args: string[]) {
  return (await execute('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}
export function safeDocumentPath(path: string): string {
  if (!/^(?:AGENTS\.md|CLAUDE\.md|\.coagent\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.md)$/.test(path)) throw new Error('DOCUMENT_PATH_FORBIDDEN');
  if (path.split('/').some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('DOCUMENT_PATH_FORBIDDEN');
  return path;
}
function assertNotSymlink(path: string) {
  try { if (lstatSync(path).isSymbolicLink()) throw new Error('DOCUMENT_SYMLINK_FORBIDDEN'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export function readDocument(root: string, path: string): string {
  const target = resolve(root, safeDocumentPath(path));
  const rel = relative(resolve(root), target);
  if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('DOCUMENT_PATH_FORBIDDEN');
  let current = target;
  while (current !== resolve(root)) {
    assertNotSymlink(current);
    current = dirname(current);
  }
  return existsSync(target) ? readFileSync(target, 'utf8').replaceAll('\r\n', '\n') : '';
}
export interface DocumentChange { before: string; after: string }
function assertMemoryPaths(root: string) {
  for (const directory of ['.coagent/specs', '.coagent/architecture/decisions']) {
    readDocument(root, `${directory}/__path-check__.md`);
    if (existsSync(join(root, directory))) for (const file of readdirSync(join(root, directory))) {
      if (file.endsWith('.md')) readDocument(root, `${directory}/${file}`);
    }
  }
  readDocument(root, '.coagent/project.md'); readDocument(root, '.coagent/architecture/constitution.md');
  assertNotSymlink(join(root, '.coagent/project.yaml'));
}
export function applyDocumentChanges(base: string, changes: readonly DocumentChange[]): string {
  if (!Array.isArray(changes) || !changes.length || changes.length > 100) throw new Error('DOCUMENT_CHANGES_REQUIRED');
  let result = base;
  for (const change of changes) {
    if (!change || typeof change.before !== 'string' || typeof change.after !== 'string') throw new Error('DOCUMENT_CHANGE_INVALID');
    const before = change.before.replaceAll('\r\n', '\n'); const after = change.after.replaceAll('\r\n', '\n');
    if (!before) {
      if (result) throw new Error('DOCUMENT_EMPTY_ANCHOR');
      result = after;
    } else {
      const index = result.indexOf(before);
      if (index < 0 || result.indexOf(before, index + 1) >= 0) throw new Error('DOCUMENT_ANCHOR_NOT_UNIQUE');
      result = result.slice(0, index) + after + result.slice(index + before.length);
    }
  }
  return result;
}

/** 先在隔离检出提交，再核对目标干净/HEAD/分支，以 fast-forward 原子落入集成分支。 */
export async function commitDocument(input: { root: string; path: string; before: string; after: string; marker: string; projectId: string }) {
  const { root, path, marker } = input;
  const prior = await documentGit(root, ['log', '-1', '--format=%H', '--fixed-strings', '--grep', marker]);
  if (prior && readDocument(root, path) === input.after) return prior;
  const branch = await documentGit(root, ['branch', '--show-current']);
  if (!branch || branch === 'master' || branch === 'main') throw new Error('DOCUMENT_TARGET_NOT_INTEGRATION');
  if (await documentGit(root, ['status', '--porcelain'])) throw new Error('DOCUMENT_WORKSPACE_DIRTY');
  if (readDocument(root, path) !== input.before) throw new Error('DOCUMENT_BASE_CHANGED');
  const head = await documentGit(root, ['rev-parse', 'HEAD']);
  const scratch = join(tmpdir(), `coagent-doc-${randomUUID()}`);
  let added = false;
  try {
    await documentGit(root, ['worktree', 'add', '--detach', scratch, head]); added = true;
    readDocument(scratch, path);
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    writeFileSync(join(scratch, path), input.after, 'utf8');
    assertNotSymlink(join(scratch, 'VIBE.md'));
    assertMemoryPaths(scratch);
    const generated = writeVibe(scratch, input.projectId);
    await documentGit(scratch, ['add', '--', path, generated]);
    const changed = await documentGit(scratch, ['diff', '--cached', '--name-only']);
    if (!changed) return head;
    await documentGit(scratch, ['commit', '-m', `docs(project): 批准文档提议\n\n${marker}`]);
    const revision = await documentGit(scratch, ['rev-parse', 'HEAD']);
    if (await documentGit(root, ['branch', '--show-current']) !== branch || await documentGit(root, ['rev-parse', 'HEAD']) !== head
        || await documentGit(root, ['status', '--porcelain'])) throw new Error('DOCUMENT_TARGET_CHANGED');
    await documentGit(root, ['merge', '--ff-only', revision]);
    return revision;
  } finally {
    if (added) await documentGit(root, ['worktree', 'remove', '--force', scratch]).catch(() => undefined);
  }
}
