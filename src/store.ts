import type { DB } from './db.js';
import { hashFile, hashFiles, type FileHashes } from './freshness.js';
import path from 'node:path';
import { redactSecrets } from './secrets.js';
import type {
  FeedbackSignal,
  Observation,
  ObservationStatus,
  StoreInput,
  StoreResult,
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
}

function sanitize(input: StoreInput): Sanitized {
  return {
    entityName: redactSecrets(input.entityName.trim()) || 'project',
    title: redactSecrets(input.title.trim()),
    narrative: redactSecrets(input.narrative.trim()),
    facts: uniq(input.facts).map(redactSecrets),
    filesModified: uniq(input.filesModified),
    concepts: uniq(input.concepts).map((c) => c.toLowerCase()),
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
export function storeObservation(db: DB, input: StoreInput): StoreResult {
  const s = sanitize(input);
  const ts = now();
  const body = [s.title, s.narrative, ...s.facts].join('\n');
  const tokens = estimateTokens(body);
  const causal = CAUSAL.test(body) ? 1 : 0;
  // Hashes of the files named now; on an update they replace the old hashes for those files.
  const hashes = input.rootPath ? hashFiles(input.rootPath, s.filesModified) : {};
  const mergeHashes = (prev: FileHashes) => JSON.stringify({ ...prev, ...hashes });

  if (input.topicKey) {
    const existing = db
      .prepare("SELECT * FROM observations WHERE projectId = ? AND topicKey = ? AND status = 'active' ORDER BY id DESC LIMIT 1")
      .get(input.projectId, input.topicKey) as Record<string, unknown> | undefined;
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
      return { observation: getObservation(db, prev.id)!, action: 'updated-topic' };
    }
  }

  if (!input.topicKey) {
    const candidates = db
      .prepare(
        "SELECT * FROM observations WHERE projectId = ? AND entityName = ? AND type = ? AND status = 'active' ORDER BY id DESC LIMIT 50",
      )
      .all(input.projectId, s.entityName, input.type) as Record<string, unknown>[];
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
        return { observation: getObservation(db, o.id)!, action: 'merged-duplicate' };
      }
    }
  }

  const info = db
    .prepare(
      `INSERT INTO observations (projectId, entityName, type, title, narrative, facts, filesModified, concepts, tokens,
        createdAt, topicKey, sessionId, progress, source, commitHash, relatedCommits, relatedEntities, admissionState,
        valueCategory, hasCausalLanguage, fileHashes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.projectId, s.entityName, input.type, s.title, s.narrative,
      JSON.stringify(s.facts), JSON.stringify(s.filesModified), JSON.stringify(s.concepts), tokens,
      ts, input.topicKey ?? null, input.sessionId ?? null,
      input.progress ? JSON.stringify(input.progress) : null,
      input.source ?? 'agent', input.commitHash ?? null,
      JSON.stringify(uniq(input.relatedCommits)), JSON.stringify(uniq(input.relatedEntities)),
      input.admissionState ?? 'qualified', input.valueCategory ?? null, causal, JSON.stringify(hashes),
    );
  return { observation: getObservation(db, Number(info.lastInsertRowid))!, action: 'created' };
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
  db.prepare('DELETE FROM observation_access WHERE observationId = ?').run(id);
  db.prepare('DELETE FROM feedback WHERE observationId = ?').run(id);
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
