/**
 * 事件翻译表（src/web/narrate.js）。
 *
 * 这个文件是契约里那 17 条翻译的**可执行版本**：谁把某条 kind 的文案改没了、
 * 或者加了一条新 kind 却忘了翻译，都在这里红。界面不会红——界面只会悄悄
 * 显示一行机器名，而没人会把那个当 bug 报。所以断言必须写在事件这一层。
 *
 * 三条底线单独各占一条：
 *   1. 每一种 kind 的 badge 与 action 逐字对得上契约；
 *   2. 把已翻译的结果全拼起来，不得出现任何机器事件名；
 *   3. 未翻译的 kind 必须自己报出 kind，且带「未翻译」——不能渲染成空白。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { serveStatic } from '../src/api/static.ts';

import {
  END_REASON,
  PLATFORM_ROLE_LABEL,
  STAGE_CN,
  WAIT_REASON,
  commandCountLabel,
  commandDetail,
  endReasonText,
  finalReviewSummary,
  fieldLabel,
  formatAttemptId,
  formatUsage,
  isRuntimeCommand,
  narrateEvent,
  nowDoing,
  reasonText,
  roleBadge,
  roleOfAttempt,
  roleTone,
  roleUsageLine,
  revisionLabel,
  stageName,
  stateLabel,
  usageLine,
} from '../src/web/narrate.js';

/** 契约翻译表里出现过的全部机器事件名：界面上一个都不许露头。 */
const MACHINE_KINDS = [
  'mission.created',
  'attempt.started',
  'plan.updated',
  'work_item.created',
  'work_item.dispatched',
  'work_item.retired',
  'evidence.submitted',
  'execution_result.submitted',
  'review.recorded',
  'escalation.raised',
  'mission_result.submitted',
  'attempt.ended',
  'contract.revised',
  'final_review.merged',
  'mission.waiting',
  'mission.resumed',
  'orchestration.round.started',
  'memory.applied',
  'delivery.created',
  'final_review.integration_anchor',
  'final_review.integration_verified',
  'final_review.merge_applied',
  'work_item.redispatched',
  'change.receipt_recorded',
];

/** 一条真 Mission 会喂给页面的 ctx（形状取自 MissionView）。 */
const CTX = {
  intent: '把三个页面从状态转储改成人话',
  plan: { direction: '先落翻译表，再改页面', findings: '事件表散在渲染分支里' },
  workItems: [
    { id: 'W-465', title: '事件翻译表' },
    { id: 'W-466', title: '用量拆项' },
  ],
  result: { summary: '三个页面都改好了', outcome: 'delivered' },
};

/**
 * 契约里的每一条 kind + 一份合法事件。attempt.started 两种角色各一条，
 * escalation.raised 与平台真实的 escalated 各一条——只认一个的话，
 * 另一个在界面上就是机器名。
 */
