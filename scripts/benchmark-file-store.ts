/**
 * 合成负载基线：量 FileStateStore.flush() 的同步落盘耗时。
 *
 * 只造**合成**事件（kind=synthetic.benchmark，每条 payload 1KB），
 * 在系统临时目录下的 mkdtemp 目录里写自己的 synthetic-N.json。
 * 不读、不写本仓库的状态文件与凭据，不改生产存储逻辑。
 *
 *   node scripts/benchmark-file-store.ts [--sizes 1,10,50] [--samples 4]
 */
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { FileStateStore } from '../src/application/file-store.ts';

const EVENTS_PER_MB = 1024;
const PAYLOAD = 'x'.repeat(1024);
const PROJECT_ID = 'synthetic-project';
const MISSION_ID = 'synthetic-mission';
const DIR_PREFIX = 'coagent-persist-bench-';

function fail(message: string): never {
  console.error(`参数错误：${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { sizes: number[]; samples: number } {
  let sizes = [1, 10, 50];
  let samples = 4;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1]?.trim();
    if (flag !== '--sizes' && flag !== '--samples') fail(`未知参数 ${flag}`);
    if (value === undefined || value === '') fail(`${flag} 缺少取值`);
    i += 1;
    if (flag === '--sizes') {
      const parts = value.split(',');
      if (parts.some((part) => !/^\d+$/.test(part))) fail(`--sizes 需要正整数列表，收到 ${value}`);
      sizes = parts.map(Number);
    } else {
      if (!/^\d+$/.test(value)) fail(`--samples 需要正整数，收到 ${value}`);
      samples = Number(value);
    }
  }
  for (const size of sizes) {
    if (!Number.isInteger(size) || size < 1 || size > 64) fail(`size 须在 1..64，收到 ${size}`);
  }
  if (!Number.isInteger(samples) || samples < 1 || samples > 10) fail(`samples 须在 1..10，收到 ${samples}`);
  return { sizes, samples };
}

function syntheticEvent(at: string) {
  return { at, projectId: PROJECT_ID, missionId: MISSION_ID, kind: 'synthetic.benchmark', data: { payload: PAYLOAD } };
}

const { sizes, samples } = parseArgs(process.argv.slice(2));
const root = mkdtempSync(join(tmpdir(), DIR_PREFIX));
const at = new Date().toISOString();

try {
  for (const sizeMB of sizes) {
    const path = join(root, `synthetic-${sizeMB}.json`);
    const store = new FileStateStore(path);
    const events = store.raw().events;
    for (let i = 0; i < sizeMB * EVENTS_PER_MB; i += 1) events.push(syntheticEvent(at) as never);

    const flushMs: number[] = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const started = performance.now();
      store.flush();
      flushMs.push(Number((performance.now() - started).toFixed(1)));
    }
    const bytes = statSync(path).size;
    console.log(JSON.stringify({
      source: 'synthetic-only',
      sizeMB,
      flushMs,
      fileMB: Number((bytes / 1024 / 1024).toFixed(2)),
    }));
  }
} finally {
  // 只删自己建的目录：realpath 必须在系统临时目录下，且目录名带本脚本前缀。
  const realRoot = realpathSync(root);
  const realTemp = realpathSync(resolve(tmpdir()));
  const insideTemp = realRoot.startsWith(realTemp) && realRoot !== realTemp;
  if (!insideTemp || !basename(realRoot).startsWith(DIR_PREFIX)) {
    console.error(`拒绝清理非预期目录：${realRoot}`);
  } else {
    rmSync(realRoot, { recursive: true, force: true });
  }
}
