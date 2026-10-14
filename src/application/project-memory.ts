/**
 * Project Memory（S04）。
 *
 * **Git 是 Project Truth**：长期知识存在项目仓库的 `.coagent/` 里，跟代码
 * 同一个版本。平台的数据库存的是 Work Truth（Mission / Attempt / Evidence），
 * 两者不混。
 *
 * 落地方式是关键：memory 的改动**写进 Mission 自己的 worktree**，跟着那次
 * merge 一起进目标分支。这样"代码改了但文档没跟上"从结构上就不可能发生——
 * 它们是同一个提交。
 *
 * 三条规则（S04.3）：
 *   - 实现只是把既有行为修回来 → 不动 Living Spec
 *   - 新增/改变了可观察行为    → 更新对应的 Living Spec
 *   - 跨 Mission 的长期技术取舍 → 写 ADR
 *
 * Living Spec 按**稳定的 Capability** 组织，不是每个 Mission 一份。
 * 一年下来 Mission 有几百条，Capability 只有十几个。
 *
 * 项目级稳定认知的唯一 Source of Truth 是 `.coagent/project.md`
 *（`projectProfile`）。legacy `project.yaml` + `architecture/constitution.md`
 * 仅在 project.md 不存在时可读。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface MemoryDelta {
  /** living_spec：系统"现在是什么"；adr：一次长期取舍及其理由。 */
  readonly kind: 'living_spec' | 'adr';
  /**
   * Living Spec 用稳定的 Capability 名（如 `scheduling`、`mission-lifecycle`），
   * **不要**用 Mission 名或日期 —— 那会退化成"每个变更一份永久文档"。
   */
  readonly slug: string;
  readonly title: string;
  readonly body: string;
}

export interface ProjectMemory {
  readonly root: string;
  readonly exists: boolean;
  readonly projectName: string;
  /** 整个 project.md（含首个 H1）；legacy 路径下合成。 */
  readonly projectProfile: string | undefined;
  readonly specs: { slug: string; title: string; body: string }[];
  readonly decisions: { slug: string; title: string; body: string }[];
}

const DIR = '.coagent';

function firstHeading(body: string, fallback: string): string {
  const line = body.split(/\r?\n/).find((l) => l.startsWith('# '));
  return line ? line.slice(2).trim() : fallback;
}

function stripHeading(body: string): string {
  return body.replace(/^#\s+.*\r?\n/, '');
}

function readDocs(dir: string): { slug: string; title: string; body: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const body = readFileSync(join(dir, name), 'utf8');
      const slug = name.replace(/\.md$/, '');
      return { slug, title: firstHeading(body, slug), body };
    });
}

function dirFallbackName(projectRoot: string): string {
  return resolve(projectRoot).split(/[\\/]/).pop() ?? 'project';
}

/** legacy：只认 `name:` 这一行。不引 YAML 解析器。 */
function readLegacyYamlName(root: string): string | undefined {
  const path = join(root, 'project.yaml');
  if (!existsSync(path)) return undefined;
  const line = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('name:'));
  if (!line) return undefined;
  const name = line.split(':').slice(1).join(':').trim();
  return name || undefined;
}

function readLegacyConstitutionBody(root: string): string | undefined {
  const path = join(root, 'architecture', 'constitution.md');
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8');
}

/**
 * @param fallbackName 没有 project.md / legacy name 时用它当项目名。**必须传 projectId**，
 *   不能靠目录名兜底——落地时读的是 Mission 的 worktree，那个目录叫
 *   Mission ID，于是 VIBE.md 的标题会变成「M-ctx」而不是项目名。
 */
export function readProjectMemory(projectRoot: string, fallbackName?: string): ProjectMemory {
  const root = resolve(projectRoot, DIR);
  const projectMdPath = join(root, 'project.md');
  const specs = readDocs(join(root, 'specs'));
  const decisions = readDocs(join(root, 'architecture', 'decisions'));
  const base = {
    root,
    exists: existsSync(root),
    specs,
    decisions,
  };

  // canonical：project.md 存在就绝不再读 legacy
  if (existsSync(projectMdPath)) {
    const projectProfile = readFileSync(projectMdPath, 'utf8');
    return {
      ...base,
      projectName: firstHeading(projectProfile, fallbackName ?? dirFallbackName(projectRoot)),
      projectProfile,
    };
  }

  // legacy：yaml name → fallback → 目录名；profile = `# name\n\n` + constitution 去首 H1
  const legacyName =
    readLegacyYamlName(root) ?? fallbackName ?? dirFallbackName(projectRoot);
  const constitution = readLegacyConstitutionBody(root);
  const projectProfile = constitution
    ? `# ${legacyName}\n\n${stripHeading(constitution).replace(/^\r?\n/, '')}`
    : undefined;

  return {
    ...base,
    projectName: legacyName,
    projectProfile,
  };
}

