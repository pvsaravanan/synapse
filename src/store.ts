import { branchScope, scopeFor, trackBranch } from './branch.js';
import type { DB } from './db.js';
import { hashFile, hashFiles, type FileHashes } from './freshness.js';
import path from 'node:path';
import { redactSecrets } from './secrets.js';
import {
  OBSERVATION_TYPES,
  type FeedbackSignal,
  type Observation,
  type ObservationStatus,
  type ObservationType,
  type StoreInput,
  type StoreResult,
} from './types.js';
import type { ScoringContext } from './retention.js';

const CAUSAL = /\b(because|due to|caused by|so that|therefore|since|in order to|as a result|leads? to)\b/i;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function now(): string {
  return new Date().toISOString();
}

function uniq(list: string[] | undefined): string[] {
  return [...new Set((list ?? []).map((s) => s.trim()).filter(Boolean))];
}

function parseHashes(v: unknown): FileHashes {
  if (typeof v !== 'string' || !v) return {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseList(v: unknown): string[] {
  if (typeof v !== 'string' || !v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function rowToObservation(row: Record<string, unknown>): Observation {
  return {
    id: Number(row.id),
    projectId: String(row.projectId),
    entityName: String(row.entityName),
    type: row.type as Observation['type'],
    title: String(row.title),
    narrative: String(row.narrative ?? ''),
    facts: parseList(row.facts),
    filesModified: parseList(row.filesModified),
    concepts: parseList(row.concepts),
    tokens: Number(row.tokens ?? 0),
    createdAt: String(row.createdAt),
    updatedAt: (row.updatedAt as string) ?? undefined,
    topicKey: (row.topicKey as string) ?? undefined,
    revisionCount: Number(row.revisionCount ?? 1),
    sessionId: (row.sessionId as string) ?? undefined,
    status: (row.status as ObservationStatus) ?? 'active',
    supersededBy: row.supersededBy == null ? undefined : Number(row.supersededBy),
    progress: row.progress ? JSON.parse(String(row.progress)) : undefined,
    source: (row.source as Observation['source']) ?? 'agent',
    commitHash: (row.commitHash as string) ?? undefined,
    relatedCommits: parseList(row.relatedCommits),
    relatedEntities: parseList(row.relatedEntities),
    admissionState: (row.admissionState as Observation['admissionState']) ?? 'qualified',
    valueCategory: (row.valueCategory as Observation['valueCategory']) ?? undefined,
    hasCausalLanguage: Boolean(row.hasCausalLanguage),
    fileHashes: parseHashes(row.fileHashes),
    uid: (row.uid as string) ?? undefined,
    branch: (row.branch as string) ?? undefined,
  };
}

/** Token-set Jaccard similarity used for cheap duplicate detection. */
export function similarity(a: string, b: string): number {
  const tok = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []);
  const A = tok(a);
  const B = tok(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

const DUPLICATE_THRESHOLD = 0.82;

interface Sanitized {
  entityName: string;
  title: string;
  narrative: string;
  facts: string[];
  filesModified: string[];
  concepts: string[];
  /** Redacted too: hook topic keys embed raw command text (`hook/cmd/<command>/<session>`). */
  topicKey?: string;
}

function sanitize(input: StoreInput): Sanitized {
  return {
    entityName: redactSecrets(input.entityName.trim()) || 'project',
    title: redactSecrets(input.title.trim()),
    narrative: redactSecrets(input.narrative.trim()),
    facts: uniq(input.facts).map(redactSecrets),
    filesModified: uniq(input.filesModified),
    concepts: uniq(input.concepts).map((c) => redactSecrets(c).toLowerCase()),
    topicKey: input.topicKey ? redactSecrets(input.topicKey) : undefined,
  };
}

export function getObservation(db: DB, id: number): Observation | undefined {
  const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToObservation(row) : undefined;
}

export function getObservations(db: DB, ids: number[]): Observation[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(`SELECT * FROM observations WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as Record<string, unknown>[];
  const byId = new Map(rows.map((r) => [Number(r.id), rowToObservation(r)]));
  return ids.map((id) => byId.get(id)).filter((o): o is Observation => Boolean(o));
}

export interface ListOptions {
  projectId?: string;
  status?: ObservationStatus | 'all';
  type?: string[];
  limit?: number;
  since?: string;
  entityName?: string;
  includeCandidates?: boolean;
  /** Visible on this branch (string), project-wide only (null), or every branch (undefined); see branchClause. */
  branch?: string | null;
}

/**
 * SQL for "visible on this branch": project-wide memories plus the branch's own, except a project-wide memory whose
 * topic the branch revised (its branch copy stands in for it there). `alias` is the observations table's name in the
 * query. Undefined branch: no condition (every branch).
 */
export function branchClause(branch: string | null | undefined, alias = 'observations'): { sql: string; params: string[] } | undefined {
  if (branch === undefined) return undefined;
  if (branch === null) return { sql: `${alias}.branch IS NULL`, params: [] };
  return {
    sql: `(${alias}.branch = ? OR (${alias}.branch IS NULL AND NOT (${alias}.topicKey IS NOT NULL AND EXISTS (SELECT 1 FROM observations sb
      WHERE sb.projectId = ${alias}.projectId AND sb.topicKey = ${alias}.topicKey AND sb.branch = ? AND sb.status = 'active'))))`,
    params: [branch, branch],
  };
}

/** The same rule as branchClause, for a memory already loaded. */
export function visibleOn(db: DB, o: Observation, branch: string | null | undefined): boolean {
  if (branch === undefined) return true;
  if (o.branch) return o.branch === branch;
  if (!branch || !o.topicKey) return true;
  return !db.prepare("SELECT 1 FROM observations WHERE projectId = ? AND topicKey = ? AND branch = ? AND status = 'active' LIMIT 1").get(o.projectId, o.topicKey, branch);
}

export function listObservations(db: DB, opts: ListOptions = {}): Observation[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.projectId) {
    where.push('projectId = ?');
    params.push(opts.projectId);
  }
  if (opts.status !== 'all') {
    where.push('status = ?');
    params.push(opts.status ?? 'active');
  }
  if (opts.type?.length) {
    where.push(`type IN (${opts.type.map(() => '?').join(',')})`);
    params.push(...opts.type);
  }
  if (opts.since) {
    where.push('COALESCE(updatedAt, createdAt) >= ?');
    params.push(opts.since);
  }
  if (opts.entityName) {
    where.push('entityName = ?');
    params.push(opts.entityName);
  }
  if (opts.includeCandidates === false) where.push("admissionState = 'qualified'");
  const scope = branchClause(opts.branch);
  if (scope) {
    where.push(scope.sql);
    params.push(...scope.params);
  }
  const sql =
    `SELECT * FROM observations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ` +
    `ORDER BY COALESCE(updatedAt, createdAt) DESC, id DESC LIMIT ?`;
  params.push(opts.limit ?? 1000);
  return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map(rowToObservation);
}

/**
 * Store an observation.
 *  1. topicKey upsert: same project + topicKey active record is revised in place.
 *  2. duplicate merge: near-identical active record (same entity+type) is refreshed.
 *  3. otherwise insert.
 */
function storeObservationInner(db: DB, input: StoreInput): StoreResult {
  const s = sanitize(input);
  const ts = now();
  const body = [s.title, s.narrative, ...s.facts].join('\n');
  const tokens = estimateTokens(body);
  const causal = CAUSAL.test(body) ? 1 : 0;
  // Hashes of the files named now; on an update they replace the old hashes for those files.
  const hashes = input.rootPath ? hashFiles(input.rootPath, s.filesModified) : {};
  const mergeHashes = (prev: FileHashes) => JSON.stringify({ ...prev, ...hashes });
  // On a feature branch the memory belongs to the branch (unless it holds everywhere); updates stay within a scope, so
  // revising a project-wide topic from a branch makes a branch copy that stands in for it there until the merge.
  let branch = input.scope === 'project' ? null : branchScope(input.rootPath) ?? null;
  let scopeReason: string | undefined;
  // Whether an agent's or person's memory belongs to the branch is decided from evidence (branch.ts scopeFor), unless
  // they chose; a memory revising a project-wide topic stays on the branch (it forks, so the default branch keeps its
  // version until the merge). Auto-captured records always belong to the branch.
  if (branch && !input.scope && (input.source ?? 'agent') !== 'hook' && input.source !== 'git') {
    const forks = s.topicKey && db.prepare("SELECT 1 FROM observations WHERE projectId = ? AND topicKey = ? AND branch IS NULL AND status = 'active'").get(input.projectId, s.topicKey);
    if (!forks) {
      const decided = scopeFor(input.rootPath!, {
        type: input.type, files: s.filesModified, text: [s.title, s.narrative, ...s.facts].join('\n'),
        sessionFiles: input.sessionId ? sessionEditedFiles(db, input.sessionId) : [],
      });
      if (decided.scope === 'project') branch = null;
      scopeReason = decided.why;
    }
  }
  if (branch) {
    try {
      const tracked = db.prepare("SELECT 1 FROM branch_scopes WHERE projectId = ? AND branch = ? AND state = 'open'").get(input.projectId, branch);
      if (!tracked) trackBranch(db, input.projectId, input.rootPath!, branch);
    } catch {
      /* tracking only helps merge detection later */
    }
  }

  if (s.topicKey) {
    const existing = db
      .prepare("SELECT * FROM observations WHERE projectId = ? AND topicKey = ? AND status = 'active' AND branch IS ? ORDER BY id DESC LIMIT 1")
      .get(input.projectId, s.topicKey, branch) as Record<string, unknown> | undefined;
    if (existing) {
      const prev = rowToObservation(existing);
      db.prepare(
        `UPDATE observations SET entityName=?, type=?, title=?, narrative=?, facts=?, filesModified=?, concepts=?,
         tokens=?, updatedAt=?, revisionCount=revisionCount+1, sessionId=COALESCE(?, sessionId), progress=?,
         relatedCommits=?, relatedEntities=?, hasCausalLanguage=?, admissionState=?, valueCategory=COALESCE(?, valueCategory),
         fileHashes=? WHERE id=?`,
      ).run(
        s.entityName, input.type, s.title, s.narrative, JSON.stringify(s.facts),
        JSON.stringify(uniq([...prev.filesModified, ...s.filesModified])),
        JSON.stringify(uniq([...prev.concepts, ...s.concepts])),
        tokens, ts, input.sessionId ?? null, input.progress ? JSON.stringify(input.progress) : null,
        JSON.stringify(uniq([...prev.relatedCommits, ...(input.relatedCommits ?? [])])),
        JSON.stringify(uniq([...prev.relatedEntities, ...(input.relatedEntities ?? [])])),
        causal, input.admissionState ?? 'qualified', input.valueCategory ?? null, mergeHashes(prev.fileHashes), prev.id,
      );
      snapshotRevision(db, prev, { change: 'topic-update', sessionId: input.sessionId });
      return { observation: getObservation(db, prev.id)!, action: 'updated-topic', scopeReason };
    }
  }

  if (!s.topicKey) {
    const candidates = db
      .prepare(
        "SELECT * FROM observations WHERE projectId = ? AND entityName = ? AND type = ? AND status = 'active' AND branch IS ? ORDER BY id DESC LIMIT 50",
      )
      .all(input.projectId, s.entityName, input.type, branch) as Record<string, unknown>[];
    for (const row of candidates) {
      const o = rowToObservation(row);
      const sim = similarity(`${o.title} ${o.narrative}`, `${s.title} ${s.narrative}`);
      if (sim >= DUPLICATE_THRESHOLD) {
        const keepNew = s.narrative.length >= o.narrative.length;
        db.prepare(
          `UPDATE observations SET title=?, narrative=?, facts=?, filesModified=?, concepts=?, tokens=?, updatedAt=?,
           revisionCount=revisionCount+1, admissionState=CASE WHEN ?='qualified' THEN 'qualified' ELSE admissionState END,
           fileHashes=? WHERE id=?`,
        ).run(
          keepNew ? s.title : o.title,
          keepNew ? s.narrative : o.narrative,
          JSON.stringify(uniq([...o.facts, ...s.facts])),
          JSON.stringify(uniq([...o.filesModified, ...s.filesModified])),
          JSON.stringify(uniq([...o.concepts, ...s.concepts])),
          keepNew ? tokens : o.tokens,
          ts,
          input.admissionState ?? 'qualified',
          mergeHashes(o.fileHashes),
          o.id,
        );
        snapshotRevision(db, o, { change: 'duplicate-merge', sessionId: input.sessionId });
        return { observation: getObservation(db, o.id)!, action: 'merged-duplicate', scopeReason };
      }
    }
  }

  const info = db
    .prepare(
      `INSERT INTO observations (projectId, entityName, type, title, narrative, facts, filesModified, concepts, tokens,
        createdAt, topicKey, sessionId, progress, source, commitHash, relatedCommits, relatedEntities, admissionState,
        valueCategory, hasCausalLanguage, fileHashes, branch)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.projectId, s.entityName, input.type, s.title, s.narrative,
      JSON.stringify(s.facts), JSON.stringify(s.filesModified), JSON.stringify(s.concepts), tokens,
      ts, s.topicKey ?? null, input.sessionId ?? null,
      input.progress ? JSON.stringify(input.progress) : null,
      input.source ?? 'agent', input.commitHash ?? null,
      JSON.stringify(uniq(input.relatedCommits)), JSON.stringify(uniq(input.relatedEntities)),
      input.admissionState ?? 'qualified', input.valueCategory ?? null, causal, JSON.stringify(hashes), branch,
    );
  return { observation: getObservation(db, Number(info.lastInsertRowid))!, action: 'created', scopeReason };
}

export function setStatus(db: DB, ids: number[], status: ObservationStatus, projectId?: string): number {
  if (ids.length === 0) return 0;
  const params: (string | number)[] = [status, now(), ...ids];
  let sql = `UPDATE observations SET status = ?, updatedAt = ? WHERE id IN (${ids.map(() => '?').join(',')})`;
  if (projectId) {
    sql += ' AND projectId = ?';
    params.push(projectId);
  }
  return Number(db.prepare(sql).run(...params).changes);
}

export function promoteObservation(db: DB, id: number): boolean {
  return Number(db.prepare("UPDATE observations SET admissionState = 'qualified' WHERE id = ?").run(id).changes) > 0;
}

export function deleteObservation(db: DB, id: number): boolean {
  db.prepare('DELETE FROM observation_revisions WHERE observationId = ?').run(id);
  db.prepare('DELETE FROM observation_access WHERE observationId = ?').run(id);
  db.prepare('DELETE FROM feedback WHERE observationId = ?').run(id);
  db.prepare('DELETE FROM embeddings WHERE observationId = ?').run(id);
  return Number(db.prepare('DELETE FROM observations WHERE id = ?').run(id).changes) > 0;
}

export function recordAccess(db: DB, ids: number[]): void {
  const stmt = db.prepare(
    `INSERT INTO observation_access(observationId, accessCount, lastAccessed) VALUES(?, 1, ?)
     ON CONFLICT(observationId) DO UPDATE SET accessCount = accessCount + 1, lastAccessed = excluded.lastAccessed`,
  );
  const ts = now();
  for (const id of ids) stmt.run(id, ts);
}

export function recordFeedback(db: DB, id: number, signal: FeedbackSignal, note?: string, rootPath?: string): void {
  db.prepare('INSERT INTO feedback(observationId, signal, note, createdAt) VALUES(?,?,?,?)').run(id, signal, note ?? null, now());
  if (signal === 'outdated') setStatus(db, [id], 'resolved');
  if (signal === 'verified' && rootPath) refreshFileHashes(db, id, rootPath);
}

/**
 * Re-record a memory's file hashes from current content (after checking it still matches the code).
 * Covers every file it names, so memories stored before hashing existed start being tracked too.
 */
export function refreshFileHashes(db: DB, id: number, rootPath: string): boolean {
  const o = getObservation(db, id);
  if (!o) return false;
  const files = [...new Set([...o.filesModified, ...Object.keys(o.fileHashes)])];
  db.prepare('UPDATE observations SET fileHashes = ? WHERE id = ?').run(JSON.stringify(hashFiles(rootPath, files)), id);
  return true;
}

/**
 * A session's own edits are part of its work, not drift: re-hash the files its memories name, so storing a
 * decision and then implementing it doesn't flag the decision. Only files the session itself edited are
 * re-hashed (`file`, or every file its hook-captured edits name), so changes by you or another agent still flag.
 */
export function refreshSessionHashes(db: DB, sessionId: string, rootPath: string, file?: string): number {
  const edited = new Set(file ? [file] : sessionEditedFiles(db, sessionId));
  if (edited.size === 0) return 0;
  const rows = db
    .prepare("SELECT id, fileHashes FROM observations WHERE sessionId = ? AND fileHashes != '{}'")
    .all(sessionId) as { id: number; fileHashes: string }[];
  const update = db.prepare('UPDATE observations SET fileHashes = ? WHERE id = ?');
  const cache = new Map<string, string>();
  let changed = 0;
  for (const r of rows) {
    const hashes = parseHashes(r.fileHashes);
    let dirty = false;
    for (const key of Object.keys(hashes)) {
      if (!edited.has(key)) continue;
      if (!cache.has(key)) cache.set(key, hashFile(path.join(rootPath, key)));
      if (hashes[key] !== cache.get(key)) {
        hashes[key] = cache.get(key)!;
        dirty = true;
      }
    }
    if (dirty) {
      update.run(JSON.stringify(hashes), r.id);
      changed++;
    }
  }
  return changed;
}

/** Project-relative files a session edited, from its hook-captured edit records. */
export function sessionEditedFiles(db: DB, sessionId: string): string[] {
  const rows = db
    .prepare("SELECT filesModified FROM observations WHERE sessionId = ? AND source = 'hook' AND type = 'what-changed'")
    .all(sessionId) as { filesModified: string }[];
  return [...new Set(rows.flatMap((r) => parseList(r.filesModified)))];
}

/** Access counts and feedback weights for scoring. */
export function scoringContexts(db: DB, ids: number[]): Map<number, ScoringContext> {
  const out = new Map<number, ScoringContext>();
  if (ids.length === 0) return out;
  const ph = ids.map(() => '?').join(',');
  for (const r of db.prepare(`SELECT observationId, accessCount FROM observation_access WHERE observationId IN (${ph})`).all(...ids) as {
    observationId: number;
    accessCount: number;
  }[]) {
    out.set(Number(r.observationId), { accessCount: Number(r.accessCount) });
  }
  for (const r of db
    .prepare(
      `SELECT observationId, SUM(CASE WHEN signal IN ('helpful', 'verified') THEN 1 ELSE -1 END) AS w FROM feedback
       WHERE observationId IN (${ph}) GROUP BY observationId`,
    )
    .all(...ids) as { observationId: number; w: number }[]) {
    const id = Number(r.observationId);
    out.set(id, { ...(out.get(id) ?? {}), feedbackWeight: Number(r.w) });
  }
  return out;
}

/** Chronological neighbours of an anchor observation within its project. */
export function timeline(db: DB, anchorId: number, before = 3, after = 3): { anchor?: Observation; before: Observation[]; after: Observation[] } {
  const anchor = getObservation(db, anchorId);
  if (!anchor) return { before: [], after: [] };
  const b = (db
    .prepare('SELECT * FROM observations WHERE projectId = ? AND (createdAt < ? OR (createdAt = ? AND id < ?)) ORDER BY createdAt DESC, id DESC LIMIT ?')
    .all(anchor.projectId, anchor.createdAt, anchor.createdAt, anchor.id, before) as Record<string, unknown>[])
    .map(rowToObservation)
    .reverse();
  const a = (db
    .prepare('SELECT * FROM observations WHERE projectId = ? AND (createdAt > ? OR (createdAt = ? AND id > ?)) ORDER BY createdAt ASC, id ASC LIMIT ?')
    .all(anchor.projectId, anchor.createdAt, anchor.createdAt, anchor.id, after) as Record<string, unknown>[])
    .map(rowToObservation);
  return { anchor, before: b, after: a };
}

export function projectStats(db: DB, projectId?: string): { total: number; byStatus: Record<string, number>; byType: Record<string, number> } {
  const where = projectId ? 'WHERE projectId = ?' : '';
  const params = projectId ? [projectId] : [];
  const byStatus: Record<string, number> = {};
  for (const r of db.prepare(`SELECT status, COUNT(*) AS n FROM observations ${where} GROUP BY status`).all(...params) as { status: string; n: number }[]) {
    byStatus[r.status] = Number(r.n);
  }
  const byType: Record<string, number> = {};
  for (const r of db
    .prepare(`SELECT type, COUNT(*) AS n FROM observations ${where ? where + " AND status = 'active'" : "WHERE status = 'active'"} GROUP BY type`)
    .all(...params) as { type: string; n: number }[]) {
    byType[r.type] = Number(r.n);
  }
  return { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus, byType };
}

export function listProjects(db: DB): { projectId: string; count: number; lastActivity: string }[] {
  return (db
    .prepare('SELECT projectId, COUNT(*) AS n, MAX(COALESCE(updatedAt, createdAt)) AS last FROM observations GROUP BY projectId ORDER BY last DESC')
    .all() as { projectId: string; n: number; last: string }[]).map((r) => ({ projectId: r.projectId, count: Number(r.n), lastActivity: r.last }));
}

/**
 * Store an observation. When the agent stores its own fix (problem-solution) in a session, the draft fixes that the
 * hooks made in that session for the same files are resolved: the agent's account of the cause replaces them.
 */
export function storeObservation(db: DB, input: StoreInput): StoreResult {
  const result = storeObservationInner(db, input);
  if ((input.source ?? 'agent') !== 'hook' && input.type === 'problem-solution' && input.sessionId) retireDraftFixes(db, result.observation);
  return result;
}

function retireDraftFixes(db: DB, fix: Observation): void {
  const drafts = (db
    .prepare("SELECT * FROM observations WHERE projectId = ? AND sessionId = ? AND source = 'hook' AND type = 'problem-solution' AND status = 'active'")
    .all(fix.projectId, fix.sessionId!) as Record<string, unknown>[]).map(rowToObservation);
  const files = new Set(fix.filesModified);
  const overlapping = drafts.filter((d) => files.size === 0 || d.filesModified.some((f) => files.has(f)));
  setStatus(db, overlapping.map((d) => d.id), 'resolved', fix.projectId);
}

export interface ObservationEdit {
  title?: string;
  narrative?: string;
  type?: string;
  entityName?: string;
  facts?: string[];
  filesModified?: string[];
  concepts?: string[];
  /** Also qualify it (a candidate someone kept, now with a better title). */
  qualify?: boolean;
}

/**
 * Edit a memory in place (a person fixing a title or narrative). Everything passes through redactSecrets; the revision
 * count goes up. Files it newly names are hashed from current content when `rootPath` is known, so they aren't
 * flagged as changed straight away. Throws on an unknown type or an empty title.
 */
export function editObservation(db: DB, id: number, edit: ObservationEdit, rootPath?: string, history: RevisionContext = { change: 'edit' }): Observation {
  const o = getObservation(db, id);
  if (!o) throw new Error(`No memory #${id}`);
  const type = (edit.type ?? o.type) as ObservationType;
  if (!(OBSERVATION_TYPES as readonly string[]).includes(type)) throw new Error(`Unknown type: ${type}`);
  const s = sanitize({
    projectId: o.projectId,
    type,
    entityName: edit.entityName ?? o.entityName,
    title: edit.title ?? o.title,
    narrative: edit.narrative ?? o.narrative,
    facts: edit.facts ?? o.facts,
    filesModified: (edit.filesModified ?? o.filesModified).map((f) => f.trim().replace(/^\.\//, '')),
    concepts: edit.concepts ?? o.concepts,
  });
  if (!s.title) throw new Error('A title is required');
  const body = [s.title, s.narrative, ...s.facts].join('\n');
  const added = s.filesModified.filter((f) => !(f in o.fileHashes));
  const hashes = { ...Object.fromEntries(Object.entries(o.fileHashes).filter(([f]) => s.filesModified.includes(f))), ...(rootPath ? hashFiles(rootPath, added) : {}) };
  db.prepare(
    `UPDATE observations SET type=?, entityName=?, title=?, narrative=?, facts=?, filesModified=?, concepts=?, tokens=?,
     hasCausalLanguage=?, fileHashes=?, updatedAt=?, revisionCount=revisionCount+1,
     admissionState=CASE WHEN ? THEN 'qualified' ELSE admissionState END WHERE id=?`,
  ).run(
    type, s.entityName, s.title, s.narrative, JSON.stringify(s.facts), JSON.stringify(s.filesModified), JSON.stringify(s.concepts),
    estimateTokens(body), CAUSAL.test(body) ? 1 : 0, JSON.stringify(hashes), now(), edit.qualify ? 1 : 0, id,
  );
  snapshotRevision(db, o, history);
  return getObservation(db, id)!;
}

/**
 * Merge duplicates into one memory: `into` keeps its title and gains the others' facts, files, concepts and related
 * entities and commits, with each one's narrative appended under a "Merged from #id" heading (edit it afterwards). The
 * others are archived with `supersededBy` pointing at it, never deleted; their read counts carry over. If any of them
 * was qualified, the result is too. All must be in the same project.
 */
export function mergeObservations(db: DB, intoId: number, fromIds: number[]): Observation {
  const into = getObservation(db, intoId);
  if (!into) throw new Error(`No memory #${intoId}`);
  const from = [...new Set(fromIds)].filter((id) => id !== intoId).map((id) => {
    const o = getObservation(db, id);
    if (!o) throw new Error(`No memory #${id}`);
    if (o.projectId !== into.projectId) throw new Error(`#${id} belongs to another project`);
    return o;
  });
  if (from.length === 0) throw new Error('Pick at least one other memory to merge');
  const all = [into, ...from];
  const narrative = [into.narrative, ...from.filter((o) => o.narrative.trim() && !into.narrative.includes(o.narrative.trim()))
    .map((o) => `#### Merged from #${o.id}: ${o.title}\n${o.narrative.trim()}`)].filter(Boolean).join('\n\n');
  const facts = uniq(all.flatMap((o) => o.facts));
  const body = [into.title, narrative, ...facts].join('\n');
  db.prepare(
    `UPDATE observations SET narrative=?, facts=?, filesModified=?, concepts=?, relatedEntities=?, relatedCommits=?, fileHashes=?,
     tokens=?, hasCausalLanguage=?, updatedAt=?, revisionCount=revisionCount+1,
     admissionState=CASE WHEN ? THEN 'qualified' ELSE admissionState END WHERE id=?`,
  ).run(
    narrative, JSON.stringify(facts), JSON.stringify(uniq(all.flatMap((o) => o.filesModified))), JSON.stringify(uniq(all.flatMap((o) => o.concepts))),
    JSON.stringify(uniq([...all.flatMap((o) => o.relatedEntities), ...from.map((o) => o.entityName)].filter((e) => e !== into.entityName))),
    JSON.stringify(uniq(all.flatMap((o) => o.relatedCommits))),
    JSON.stringify(Object.assign({}, ...[...from].reverse().map((o) => o.fileHashes), into.fileHashes)),
    estimateTokens(body), CAUSAL.test(body) ? 1 : 0, now(), all.some((o) => o.admissionState === 'qualified') ? 1 : 0, intoId,
  );
  snapshotRevision(db, into, { change: 'merge', note: `merged ${from.map((o) => `#${o.id}`).join(', ')}` });
  const archive = db.prepare("UPDATE observations SET status = 'archived', supersededBy = ?, updatedAt = ? WHERE id = ?");
  const reads = db.prepare('SELECT COALESCE(SUM(accessCount), 0) AS n FROM observation_access WHERE observationId IN (' + from.map(() => '?').join(',') + ')').get(...from.map((o) => o.id)) as { n: number };
  for (const o of from) archive.run(intoId, now(), o.id);
  if (Number(reads.n) > 0) {
    db.prepare(
      `INSERT INTO observation_access(observationId, accessCount, lastAccessed) VALUES(?, ?, ?)
       ON CONFLICT(observationId) DO UPDATE SET accessCount = accessCount + excluded.accessCount`,
    ).run(intoId, Number(reads.n), now());
  }
  return getObservation(db, intoId)!;
}

/** What replaced a version of a memory (history.ts). */
export type RevisionChange = 'topic-update' | 'duplicate-merge' | 'edit' | 'merge' | 'team' | 'restore';
export interface RevisionContext { change: RevisionChange; sessionId?: string | null; note?: string }

/** Versions kept per memory; older ones are dropped. */
export const MAX_REVISIONS = 50;
const CONTENT_KEYS = ['type', 'entityName', 'title', 'narrative', 'facts', 'filesModified', 'concepts'] as const;
const contentOf = (o: Observation) => JSON.stringify(CONTENT_KEYS.map((k) => o[k]));

/**
 * Keep the version `prev` was before a change, once the change is written. Only curated memories get history
 * (auto-captured candidates are logs), and only when the content actually changed.
 */
export function snapshotRevision(db: DB, prev: Observation, ctx: RevisionContext): void {
  if (prev.admissionState === 'candidate') return;
  const now_ = getObservation(db, prev.id);
  if (!now_ || contentOf(now_) === contentOf(prev)) return;
  db.prepare(
    `INSERT INTO observation_revisions (observationId, revision, type, entityName, title, narrative, facts, filesModified, concepts,
      validFrom, replacedAt, change, sessionId, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    prev.id, prev.revisionCount, prev.type, prev.entityName, prev.title, prev.narrative, JSON.stringify(prev.facts), JSON.stringify(prev.filesModified),
    JSON.stringify(prev.concepts), prev.updatedAt ?? prev.createdAt, now_.updatedAt ?? now(), ctx.change, ctx.sessionId ?? null, ctx.note ?? null,
  );
  db.prepare(
    `DELETE FROM observation_revisions WHERE observationId = ? AND id NOT IN
       (SELECT id FROM observation_revisions WHERE observationId = ? ORDER BY id DESC LIMIT ?)`,
  ).run(prev.id, prev.id, MAX_REVISIONS);
}

/** Active memories of the same project most like `id` (title and narrative), for picking duplicates to merge. */
export function similarObservations(db: DB, id: number, limit = 8): { observation: Observation; score: number }[] {
  const o = getObservation(db, id);
  if (!o) return [];
  const text = `${o.title} ${o.narrative}`;
  return listObservations(db, { projectId: o.projectId, status: 'active', limit: 2000 })
    .filter((x) => x.id !== id)
    .map((x) => ({ observation: x, score: similarity(text, `${x.title} ${x.narrative}`) + (x.entityName === o.entityName ? 0.05 : 0) }))
    .filter((x) => x.score >= 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
