/**
 * 任务详情「交付验证」六层的纯数据投影：一条 Mission 详情 + 所选工作项 → 六层事实
 * （机器验证、角色验收、独立复核、检视者终审、合入集成分支、合入 master）。
 *
 * **为什么单开一个纯模块**：这一块最容易出的错都不报错、不崩、也不影响任何断言——
 * 把上一跳残留的机器报告说成「这一跳已通过」、把 direct 的两层协作写成「协调者验收」、
 * 把标准任务的独立复核写成「未知」、把「没有合入证据」写成「未合入」。这些句子在界面上
 * 都长得像对的，只有对着真实投影断言才问得出来。
 *
 * **不发请求、不拼 HTML、不读时钟**：前端只走 `/api/*` 已经投影好的 view；转义与配色是
 * 渲染层的事。函数内一旦取「现在」或自己去 fetch，同一条数据两次运行会得出不同的字，
 * 测试就没法断言，渲染层也会为了同一个事实写第二份判断。
 *
 * **六层固定顺序**：机器 → 角色 → 独立复核 → 终审 → 集成 → master。改顺序就是让所有人
 * 重新认一遍位置。
 *
 * **一句话贯穿全篇**：当前这一跳有没有交回，决定旧结论算不算数。`status` 是 dispatched
 * 时 attemptIds、validationReport、executionResult、lastReview 都还可能留着上一跳的值
 * （dispatch 不清旧结果），照抄它们就是把上一跳的通过贴到这一跳头上。
 */

const text = (value) => (value === undefined || value === null ? '' : String(value)).trim();
const list = (value) => (Array.isArray(value) ? value : []);
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

/**
 * 当前已交回的三个状态。**dispatched 不在这里**：派出去了不等于交回来了，
 * 内核 dispatch 也不清旧结果，所以这一格必须靠 status 判，不能靠「有没有报告」判。
 */
const RETURNED_STATUSES = new Set(['submitted', 'accepted', 'rejected']);

/**
 * 七个状态词，逐字对应工单。多造一个词（比如「进行中」「部分通过」），界面上就多一个
 * 没人认得、也没人知道该不该动手的状态。
 */
const STATE_TEXT = Object.freeze({
  not_started: '未开始',
  not_returned: '当前未交回',
  pending: '待处理',
  passed: '通过',
  failed: '未通过',
  inapplicable: '不适用',
  unknown: '未知',
});

/** 时间与缺失字段统一说「未知」：空串在界面上会被读成「这一层没有这一栏」。 */
const UNKNOWN = '未知';

function layer(key, title, state, detail, attribution, extra) {
  return {
    key,
    title,
    state,
    stateText: STATE_TEXT[state],
    detail,
    attribution,
    ...(extra === undefined ? {} : extra),
  };
}

/** 所选工作项。**对不上就是没有**：硬套到别的工单上，界面会显示一张没被选中的工单的结论。 */
function selectItem(items, asked) {
  const id = text(asked);
  if (id === '') return null;
  return items.find((item) => text(item && item.id) === id) ?? null;
}

/** 逐条验收结果只认数组形状；没有就是 null（不是空数组——「没记」和「一条都没有」不一样）。 */
function acceptanceRowsOf(review) {
  const raw = review === null ? null : review.acceptanceResults;
  if (!Array.isArray(raw)) return null;
  return raw.map((row) => {
    const r = object(row) ?? {};
    return { criterion: text(r.criterion), status: text(r.status) };
  });
}

/* ============================ 1. 机器验证 ============================ */

