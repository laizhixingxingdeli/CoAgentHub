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
  STAGE_CN,
  WAIT_REASON,
  endReasonText,
  fieldLabel,
  formatAttemptId,
  formatUsage,
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
    for (const forbidden of ['document', 'innerHTML', 'esc(', 'fetch(', 'Date.now', 'new Date']) {
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
    })) {
      assert.equal(typeof value, 'function', `${name} 要是函数`);
    }
    assert.equal(typeof STAGE_CN, 'object');
    assert.equal(typeof WAIT_REASON, 'object');
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
    for (const kind of ['memory.applied', 'final_review.send_back', 'mission.paused', '']) {
      const out = narrateEvent({ kind, data: {} });
      assert.equal(out.untranslated, true);
      assert.equal(out.badge, '未翻译');
      const whole = out.badge + out.action + out.detail;
      assert.ok(whole.includes('未翻译'), `没标未翻译：${whole}`);
      assert.ok(whole.trim().length > 0, '整段不能是空白');
      if (kind) assert.ok(whole.includes(kind), `没带上 kind：${whole}`);
    }
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
      'no_available_agent',
      'platform_unreachable',
      'project_busy',
      'runaway_suspected',
      'target_changed',
      'waiting_l3',
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
