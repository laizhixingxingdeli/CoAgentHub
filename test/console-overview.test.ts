/**
 * 任务总览的纯数据投影（src/web/console-overview-model.js）。
 *
 * 只写两组，对应验收的两条：
 *   1. 六态 / 附标 / 处理人 / 费用的**边界**——这一层最容易出的错都不报错：
 *      未上报的费用显示成 $0.00、终态上残留的 waiting_l3 被再翻译一遍
 *      「等你处理」、openEscalations 的条数被画成「已升级（问题）」、
 *      executing / isMutating 被当成「agent 正在跑」。每一条都让人对着屏幕
 *      做错判断，而屏幕上看起来完全正常，所以断言写在这里。
 *   2. 组合筛选与分页：完整匹配集合不被可见批次截断，三组排序不改输入。
 *
 * 其余分支不各写一条：同一个判断写第二遍不会更准，只会多一处要跟着改。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OVERVIEW_PAGE_SIZE,
  OVERVIEW_STATUS_ORDER,
  buildOverview,
  groupOverview,
  projectCost,
  projectOverviewRow,
  projectOverviewRows,
} from '../src/web/console-overview-model.js';

/** 一行的最小真实形状：字段名照 src/application/platform/types.ts 的 MissionSummary。 */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    missionId: 'M-1',
    projectId: 'P-1',
    status: 'executing',
    coordinationMode: 'hierarchical',
    waitReason: undefined,
    waitDetail: undefined,
    updatedAt: '2026-10-26T10:00:00.000Z',
    paused: false,
    isMutating: false,
    intent: '做一件有边界的事',
    workItems: 2,
    accepted: 1,
    openEscalations: 0,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 1.5, quality: 'reported' },
    ...overrides,
  };
}

