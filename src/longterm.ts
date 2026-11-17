/**
 * Reviewed long-term memory: a small, deliberately curated layer on top of
 * observations. Items are proposed (by an agent, a person, or by promoting an
 * observation), and only approved items reach the project brief. Every review
 * action records a reason, so the store says why each item is trusted.
 *
 *   kind   semantic   a stable fact ("the API is stateless; auth is JWT")
 *          procedural how to do something ("release: build, test, tag, push")
 *          episodic   a notable event ("2026-11 outage came from pool exhaustion")
 *   scope  project    this project only
 *          user       portable: shown in every project (a personal preference)
 *   state  proposed -> approved; archived and superseded leave retrieval
 */
import type { DB } from './db.js';
import { buildFtsQuery } from './search.js';
import { redactSecrets } from './secrets.js';
import { getObservations } from './store.js';

export const LT_KINDS = ['semantic', 'procedural', 'episodic'] as const;
export const LT_SCOPES = ['project', 'user'] as const;
export const LT_STATES = ['proposed', 'approved', 'archived', 'superseded'] as const;
export type LtKind = (typeof LT_KINDS)[number];
export type LtScope = (typeof LT_SCOPES)[number];
export type LtState = (typeof LT_STATES)[number];

export const LT_KIND_LABEL: Record<LtKind, string> = { semantic: 'FACT', procedural: 'PROCEDURE', episodic: 'EVENT' };

export interface LongTermItem {
  id: number;
  /** Project the item was proposed in; user-scope items are visible from every project. */
  projectId: string;
  scope: LtScope;
  kind: LtKind;
  title: string;
  body: string;
  applicability?: string;
  evidence: string[];
  state: LtState;
  /** Reason given at the latest review action. */
  reason?: string;
  supersededBy?: number;
  sourceObservationId?: number;
  proposedBy: string;
  createdAt: string;
  reviewedAt?: string;
}

export interface ProposeInput {
  projectId: string;
  kind: LtKind;
  title: string;
  body: string;
  scope?: LtScope;
  applicability?: string;
  evidence?: string[];
  sourceObservationId?: number;
  proposedBy?: string;
}

function toItem(r: Record<string, unknown>): LongTermItem {
  return {
    id: Number(r.id),
    projectId: String(r.projectId),
    scope: r.scope as LtScope,
    kind: r.kind as LtKind,
    title: String(r.title),
    body: String(r.body),
    applicability: (r.applicability as string) ?? undefined,
    evidence: JSON.parse(String(r.evidence || '[]')),
    state: r.state as LtState,
    reason: (r.reason as string) ?? undefined,
    supersededBy: r.supersededBy == null ? undefined : Number(r.supersededBy),
    sourceObservationId: r.sourceObservationId == null ? undefined : Number(r.sourceObservationId),
    proposedBy: String(r.proposedBy),
    createdAt: String(r.createdAt),
    reviewedAt: (r.reviewedAt as string) ?? undefined,
  };
}

const clean = (s: string | undefined, max: number) => (s?.trim() ? redactSecrets(s.trim()).slice(0, max) : null);
const VISIBLE = "(projectId = ? OR scope = 'user')";

/** Item by id, only if visible from this project. */
export function getLongTerm(db: DB, projectId: string, id: number): LongTermItem | undefined {
  const r = db.prepare(`SELECT * FROM long_term WHERE id = ? AND ${VISIBLE}`).get(id, projectId) as Record<string, unknown> | undefined;
  return r ? toItem(r) : undefined;
}

/**
 * Propose an item for review. A proposal whose title matches a live
 * (proposed or approved) item in the same scope returns that item instead.
 */