function machineLayer(item, currentReturned) {
  if (item === null) {
    return layer('machine', '机器验证', 'not_started', '没有所选工作项，无法对应机器报告', '没有所选工作项');
  }
  const status = text(item.status);
  const report = object(item.validationReport);
  const reportId = report === null ? '' : text(report.reportId);

  if (!currentReturned) {
    const attempts = list(item.attemptIds).filter((id) => text(id) !== '');
    if (attempts.length > 0 || status === 'dispatched') {
      // 残留报告是上一跳的：它挂的是旧的 submittedAttemptId，讲不出这一跳过没过。
      // 点出 id 是为了让人能回去查那一份，同时把「不算当前」写在同一个句子里。
      const detail = reportId === ''
        ? '当前未交回，没有与当前提交对应的机器报告'
        : `当前未交回；残留报告 ${reportId} 不作为当前结果`;
      return layer(
        'machine',
        '机器验证',
        'not_returned',
        detail,
        reportId === '' ? '没有与当前提交对应的报告' : `机器报告 ${reportId}（旧提交残留）`,
      );
    }
    return layer('machine', '机器验证', 'not_started', '还没有派出执行尝试，没有机器报告', '没有尝试');
  }

  if (report === null) {
    return layer('machine', '机器验证', 'unknown', '没有与当前提交对应的机器报告', '没有报告对象');
  }
  if (report.passed === true) {
    return layer('machine', '机器验证', 'passed', '当前提交的机器验证通过', `机器报告 ${reportId}`);
  }
  if (report.passed === false) {
    return layer('machine', '机器验证', 'failed', '当前提交的机器验证未通过', `机器报告 ${reportId}`);
  }
  // passed 不是布尔：报告形状不对。按未知处理，不替它猜一个结论。
  return layer('machine', '机器验证', 'unknown', `报告 ${reportId} 没有给出通过与否`, `机器报告 ${reportId}`);
}

/* ============================ 2. 角色验收 ============================ */

function roleLayer(coordinationMode, item, currentReturned) {
  const direct = text(coordinationMode) === 'direct';
  // direct 是主控在平台外面直接验收，平台里没有 L2。标题写成「协调者验收」，
  // 人会去找一个这条 Mission 里根本不存在的角色要结论。
  const title = direct ? '外部主控验收' : '协调者验收';

  if (item === null) {
    return layer('role', title, 'not_started', '没有所选工作项，无法对应验收结论', '没有所选工作项');
  }

  const status = text(item.status);
  const review = object(item.lastReview);
  const verdict = review === null ? '' : text(review.verdict);

  if (!currentReturned) {
    const detail = review === null
      ? '当前未交回，没有与当前提交对应的验收结论'
      : `当前未交回；残留验收结论（${verdict === '' ? '结论未知' : verdict}）不作为当前结果`;
    return layer(
      'role',
      title,
      'not_returned',
      detail,
      review === null ? '没有验收记录' : '上一次验收记录（残留）',
    );
  }

  // 已交回：逐条结论只认这一份 review 的 acceptanceResults，不拿契约条数冒充。
  const rows = acceptanceRowsOf(review);
  const extra = rows === null ? undefined : { acceptanceResults: rows };

  // 逐条结论只留在 acceptanceResults，由视图画一次。曾把逐条拼进 detail，于是同一句
  // 验收在明细和列表里各出现一遍，读的人会以为那是两条不同的结论。
  if (status === 'accepted') {
    return layer('role', title, 'passed', '已交回，验收通过', '当前提交的验收记录', extra);
  }
  if (status === 'rejected') {
    return layer('role', title, 'failed', '已交回，验收未通过', '当前提交的验收记录', extra);
  }
  // submitted：交回来了但还没结论。lastReview / validationReport 可能还留着上一轮的值，
  // 拿它们写成「通过」就是替还没做的验收先签字。
  return layer('role', title, 'pending', '已交回，等待验收结论', title);
}

/* ============================ 3. 独立复核 ============================ */

