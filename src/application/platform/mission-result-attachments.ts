/**
 * 交卷的平台附件采集。
 *
 * 三样东西都是**平台自己从记录里搬来的事实**，不是协调者自报：最后一次全量
 * 测试的原样结果行、相对集成分支 HEAD 的 diff 统计、每条验收标准对应哪些工单。
 * 分开放在 `attachments` 里而不是塞进 criteria，是因为这两者责任不同——
 * 协调者的判断和机器的输出不能混成一句"证据"。
 *
 * 拿不到一律 null + `unavailable` 说明原因：**缺了是"这次没跑到"，不是"结果是
 * 空的"**。任何一处都不许根据 exitCode 或空值推一个好看的数字出来。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type {
  Mission,
  MissionResultPlatformAttachments,
  ValidationReport,
} from '../../kernel/index.ts';
import { countTextLines } from '../validation/workspace-diff-fact-reader.ts';
import { criteriaList } from './agent-view-helpers.ts';
import type { PlatformContext } from './context.ts';

const run = promisify(execFile);

/** 只读 git 的兜底：交卷不该因为读一次 diff 卡住整条流水线。 */
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

interface Candidate {
  readonly at: string;
  readonly source: string;
  readonly text: string;
}

/**
 * 全量测试的结果行。
 *
 * 只认真正的全量 `node --test`：定向（带路径）、管道、复合命令跑的是子集，
 * 把它们标成"全量测试通过了"会让一条只跑了一个文件的命令替整仓背书。
 */
function isFullNodeTest(command: string | undefined): boolean {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  // 允许前后空白，其余必须逐字相等：`node  --test`、`node --test | tail`、
  // `node --test test/x.ts` 都不是全量（管道还会吞掉退出码）。
  return trimmed === 'node --test';
}

/**
 * 四项计数。三种写法都要认：新版 `ℹ tests 12`、旧版 `# tests 12`、以及已经把
 * 摘要归纳成 `tests 12 / pass 12 / fail 0 / skipped 0` 的历史证据——只认带标记的
 * 那两种，等于把这些 Mission 的附件全判成拿不到。
 *
 * 每项两侧都要词边界：没有它，`latest tests 12`、`passing 3` 这种挨着的词会被
 * 当成计数行，读出来的数就不是这次跑出来的。
 */
const COUNT_PATTERNS = {
  tests: /\btests\b\s+(\d+)/,
  pass: /\bpass\b\s+(\d+)/,
  fail: /\bfail\b\s+(\d+)/,
  skipped: /\bskipped\b\s+(\d+)/,
} as const;

/**
 * 从一段输出里取四项计数。
 *
 * 四项缺一项就返回 undefined：**缺了是"这次没读到"**，不许拿 exitCode 或另一
 * 项去推算凑齐（fail=tests-pass 这类推法在 cancelled 存在时是错的）。
 */
function extractCounts(text: string): Record<keyof typeof COUNT_PATTERNS, number> | undefined {
  const out: Partial<Record<keyof typeof COUNT_PATTERNS, number>> = {};
  for (const [key, pattern] of Object.entries(COUNT_PATTERNS)) {
    const match = pattern.exec(text);
    if (!match) return undefined;
    out[key as keyof typeof COUNT_PATTERNS] = Number(match[1]);
  }
  return out as Record<keyof typeof COUNT_PATTERNS, number>;
}

/**
 * 把读到的计数归纳成一行结算格式。
 *
 * 不是原始输出的逐字拷贝：原始行可能是 `ℹ tests 41` 四行分散的样子。归纳只用
 * 已经提取出来的四项真实计数，不补、不推算。
 */
function resultLineOf(counts: Record<keyof typeof COUNT_PATTERNS, number>): string {
  return `tests ${counts.tests} / pass ${counts.pass} / fail ${counts.fail} / skipped ${counts.skipped}`;
}

async function evidenceCandidates(ctx: PlatformContext, mission: Mission): Promise<Candidate[]> {
  const events = await ctx.activity.list(mission.id);
  const submittedAt = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== 'evidence.submitted') continue;
    const data = event.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
    const evidenceId = (data as { evidenceId?: unknown }).evidenceId;
    if (typeof evidenceId !== 'string') continue;
    // 后写盖前写：同一 id 只留下最后那条（重发场景）。
    submittedAt.set(evidenceId, event.at);
  }
  const out: Candidate[] = [];
  for (const item of mission.workItems) {
    for (const attempt of item.attempts) {
      for (const record of attempt.evidence) {
        if (!isFullNodeTest(record.command)) continue;
        const at = submittedAt.get(record.id) ?? '';
        const text = [record.output ?? '', record.summary].join('\n');
        out.push({ at, source: `evidence ${record.id}`, text });
      }
    }
  }
  return out;
}