const CASES = [
  {
    name: 'mission.created',
    event: { kind: 'mission.created', data: { contractRevision: 1 } },
    badge: 'L3 → L2',
    action: '发起任务',
    detailHas: ['把三个页面从状态转储改成人话'],
  },
  {
    name: 'attempt.started（协调者）',
    event: { kind: 'attempt.started', data: { kind: 'coordinator' }, attemptId: 'coord-2' },
    badge: 'L2',
    action: '协调者接手',
    detailHas: [],
  },
  {
    name: 'attempt.started（执行者）',
    event: {
      kind: 'attempt.started',
      data: { kind: 'executor' },
      workItemId: 'W-465',
      attemptId: 'W-465.exec-1',
    },
    badge: 'L1',
    action: '执行者开工',
    detailHas: ['事件翻译表'],
  },
  {
    name: 'plan.updated',
    event: { kind: 'plan.updated', data: { planRevision: 2 }, planRevision: 2 },
    badge: 'L2',
    action: '写回调查结论',
    detailHas: ['先落翻译表，再改页面'],
  },
  {
    name: 'work_item.created',
    event: { kind: 'work_item.created', data: { title: '事件翻译表' }, workItemId: 'W-465' },
    badge: 'L2',
    action: '拆出工作项',
    detailHas: ['事件翻译表'],
  },
  {
    name: 'work_item.dispatched',
    event: { kind: 'work_item.dispatched', data: { ids: ['W-465', 'W-466'] }, attemptId: 'coord-2' },
    badge: 'L2 → L1',
    action: '派发工作项',
    detailHas: ['事件翻译表', '用量拆项'],
  },
  {
    name: 'work_item.retired',
    event: { kind: 'work_item.retired', data: { reason: '契约改了，这项工作不做' }, workItemId: 'W-465' },
    badge: 'L2',
    action: '作废工作项',
    detailHas: ['契约改了，这项工作不做'],
  },
  {
    name: 'evidence.submitted',
    event: {
      kind: 'evidence.submitted',
      data: { evidenceId: 'E-7', kind: 'command', exitCode: 0 },
      workItemId: 'W-465',
      attemptId: 'W-465.exec-1',
    },
    badge: 'L1',
    action: '提交证据',
    detailHas: ['command', '0'],
  },
  {
    name: 'execution_result.submitted',
    event: {
      kind: 'execution_result.submitted',
      data: { outcome: 'completed', changedFiles: 2 },
      workItemId: 'W-465',
      attemptId: 'W-465.exec-1',
    },
    badge: 'L1 → L2',
    action: '交回结果',
    detailHas: ['completed'],
  },
  {
    name: 'review.recorded（通过）',
    event: {
      kind: 'review.recorded',
      data: { verdict: 'accept', reasons: ['测试跑过了'] },
      workItemId: 'W-465',
      attemptId: 'coord-2',
    },
    badge: 'L2',
    action: '技术验收：通过',
    detailHas: ['测试跑过了'],
  },
  {
    name: 'review.recorded（打回）',
    event: {
      kind: 'review.recorded',
      data: { verdict: 'reject', reasons: ['少了一条未知 kind 的兜底'] },
      workItemId: 'W-465',
      attemptId: 'coord-2',
    },
    badge: 'L2',
    action: '技术验收：打回',
    detailHas: ['少了一条未知 kind 的兜底'],
  },
  {
    name: 'escalation.raised',
    event: { kind: 'escalation.raised', data: { question: '要不要保留旧页面？' }, attemptId: 'coord-2' },
    badge: 'L2 → L3',
    action: '升级提问',
    detailHas: ['要不要保留旧页面？'],
  },
  {
    name: 'escalated（平台真实 kind）',
    event: { kind: 'escalated', data: { question: '要不要保留旧页面？' }, attemptId: 'coord-2' },
    badge: 'L2 → L3',
    action: '升级提问',
    detailHas: ['要不要保留旧页面？'],
  },
  {
    name: 'mission_result.submitted',
    event: {
      kind: 'mission_result.submitted',
      data: { outcome: 'delivered', missionStatus: 'awaiting_review' },
      attemptId: 'coord-2',
    },
    badge: 'L2 → L3',
    action: '交卷',
    detailHas: ['三个页面都改好了'],
  },
  {
    name: 'attempt.ended（协调者）',
    event: { kind: 'attempt.ended', data: { endedBy: 'structured_submit' }, attemptId: 'coord-2' },
    badge: 'L2',
    action: '这一跳结束',
    detailHas: ['正常交了结果'],
  },
  {
    name: 'attempt.ended（执行者）',
    event: { kind: 'attempt.ended', data: { endedBy: 'no_structured_result' }, attemptId: 'W-465.exec-1' },
    badge: 'L1',
    action: '这一跳结束',
    detailHas: ['跑完了却没交结果'],
  },
  {
    name: 'contract.revised',
    event: { kind: 'contract.revised', data: { contractRevision: 3, status: 'planning' } },
    badge: 'L3',
    action: '改了契约',
    detailHas: ['契约 r3'],
  },
  {
    name: 'final_review.merged',
    event: { kind: 'final_review.merged', data: { mergedInto: 'main', reasons: [] } },
    badge: 'L3',
    action: '放行并落地',
    detailHas: [],
  },
  {
    name: 'mission.waiting',
    event: { kind: 'mission.waiting', data: { reason: 'project_busy' }, },
    badge: 'L2',
    action: '暂停',
    detailHas: ['改动名额'],
  },
  {
    name: 'mission.resumed',
    event: { kind: 'mission.resumed', data: { reason: undefined, detail: undefined } },
    badge: 'L2',
    action: '又动起来了',
    detailHas: [],
  },
  {
    name: 'orchestration.round.started',
    event: { kind: 'orchestration.round.started', data: { schemaVersion: 1 } },
    badge: '平台',
    action: '开始新一轮调度',
    detailHas: ['预算'],
  },
  {
    name: 'memory.applied',
    event: { kind: 'memory.applied', data: { written: ['specs/web-shell.md', 'VIBE.md'] } },
    badge: '平台',
    action: '写入项目记忆',
    detailHas: ['VIBE.md'],
  },
  {
    name: 'delivery.created',
    event: { kind: 'delivery.created', data: { deliveryId: 'D-12' } },
    badge: '平台',
    action: '投进收件箱',
    detailHas: ['D-12'],
  },
  {
    name: 'final_review.integration_anchor',
    event: {
      kind: 'final_review.integration_anchor',
      data: { integrationBranch: 'auto/harness', anchor: 'abc123def' },
    },
    badge: 'L3',
    action: '记下集成锚点',
    detailHas: ['auto/harness'],
  },
  {
    name: 'final_review.integration_verified',
    event: {
      kind: 'final_review.integration_verified',
      data: { reportId: 'IVAL-3', passed: true, mergedInto: 'deadbeef' },
    },
    badge: 'L3',
    action: '集成验证通过',
    detailHas: ['IVAL-3'],
  },
  {
    name: 'final_review.merge_applied',
    event: {
      kind: 'final_review.merge_applied',
      data: { integrationBranch: 'auto/harness', mergedInto: 'cafebabe', anchor: 'abc123def' },
    },
    badge: 'L3',
    action: '合进集成分支',
    detailHas: ['cafebabe'],
  },
  {
    name: 'work_item.redispatched',
    event: {
      kind: 'work_item.redispatched',
      data: { ids: ['W-465'], reason: 'escalation_answered' },
      workItemId: 'W-465',
    },
    badge: 'L3 → L1',
    action: '重新派发工作项',
    detailHas: ['事件翻译表'],
  },
  {
    name: 'change.receipt_recorded',
    event: {
      kind: 'change.receipt_recorded',
      data: { changeId: 'CR-1', layer: 'session_consumed', workItemId: 'W-465' },
      workItemId: 'W-465',
    },
    badge: 'L1 执行',
    action: '变更回执：已进入会话',
    detailHas: ['CR-1', '不等于已应用或已验证'],
  },
];

/* ============================ 文件形状 ============================ */