function independentLayer(view) {
  if (text(view.executionMode) !== 'high_assurance') {
    // 标准任务不做独立复核是「不适用」，不是「未知」：写成未知，人会去查一件本来
    // 不该发生的事。
    return layer('independent', '独立复核', 'inapplicable', '仅高保障任务需要', '执行保障不是高保障');
  }
  const reviews = list(view.independentReviews);
  const last = object(reviews[reviews.length - 1]);
  if (last === null) {
    return layer('independent', '独立复核', 'not_started', '还没有独立复核记录', '没有独立复核记录');
  }
  const verdict = text(last.verdict);
  if (verdict === 'pass') {
    return layer('independent', '独立复核', 'passed', '独立复核通过', '独立复核记录（最新一条）');
  }
  if (verdict === 'send_back') {
    return layer('independent', '独立复核', 'failed', '独立复核打回', '独立复核记录（最新一条）');
  }
  return layer('independent', '独立复核', 'unknown', '独立复核结论无法识别', '独立复核记录（最新一条）');
}

/* ============================ 4. 检视者终审 ============================ */

/**
 * 上一轮留下的终审结论：写 priorNote 而不是当前 state 的唯一判据。
 *
 * 三个 verdict 都算：merge 是上一轮通过了、send_back/abandon 是上一轮退回了，两种都
 * 讲不出这一轮怎么样。只认 send_back 会把「上一轮 merge 过」画成这一轮已通过。
 */
const PRIOR_VERDICTS = new Set(['merge', 'send_back', 'abandon']);

function finalLayer(view) {
  const finalReview = object(view.finalReview);
  const verdict = finalReview === null ? '' : text(finalReview.verdict);

  if (text(view.status) === 'awaiting_review') {
    // 契约改版会重开 Mission，内核**不清** finalReview：这一格里留着的仍是上一轮的
    // 结论。照它画「未通过」，屏幕上就成了「这一轮已经被检视者退回」——而这一轮连
    // 终审都还没发生，人会去等一个永远不会来的重派。
    const prior = PRIOR_VERDICTS.has(verdict) ? `上轮终审 ${verdict}，不作为当前结论` : '';
    return layer(
      'final',
      '检视者终审',
      'pending',
      '任务已到待检视，还没有本轮终审结论',
      prior === '' ? '任务状态 awaiting_review' : '上一轮终审记录',
      { priorNote: prior },
    );
  }

  if (finalReview === null) {
    return layer('final', '检视者终审', 'not_started', '还没有终审结论', '没有终审记录');
  }
  if (verdict === 'merge') {
    return layer('final', '检视者终审', 'passed', '终审结论 merge', '本任务的终审记录');
  }
  if (verdict === 'send_back' || verdict === 'abandon') {
    return layer('final', '检视者终审', 'failed', `终审结论 ${verdict}`, '本任务的终审记录');
  }
  return layer('final', '检视者终审', 'unknown', '终审结论无法识别', '本任务的终审记录');
}

/* ============================ 5. 合入集成分支 ============================ */

function integrationLayer(view) {
  const finalReview = object(view.finalReview);
  const mergedInto = finalReview === null ? '' : text(finalReview.mergedInto);
  if (mergedInto !== '') {
    return layer('integration', '合入集成分支', 'passed', `已合入集成分支 ${mergedInto}`, '终审记录的 mergedInto');
  }
  if (finalReview !== null && text(finalReview.verdict) === 'merge') {
    // merge 却没有 mergedInto：平台不知道合到哪儿了。写「未合入」比不写更糟——
    // 那是在替平台断言一件它没有证据的事。
    return layer('integration', '合入集成分支', 'unknown', '终审结论是 merge，但没有记录合入到哪个集成分支', '终审记录缺 mergedInto');
  }
  return layer('integration', '合入集成分支', 'not_started', '还没有合入集成分支的记录', '没有终审合入记录');
}

/* ============================ 6. 合入 master ============================ */

function masterLayer() {
  // 详情里没有 master 上的合并证据这一格。所以恒为未知，且只说「未记录」：
  // 「已合入 master」是凭空断言，「未合入」同样是把「没有证据」说成「没有发生」。
  return layer(
    'master',
    '合入 master',
    'unknown',
    'master 合入未记录：平台没有 master 上的合并证据',
    '详情里没有 master 字段可读',
  );
}

/* ====================== 归属：事件链对得上才算数 ====================== */