function reportFullTestChecks(report: ValidationReport, worktreeCwd: string): Candidate[] {
  return report.checks
    .filter((check) => {
      if (check.kind !== 'command' || !check.command) return false;
      // argv 逐项对，不拼成串再比：`join(' ')` 会把 `['node --test']`（一项）也拼成
      // `node --test`，把一次定向/复合命令认成全量。cwd 也要对得上，否则那次跑的
      // 是别的目录，不能用它替本 Mission 的 worktree 背书。
      const argv = check.command.argv;
      return (
        argv.length === 2 &&
        argv[0] === 'node' &&
        argv[1] === '--test' &&
        check.command.cwd === worktreeCwd
      );
    })
    .map((check) => ({
      at: check.endedAt,
      source: `report ${report.id}`,
      text: check.command?.outputTail ?? '',
    }));
}

async function reportCandidates(
  ctx: PlatformContext,
  mission: Mission,
  worktreeCwd: string,
): Promise<Candidate[]> {
  const reports = ctx.validation?.reports;
  if (!reports) return [];
  const out: Candidate[] = [];
  for (const event of await ctx.activity.list(mission.id)) {
    if (event.kind !== 'validation.reported') continue;
    const data = event.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) continue;
    const reportId = (data as { reportId?: unknown }).reportId;
    if (typeof reportId !== 'string') continue;
    const report = await reports.get(reportId);
    if (!report || report.missionId !== mission.id) continue;
    out.push(...reportFullTestChecks(report, worktreeCwd));
  }
  return out;
}

/**
 * 取最后一次全量测试结果。
 *
 * **只看最后一份**：回退到更早的报告去凑一个"好看的"结果，等于用旧绿掩盖
 * 现在没测。最后一份读不出计数就报 null 并说明原因。
 */
async function lastFullTest(
  ctx: PlatformContext,
  mission: Mission,
  worktreeCwd: string | undefined,
): Promise<{
  readonly value: MissionResultPlatformAttachments['lastFullTest'];
  readonly note?: string;
}> {
  const candidates = [...(await evidenceCandidates(ctx, mission))];
  if (worktreeCwd !== undefined) {
    candidates.push(...(await reportCandidates(ctx, mission, worktreeCwd)));
  }
  if (candidates.length === 0) {
    return {
      value: null,
      note: 'lastFullTest 不可用：本次 Mission 没有全量 `node --test` 的证据或验证报告',
    };
  }
  candidates.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const newest = candidates[candidates.length - 1]!;
  const counts = extractCounts(newest.text);
  if (!counts) {
    return {
      value: null,
      note: `lastFullTest 不可用：最后一份全量测试输出（${newest.source}）里读不出 tests/pass/fail/skipped 四项计数`,
    };
  }
  return { value: { resultLine: resultLineOf(counts), source: newest.source } };
}

/** 每条验收标准对应哪些工单。没有工单关联这条标准就给空数组——不是省略。 */
function criterionWorkItems(mission: Mission): MissionResultPlatformAttachments['criterionWorkItems'] {
  const count = mission.contract?.acceptance.length ?? 0;
  const byCriterion = new Map<number, string[]>();
  for (const item of mission.workItems) {
    for (const criterion of criteriaList(item.order)) {
      const list = byCriterion.get(criterion) ?? [];
      if (!list.includes(item.id)) list.push(item.id);
      byCriterion.set(criterion, list);
    }
  }
  return Array.from({ length: count }, (_unused, position) => ({
    index: position + 1,
    workItemIds: byCriterion.get(position + 1) ?? [],
  }));
}

interface Numstat {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}

/**
 * `git diff --numstat` 按 NUL 分隔取路径。
 *
 * 文件名可以含空格（换行和引号在 `-z` 下也不再转义），按行切会把一个文件切成
 * 两个假路径。二进制文件给 `-`，那是"没法计行"而不是 0。
 */
function parseNumstat(raw: string): Numstat | undefined {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const entry of raw.split('\0')) {
    if (entry === '') continue;
    const tab1 = entry.indexOf('\t');
    const tab2 = tab1 >= 0 ? entry.indexOf('\t', tab1 + 1) : -1;
    if (tab1 < 0 || tab2 < 0) return undefined;
    const ins = entry.slice(0, tab1);
    const del = entry.slice(tab1 + 1, tab2);
    if (ins === '-' || del === '-') return undefined;
    const insNum = Number(ins);
    const delNum = Number(del);
    if (!Number.isFinite(insNum) || !Number.isFinite(delNum)) return undefined;
    files += 1;
    insertions += insNum;
    deletions += delNum;
  }
  return { files, insertions, deletions };
}

