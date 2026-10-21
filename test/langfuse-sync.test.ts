// scripts/langfuse-sync.mjs 的两条综合验收（W-722）：
// 1) 用临时平台 + 临时 Langfuse：完整 lastReview 的 L2 分只落受评 Attempt 的 trace、
//    历史 review 事件不产生 L2 分、第一次运行把已确认 id 记进进度、第二次相同输入零发送、
//    Langfuse 断连时新的未确认 id 不进 acked 而已捕获记录仍在；
// 2) 关闭时零请求、项目范围只取匹配的 Mission、请求路径里没有 Delivery 与运行状态文件、
//    项目范围共用一个进度文件时两个 Mission 的捕获记录不会被互相覆盖、
//    有界循环在 abort 后能结束并调用了 flush。
// 不连真实平台（3101）与真实 Langfuse（3300），不读任何真实配置或凭据：
// 平台数据取自 test/fixtures 的 synthetic fixture，密钥是临时目录里的合成值。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTransport, loadConfig, stableIds } from '../scripts/langfuse-transport.mjs';
import { runBounded, syncQualityOnce, defaultProgressPath } from '../scripts/langfuse-sync.mjs';

const FIXTURE = new URL('./fixtures/langfuse-quality-http.json', import.meta.url);
const MISSION_ID = 'M-q-synthetic';
// 只作为「有没有被发出去」的哨兵：临时配置里的合成值，不对应任何真实凭据。
const SECRET_KEY = 'sk-lf-0000000000000000-test';
const CONTROL_TOKEN = 'control-token-sentinel';

const SCRIPT = fileURLToPath(new URL('../scripts/langfuse-sync.mjs', import.meta.url));
const loadFixture = async () => JSON.parse(await readFile(FIXTURE, 'utf8'));

/**
 * 直接跑 CLI（不经 shell）。子进程环境原样透传，不额外塞任何东西；
 * 所有输入（配置、进度、平台地址）都从参数给，所以不依赖用户家目录里的真实配置。
 */
function runCli(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { timeout: 10000, windowsHide: true },
      (error, stdout, stderr) => {
        // 成功时 error 为 null，退出码就是 0：漏掉这一支会把「退 0」误判成未知。
        resolve({ code: error ? error.code : 0, stdout, stderr });
      },
    );
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 临时平台。只回答本测试用到的五个只读路径；其它一律 404，顺便证明同步器没有
 * 去碰 Delivery、/live、/diff 或运行状态文件。
 */