/** 倒序找最后一条满足条件的事件；没有就是 null。 */
function lastEventOf(events, match) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = object(events[i]);
    if (event === null) continue;
    if (match(event)) return event;
  }
  return null;
}

/** 什么都不认的归属：三处时刻全空，上层据此写「未知」。 */
const NONE_ATTRIBUTION = Object.freeze({
  submittedAttemptId: '',
  submittedAt: '',
  machineAt: '',
  roleAt: '',
});

/**
 * 这一跳的事件归属：报告号 → submittedAttemptId → 提交 / 机器 / 角色三个时刻。
 *
 * **必须倒序取最后一条**：同一张工单、同一次提交会被验过不止一次（重跑机器验收、
 * 契约改版后重验），正序取第一条拿到的是上一次的钟点，屏幕上的「提交时间」会比
 * 实际早好几天，而它看起来完全正常。
 *
 * **链条任一环缺失就整段留空**：`attemptIds` 的最后一项、`review.recorded` 的
 * attemptId 都不能拿来顶替 `submittedAttemptId`——前者是「派过哪几跳」，后者是
 * 「这一份报告评的是哪一跳」，两者在重派之后恰好不一致。用错了画面上就是「这一跳
 * 13:29 交的卷、机器 13:31 验过」，而那条事件属于别的 Attempt。
 *
 * 评审者自己的 attemptId（例如 coord-8）只用来对齐 review 事件，绝不出现在画面上：
 * 受评的是执行者，写评审者等于把交卷归属给错了人。
 */
function attributionOf(item, activity, status) {
  if (item === null) return NONE_ATTRIBUTION;
  const itemId = text(item.id);
  const reportId = reportIdOf(item);
  if (itemId === '' || reportId === '') return NONE_ATTRIBUTION;
  const events = list(activity);

  const reported = lastEventOf(events, (event) => {
    if (text(event.kind) !== 'validation.reported') return false;
    if (text(event.workItemId) !== itemId) return false;
    const data = object(event.data);
    return data !== null && text(data.reportId) === reportId;
  });
  if (reported === null) return NONE_ATTRIBUTION;

  const reportedData = object(reported.data);
  const submittedAttemptId = reportedData === null ? '' : text(reportedData.submittedAttemptId);
  // 报告号对上了却说不出评的是哪一跳：机器时刻同样保持未知——它挂不到任何一次提交上。
  if (submittedAttemptId === '') return NONE_ATTRIBUTION;

  const submitted = lastEventOf(events, (event) => (
    text(event.kind) === 'execution_result.submitted'
    && text(event.workItemId) === itemId
    && text(event.attemptId) === submittedAttemptId
  ));

  const review = object(item.lastReview);
  const reviewerAttemptId = review === null ? '' : text(review.attemptId);
  // 只有已验收/已退回才有本轮角色时刻：submitted 时还没有人下过结论，
  // 上一轮 review 事件的钟点挂上去就成了「这一跳已经被验收过了」。
  const reviewed = (status === 'accepted' || status === 'rejected') && reviewerAttemptId !== ''
    ? lastEventOf(events, (event) => (
      text(event.kind) === 'review.recorded'
      && text(event.workItemId) === itemId
      && text(event.attemptId) === reviewerAttemptId
    ))
    : null;

  return {
    submittedAttemptId,
    submittedAt: submitted === null ? '' : text(submitted.at),
    machineAt: text(reported.at),
    roleAt: reviewed === null ? '' : text(reviewed.at),
  };
}

/* ============================ 交卷摘要 ============================ */

/**
 * 受评执行那一行：工作项 id + 受评 Attempt + 报告号。
 *
 * 「这次交卷是被哪一跳、哪一份机器报告评的」是契约要求写清归属的那半句。只写工作项
 * id 时，一个季度里同一张工单的十几份报告看起来是同一份；写评审者 id 时，人会把
 * 验收方的身份当成交卷方的身份。
 */