describe('叙事模块的加载与文件形状', () => {
  const path = fileURLToPath(new URL('../src/web/narrate.js', import.meta.url));

  test('文件在 src/web/ 下，名字满足静态服务的 SAFE_NAME', () => {
    assert.ok(existsSync(path), '缺 src/web/narrate.js');
    // 服务端的 SAFE_NAME 只认一层扁平小写文件名。名字里混进大写或斜杠，
    // 浏览器拿到的就是 404，而这条 404 在控制台之外没人看得见。
    const name = path.split(/[\\/]/).pop() as string;
    assert.match(name, /^[a-z0-9][a-z0-9._-]*\.(html|css|js|svg)$/);
  });

  test('真静态服务认得 /narrate.js（浏览器那边不是 404）', () => {
    const calls: { status?: number; headers?: Record<string, string>; body?: unknown } = {};
    const res = {
      writeHead(status: number, headers: Record<string, string>) {
        calls.status = status;
        calls.headers = headers;
      },
      end(body: unknown) {
        calls.body = body;
      },
    };
    assert.equal(serveStatic('/narrate.js', res as never), true, '/narrate.js 没被静态服务认下');
    assert.equal(calls.status, 200);
    assert.equal(calls.headers?.['content-type'], 'text/javascript; charset=utf-8');
    assert.match(String(calls.body), /export function narrateEvent/);
  });

  test('不拼 HTML、不 esc、不碰 DOM —— 这一层只回字符串', () => {
    const source = readFileSync(path, 'utf8');
    // document.proposal_changed 是合法事件名；检查 DOM 引用，不能误伤字符串键。
    const code = source.replace(/'[^']*'|"[^"]*"/g, '');
    assert.ok(!/\bdocument\s*(?:\.|\[)/.test(code), 'narrate.js 不应调用 DOM document');
    for (const forbidden of ['innerHTML', 'esc(', 'fetch(', 'Date.now', 'new Date']) {
      assert.ok(!source.includes(forbidden), `narrate.js 里不该出现 ${forbidden}`);
    }
  });

  test('导出的都是函数或纯数据表', async () => {
    for (const [name, value] of Object.entries({
      narrateEvent,
      formatAttemptId,
      formatUsage,
      usageLine,
      fieldLabel,
      revisionLabel,
      stateLabel,
      reasonText,
      nowDoing,
      endReasonText,
      roleOfAttempt,
      roleBadge,
      roleTone,
      stageName,
      roleUsageLine,
      isRuntimeCommand,
      commandCountLabel,
      commandDetail,
      finalReviewSummary,
    })) {
      assert.equal(typeof value, 'function', `${name} 要是函数`);
    }
    assert.equal(typeof STAGE_CN, 'object');
    assert.equal(typeof WAIT_REASON, 'object');
    assert.equal(typeof PLATFORM_ROLE_LABEL, 'string');
    assert.equal(PLATFORM_ROLE_LABEL, '平台');
  });
});

/* ============================ 事件表 ============================ */

describe('事件翻译表：逐条对契约', () => {
  for (const c of CASES) {
    test(`${c.name} → ${c.badge} / ${c.action}`, () => {
      const out = narrateEvent(c.event, CTX);
      assert.equal(out.badge, c.badge);
      assert.equal(out.action, c.action);
      assert.equal(out.untranslated, false);
      // 三件套一件都不许空：空行在界面上和"这条事件没内容"长得一样，
      // 而真实原因是翻译表漏了它。
      for (const field of ['badge', 'action', 'detail']) {
        assert.equal(typeof out[field], 'string', `${field} 要是字符串`);
        assert.notEqual(out[field].trim(), '', `${field} 不能是空白`);
        assert.ok(!out[field].includes('undefined'), `${field} 里漏了 undefined`);
        assert.ok(!out[field].includes('null'), `${field} 里漏了 null`);
      }
      for (const fragment of c.detailHas) {
        assert.ok(out.detail.includes(fragment), `detail 里该有「${fragment}」，实际是「${out.detail}」`);
      }
    });
  }

  test('attempt.started 没有 data.kind 时：coord- 前缀当协调者，有 workItemId 当执行者', () => {
    const coord = narrateEvent({ kind: 'attempt.started', attemptId: 'coord-1' }, CTX);
    assert.equal(coord.badge, 'L2');
    assert.equal(coord.action, '协调者接手');

    const exec = narrateEvent(
      { kind: 'attempt.started', attemptId: 'W-466.exec-1', workItemId: 'W-466' },
      CTX,
    );
    assert.equal(exec.badge, 'L1');
    assert.equal(exec.action, '执行者开工');
    assert.equal(exec.detail, '用量拆项');
  });

  test('执行者知道 workItemId 但 ctx 里查不到标题时，detail 退回 workItemId', () => {
    const out = narrateEvent(
      { kind: 'attempt.started', data: { kind: 'executor' }, workItemId: 'W-999', attemptId: 'W-999.exec-1' },
      { workItems: [] },
    );
    assert.equal(out.detail, 'W-999');
  });

  test('缺 ctx 时用可读的退回，不出现 undefined/null/空白', () => {
    const calls = [
      narrateEvent({ kind: 'mission.created' }),
      narrateEvent({ kind: 'attempt.started', data: { kind: 'executor' }, workItemId: 'W-465' }),
      narrateEvent({ kind: 'plan.updated', data: {} }),
      narrateEvent({ kind: 'work_item.dispatched', data: { ids: ['W-465'] } }),
      narrateEvent({ kind: 'mission_result.submitted', data: { outcome: 'blocked' } }),
      narrateEvent({ kind: 'evidence.submitted', data: { kind: 'test' } }),
      narrateEvent({ kind: 'execution_result.submitted', data: {} }),
      narrateEvent({ kind: 'mission.waiting', data: {} }),
    ];
    for (const out of calls) {
      assert.ok(out.detail.trim().length > 0, `detail 退回失败：${JSON.stringify(out)}`);
      assert.ok(!/undefined|null/.test(out.detail), `detail 里漏了机器值：${out.detail}`);
    }
    assert.equal(narrateEvent({ kind: 'mission.created' }).detail, '（没有契约）');
  });

  test('未知 kind：untranslated=true，带 kind 本身与「未翻译」，不是空白', () => {
    // 用确定不在表里的名字。曾经拿 memory.applied / mission.paused 当未知样例，
    // 表一补上这条就变成「翻译了还标未翻译」——那是在锁错误形状。
    for (const kind of ['this.kind.does.not.exist', 'mission.totally_fake', '']) {
      const out = narrateEvent({ kind, data: {} });
      assert.equal(out.untranslated, true);
      assert.equal(out.badge, '未翻译');
      const whole = out.badge + out.action + out.detail;
      assert.ok(whole.includes('未翻译'), `没标未翻译：${whole}`);
      assert.ok(whole.trim().length > 0, '整段不能是空白');
      if (kind) assert.ok(whole.includes(kind), `没带上 kind：${whole}`);
    }
  });

  test('change.impact_decided：三结论都只是判断、未应用；cancel_replace 说的是「需取消替换」；未知结论安全退回', () => {
    const data = { changeId: 'CR-1', workItemId: 'W-465', attemptId: 'W-465.exec-1', affectedAcceptance: [1] };
    const cases = [
      { decision: 'compatible', label: '兼容照跑' },
      { decision: 'replan', label: '需重排' },
      { decision: 'cancel_replace', label: '需取消替换' },
    ];
    for (const c of cases) {
      const out = narrateEvent(
        { kind: 'change.impact_decided', data: { ...data, decision: c.decision } },
        CTX,
      );
      assert.equal(out.untranslated, false);
      assert.equal(out.badge, 'L2 协调');
      assert.ok(out.action.includes(c.label), `action 该说「${c.label}」：${out.action}`);
      assert.ok(out.detail.includes('CR-1'), out.detail);
      // 只是判断：不许出现「已取消 / 已重排 / 已应用 / 已处理」这种落地说法。
      assert.ok(/只是判断/.test(out.detail), out.detail);
      assert.ok(/尚未应用/.test(out.detail), out.detail);
      assert.ok(
        !/已(?:取消|重排|应用|处理)/.test(`${out.badge}${out.action}${out.detail}`),
        `不许把判断写成已落地：${out.action} / ${out.detail}`,
      );
    }

    // 认不出的结论：原样带回、仍标只是判断，不替调用方编一个说法。
    const unknown = narrateEvent(
      { kind: 'change.impact_decided', data: { ...data, decision: 'no_such_decision', affectedAcceptance: [] } },
      CTX,
    );
    assert.equal(unknown.untranslated, false);
    assert.ok(unknown.action.includes('no_such_decision'), unknown.action);
    assert.ok(/只是判断/.test(unknown.detail), unknown.detail);
    for (const field of ['badge', 'action', 'detail']) {
      assert.notEqual(unknown[field].trim(), '', `${field} 不能空白`);
      assert.ok(!/undefined|null/.test(unknown[field]), `${field} 漏了机器值：${unknown[field]}`);
    }

    // 连结论字段都没有：退回「没有结论」，仍不空、仍只是判断。
    const missing = narrateEvent({ kind: 'change.impact_decided', data: {} }, CTX);
    assert.ok(missing.action.includes('没有结论'), missing.action);
    assert.ok(/只是判断/.test(missing.detail), missing.detail);
  });

  test('change.receipt_recorded：三层都只说收到，不等于已应用或已验证；未知层仍翻译', () => {
    const data = { changeId: 'CR-1', workItemId: 'W-465', attemptId: 'W-465.exec-1' };
    const cases = [
      { layer: 'adapter_received', label: '执行侧已收到' },
      { layer: 'session_consumed', label: '已进入会话' },
      { layer: 'executor_started', label: '执行者自述已按差异继续' },
    ];
    for (const c of cases) {
      const out = narrateEvent(
        { kind: 'change.receipt_recorded', data: { ...data, layer: c.layer } },
        CTX,
      );
      assert.equal(out.untranslated, false);
      assert.equal(out.badge, 'L1 执行');
      assert.ok(out.action.includes(c.label), `action 该说「${c.label}」：${out.action}`);
      assert.ok(out.detail.includes('CR-1'), out.detail);
      // 回执没有验收层：不许出现「已应用 / 已验证 / 已处理」这种落地说法。
      assert.ok(/不等于已应用或已验证/.test(out.detail), out.detail);
      // 扣掉那句明确否定之后再扫：否定句本身含「已应用 / 已验证」四个字，
      // 不扣的话这条断言永远只能写在纸面上——那才是把门槛降没了。
      const claims = `${out.badge}${out.action}${out.detail}`.replace(/不等于已应用或已验证/g, '');
      assert.ok(
        !/已(?:应用|验证|处理)/.test(claims),
        `不许把回执写成已落地：${out.action} / ${out.detail}`,
      );
      assert.ok(
        !`${out.badge}${out.action}${out.detail}`.includes('receipt_recorded'),
        `漏出了机器事件名：${out.badge} / ${out.action} / ${out.detail}`,
      );
      for (const field of ['badge', 'action', 'detail']) {
        assert.notEqual(out[field].trim(), '', `${field} 不能空白`);
        assert.ok(!/undefined|null/.test(out[field]), `${field} 漏了机器值：${out[field]}`);
      }
    }

    // 认不出的层（含 verified）：仍翻译、仍不带验收结论，不替调用方下结论。
    const unknown = narrateEvent(
      { kind: 'change.receipt_recorded', data: { ...data, layer: 'verified' } },
      CTX,
    );
    assert.equal(unknown.untranslated, false);
    assert.ok(unknown.action.includes('verified'), unknown.action);
    assert.ok(/不等于已应用或已验证/.test(unknown.detail), unknown.detail);
  });

  test('整体：已翻译结果的 badge+action+detail 里不出现任何机器事件名', () => {
    const rendered = CASES.map((c) => {
      const out = narrateEvent(c.event, CTX);
      return `${out.badge} ${out.action} ${out.detail}`;
    });
    const blob = rendered.join('\n');
    for (const kind of MACHINE_KINDS) {
      assert.ok(!blob.includes(kind), `界面上漏出了机器事件名「${kind}」：\n${blob}`);
    }
    assert.equal(rendered.length, CASES.length);
  });
});

/* ============================ 环节名 ============================ */

describe('stageName：一组事件 → 环节名', () => {
  const wi = [
    { id: 'W-1649', title: '把观测面接上读模型' },
    { id: 'W-1650', title: '修好跳库的用例' },
  ];
  const ctx = { workItems: wi };

  test('协调者组名从组内 kind 推出，多个用顿号按固定顺序连', () => {
    // 只有规划+派发。
    assert.equal(
      stageName([
        { attemptId: 'coord-1', kind: 'plan.updated' },
        { attemptId: 'coord-1', kind: 'work_item.created' },
        { attemptId: 'coord-1', kind: 'work_item.dispatched' },
      ], ctx),
      '调查与规划、派发',
    );
    // 验收+派发（调查与规划没参与）——只写验收与派发，不倒回“规划”。
    assert.equal(
      stageName([
        { attemptId: 'coord-2', kind: 'review.recorded' },
        { attemptId: 'coord-2', kind: 'work_item.dispatched' },
      ], ctx),
      '技术验收、派发',
    );
    // 四种齐，按固定顺序而不是事件到达顺序。
    assert.equal(
      stageName([
        { attemptId: 'coord-3', kind: 'mission_result.submitted' },
        { attemptId: 'coord-3', kind: 'work_item.dispatched' },
        { attemptId: 'coord-3', kind: 'review.recorded' },
        { attemptId: 'coord-3', kind: 'plan.updated' },
      ], ctx),
      '调查与规划、技术验收、派发、交卷',
    );
  });

  test('四种 kind 都没有时退回「协调」，不空也不露 attemptId', () => {
    const out = stageName([{ attemptId: 'coord-9', kind: 'attempt.started' }], ctx);
    assert.equal(out, '协调');
    assert.equal(out.includes('coord-9'), false);
    assert.ok(out.trim().length > 0);
  });

  test('执行者组 → 执行 · <标题>；查不到标题用 id', () => {
    assert.equal(
      stageName([{ attemptId: 'W-1649.exec-1', workItemId: 'W-1649', kind: 'attempt.started' }], ctx),
      '执行 · 把观测面接上读模型',
    );
    assert.equal(
      stageName([{ attemptId: 'W-9999.exec-1', workItemId: 'W-9999', kind: 'attempt.started' }], ctx),
      '执行 · W-9999',
    );
  });

  test('没有 attemptId 的那一组 → L3 检视者', () => {
    assert.equal(stageName([{ kind: 'mission.created' }, { kind: 'final_review.merged' }], ctx), 'L3 检视者');
  });

  test('环节名里不出现机器事件名', () => {
    const names = [
      stageName([{ attemptId: 'coord-1', kind: 'plan.updated' }], ctx),
      stageName([{ attemptId: 'coord-1', kind: 'work_item.dispatched' }], ctx),
      stageName([{ attemptId: 'coord-1', kind: 'mission_result.submitted' }], ctx),
      stageName([{ attemptId: 'W-1649.exec-1', workItemId: 'W-1649' }], ctx),
      stageName([{ kind: 'mission.created' }], ctx),
    ];
    for (const n of names) {
      for (const kind of MACHINE_KINDS) {
        assert.equal(n.includes(kind), false, `环节名「${n}」里漏出机器事件名 ${kind}`);
      }
    }
  });
});

describe('环节角色与取色', () => {
  test('coord → coordinator/L2 协调/queued，.exec- → executor/L1 执行/running，无 id → reviewer/L3/unconfirmed', () => {
    assert.equal(roleOfAttempt('coord-1'), 'coordinator');
    assert.equal(roleOfAttempt('W-1649.exec-1'), 'executor');
    assert.equal(roleOfAttempt(''), 'reviewer');
    assert.equal(roleOfAttempt(undefined), 'reviewer');

    assert.equal(roleBadge('coordinator'), 'L2 协调');
    assert.equal(roleBadge('executor'), 'L1 执行');
    assert.equal(roleBadge('reviewer'), 'L3 检视者');

    // 与 projects.js stageTone 同一套 status token：investigating/planning→queued、
    // executing→running、awaiting_review→unconfirmed。
    assert.equal(roleTone('coordinator'), 'queued');
    assert.equal(roleTone('executor'), 'running');
    assert.equal(roleTone('reviewer'), 'unconfirmed');
  });

  test('角色徒章/用量行不露英文角色键、不出现 undefined', () => {
    for (const role of ['coordinator', 'executor', 'reviewer']) {
      assert.equal(roleBadge(role).includes(role), false, `${role} 直接上了屏`);
      const line = roleUsageLine(role, 1000, 74, '$0.1234');
      assert.ok(line.includes('74%'), line);
      assert.ok(line.includes('$0.1234'), line);
      assert.equal(line.includes('undefined'), false, line);
    }
    // 零用量也得是一句人话，不能退化成 undefined/NaN。
    const zero = roleUsageLine('coordinator', 0, 0, '');
    assert.match(zero, /占比 0%/);
    assert.equal(zero.includes('undefined') || zero.includes('NaN'), false, zero);
  });
});

/* ============================ 尝试 ID ============================ */

describe('formatAttemptId', () => {
  test('W-465.exec-1 → 工作项 W-465 · 执行者第 1 次尝试', () => {
    const out = formatAttemptId('W-465.exec-1');
    assert.equal(out.label, '工作项 W-465 · 执行者第 1 次尝试');
    assert.equal(out.raw, 'W-465.exec-1');
  });

  test('coord-2 → 协调者第 2 次尝试，raw 原样', () => {
    const out = formatAttemptId('coord-2');
    assert.equal(out.label, '协调者第 2 次尝试');
    assert.equal(out.raw, 'coord-2');
  });

  test('对不上的原样带出，不猜', () => {
    assert.equal(formatAttemptId('exec-9').label, '尝试 exec-9');
    assert.equal(formatAttemptId('exec-9').raw, 'exec-9');
    assert.equal(formatAttemptId('随便一串').label, '尝试 随便一串');
    assert.ok(formatAttemptId(undefined).label.trim().length > 0, '没有编号也不能是空白');
  });
});

/* ============================ 用量 ============================ */

describe('formatUsage / usageLine', () => {
  test('新增 = total - cacheRead，缓存占比高时给出说明', () => {
    const f = formatUsage({ input: 100, output: 50, cacheRead: 850, cacheWrite: 0, total: 1000, cost: 1.2345 });
    assert.equal(f.added, 150);
    assert.equal(f.cached, 850);
    assert.equal(f.cacheRatio, 0.85);
    assert.equal(f.cachePctText, '85%');
    assert.equal(f.costText, '$1.2345');
    assert.ok(f.note.includes('缓存部分计费便宜得多'), `note 该说明缓存便宜：${f.note}`);
  });

  test('费用未上报时明说，不显示 $0.0000', () => {
    const f = formatUsage({ input: 10, output: 5, cacheRead: 5, cacheWrite: 0, total: 20 });
    assert.equal(f.costText, '费用未上报');
    assert.equal(f.note, '');
  });

  test('缺 total 时按 input+output+cacheWrite 推新增', () => {
    const f = formatUsage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 5 });
    assert.equal(f.added, 20);
    assert.equal(f.cached, 0);
    assert.equal(f.cacheRatio, 0);
  });

  test('total=0 时不报占比、不给缓存说明', () => {
    const f = formatUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
    assert.equal(f.added, 0);
    assert.equal(f.cacheRatio, 0);
    assert.equal(f.cachePctText, '0%');
    assert.equal(f.note, '');
    assert.equal(f.costText, '$0.0000');
  });

  test('缺失字段当 0，不吐 NaN/undefined', () => {
    const f = formatUsage(undefined);
    for (const key of ['added', 'cached', 'cacheRatio']) assert.equal(f[key], 0);
    assert.equal(f.costText, '费用未上报');
  });

  test('usageLine 一句话里同时有新增、缓存命中、占比与费用', () => {
    const line = usageLine({ input: 100, output: 50, cacheRead: 850, cacheWrite: 0, total: 1000, cost: 1.2345 });
    for (const fragment of ['新增', '缓存命中', '85%', '$1.2345']) {
      assert.ok(line.includes(fragment), `usageLine 里该有「${fragment}」：${line}`);
    }
    const noCost = usageLine({ input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20 });
    assert.ok(noCost.includes('费用未上报'));
    assert.ok(noCost.includes('%'));
  });
});

