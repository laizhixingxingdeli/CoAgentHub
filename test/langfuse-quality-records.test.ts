// scripts/langfuse-quality-records.mjs 的两条综合验收（W-721）：
// 1) 用真实 HTTP 形状（脱敏 synthetic fixture）验证 L2 投影：完整 lastReview 只关联
//    submittedAttemptId 指向的**受评** Attempt、lastReview 换掉后已捕获快照仍在、
//    旧记录缺信息只落 Mission 级 unknown 且不出分、重复投影 ID 稳定、正文默认不带/开启后脱敏截断；
// 2) VR 真实 checks 形状 + skip/unknown/infra 变体 + L3 只在 Mission 层，且机器绿不生成
//    L2/L3 接受、报告归属不符只出 missing 观察。
// 不连真实 Langfuse/模型，不读凭据：fixture 全部 synthetic。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { projectQualityRecords } from '../scripts/langfuse-quality-records.mjs';
import { stableIds } from '../scripts/langfuse-transport.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/langfuse-quality-http.json', import.meta.url));
const MISSION_ID = 'M-q-synthetic';

const loadFixture = async () => JSON.parse(await readFile(FIXTURE, 'utf8'));

const recordsNamed = (out, name) => out.records.filter((record) => record.span.name === name);
const scoreNames = (record) => record.scores.map((score) => score.name);
const attr = (record, key) => record.span.attributes.find((entry) => entry.key === key);
const strOf = (record, key) => attr(record, key)?.value.stringValue;
const boolOf = (record, key) => attr(record, key)?.value.boolValue;
const intOf = (record, key) => attr(record, key)?.value.intValue;
const missionTraceId = () => stableIds({ missionId: MISSION_ID }).traceId;
const attemptTraceId = (attemptId) => stableIds({ missionId: MISSION_ID, attemptId }).traceId;
/** 记录整体 JSON 序列化后再查哨兵：只要正文以任何形式进了输出都会被抓到。 */
const serialized = (value) => JSON.stringify(value);

/** lastReview 被下一轮换掉：内容不同（reject + requiredChanges + fail 的逐条结果）。 */
const reviseLastReview = (mission) => {
  const next = JSON.parse(JSON.stringify(mission));
  const item = next.workItems.find((entry) => entry.id === 'W-1');
  item.status = 'rejected';
  item.lastReview = {
    verdict: 'reject',
    reasons: ['synthetic reason C: the second acceptance result is still unverified'],
    requiredChanges: ['synthetic required change: attach the missing evidence'],
    attemptId: 'coord-3',
    submittedAttemptId: 'W-1.exec-1',
    acceptanceResults: [
      { criterion: 'synthetic AC1 text', status: 'pass', evidence: 'synthetic evidence E-13' },
      { criterion: 'synthetic AC2 text', status: 'fail', note: 'synthetic note: no evidence attached' },
      { criterion: 'synthetic AC3 text', status: 'pass', evidence: 'synthetic evidence E-14' },
    ],
  };
  return next;
};