function reviewedExecutionOf(item, submittedAttemptId) {
  const id = text(item && item.id);
  if (id === '') return '';
  const parts = [id];
  if (submittedAttemptId !== '') parts.push(`受评执行 ${submittedAttemptId}`);
  const reportId = reportIdOf(item);
  if (reportId !== '') parts.push(`报告 ${reportId}`);
  return parts.join(' · ');
}

/**
 * 所选工作项「当前这一跳」的机器报告号；未交回或没有报告时是空串。
 *
 * 导出给接线层用，是因为「什么算已交回」只能有一份：接线层自己再写一遍
 * submitted / accepted / rejected，两处早晚分岔，而分岔的那边只是多发或少发一条 GET。
 */
export function currentReportIdOf(view, workItemId) {
  const id = text(workItemId);
  if (id === '') return '';
  const items = list(object(view) && object(view).workItems);
  const item = items.find((entry) => object(entry) !== null && text(entry.id) === id);
  if (item === undefined) return '';
  if (!RETURNED_STATUSES.has(text(item.status))) return '';
  return reportIdOf(item);
}

/** 当前这一跳的机器报告号；没有报告或没有 id 就是空串。 */
function reportIdOf(item) {
  const report = object(item && item.validationReport);
  return report === null ? '' : text(report.reportId);
}

/**
 * 完整报告能不能算在这一跳头上。
 *
 * 三个条件缺一不可：报告 id 就是这一跳的简版报告号、报告自己记的工作项没说是别人、
 * 报告自己记的 attemptId 就是那条 validation.reported 的 submittedAttemptId。
 * 少判一条，一份 append-only 报告就会串到别的提交上——而它看起来只是「命令和计数」。
 */
function fullReportOf(item, opts, attribution) {
  const report = object(opts.validationReport);
  if (report === null) return null;
  if (attribution.submittedAttemptId === '') return null;
  if (text(report.id) === '' || text(report.id) !== reportIdOf(item)) return null;
  const workItemId = text(report.workItemId);
  if (workItemId !== '' && workItemId !== text(item.id)) return null;
  const attemptId = text(report.attemptId);
  if (attemptId !== '' && attemptId !== attribution.submittedAttemptId) return null;
  return report;
}

/**
 * 从命令输出尾里取计数。
 *
 * 只认整行形状（`# tests 2033` / `tests 2033` / `# pass 2033`），并且 tests 与 pass
 * 两个数都在才算数：只提到一个时拼出「tests 2033」会让人以为全过了，而实际可能是
 * 2033 条里 12 条失败。提不到就返回空串，绝不用常量填一个 2033。
 *
 * 行首允许任意非字字符（`#`、`ℹ` 这些不同 reporter 的记号）：把判定写死成 `#`，换一份
 * 输出就静默提不到计数，屏幕上只是少一行，没人会去查。
 */
function countsOf(outputTail) {
  let tests = null;
  let pass = null;
  for (const line of String(outputTail).split('\n')) {
    const t = /^\W*tests\s+(\d+)\s*$/.exec(line);
    if (t !== null) tests = Number(t[1]);
    const p = /^\W*pass\s+(\d+)\s*$/.exec(line);
    if (p !== null) pass = Number(p[1]);
  }
  if (tests === null || pass === null) return '';
  return `tests ${tests} · pass ${pass}`;
}

/**
 * 一条命令的定向/全量标签。
 *
 * 只看 argv，不从 argv 编数字：`node --test` 与带文件名的 `node --test x.test.ts` 跑的东西
 * 完全不同，计数差两个数量级，标签贴错了人会把定向的 68 当成全量跑了。
 */
function labelOfArgv(argv) {
  const line = argv.join(' ');
  if (line === 'node --test') return '全量';
  if (line.includes('.test.ts') || line.includes('.spec.ts')) return '定向';
  return '';
}

/**
 * 报告里真跑过的命令（argv 拼成一行）与它**各自**对得上的计数、标签。
 *
 * 三个数组等长同序。计数必须逐条取自己的 outputTail：共享一份计数时只有第一条有数，
 * 第二条（往往是全量）要么空白，要么把定向的 68 当成全量的结果——这也是为什么
 * 绝不把两条命令的数字相加，2033 与 68 是两个互不相干的运行。
 */