/* ============================ 内部词 ============================ */

describe('内部词与版本号', () => {
  test('fieldLabel 给出人话标签', () => {
    assert.equal(fieldLabel('attempt'), '尝试');
    assert.equal(fieldLabel('causationId'), '由哪一跳引发');
    assert.equal(fieldLabel('profileId'), '候选');
    assert.equal(fieldLabel('ExecutionProfile'), '运行时');
    assert.equal(fieldLabel('WorkItem'), '工作项');
  });

  test('认不出来的 key 原样回显，不吞掉', () => {
    assert.equal(fieldLabel('somethingNew'), 'somethingNew');
  });

  test('revisionLabel', () => {
    assert.equal(revisionLabel('plan', 2), '规划 r2');
    assert.equal(revisionLabel('contract', 3), '契约 r3');
  });
});

/* ============================ 阶段 / 状态 ============================ */

describe('阶段与状态是两根轴', () => {
  test('STAGE_CN 与项目页逐字一致', () => {
    assert.deepEqual(STAGE_CN, {
      investigating: '调查中',
      planning: '规划中',
      executing: '执行中',
      awaiting_review: '等你检视',
      completed: '已完成',
      blocked: '已中止',
    });
  });

  test('stateLabel 的四个分支', () => {
    assert.equal(stateLabel({ paused: true, status: 'executing' }), '已暂停');
    assert.equal(stateLabel({ waitReason: 'project_busy', status: 'executing' }), '等待中');
    assert.equal(stateLabel({ status: 'completed' }), '已结束');
    assert.equal(stateLabel({ status: 'blocked' }), '已停止');
    assert.equal(stateLabel({ status: 'executing' }), '进行中');
  });

  test('状态词与阶段词一个都不撞', () => {
    const stages = Object.values(STAGE_CN);
    for (const status of ['executing', 'completed', 'blocked', 'awaiting_review']) {
      const word = stateLabel({ status });
      assert.ok(!stages.includes(word), `状态词「${word}」和阶段词撞了`);
    }
    assert.notEqual(stateLabel({ status: 'completed' }), STAGE_CN.completed);
    assert.notEqual(stateLabel({ status: 'blocked' }), STAGE_CN.blocked);
  });

  test('WAIT_REASON 与项目页一致，waitDetail 优先', () => {
    assert.deepEqual(Object.keys(WAIT_REASON).sort(), [
      'attempt_limit_reached',
      'base_revision_stale',
      'cancelled_by_user',
      'escalated',
      'execution_budget_exceeded',
      'mission_cost_cap_reached',
      'no_available_agent',
      'platform_unreachable',
      'project_busy',
      'runaway_suspected',
      'target_changed',
      'waiting_l3',
      'work_item_checkpoint',
    ]);
    assert.equal(reasonText({ waitDetail: '卡在 exec-a', waitReason: 'no_available_agent' }), '卡在 exec-a');
    assert.equal(reasonText({ waitReason: 'project_busy' }), WAIT_REASON.project_busy);
    assert.equal(reasonText({ waitReason: 'something_new' }), 'something_new');
    assert.equal(reasonText({}), '');
  });

  test('runaway_suspected 翻成人话，不露英文键', () => {
    // 漏这一条的形态：界面上停机原因那一栏直接写着 runaway_suspected。
    const out = reasonText({ waitReason: 'runaway_suspected' });
    assert.equal(out, '一跳跑太久，已停下来等人看');
    assert.equal(out.includes('runaway_suspected'), false, out);
    // nowDoing 也走同一张表，不该在那里漏出机器键。
    assert.equal(nowDoing({ status: 'executing', waitReason: 'runaway_suspected' }).includes('runaway_suspected'), false);
  });

  test('endedBy 中文覆盖六种，未知原样', () => {
    for (const reason of Object.keys(END_REASON)) {
      const out = endReasonText(reason);
      assert.ok(out.trim().length > 0, `${reason} 没翻译`);
      assert.ok(!out.includes(reason), `${reason} 没有被翻成人话：${out}`);
    }
    assert.equal(endReasonText('structured_submit'), '正常交了结果');
    assert.equal(endReasonText('something_new'), 'something_new');
  });
});