describe('状态 / 附标 / 处理人 / 费用的边界', () => {
  test('六态各有中文，附标与处理人只认真实字段，终态压过残留 waiting_l3', () => {
    const expected: Record<string, string> = {
      investigating: '调查中',
      planning: '规划中',
      executing: '执行中',
      awaiting_review: '等你检视',
      completed: '已完成',
      blocked: '已中止',
    };
    for (const status of OVERVIEW_STATUS_ORDER) {
      assert.equal(projectOverviewRow(row({ status })).statusText, expected[status], status);
    }
    // 认不出的状态不许原样印一个英文机器名。
    assert.equal(projectOverviewRow(row({ status: 'weird_state' })).statusText, '未知');

    // 附标：全部来自真实字段。openEscalations 的**条数**不是「问题升级」的证据。
    const marked = projectOverviewRow(row({
      paused: true,
      coordinationMode: 'direct',
      openEscalations: 3,
    }));
    assert.deepEqual(marked.marks.map((m) => m.key), ['paused', 'direct']);
    assert.equal(marked.marksText, '已暂停 · 直接主控');

    // 问题升级只看真实详情里 openEscalations 数组：未答复、且不带平台门禁的那一条
    // 才算；带货上限 / 检查点门禁的、已答复的都不算。
    const escalated = projectOverviewRow(row({
      openEscalations: [
        { attemptId: 'A-1', question: '范围选哪个', why: '两条路都可行', optionsConsidered: ['窄', '宽'] },
        { attemptId: 'A-2', question: '费用到顶了', why: '票级上限', optionsConsidered: [], platformGate: { kind: 'cost_cap', threshold: 5 } },
      ],
    }));
    assert.deepEqual(escalated.marks.map((m) => m.key), ['problem']);
    assert.equal(escalated.marksText, '已升级（问题）');
    // 只有门禁升级 / 已经答过了 → 不是问题。
    assert.deepEqual(
      projectOverviewRow(row({
        openEscalations: [{ attemptId: 'A-3', question: '到检查点了', why: '序号到阈值', optionsConsidered: [], platformGate: { kind: 'work_item_checkpoint', threshold: 2 } }],
      })).marks,
      [],
    );
    assert.deepEqual(
      projectOverviewRow(row({
        openEscalations: [{ attemptId: 'A-4', question: '改不改接口', why: '契约', optionsConsidered: [], answer: '不改', answeredAt: '2026-10-26T09:00:00.000Z' }],
      })).marks,
      [],
    );
    // 补修没有结构化来源，也不把 rerunOf 当成补修：两者都不出标记。
    assert.deepEqual(
      projectOverviewRow(row({ repairOf: 'W-1', origin: { rerunOf: 'M-0' } })).marks,
      [],
    );

    // executing + isMutating 不证明 agent 在跑：没有 waitInfo 就是未知。
    const executing = projectOverviewRow(row({ status: 'executing', isMutating: true }));
    assert.equal(executing.owner.activeAgent, 'unknown');
    assert.equal(executing.owner.autoResume, 'unknown');
    assert.equal(executing.group, 'active');
    // 但真上报了活动 Agent，就照实说。
    const running = projectOverviewRow(row({
      waitInfo: { reason: 'retry_backoff', owner: 'platform', autoResume: true, activeAgent: true, action: '到点自动重试' },
    }));
    assert.equal(running.owner.activeAgent, true);
    assert.equal(running.owner.text, '平台自动处理');
    assert.equal(running.nextStep, '到点自动重试');

    // 终态：残留 waiting_l3 既不进「需要你处理」，也不复述「等你处理」。
    const completed = projectOverviewRow(row({
      status: 'completed',
      waitReason: 'waiting_l3',
      waitInfo: { reason: 'waiting_l3', owner: 'l3', autoResume: false, activeAgent: false, action: '等检视者答复' },
    }));
    assert.equal(completed.group, 'finished');
    assert.equal(completed.waitLine, '');
    assert.equal(completed.owner.key, 'none');
    assert.equal(completed.owner.text, '已结束，没有待办');
    assert.equal(completed.owner.autoResume, false);
    assert.equal(completed.owner.activeAgent, false);
    assert.equal(completed.owner.action, '');
    assert.equal(completed.nextStep, '');

    // 终态上 activeAgent 不是待办，是进程事实：cancel() 不关闭正在跑的那一跳，
    // 所以真实上报的 true 就保留，不能从 completed 推断成 false。
    const terminalLiveAgent = projectOverviewRow(row({
      status: 'completed',
      waitInfo: { reason: 'waiting_l3', owner: 'l3', autoResume: false, activeAgent: true, action: '等检视者答复' },
    }));
    assert.equal(terminalLiveAgent.owner.activeAgent, true);
    assert.equal(terminalLiveAgent.owner.key, 'none');
    assert.equal(terminalLiveAgent.owner.autoResume, false);
    assert.equal(terminalLiveAgent.owner.action, '');
    assert.equal(terminalLiveAgent.waitLine, '');
    assert.equal(terminalLiveAgent.group, 'finished');
    // 缺这个布尔值也是未知：不补 false 冒充「没有活动 Agent」。
    const terminalNoAgentField = projectOverviewRow(row({
      status: 'blocked',
      waitInfo: { reason: 'cancelled_by_user', owner: 'user', autoResume: false },
    }));
    assert.equal(terminalNoAgentField.owner.activeAgent, 'unknown');
    assert.equal(terminalNoAgentField.owner.key, 'none');
    assert.equal(terminalNoAgentField.waitLine, '');
    assert.equal(terminalNoAgentField.group, 'finished');
    // 连 waitInfo 都没有的终态：同样未知。
    assert.equal(projectOverviewRow(row({ status: 'completed' })).owner.activeAgent, 'unknown');

    // 终态上别的残留原因也只能是只读原因：blocked + cancelled_by_user 不再变成
    // 「需要用户处理 / 不会自动恢复」那一套待办。
    const blocked = projectOverviewRow(row({
      status: 'blocked',
      waitReason: 'cancelled_by_user',
      waitInfo: {
        reason: 'cancelled_by_user',
        owner: 'user',
        autoResume: false,
        activeAgent: false,
        action: '被叫停或暂停了：resume 之后重跑',
      },
    }));
    assert.equal(blocked.owner.key, 'none');
    assert.equal(blocked.owner.text, '已结束，没有待办');
    assert.equal(blocked.owner.reason, 'cancelled_by_user');
    assert.equal(blocked.owner.autoResume, false);
    assert.equal(blocked.owner.activeAgent, false);
    assert.equal(blocked.owner.action, '');
    assert.equal(blocked.nextStep, '');
    assert.equal(blocked.waitLine, '');
    assert.equal(blocked.group, 'finished');

    // waitInfo 缺布尔值就是未知：不能拿默认 false 冒充「不会自动恢复 / 没有活动 Agent」。
    const partial = projectOverviewRow(row({
      waitInfo: { reason: 'retry_backoff', owner: 'platform', action: '到点自动重试' },
    }));
    assert.equal(partial.owner.autoResume, 'unknown');
    assert.equal(partial.owner.activeAgent, 'unknown');
    assert.match(partial.waitLine, /未知/);
    assert.doesNotMatch(partial.waitLine, /不会自动恢复|没有活动 Agent/);
    // 只缺一个布尔时，另一个照实说，缺的那个仍是未知。
    const halfKnown = projectOverviewRow(row({ waitInfo: { reason: 'retry_backoff', owner: 'platform', activeAgent: true } }));
    assert.equal(halfKnown.owner.autoResume, 'unknown');
    assert.equal(halfKnown.owner.activeAgent, true);
    assert.match(halfKnown.waitLine, /有活动 Agent/);
    assert.doesNotMatch(halfKnown.waitLine, /不会自动恢复/);

    // 「需要你处理」不能被未知布尔值劫持：处理人明说是 l3 时分组靠 autoResume !== true。
    assert.equal(projectOverviewRow(row({ status: 'awaiting_review', waitInfo: { reason: 'waiting_l3', owner: 'l3' } })).group, 'needs_you');

    // 等你检视的处理人是 L3：不靠 waitInfo 也不会猜错。需要人动手且不会自动恢复
    // 才算「需要你处理」；缺 waitInfo 时不把未知当成「会自己好」。
    assert.equal(projectOverviewRow(row({ status: 'awaiting_review' })).owner.text, '需要检视者（L3）处理');
    assert.equal(projectOverviewRow(row({ status: 'awaiting_review' })).group, 'needs_you');
  });

  test('费用：unknown 即使 cost 0 也是未知，estimated 标估算，reported 0 保留，direct 主控未计', () => {
    const unknown = projectCost({ cost: 0, quality: 'unknown' }, {});
    assert.equal(unknown.text, '未知');
    assert.equal(unknown.amount, null);
    // 连 quality 都没有（老记录）同样未知。
    assert.equal(projectCost({ cost: 2.5 }, {}).text, '未知');

    const estimated = projectCost({ cost: 1.06, quality: 'estimated' }, {});
    assert.equal(estimated.text, '≈$1.06');
    assert.equal(estimated.estimated, true);

    // 真实上报的 $0.00 与「没上报」是两件事。
    assert.equal(projectCost({ cost: 0, quality: 'reported' }, {}).text, '$0.00');

    // 两层协作：已知的只是执行侧，不能表述成完整总成本。
    assert.equal(projectCost({ cost: 1.06, quality: 'estimated' }, { direct: true }).text, '≈$1.06 + 主控未计');
    assert.equal(projectCost({ cost: undefined, quality: 'unknown' }, { direct: true }).text, '未知（主控未计）');

    // 接到行上：direct 行自动带附标与主控未计。
    const directRow = projectOverviewRow(row({ coordinationMode: 'direct', usage: { cost: 1.06, quality: 'reported' } }));
    assert.equal(directRow.cost.text, '$1.06 + 主控未计');
    assert.ok(directRow.marks.some((m) => m.key === 'direct'));
  });
});