function ranCommandsOf(report) {
  const commands = [];
  const commandCounts = [];
  const labels = [];
  for (const check of list(report.checks)) {
    const c = object(check);
    if (c === null || text(c.kind) !== 'command') continue;
    const command = object(c.command);
    if (command === null) continue;
    const argv = list(command.argv).map(text).filter((part) => part !== '');
    if (argv.length === 0) continue;
    commands.push(argv.join(' '));
    // 提不到计数就是空串，不借别的命令的数顶上。
    commandCounts.push(typeof command.outputTail === 'string' ? countsOf(command.outputTail) : '');
    labels.push(labelOfArgv(argv));
  }
  return { commands, commandCounts, labels };
}

/**
 * 报告里可计量的变更行数，没有就是 null。
 *
 * `unknown` 点了名 changedLines 时视同没有：那时 used.changedLines 可能是个 0 占位，
 * 印出来就是「这一跳一行没改」。
 */
function changedLinesOf(report) {
  for (const check of list(report.checks)) {
    const c = object(check);
    if (c === null || text(c.kind) !== 'diff-size') continue;
    const size = object(c.diffSize);
    if (size === null) continue;
    const used = object(size.used);
    const lines = used === null ? undefined : used.changedLines;
    if (typeof lines !== 'number' || !Number.isFinite(lines)) continue;
    if (list(size.unknown).map(text).includes('changedLines')) continue;
    return lines;
  }
  return null;
}

function projectSubmission(item, currentReturned, attribution, opts) {
  const result = object(item && item.executionResult);
  const order = object(item && item.order);
  const commands = list(order && order.verification).map(text).filter((command) => command !== '');

  const verification = {
    fromOrder: true,
    // 这一行必须留在命令旁边：它决定那份清单是「跑过」还是「要求跑」。
    note: '工单要求，不是已跑结果',
    commands,
  };

  if (!currentReturned) {
    // 未交回时 executionResult 是上一跳的信：抄进 currentFiles 就成了「这一跳动了这些文件」。
    // 三处时间、已跑命令、行数同样一律未知：留着上一跳的报告只会把旧结论贴到这一跳头上。
    return {
      current: false,
      changedFiles: null,
      currentFiles: null,
      summary: null,
      reviewedExecution: null,
      fileCount: null,
      reportAttribution: null,
      submittedAtText: UNKNOWN,
      lineDeltaText: UNKNOWN,
      ranCommands: null,
      ranCommandCounts: null,
      ranLabels: null,
      verification,
    };
  }

  const files = result === null
    ? null
    : (Array.isArray(result.changedFiles) ? result.changedFiles.map(text) : null);
  const report = fullReportOf(item, opts, attribution);
  const ran = report === null ? { commands: [], commandCounts: [], labels: [] } : ranCommandsOf(report);
  const lines = report === null ? null : changedLinesOf(report);

  return {
    current: true,
    changedFiles: files,
    currentFiles: files,
    summary: result === null ? null : text(result.summary),
    reviewedExecution: reviewedExecutionOf(item, attribution.submittedAttemptId),
    // 文件数只数这一跳真是这份清单的条数：清单缺失时给 null，写 0 就是「没改文件」。
    fileCount: files === null ? null : files.length,
    // 报告归属：这一跳的结论是哪一份机器报告给的。没有报告就不命名，交给视图写「未知」。
    reportAttribution: reportIdOf(item) === '' ? null : `机器报告 ${reportIdOf(item)}`,
    submittedAtText: attribution.submittedAt === '' ? UNKNOWN : attribution.submittedAt,
    lineDeltaText: lines === null ? UNKNOWN : `${lines} 行`,
    // 已跑命令只来自归属对得上的完整报告；取不到就是 null（视图写未知），
    // 工单 verification 那份清单一律不填进来冒充已跑。
    ranCommands: ran.commands.length === 0 ? null : ran.commands,
    // 计数与标签逐条对齐 ranCommands；没有命令时一起给 null，别给三个长度不一的空数组。
    ranCommandCounts: ran.commands.length === 0 ? null : ran.commandCounts,
    ranLabels: ran.commands.length === 0 ? null : ran.labels,
    verification,
  };
}

