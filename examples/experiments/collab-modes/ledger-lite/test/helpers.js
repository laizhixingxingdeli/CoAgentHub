import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

/** 建一个带 config.json 的临时工作目录。 */
export function workdir(config = { baseCurrency: 'CNY' }) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-lite-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

export function writeFile(dir, name, content) {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

/** 调 main 并收集输出。 */
export function run(dir, ...argv) {
  let stdout = '';
  let stderr = '';
  const code = main(argv, {
    cwd: dir,
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
  });
  return { code, stdout, stderr };
}
