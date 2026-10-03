import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('HTTP API 文档覆盖当前静态路由、参数路由和 agent 工具入口', () => {
  const source = readFileSync(new URL('../src/api/server.ts', import.meta.url), 'utf8');
  const doc = readFileSync(new URL('../docs/http-api.md', import.meta.url), 'utf8');
  const documented = new Set([...doc.matchAll(/^### (?:GET|POST|PUT|PATCH|DELETE) (\/api\/[^\s]+)/gm)]
    .map((match) => match[1].replace(/:[\w]+/g, ':id')));
  const routes = [...source.matchAll(/path === '(\/api\/[^']+)'/g)].map((match) => match[1]);
  for (const match of source.matchAll(/const \w+Match = \/\^(.*?)\$\/\s*\.exec\(path\)/g)) {
    const path = match[1].replaceAll('\\/', '/').replaceAll('([^/]+)', ':id').replaceAll('(.+)', ':id');
    const alternatives = /\(([^()]+\|[^()]+)\)/.exec(path);
    if (alternatives) routes.push(...alternatives[1].split('|').map((part) => path.replace(alternatives[0], part)));
    else routes.push(path);
  }
  for (const match of source.matchAll(/async (coagent_\w+)\(run/g)) routes.push(`/api/agent/${match[1]}`);
  assert.ok(routes.length > 50, '不能因提取规则失效而得到空覆盖');
  for (const route of routes) assert.ok(documented.has(route), `缺少路由文档 ${route}`);
});
