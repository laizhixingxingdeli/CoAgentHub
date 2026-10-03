import type { Mission } from '../../kernel/index.ts';
import { PlatformRuleError, type PlatformContext } from './context.ts';
import { applyDocumentChanges, commitDocument, documentHash, readDocument, safeDocumentPath, type DocumentChange } from '../document-files.ts';

export interface DocumentProposal {
  id: string; projectId: string; missionId: string; root: string; path: string; title: string;
  revision: number; base: string; baseHash: string; changes: readonly DocumentChange[]; proposed: string;
  state: 'proposed' | 'approved' | 'withdrawn' | 'committed' | 'needs_revision';
  at: string; error?: string; reviewer?: string; reason?: string; commit?: string;
}
export interface DocumentDecision {
  action: 'approve' | 'edit' | 'withdraw'; reviewer: string; reason: string;
  revision: number; baseHash: string; changes?: readonly DocumentChange[];
}
export async function listDocumentProposals(ctx: PlatformContext, projectId?: string): Promise<DocumentProposal[]> {
  const rows = new Map<string, DocumentProposal>();
  for (const project of await ctx.projects.list()) {
    if (projectId && project.id !== projectId) continue;
    for (const mission of project.missions) for (const event of await ctx.activity.list(mission.id)) {
      if (event.kind !== 'document.proposal_changed') continue;
      const row = event.data as DocumentProposal;
      rows.set(row.id, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
async function record(ctx: PlatformContext, row: DocumentProposal) {
  const { mission } = await ctx.locate(row.missionId);
  const next = { ...row, at: ctx.clock.now().toISOString() };
  await ctx.event(mission, 'document.proposal_changed', next);
  return next;
}
export async function proposeDocument(ctx: PlatformContext, input: { missionId: string; path: string; title: string; changes: readonly DocumentChange[]; reviewer: string; reason: string }) {
  const { mission } = await ctx.locate(input.missionId);
  if (!mission.workspaceRef?.projectRoot) throw new PlatformRuleError('DOCUMENT_WORKSPACE_REQUIRED', '提议需要可信项目工作区');
  const root = mission.workspaceRef.projectRoot;
  const path = safeDocumentPath(input.path);
  const base = readDocument(root, path);
  if (typeof input.reviewer !== 'string' || !input.reviewer.trim() || typeof input.reason !== 'string' || !input.reason.trim()
      || typeof input.title !== 'string' || !input.title.trim()) throw new PlatformRuleError('DOCUMENT_SIGNATURE_REQUIRED', '需要标题、检视者与理由');
  return record(ctx, { id: ctx.ids.next('DOC'), projectId: mission.projectId, missionId: mission.id, root, path,
    title: input.title, revision: 1, base, baseHash: documentHash(base), changes: input.changes,
    proposed: applyDocumentChanges(base, input.changes), state: 'proposed', at: '', reviewer: input.reviewer, reason: input.reason });
}
/** 交卷提议只排队。旧整份正文转换成显式替换差异，不代表已获批准。 */
export async function captureMissionDocuments(ctx: PlatformContext, mission: Mission, submission: string) {
  if (!mission.result?.memoryDelta?.length) return;
  const known = new Set((await listDocumentProposals(ctx)).map((row) => row.id));
  for (const [index, proposal] of (mission.result?.memoryDelta ?? []).entries()) {
    const id = `DOC:${mission.id}:${submission}:${index}`;
    if (known.has(id)) continue;
    const root = mission.workspaceRef?.projectRoot ?? '';
    let path = ''; let base = ''; let changes: readonly DocumentChange[] = []; let proposed = ''; let error: string | undefined;
    try {
      if (!root || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(proposal.slug) || !['adr', 'living_spec'].includes(proposal.kind)) throw new Error('DOCUMENT_PROPOSAL_INVALID');
      path = safeDocumentPath(proposal.kind === 'adr' ? `.coagent/architecture/decisions/${proposal.slug}.md` : `.coagent/specs/${proposal.slug}.md`);
      base = readDocument(root, path);
      if (proposal.changes) changes = proposal.changes;
      else {
        if (typeof proposal.body !== 'string') throw new Error('DOCUMENT_CHANGES_REQUIRED');
        const body = proposal.body.startsWith('# ') ? proposal.body : `# ${proposal.title}\n\n${proposal.body}\n`;
        changes = [{ before: base, after: body.endsWith('\n') ? body : `${body}\n` }];
      }
      proposed = applyDocumentChanges(base, changes);
    } catch (cause) { error = cause instanceof Error ? cause.message : 'DOCUMENT_PROPOSAL_INVALID'; }
    await record(ctx, { id, projectId: mission.projectId, missionId: mission.id, root, path, title: proposal?.title ?? '无效文档提议',
      revision: 1, base, baseHash: documentHash(base), changes, proposed, state: error ? 'needs_revision' : 'proposed', at: '', error });
  }
}
export async function decideDocument(ctx: PlatformContext, id: string, input: DocumentDecision) {
  const row = (await listDocumentProposals(ctx)).find((entry) => entry.id === id);
  if (!row) throw new PlatformRuleError('DOCUMENT_NOT_FOUND', '文档提议不存在');
  if (typeof input.reviewer !== 'string' || !input.reviewer.trim() || typeof input.reason !== 'string' || !input.reason.trim()
      || !['approve', 'edit', 'withdraw'].includes(input.action)) throw new PlatformRuleError('DOCUMENT_SIGNATURE_REQUIRED', '需要有效操作、检视者与理由');
  if (row.state === 'committed' || row.state === 'withdrawn') throw new PlatformRuleError('DOCUMENT_ALREADY_CLOSED', '已提交或撤回的提议不可再改');
  if (row.revision !== input.revision || row.baseHash !== input.baseHash) throw new PlatformRuleError('DOCUMENT_REVIEW_STALE', '审查版本或基线不符，请刷新差异');
  const signature = { reviewer: input.reviewer.trim(), reason: input.reason.trim() };
  if (input.action === 'withdraw') return record(ctx, { ...row, ...signature, state: 'withdrawn' });
  if (input.action === 'edit') {
    const base = readDocument(row.root, row.path);
    const proposed = applyDocumentChanges(base, input.changes ?? []);
    return record(ctx, { ...row, ...signature, base, baseHash: documentHash(base), changes: input.changes!, proposed,
      revision: row.revision + 1, state: 'proposed', error: undefined });
  }
  if (row.error || !row.path || readDocument(row.root, row.path) !== row.base) throw new PlatformRuleError('DOCUMENT_BASE_CHANGED', '文档已变化或差异无效，需要编辑并重新审批');
  if (row.state === 'approved') return row;
  return record(ctx, { ...row, ...signature, state: 'approved' });
}
export async function flushDocumentQueue(ctx: PlatformContext, projectId?: string) {
  const committed: string[] = []; const deferred: string[] = []; const errors: Array<{ id: string; reason: string }> = [];
  const projects = await ctx.projects.list();
  for (const row of await listDocumentProposals(ctx, projectId)) {
    if (row.state !== 'approved') continue;
    const project = projects.find((entry) => entry.id === row.projectId);
    const active = project?.missions.some((mission) => !['completed', 'cancelled', 'failed', 'blocked'].includes(mission.status) && !mission.isParked
      || [...mission.coordinatorAttempts, ...mission.independentReviewerAttempts, ...mission.workItems.flatMap((item) => item.attempts)].some((attempt) => attempt.status === 'in_progress'));
    if (!project || active) { deferred.push(row.id); errors.push({ id: row.id, reason: 'DOCUMENT_MISSION_ACTIVE' }); continue; }
    try {
      const commit = await commitDocument({ root: row.root, path: row.path, before: row.base, after: row.proposed,
        marker: `CoAgentHub-Document-Proposal: ${row.id}@${row.revision}`, projectId: row.projectId });
      await record(ctx, { ...row, state: 'committed', commit, error: undefined }); committed.push(row.id);
      const { mission } = await ctx.locate(row.missionId);
      await ctx.event(mission, 'memory.applied', { written: [row.path, 'VIBE.md'], proposalId: row.id, commit });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'DOCUMENT_COMMIT_FAILED';
      if (code === 'DOCUMENT_BASE_CHANGED') await record(ctx, { ...row, state: 'needs_revision', error: code });
      // 环境暂不可写时保留批准与队列，避免通知/事件每轮刷屏。
      deferred.push(row.id);
      errors.push({ id: row.id, reason: code.startsWith('DOCUMENT_') ? code : 'DOCUMENT_COMMIT_FAILED' });
    }
  }
  return { committed, deferred, errors };
}
