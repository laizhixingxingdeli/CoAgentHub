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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    seen.push({ method: req.method, path, headers: req.headers });
    const outcome = route(path, req.method);
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
];

const assertOnlyAllowedPaths = (seen) => {
  for (const entry of seen) {
    assert.equal(entry.method, 'GET', `只允许 GET，实际 ${entry.method} ${entry.path}`);
    // 运行状态文件与 Delivery 不属于观测面：这两样一旦出现在路径里就是本单的失败。
    assert.doesNotMatch(entry.path, /\.coagent-state\.json|delivery|\/live$|\/diff$/i);
    assert.ok(ALLOWED.some((pattern) => pattern.test(entry.path)), `路径不在白名单：${entry.path}`);
  }
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
      assert.deepEqual([...new Set(fetched)].sort(), [
        '/api/missions/M-a1',
        '/api/missions/M-a1/activity',
        '/api/missions/M-a1/attempts/W-a1.exec-1',
        '/api/missions/M-a2',
        '/api/missions/M-a2/activity',
        '/api/missions/M-a2/attempts/W-a2.exec-1',
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