/* ============================ 现在在干什么 ============================ */

describe('nowDoing 说人话，不说机器状态名', () => {
  test('调查中且没拆工作项', () => {
    assert.equal(nowDoing({ status: 'investigating', workItems: [] }), '协调者还在调查，没拆工作项');
  });

  test('执行中：在跑哪个工作项、哪个角色', () => {
    const line = nowDoing({
      status: 'executing',
      workItems: [{ id: 'W-465', title: '事件翻译表', status: 'dispatched' }],
    });
    assert.ok(line.includes('事件翻译表'), line);
    assert.ok(line.includes('执行者'), line);
  });

  test('等待：暂停与停机原因各有说法', () => {
    assert.equal(nowDoing({ status: 'executing', paused: true, workItems: [] }), '在等暂停结束');
    const waiting = nowDoing({ status: 'executing', waitReason: 'project_busy', workItems: [] });
    assert.ok(waiting.includes('在等'), waiting);
    assert.ok(waiting.includes(WAIT_REASON.project_busy), waiting);
    const waitingDetail = nowDoing({ status: 'executing', waitReason: 'no_available_agent', waitDetail: '卡在 exec-a' });
    assert.ok(waitingDetail.includes('卡在 exec-a'), waitingDetail);
  });

  test('终态：说结果，不说"已完成"就完事', () => {
    assert.ok(nowDoing({ status: 'completed', result: { summary: '都改好了' } }).includes('都改好了'));
    assert.ok(nowDoing({ status: 'completed' }).includes('结束'), '没有摘要也要说结束了');
    assert.notEqual(nowDoing({ status: 'completed' }).trim(), '', '终态不能没话说');
    const blocked = nowDoing({ status: 'blocked', result: { summary: '平台连不上' } });
    assert.ok(blocked.includes('平台连不上'), blocked);
    assert.ok(nowDoing({ status: 'blocked' }).includes('中止'), '中止信息要有');
  });

  test('其余阶段各有一句', () => {
    assert.ok(nowDoing({ status: 'planning' }).includes('规划'));
    assert.equal(nowDoing({ status: 'executing', workItems: [] }), '协调者正在处理');
    assert.ok(nowDoing({ status: 'awaiting_review' }).includes('检视'));
  });

  test('整句里不出现机器阶段名', () => {
    const views = [
      { status: 'investigating', workItems: [] },
      { status: 'planning' },
      { status: 'executing', workItems: [{ id: 'W-465', title: '事件翻译表', status: 'dispatched' }] },
      { status: 'executing', workItems: [] },
      { status: 'awaiting_review' },
      { status: 'completed', result: { summary: '都改好了' } },
      { status: 'blocked', result: { summary: '平台连不上' } },
    ];
    for (const view of views) {
      const line = nowDoing(view);
      assert.ok(line.trim().length > 0, `${view.status} 没有话说`);
      for (const stage of Object.keys(STAGE_CN)) {
        assert.ok(!line.includes(stage), `nowDoing 里漏出了机器状态名「${stage}」：${line}`);
      }
    }
  });
});

