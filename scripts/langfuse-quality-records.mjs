/**
 * 质量同步的事实投影（W-721）：把已经取到的 HTTP 事实变成可重放的观察记录。
 *
 * 为什么单独一层：质量同步 CLI 要做的是「HTTP 事实 -> Langfuse 观察」，两端都不稳——
 * HTTP 端的形状随平台演进（lastReview 从没有 submittedAttemptId 到有，ValidationReport
 * 的 checks 从只有 command 到 changed-paths/diff-size），Langfuse 端要求稳定、可重投的
 * trace/score id。把「挑哪些字段、怎么命名、哪些事实不足以下结论」集中在这里，CLI 只管
 * 取和发；否则每次加字段都要在 CLI 里重写一遍挑字段逻辑，漏一处就是一条错归因。
 *
 * 三条必须守住的诚实性：
 * 1) 只有 HTTP 真的给了 submittedAttemptId 的 lastReview 才能关联到受评 Attempt。
 *    `attemptId` 是评审者（协调者），拿它当受评者会把分数挂到协调者的 trace 上，
 *    而 Langfuse 里两个 trace 看起来一样正常，错了也看不出来。
 * 2) review.recorded 历史事件没有受评者字段、也没有逐条原文：它们永远只是独立观察。
 *    和「当前 lastReview」拼起来，会让一次旧评审继承一次新提交的身份。
 * 3) 机器绿（report.passed / 命令退出 0）不是 L2/L3 接受，也不是测试全通过。
 *    测试状态只从命令输出里的 TAP/Node 汇总读；读不到就是 unknown，不出成功分。
 *
 * 接口（后续 CLI 直接用，返回值全部 JSON 可序列化）：
 *
 *   projectQualityRecords({ mission, activity, reports, attempts,
 *                           capturedReviews, reviewHistory, lastReviewFallback,
 *                           config, observedAt })
 *     -> { records, capturedReviews }
 *
 * - mission：GET /api/missions/:id 的顶层对象，只读 workItems[].lastReview。
 * - reviewHistory：{ [workItemId]: ReviewRecord[] }，来自
 *   GET /api/missions/:id/work-items/:wid/reviews 的逐页读取。**每条都是完整快照**，
 *   逐条交给 buildSnapshot；受评者只认每条记录自己的 submittedAttemptId。
 * - lastReviewFallback：允许退回 workItems[].lastReview 的工单 id 列表。只有历史接口
 *   404（旧平台）时才由 CLI 填进来；其它读取失败不进这个列表，于是那件工单本轮
 *   不投影 L2 快照——宁可少一条，也不把「没读到」当成「只有这一条」。
 * - activity：GET /api/missions/:id/activity 的事件数组。
 * - reports：按 reportId 索引的普通对象（GET .../validation-reports/:reportId）。
 * - attempts：按 attemptId 索引的普通对象（GET .../attempts/:attemptId）。只取
 *   kind/workItemId/profile/endedBy/failReason/evidence 做来源核对——累计 usage 是
 *   Attempt 级的，不能当逐调用数据；完整 output/toolActivity 也不复制。
 * - capturedReviews：上一次投影输出的 capturedReviews，原样传回来合并。
 * - config：transport 的配置（captureContent / maxContentChars），决定正文是否保留。
 * - observedAt：调用方读这份 HTTP 的时刻。只在源记录没有时间时代用，且显式标注
 *   coagent.time.*.source=observedAt——它不是评审发生时间。
 * - records[]：{ id, span, scores }。span 只含原生 OTLP 字段；scores[] 每项正是
 *   transport.enqueueScore 接受的 {id, traceId, name, dataType, value, comment?}，
 *   且与所属 span 同 trace（分数和它解释的观察必须落在同一个 trace 上）。
 *
 * 不读凭据、不打印、不发网络：这一层只挑字段与命名。
 */
import { captureValue, stableEventId, stableIds } from './langfuse-transport.mjs';

/** L2 逐条结果只认平台定义的四种；其它（含缺失、拼错）一律 unknown，不冒充 pass。 */
const ACCEPTANCE_STATUSES = new Set(['pass', 'fail', 'unverified', 'not_applicable']);
const L2_VERDICTS = new Set(['accept', 'reject']);
const L3_VERDICTS = new Map([
  ['final_review.merged', 'merge'],
  ['final_review.send_back', 'send_back'],
  ['final_review.abandoned', 'abandon'],
]);
const MERGE_FAILED_KIND = 'final_review.merge_failed';
const REVIEW_HISTORY_KIND = 'review.recorded';
const VALIDATION_REPORTED_KIND = 'validation.reported';

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;
const asText = (value) => (typeof value === 'string' && value.length > 0 ? value : undefined);
const asTextList = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === 'string') : undefined;

const str = (key, value) => ({ key, value: { stringValue: String(value) } });
const boolAttr = (key, value) => ({ key, value: { boolValue: value === true } });
const intAttr = (key, value) => ({ key, value: { intValue: value } });

/** 毫秒精度足够：HTTP 上的 at/startedAt/endedAt 本来就是毫秒 ISO 串。 */
const toUnixNano = (iso) => {
  if (typeof iso !== 'string') return undefined;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  // 走 BigInt：1750000000000000000 用 float64 会掉精度，接收端就对不上了。
  return (BigInt(ms) * 1_000_000n).toString();
};