async function startPlatform(route) {
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    const path = parsed.pathname;
    seen.push({ method: req.method, path, url: req.url, headers: req.headers });
    // 路由拿到的 path 不带查询串，查询串单独给：分页参数是评审历史契约的一部分。
    const outcome = route(path, req.method, parsed.searchParams);
    if (!outcome) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    res.writeHead(outcome.status, { 'content-type': 'application/json' }).end(JSON.stringify(outcome.body));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    seen,
    async close() {
      // 挂起的 socket 不销毁的话 close() 永远等不到 idle。
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 临时 Langfuse：抓真实 wire（OTLP span 与 ingestion score），回执按 v4 形状确认。 */
async function startLangfuse() {
  const spans = [];
  const scores = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    readBody(req)
      .then((text) => {
        const parsed = JSON.parse(text || '{}');
        if (req.url === '/api/public/otel/v1/traces') {
          for (const resource of parsed.resourceSpans ?? []) {
            for (const scope of resource.scopeSpans ?? []) {
              for (const span of scope.spans ?? []) spans.push(span);
            }
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"partialSuccess":{}}');
          return;
        }
        const item = parsed.batch?.[0];
        if (item) scores.push(item.body);
        res
          .writeHead(207, { 'content-type': 'application/json' })
          .end(JSON.stringify({ successes: [{ id: item?.id, status: 201 }], errors: [] }));
      })
      .catch(() => res.writeHead(400).end('{}'));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    spans,
    scores,
    /** 用作「连不上」的目标：先听一个端口再关掉，端口就一定是关着的。 */
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 配置一律是临时目录里的合成值：绝不读 ~/.coagent 或 /src/.env。 */
async function configFor(dir, baseUrl, name) {
  const file = join(dir, name);
  await writeFile(
    file,
    JSON.stringify({
      enabled: true,
      baseUrl,
      publicKey: 'pk-lf-0000-test',
      secretKey: SECRET_KEY,
      captureContent: false,
      requestTimeoutMs: 2000,
      maxQueueSize: 200,
      flushTimeoutMs: 2000,
    }),
  );
  // 同时回文件路径：CLI 分支要用 --config 传同一个配置，而不是再写一份。
  return { config: await loadConfig({ path: file }), file };
}


const ALLOWED = [
  /^\/api\/missions$/,
  /^\/api\/missions\/[^/]+$/,
  /^\/api\/missions\/[^/]+\/activity$/,
  /^\/api\/missions\/[^/]+\/attempts\/[^/]+$/,
  /^\/api\/missions\/[^/]+\/validation-reports\/[^/]+$/,
  /^\/api\/missions\/[^/]+\/work-items\/[^/]+\/reviews$/,
];

/**
 * 白名单只是路径层。评审历史还允许带查询串，但只允许 cursor/limit 两个键、
 * 取值只能是数字：`?x=../../` 与 `?limit=100000` 都不该出现。
 */
const assertOnlyAllowedQuery = (seen) => {
  for (const entry of seen) {
    const query = entry.url?.split('?')[1];
    if (!query) continue;
    assert.match(entry.path, /\/work-items\/[^/]+\/reviews$/, `只有评审历史允许带查询串：${entry.path}`);
    for (const [key, value] of new URLSearchParams(query)) {
      assert.ok(['cursor', 'limit'].includes(key), `查询串只允许 cursor/limit：${key}`);
      assert.match(value, /^\d+$/, `查询串值只能是数字：${key}=${value}`);
      if (key === 'limit') {
        const limit = Number(value);
        assert.ok(limit >= 1 && limit <= 100, `limit 必须在 1..100：${limit}`);
      }
    }
  }
};

const assertOnlyAllowedPaths = (seen) => {
  for (const entry of seen) {
    assert.equal(entry.method, 'GET', `只允许 GET，实际 ${entry.method} ${entry.path}`);
    // 运行状态文件与 Delivery 不属于观测面：这两样一旦出现在路径里就是本单的失败。
    assert.doesNotMatch(entry.path, /\.coagent-state\.json|delivery|\/live$|\/diff$/i);
    assert.ok(ALLOWED.some((pattern) => pattern.test(entry.path)), `路径不在白名单：${entry.path}`);
  }
  assertOnlyAllowedQuery(seen);
};

test('syncs a mission once, skips confirmed ids on rerun, and never marks unconfirmed records as synced when langfuse is gone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'langfuse-sync-'));
  const fixture = await loadFixture();
  // 平台侧做成可追加的：第三轮模拟「平台上又多了一条验证事实」。
  const reports = JSON.parse(JSON.stringify(fixture.reports));
  let activity = JSON.parse(JSON.stringify(fixture.activity));
  const extraReport = { ...JSON.parse(JSON.stringify(reports['VR-1'])), id: 'VR-9', passed: false };
  const extraEvent = {
    ...JSON.parse(JSON.stringify(fixture.activity.find((event) => event.kind === 'validation.reported'))),
    messageId: 'synthetic-msg-vr-9',
    at: '2026-10-16T05:10:00.000Z',
    data: { reportId: 'VR-9', passed: false, submittedAttemptId: 'W-1.exec-1' },
  };

  const platform = await startPlatform((path) => {
    if (path === `/api/missions/${MISSION_ID}`) return { status: 200, body: fixture.mission };
    if (path === `/api/missions/${MISSION_ID}/activity`) return { status: 200, body: activity };
    const report = /^\/api\/missions\/[^/]+\/validation-reports\/([^/]+)$/.exec(path);
    if (report) {
      const body = reports[report[1]];
      return body ? { status: 200, body } : { status: 404, body: { error: 'missing' } };
    }
    const attempt = /^\/api\/missions\/[^/]+\/attempts\/([^/]+)$/.exec(path);
    if (attempt) {
      const body = fixture.attempts[attempt[1]];
      return body ? { status: 200, body } : { status: 404, body: { error: 'missing' } };
    }
    return null;
  });
  const langfuse = await startLangfuse();
  const { config } = await configFor(dir, langfuse.baseUrl, 'enabled.json');
  const progressPath = join(dir, 'progress', 'mission.json');
  const submittedTrace = stableIds({ missionId: MISSION_ID, attemptId: 'W-1.exec-1' }).traceId;
  const reviewerTrace = stableIds({ missionId: MISSION_ID, attemptId: 'coord-1' }).traceId;
  const missionTrace = stableIds({ missionId: MISSION_ID }).traceId;

  try {
    const first = await syncQualityOnce({
      config,
      platformUrl: platform.baseUrl,
      missionId: MISSION_ID,
      progressPath,
      controlToken: CONTROL_TOKEN,
    });
    assert.equal(first.ok, true);
    assert.equal(first.disabled, false);
    assert.ok(first.sent > 0, '第一次运行必须真的发出记录');
    assert.equal(first.unconfirmed, 0);
    assertOnlyAllowedPaths(platform.seen);
    // 控制面凭据只走 Authorization 头；带了 run token 就等于让平台把同步器当成某次执行。
    for (const entry of platform.seen) {
      assert.equal(entry.headers.authorization, `Bearer ${CONTROL_TOKEN}`);
      assert.equal(entry.headers['x-coagent-run'], undefined);
    }

    const l2 = langfuse.spans.filter((span) => span.name === 'coagent.l2.work_item_review');
    assert.equal(l2.length, 1);
    // 受评者而不是评审者：挂错 trace 在 Langfuse 里看起来一样正常，所以必须钉死。
    assert.equal(l2[0].traceId, submittedTrace);
    assert.notEqual(l2[0].traceId, reviewerTrace);
    assert.notEqual(l2[0].traceId, missionTrace);
    const l2Verdicts = langfuse.scores.filter((score) => score.name === 'coagent.l2.verdict');
    assert.equal(l2Verdicts.length, 1);
    assert.equal(l2Verdicts[0].traceId, submittedTrace);

    // 历史 review 事件照样导出，但只在 Mission trace 上做观察，一个 L2 分都不出。
    const history = langfuse.spans.filter((span) => span.name === 'coagent.review_history_event');
    assert.equal(history.length, 1);
    assert.equal(history[0].traceId, missionTrace);
    // 会话分组走 Langfuse v4 的 langfuse.session.id（span 级）：wire 上每条 span 都要带，
    // 值仍是 missionId；旧名 langfuse.trace.session_id 不会被 Langfuse 识别。
    const sessionOf = (span) =>
      span.attributes.find((entry) => entry.key === 'langfuse.session.id')?.value?.stringValue;
    assert.ok(langfuse.spans.length > 0, '本轮必须真的发出 span');
    for (const span of langfuse.spans) {
      assert.equal(sessionOf(span), MISSION_ID, span.name);
      assert.equal(
        span.attributes.some((entry) => entry.key === 'langfuse.trace.session_id'),
        false,
        span.name,
      );
    }
    assert.equal(langfuse.scores.some((score) => score.name.startsWith('coagent.l3.') && score.traceId !== missionTrace), false);
    // L3 属于 Mission 层，不能被拆到 Attempt trace 上。
    for (const score of langfuse.scores) {
      if (score.name.startsWith('coagent.l3.')) assert.equal(score.traceId, missionTrace);
    }

    const afterFirst = JSON.parse(await readFile(progressPath, 'utf8'));
    assert.equal(afterFirst.version, 1);
    assert.ok(afterFirst.acked.length > 0, '已确认的 id 必须落进进度');
    assert.ok(afterFirst.capturedReviews.length > 0, '已捕获的完整记录必须落进进度');

    const spanCountAfterFirst = langfuse.spans.length;
    const scoreCountAfterFirst = langfuse.scores.length;
    const second = await syncQualityOnce({
      config,
      platformUrl: platform.baseUrl,
      missionId: MISSION_ID,
      progressPath,
      controlToken: CONTROL_TOKEN,
    });
    assert.equal(second.sent, 0, '相同输入的第二次运行必须零发送');
    assert.ok(second.skipped > 0);
    assert.equal(langfuse.spans.length, spanCountAfterFirst);
    assert.equal(langfuse.scores.length, scoreCountAfterFirst);

    // 平台多出一条验证事实，Langfuse 这时已经连不上：新的 id 只能算未确认。
    activity = [...activity, extraEvent];
    reports['VR-9'] = extraReport;
    await new Promise((resolve) => {
      langfuse
        .close()
        .then(resolve)
        .catch(() => resolve());
    });
    const { config: deadConfig } = await configFor(dir, `http://127.0.0.1:${langfuse.port}`, 'dead.json');
    const third = await syncQualityOnce({
      config: deadConfig,
      platformUrl: platform.baseUrl,
      missionId: MISSION_ID,
      progressPath,
      controlToken: CONTROL_TOKEN,
    });
    assert.ok(third.unconfirmed > 0, '断连时必须有未确认记录');
    assert.equal(third.sent, 0);

    const afterThird = JSON.parse(await readFile(progressPath, 'utf8'));
    // 关键：没有任何未确认 id 混进 acked。
    assert.deepEqual(afterThird.acked, afterFirst.acked);
    // 已捕获的完整记录仍然在，下一轮还能用它们继续投影。
    assert.deepEqual(afterThird.capturedReviews, afterFirst.capturedReviews);
    assert.ok(afterThird.capturedReviews.length > 0);

    // 捕获与确认分离的最强证据：从头就断连时，进度里一个 acked 都没有，但已捕获的
    // 完整记录仍然落盘了——这正是「断连不丢捕获，也不冒充已发送」。
    const freshProgress = join(dir, 'progress', 'dead-from-start.json');
    const coldStart = await syncQualityOnce({
      config: deadConfig,
      platformUrl: platform.baseUrl,
      missionId: MISSION_ID,
      progressPath: freshProgress,
      controlToken: CONTROL_TOKEN,
    });
    assert.ok(coldStart.unconfirmed > 0);
    const coldProgress = JSON.parse(await readFile(freshProgress, 'utf8'));
    assert.deepEqual(coldProgress.acked, [], '没有确认就不能写 acked');
    assert.ok(coldProgress.capturedReviews.length > 0, '捕获必须早于发送落盘');

    // CLI 入口本身也走一遍真实 HTTP：Langfuse 连不上时退 1，stdout 只有计数与 missionId。
    const cliConfig = await configFor(dir, `http://127.0.0.1:${langfuse.port}`, 'dead-cli.json');
    const cli = await runCli([
      '--config',
      cliConfig.file,
      '--mission',
      MISSION_ID,
      '--once',
      '--platform-url',
      platform.baseUrl,
      '--progress',
      join(dir, 'progress', 'cli.json'),
    ]);
    assert.equal(cli.code, 1, '有未确认记录时 CLI 必须退 1');
    assert.match(cli.stdout, /mission M-q-synthetic .*unconfirmed=[1-9]/);
    // 只输出计数与 missionId：不打印密钥、不打印 Authorization、不打印评审正文。
    assert.doesNotMatch(`${cli.stdout}${cli.stderr}`, /sk-lf|Bearer |synthetic reason/i);
  } finally {
    await platform.close();
    await langfuse.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('stays silent when disabled, scopes project reads, and stops a bounded loop on abort with a flush', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'langfuse-sync-'));
  // 项目范围下两个匹配 Mission 各带一条完整 lastReview：它们共用同一个进度文件，
  // 所以这里能看出「写后一个 Mission 时有没有把前一个已捕获的记录清掉」。
  // 形状对齐 langfuse-quality-records 接受的 lastReview（submittedAttemptId/verdict/acceptanceResults）。
  const projectMissions = {
    'M-a1': {
      missionId: 'M-a1',
      projectId: 'p-a',
      workItems: [
        {
          id: 'W-a1',
          lastReview: {
            submittedAttemptId: 'W-a1.exec-1',
            verdict: 'accept',
            reasons: ['synthetic reason a1'],
            acceptanceResults: [{ criterion: 'synthetic criterion a1', status: 'pass', evidence: 'synthetic evidence a1' }],
          },
        },
      ],
    },
    'M-a2': {
      missionId: 'M-a2',
      projectId: 'p-a',
      workItems: [
        {
          id: 'W-a2',
          lastReview: {
            submittedAttemptId: 'W-a2.exec-1',
            verdict: 'reject',
            reasons: ['synthetic reason a2'],
            acceptanceResults: [{ criterion: 'synthetic criterion a2', status: 'fail', note: 'synthetic note a2' }],
          },
        },
      ],
    },
  };
  const platform = await startPlatform((path) => {
    if (path === '/api/missions') {
      return {
        status: 200,
        body: [
          { missionId: 'M-a1', projectId: 'p-a' },
          { missionId: 'M-a2', projectId: 'p-a' },
          { missionId: 'M-b1', projectId: 'p-b' },
        ],
      };
    }
    const mission = /^\/api\/missions\/([^/]+)$/.exec(path);
    if (mission) {
      const body = projectMissions[mission[1]];
      return body ? { status: 200, body } : { status: 404, body: { error: 'missing' } };
    }
    if (/^\/api\/missions\/[^/]+\/activity$/.test(path)) return { status: 200, body: [] };
    return null;
  });

  try {
    // 1) 关闭：不请求平台，不建传输，不写进度。
    const disabled = await loadConfig({ path: join(dir, 'absent.json') });
    assert.equal(disabled.enabled, false);
    const disabledProgress = join(dir, 'disabled-progress.json');
    let platformHits = 0;
    const enqueued = [];
    const stubTransport = {
      enqueueSpan: (span) => {
        enqueued.push(span);
        return Promise.resolve(true);
      },
      enqueueScore: (score) => {
        enqueued.push(score);
        return Promise.resolve(true);
      },
      flush: () => Promise.resolve(true),
    };
    const off = await syncQualityOnce({
      config: disabled,
      platformUrl: platform.baseUrl,
      missionId: 'M-a1',
      progressPath: disabledProgress,
      transport: stubTransport,
      fetchImpl: async () => {
        platformHits += 1;
        return { ok: true, status: 200, json: {} };
      },
    });
    assert.equal(off.disabled, true);
    assert.equal(platformHits, 0, '关闭时不得请求平台');
    assert.equal(enqueued.length, 0, '关闭时不得请求 Langfuse');
    await assert.rejects(() => readFile(disabledProgress, 'utf8'), '关闭时不得写进度');

    // 2) CLI 参数形状：scope 与运行模式都必须且只能有一个，且有界区间与轮数有上下界。
    //    参数错误必须在开连之前就退 2，所以这里不需要任何服务在听。
    const cli = await (async () => {
      const config = join(dir, 'cli-disabled.json');
      await writeFile(config, JSON.stringify({ enabled: false }));
      return { config, progress: join(dir, 'cli-progress.json') };
    })();
    const base = ['--config', cli.config, '--progress', cli.progress];
    for (const args of [
      [...base],
      [...base, '--mission', 'M-a1', '--project', 'p-a', '--once'],
      [...base, '--mission', 'M-a1'],
      [...base, '--mission', 'M-a1', '--once', '--interval-ms', '2000', '--iterations', '2'],
      [...base, '--mission', 'M-a1', '--interval-ms', '999', '--iterations', '2'],
      [...base, '--mission', 'M-a1', '--interval-ms', '2000', '--iterations', '51'],
      [...base, '--mission', 'M-a1', '--interval-ms', '2000'],
    ]) {
      const outcome = await runCli(args);
      assert.equal(outcome.code, 2, `参数错误必须退 2：${args.join(' ')}`);
      // 参数错误与关闭都不得把密钥或控制面 token 回显到输出里。
      assert.doesNotMatch(`${outcome.stdout}${outcome.stderr}`, /sk-lf|Bearer /);
    }
    // 关闭时退 0，stdout 只写 disabled。
    const disabledCli = await runCli([...base, '--mission', 'M-a1', '--once']);
    assert.equal(disabledCli.code, 0);
    assert.equal(disabledCli.stdout.trim(), 'langfuse disabled');
    // 默认进度路径在用户家目录下，不在仓库里（否则评审正文片段会被误提交）。
    const defaultPath = defaultProgressPath({ missionId: 'M-a1' });
    assert.match(defaultPath.replace(/\\/g, '/'), /\/\.coagent\/langfuse-progress\/mission-M-a1\.json$/);
    assert.doesNotMatch(defaultPath.replace(/\\/g, '/'), /coagenthub-v5/);

    // 3) 项目范围：只读匹配的 Mission，且请求路径里没有 Delivery / 运行状态文件。
    const langfuse = await startLangfuse();
    try {
      const { config } = await configFor(dir, langfuse.baseUrl, 'enabled.json');
      const progressPath = join(dir, 'progress', 'project.json');
      const project = await syncQualityOnce({
        config,
        platformUrl: platform.baseUrl,
        projectId: 'p-a',
        progressPath,
      });
      assert.equal(project.ok, true);
      assert.deepEqual([...project.missions].sort(), ['M-a1', 'M-a2']);
      assertOnlyAllowedPaths(platform.seen);
      const fetched = platform.seen.map((entry) => entry.path).filter((path) => path !== '/api/missions');
      // 每件工单先读评审历史（旧平台 404 就退回 lastReview），再读受评 Attempt 明细。
      assert.deepEqual([...new Set(fetched)].sort(), [
        '/api/missions/M-a1',
        '/api/missions/M-a1/activity',
        '/api/missions/M-a1/attempts/W-a1.exec-1',
        '/api/missions/M-a1/work-items/W-a1/reviews',
        '/api/missions/M-a2',
        '/api/missions/M-a2/activity',
        '/api/missions/M-a2/attempts/W-a2.exec-1',
        '/api/missions/M-a2/work-items/W-a2/reviews',
      ]);

      // 共用一份进度时，后同步的 Mission 不能把先同步那个的已捕获记录冲掉：
      // 冲掉之后它下一轮再也投影不出来，Langfuse 里就永久缺这条评审。
      const afterFirst = JSON.parse(await readFile(progressPath, 'utf8'));
      assert.deepEqual(
        afterFirst.capturedReviews.map((entry) => entry.missionId).sort(),
        ['M-a1', 'M-a2'],
        '项目范围共用一个进度文件时，两个 Mission 的捕获记录都必须留在进度里',
      );

      const projectAgain = await syncQualityOnce({
        config,
        platformUrl: platform.baseUrl,
        projectId: 'p-a',
        progressPath,
      });
      assert.equal(projectAgain.ok, true);
      const afterSecond = JSON.parse(await readFile(progressPath, 'utf8'));
      // 第二次同步同样是 M-a1 先写、M-a2 后写：这里断言的是后写那一步没删掉前一个 Mission 的记录。
      assert.deepEqual(afterSecond.capturedReviews.map((entry) => entry.missionId).sort(), ['M-a1', 'M-a2']);
      for (const entry of afterSecond.capturedReviews) {
        assert.equal(entry.complete, true, '进度里留的必须是能投影出分数的完整记录');
        assert.ok(entry.submittedAttemptId, '完整记录必须带受评 Attempt');
      }
      // 同一份记录不能因为「保留旧项 + 再拼当前项」被存两遍：那会让每轮同步都长一条。
      assert.equal(
        afterSecond.capturedReviews.length,
        afterFirst.capturedReviews.length,
        '重复同步不得复制同一份捕获记录',
      );
    } finally {
      await langfuse.close();
    }

    // 4) 有界循环：abort 之后不再开下一轮，并且退出前调用了 flush。
    let flushes = 0;
    let reads = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15);
    try {
      const results = await runBounded({
        iterations: 5,
        intervalMs: 20,
        signal: controller.signal,
        config: { enabled: true, baseUrl: platform.baseUrl, requestTimeoutMs: 500 },
        platformUrl: platform.baseUrl,
        missionId: 'M-a1',
        progressPath: join(dir, 'progress', 'bounded.json'),
        transport: {
          enqueueSpan: () => Promise.resolve(true),
          enqueueScore: () => Promise.resolve(true),
          flush: () => {
            flushes += 1;
            return Promise.resolve(true);
          },
        },
        fetchImpl: async () => {
          reads += 1;
          return { ok: true, status: 200, json: [] };
        },
      });
      assert.ok(results.length >= 1 && results.length < 5, '中断后必须提前结束，而不是跑满 5 轮');
      assert.ok(reads > 0);
    } finally {
      clearTimeout(timer);
    }
    // 每轮 syncQualityOnce 结束会 flush，runBounded 的 finally 再兜一次：
    // 至少说明信号处理没有把退出路径上的 flush 跳过。
    assert.ok(flushes >= 1, '中断路径也必须 flush');
  } finally {
    await platform.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 101 个 Mission 的整轮退出（本单要求「不按 50 截断」）：
 * - 按稳定 missionId 排序，每轮最多 50 个；
 * - 进度里记 lastMissionId，下一次从它后面继续，走到末尾绕回开头；
 * - 失败的 Mission 不推进游标，下一轮从同一处重来（不越过失败批次）。
 */
test('walks more than 50 project missions across bounded rounds instead of truncating, and never advances past a failed batch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'langfuse-sync-'));
  const total = 101;
  const ids = Array.from({ length: total }, (_, index) => `M-p${String(index + 1).padStart(3, '0')}`);
  // 平台故意用乱序返回：顺序不是契约，同步器必须自己按 id 稳定排序。
  const listed = [...ids].reverse().map((missionId) => ({ missionId, projectId: 'p-many' }));
  const visited = [];
  let failOn = null;
  const platform = await startPlatform((path) => {
    if (path === '/api/missions') return { status: 200, body: listed };
    const mission = /^\/api\/missions\/([^/]+)$/.exec(path);
    if (mission) {
      visited.push(mission[1]);
      if (mission[1] === failOn) return { status: 500, body: { error: 'boom' } };
      return {
        status: 200,
        body: {
          missionId: mission[1],
          projectId: 'p-many',
          workItems: [
            {
              id: 'W-1',
              lastReview: {
                verdict: 'accept',
                reasons: ['synthetic many reason'],
                requiredChanges: [],
                attemptId: 'coord-1',
                submittedAttemptId: 'W-1.exec-1',
                acceptanceResults: [{ criterion: 'synthetic many AC', status: 'pass' }],
              },
            },
          ],
        },
      };
    }
    if (/^\/api\/missions\/[^/]+\/activity$/.test(path)) return { status: 200, body: [] };
    if (/^\/api\/missions\/[^/]+\/work-items\/[^/]+\/reviews$/.test(path)) {
      // 旧平台形状：404 才允许退回 lastReview。
      return { status: 404, body: { error: 'not found' } };
    }
    if (/^\/api\/missions\/[^/]+\/attempts\/[^/]+$/.test(path)) {
      return { status: 404, body: { error: 'not found' } };
    }
    return null;
  });
  const langfuse = await startLangfuse();
  const progressPath = join(dir, 'progress', 'many.json');
  const stubTransport = {
    enqueueSpan: () => Promise.resolve(true),
    enqueueScore: () => Promise.resolve(true),
    flush: () => Promise.resolve(true),
  };
  try {
    const { config } = await configFor(dir, langfuse.baseUrl, 'many.json');
    const round1 = await syncQualityOnce({
      config,
      platformUrl: platform.baseUrl,
      projectId: 'p-many',
      progressPath,
      transport: stubTransport,
    });
    assert.equal(round1.ok, true);
    assert.equal(round1.truncated, undefined, '超过 50 个不再报截断');
    assert.equal(round1.missions.length, 50);
    assert.equal(round1.project.total, total);
    assert.equal(round1.project.pending, total - 50);
    assert.deepEqual(round1.missions, ids.slice(0, 50), '第一轮必须按稳定 id 顺序取前 50 个');
    assertOnlyAllowedPaths(platform.seen);

    const after1 = JSON.parse(await readFile(progressPath, 'utf8'));
    assert.equal(after1.projects['p-many'].lastMissionId, 'M-p050', '游标停在最后一个成功的 Mission');

    const round2 = await syncQualityOnce({
      config,
      platformUrl: platform.baseUrl,
      projectId: 'p-many',
      progressPath,
      transport: stubTransport,
    });
    assert.equal(round2.missions.length, 50);
    assert.deepEqual(round2.missions, ids.slice(50, 100), '第二轮从游标后面继续，不重头再来');

    const round3 = await syncQualityOnce({
      config,
      platformUrl: platform.baseUrl,
      projectId: 'p-many',
      progressPath,
      transport: stubTransport,
    });
    // 第三轮从末尾继续并绕回开头补齐到 50 个：这是「遍历末尾再回到开头」的落点。
    assert.equal(round3.missions.length, 50);
    assert.equal(round3.missions[0], 'M-p101');
    assert.equal(round3.missions[1], 'M-p001', '走到末尾必须绕回开头');
    assert.equal(round3.project.wrapped, true);

    // 三轮下来 101 个 Mission 全部经过，且每个都真的被读过。
    assert.deepEqual([...new Set(visited)].sort(), ids);
    assert.ok(visited.length >= total, '轮转不得漏掉任何一个 Mission');

    // 失败不推进游标：让下一轮的第一个（M-p050）失败，游标停在 M-p049。
    failOn = 'M-p050';
    const round4 = await syncQualityOnce({
      config,
      platformUrl: platform.baseUrl,
      projectId: 'p-many',
      progressPath,
      transport: stubTransport,
    });
    assert.equal(round4.ok, false, '读取失败必须让本轮未完成');
    const after4 = JSON.parse(await readFile(progressPath, 'utf8'));
    assert.equal(after4.projects['p-many'].lastMissionId, 'M-p049', '失败批次不得被跳过');
    failOn = null;
    const round5 = await syncQualityOnce({
      config,
      platformUrl: platform.baseUrl,
      projectId: 'p-many',
      progressPath,
      transport: stubTransport,
    });
    assert.equal(round5.ok, true);
    assert.equal(round5.missions[0], 'M-p050', '下一轮从失败的那个 Mission 重新开始');

    // 游标写失败也必须当场停住本批：用 now 在第 2 次调用上抛错，让**只有**
    // advanceProjectCursor 的那次写盘失败。这一轮里每条记录都已 acked，所以 syncMission
    // 只会写一次进度（捕获后那次，入队后那次因为零待发被跳过），第 2 次写盘就是游标。
    // 本批第一个 Mission（M-p100，round5 已经推进到 M-p099）之后不得再读后面的 Mission，
    // 盘上的游标留在上一次成功的位置。
    const visitedBeforeCursorFault = visited.length;
    let writeCalls = 0;
    const round6 = await syncQualityOnce({
      config,
      platformUrl: platform.baseUrl,
      projectId: 'p-many',
      progressPath,
      transport: stubTransport,
      now: () => {
        writeCalls += 1;
        if (writeCalls > 1) throw new Error('synthetic cursor write failure');
        return Date.now();
      },
    });
    assert.equal(writeCalls, 2, '故障注入必须真的落在游标写盘上');
    assert.equal(round6.ok, false, '游标写失败必须让本轮未完成');
    assert.equal(round6.missions.length, 1, '游标写失败后不得继续处理后续 Mission');
    assert.equal(round6.missions[0], 'M-p100');
    assert.equal(visited.length, visitedBeforeCursorFault + 1, '后续 Mission 一个都不该被读');
    assert.equal(round6.project.pending, total, '一个都没推进：剩下的都算没处理');
    const after6 = JSON.parse(await readFile(progressPath, 'utf8'));
    assert.equal(after6.projects['p-many'].lastMissionId, 'M-p099', '游标写失败不得前进');

    // 故障消失后从同一个 Mission 重来，证明「停下来」不是把这一批丢掉。
    const round7 = await syncQualityOnce({
      config,
      platformUrl: platform.baseUrl,
      projectId: 'p-many',
      progressPath,
      transport: stubTransport,
    });
    assert.equal(round7.ok, true);
    assert.equal(round7.missions[0], 'M-p100', '游标写失败的那个 Mission 下一轮重新开始');
    const after7 = JSON.parse(await readFile(progressPath, 'utf8'));
    assert.equal(
      after7.projects['p-many'].lastMissionId,
      round7.missions.at(-1),
      '故障恢复后照常按连续成功前缀推进',
    );
  } finally {
    await platform.close();
    await langfuse.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 评审历史（新接口）在同步层的两条硬要求：
 * 1) 同一工单两次评审分页都要准确落到各自的受评 Attempt 上，重跑不重复评分；
 * 2) 404 才退回 lastReview；错误分页要标 partial 并保留已捕获，且 cursor 留在原地。
 */
test('pages work-item review history onto the reviewed attempts, falls back only on 404, and reports partial on a failed page', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'langfuse-sync-'));
  const missionId = 'M-hist';
  const workItemId = 'W-h1';
  // 两条评审：受评 Attempt 不同（第二次是重交后的 exec-2）。
  const reviews = [
    {
      verdict: 'reject',
      reasons: ['synthetic history reject reason'],
      requiredChanges: ['synthetic history required change'],
      attemptId: 'coord-1',
      submittedAttemptId: 'W-h1.exec-1',
      acceptanceResults: [{ criterion: 'synthetic AC1', status: 'fail' }],
    },
    {
      verdict: 'accept',
      reasons: ['synthetic history accept reason'],
      requiredChanges: [],
      attemptId: 'coord-2',
      submittedAttemptId: 'W-h1.exec-2',
      acceptanceResults: [{ criterion: 'synthetic AC1', status: 'pass' }],
    },
  ];
  const mission = {
    missionId,
    projectId: 'p-hist',
    workItems: [
      {
        id: workItemId,
        // lastReview 就是第二条：历史与 lastReview 是同一事实，不能重复评分。
        lastReview: reviews[1],
      },
      { id: 'W-legacy', lastReview: { verdict: 'accept', reasons: ['synthetic legacy'], requiredChanges: [], attemptId: 'coord-3' } },
    ],
  };
  const pageSize = 1;
  let failNextPage = false;
  // 分页契约的两种故障：坏 nextCursor（本轮不算读完）与中间页 404（不是旧接口）。
  let pageFault = null;
  const requestedCursors = [];
  const platform = await startPlatform((path, method, params) => {
    if (path === `/api/missions/${missionId}`) return { status: 200, body: mission };
    if (path === `/api/missions/${missionId}/activity`) return { status: 200, body: [] };
    if (path === `/api/missions/${missionId}/work-items/${workItemId}/reviews`) {
      const cursor = Number(params.get('cursor') ?? 0);
      const limit = Number(params.get('limit') ?? 50);
      requestedCursors.push({ cursor, limit });
      if (failNextPage && cursor > 0) return { status: 500, body: { error: 'boom' } };
      if (pageFault?.status && cursor > 0) return { status: pageFault.status, body: { error: 'boom' } };
      const slice = reviews.slice(cursor, cursor + pageSize).map((review, index) => ({
        reviewId: JSON.stringify([missionId, workItemId, cursor + index]),
        reviewIndex: cursor + index,
        review,
      }));
      const next = cursor + slice.length < reviews.length ? cursor + slice.length : null;
      // 第一页故意给坏 cursor：缺失（undefined 会被 JSON 丢掉）、负数、回退、小数、字符串。
      if (pageFault && cursor === 0 && 'nextCursor' in pageFault) {
        return { status: 200, body: { items: slice, nextCursor: pageFault.nextCursor, total: reviews.length } };
      }
      return { status: 200, body: { items: slice, nextCursor: next, total: reviews.length } };
    }
    if (path === `/api/missions/${missionId}/work-items/W-legacy/reviews`) {
      return { status: 404, body: { error: 'not found' } };
    }
    const attempt = /^\/api\/missions\/[^/]+\/attempts\/([^/]+)$/.exec(path);
    if (attempt) return { status: 404, body: { error: 'not found' } };
    return null;
  });
  const langfuse = await startLangfuse();
  const progressPath = join(dir, 'progress', 'history.json');
  try {
    const { config } = await configFor(dir, langfuse.baseUrl, 'history.json');
    const first = await syncQualityOnce({
      config,
      platformUrl: platform.baseUrl,
      missionId,
      progressPath,
    });
    assert.equal(first.ok, true);
    assert.equal(first.partial, false, '没截断就不能标 partial');
    // 分页是真的：每次都用平台给的 nextCursor，limit 落在 1..100 内。
    assert.ok(requestedCursors.length >= 2, '两次评审必须分页读到');
    for (const entry of requestedCursors) {
      assert.ok(entry.limit >= 1 && entry.limit <= 100, `limit 越界：${entry.limit}`);
    }
    assertOnlyAllowedPaths(platform.seen);

    const l2 = langfuse.spans.filter((span) => span.name === 'coagent.l2.work_item_review');
    assert.equal(l2.length, 2, '两条评审各一份快照（lastReview 与历史同一条只算一份）');
    const traceOf = (submitted) => stableIds({ missionId, attemptId: submitted }).traceId;
    assert.deepEqual(
      l2.map((span) => span.traceId).sort(),
      [traceOf('W-h1.exec-1'), traceOf('W-h1.exec-2')].sort(),
      '每条评审都必须落在自己受评的 Attempt 上',
    );
    const verdicts = langfuse.scores.filter((score) => score.name === 'coagent.l2.verdict');
    assert.equal(verdicts.length, 2);
    assert.deepEqual(verdicts.map((score) => score.value).sort(), ['accept', 'reject']);
    // 旧平台工单：404 才退回 lastReview，而且因为缺受评者只出 unknown 观察，不出分。
    const unknown = langfuse.spans.filter((span) => span.name === 'coagent.mission_review_observation');
    assert.equal(unknown.length, 1);

    // 重跑：同一份历史零新增（稳定 ID 去重），进度里也不重复。
    const spanCount = langfuse.spans.length;
    const scoreCount = langfuse.scores.length;
    const second = await syncQualityOnce({
      config,
      platformUrl: platform.baseUrl,
      missionId,
      progressPath,
    });
    assert.equal(second.sent, 0, '重跑必须零发送');
    assert.equal(langfuse.spans.length, spanCount);
    assert.equal(langfuse.scores.length, scoreCount);
    const progressAfter = JSON.parse(await readFile(progressPath, 'utf8'));
    assert.equal(progressAfter.capturedReviews.length, 2, '两条完整快照，不因重跑增长');

    // 分页失败：显式 partial，保留已捕获，cursor 留在失败那一页，下一轮能接着读。
    const partialPath = join(dir, 'progress', 'history-partial.json');
    failNextPage = true;
    const failed = await syncQualityOnce({
      config,
      platformUrl: platform.baseUrl,
      missionId,
      progressPath: partialPath,
    });
    // 第一页成功、第二页 500：本轮未完成，并且 partial 是显式的事实。
    assert.equal(failed.ok, false, '分页失败必须让本轮未完成');
    assert.equal(failed.partial, true, '截断/失败必须显式标 partial');
    const partialProgress = JSON.parse(await readFile(partialPath, 'utf8'));
    assert.equal(partialProgress.reviewCursors[missionId][workItemId], 1, 'cursor 停在失败的那一页');
    assert.ok(partialProgress.capturedReviews.length >= 1, '已捕获的记录必须保留');
    failNextPage = false;
    const resumed = await syncQualityOnce({
      config,
      platformUrl: platform.baseUrl,
      missionId,
      progressPath: partialPath,
    });
    assert.equal(resumed.ok, true, '下一轮从失败的那一页继续后应当完整');
    const resumedProgress = JSON.parse(await readFile(partialPath, 'utf8'));
    assert.equal(resumedProgress.reviewCursors[missionId]?.[workItemId], undefined, '读完之后清掉游标');
    assert.equal(resumedProgress.capturedReviews.length, 2);

    // 坏 nextCursor（缺失/负数/回退/相同/小数/字符串）不等于「读完了」：本轮必须未完成、
    // 不能伪评分，已读条目与当前页起点都要保留，下一轮从同一处重试。
    for (const badCursor of [undefined, -1, 0, 0.5, '1']) {
      const badPath = join(dir, 'progress', `history-bad-${String(badCursor).replace(/[^\w]/g, '_')}.json`);
      pageFault = { nextCursor: badCursor };
      const spansBefore = langfuse.spans.length;
      const bad = await syncQualityOnce({
        config,
        platformUrl: platform.baseUrl,
        missionId,
        progressPath: badPath,
      });
      assert.equal(bad.ok, false, `坏 nextCursor 必须让本轮未完成：${String(badCursor)}`);
      assert.equal(bad.partial, true, `坏 nextCursor 必须显式标 partial：${String(badCursor)}`);
      const badProgress = JSON.parse(await readFile(badPath, 'utf8'));
      assert.equal(badProgress.reviewCursors[missionId][workItemId], 0, '坏 cursor 时停在当前页起点');
      assert.equal(
        badProgress.capturedReviews.filter((entry) => entry.workItemId === workItemId).length,
        1,
        '已读到的那一页要保留，但不能把没读到的当成读完了',
      );
      // 不伪评分：没读到的那条评审不得被凭空投影出来（它会落到 exec-2 的 trace 上）。
      const fresh = langfuse.spans.slice(spansBefore);
      assert.equal(
        fresh.filter((span) => span.traceId === traceOf('W-h1.exec-2')).length,
        0,
        `坏 cursor 不得为未读到的评审伪造投影：${String(badCursor)}`,
      );
      assert.deepEqual(
        [...new Set(langfuse.scores.filter((score) => score.name === 'coagent.l2.verdict').map((score) => score.value))].sort(),
        ['accept', 'reject'],
        '判定值集合不得出现凭空造出来的项',
      );
    }
    pageFault = null;

    // 中间页 404 是读取故障，不是旧接口：不能丢掉之前读到的 items 去退回 lastReview。
    const midPath = join(dir, 'progress', 'history-mid404.json');
    pageFault = { status: 404 };
    const mid = await syncQualityOnce({
      config,
      platformUrl: platform.baseUrl,
      missionId,
      progressPath: midPath,
    });
    assert.equal(mid.ok, false, '中间页 404 必须让本轮未完成');
    assert.equal(mid.partial, true);
    const midProgress = JSON.parse(await readFile(midPath, 'utf8'));
    assert.equal(midProgress.reviewCursors[missionId][workItemId], 1, '中间页 404 不推进 cursor');
    assert.equal(
      midProgress.capturedReviews.filter((entry) => entry.workItemId === workItemId).length,
      1,
      '中间页 404 不得丢掉已读到的评审',
    );
    pageFault = null;
    // 下一轮从中间页重试，读到全部两条。
    const afterMid = await syncQualityOnce({
      config,
      platformUrl: platform.baseUrl,
      missionId,
      progressPath: midPath,
    });
    assert.equal(afterMid.ok, true, '中间页 404 之后应当能从原处重试成功');
    const afterMidProgress = JSON.parse(await readFile(midPath, 'utf8'));
    assert.equal(afterMidProgress.reviewCursors[missionId]?.[workItemId], undefined);
    assert.equal(afterMidProgress.capturedReviews.length, 2);
  } finally {
    await platform.close();
    await langfuse.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

/** 同步调用方看得见的失败：不连传输、不启平台。注入的是 rename/等待，不是 CLI 开关。 */
const quietTransport = {
  enqueueSpan: async () => false,
  enqueueScore: async () => false,
  flush: async () => true,
};

function syntheticErrno(code) {
  const error = new Error(`synthetic rename ${code}`);
  error.code = code;
  return error;
}

function progressFetch(routes) {
  return async (url) => {
    const path = new URL(url).pathname;
    const body = routes[path];
    if (body === undefined) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: body };
  };
}

/**
 * 替换失败不得删旧目标：少量瞬态错误后走真实 rename，新内容落盘；
 * 耗尽或不可重试时旧字节不变、首次创建不留伪进度，等待有上界。
 * 为什么不把故障做成 CLI 开关：开关会跟着进真实同步，而这里要证的是库函数的替换约定。
 */
test('replaces progress after a few transient rename errors without deleting the previous file', { timeout: 8000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'langfuse-sync-'));
  const progressPath = join(dir, 'progress.json');
  const missionId = 'M-new';
  const prior = {
    version: 1,
    acked: ['prior-acked-id'],
    capturedReviews: [{ missionId: 'M-keep', marker: 'keep-me' }],
    projects: { 'p-cursor': { lastMissionId: 'M-old', wrapped: false } },
    reviewCursors: { 'M-keep': { 'W-keep': 3 } },
    note: 'must-not-survive-successful-replace',
  };
  const priorText = `${JSON.stringify(prior)}\n`;
  await writeFile(progressPath, priorText, 'utf8');
  let failures = 0;
  const waits = [];
  try {
    const result = await syncQualityOnce({
      config: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:9',
        publicKey: 'pk-lf-0000-test',
        secretKey: SECRET_KEY,
        captureContent: false,
        requestTimeoutMs: 2000,
      },
      platformUrl: 'http://127.0.0.1:9',
      missionId,
      progressPath,
      transport: quietTransport,
      fetchImpl: progressFetch({
        [`/api/missions/${missionId}`]: { missionId, projectId: 'p-cursor', workItems: [] },
        [`/api/missions/${missionId}/activity`]: [],
      }),
      renameFile: async (from, to) => {
        assert.equal(dirname(from), dirname(to), '临时文件必须与目标同目录');
        assert.notEqual(from, to);
        if (failures < 2) {
          failures += 1;
          assert.equal(await readFile(to, 'utf8'), priorText, '瞬态失败期间不得删掉旧进度');
          throw syntheticErrno(failures === 1 ? 'EPERM' : 'EBUSY');
        }
        await rename(from, to);
      },
      retryWait: async (ms) => {
        waits.push(ms);
      },
    });
    assert.equal(failures, 2, '必须真的遇到并走过瞬态 rename 失败');
    assert.equal(result.ok, true);
    assert.ok(waits.length >= 1 && waits.length <= 9, `等待次数必须有界：${waits.length}`);
    assert.ok(waits.every((ms) => Number.isFinite(ms) && ms > 0));
    assert.ok(waits.reduce((sum, ms) => sum + ms, 0) <= 2000);
    const after = JSON.parse(await readFile(progressPath, 'utf8'));
    assert.equal(after.version, 1);
    assert.deepEqual(after.acked, ['prior-acked-id']);
    assert.deepEqual(after.capturedReviews, [{ missionId: 'M-keep', marker: 'keep-me' }]);
    assert.deepEqual(after.projects, { 'p-cursor': { lastMissionId: 'M-old', wrapped: false } });
    assert.equal(after.reviewCursors['M-keep']['W-keep'], 3, '其它 Mission 的游标必须原样留在新快照里');
    assert.equal(after.note, undefined, '成功替换必须写入新快照，而不是留着旧文件假装成功');
    assert.deepEqual(
      Object.keys(after),
      ['version', 'acked', 'capturedReviews', 'projects', 'reviewCursors'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keeps old progress bytes when rename retries are exhausted or the error is not retryable', { timeout: 8000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'langfuse-sync-'));
  const progressPath = join(dir, 'progress.json');
  const missionId = 'M-new';
  const projectId = 'p-fail';
  const prior = {
    version: 1,
    acked: ['prior-acked-id'],
    capturedReviews: [{ missionId: 'M-keep', marker: 'keep-me' }],
    projects: { [projectId]: { lastMissionId: 'M-old', wrapped: false } },
    reviewCursors: { 'M-keep': { 'W-keep': 3 } },
  };
  const priorText = `${JSON.stringify(prior)}\n`;
  await writeFile(progressPath, priorText, 'utf8');
  const config = {
    enabled: true,
    baseUrl: 'http://127.0.0.1:9',
    publicKey: 'pk-lf-0000-test',
    secretKey: SECRET_KEY,
    captureContent: false,
    requestTimeoutMs: 2000,
  };
  const fetchImpl = progressFetch({
    '/api/missions': [{ missionId, projectId }],
    [`/api/missions/${missionId}`]: { missionId, projectId, workItems: [] },
    [`/api/missions/${missionId}/activity`]: [],
  });
  let renameCalls = 0;
  const waits = [];
  try {
    const started = Date.now();
    const exhausted = await syncQualityOnce({
      config,
      platformUrl: 'http://127.0.0.1:9',
      projectId,
      progressPath,
      transport: quietTransport,
      fetchImpl,
      renameFile: async () => {
        renameCalls += 1;
        throw syntheticErrno('EACCES');
      },
      retryWait: async (ms) => {
        waits.push(ms);
      },
    });
    const elapsed = Date.now() - started;
    assert.equal(exhausted.ok, false, '耗尽必须向同步调用方体现为失败');
    assert.equal(exhausted.progressWriteFailed, true);
    assert.equal(exhausted.sent, 0, 'acked 不得在写盘失败后假推进');
    assert.ok(renameCalls >= 2, '持续瞬态错误必须真的重试过');
    assert.ok(waits.length >= 1 && waits.length <= 9, `等待次数必须有界：${waits.length}`);
    assert.ok(waits.reduce((sum, ms) => sum + ms, 0) <= 2000);
    assert.ok(elapsed < 1500, `注入的等待不得再叠一段真实长等待：${elapsed}ms`);
    assert.equal(await readFile(progressPath, 'utf8'), priorText, '旧目标字节必须原样保留');
    const kept = JSON.parse(priorText);
    assert.deepEqual(kept.acked, ['prior-acked-id']);
    assert.equal(kept.projects[projectId].lastMissionId, 'M-old', '游标不得假推进');
    assert.deepEqual(kept.reviewCursors, prior.reviewCursors);
    assert.equal((await readdir(dir)).some((name) => name.endsWith('.tmp')), false, '失败后只能清本次临时文件');

    const freshPath = join(dir, 'fresh', 'progress.json');
    let freshWaits = 0;
    const fresh = await syncQualityOnce({
      config,
      platformUrl: 'http://127.0.0.1:9',
      missionId,
      progressPath: freshPath,
      transport: quietTransport,
      fetchImpl: progressFetch({
        [`/api/missions/${missionId}`]: { missionId, projectId, workItems: [] },
        [`/api/missions/${missionId}/activity`]: [],
      }),
      renameFile: async () => {
        throw syntheticErrno('ENOSPC');
      },
      retryWait: async () => {
        freshWaits += 1;
      },
    });
    assert.equal(fresh.ok, false);
    assert.equal(fresh.progressWriteFailed, true);
    assert.equal(fresh.sent, 0);
    assert.equal(freshWaits, 0, '不可重试错误不得进入等待');
    await assert.rejects(readFile(freshPath, 'utf8'), { code: 'ENOENT' });
    assert.equal((await readdir(dirname(freshPath))).some((name) => name.endsWith('.tmp')), false);
    assert.equal(await readFile(progressPath, 'utf8'), priorText, '清临时文件时不得碰旧目标');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