/* ============================ 命令族辅助 / LQ1 夹具 ============================ */

/**
 * LQ1 任务页当时的形状：65 条事件里 33 条显示「未翻译」。
 * 命令族（started ×20 + tracking.enabled ×5）交给折叠，不要求单条翻译；
 * 其余点名的非命令 kind 必须零「未翻译」。task.js 整页渲染交后续任务。
 */
function lq1Events(): Array<{ kind: string; data?: Record<string, unknown>; attemptId?: string; workItemId?: string }> {
  const rows: Array<{ kind: string; data?: Record<string, unknown>; attemptId?: string; workItemId?: string }> = [
    { kind: 'mission.created', data: { contractRevision: 1 } },
    { kind: 'attempt.started', data: { kind: 'coordinator' }, attemptId: 'coord-1' },
    { kind: 'plan.updated', data: { planRevision: 1 }, attemptId: 'coord-1' },
    { kind: 'work_item.created', data: { title: '事件翻译表' }, workItemId: 'W-465', attemptId: 'coord-1' },
    { kind: 'work_item.dispatched', data: { ids: ['W-465'] }, attemptId: 'coord-1' },
    { kind: 'attempt.ended', data: { endedBy: 'structured_submit' }, attemptId: 'coord-1' },
    { kind: 'attempt.started', data: { kind: 'executor' }, attemptId: 'W-465.exec-1', workItemId: 'W-465' },
    { kind: 'runtime.command_tracking.enabled', data: { schemaVersion: 1 }, attemptId: 'W-465.exec-1' },
    { kind: 'runtime.command_tracking.enabled', data: { schemaVersion: 1 }, attemptId: 'W-465.exec-1' },
    { kind: 'runtime.command_tracking.enabled', data: { schemaVersion: 1 }, attemptId: 'W-465.exec-1' },
    { kind: 'runtime.command_tracking.enabled', data: { schemaVersion: 1 }, attemptId: 'W-465.exec-1' },
    { kind: 'runtime.command_tracking.enabled', data: { schemaVersion: 1 }, attemptId: 'W-465.exec-1' },
  ];
  for (let i = 0; i < 20; i += 1) {
    rows.push({
      kind: 'runtime.command.started',
      data: { schemaVersion: 1, callId: `call-${i}` },
      attemptId: 'W-465.exec-1',
    });
  }
  rows.push(
    { kind: 'evidence.submitted', data: { kind: 'test', exitCode: 0 }, attemptId: 'W-465.exec-1', workItemId: 'W-465' },
    { kind: 'execution_result.submitted', data: { outcome: 'completed', changedFiles: 3 }, attemptId: 'W-465.exec-1' },
    { kind: 'attempt.ended', data: { endedBy: 'structured_submit' }, attemptId: 'W-465.exec-1' },
    { kind: 'review.recorded', data: { verdict: 'accept', reasons: ['测试跑过了'] }, attemptId: 'coord-2' },
    { kind: 'orchestration.round.started', data: { schemaVersion: 1 } },
    { kind: 'orchestration.round.started', data: { schemaVersion: 1 } },
    { kind: 'orchestration.round.started', data: { schemaVersion: 1 } },
    { kind: 'mission_result.submitted', data: { outcome: 'delivered' }, attemptId: 'coord-2' },
    { kind: 'delivery.created', data: { deliveryId: 'D-lq1' } },
    { kind: 'memory.applied', data: { written: ['VIBE.md'] } },
    { kind: 'final_review.integration_anchor', data: { integrationBranch: 'auto/x', anchor: 'aaa' } },
    { kind: 'final_review.merge_applied', data: { mergedInto: 'bbb', integrationBranch: 'auto/x' } },
    { kind: 'final_review.integration_verified', data: { reportId: 'IVAL-1', passed: true } },
    { kind: 'final_review.merged', data: { mergedInto: 'bbb' } },
    { kind: 'work_item.retired', data: { reason: '不做了' }, workItemId: 'W-466' },
    { kind: 'contract.revised', data: { contractRevision: 2 } },
    { kind: 'mission.waiting', data: { reason: 'waiting_l3' } },
    { kind: 'mission.resumed', data: {} },
    { kind: 'escalated', data: { question: '要不要合？' }, attemptId: 'coord-2' },
    { kind: 'work_item.redispatched', data: { ids: ['W-465'] }, workItemId: 'W-465' },
    { kind: 'final_review.send_back', data: { reasons: ['再看一眼'] } },
    { kind: 'mission.routed', data: { recommended: 'lightweight', reasons: ['单文件'] } },
    { kind: 'mission.paused', data: {} },
    { kind: 'mission.resumed_from_pause', data: {} },
    { kind: 'mission.cancelled', data: { reason: '不要了' } },
    { kind: 'blocked.reported', data: { reason: '缺上下文' }, workItemId: 'W-465' },
    { kind: 'escalation.answered', data: { question: '要不要合？', answer: '合' } },
    { kind: 'validation.reported', data: { reportId: 'VAL-1', passed: true } },
    { kind: 'context.truncated', data: { budget: 8000, estimatedBefore: 9000, estimatedAfter: 7000 } },
    { kind: 'mission.budget.threshold', data: { dimension: 'rounds', threshold: 0.8 } },
    { kind: 'independent_review.blocked', data: { reason: 'no_candidates', detail: '没有独立检视候选' } },
    { kind: 'independent_review.recorded', data: { verdict: 'pass', reviewedCommit: 'abc' } },
    { kind: 'recovery.applied', data: { deliveryId: 'D-fix' } },
  );
  return rows;
}