/* ============================== 各层时间 ============================== */

/**
 * 每层的时刻。不取「现在」、不拿 updatedAt 顶替。
 *
 * 机器层与角色层用 activity 里的事件时刻（`validation.reported` / `review.recorded`），
 * 不用报告自己的 startedAt / endedAt 冒充这一层的事件时刻：那是「机器跑了多久」，
 * 不是「平台什么时候记下这份报告」，两者在排队时能差十几分钟。
 *
 * 事件链对不上时一律「未知」——写一个看起来合理的钟点比留空更让人信错。
 */
function timeTextOf(key, view, attribution) {
  const at = attribution === null ? NONE_ATTRIBUTION : attribution;
  const stringField = (source, field) => {
    const value = source === null ? undefined : source[field];
    return typeof value === 'string' ? value.trim() : '';
  };

  if (key === 'machine') return at.machineAt;
  if (key === 'role') return at.roleAt;
  if (key === 'final') {
    // 待检视时这一轮根本没有终审时刻；上一轮的 mergedAt 挂在这里就成了这一轮的时刻。
    if (text(view.status) === 'awaiting_review') return '';
    const finalReview = object(view.finalReview);
    if (finalReview === null || text(finalReview.verdict) !== 'merge') return '';
    return stringField(finalReview, 'mergedAt');
  }
  // 独立复核记录的 recordedAt、合入与 master 的时刻：工单没有把它们归入这一格，
  // 这里不借别的字段凑一个。
  return '';
}

/* ============================ 出口 ============================ */

/**
 * 一条 Mission 详情的投影。纯函数：不改入参、不读全局、不发请求。
 *
 * view 形状 = `/api/missions/:id` 的 MissionView（status / coordinationMode /
 * executionMode / independentReviews / finalReview / workItems[]）。
 * options = { selectedWorkItemId, activity, validationReport }：详情页当前点中的那一项、
 * 这条 Mission 的活动流（时间与提交归属的唯一来源）、以及 `/validation-reports/:id`
 * 取回来的完整报告（已跑命令、计数与行数的唯一来源）。三者缺省时行为与从前一致：
 * 没有 activity 就不编时间，没有报告就不编命令与计数。
 *
 * 没有所选工作项（没点、或点到的 id 不在 workItems 里）时六层照样返回：页面结构不能
 * 因为一个对不上的 id 就塌掉，但机器与角色两层必须是「未开始」并写明没有所选工作项——
 * 拿任何一项的结论顶上，就是在说一张没被选中的工单的交付情况。
 */
export function projectDelivery(view, options) {
  const v = object(view) ?? {};
  const opts = object(options) ?? {};
  const items = list(v.workItems);
  const item = selectItem(items, opts.selectedWorkItemId);

  const currentReturned = item !== null && RETURNED_STATUSES.has(text(item.status));
  // 未交回时连归属都不算：dispatched 上留着的报告与事件链属于上一跳，
  // 算出来再画上去就是把旧结论贴到这一跳头上。
  const attribution = currentReturned ? attributionOf(item, opts.activity, text(item.status)) : null;

  const layers = [
    machineLayer(item, currentReturned),
    roleLayer(v.coordinationMode, item, currentReturned),
    independentLayer(v),
    finalLayer(v),
    integrationLayer(v),
    masterLayer(),
  ].map((built) => ({ ...built, timeText: timeTextOf(built.key, v, attribution) || UNKNOWN }));

  return {
    selectedWorkItemId: item === null ? null : text(item.id),
    currentReturned,
    layers,
    submission: projectSubmission(item, currentReturned, attribution ?? NONE_ATTRIBUTION, opts),
  };
}
