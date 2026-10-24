// 命令行入口：node src/cli.js <命令> [参数]
// main(argv, io) 返回退出码，测试直接调用；io = { cwd, stdout, stderr }。

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MoneyError } from './money.js';
import { ImportError, parseCsv } from './parse.js';
import { monthlyReport, renderReport } from './report.js';
import { StoreError, addTransactions, loadLedger, saveLedger } from './store.js';

const USAGE = `用法：
  ledger import <文件.csv>
  ledger report [--month YYYY-MM]
`;

export class UsageError extends Error {}

export function loadConfig(cwd) {
  const path = join(cwd, 'config.json');
  const config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return { baseCurrency: 'CNY', ...config };
}

function ledgerPath(cwd) {
  return join(cwd, 'ledger.json');
}

function runImport(args, { cwd, stdout }) {
  if (args.length !== 1) throw new UsageError('import 需要一个 CSV 文件');
  const file = resolve(cwd, args[0]);
  if (!existsSync(file)) throw new ImportError(`找不到文件：${args[0]}`);
  const incoming = parseCsv(readFileSync(file, 'utf8'));
  const path = ledgerPath(cwd);
  const { ledger, added, skipped } = addTransactions(loadLedger(path), incoming);
  saveLedger(path, ledger);
  stdout.write(`导入 ${added} 笔，跳过重复 ${skipped} 笔\n`);
}

function runReport(args, { cwd, stdout }) {
  let month;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--month' && /^\d{4}-\d{2}$/.test(args[i + 1] ?? '')) {
      month = args[++i];
    } else {
      throw new UsageError(`report 不认识的参数：${args[i]}`);
    }
  }
  const ledger = loadLedger(ledgerPath(cwd));
  stdout.write(renderReport(monthlyReport(ledger.transactions, { month })));
}

const COMMANDS = { import: runImport, report: runReport };

export function main(argv, io = {}) {
  const context = {
    cwd: io.cwd ?? process.cwd(),
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
  };
  const [command, ...args] = argv;
  const run = COMMANDS[command];
  if (!run) {
    context.stderr.write(USAGE);
    return 2;
  }
  try {
    run(args, context);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      context.stderr.write(`${error.message}\n${USAGE}`);
      return 2;
    }
    if (error instanceof ImportError || error instanceof StoreError || error instanceof MoneyError) {
      context.stderr.write(`错误：${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
