import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { analyzeCodeMetrics, type MetricSource, type MetricsReport } from '../code-metrics.ts';

/** 全图仅读 src；不能读取仓库凭据、状态或代理配置。 */
export async function collectCodeMetrics(root: string, changedPaths?: readonly string[]): Promise<MetricsReport> {
  const sources: MetricSource[] = [];
  const unanalyzed: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.(ts|js)$/.test(entry.name)) {
        try { sources.push({ path: relative(root, path).replaceAll('\\', '/'), content: await readFile(path, 'utf8') }); }
        catch { unanalyzed.push(`${relative(root, path)}: 读取失败`); }
      }
    }
  }
  try { await walk(resolve(root, 'src')); }
  catch { unanalyzed.push('src: 无法完整读取源码目录'); }
  const report = analyzeCodeMetrics(sources, changedPaths);
  report.unanalyzed.push(...unanalyzed);
  return report;
}