export function proposeLongTerm(db: DB, input: ProposeInput): { item: LongTermItem; action: 'proposed' | 'exists' } {
  const title = clean(input.title, 200);
  const body = clean(input.body, 4000);
  if (!title || !body) throw new Error('title and body are required');
  if (!LT_KINDS.includes(input.kind)) throw new Error(`kind must be one of ${LT_KINDS.join(', ')}`);
  const scope = input.scope ?? 'project';
  if (!LT_SCOPES.includes(scope)) throw new Error(`scope must be one of ${LT_SCOPES.join(', ')}`);

  const dup = db
    .prepare(
      `SELECT * FROM long_term WHERE lower(title) = lower(?) AND scope = ? AND state IN ('proposed','approved')
       AND (scope = 'user' OR projectId = ?) LIMIT 1`,
    )
    .get(title, scope, input.projectId) as Record<string, unknown> | undefined;
  if (dup) return { item: toItem(dup), action: 'exists' };

  const evidence = (input.evidence ?? []).map((e) => redactSecrets(String(e).trim()).slice(0, 300)).filter(Boolean);
  const r = db
    .prepare(
      `INSERT INTO long_term(projectId, scope, kind, title, body, applicability, evidence, state, sourceObservationId, proposedBy, createdAt)
       VALUES(?,?,?,?,?,?,?,'proposed',?,?,?)`,
    )
    .run(
      input.projectId, scope, input.kind, title, body, clean(input.applicability, 500), JSON.stringify(evidence),
      input.sourceObservationId ?? null, input.proposedBy ?? 'agent', new Date().toISOString(),
    );
  return { item: getLongTerm(db, input.projectId, Number(r.lastInsertRowid))!, action: 'proposed' };
}

/** Propose an existing observation as long-term memory; the observation becomes its evidence. */
export function promoteToLongTerm(
  db: DB, projectId: string, observationId: number, opts: { kind: LtKind; scope?: LtScope; applicability?: string; proposedBy?: string },
): { item: LongTermItem; action: 'proposed' | 'exists' } {
  const [o] = getObservations(db, [observationId]);
  if (!o || o.projectId !== projectId) throw new Error(`Memory #${observationId} not found in this project`);
  const body = [o.narrative, ...o.facts.map((f) => `- ${f}`)].filter((s) => s.trim()).join('\n') || o.title;
  return proposeLongTerm(db, {
    projectId,
    kind: opts.kind,
    scope: opts.scope,
    title: o.title,
    body,
    applicability: opts.applicability,
    evidence: [`#${o.id}`, ...(o.commitHash ? [`commit:${o.commitHash.slice(0, 12)}`] : [])],
    sourceObservationId: o.id,
    proposedBy: opts.proposedBy,
  });
}

function requireReason(reason: string | undefined): string {
  const r = clean(reason, 500);
  if (!r) throw new Error('a reason is required for every review action');
  return r;
}

/** Approve or archive an item. Approving works from proposed or archived; archiving from proposed or approved. */
export function reviewLongTerm(db: DB, projectId: string, id: number, action: 'approve' | 'archive', reason: string): LongTermItem {
  const r = requireReason(reason);
  const item = getLongTerm(db, projectId, id);
  if (!item) throw new Error(`Long-term item LT${id} not found`);
  const allowed: Record<typeof action, LtState[]> = { approve: ['proposed', 'archived'], archive: ['proposed', 'approved'] };
  if (!allowed[action].includes(item.state)) throw new Error(`LT${id} is ${item.state}; cannot ${action}`);
  db.prepare('UPDATE long_term SET state = ?, reason = ?, reviewedAt = ? WHERE id = ?').run(
    action === 'approve' ? 'approved' : 'archived', r, new Date().toISOString(), id,
  );
  return getLongTerm(db, projectId, id)!;
}