/**
 * 时间只取**来源给出**的：没有就显式标缺失，绝不拿「我什么时候读的」补成发生时刻。
 * observedAt 只在调用方明确传入时兜底，并留下 source=observedAt 便于事后区分。
 */
function timeOf({ startedAt, endedAt, observedAt }) {
  const attributes = [];
  const fields = {};
  const startFromSource = toUnixNano(startedAt);
  const observed = toUnixNano(observedAt);
  const start = startFromSource ?? observed;
  const end = toUnixNano(endedAt);
  if (start !== undefined) {
    fields.startTimeUnixNano = start;
    if (startFromSource === undefined) attributes.push(str('coagent.time.start.source', 'observedAt'));
  } else {
    attributes.push(boolAttr('coagent.time.start.missing', true));
  }
  if (end !== undefined) fields.endTimeUnixNano = end;
  // 缺结束时间就留空：用 start 或采集时刻补一个 end，等于编造一个发生时刻。
  else attributes.push(boolAttr('coagent.time.end.missing', true));
  return { fields, attributes };
}

function makeRecord({ name, traceId, spanId, eventKey, startedAt, endedAt, observedAt, attributes }) {
  const time = timeOf({ startedAt, endedAt, observedAt });
  const span = { traceId, spanId, name, attributes: [...attributes, ...time.attributes] };
  if (time.fields.startTimeUnixNano !== undefined) span.startTimeUnixNano = time.fields.startTimeUnixNano;
  if (time.fields.endTimeUnixNano !== undefined) span.endTimeUnixNano = time.fields.endTimeUnixNano;
  return { id: stableEventId(['record', name, traceId, spanId]), span, scores: [], eventKey };
}

/**
 * 稳定 score id：同一份事实重投必须复用同一个 id（Langfuse 会按 id 去重），
 * 但同一 trace 下同名分数可能来自不同快照，所以把记录身份也拼进去。
 */
function makeScore({ traceId, recordKey, name, value, dataType = 'CATEGORICAL', comment }) {
  const score = {
    id: stableEventId(['score', traceId, name, recordKey]),
    traceId,
    name,
    dataType,
    value,
  };
  if (typeof comment === 'string' && comment.length > 0) score.comment = comment;
  return score;
}

/**
 * 采集过的正文按 config 决定要不要带出；missing/truncated 两个事实永远保留。
 * 返回归一化后的采集对象，调用方一律用 filled() 判断「到底有没有正文」。
 */
function pushCapture(attributes, prefix, captured) {
  const shape = storedCapture(captured);
  attributes.push(boolAttr(`${prefix}.missing`, shape.missing));
  if (shape.missing) return shape;
  attributes.push(boolAttr(`${prefix}.truncated`, shape.truncated));
  // 空串也照发：它和「没有这一格」是两件事，读的人要能区分。
  if (typeof shape.value === 'string') attributes.push(str(prefix, shape.value));
  return shape;
}

/** 从进度文件读回来的采集对象可能被手改过：只认形状，坏的一律当缺失。 */
function storedCapture(value) {
  if (!isObject(value)) return { missing: true, truncated: false };
  const out = { missing: value.missing !== false, truncated: value.truncated === true };
  if (typeof value.value === 'string') out.value = value.value;
  return out;
}

/** captureValue 的结果只有「确实带出了字符串」才算有值：missing/被截断成空都不算。 */
const filled = (captured) => typeof captured?.value === 'string' && captured.missing === false;

const storedCriteria = (value) =>
  Array.isArray(value)
    ? value.map((entry, index) => {
        const item = isObject(entry) ? entry : {};
        return {
          index: Number.isInteger(item.index) ? item.index : index + 1,
          status: ACCEPTANCE_STATUSES.has(item.status) ? item.status : 'unknown',
          criterion: storedCapture(item.criterion),
          evidence: storedCapture(item.evidence),
          note: storedCapture(item.note),
        };
      })
    : null;

/**
 * 一份 lastReview 的快照。
 *
 * 稳定 key 由**源记录身份 + 内容摘要**构成，不含轮询时间：同一份记录每轮同步都得到
 * 同一个 key（否则进度文件每轮都长一条），内容变了才是一条新快照（于是旧快照在
 * lastReview 被替换后仍然留着，能继续导出它自己的评分）。
 */
