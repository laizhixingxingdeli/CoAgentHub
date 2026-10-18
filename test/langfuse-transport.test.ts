// scripts/langfuse-transport.mjs 的两条综合验收：
// 1) 本地临时 server 抓真实 wire，验证关闭默认、稳定 ID、v4 OTLP 结构与 header、
//    score 确认判定、内容默认关闭/脱敏/截断顺序；
// 2) 故障/挂起 server，验证队列与 flush 有界、promise 从不 reject、失败不确认、无敏感日志。
// 不连真实 Langfuse，不读任何真实凭据：配置一律是临时目录里的 fixture。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  captureValue,
  createTransport,
  loadConfig,
  stableEventId,
  stableIds,
} from '../scripts/langfuse-transport.mjs';

const SECRET_KEY = 'sk-lf-0123456789abcdef'; // 只作为被脱敏的哨兵，不对应任何真实凭据
const RUN_TOKEN = 'RUNTOKEN-SENTINEL-abcdef123456';
const PASSWORD = 'hunter2-SENTINEL';
const PROXY_CRED = 'proxyuser:proxypass-SENTINEL';
// 不带 sk-/Bearer 前缀的合成哨兵：前缀规则认不出来，只能按字段名识别。
// 键名故意混用 camelCase / snake_case，覆盖 `api-key`/`API_KEY` 这类写法差异。
const STRINGIFIED_TOOL_OUTPUT = {
  command: 'ls -la',
  apiKey: 'GK-9f8e7d6c5b4a',
  password: 'PW-Q1w2E3r4T5y6',
  run_token: 'RT-Z9x8C7v6B5n4M',
  authConfig: { scheme: 'basic', value: 'AUTHCFG-M4n3B2v1C0x9' },
  // 代理地址没有 userinfo：地址本身也不能留。
  proxy: 'http://10.23.45.67:7890',
};
const STRINGIFIED_SENTINELS = [
  'GK-9f8e7d6c5b4a',
  'PW-Q1w2E3r4T5y6',
  'RT-Z9x8C7v6B5n4M',
  'AUTHCFG-M4n3B2v1C0x9',
  '10.23.45.67:7890',
];
const toolOutputText = JSON.stringify(STRINGIFIED_TOOL_OUTPUT);

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function startServer(handler) {
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    readJsonBody(req)
      .then((text) => handler(req, text, seen, res))
      .catch(() => {
        res.writeHead(500).end('{}');
      });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    async close() {
      // 挂起的 socket 不销毁的话 server.close() 永远等不到 idle，测试会卡死。
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function withFixture(dir, settings, name = 'langfuse.json') {
  const file = join(dir, name);
  await writeFile(file, JSON.stringify(settings));
  return file;
}

test('writes v4 OTLP spans and confirmed ingestion scores to a local endpoint, with stable ids and sanitized content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'langfuse-transport-'));
  const logged = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logged.push(args.join(' '));
  console.error = (...args) => logged.push(args.join(' '));
  const server = await startServer((req, text, seen, res) => {
    seen.push({ url: req.url, headers: req.headers, body: text });
    if (req.url === '/api/public/otel/v1/traces') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"partialSuccess":{}}');
      return;
    }
    const parsed = JSON.parse(text || '{}');
    const id = parsed.batch?.[0]?.id;
    // 按 score 名字模拟三种回执：正常确认、207 带逐项错误、2xx 但没本 event 的成功项。
    const name = parsed.batch?.[0]?.body?.name;
    if (name === 'rejected') {
      res.writeHead(207, { 'content-type': 'application/json' })
        .end(JSON.stringify({ successes: [], errors: [{ id, status: 400, message: 'invalid' }] }));
      return;
    }
    if (name === 'unacked') {
      res.writeHead(202, { 'content-type': 'application/json' })
        .end(JSON.stringify({ successes: [{ id: 'someone-else', status: 201 }], errors: [] }));
      return;
    }
    res.writeHead(207, { 'content-type': 'application/json' })
      .end(JSON.stringify({ successes: [{ id, status: 201 }], errors: [] }));
  });
  try {
    const config = await loadConfig({
      path: await withFixture(dir, {
        enabled: true,
        baseUrl: server.baseUrl,
        publicKey: 'pk-lf-test',
        secretKey: SECRET_KEY,
        captureContent: false,
        maxContentChars: 10,
        requestTimeoutMs: 2000,
        maxQueueSize: 5,
        flushTimeoutMs: 2000,
      }),
    });
    assert.equal(config.enabled, true);
    assert.equal(config.captureContent, false);
    assert.equal(config.maxContentChars, 10);

    // 无文件 / 坏配置 / 未 enabled / 非回环或带凭据的 baseUrl：一律关闭，且不回显内容。
    assert.equal((await loadConfig({ path: join(dir, 'nope.json') })).enabled, false);
    await writeFile(join(dir, 'bad.json'), `{ "enabled": true, "secretKey": ${JSON.stringify(SECRET_KEY)}`);
    assert.equal((await loadConfig({ path: join(dir, 'bad.json') })).enabled, false);
    for (const [index, baseUrl] of [
      `https://langfuse.example.com`,
      `http://user:${PROXY_CRED}@127.0.0.1:3300`,
      `http://127.0.0.1:3300/?key=${SECRET_KEY}`,
      `http://127.0.0.1:3300/a/%2E%2E%2Fadmin`,
    ].entries()) {
      const unsafe = await loadConfig({
        path: await withFixture(
          dir,
          { enabled: true, baseUrl, publicKey: 'pk', secretKey: 'sk-x' },
          `unsafe-${index}.json`,
        ),
      });
      assert.equal(unsafe.enabled, false, baseUrl);
    }
    assert.equal((await loadConfig({ path: join(dir, 'langfuse.json') })).enabled, true);

    // 稳定 ID：确定性、attempt 隔离、命名空间数组哈希不撞简单拼接。
    const mission = stableIds({ missionId: 'W-718' });
    const again = stableIds({ missionId: 'W-718' });
    const attemptA = stableIds({ missionId: 'W-718', attemptId: 'a1', callIndex: 0, eventKey: 'tool' });
    const attemptB = stableIds({ missionId: 'W-718', attemptId: 'a2', callIndex: 0, eventKey: 'tool' });
    assert.deepEqual(mission, again);
    assert.match(mission.traceId, /^[0-9a-f]{32}$/);
    assert.match(mission.spanId, /^[0-9a-f]{16}$/);
    assert.notEqual(mission.traceId, attemptA.traceId);
    assert.notEqual(attemptA.traceId, attemptB.traceId);
    assert.notEqual(attemptA.spanId, attemptB.spanId);
    assert.notEqual(stableEventId(['ab', 'c']), stableEventId(['a', 'bc']));
    assert.match(stableEventId(['score', mission.traceId]), /^[0-9a-f]{64}$/);

    const transport = createTransport(config);
    const ids = stableIds({ missionId: 'W-718', attemptId: 'a1', callIndex: 1, eventKey: 'agent_end' });
    const spanOk = await transport.enqueueSpan({
      traceId: ids.traceId,
      spanId: ids.spanId,
      name: 'coagent.attempt',
      startTimeUnixNano: '1750000000000000000',
      endTimeUnixNano: '1750000001000000000',
      attributes: [
        { key: 'agent.attempt', value: { intValue: 42 } },
        { key: 'authorization', value: { stringValue: `Bearer ${RUN_TOKEN}` } },
        { key: 'tool.args', value: { stringValue: `{"apiKey":"${SECRET_KEY}","proxy":"http://${PROXY_CRED}@127.0.0.1:8080"}` } },
        // 工具结果是字符串化 JSON 时，凭据是任意取值：靠前缀规则一定漏。
        { key: 'tool.output', value: { stringValue: toolOutputText } },
        { key: 'session.id', value: { stringValue: 'W-718' } },
      ],
    });
    assert.equal(spanOk, true);
    const scoreOk = await transport.enqueueScore({
      traceId: ids.traceId,
      name: 'quality.pass',
      value: 1,
      dataType: 'NUMERIC',
      comment: 'ok',
      attemptId: 'a1',
    });
    const scoreRejected = await transport.enqueueScore({ traceId: ids.traceId, name: 'rejected', value: 0 });
    const scoreUnacked = await transport.enqueueScore({ traceId: ids.traceId, name: 'unacked', value: 0 });
    assert.equal(await scoreOk, true);
    // 207 带 errors、2xx 但缺本 event 的 success：都不算被确认。
    assert.equal(await scoreRejected, false);
    assert.equal(await scoreUnacked, false);
    assert.equal(await transport.flush(), true);

    const otlp = server.seen.filter((entry) => entry.url === '/api/public/otel/v1/traces');
    const ingestion = server.seen.filter((entry) => entry.url === '/api/public/ingestion');
    assert.equal(otlp.length, 1);
    assert.equal(ingestion.length, 3);
    for (const entry of [...otlp, ...ingestion]) {
      assert.equal(entry.headers['x-langfuse-ingestion-version'], '4');
      assert.equal(
        entry.headers.authorization,
        `Basic ${Buffer.from(`pk-lf-test:${SECRET_KEY}`).toString('base64')}`,
      );
    }
    const otlpBody = JSON.parse(otlp[0].body);
    const span = otlpBody.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.traceId, ids.traceId);
    assert.equal(span.spanId, ids.spanId);
    assert.equal(span.name, 'coagent.attempt');
    assert.equal(span.startTimeUnixNano, '1750000000000000000');
    // OTLP 整数/ID 类型不能被脱敏环节改掉。
    const attemptAttr = span.attributes.find((attr) => attr.key === 'agent.attempt');
    assert.equal(typeof attemptAttr.value.intValue, 'number');
    assert.equal(attemptAttr.value.intValue, 42);
    const authAttr = span.attributes.find((attr) => attr.key === 'authorization');
    assert.equal(authAttr.value.stringValue.includes(RUN_TOKEN), false);
    const toolAttr = span.attributes.find((attr) => attr.key === 'tool.args');
    const toolText = toolAttr.value.stringValue;
    assert.equal(toolText.includes(SECRET_KEY), false);
    assert.equal(toolText.includes('proxypass-SENTINEL'), false);
    // 最终 wire 上的字符串化工具输出：非 sk-/Bearer 形状的也需要做靠字段名脱敏。
    const outputText = span.attributes.find((attr) => attr.key === 'tool.output').value.stringValue;
    for (const sentinel of STRINGIFIED_SENTINELS) {
      assert.equal(outputText.includes(sentinel), false, sentinel);
    }
    // 脱敏不能把整段正文一并吃掉：无关字段必须还在，否则复核内容不可用。
    assert.equal(outputText.includes('ls -la'), true);
    for (const entry of server.seen) {
      assert.equal(entry.body.includes(SECRET_KEY), false, entry.url);
      assert.equal(entry.body.includes(RUN_TOKEN), false, entry.url);
      assert.equal(entry.body.includes(PASSWORD), false, entry.url);
      for (const sentinel of STRINGIFIED_SENTINELS) {
        assert.equal(entry.body.includes(sentinel), false, `${sentinel} @ ${entry.url}`);
      }
    }
    const scoreBody = JSON.parse(ingestion[0].body);
    assert.equal(scoreBody.batch[0].type, 'score-create');
    assert.equal(scoreBody.batch[0].body.traceId, ids.traceId);
    assert.equal(scoreBody.batch[0].body.name, 'quality.pass');
    assert.equal(scoreBody.batch[0].body.dataType, 'NUMERIC');
    assert.equal(scoreBody.batch[0].body.comment, 'ok');
    assert.equal(typeof scoreBody.batch[0].id, 'string');
    // 同一 score 重投必须复用同一个 event id，否则 Langfuse 会收成两条。
    const repeated = await createTransport(config).enqueueScore({ traceId: ids.traceId, name: 'quality.pass', value: 1, attemptId: 'a1' });
    assert.equal(await repeated, true);
    const repeatedBody = JSON.parse(server.seen.at(-1).body);
    assert.equal(repeatedBody.batch[0].id, scoreBody.batch[0].id);

    // 内容采集：默认关闭时只有 missing/truncated 事实，不含正文。
    const closed = captureValue({ prompt: 'hello', apiKey: SECRET_KEY }, config);
    assert.equal('value' in closed, false);
    assert.equal(closed.missing, false);
    assert.equal(captureValue(undefined, config).missing, true);
    assert.equal(captureValue(null, config).missing, true);

    const captureConfig = { ...config, captureContent: true, maxContentChars: 6 };
    const truncated = captureValue({ nested: { header: `Authorization: Bearer ${RUN_TOKEN}` } }, captureConfig);
    // 先脱敏再截断：截断点切在凭据中间时，泄露出去的就是半个凭据。
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.value.length, 6);
    const full = captureValue(
      {
        tool: { input: { header: `Authorization: Basic ${SECRET_KEY}`, nested: { tail: 'kept' } } },
        proxy: `http://${PROXY_CRED}@127.0.0.1:8080`,
        runToken: RUN_TOKEN,
        list: [`key=${SECRET_KEY}`],
        toolOutput: toolOutputText,
      },
      { ...config, captureContent: true, maxContentChars: 5000 },
    );
    assert.equal(full.truncated, false);
    assert.equal(full.missing, false);
    for (const sentinel of [SECRET_KEY, RUN_TOKEN, PASSWORD, 'proxypass-SENTINEL', ...STRINGIFIED_SENTINELS]) {
      assert.equal(full.value.includes(sentinel), false, sentinel);
    }
    // 无关字段保留下来，才能确认脱敏不是把内容整个吐掉。
    assert.equal(full.value.includes('ls -la'), true);

    // 协调者复现的形状：只有字符串化 JSON 时，采集结果与最终 wire 都不能带凭据。
    const stringified = captureValue(
      { toolOutput: toolOutputText },
      { ...config, captureContent: true, maxContentChars: 2000 },
    );
    assert.equal(stringified.truncated, false);
    assert.equal(stringified.missing, false);
    assert.equal(typeof stringified.value, 'string');
    for (const sentinel of STRINGIFIED_SENTINELS) {
      assert.equal(stringified.value.includes(sentinel), false, sentinel);
    }
    assert.equal(stringified.value.includes('[REDACTED]'), true);
    assert.equal(stringified.value.includes('ls -la'), true);
    // 循环引用不抛异常，仍然给出行界标记。
    const circular = { name: 'loop' };
    circular.self = circular;
    const looped = captureValue(circular, { ...config, captureContent: true, maxContentChars: 5000 });
    assert.equal(looped.missing, false);
    assert.equal(typeof looped.value, 'string');

    assert.deepEqual(logged, []);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('keeps queue, timeouts and flush bounded, never rejects, and never logs when the endpoint stalls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'langfuse-transport-fail-'));
  const logged = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = (...args) => logged.push(args.join(' '));
  console.error = (...args) => logged.push(args.join(' '));
  console.warn = (...args) => logged.push(args.join(' '));
  const stalled = await startServer(() => {
    // 故意不回包：模拟对端挂起。
  });
  let refusedBaseUrl;
  try {
    // 关闭时完全无网络：同一个 server 上不应看到任何请求。
    const offTransport = createTransport(await loadConfig({ path: join(dir, 'absent.json') }));
    assert.equal(await offTransport.enqueueSpan({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'x' }), false);
    assert.equal(await offTransport.enqueueScore({ traceId: 'a'.repeat(32), name: 'x', value: 1 }), false);
    assert.equal(await offTransport.flush(), false);
    assert.equal(stalled.seen.length, 0);

    const hanging = createTransport({
      enabled: true,
      baseUrl: stalled.baseUrl,
      publicKey: 'pk',
      secretKey: SECRET_KEY,
      captureContent: false,
      maxContentChars: 100,
      requestTimeoutMs: 60_000,
      maxQueueSize: 2,
      flushTimeoutMs: 300,
    });
    const inflight = [
      hanging.enqueueSpan({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'one' }),
      hanging.enqueueScore({ traceId: 'a'.repeat(32), name: 'two', value: 1 }),
    ];
    // 队列 + 在途合计到上界后立刻丢弃，返回 false 而不是无限堆积。
    assert.equal(await hanging.enqueueSpan({ traceId: 'a'.repeat(32), spanId: 'c'.repeat(16), name: 'three' }), false);
    assert.equal(await hanging.flush(), false);
    assert.deepEqual(await Promise.all(inflight), [false, false]);

    // 端口没人监听：连接错误按未确认结算，不抛出。
    const probe = await startServer(() => {});
    refusedBaseUrl = probe.baseUrl;
    await probe.close();
    const broken = createTransport({
      enabled: true,
      baseUrl: refusedBaseUrl,
      publicKey: 'pk',
      secretKey: SECRET_KEY,
      requestTimeoutMs: 500,
      flushTimeoutMs: 1000,
    });
    assert.equal(await broken.enqueueSpan({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'boom' }), false);
    assert.equal(await broken.flush(), true);

    // 请求超时也要结算成 false：server 收到但永不回包。
    const slow = createTransport({
      enabled: true,
      baseUrl: stalled.baseUrl,
      publicKey: 'pk',
      secretKey: SECRET_KEY,
      requestTimeoutMs: 150,
      flushTimeoutMs: 1000,
    });
    assert.equal(await slow.enqueueSpan({ traceId: 'a'.repeat(32), spanId: 'd'.repeat(16), name: 'slow' }), false);

    // 5xx 与畸形回执都不确认。
    const rejecting = await startServer((req, text, seen, res) => {
      seen.push({ url: req.url, headers: req.headers, body: text });
      if (req.url === '/api/public/otel/v1/traces') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"partialSuccess":{"rejectedSpans":1}}');
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json' }).end('{"errors":[{"message":"boom"}]}');
    });
    try {
      const partial = createTransport({
        enabled: true,
        baseUrl: rejecting.baseUrl,
        publicKey: 'pk',
        secretKey: SECRET_KEY,
        requestTimeoutMs: 1000,
        flushTimeoutMs: 2000,
      });
      assert.equal(await partial.enqueueSpan({ traceId: 'a'.repeat(32), spanId: 'e'.repeat(16), name: 'partial' }), false);
      assert.equal(await partial.enqueueScore({ traceId: 'a'.repeat(32), name: 'err', value: 0 }), false);
      assert.equal(await partial.flush(), true);
    } finally {
      await rejecting.close();
    }

    for (const line of logged) {
      for (const sentinel of [SECRET_KEY, RUN_TOKEN, PASSWORD, 'pk-lf-test']) {
        assert.equal(line.includes(sentinel), false, line);
      }
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    await stalled.close();
    await rm(dir, { recursive: true, force: true });
  }
});
