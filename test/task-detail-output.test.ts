/**
 * 当前输出与历史 Attempt 的绑定投影（src/web/task-detail-output.js）。
 *
 * 只写三条：这一层最容易出的错都不报错也不崩——选中历史时把实时行也换掉、历史正文
 * 缺失时借实时行或任务累计用量顶上、拿任务级统计冒充单跳花费、已结束的环节还被说成
 * 「疑似停滞」、概要用别的 Attempt 的身份/范围/改派/费用冒充选中那一跳的。每条断言
 * 对应工单里的一句验收。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LEASE_TOLERANCE_MS, projectOutputBinding } from '../src/web/task-detail-output.js';

test('当前实时输出与历史选择各认各的 Attempt，历史缺失正文为未知且不借别的账', () => {
  const binding = projectOutputBinding({
    currentAttemptId: 'W-1.exec-2',
    selectedAttemptId: 'W-1.exec-1',
    nowIso: '2026-10-26T10:00:00.000Z',
    currentAttempt: {
      attemptId: 'W-1.exec-2',
      status: 'in_progress',
      heartbeatAt: '2026-10-26T09:59:50.000Z',
    },
    // 选中的历史这一跳详情没取到：正文与用量都只能「未知」。
    selectedAttempt: null,
    liveChunks: [
      { attemptId: 'W-1.exec-2', text: '当前' },
      { attemptId: 'W-1.exec-1', text: '旧行' },
    ],
    // 任务累计用量不能拿来冒充单跳用量。
    missionUsage: { cost: 9, quality: 'reported' },
    // 任务级的改动清单也不能挂到某一跳名下。
    missionDiff: ['src/a.js'],
    executionResult: { output: '任务级输出' },
  });

  // 选中历史不改变「实时输出属于谁」。
  assert.equal(binding.liveAttemptId, 'W-1.exec-2');
  assert.equal(binding.historyAttemptId, 'W-1.exec-1');
  // 只拼当前这一跳的行：上一跳的行混进来会被读成这一跳正在跑的内容。
  assert.equal(binding.liveText, '当前');

  assert.equal(binding.historyOutput.output, null);
  assert.ok(binding.historyOutput.note.includes('未知'));
  assert.equal(binding.historyUsage, null);
  // 没有按 Attempt 的文件清单就不给清单，不抄 missionDiff / executionResult。
  assert.equal(binding.historyFiles.files, null);

  // 容忍窗口与 reconcile 的租约一致，且是具名常量。
  assert.equal(LEASE_TOLERANCE_MS, 90000);
});

test('归属链齐全时文件页签列这一跳的真实路径，旧 Attempt / 旧修订 / 归属不全仍为未知', () => {
  // 现场（W-906.exec-1 / r2 / VR-639）：提交、修订、机器报告与 lastReview 四环都指向
  // 这一跳，文件清单就该是它自己报的那两条。内嵌夹具，不读仓库外的 JSON。
  const fileEvidence = {
    workItemId: 'W-906',
    attemptIds: ['W-906.exec-0', 'W-906.exec-1'],
    orderRevision: 'r2',
    changedFiles: ['src/web/app.js', 'test/web-task.test.ts'],
    reviewSubmittedAttemptId: 'W-906.exec-1',
    reportId: 'VR-639',
    events: [
      {
        kind: 'execution_result.submitted',
        workItemId: 'W-906',
        attemptId: 'W-906.exec-1',
        // 事件里的 changedFiles 是**数量**：把它当路径就是一串编造的文件名。
        data: { orderRevision: 'r2', changedFiles: 2 },
      },
      {
        kind: 'validation.reported',
        workItemId: 'W-906',
        attemptId: 'W-906.exec-1',
        data: { reportId: 'VR-639', submittedAttemptId: 'W-906.exec-1' },
      },
    ],
  };
  const bind = (selectedAttemptId: string, evidence: Record<string, unknown> | null) => projectOutputBinding({
    currentAttemptId: 'W-906.exec-1',
    selectedAttemptId,
    nowIso: '2026-10-26T10:00:00.000Z',
    currentAttempt: { attemptId: 'W-906.exec-1', status: 'succeeded' },
    selectedAttempt: { attemptId: selectedAttemptId, status: 'succeeded' },
    liveChunks: [],
    selectedWorkItem: {
      id: 'W-906',
      status: 'accepted',
      attemptIds: ['W-906.exec-0', 'W-906.exec-1'],
      order: { allowedScope: ['src/web/task-detail-page.js'] },
    },
    fileEvidence: evidence,
    // 任务级事实：一律不许出现在文件面板里。
    missionDiff: ['src/other.js'],
    executionResult: { changedFiles: ['src/stolen.js'] },
  }).historyFiles;

  const known = bind('W-906.exec-1', fileEvidence);
  assert.deepEqual(known.files, ['src/web/app.js', 'test/web-task.test.ts']);
  assert.equal(known.note, '');
  assert.equal(known.attemptId, 'W-906.exec-1');
  // 不编行数、不编正文：清单只有路径这一种字段。
  assert.equal('lineDelta' in known, false);
  assert.deepEqual(known.files, [...known.files]);
  assert.equal(known.files.includes('src/other.js'), false);
  assert.equal(known.files.includes('src/stolen.js'), false);

  // 点的是上一跳：提交、报告、lastReview 都指向 exec-1，清单留给谁都不对。
  const otherAttempt = bind('W-906.exec-0', fileEvidence);
  assert.equal(otherAttempt.files, null);
  assert.ok(otherAttempt.note.includes('该尝试没有单独的文件清单'));

  // 工单改过版：r2 的清单贴在 r3 这一跳下面就是别的版本的路径。
  const otherRevision = bind('W-906.exec-1', { ...fileEvidence, orderRevision: 'r3' });
  assert.equal(otherRevision.files, null);
  assert.ok(otherRevision.note.includes('该尝试没有单独的文件清单'));

  // 归属证据缺失（页面找不到唯一那张工单时就是 null）：未知，不退回任务级事实。
  const missing = bind('W-906.exec-1', null);
  assert.equal(missing.files, null);
  assert.ok(missing.note.includes('该尝试没有单独的文件清单'));

  // 只在 lastReview 一环缺失：整条链断在这里，同样是未知。
  const noReview = bind('W-906.exec-1', { ...fileEvidence, reviewSubmittedAttemptId: '' });
  assert.equal(noReview.files, null);
});

test('概要展示选中那一跳自己的身份、允许范围、费用质量与交回结果，缺失为未知且不借任务级事实', () => {
  const facts = projectOutputBinding({
    currentAttemptId: 'W-1.exec-13',
    selectedAttemptId: 'W-1.exec-13',
    nowIso: '2026-10-26T10:00:00.000Z',
    currentAttempt: { attemptId: 'W-1.exec-13', status: 'in_progress' },
    selectedAttempt: {
      attemptId: 'W-1.exec-13',
      kind: 'executor',
      status: 'succeeded',
      profile: {
        profileId: 'exec-codebuddy-cn-ds41-flash',
        facts: [
          { key: 'provider', value: 'codebuddy' },
          { key: 'model', value: 'deepseek-v4.1-flash' },
          { key: 'reasoning', value: 'medium' },
        ],
      },
      usage: { cost: 0, quality: 'reported' },
      output: '已完成',
    },
    selectedWorkItem: {
      id: 'W-1',
      status: 'dispatched',
      attemptIds: ['W-1.exec-12', 'W-1.exec-13'],
      order: { allowedScope: ['src/web/app.js', 'test/web-task.test.ts'] },
    },
    liveChunks: [],
    // 任务级的改动与累计用量不能被当成这一跳的。
    missionDiff: ['src/web/other.js'],
    missionUsage: { cost: 9, quality: 'reported' },
  }).facts;

  // 次数从 attemptId 的尾巴解析，不是写死的 13。
  assert.equal(facts.title, '执行第 13 次');
  assert.ok(facts.identity.includes('执行者'));
  assert.ok(facts.identity.includes('exec-codebuddy-cn-ds41-flash'));
  assert.ok(facts.identity.includes('codebuddy/deepseek-v4.1-flash'));
  assert.ok(facts.identity.includes('medium'));
  assert.deepEqual(facts.scope, ['src/web/app.js', 'test/web-task.test.ts']);
  // 报过 0 就是真的花了 $0.00：不是未知，也不能停在 `0 · reported` 两列原值上。
  assert.equal(facts.cost.quality, 'reported');
  assert.equal(facts.cost.text, '$0.00 · 上报');
  assert.equal(facts.result, '已交回');
  // 没有这一跳的改派事件就是未知，不编故事。
  assert.equal(facts.candidateChange, '未知');

  // 选中详情对不上 id：每一格都是未知，且绝不退回任务级事实。
  const mismatched = projectOutputBinding({
    currentAttemptId: 'W-1.exec-13',
    selectedAttemptId: 'W-1.exec-12',
    nowIso: '2026-10-26T10:00:00.000Z',
    currentAttempt: { attemptId: 'W-1.exec-13', status: 'in_progress' },
    selectedAttempt: { attemptId: 'W-1.exec-13', kind: 'executor', status: 'succeeded', usage: { cost: 0, quality: 'reported' } },
    selectedWorkItem: { id: 'W-1', attemptIds: ['W-1.exec-13'], order: { allowedScope: ['src/web/app.js'] } },
    selectedActivity: [{ kind: 'work_item.auto_redispatched', attemptId: 'W-1.exec-13', data: { summary: '别人的改派' } }],
    liveChunks: [],
    missionDiff: ['src/web/other.js'],
  }).facts;

  assert.equal(mismatched.matched, false);
  for (const name of ['title', 'identity', 'candidateChange', 'result']) {
    assert.equal(mismatched[name], '未知', name + ' 在 id 对不上时不是未知：' + mismatched[name]);
  }
  assert.equal(mismatched.scope, null);
  assert.equal(mismatched.cost, null);

  // 估算带 ≈ 与「估算」，不冒充精确；质量认不出来时即使 cost 是 0 也不能印 $0.00——
  // 那个 0 只是结构默认值，印出来就成了「这一跳不要钱」。
  const cost = (usage) => projectOutputBinding({
    currentAttemptId: 'W-1.exec-13',
    selectedAttemptId: 'W-1.exec-13',
    nowIso: '2026-10-26T10:00:00.000Z',
    currentAttempt: { attemptId: 'W-1.exec-13', status: 'in_progress' },
    selectedAttempt: { attemptId: 'W-1.exec-13', kind: 'executor', status: 'succeeded', usage },
    liveChunks: [],
  }).facts.cost;
  assert.equal(cost({ cost: 0.184, quality: 'estimated' }).text, '≈$0.18 · 估算');
  assert.equal(cost({ cost: 0, quality: 'unknown' }).text, '未知');
  assert.equal(cost({ cost: 'not-a-number', quality: 'reported' }).text, '未知');
  // usage 整块缺失时不编一个 cost 对象，交给视图说「未知」。
  assert.equal(cost(undefined), null);
});

test('已结束不谈停滞；只有进行中且真实心跳超过容忍窗口才算疑似停滞，心跳缺失只是未知', () => {
  const base = {
    currentAttemptId: 'W-1.exec-3',
    selectedAttemptId: 'W-1.exec-3',
    nowIso: '2026-10-26T10:00:00.000Z',
    liveChunks: [],
  };
  const beat = (status, heartbeatAt) => projectOutputBinding({
    ...base,
    currentAttempt: { attemptId: 'W-1.exec-3', status, heartbeatAt },
  }).heartbeat;

  // 已结束：心跳再旧也「不适用」，读成停滞会让人去重启一个已经交回结果的环节。
  const done = beat('succeeded', '2026-10-26T08:00:00.000Z');
  assert.equal(done.applicable, false);
  assert.equal(done.stalled, false);
  assert.equal(done.stateText, '心跳不适用');

  // 进行中、心跳早 100 秒（> 90000ms）：疑似停滞。
  const stale = beat('in_progress', '2026-10-26T09:58:20.000Z');
  assert.equal(stale.applicable, true);
  assert.equal(stale.stalled, true);
  assert.equal(stale.stateText, '疑似停滞');

  // 进行中、心跳早 10 秒：不算停滞，且原样带出 ISO。
  const fresh = beat('in_progress', '2026-10-26T09:59:50.000Z');
  assert.equal(fresh.applicable, true);
  assert.equal(fresh.stalled, false);
  assert.ok(fresh.stateText.includes('2026-10-26T09:59:50.000Z'));

  // 心跳缺失、空串、读不出来都只是「未知」：master 上已有的 Attempt 响应没有
  // heartbeatAt 键，把这些判成停滞会让人去重启一条可能还在正常输出的尝试。
  for (const heartbeatAt of [null, '', 'not-a-time']) {
    const unknown = beat('in_progress', heartbeatAt);
    assert.equal(unknown.applicable, true);
    assert.equal(unknown.stalled, false);
    assert.equal(unknown.stateText, '心跳未知');
    // 文本里不许出现「疑似停滞」——界面上一句话就能把人推去动手。
    assert.ok(!unknown.stateText.includes('疑似停滞'));
  }
});