function buildSnapshot({ missionId, workItemId, review, config, source }) {
  const verdict = L2_VERDICTS.has(review.verdict) ? review.verdict : undefined;
  const submittedAttemptId = asText(review.submittedAttemptId);
  const reviewerAttemptId = asText(review.attemptId);
  const reasonsRaw = asTextList(review.reasons);
  const requiredRaw = asTextList(review.requiredChanges);
  const rawCriteria = Array.isArray(review.acceptanceResults) ? review.acceptanceResults : undefined;
  const criteria =
    rawCriteria === undefined
      ? null
      : rawCriteria.map((entry, index) => {
          const item = isObject(entry) ? entry : {};
          return {
            index: index + 1,
            // unknown 不冒充 pass：pass/fail/unverified/not_applicable 与「没读到」分开。
            status: ACCEPTANCE_STATUSES.has(item.status) ? item.status : 'unknown',
            criterion: captureValue(item.criterion, config),
            evidence: captureValue(item.evidence, config),
            note: captureValue(item.note, config),
          };
        });
  // 摘要用**原始**内容算（不带 config）：否则 captureContent 开关一变 key 就变，
  // 同一份记录会被当成两份。摘要只是哈希，不会把正文带出去。
  const contentKey = stableEventId([
    'l2-content',
    verdict ?? null,
    reasonsRaw ?? null,
    requiredRaw ?? null,
    rawCriteria === undefined
      ? null
      : rawCriteria.map((entry) =>
          isObject(entry)
            ? [entry.criterion ?? null, entry.status ?? null, entry.evidence ?? null, entry.note ?? null]
            : null,
        ),
  ]);
  const key = stableEventId([
    'l2-captured-review',
    missionId,
    workItemId ?? null,
    submittedAttemptId ?? null,
    reviewerAttemptId ?? null,
    contentKey,
  ]);
  return {
    key,
    source,
    missionId,
    workItemId: workItemId ?? null,
    // 受评者与评审者分开存：只有前者能做 trace，后者只做元数据。
    submittedAttemptId: submittedAttemptId ?? null,
    reviewerAttemptId: reviewerAttemptId ?? null,
    verdict: verdict ?? null,
    reasons: captureValue(reasonsRaw, config),
    requiredChanges: captureValue(requiredRaw, config),
    criteria,
    /** 「能关联受评 Attempt 且结论已知」才算完整：缺任一项都不许打 L2 分。 */
    complete: Boolean(verdict && submittedAttemptId),
  };
}

/** 上一轮进度里的快照：字段逐个校验，不可信的降级成缺失，绝不臆造。 */
function normalizePriorSnapshot(entry, missionId) {
  if (!isObject(entry) || typeof entry.key !== 'string' || entry.key.length === 0) return undefined;
  if (asText(entry.missionId) !== missionId) return undefined;
  const verdict = L2_VERDICTS.has(entry.verdict) ? entry.verdict : null;
  const submittedAttemptId = asText(entry.submittedAttemptId) ?? null;
  return {
    key: entry.key,
    source: asText(entry.source) ?? 'captured',
    missionId,
    workItemId: asText(entry.workItemId) ?? null,
    submittedAttemptId,
    reviewerAttemptId: asText(entry.reviewerAttemptId) ?? null,
    verdict,
    reasons: storedCapture(entry.reasons),
    requiredChanges: storedCapture(entry.requiredChanges),
    // 进度里 criteria 为 null 表示当时就没有逐条结果：那是事实，不当成「有但空了」。
    criteria: entry.criteria === null ? null : storedCriteria(entry.criteria),
    complete: Boolean(verdict && submittedAttemptId),
  };
}

function snapshotAttributes(snapshot, missionId) {
  const attributes = [
    str('coagent.mission_id', missionId),
    // 与 pi 观测同一个 session 分组：不统一的话，同一次 Mission 在 Langfuse 里会裂成两个会话。
    // 字段名用 Langfuse v4 的官方映射 langfuse.session.id（值仍是 missionId）。
    str('langfuse.session.id', missionId),
    str('coagent.observation.source', snapshot.source),
  ];
  if (snapshot.workItemId) attributes.push(str('coagent.work_item_id', snapshot.workItemId));
  else attributes.push(boolAttr('coagent.work_item_id.missing', true));
  if (snapshot.submittedAttemptId) attributes.push(str('coagent.submitted_attempt_id', snapshot.submittedAttemptId));
  else attributes.push(boolAttr('coagent.submitted_attempt_id.missing', true));
  if (snapshot.reviewerAttemptId) attributes.push(str('coagent.reviewer_attempt_id', snapshot.reviewerAttemptId));
  else attributes.push(boolAttr('coagent.reviewer_attempt_id.missing', true));
  if (snapshot.verdict) attributes.push(str('coagent.l2.verdict', snapshot.verdict));
  else attributes.push(boolAttr('coagent.l2.verdict.missing', true));
  const reasons = pushCapture(attributes, 'coagent.l2.reasons', snapshot.reasons);
  pushCapture(attributes, 'coagent.l2.required_changes', snapshot.requiredChanges);
  if (snapshot.criteria === null) {
    attributes.push(boolAttr('coagent.l2.criteria.missing', true));
  } else {
    attributes.push(boolAttr('coagent.l2.criteria.missing', false));
    attributes.push(intAttr('coagent.l2.criteria.count', snapshot.criteria.length));
    for (const criterion of snapshot.criteria) {
      const prefix = `coagent.l2.criterion.${criterion.index}`;
      if (criterion.status === 'unknown') attributes.push(boolAttr(`${prefix}.status.unknown`, true));
      else attributes.push(str(`${prefix}.status`, criterion.status));
      pushCapture(attributes, `${prefix}.text`, criterion.criterion);
      pushCapture(attributes, `${prefix}.evidence`, criterion.evidence);
      pushCapture(attributes, `${prefix}.note`, criterion.note);
    }
  }
  return { attributes, reasons };
}