/** Replace an approved item with a newer one; the old one leaves retrieval and points at its replacement. */
export function supersedeLongTerm(db: DB, projectId: string, oldId: number, newId: number, reason: string): LongTermItem {
  const r = requireReason(reason);
  if (oldId === newId) throw new Error('an item cannot supersede itself');
  const old = getLongTerm(db, projectId, oldId);
  const next = getLongTerm(db, projectId, newId);
  if (!old) throw new Error(`Long-term item LT${oldId} not found`);
  if (!next) throw new Error(`Long-term item LT${newId} not found`);
  if (old.state !== 'approved') throw new Error(`LT${oldId} is ${old.state}; only approved items can be superseded`);
  if (next.state === 'archived' || next.state === 'superseded') throw new Error(`LT${newId} is ${next.state}; supersede with a live item`);
  db.prepare("UPDATE long_term SET state = 'superseded', supersededBy = ?, reason = ?, reviewedAt = ? WHERE id = ?").run(
    newId, r, new Date().toISOString(), oldId,
  );
  return getLongTerm(db, projectId, oldId)!;
}

/** Items visible from this project, newest first; `query` filters by full-text match. */
export function listLongTerm(db: DB, projectId: string, opts: { state?: LtState | 'all'; query?: string; limit?: number } = {}): LongTermItem[] {
  const where = [VISIBLE];
  const params: (string | number)[] = [projectId];
  if (opts.state && opts.state !== 'all') {
    where.push('state = ?');
    params.push(opts.state);
  }
  const fts = opts.query ? buildFtsQuery(opts.query) : null;
  if (opts.query && !fts) return [];
  if (fts) {
    where.push('id IN (SELECT rowid FROM long_term_fts WHERE long_term_fts MATCH ?)');
    params.push(fts);
  }
  params.push(opts.limit ?? 50);
  return (db.prepare(`SELECT * FROM long_term WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...params) as Record<string, unknown>[]).map(toItem);
}

/** Approved items for the brief: matches for the task first, then the most recently reviewed. */
export function approvedForBrief(db: DB, projectId: string, task: string, limit = 5): LongTermItem[] {
  const approved = listLongTerm(db, projectId, { state: 'approved', limit: 200 });
  const matched = new Set(task.trim() ? listLongTerm(db, projectId, { state: 'approved', query: task, limit: 200 }).map((i) => i.id) : []);
  const recency = (i: LongTermItem) => i.reviewedAt ?? i.createdAt;
  return approved
    .sort((a, b) => Number(matched.has(b.id)) - Number(matched.has(a.id)) || recency(b).localeCompare(recency(a)))
    .slice(0, limit);
}

export function pendingLongTermCount(db: DB, projectId: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM long_term WHERE state = 'proposed' AND ${VISIBLE}`).get(projectId) as { n: number }).n);
}

/** One compact line: `[PROCEDURE] Release steps — build, test, tag (LT3, user)`. */
export function ltLine(i: LongTermItem, maxBody = 200): string {
  const body = i.body.replace(/\s+/g, ' ');
  const clipped = body.length > maxBody ? body.slice(0, maxBody) + '…' : body;
  const tags = [`LT${i.id}`, i.scope === 'user' ? 'user' : '', i.state !== 'approved' ? i.state : ''].filter(Boolean).join(', ');
  return `[${LT_KIND_LABEL[i.kind]}] ${i.title} — ${clipped} (${tags})`;
}

export function ltDetail(i: LongTermItem): string {
  const header = [
    `LT${i.id} [${LT_KIND_LABEL[i.kind]}] ${i.title}`,
    `State: ${i.state}${i.supersededBy ? ` (by LT${i.supersededBy})` : ''} · scope: ${i.scope} · proposed by ${i.proposedBy} ${i.createdAt.slice(0, 10)}`,
    i.reason ? `Review reason${i.reviewedAt ? ` (${i.reviewedAt.slice(0, 10)})` : ''}: ${i.reason}` : '',
    i.applicability ? `Applies when: ${i.applicability}` : '',
    i.evidence.length ? `Evidence: ${i.evidence.join(', ')}` : '',
  ].filter(Boolean);
  return `${header.join('\n')}\n\n${i.body}`;
}
