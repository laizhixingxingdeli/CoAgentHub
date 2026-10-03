/** 近似度量只作告警；不承担语法检查或合入门禁。 */
export interface MetricSource { path: string; content: string }
export interface MetricWarning { path: string; line: number; kind: string; value: number; limit: number; detail: string }
export interface MetricsReport { warnings: MetricWarning[]; unanalyzed: string[] }

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/** 保留换行与字符位置，注释/字符串中的括号不会参与度量。 */
function mask(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    (match) => match.replace(/[^\r\n]/g, ' '));
}

function closingBrace(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

function parameterCount(parameters: string): number {
  if (!parameters.trim()) return 0;
  let count = 1;
  let depth = 0;
  for (const char of parameters) {
    if ('([{<'.includes(char)) depth++;
    else if (')]}>' .includes(char)) depth--;
    else if (char === ',' && depth === 0) count++;
  }
  return count;
}

function functionMetrics(file: MetricSource, report: MetricsReport): void {
  const source = mask(file.content);
  // 函数声明、块体箭头、普通方法；复杂泛型/正则字面量仅作近似，见未分析说明。
  const pattern = /(?:function\s*[\w$]*\s*|(?:^|[\n;{}])\s*(?:async\s+)?[#\w$]+\s*|(?:\b(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s+)?))\(([^()]*)\)\s*(?::[^=\n{]+)?\s*(?:=>\s*)?\{/g;
  let match: RegExpExecArray | null;
  let found = 0;
  while ((match = pattern.exec(source))) {
    if (/^\s*(?:if|for|while|switch|catch|with)\s*\(/.test(match[0])) continue;
    found++;
    const start = pattern.lastIndex - 1;
    const end = closingBrace(source, start);
    const line = source.slice(0, start).split('\n').length;
    if (end < 0) { report.unanalyzed.push(`${file.path}:${line} 未匹配函数闭括号`); continue; }
    const body = source.slice(start + 1, end);
    let nesting = 0;
    let maximum = 0;
    for (const char of body) {
      if (char === '{') maximum = Math.max(maximum, ++nesting);
      if (char === '}') nesting--;
    }
    const measures: [string, number, number][] = [
      ['function_lines', body.split('\n').length, 40],
      ['parameters', parameterCount(match[1]), 4],
      ['nesting', maximum, 3],
      ['complexity', 1 + (body.match(/\b(?:if|for|while|case|catch)\b|&&|\|\||\?(?![?.])/g)?.length ?? 0), 14],
    ];
    for (const [kind, value, limit] of measures) {
      if (value > limit) report.warnings.push({ path: file.path, line, kind, value, limit, detail: '近似度量，人工复核' });
    }
  }
  if (/=>|\bfunction\b/.test(source) && found === 0) report.unanalyzed.push(`${file.path}: 函数形式未识别`);
  if (/=>\s*[^\s{]/.test(source)) report.unanalyzed.push(`${file.path}: 表达式箭头/复杂签名未逐函数分析`);
}

function dependencyCycles(files: readonly MetricSource[], selected: Set<string>): MetricWarning[] {
  const paths = new Set(files.map((file) => normalize(file.path)));
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const path = normalize(file.path);
    if (!path.startsWith('src/')) continue;
    const imports = [...file.content.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').matchAll(/\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?['"]([^'"]+)['"]/g)];
    const targets = imports.flatMap((match) => {
      if (!match[1].startsWith('.')) return [];
      const base = normalize(`${path.slice(0, path.lastIndexOf('/'))}/${match[1]}`);
      const target = [base, `${base}.ts`, `${base}.js`, `${base}/index.ts`, `${base}/index.js`].find((candidate) => paths.has(candidate));
      return target ? [target] : [];
    });
    graph.set(path, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const warnings: MetricWarning[] = [];
  function visit(path: string): void {
    if (visiting.has(path)) {
      const cycle = [...stack.slice(stack.indexOf(path)), path];
      if (cycle.some((member) => selected.has(member))) warnings.push({ path, line: 1, kind: 'dependency_cycle', value: cycle.length - 1, limit: 0, detail: cycle.join(' → ') });
      return;
    }
    if (visited.has(path)) return;
    visiting.add(path); stack.push(path);
    for (const target of graph.get(path) ?? []) visit(target);
    stack.pop(); visiting.delete(path); visited.add(path);
  }
  for (const path of graph.keys()) visit(path);
  return warnings;
}

export function analyzeCodeMetrics(files: readonly MetricSource[], changedPaths?: readonly string[]): MetricsReport {
  const selected = new Set((changedPaths ?? files.map((file) => file.path)).map(normalize));
  const report: MetricsReport = { warnings: [], unanalyzed: [] };
  for (const file of files) {
    if (!selected.has(normalize(file.path))) continue;
    if (!/\.(ts|js)$/.test(file.path)) { report.unanalyzed.push(`${file.path}: 非源码文件`); continue; }
    const lines = file.content.split('\n').length;
    if (lines > 400) report.warnings.push({ path: file.path, line: 1, kind: 'file_lines', value: lines, limit: 400, detail: '文件长度' });
    functionMetrics(file, report);
  }
  report.warnings.push(...dependencyCycles(files, selected));
  return report;
}
