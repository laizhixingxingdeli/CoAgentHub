/**
 * 离线逐跳归因入口。
 *
 *   node src/context-attribution-report.ts --input <state.json> [--archive <package.json> ...]
 *
 * 只读显式路径、只写 stdout。失败只打固定错误码：路径和源 JSON 都可能夹带凭据。
 * 不 import FileStateStore / Platform，避免顺手 hydrate 或去拼简报。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONTEXT_ATTRIBUTION_ERROR_CODE,
  buildContextAttributionReport,
} from './application/context-attribution-report.ts';

function fail(): void {
  console.error(CONTEXT_ATTRIBUTION_ERROR_CODE);
  process.exitCode = 2;
}

function parseArgs(argv: readonly string[]): { input: string; archives: string[] } {
  let input: string | undefined;
  const archives: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--input') {
      if (!value || value.startsWith('--') || input !== undefined) throw new Error('bad args');
      input = value;
      i += 1;
      continue;
    }
    if (flag === '--archive') {
      if (!value || value.startsWith('--')) throw new Error('bad args');
      archives.push(value);
      i += 1;
      continue;
    }
    throw new Error('bad args');
  }
  if (!input) throw new Error('bad args');
  return { input, archives };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function readArchive(path: string): { value: unknown; integrity: { bytes: number; sha256: string } } {
  const buf = readFileSync(path);
  return {
    value: JSON.parse(buf.toString('utf8')) as unknown,
    integrity: {
      bytes: buf.byteLength,
      sha256: createHash('sha256').update(buf).digest('hex'),
    },
  };
}

function main(): void {
  try {
    const args = parseArgs(process.argv.slice(2));
    const state = readJson(args.input);
    const archives = args.archives.map(readArchive);
    const report = buildContextAttributionReport(
      state,
      archives.map((item) => item.value),
      archives.map((item) => item.integrity),
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch {
    fail();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) main();