describe('组合筛选 / 分页 / 不改输入', () => {
  /** 60 行同构数据：两个项目、六种状态、按时间递减，用来验「完整集合不被批次截断」。 */
  function many(): Record<string, unknown>[] {
    const statuses = OVERVIEW_STATUS_ORDER;
    return Array.from({ length: 60 }, (_, i) => row({
      missionId: `M-${String(i).padStart(2, '0')}`,
      projectId: i % 2 === 0 ? 'P-1' : 'P-2',
      status: statuses[i % statuses.length],
      paused: i % 10 === 0,
      intent: i % 3 === 0 ? '修复通知关联恢复' : '整理车辆策略',
      updatedAt: new Date(Date.UTC(2026, 9, 26, 10, 0, 0) - i * 60_000).toISOString(),
    }));
  }

  test('条件组合与完整统计；分页只切显示批次；三组排序不改输入', () => {
    const rows = many();
    const snapshot = JSON.stringify(rows);

    // 单看项目 + 暂停 + 搜索：计数按「状态以外的条件」算，页签点进去不会是空的。
    // 命中 M-00 与 M-30（偶数 = P-1，10 的倍数 = 暂停，3 的倍数 = intent 含「通知」）。
    const scoped = buildOverview(rows, { filter: { projectId: 'P-1', pausedOnly: true, query: '通知' }, shown: 2 });
    assert.equal(scoped.counts.all, 2);
    assert.equal(scoped.counts.investigating, 2);
    assert.equal(scoped.counts.executing, 0);

    // 再叠状态筛选：matched 是完整匹配集合，不是可见批次。
    const filtered = buildOverview(rows, {
      filter: { projectId: 'P-1', pausedOnly: true, query: '通知', status: 'investigating' },
      shown: 1,
    });
    assert.deepEqual(filtered.matched.map((r) => r.missionId), ['M-00', 'M-30']);
    assert.equal(filtered.page.shown, 1);
    assert.equal(filtered.page.total, 2);
    assert.equal(filtered.page.hasMore, true);

    // 不筛选时：总数 60，但一屏只给 2 条；hasMore 与剩余数说的是完整集合。
    const paged = buildOverview(rows, { shown: 2 });
    assert.equal(paged.total, 60);
    assert.equal(paged.page.shown, 2);
    assert.equal(paged.page.hasMore, true);
    assert.equal(paged.page.remaining, 58);
    assert.equal(paged.page.size, 2);
    // 默认页大小是有名字的常量，不是设计稿里的样本数。
    assert.equal(buildOverview(rows, {}).page.size, OVERVIEW_PAGE_SIZE);

    // 三组：组序固定，组内 updatedAt 降序，跨组后整体是「需要你处理 → 进行中 → 最近结束」。
    const ordered = buildOverview(rows, { shown: 60 }).groups;
    assert.deepEqual(ordered.map((g) => g.key), ['needs_you', 'active', 'finished']);
    assert.deepEqual(ordered.map((g) => g.title), ['需要你处理', '进行中', '最近结束']);
    for (const group of ordered) {
      const times = group.rows.map((r) => Date.parse((r as { updatedAt: string }).updatedAt));
      const sorted = [...times].sort((a, b) => b - a);
      assert.deepEqual(times, sorted, `${group.key} 组内不是 updatedAt 降序`);
    }
    // 「需要你处理」里每条都真是等人且不会自动恢复。
    for (const r of ordered[0].rows as { owner: { key: string; autoResume: unknown } }[]) {
      assert.ok(r.owner.key === 'l3' || r.owner.key === 'user', r.owner.key);
      assert.notEqual(r.owner.autoResume, true);
    }

    // 同样的输入再来一次，顺序一样（排序稳定，否则每次重画行都会跳）。
    assert.deepEqual(
      groupOverview(projectOverviewRows(rows)).map((g) => g.rows.map((r) => r.missionId)),
      groupOverview(projectOverviewRows(rows)).map((g) => g.rows.map((r) => r.missionId)),
    );

    // 入参一个字节都没动，返回的数组也不是同一个引用。
    assert.equal(JSON.stringify(rows), snapshot);
    const projected = projectOverviewRows(rows);
    assert.notEqual(projected[0], rows[0]);
    groupOverview(projected);
    assert.deepEqual(projected.map((r) => r.missionId), rows.map((r) => r.missionId));
  });
});