/**
 * L2 快照 -> 记录。
 *
 * 完整快照落在受评 Attempt 的 trace 上（Mission 与 Attempt 两种 trace 由同一个
 * stableIds 算出，attemptId 一给就自然隔离）；缺受评者的只落 Mission trace 的
 * unknown/missing 观察，一个 L2 分都不出。
 */
function l2Record({ snapshot, missionId, missionTrace }) {
  const { attributes, reasons } = snapshotAttributes(snapshot, missionId);
  const trace = snapshot.complete
    ? stableIds({ missionId, attemptId: snapshot.submittedAttemptId })
    : missionTrace;
  const eventKey = `l2-review:${snapshot.key}`;
  const record = makeRecord({
    name: snapshot.complete ? 'coagent.l2.work_item_review' : 'coagent.mission_review_observation',
    traceId: trace.traceId,
    spanId: stableIds({ missionId, attemptId: snapshot.complete ? snapshot.submittedAttemptId : null, eventKey }).spanId,
    eventKey,
    // lastReview 上没有时间：快照缺时间就显式 missing，不拿采集时刻冒充评审时间。
    attributes: [
      ...attributes,
      str('langfuse.observation.type', 'EVENT'),
      ...(snapshot.complete ? [] : [boolAttr('coagent.l2.incomplete', true)]),
    ],
  });
  if (!snapshot.complete) return record;
  record.scores.push(
    makeScore({
      traceId: trace.traceId,
      recordKey: `${record.eventKey}|coagent.l2.verdict`,
      name: 'coagent.l2.verdict',
      value: snapshot.verdict,
      comment: filled(reasons) ? reasons.value : undefined,
    }),
  );
  for (const criterion of snapshot.criteria ?? []) {
    if (criterion.status === 'unknown') continue;
    const comment =
      criterion.status === 'pass' && filled(criterion.evidence)
        ? criterion.evidence.value
        : filled(criterion.note)
          ? criterion.note.value
          : undefined;
    record.scores.push(
      makeScore({
        traceId: trace.traceId,
        recordKey: `${record.eventKey}|coagent.l2.criterion.${criterion.index}`,
        name: `coagent.l2.criterion.${criterion.index}`,
        value: criterion.status,
        comment,
      }),
    );
  }
  return record;
}

/** 历史事件的身份：优先平台给的事件 id，否则由事件自身的可见事实哈希出来。 */
function eventIdentity(event, missionId) {
  const messageId = asText(event.messageId);
  if (messageId) return messageId;
  return stableEventId([
    'activity-event',
    asText(event.missionId) ?? missionId,
    event.workItemId ?? null,
    event.kind ?? null,
    event.at ?? null,
    event.attemptId ?? null,
    event.data ?? null,
  ]);
}

/**
 * review.recorded 是**历史事实**，不是当前状态的投影。
 *
 * 它没有 submittedAttemptId，也没有逐条原文（只有 counts 与 unverified 序号），
 * 所以永远只落 Mission trace 的观察：不打 L2 分，也不拿当前 lastReview 的
 * submittedAttemptId / acceptanceResults 补上去——那样会把旧评审挂到新提交上。
 */
function historyReviewRecord({ event, missionId, config }) {
  const identity = eventIdentity(event, missionId);
  const data = isObject(event.data) ? event.data : {};
  const attributes = [
    str('coagent.mission_id', missionId),
    str('langfuse.session.id', missionId),
    str('coagent.observation.source', REVIEW_HISTORY_KIND),
    str('coagent.source.event_kind', REVIEW_HISTORY_KIND),
    str('coagent.source.event_id', identity),
    str('langfuse.observation.type', 'EVENT'),
    // 事件上的 attemptId 是评审者，不是受评者；改名而不是照搬，避免读的人看错。
    ...(asText(event.attemptId) ? [str('coagent.reviewer_attempt_id', event.attemptId)] : []),
    boolAttr('coagent.submitted_attempt_id.missing', true),
    boolAttr('coagent.l2.criteria_verbatim.missing', true),
    boolAttr('coagent.l2.scored', false),
  ];
  if (asText(event.workItemId)) attributes.push(str('coagent.work_item_id', event.workItemId));
  if (L2_VERDICTS.has(data.verdict)) attributes.push(str('coagent.l2.history.verdict', data.verdict));
  else attributes.push(boolAttr('coagent.l2.history.verdict.missing', true));
  pushCapture(attributes, 'coagent.l2.history.reasons', captureValue(asTextList(data.reasons), config));
  const acceptance = isObject(data.acceptance) ? data.acceptance : undefined;
  if (acceptance) {
    for (const [status, count] of Object.entries(acceptance)) {
      if (ACCEPTANCE_STATUSES.has(status) && Number.isFinite(count)) {
        attributes.push(intAttr(`coagent.l2.history.acceptance.${status}`, Number(count)));
      }
    }
  } else {
    attributes.push(boolAttr('coagent.l2.history.acceptance.missing', true));
  }
  const unverified = asTextList(data.unverified) ? data.unverified : undefined;
  if (unverified) attributes.push(intAttr('coagent.l2.history.unverified.count', unverified.length));
  return makeRecord({
    name: 'coagent.review_history_event',
    traceId: stableIds({ missionId }).traceId,
    spanId: stableIds({ missionId, eventKey: `review-history:${identity}` }).spanId,
    eventKey: `review-history:${identity}`,
    // 事件自带发生时刻，直接用；没有就不补。
    startedAt: event.at,
    attributes,
  });
}