describe('命令族辅助：给 task.js 折叠用，无 DOM', () => {
  test('isRuntimeCommand 只认 command / command_tracking 前缀',
    () => {
      assert.equal(isRuntimeCommand('runtime.command.started'), true);
      assert.equal(isRuntimeCommand('runtime.command_tracking.enabled'), true);
      assert.equal(isRuntimeCommand('runtime.command_tracking.invalid'), true);
      assert.equal(isRuntimeCommand('orchestration.round.started'), false);
      assert.equal(isRuntimeCommand('runtime.command'), false);
      assert.equal(isRuntimeCommand(''), false);
    },
  );

  test('commandCountLabel 零条说人话，正数带数字', () => {
    assert.equal(commandCountLabel(0), '没有命令');
    assert.equal(commandCountLabel(1), '1 条命令');
    assert.equal(commandCountLabel(20), '20 条命令');
  });

  test('commandDetail 带 callId / 跟踪状态，不空、不漏 undefined', () => {
    const started = commandDetail({ kind: 'runtime.command.started', data: { callId: 'c-9' } });
    assert.ok(started.includes('c-9'), started);
    assert.equal(started.includes('undefined'), false, started);
    assert.ok(commandDetail({ kind: 'runtime.command_tracking.enabled', data: {} }).trim().length > 0);
    assert.ok(commandDetail({ kind: 'runtime.command_tracking.invalid', data: {} }).trim().length > 0);
  });

  test('commandDetail 有命令文本与退出码时如实显示，缺值仍退回 callId', () => {
    assert.equal(
      commandDetail({ kind: 'runtime.command.started', data: { callId: 'c-9' } }),
      '命令 c-9',
    );
    assert.equal(
      commandDetail({ kind: 'runtime.command.started', data: { schemaVersion: 1 } }),
      '命令 （没有 callId）',
    );

    const withText = commandDetail({
      kind: 'runtime.command.started',
      data: { callId: 'c-9', command: 'node --test' },
    });
    assert.ok(withText.includes('node --test'), withText);
    assert.equal(withText.includes('undefined'), false, withText);

    const withExit = commandDetail({
      kind: 'runtime.command.started',
      data: { callId: 'c-9', exitCode: 0 },
    });
    assert.ok(withExit.includes('c-9'), withExit);
    assert.ok(withExit.includes('退出码 0'), withExit);
    assert.equal(withExit.includes('undefined'), false, withExit);

    const withBoth = commandDetail({
      kind: 'runtime.command.started',
      data: { callId: 'c-9', command: 'node --test', exitCode: 1 },
    });
    assert.ok(withBoth.includes('node --test'), withBoth);
    assert.ok(withBoth.includes('退出码 1'), withBoth);
    assert.equal(withBoth.includes('undefined'), false, withBoth);

    // 空串命令不算有值：不要换成一条空的「命令 」把 callId 挤掉。
    assert.equal(
      commandDetail({ kind: 'runtime.command.started', data: { callId: 'c-9', command: '  ' } }),
      '命令 c-9',
    );

    assert.equal(
      commandDetail({ kind: 'runtime.command_tracking.enabled', data: { schemaVersion: 1 } }),
      '开始跟踪本跳的命令',
    );
    assert.equal(
      commandDetail({ kind: 'runtime.command_tracking.invalid', data: { schemaVersion: 1 } }),
      '命令跟踪失效，次数按未知计',
    );
  });
});