/**
 * 删掉标题里含 marker 的整节（该行起到下一个同级或更高级标题，子标题属于该节）。
 *
 * 用途是让只给 L3 看的历史章节不进协调者/执行者的简报。判准只看**标题行**：
 * marker 只出现在正文某处时不算，必须原样返回同一个字符串（===），
 * 否则 `api.test.ts` 里对 projectRules 原文与 hash 的断言会无谓地变红。
 * markdown 不含 marker 时同样原样返回——不 trim、不动换行。
 * 只有真的删过节，才用入参实际用的换行符（含 `\r\n` 则用 `\r\n`，否则 `\n`）重新 join。
 */
export function omitSectionsWithMarker(markdown: string, marker = '（仅 L3）'): string {
  if (!markdown.includes(marker)) return markdown;
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  const kept: string[] = [];
  // 被丢掉的那一节的标题层级；遇到同级或更高级标题才结束。
  let skipLevel = 0;
  let dropped = false;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (skipLevel !== 0 && level <= skipLevel) skipLevel = 0;
      if (skipLevel === 0 && heading[2].includes(marker)) {
        skipLevel = level;
        dropped = true;
        continue;
      }
    }
    if (skipLevel !== 0) continue;
    kept.push(line);
  }
  return dropped ? kept.join(newline) : markdown;
}

/**
 * 在一个还没有 `.coagent/` 的仓库里建出骨架。
 *
 * 只建 `project.md` 和 specs/decisions 占位。内容该由用它的人写；
 * 平台预填一堆具体项目用途只会被原样留在那儿，然后没人相信它。
 */
export function initProjectMemory(projectRoot: string, projectName: string): string[] {
  const root = resolve(projectRoot, DIR);
  const created: string[] = [];
  const ensure = (path: string, content: string) => {
    if (existsSync(path)) return;
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
    created.push(path.slice(resolve(projectRoot).length + 1).replaceAll('\\', '/'));
  };

  ensure(
    join(root, 'project.md'),
    [
      `# ${projectName}`,
      '',
      '<!-- 项目级稳定认知。写用途、核心模型、不变量与约束；不要写 Mission 历史。 -->',
      '',
      '## Purpose',
      '',
      '（这个项目是做什么的、为谁服务。）',
      '',
      '## Core Model',
      '',
      '（稳定的领域对象与关系，不是当前 Sprint 的任务列表。）',
      '',
      '## Constraints',
      '',
      '（不可协商的红线：分层、依赖、技术选型边界。）',
      '',
    ].join('\n'),
  );
  ensure(
    join(root, 'specs', '.keep'),
    '# Living Spec 放这里，按稳定的 Capability 命名（不是按 Mission）。\n',
  );
  ensure(
    join(root, 'architecture', 'decisions', '.keep'),
    '# ADR 放这里：一次长期取舍 + 为什么这么选。\n',
  );
  return created;
}

/**
 * 落地时**会写进项目的**那些文件。只算路径，不写盘。
 *
 * 给检视面用。记忆文件是在 merge 那一刻才写进 worktree 的，所以检视时
 * `workspace.diff()` 里根本没有它们 —— L3 读作"将要落地的东西"的那一块，
 * 系统性地少掉这几份，而且没有任何提示。实测 P1 就这么落了三个我没看过的文件。
 *
 * **VIBE.md 必须列进来。** 它不在 memoryDelta 里，是 writeVibe 无条件重写的，
 * 于是「批准 N 条记忆、落地 N+1 个文件」，那多出来的一个谁都没看过 ——
 * 而它写在别人仓库的根目录上。
 */