test('projects L2 lastReview only onto the reviewed submitted attempt, keeps captured snapshots after replacement, and never scores incomplete or legacy reviews', async () => {
  const fixture = await loadFixture();
  const first = projectQualityRecords({
    mission: fixture.mission,
    activity: fixture.activity,
    reports: fixture.reports,
    attempts: fixture.attempts,
    capturedReviews: [],
    config: {},
  });

  // 输出必须能原样 JSON 往返：后续 CLI 要落进度文件、发 wire。
  assert.deepEqual(JSON.parse(serialized(first)), first);

  const l2 = recordsNamed(first, 'coagent.l2.work_item_review');
  assert.equal(l2.length, 1);
  const [review] = l2;
  // 受评者是 executor，不是评审者：张冠李戴在 Langfuse 里看不出来，所以这里必须钉死。
  assert.equal(review.span.traceId, attemptTraceId('W-1.exec-1'));
  assert.notEqual(review.span.traceId, attemptTraceId('coord-1'));
  assert.notEqual(review.span.traceId, missionTraceId());
  assert.equal(strOf(review, 'coagent.submitted_attempt_id'), 'W-1.exec-1');
  assert.equal(strOf(review, 'coagent.reviewer_attempt_id'), 'coord-1');
  assert.equal(boolOf(review, 'coagent.submitted_attempt_id.missing'), undefined);
  // 与 pi 观测统一：session 分组用 missionId，否则同一个 Mission 会裂成两个会话。
  // 字段名必须是 Langfuse v4 官方映射 langfuse.session.id（span 级），旧名不会被识别。
  assert.equal(strOf(review, 'langfuse.session.id'), MISSION_ID);
  assert.equal(attr(review, 'langfuse.trace.session_id'), undefined);
  assert.equal(strOf(review, 'coagent.l2.verdict'), 'accept');
  assert.deepEqual(scoreNames(review), [
    'coagent.l2.verdict',
    'coagent.l2.criterion.1',
    'coagent.l2.criterion.2',
    'coagent.l2.criterion.3',
  ]);
  const byName = (name) => review.scores.find((score) => score.name === name);
  assert.equal(byName('coagent.l2.verdict').value, 'accept');
  assert.equal(byName('coagent.l2.verdict').dataType, 'CATEGORICAL');
  // categorical 值与 status 一一对应；unverified 不能冒充 pass。
  assert.equal(byName('coagent.l2.criterion.1').value, 'pass');
  assert.equal(byName('coagent.l2.criterion.2').value, 'unverified');
  assert.equal(byName('coagent.l2.criterion.3').value, 'pass');
  for (const score of review.scores) {
    // 分数必须和它解释的观察同 trace。
    assert.equal(score.traceId, review.span.traceId, score.name);
    assert.equal(typeof score.id, 'string');
    assert.equal(score.id.length, 64);
  }
  // lastReview 上没有时间：宁可显式标缺失，也不拿采集时刻冒充评审发生时间。
  assert.equal(boolOf(review, 'coagent.time.start.missing'), true);
  assert.equal(review.span.startTimeUnixNano, undefined);

  // 每一条导出记录（Attempt trace 上的评审、Mission 级的未知/历史/验证/L3 观察）都要带会话分组，
  // 否则同一 Mission 的部分观察在 Langfuse 里挂不到会话上。
  for (const record of first.records) {
    assert.equal(strOf(record, 'langfuse.session.id'), MISSION_ID, record.span.name);
    assert.equal(attr(record, 'langfuse.trace.session_id'), undefined, record.span.name);
  }

  // 旧形状（无 submittedAttemptId、无 acceptanceResults）：只落 Mission 级 unknown，一个 L2 分都不出。
  const unknown = recordsNamed(first, 'coagent.mission_review_observation');
  assert.equal(unknown.length, 1);
  const [legacy] = unknown;
  assert.equal(legacy.span.traceId, missionTraceId());
  assert.deepEqual(legacy.scores, []);
  assert.equal(boolOf(legacy, 'coagent.submitted_attempt_id.missing'), true);
  assert.equal(boolOf(legacy, 'coagent.l2.criteria.missing'), true);
  assert.equal(strOf(legacy, 'coagent.l2.verdict'), 'accept');
  // 它的 attemptId 只是评审者身份，不允许被当成受评者写进 trace 或 submitted 属性。
  assert.equal(strOf(legacy, 'coagent.reviewer_attempt_id'), 'coord-2');
  assert.equal(strOf(legacy, 'coagent.l2.criteria.1.status'), undefined);
  assert.equal(serialized(legacy).includes(attemptTraceId('coord-2')), false);

  // 默认关闭正文：理由/逐条原文一律不带，但 missing 事实必须还在。
  const allText = serialized(first);
  for (const body of [
    'synthetic reason A',
    'synthetic evidence E-11',
    'synthetic note: no device available',
    'synthetic AC1 text',
    'synthetic required change',
  ]) {
    assert.equal(allText.includes(body), false, body);
  }
  assert.equal(boolOf(review, 'coagent.l2.reasons.missing'), false);
  assert.equal(attr(review, 'coagent.l2.reasons'), undefined);
  assert.equal(attr(review, 'coagent.l2.criterion.1.evidence'), undefined);

  // 同一输入重复投影：ID 逐字节稳定（重跑不会在 Langfuse 里长出第二条）。
  const repeat = projectQualityRecords({
    mission: fixture.mission,
    activity: fixture.activity,
    reports: fixture.reports,
    attempts: fixture.attempts,
    capturedReviews: [],
    config: {},
  });
  assert.deepEqual(repeat, first);

  // lastReview 被换掉：已捕获的完整快照仍在，并且继续导出它自己那份评分。
  const next = projectQualityRecords({
    mission: reviseLastReview(fixture.mission),
    activity: fixture.activity,
    reports: fixture.reports,
    attempts: fixture.attempts,
    capturedReviews: first.capturedReviews,
    config: {},
  });
  const nextReviews = recordsNamed(next, 'coagent.l2.work_item_review');
  assert.equal(nextReviews.length, 2);
  const kept = nextReviews.find((record) => record.scores.some((score) => score.value === 'accept'));
  const replaced = nextReviews.find((record) => record.scores.some((score) => score.value === 'reject'));
  assert.ok(kept, '旧快照必须还在');
  assert.ok(replaced, '新 lastReview 必须写成新记录');
  // 旧记录的身份、评分、trace 都不因新状态而改变。
  assert.deepEqual(kept, review);
  assert.equal(replaced.span.traceId, attemptTraceId('W-1.exec-1'));
  assert.notEqual(replaced.span.spanId, review.span.spanId);
  assert.equal(replaced.scores.find((score) => score.name === 'coagent.l2.criterion.2').value, 'fail');
  // 进度里两条完整快照都在，且稳定 key 不同（同一条记录不会每轮新增一条）。
  assert.equal(next.capturedReviews.length, 2);
  assert.equal(new Set(next.capturedReviews.map((entry) => entry.key)).size, 2);
  const third = projectQualityRecords({
    mission: reviseLastReview(fixture.mission),
    activity: fixture.activity,
    reports: fixture.reports,
    attempts: fixture.attempts,
    capturedReviews: next.capturedReviews,
    config: {},
  });
  assert.deepEqual(third, next);

  // 开启正文：只带 config 允许的内容，超长截断；否则复核时看不到理由和证据。
  const withContent = projectQualityRecords({
    mission: fixture.mission,
    activity: fixture.activity,
    reports: fixture.reports,
    attempts: fixture.attempts,
    capturedReviews: [],
    config: { captureContent: true, maxContentChars: 2000 },
  });
  const withContentReview = recordsNamed(withContent, 'coagent.l2.work_item_review')[0];
  assert.equal(strOf(withContentReview, 'coagent.l2.reasons').includes('synthetic reason A'), true);
  assert.equal(boolOf(withContentReview, 'coagent.l2.reasons.truncated'), false);
  assert.equal(
    withContentReview.scores.find((score) => score.name === 'coagent.l2.criterion.1').comment,
    'synthetic evidence E-11',
  );
  // 证据只挂在 pass 上；unverified 带的是 note，不是证据。
  assert.equal(
    withContentReview.scores.find((score) => score.name === 'coagent.l2.criterion.2').comment,
    'synthetic note: no device available',
  );
  // 内容开关不影响记录身份：同一份记录的 spanId/score id 不变，否则重跑会重复投递。
  assert.equal(withContentReview.span.spanId, review.span.spanId);
  assert.deepEqual(
    withContentReview.scores.map((score) => score.id),
    review.scores.map((score) => score.id),
  );

  const truncated = projectQualityRecords({
    mission: fixture.mission,
    activity: fixture.activity,
    reports: fixture.reports,
    attempts: fixture.attempts,
    capturedReviews: [],
    config: { captureContent: true, maxContentChars: 12 },
  });
  const truncatedReview = recordsNamed(truncated, 'coagent.l2.work_item_review')[0];
  assert.equal(boolOf(truncatedReview, 'coagent.l2.reasons.truncated'), true);
  assert.equal(strOf(truncatedReview, 'coagent.l2.reasons').length, 12);
  assert.equal(
    truncatedReview.scores.find((score) => score.name === 'coagent.l2.criterion.1').comment.length,
    12,
  );

  // 历史 review.recorded 只做独立观察：不借当前 lastReview 的受评者，也不出 L2 分。
  const history = recordsNamed(first, 'coagent.review_history_event');
  assert.equal(history.length, 1);
  const [event] = history;
  assert.equal(event.span.traceId, missionTraceId());
  assert.deepEqual(event.scores, []);
  assert.equal(strOf(event, 'coagent.source.event_id'), 'synthetic-msg-review-history');
  assert.equal(strOf(event, 'coagent.reviewer_attempt_id'), 'coord-1');
  assert.equal(boolOf(event, 'coagent.submitted_attempt_id.missing'), true);
  assert.equal(boolOf(event, 'coagent.l2.criteria_verbatim.missing'), true);
  assert.equal(boolOf(event, 'coagent.l2.scored'), false);
  assert.equal(event.span.startTimeUnixNano, '1792126587572000000');
  assert.equal(serialized(event).includes('W-1.exec-1'), false, '历史事件不得继承当前提交身份');
});

