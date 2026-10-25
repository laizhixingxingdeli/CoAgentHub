/**
 * CI 工作流的门禁事实（静态）。
 *
 * 适配器与 MCP 曾经整条 job `continue-on-error: true`：坏了也显示绿灯，合并照样放行。
 * 这里守的是那份判据本身——适配器测试、tsc 构建、MCP 测试必须挡合并；唯一的例外是
 * 那条真的做 DNS 解析的用例（跑在代理后面时失败是 ECONNRESET 而不是 ENOTFOUND，
 * 取决于运行机的网络栈），它单独一步、标 continue-on-error，只负责把失败显示出来。
 * 判据读文本而不是解析 YAML：仓库没有 YAML 依赖，形状又只有这两处。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// 工作区是 Windows 的 CRLF 检出：先归一化，行尾不该影响判据。
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

/** 取一个 job 的正文：从它的名字到下一个顶层 job 或文件末尾。 */
function jobBlock(name: string): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.ok(start >= 0, `工作流里没有 job ${name}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
  // 文件末行的空行由 split 留下，收尾时去掉。
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

test('适配器与 MCP 是必过 job：不能整条 continue-on-error', () => {
  const block = jobBlock('adapter-and-mcp');
  // job 级键缩进 4 空格；step 级是列表项（6 空格 + "-"）。只拦前者。
  assert.doesNotMatch(block, /^ {4}continue-on-error:/m, '整条 job 不许 continue-on-error，否则坏了也不挡合并');
  assert.match(block, /^ {4}runs-on: /m);
});

test('必过步骤覆盖确定性适配器测试、tsc 构建与 MCP 测试，且直接走 node argv', () => {
  const block = jobBlock('adapter-and-mcp');
  const gated = block
    .split('\n')
    .filter((line) => line.startsWith('      - run: ') && !line.startsWith('      - run: npm test'))
    .join('\n');
  assert.match(gated, /node --import tsx --test .*--test-skip-pattern=.*"adapters\/pi\/src\/\*\.spec\.ts"/, '适配器测试要排除真实 DNS 用例后必过');
  assert.match(gated, /node node_modules\/typescript\/bin\/tsc -p l3-mcp-server\/tsconfig\.json/);
  assert.match(gated, /node node_modules\/vitest\/vitest\.mjs run --root l3-mcp-server/);
});

test('真实 DNS 用例单独一步、只显示不挡合并', () => {
  const block = jobBlock('adapter-and-mcp');
  const step = block.split('\n').find((line) => line.includes('--test-name-pattern='));
  assert.ok(step, '缺少 DNS 探测步骤');
  assert.match(step!, /--test-name-pattern="DNS 解析不了"/);
  assert.match(step!, /adapters\/pi\/src\/failure-classify\.integration\.spec\.ts/);
  const index = block.split('\n').indexOf(step!);
  assert.match(block.split('\n')[index - 1], /^ {6}- continue-on-error: true$/, 'DNS 探测必须带 continue-on-error，且只作用于这一步');
});

test('Windows 仍是必过平台，Linux / macOS 的实验策略不变', () => {
  const block = jobBlock('platform');
  assert.match(block, /os: \[windows-latest, ubuntu-latest, macos-latest\]/);
  assert.match(block, /^ {4}continue-on-error: \$\{\{ matrix\.os != 'windows-latest' \}\}$/m);
});