export function plannedMemoryFiles(deltas: readonly Pick<MemoryDelta, 'kind' | 'slug'>[]): string[] {
  if (deltas.length === 0) return [];
  return [
    ...deltas.map((delta) =>
      delta.kind === 'adr'
        ? `${DIR}/architecture/decisions/${delta.slug}.md`
        : `${DIR}/specs/${delta.slug}.md`,
    ),
    'VIBE.md',
  ];
}

/**
 * 把 L3 批准的 memory 改动写进指定目录（通常是 Mission 的 worktree）。
 *
 * 返回实际写了哪些文件。写在 worktree 里而不是目标分支上，是为了让它们
 * 跟代码同一次 merge 落地。
 */
export function applyMemoryDelta(
  worktreeRoot: string,
  deltas: readonly MemoryDelta[],
): string[] {
  const written: string[] = [];
  for (const delta of deltas) {
    const dir =
      delta.kind === 'adr'
        ? join(worktreeRoot, DIR, 'architecture', 'decisions')
        : join(worktreeRoot, DIR, 'specs');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${delta.slug}.md`);
    const body = delta.body.startsWith('# ')
      ? delta.body
      : `# ${delta.title}\n\n${delta.body}\n`;
    writeFileSync(path, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
    written.push(path.slice(resolve(worktreeRoot).length + 1).replaceAll('\\', '/'));
  }
  return written;
}

/**
 * 生成 VIBE.md。
 *
 * **它是生成物，不是手写的 Source of Truth**（S04.4）。手改会在下一次生成时
 * 被覆盖，所以文件头写明这一点——不写的话总会有人在里面加东西然后丢掉。
 */
export function generateVibe(memory: ProjectMemory): string {
  const lines: string[] = [];
  lines.push(`# ${memory.projectName}`);
  lines.push('');
  lines.push('> 本文件由 CoAgentHub 生成，**不要手工编辑** —— 改动会在下次生成时丢失。');
  lines.push(`> 内容来自 \`${DIR}/\`，跟代码同一个版本。`);
  lines.push('');

  if (memory.projectProfile) {
    lines.push(stripHeading(memory.projectProfile).trim());
    lines.push('');
  }

  lines.push('## Capability 索引');
  lines.push('');
  if (memory.specs.length === 0) {
    lines.push('（还没有 Living Spec）');
  } else {
    for (const spec of memory.specs) {
      lines.push(`- **${spec.slug}** — ${spec.title}`);
      const summary = firstParagraph(spec.body);
      if (summary) lines.push(`  ${summary}`);
    }
  }
  lines.push('');

  lines.push('## 架构决策');
  lines.push('');
  if (memory.decisions.length === 0) {
    lines.push('（还没有 ADR）');
  } else {
    for (const decision of memory.decisions) {
      lines.push(`- **${decision.slug}** — ${decision.title}`);
    }
  }
  lines.push('');

  lines.push('## 给 Agent 的规则');
  lines.push('');
  lines.push('- 实现只是把既有行为修回来 → **不要**动 Living Spec。');
  lines.push('- 新增或改变了可观察行为 → 更新对应 Capability 的 Living Spec。');
  lines.push('- 跨 Mission 的长期技术取舍 → 写一份 ADR，说清楚为什么这么选。');
  lines.push('- 「已修复 / 已完成」必须有可验证证据；没跑过的命令不要写成跑过。');
  lines.push('');
  return lines.join('\n');
}

function firstParagraph(body: string): string {
  // 跳过**任意层级**的开头标题，不只是 `# `。正文经常直接以 `## 某函数`
  // 起头，只剥一级的话索引里印出来的就是这个标题——既没信息量，又把一个
  // `##` 塞进了列表项底下，把 VIBE.md 的结构撑坏。
  const paragraph = stripHeading(body)
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .find((block) => block.length > 0 && !/^#{1,6}\s/.test(block));
  return (paragraph ?? '').replace(/\s+/g, ' ').slice(0, 120);
}

/** 生成并写入 VIBE.md。返回路径。 */
export function writeVibe(worktreeRoot: string, fallbackName?: string): string {
  const memory = readProjectMemory(worktreeRoot, fallbackName);
  const path = join(resolve(worktreeRoot), 'VIBE.md');
  writeFileSync(path, generateVibe(memory), 'utf8');
  return 'VIBE.md';
}