/** 未跟踪文件：git 的 numstat 看不见它们，得自己数文本行。 */
async function untrackedLines(cwd: string): Promise<{ readonly lines: number; readonly files: number } | undefined> {
  let listed: string;
  try {
    listed = (await run('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    })).stdout;
  } catch {
    return undefined;
  }
  let files = 0;
  let lines = 0;
  for (const rel of listed.split('\0')) {
    const cleaned = rel.trim();
    if (cleaned === '') continue;
    let buf: Buffer;
    try {
      buf = await readFile(resolve(cwd, cleaned));
    } catch {
      return undefined;
    }
    // 二进制读不出"行"，按行计就会编一个数出来。
    if (buf.includes(0)) return undefined;
    files += 1;
    lines += countTextLines(buf.toString('utf8'));
  }
  return { lines, files };
}

/**
 * 相对集成分支当前 HEAD 的 diff 统计。
 *
 * 基准取集成根的 HEAD（`git rev-parse HEAD`）而不是 Mission 的 baseRevision：
 * 交卷要回答的是"这会带进目标分支多少东西"，基线早了就会漏掉别人已经合进去
 * 的部分。含已提交、未提交跟踪变更和未跟踪文件三类。
 */
async function diffStats(
  ctx: PlatformContext,
  mission: Mission,
): Promise<{
  readonly value: MissionResultPlatformAttachments['diffStats'];
  readonly note?: string;
}> {
  const projectRoot = mission.workspaceRef?.projectRoot;
  const workspace = ctx.workspace;
  if (!projectRoot || !workspace || typeof workspace.worktreePath !== 'function') {
    return { value: null, note: 'diffStats 不可用：Mission 没有 workspace 信息' };
  }
  const cwd = workspace.worktreePath(mission.id, projectRoot);
  if (!cwd || !existsSync(cwd)) {
    return { value: null, note: 'diffStats 不可用：找不到本 Mission 的独立 worktree' };
  }
  let base: string;
  let numstat: string;
  try {
    base = (await run('git', ['rev-parse', 'HEAD'], {
      cwd: resolve(projectRoot),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    })).stdout.trim();
    numstat = (await run('git', ['diff', '--numstat', '-z', base], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    })).stdout;
  } catch {
    return { value: null, note: 'diffStats 不可用：读取 git diff 失败' };
  }
  const tracked = parseNumstat(numstat);
  if (!tracked) {
    return { value: null, note: 'diffStats 不可用：diff 里有无法统计的条目（例如二进制文件）' };
  }
  const untracked = await untrackedLines(cwd);
  if (!untracked) {
    return { value: null, note: 'diffStats 不可用：读取未跟踪文件失败' };
  }
  return {
    value: {
      files: tracked.files + untracked.files,
      insertions: tracked.insertions + untracked.lines,
      deletions: tracked.deletions,
    },
  };
}

/**
 * 采一遍附件，交给 recordResult。
 *
 * 全部 try/catch 到底：附件是**附带**的，读不到不能把交卷本身挡下来——
 * 尤其是那些没有 workspace 的夹具 Mission。
 */
export async function collectMissionResultAttachments(
  ctx: PlatformContext,
  mission: Mission,
): Promise<MissionResultPlatformAttachments> {
  const unavailable: string[] = [];
  const worktreeCwd = resolveWorktreeCwd(ctx, mission);

  const test = await lastFullTest(ctx, mission, worktreeCwd).catch(() => ({
    value: null,
    note: 'lastFullTest 不可用：读取证据或报告失败',
  }));
  if (test.note) unavailable.push(test.note);

  const diff = await diffStats(ctx, mission).catch(() => ({
    value: null,
    note: 'diffStats 不可用：读取 git 失败',
  }));
  if (diff.note) unavailable.push(diff.note);

  return {
    lastFullTest: test.value,
    diffStats: diff.value,
    criterionWorkItems: criterionWorkItems(mission),
    unavailable,
  };
}

function resolveWorktreeCwd(ctx: PlatformContext, mission: Mission): string | undefined {
  const projectRoot = mission.workspaceRef?.projectRoot;
  if (!projectRoot || !ctx.workspace || typeof ctx.workspace.worktreePath !== 'function') {
    return undefined;
  }
  const cwd = ctx.workspace.worktreePath(mission.id, projectRoot);
  return cwd && existsSync(cwd) ? cwd : undefined;
}