const lastCount = (text, pattern) => {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  let found;
  for (const match of text.matchAll(pattern)) found = Number(match[1]);
  return Number.isFinite(found) ? found : undefined;
};

/**
 * 测试状态只从输出里的 TAP/Node 汇总读。
 *
 * 为什么不看退出码：`git status` / 编译错误的非零退出都不是测试失败；反过来，
 * 「全部 skipped」的退出码是 0。拿退出码当测试结论，等于给所有工程命令发测试分。
 * 读不到汇总就 unknown：`unknown` 不出成功分，比猜成 pass 安全得多。
 */
function testStatusOf(command) {
  if (!isObject(command)) return { status: 'unknown', infrastructure: 'no_command' };
  if (command.timedOut === true) return { status: 'unknown', infrastructure: 'timeout' };
  if (typeof command.exitCode !== 'number') return { status: 'unknown', infrastructure: 'process_error' };
  const tail = typeof command.outputTail === 'string' ? command.outputTail : '';
  const pass = lastCount(tail, /(?:^|\n)\s*(?:#|ℹ)\s*pass\s+(\d+)/g);
  const fail = lastCount(tail, /(?:^|\n)\s*(?:#|ℹ)\s*fail\s+(\d+)/g);
  const skip = lastCount(tail, /(?:^|\n)\s*(?:#|ℹ)\s*skip(?:ped)?\s+(\d+)/g);
  if (fail !== undefined && fail > 0) return { status: 'failed', counts: { pass, fail, skip } };
  // 有跳过就不能把这一轮算成「测试全绿」：跳过的是没跑，不是通过。
  if (pass !== undefined && skip !== undefined && skip > 0) {
    return { status: 'skipped', counts: { pass, fail, skip } };
  }
  if (pass !== undefined && fail === 0) return { status: 'passed', counts: { pass, fail, skip } };
  return { status: 'unknown', counts: { pass, fail, skip } };
}

function profileFacts(profile) {
  const source = Array.isArray(profile?.resolved)
    ? profile.resolved
    : Array.isArray(profile?.facts)
      ? profile.facts
      : [];
  const facts = {};
  for (const fact of source) {
    if (isObject(fact) && typeof fact.key === 'string' && typeof fact.value === 'string') facts[fact.key] = fact.value;
  }
  return facts;
}

/**
 * validation.reported -> 观察。
 *
 * 严格核对三方：报告自身的 missionId/workItemId/attemptId、事件的 submittedAttemptId 与
 * workItemId、以及 Attempt 明细。任一不符就只留 Mission 级 missing 观察——报告和事件
 * 各自都能是真话，但对不上就说明「这份报告不是这次提交的」，此时出分即是错归因。
 */
function validationRecords({ event, missionId, missionTrace, reports, attempts, config }) {
  const identity = eventIdentity(event, missionId);
  const data = isObject(event.data) ? event.data : {};
  const reportId = asText(data.reportId);
  const eventWorkItemId = asText(event.workItemId);
  const submittedAttemptId = asText(data.submittedAttemptId);
  const report = reportId ? (isObject(reports[reportId]) ? reports[reportId] : undefined) : undefined;
  const attempt = submittedAttemptId ? (isObject(attempts[submittedAttemptId]) ? attempts[submittedAttemptId] : undefined) : undefined;

  const problems = [];
  if (!reportId) problems.push('report_id_missing');
  else if (!report) problems.push('report_not_available');
  if (!eventWorkItemId) problems.push('event_work_item_missing');
  if (!submittedAttemptId) problems.push('event_submitted_attempt_missing');
  if (report) {
    if (asText(report.id) !== reportId) problems.push('report_id_mismatch');
    if (asText(report.missionId) !== missionId) problems.push('report_mission_mismatch');
    if (asText(report.workItemId) !== eventWorkItemId) problems.push('report_work_item_mismatch');
    if (asText(report.attemptId) !== submittedAttemptId) problems.push('report_attempt_mismatch');
  }
  // Attempt 缺席只标缺来源，不降级（调用方可能没取那一跳）；但它自相矛盾就必须停手。
  if (attempt) {
    if (asText(attempt.workItemId) !== eventWorkItemId) problems.push('attempt_work_item_mismatch');
    if (asText(attempt.kind) !== 'executor') problems.push('attempt_not_executor');
  }

  if (problems.length > 0) {
    const attributes = [
      str('coagent.mission_id', missionId),
      str('langfuse.session.id', missionId),
      str('coagent.observation.source', VALIDATION_REPORTED_KIND),
      str('coagent.source.event_kind', VALIDATION_REPORTED_KIND),
      str('coagent.source.event_id', identity),
      str('langfuse.observation.type', 'EVENT'),
      str('coagent.validation.unverified_reason', problems.join(',')),
      boolAttr('coagent.validation.engine_result.missing', true),
      boolAttr('coagent.validation.scored', false),
      ...(reportId ? [str('coagent.validation.report_id', reportId)] : [boolAttr('coagent.validation.report_id.missing', true)]),
      ...(eventWorkItemId ? [str('coagent.work_item_id', eventWorkItemId)] : []),
      ...(submittedAttemptId ? [str('coagent.validation.submitted_attempt_id', submittedAttemptId)] : []),
      ...(attempt ? [] : [boolAttr('coagent.validation.source_attempt.missing', true)]),
    ];
    return [
      makeRecord({
        name: 'coagent.validation_observation',
        traceId: missionTrace.traceId,
        spanId: stableIds({ missionId, eventKey: `validation-unverified:${identity}` }).spanId,
        eventKey: `validation-unverified:${identity}`,
        startedAt: event.at,
        attributes,
      }),
    ];
  }

  const checks = Array.isArray(report.checks) ? report.checks : [];
  const attributes = [
    str('coagent.mission_id', missionId),
    str('langfuse.session.id', missionId),
    str('coagent.observation.source', VALIDATION_REPORTED_KIND),
    str('coagent.source.event_kind', VALIDATION_REPORTED_KIND),
    str('coagent.source.event_id', identity),
    str('langfuse.observation.type', 'EVENT'),
    str('coagent.validation.report_id', reportId),
    str('coagent.work_item_id', eventWorkItemId),
    str('coagent.validation.submitted_attempt_id', submittedAttemptId),
    // engine_result 是**平台检查**的结论，不代表模型能力：挂在同一支点上的分数
    // 若被当成「模型表现」，一次 shell 环境问题就会变成一次模型差评。
    str('coagent.validation.engine_result.source', 'platform validation engine'),
    ...(Number.isFinite(report.policyRevision) ? [intAttr('coagent.validation.policy_revision', Number(report.policyRevision))] : []),
    intAttr('coagent.validation.checks.count', checks.length),
  ];
  if (typeof data.passed === 'boolean' && typeof report.passed === 'boolean' && data.passed !== report.passed) {
    // 事件与报告不一致时以报告为准，但把分歧留下：事后只有这条线索能解释两边对不上。
    attributes.push(boolAttr('coagent.validation.event_passed_mismatch', true));
  }
  const facts = profileFacts(attempt?.profile);
  if (attempt) {
    if (asText(attempt.profile?.profileId)) attributes.push(str('coagent.source.profile_id', attempt.profile.profileId));
    if (facts.provider) attributes.push(str('coagent.source.provider', facts.provider));
    if (facts.model) attributes.push(str('coagent.source.model', facts.model));
    if (asText(attempt.endedBy)) attributes.push(str('coagent.source.ended_by', attempt.endedBy));
    pushCapture(attributes, 'coagent.source.fail_reason', captureValue(attempt.failReason, config));
    const evidence = Array.isArray(attempt.evidence) ? attempt.evidence : [];
    attributes.push(intAttr('coagent.source.evidence.count', evidence.length));
    // 只留引用（证据 id 与 kind）：完整 output 是正文，且它属于 Attempt 不属于这份报告。
    const evidenceIds = evidence
      .map((item) => (isObject(item) && typeof item.id === 'string' ? `${item.id}:${item.kind ?? '?'}` : undefined))
      .filter((item) => typeof item === 'string');
    if (evidenceIds.length > 0) attributes.push(str('coagent.source.evidence.ids', evidenceIds.join(',')));
  } else {
    attributes.push(boolAttr('coagent.validation.source_attempt.missing', true));
  }

  const infrastructure = [];
  const testStatuses = [];
  checks.forEach((check, index) => {
    const item = isObject(check) ? check : {};
    const n = index + 1;
    attributes.push(str(`coagent.validation.check.${n}.kind`, asText(item.kind) ?? 'unknown'));
    if (typeof item.passed === 'boolean') attributes.push(boolAttr(`coagent.validation.check.${n}.passed`, item.passed));
    else attributes.push(boolAttr(`coagent.validation.check.${n}.passed.missing`, true));
    pushCapture(attributes, `coagent.validation.check.${n}.summary`, captureValue(item.summary, config));
    const command = isObject(item.command) ? item.command : undefined;
    if (command) {
      const argv = asTextList(command.argv);
      if (argv) attributes.push(str(`coagent.validation.check.${n}.command.argv`, argv.join(' ')));
      if (typeof command.exitCode === 'number') {
        attributes.push(intAttr(`coagent.validation.check.${n}.command.exit_code`, command.exitCode));
      } else {
        attributes.push(boolAttr(`coagent.validation.check.${n}.command.exit_code.missing`, true));
      }
      attributes.push(boolAttr(`coagent.validation.check.${n}.command.timed_out`, command.timedOut === true));
      // outputTail 原文不进 span：它可能有几 KB，而且正文按 config 才有权带出。
      if (typeof command.outputTail === 'string') {
        attributes.push(intAttr(`coagent.validation.check.${n}.command.output_tail.length`, command.outputTail.length));
      }
    }
    const test = testStatusOf(command);
    if (test.infrastructure) infrastructure.push(`${test.infrastructure}@${n}`);
    if (test.counts) {
      for (const [key, value] of Object.entries(test.counts)) {
        if (Number.isFinite(value)) attributes.push(intAttr(`coagent.validation.check.${n}.test.${key}`, Number(value)));
      }
    }
    if (test.status === 'unknown') {
      // unknown 不出分：给一个「未知」的 score 会被下游当成一条结论。
      attributes.push(boolAttr(`coagent.validation.check.${n}.test_status.missing`, true), str(`coagent.validation.check.${n}.test_status`, 'unknown'));
    }
    testStatuses.push({ n, status: test.status, kind: asText(item.kind) });
  });
  if (infrastructure.length > 0) {
    attributes.push(str('coagent.validation.infrastructure', infrastructure.join(',')));
    // 基础设施故障不是模型能力差：这里明确写下来，免得读者去 L2 分里找原因。
    attributes.push(boolAttr('coagent.validation.model_failure.excluded', true));
  }

  const trace = stableIds({ missionId, attemptId: submittedAttemptId });
  const record = makeRecord({
    name: 'coagent.validation_report',
    traceId: trace.traceId,
    spanId: stableIds({ missionId, attemptId: submittedAttemptId, eventKey: `validation:${identity}` }).spanId,
    eventKey: `validation:${identity}`,
    startedAt: asText(report.startedAt) ?? event.at,
    endedAt: asText(report.endedAt),
    attributes,
  });
  if (typeof report.passed === 'boolean') {
    record.scores.push(
      makeScore({
        traceId: trace.traceId,
        recordKey: `${record.eventKey}|coagent.validation.engine_result`,
        name: 'coagent.validation.engine_result',
        value: report.passed ? 'passed' : 'failed',
      }),
    );
  }
  checks.forEach((check, index) => {
    const item = isObject(check) ? check : {};
    const n = index + 1;
    if (typeof item.passed === 'boolean') {
      // 名字里带 check_result：这是平台检查自己的结论，与下面 test_status 是两件事。
      // 混用同一个名字，一次「全部 skipped」就会被读成一次测试成功。
      record.scores.push(
        makeScore({
          traceId: trace.traceId,
          recordKey: `${record.eventKey}|coagent.validation.check_result.${n}`,
          name: `coagent.validation.check_result.${n}`,
          value: item.passed ? 'passed' : 'failed',
        }),
      );
    }
    const status = testStatuses.find((entry) => entry.n === n)?.status;
    if (status === 'passed' || status === 'failed' || status === 'skipped') {
      record.scores.push(
        makeScore({
          traceId: trace.traceId,
          recordKey: `${record.eventKey}|coagent.validation.test_status.${n}`,
          name: `coagent.validation.test_status.${n}`,
          // skipped 单独一个值：它必须能一眼和 passed 分开，否则「没跑」会被读成「过了」。
          value: status,
        }),
      );
    }
  });
  return [record];
}

/**
 * L3 终审只属于 Mission 层。
 *
 * 一张工单的接受不代表整条 Mission 被接受，所以 L3 分永远落 Mission trace，
 * 也就不会被拆到每个 Attempt 上去。merge_failed 是合并流程的基础设施事实，
 * 不出 L3 verdict 分：一次落地失败不是评审结论，更不是模型表现。
 */
function finalReviewRecord({ event, missionId, missionTrace, config }) {
  const identity = eventIdentity(event, missionId);
  const data = isObject(event.data) ? event.data : {};
  const verdict = L3_VERDICTS.get(event.kind);
  const attributes = [
    str('coagent.mission_id', missionId),
    str('langfuse.session.id', missionId),
    str('coagent.observation.source', event.kind),
    str('coagent.source.event_kind', event.kind),
    str('coagent.source.event_id', identity),
    str('langfuse.observation.type', 'EVENT'),
  ];
  const reasons = pushCapture(attributes, 'coagent.l3.reasons', captureValue(asTextList(data.reasons), config));
  if (verdict) {
    attributes.push(str('coagent.l3.verdict', verdict));
    if (asText(data.authority)) attributes.push(str('coagent.l3.authority', data.authority));
    else attributes.push(boolAttr('coagent.l3.authority.missing', true));
    if (asText(data.mergedInto)) attributes.push(str('coagent.l3.merged_into', data.mergedInto));
    else attributes.push(boolAttr('coagent.l3.merged_into.missing', true));
  } else {
    // merge_failed：流程/基础设施观察，不是模型差评，所以连 verdict 属性都不占位。
    attributes.push(boolAttr('coagent.l3.infrastructure', true));
    attributes.push(boolAttr('coagent.l3.verdict.missing', true));
    pushCapture(attributes, 'coagent.l3.failure_reason', captureValue(data.reason, config));
  }
  const record = makeRecord({
    name: verdict ? 'coagent.final_review' : 'coagent.final_review_infrastructure',
    traceId: missionTrace.traceId,
    spanId: stableIds({ missionId, eventKey: `final-review:${identity}` }).spanId,
    eventKey: `final-review:${identity}`,
    startedAt: event.at,
    attributes,
  });
  if (verdict) {
    record.scores.push(
      makeScore({
        traceId: missionTrace.traceId,
        recordKey: `${record.eventKey}|coagent.l3.verdict`,
        name: 'coagent.l3.verdict',
        value: verdict,
        comment: filled(reasons) ? reasons.value : undefined,
      }),
    );
  }
  return record;
}

/**
 * 主入口：纯函数，无 IO、无网络、无时间依赖（除非调用方给 observedAt）。
 * 同一份输入两次调用得到逐字节相同的输出，是「稳定 ID 去重、可重跑」的前提。
 */
export function projectQualityRecords({
  mission,
  activity = [],
  reports = {},
  attempts = {},
  capturedReviews = [],
  reviewHistory,
  lastReviewFallback = [],
  config = {},
  observedAt,
} = {}) {
  const missionId = asText(mission?.missionId);
  if (!missionId) throw new TypeError('projectQualityRecords 需要 mission.missionId');
  const captureConfig = isObject(config) ? config : {};
  const observed = asText(observedAt);
  const missionTrace = stableIds({ missionId });
  const records = [];

  // 1) L2：评审历史（逐条完整快照）与上一轮已捕获的快照合并。
  //    先放旧的再放当前的：lastReview 被替换后旧快照仍在，能继续导出它自己的评分，
  //    而不是跟着当前状态一起消失（这就是「停机错过的 review」唯一还救得回的部分）。
  //    历史与 lastReview 指向同一条事实时，buildSnapshot 的稳定 key 相同，只留一份。
  const snapshots = new Map();
  for (const entry of Array.isArray(capturedReviews) ? capturedReviews : []) {
    const prior = normalizePriorSnapshot(entry, missionId);
    if (prior) snapshots.set(prior.key, prior);
  }
  const historyByWorkItem = isObject(reviewHistory) ? reviewHistory : undefined;
  const fallbackItems = new Set(
    Array.isArray(lastReviewFallback) ? lastReviewFallback.filter((id) => isText(id)) : [],
  );
  const workItems = Array.isArray(mission?.workItems) ? mission.workItems : [];
  for (const item of workItems) {
    if (!isObject(item) || !isText(item.id)) continue;
    const history = historyByWorkItem ? historyByWorkItem[item.id] : undefined;
    if (Array.isArray(history)) {
      for (const review of history) {
        if (!isObject(review)) continue;
        const snapshot = buildSnapshot({
          missionId,
          workItemId: item.id,
          review,
          config: captureConfig,
          source: 'http.reviews',
        });
        // 同一条事实（同工单 + 同受评/评审者 + 同内容）只投影一份。
        if (!snapshots.has(snapshot.key)) snapshots.set(snapshot.key, snapshot);
      }
      continue;
    }
    // 只有旧平台（历史接口 404）或旧调用方（没给 reviewHistory）才退回 lastReview。
    // 历史读取失败（既不在 reviewHistory 也不在 fallback 里）本轮什么都不投影，
    // 由 CLI 把这一轮标成未完成：不拿当前状态补一段没读到的历史。
    if (historyByWorkItem && !fallbackItems.has(item.id)) continue;
    if (!isObject(item.lastReview)) continue;
    const snapshot = buildSnapshot({
      missionId,
      workItemId: item.id,
      review: item.lastReview,
      config: captureConfig,
      source: 'http.lastReview',
    });
    if (!snapshots.has(snapshot.key)) snapshots.set(snapshot.key, snapshot);
  }
  const ordered = [...snapshots.values()].sort((a, b) =>
    `${a.workItemId ?? ''}\u0000${a.submittedAttemptId ?? ''}\u0000${a.key}`.localeCompare(
      `${b.workItemId ?? ''}\u0000${b.submittedAttemptId ?? ''}\u0000${b.key}`,
    ),
  );
  for (const snapshot of ordered) records.push(l2Record({ snapshot, missionId, missionTrace }));

  // 2) 历史事件一律单独观察；3)/4) 同理，都按事件自身携带的事实命名。
  const events = Array.isArray(activity) ? activity.filter((event) => isObject(event)) : [];
  for (const event of events) {
    if (event.kind === REVIEW_HISTORY_KIND) {
      records.push(historyReviewRecord({ event, missionId, config: captureConfig }));
    } else if (event.kind === VALIDATION_REPORTED_KIND) {
      records.push(
        ...validationRecords({
          event,
          missionId,
          missionTrace,
          reports: isObject(reports) ? reports : {},
          attempts: isObject(attempts) ? attempts : {},
          config: captureConfig,
        }),
      );
    } else if (L3_VERDICTS.has(event.kind) || event.kind === MERGE_FAILED_KIND) {
      records.push(finalReviewRecord({ event, missionId, missionTrace, config: captureConfig }));
    }
  }

  // 只有完整（结论已知 + 受评者已知）的快照才值得存进进度：不完整的记录永远算不出分，
  // 存下来只会在每轮同步里被反复投影成同一条 unknown 观察。
  const persistable = ordered.filter((snapshot) => snapshot.complete).map((snapshot) => ({
    key: snapshot.key,
    source: snapshot.source,
    missionId: snapshot.missionId,
    workItemId: snapshot.workItemId,
    submittedAttemptId: snapshot.submittedAttemptId,
    reviewerAttemptId: snapshot.reviewerAttemptId,
    verdict: snapshot.verdict,
    reasons: snapshot.reasons,
    requiredChanges: snapshot.requiredChanges,
    criteria: snapshot.criteria,
    complete: snapshot.complete,
  }));

  return {
    records: records.map((record) => ({ id: record.id, span: record.span, scores: record.scores })),
    capturedReviews: persistable,
  };
}