describe('finalReviewSummary：终审收尾摘要，无 DOM', () => {
  test('merge / send_back / abandon 各有人话，merge 带 SHA',
    () => {
      assert.equal(
        finalReviewSummary({ verdict: 'merge', mergedInto: 'deadbeefcafebabe' }),
        '终审：放行并落地 · 合入 deadbeefcafebabe',
      );
      assert.equal(finalReviewSummary({ verdict: 'merge' }), '终审：放行并落地');
      assert.equal(finalReviewSummary({ verdict: 'send_back' }), '终审：打回');
      assert.equal(finalReviewSummary({ verdict: 'abandon' }), '终审：放弃这批改动');
    },
  );

  test('缺对象、缺结论、未识别 verdict 都说人话，不漏 undefined/null',
    () => {
      assert.equal(finalReviewSummary(undefined), '还没有最终检视结论');
      assert.equal(finalReviewSummary(null), '还没有最终检视结论');
      assert.equal(finalReviewSummary({}), '终审：（没有结论）');
      assert.equal(finalReviewSummary({ verdict: '' }), '终审：（没有结论）');
      assert.equal(finalReviewSummary({ verdict: 'maybe' }), '终审：maybe');

      const cases = [
        finalReviewSummary(undefined),
        finalReviewSummary(null),
        finalReviewSummary({}),
        finalReviewSummary({ verdict: undefined, mergedInto: undefined }),
        finalReviewSummary({ verdict: null, mergedInto: null }),
        finalReviewSummary({ verdict: 'merge', mergedInto: '' }),
        finalReviewSummary({ verdict: 'send_back', mergedInto: '   ' }),
        finalReviewSummary({ verdict: 'abandon' }),
        finalReviewSummary({ verdict: 'merge', mergedInto: 'abc123' }),
      ];
      for (const line of cases) {
        assert.equal(typeof line, 'string');
        assert.ok(line.trim().length > 0, `空白摘要：${JSON.stringify(line)}`);
        assert.equal(line.includes('undefined'), false, line);
        assert.equal(line.includes('null'), false, line);
      }
    },
  );
});

describe('LQ1 字面量夹具：非命令事件零「未翻译」', () => {
  test('夹具形状对得上当时那页：65 条、命令族 25 条', () => {
    const rows = lq1Events();
    assert.equal(rows.length, 65, `夹具是 ${rows.length} 条，要对上 LQ1 的 65`);
    assert.equal(rows.filter((e) => e.kind === 'runtime.command.started').length, 20);
    assert.equal(rows.filter((e) => e.kind === 'runtime.command_tracking.enabled').length, 5);
  });

  test('非命令事件 narrateEvent 不得标未翻译', () => {
    for (const event of lq1Events()) {
      if (isRuntimeCommand(event.kind)) continue;
      const out = narrateEvent(event, CTX);
      const whole = `${out.badge} ${out.action} ${out.detail}`;
      assert.equal(out.untranslated, false, `${event.kind} 仍未翻译：${whole}`);
      assert.equal(whole.includes('未翻译'), false, `${event.kind} 文案里有「未翻译」：${whole}`);
    }
  });
});