test('projects VR checks with separated engine/test observations, keeps skip/unknown/infra out of success, and puts L3 only on the Mission trace', async () => {
  const fixture = await loadFixture();
  const out = projectQualityRecords({
    mission: fixture.mission,
    activity: fixture.activity,
    reports: fixture.reports,
    attempts: fixture.attempts,
    capturedReviews: [],
    config: {},
  });
  assert.deepEqual(JSON.parse(serialized(out)), out);

  const validations = recordsNamed(out, 'coagent.validation_report');
  assert.equal(validations.length, 4);
  const report1 = validations.find((record) => strOf(record, 'coagent.validation.report_id') === 'VR-1');
  // 报告属于受评 attempt 的 trace；score 与观察同 trace 才有意义。
  assert.equal(report1.span.traceId, attemptTraceId('W-1.exec-1'));
  assert.equal(strOf(report1, 'coagent.work_item_id'), 'W-1');
  assert.equal(strOf(report1, 'coagent.validation.submitted_attempt_id'), 'W-1.exec-1');
  assert.equal(intOf(report1, 'coagent.validation.policy_revision'), 7);
  // 来源核对只用白名单字段：profile 事实、endedBy、证据引用，不含累计 usage 与完整正文。
  assert.equal(strOf(report1, 'coagent.source.profile_id'), 'exec-synthetic');
  assert.equal(strOf(report1, 'coagent.source.provider'), 'provider-synthetic');
  assert.equal(strOf(report1, 'coagent.source.model'), 'model-synthetic');
  assert.equal(strOf(report1, 'coagent.source.ended_by'), 'structured_submit');
  assert.equal(strOf(report1, 'coagent.source.evidence.ids'), 'E-11:test,E-12:diff');
  const report1Text = serialized(report1);
  assert.equal(report1Text.includes('synthetic attempt output body'), false, '不得复制 Attempt output');
  assert.equal(report1Text.includes('synthetic-tool'), false, '不得复制 toolActivity');
  assert.equal(report1Text.includes('"total":2'), false, '累计 usage 不能当逐调用数据');
  // outputTail 只留长度：正文可能有几 KB，且默认不允许带出。
  assert.equal(report1Text.includes('✔ synthetic case'), false);
  assert.equal(
    intOf(report1, 'coagent.validation.check.1.command.output_tail.length'),
    fixture.reports['VR-1'].checks[0].command.outputTail.length,
  );
  assert.equal(strOf(report1, 'coagent.validation.check.1.command.argv'), 'node --test test/synthetic.test.ts');
  assert.equal(intOf(report1, 'coagent.validation.check.1.command.exit_code'), 0);
  // 平台检查结论与测试状态是两条不同的命名观察。
  assert.deepEqual(scoreNames(report1), [
    'coagent.validation.engine_result',
    'coagent.validation.check_result.1',
    'coagent.validation.test_status.1',
    'coagent.validation.check_result.2',
    'coagent.validation.check_result.3',
  ]);
  assert.equal(report1.scores[0].value, 'passed');
  assert.equal(report1.scores[0].name, 'coagent.validation.engine_result');
  assert.equal(report1.scores[2].value, 'passed');
  assert.equal(report1.span.startTimeUnixNano, '1792126536000000000');
  assert.equal(report1.span.endTimeUnixNano, '1792126538000000000');
  // 没有 command 的检查（changed-paths/diff-size）读不到测试汇总：不允许出一条「测试通过」。
  assert.equal(scoreNames(report1).includes('coagent.validation.test_status.2'), false);
  assert.equal(boolOf(report1, 'coagent.validation.check.2.test_status.missing'), true);
  assert.equal(strOf(report1, 'coagent.validation.check.2.test_status'), 'unknown');
  // 机器绿只是平台检查结论，不等于 L2/L3 接受。
  assert.equal(report1.scores.some((score) => score.value === 'accept'), false);
  for (const record of validations) {
    assert.equal(
      record.scores.some((score) => score.name.startsWith('coagent.l2.') || score.name.startsWith('coagent.l3.')),
      false,
      record.span.spanId,
    );
  }

  const report2 = validations.find((record) => strOf(record, 'coagent.validation.report_id') === 'VR-2');
  // 有 skip 的一轮：退出码 0 也不能算测试全绿，测试状态必须是 skipped。
  assert.equal(intOf(report2, 'coagent.validation.check.1.test.pass'), 1);
  assert.equal(intOf(report2, 'coagent.validation.check.1.test.skip'), 1);
  const skipScore = report2.scores.find((score) => score.name === 'coagent.validation.test_status.1');
  assert.equal(skipScore.value, 'skipped');
  assert.equal(report2.scores.find((score) => score.name === 'coagent.validation.check_result.1').value, 'passed');

  const report3 = validations.find((record) => strOf(record, 'coagent.validation.report_id') === 'VR-3');
  // 超时/进程起不来属于基础设施：不出测试分，也不许被读成模型差。
  assert.equal(scoreNames(report3).includes('coagent.validation.test_status.1'), false);
  assert.equal(strOf(report3, 'coagent.validation.check.1.test_status'), 'unknown');
  assert.equal(strOf(report3, 'coagent.validation.infrastructure'), 'timeout@1');
  assert.equal(boolOf(report3, 'coagent.validation.model_failure.excluded'), true);
  assert.equal(report3.scores.find((score) => score.name === 'coagent.validation.engine_result').value, 'failed');

  const report4 = validations.find((record) => strOf(record, 'coagent.validation.report_id') === 'VR-4');
  // 退出 0 但没有测试汇总（git status）：看不到汇总就是 unknown，测试分缺席。
  assert.equal(intOf(report4, 'coagent.validation.check.1.command.exit_code'), 0);
  assert.equal(strOf(report4, 'coagent.validation.check.1.test_status'), 'unknown');
  assert.equal(scoreNames(report4).includes('coagent.validation.test_status.1'), false);
  assert.equal(report4.scores.some((score) => score.value === 'passed'), true);

  // 报告归属与事件对不上：只出 Mission 级 missing 观察，不评分。
  const mismatched = recordsNamed(out, 'coagent.validation_observation');
  assert.equal(mismatched.length, 1);
  const [mismatch] = mismatched;
  assert.equal(mismatch.span.traceId, missionTraceId());
  assert.deepEqual(mismatch.scores, []);
  assert.equal(strOf(mismatch, 'coagent.validation.report_id'), 'VR-5');
  assert.equal(strOf(mismatch, 'coagent.validation.unverified_reason').includes('report_attempt_mismatch'), true);
  assert.equal(boolOf(mismatch, 'coagent.validation.engine_result.missing'), true);
  assert.equal(boolOf(mismatch, 'coagent.validation.scored'), false);

  // L3 只在 Mission 层，且不因为一张工单被接受而产生第二条。
  const finals = recordsNamed(out, 'coagent.final_review');
  assert.equal(finals.length, 1);
  const [final] = finals;
  assert.equal(final.span.traceId, missionTraceId());
  assert.equal(strOf(final, 'coagent.l3.verdict'), 'merge');
  assert.equal(strOf(final, 'coagent.l3.authority'), 'reviewer');
  assert.equal(strOf(final, 'coagent.l3.merged_into'), 'synthetic-merge-sha-0001');
  assert.deepEqual(scoreNames(final), ['coagent.l3.verdict']);
  assert.equal(final.scores[0].value, 'merge');
  assert.equal(final.scores[0].traceId, missionTraceId());
  assert.equal(out.records.flatMap((record) => record.scores).filter((score) => score.name === 'coagent.l3.verdict').length, 1);
  // L3 分数不得落到任何 attempt trace 上：那等于说这次尝试被终审接受了。
  for (const record of out.records.filter((entry) => entry.span.traceId !== missionTraceId())) {
    assert.equal(record.scores.some((score) => score.name.startsWith('coagent.l3.')), false, record.span.spanId);
  }

  // 合并失败是流程/基础设施观察，不是模型差评，也不出 L3 verdict 分。
  const failed = recordsNamed(out, 'coagent.final_review_infrastructure');
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0].scores, []);
  assert.equal(boolOf(failed[0], 'coagent.l3.infrastructure'), true);
  assert.equal(boolOf(failed[0], 'coagent.l3.verdict.missing'), true);
  assert.equal(failed[0].span.traceId, missionTraceId());
  assert.equal(serialized(failed[0]).includes('synthetic merge failure'), false);

  // 机器全绿不生成任何 L2 接受：L2 只来自带 submittedAttemptId 的 lastReview。
  const l2Verdicts = out.records
    .flatMap((record) => record.scores)
    .filter((score) => score.name === 'coagent.l2.verdict');
  assert.equal(l2Verdicts.length, 1);
  assert.equal(l2Verdicts[0].traceId, attemptTraceId('W-1.exec-1'));

  // 评审历史（新接口）：每条记录都是完整快照，逐条投影；受评者只认记录自己的
  // submittedAttemptId，与 lastReview 指向同一事实时只投影一份（稳定 key 相同）。
  const w1LastReview = fixture.mission.workItems.find((entry) => entry.id === 'W-1').lastReview;
  const historyOut = projectQualityRecords({
    mission: fixture.mission,
    activity: [],
    reports: {},
    attempts: {},
    capturedReviews: [],
    reviewHistory: {
      'W-1': [
        {
          verdict: 'reject',
          reasons: ['synthetic history reason'],
          requiredChanges: [],
          attemptId: 'coord-9',
          submittedAttemptId: 'W-1.exec-1',
          acceptanceResults: [{ criterion: 'synthetic AC1 text', status: 'fail' }],
        },
        // 与 mission.lastReview 完全同一条事实。
        w1LastReview,
      ],
      // 历史为空是「确实没有记录」这个事实：不能再拿 lastReview 顶上。
      'W-2': [],
    },
    config: {},
  });
  const historyReviews = recordsNamed(historyOut, 'coagent.l2.work_item_review');
  assert.equal(historyReviews.length, 2, '两条历史各一份快照，与 lastReview 重复的那条只算一份');
  assert.equal(recordsNamed(historyOut, 'coagent.mission_review_observation').length, 0);
  for (const record of historyReviews) {
    assert.equal(strOf(record, 'coagent.observation.source'), 'http.reviews');
  }
  const historyReject = historyReviews.find((record) => strOf(record, 'coagent.l2.verdict') === 'reject');
  const historyAccept = historyReviews.find((record) => strOf(record, 'coagent.l2.verdict') === 'accept');
  // 两条记录虽然都属于 W-1，但受评者不同，所以 trace 必须各自落在自己的 Attempt 上。
  assert.equal(historyReject.span.traceId, attemptTraceId('W-1.exec-1'));
  assert.equal(historyAccept.span.traceId, attemptTraceId('W-1.exec-1'));
  assert.equal(strOf(historyReject, 'coagent.reviewer_attempt_id'), 'coord-9');
  // 与 lastReview 同内容的那份快照得到同一个记录 id / spanId / 同一批 score id（稳定去重），
  // 只有来源标记不同（http.reviews vs http.lastReview）——它确实是从历史接口读到的。
  const lastReviewOnly = recordsNamed(
    projectQualityRecords({ mission: fixture.mission, activity: [], config: {} }),
    'coagent.l2.work_item_review',
  ).find((record) => strOf(record, 'coagent.work_item_id') === 'W-1');
  assert.equal(historyAccept.id, lastReviewOnly.id);
  assert.equal(historyAccept.span.spanId, lastReviewOnly.span.spanId);
  assert.deepEqual(
    historyAccept.scores.map((score) => score.id),
    lastReviewOnly.scores.map((score) => score.id),
  );
  assert.equal(historyOut.capturedReviews.length, 2);
  assert.equal(new Set(historyOut.capturedReviews.map((entry) => entry.key)).size, 2);

  // 历史读取失败（既不在 reviewHistory 也不在 fallback 里）时，这件工单本轮不投影
  // 任何 L2 快照：不拿当前 lastReview 补一段没读到的历史。
  const unreadable = projectQualityRecords({
    mission: fixture.mission,
    activity: [],
    capturedReviews: [],
    reviewHistory: {},
    lastReviewFallback: ['W-2'],
    config: {},
  });
  assert.equal(
    recordsNamed(unreadable, 'coagent.l2.work_item_review').some(
      (record) => strOf(record, 'coagent.work_item_id') === 'W-1',
    ),
    false,
  );
  // W-2 在 fallback 里（旧平台 404）：仍然从 lastReview 投影，且因为缺受评者只出 unknown。
  const fallbackRecords = recordsNamed(unreadable, 'coagent.mission_review_observation');
  assert.equal(fallbackRecords.length, 1);
  assert.equal(strOf(fallbackRecords[0], 'coagent.observation.source'), 'http.lastReview');
  assert.equal(strOf(fallbackRecords[0], 'coagent.work_item_id'), 'W-2');
});
