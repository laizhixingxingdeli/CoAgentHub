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
  readonly constitution: string | undefined;
  readonly specs: { slug: string; title: string; body: string }[];
  readonly decisions: { slug: string; title: string; body: string }[];
}

const DIR = '.coagent';

function firstHeading(body: string, fallback: string): string {
  const line = body.split(/\r?\n/).find((l) => l.startsWith('# '));
  return line ? line.slice(2).trim() : fallback;
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

/**
 * @param fallbackName 没有 project.yaml 时用它当项目名。**必须传 projectId**，
 *   不能靠目录名兜底——落地时读的是 Mission 的 worktree，那个目录叫
 *   Mission ID，于是 VIBE.md 的标题会变成「M-ctx」而不是项目名。
 */
export function readProjectMemory(projectRoot: string, fallbackName?: string): ProjectMemory {
  const root = resolve(projectRoot, DIR);
  const constitutionPath = join(root, 'architecture', 'constitution.md');
  return {
    root,
    exists: existsSync(root),
    projectName: readProjectName(root, projectRoot, fallbackName),
    constitution: existsSync(constitutionPath)
      ? readFileSync(constitutionPath, 'utf8')
      : undefined,
    specs: readDocs(join(root, 'specs')),
    decisions: readDocs(join(root, 'architecture', 'decisions')),
  };
}

function readProjectName(root: string, projectRoot: string, fallbackName?: string): string {
  const path = join(root, 'project.yaml');
  if (!existsSync(path)) {
    return fallbackName ?? resolve(projectRoot).split(/[\\/]/).pop() ?? 'project';
  }
  // 只认 `name:` 这一行。引 YAML 解析器不值得——这里只需要一个名字。
  const line = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('name:'));
  return line ? line.split(':').slice(1).join(':').trim() : 'project';
}

/**
 * 在一个还没有 `.coagent/` 的仓库里建出骨架。
 *
 * 刻意只建目录和一份很短的 constitution：**内容该由用它的人写**，
 * 平台预填一堆模板文字只会被原样留在那儿，然后没人相信它。
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
    join(root, 'project.yaml'),
    ['# 项目长期事实的锚点。跟代码同一个版本。', `name: ${projectName}`, ''].join('\n'),
  );
  ensure(
    join(root, 'architecture', 'constitution.md'),
    [
      '# 架构约束',
      '',
      '这里写**不可协商**的东西：分层边界、禁止的依赖方向、必须守住的不变量。',
      '写进来的每一条都会被当成红线传给协调者和执行者，所以只写真的红线。',
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

  if (memory.constitution) {
    lines.push('## 架构约束');
    lines.push('');
    lines.push(stripHeading(memory.constitution).trim());
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

function stripHeading(body: string): string {
  return body.replace(/^#\s+.*\r?\n/, '');
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
