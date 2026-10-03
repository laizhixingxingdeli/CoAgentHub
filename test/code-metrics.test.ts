import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCodeMetrics } from '../src/application/code-metrics.ts';

test('近似度量报告长度、参数、嵌套、复杂度与相对依赖环，只报选中文件', () => {
  const sources = [
    { path: 'src/a.ts', content: `import { b } from './b.ts';\nfunction long(a,b,c,d,e) {\n${'  if (a) { if(b) { if(c) { if(d) { a++; } } } }\n'.repeat(41)}}\n` },
    { path: 'src/b.ts', content: "import { a } from './a.ts';\nexport const b = 1;" },
  ];
  const report = analyzeCodeMetrics(sources, ['src/a.ts']);
  for (const kind of ['function_lines', 'parameters', 'nesting', 'complexity', 'dependency_cycle']) {
    assert.ok(report.warnings.some((warning) => warning.kind === kind), kind);
  }
  assert.ok(!report.warnings.some((warning) => warning.path === 'src/b.ts' && warning.kind !== 'dependency_cycle'));
  assert.ok(analyzeCodeMetrics([{ path: 'src/large.ts', content: '\n'.repeat(401) }]).warnings.some((warning) => warning.kind === 'file_lines'));
});
