import { execFileSync } from 'node:child_process';
import { collectCodeMetrics } from '../src/application/platform/code-metrics-files.ts';

try {
  const args = process.argv.slice(2);
  const index = args.indexOf('--changed');
  let changed: string[] | undefined;
  if (index >= 0) {
    if (!args[index + 1] || args[index + 1].startsWith('-')) throw new Error('--changed 需要基线提交');
    changed = execFileSync('git', ['diff', '--name-only', '-z', args[index + 1], '--', 'src'], { encoding: 'utf8' }).split('\0').filter(Boolean);
    changed.push(...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', 'src'], { encoding: 'utf8' }).split('\0').filter(Boolean));
  }
  const report = await collectCodeMetrics(process.cwd(), changed);
  for (const warning of report.warnings) console.log(`${warning.path}:${warning.line} ${warning.kind}=${warning.value}（建议≤${warning.limit}） ${warning.detail}`);
  for (const entry of report.unanalyzed) console.log(`未分析：${entry}`);
  console.log(`近似告警 ${report.warnings.length} 条；仅作提示，退出码0。`);
} catch (error) { console.log(`未分析：${String(error)}；只告警，退出码0。`); }
