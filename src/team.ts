/**
 * Team memory: curated memories shared through the repository, in `.synapse/memory.jsonl`, so teammates and CI agents
 * get the same gotchas and decisions through git while each machine keeps its own local database.
 *
 * The file has one JSON object per line, ordered oldest first, so a new memory is an appended line and an edit is a
 * one-line diff that is easy to review. Each memory carries a stable `uid` (local ids differ per machine) and the
 * content hashes of its files, so "changed since" works across machines too. A memory that stops being shared
 * (resolved, archived, marked private) leaves a short tombstone line `{uid, status, title, updatedAt}`, so the removal
 * reaches teammates explicitly; a deleted line could also just mean an older branch.
 *
 * Merging is last-writer-wins on `updatedAt`, entry by entry: importing an older file (another branch) never
 * overwrites newer local edits, and exporting first imports what is in the file, so a teammate's lines aren't lost.
 *
 * What is shared: active, curated memories (qualified), except git-ingested ones (each clone can ingest its own
 * history), ones with the concept `private`, and auto-captured candidates. Text passes through redactSecrets, and
 * absolute paths into the project or the home directory are rewritten, so no machine-specific paths reach the repo.
 */
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getMeta, setMeta, type DB } from './db.js';
import { hashFiles } from './freshness.js';
import { redactSecrets } from './secrets.js';
import { estimateTokens, rowToObservation, setStatus, similarity } from './store.js';
import { OBSERVATION_TYPES, type Observation, type ProjectInfo } from './types.js';

export const TEAM_FILE = path.join('.synapse', 'memory.jsonl');

export interface TeamMemory {
  uid: string;
  type: string;
  entity: string;
  title: string;
  narrative: string;
  facts?: string[];
  files?: string[];
  concepts?: string[];
  related?: string[];
  topicKey?: string;
  /** Content hash of each file when the memory was stored or last verified. */
  fileHashes?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface TeamTombstone {
  uid: string;
  status: 'resolved' | 'archived' | 'private';
  title: string;
  updatedAt: string;
}

export type TeamEntry = TeamMemory | TeamTombstone;

export interface TeamImport {
  added: number[];
  updated: number[];
  removed: number[];
  unchanged: number;
  skipped: number;
}

export interface TeamExport {
  file: string;
  written: boolean;
  shared: number;
  tombstones: number;
  imported: TeamImport;
  /** uids newly given to memories shared for the first time. */
  newlyShared: number[];
}

const isTombstone = (e: TeamEntry): e is TeamTombstone => 'status' in e;
/** Tombstones older than this are dropped from the file; every teammate has had time to pull them. */
const TOMBSTONE_DAYS = 180;

/** SYNAPSE_TEAM=0 turns off loading the team file automatically (setup, session start, MCP server start). */
export function teamAutoImportEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test(process.env.SYNAPSE_TEAM ?? '');
}

export const teamFilePath = (project: ProjectInfo) => path.join(project.rootPath, TEAM_FILE);

/** Parse the team file; malformed lines are skipped (counted), so one bad merge doesn't block the rest. */
export function readTeamFile(file: string): { entries: TeamEntry[]; invalid: number } {
  if (!existsSync(file)) return { entries: [], invalid: 0 };
  let invalid = 0;
  const entries: TeamEntry[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as TeamEntry;
      const ok = typeof e?.uid === 'string' && /^[\w-]{6,64}$/.test(e.uid) && typeof e.updatedAt === 'string' && typeof e.title === 'string'
        && (isTombstone(e) ? ['resolved', 'archived', 'private'].includes(e.status)
          : typeof e.narrative === 'string' && (OBSERVATION_TYPES as readonly string[]).includes(e.type) && typeof e.entity === 'string' && typeof e.createdAt === 'string');
      if (ok) entries.push(e);
      else invalid++;
    } catch {
      invalid++;
    }
  }
  return { entries, invalid };
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const stamp = (o: Observation) => o.updatedAt ?? o.createdAt;

function byUid(db: DB, projectId: string, uid: string): Observation | undefined {
  const row = db.prepare('SELECT * FROM observations WHERE projectId = ? AND uid = ? ORDER BY id LIMIT 1').get(projectId, uid) as Record<string, unknown> | undefined;
  return row ? rowToObservation(row) : undefined;
}

/** An unshared local memory that says the same thing (same area and type, near-identical text), to adopt the uid. */
function lookalike(db: DB, projectId: string, e: TeamMemory): Observation | undefined {
  const rows = db
    .prepare("SELECT * FROM observations WHERE projectId = ? AND uid IS NULL AND entityName = ? AND type = ? AND status = 'active' ORDER BY id DESC LIMIT 50")
    .all(projectId, e.entity, e.type) as Record<string, unknown>[];
  return rows.map(rowToObservation).find((o) => similarity(`${o.title} ${o.narrative}`, `${e.title} ${e.narrative}`) >= 0.82);
}

function writeEntry(db: DB, project: ProjectInfo, e: TeamMemory, id?: number): number {
  const facts = strs(e.facts).map(redactSecrets);
  const files = strs(e.files);
  const hashes = e.fileHashes && typeof e.fileHashes === 'object' ? e.fileHashes : hashFiles(project.rootPath, files);
  const fields = [
    e.type, redactSecrets(e.entity), redactSecrets(e.title), redactSecrets(e.narrative), JSON.stringify(facts), JSON.stringify(files),
    JSON.stringify(strs(e.concepts)), JSON.stringify(strs(e.related)), e.topicKey ?? null, JSON.stringify(hashes),
    estimateTokens([e.title, e.narrative, ...facts].join('\n')), e.updatedAt,
  ];
  if (id !== undefined) {
    db.prepare(
      `UPDATE observations SET type=?, entityName=?, title=?, narrative=?, facts=?, filesModified=?, concepts=?, relatedEntities=?, topicKey=?,
       fileHashes=?, tokens=?, updatedAt=?, status='active', admissionState='qualified', uid=?, revisionCount=revisionCount+1 WHERE id=?`,
    ).run(...fields, e.uid, id);
    return id;
  }
  const r = db
    .prepare(
      `INSERT INTO observations (type, entityName, title, narrative, facts, filesModified, concepts, relatedEntities, topicKey, fileHashes, tokens,
        updatedAt, projectId, createdAt, source, admissionState, uid)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'team','qualified',?)`,
    )
    .run(...fields, project.id, e.createdAt, e.uid);
  return Number(r.lastInsertRowid);
}

/**
 * Bring the team file's entries into the local database. Per uid, the newer side wins: a newer entry updates (or
 * reopens) the local memory, a newer tombstone resolves or archives it, and anything older is left alone.
 */
export function importTeamEntries(db: DB, project: ProjectInfo, entries: TeamEntry[], opts: { dryRun?: boolean } = {}): TeamImport {
  const result: TeamImport = { added: [], updated: [], removed: [], unchanged: 0, skipped: 0 };
  const run = () => {
    for (const e of entries) {
      const local = byUid(db, project.id, e.uid);
      if (isTombstone(e)) {
        if (local && local.status === 'active' && e.updatedAt > stamp(local)) {
          if (!opts.dryRun) setStatus(db, [local.id], e.status === 'archived' ? 'archived' : 'resolved', project.id);
          result.removed.push(local.id);
        } else result.unchanged++;
        continue;
      }
      if (local) {
        if (e.updatedAt > stamp(local)) {
          if (!opts.dryRun) writeEntry(db, project, e, local.id);
          result.updated.push(local.id);
        } else result.unchanged++;
        continue;
      }
      const twin = lookalike(db, project.id, e);
      if (twin) {
        if (!opts.dryRun) {
          if (e.updatedAt > stamp(twin)) writeEntry(db, project, e, twin.id);
          else db.prepare('UPDATE observations SET uid = ? WHERE id = ?').run(e.uid, twin.id);
        }
        result.updated.push(twin.id);
        continue;
      }
      if (opts.dryRun) result.added.push(0);
      else result.added.push(writeEntry(db, project, e));
    }
  };
  if (opts.dryRun) run();
  else {
    db.exec('BEGIN');
    try {
      run();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return result;
}

/** Import the project's team file. */
export function importTeam(db: DB, project: ProjectInfo, opts: { dryRun?: boolean } = {}): TeamImport & { invalid: number; file: string } {
  const file = teamFilePath(project);
  const { entries, invalid } = readTeamFile(file);
  return { ...importTeamEntries(db, project, entries, opts), invalid, file };
}

/**
 * Import the team file when its content changed since the last import (setup, session start, MCP server start). Cheap
 * when nothing changed: one file read and a hash. Returns the import, or undefined when there was nothing new.
 */
export function teamAutoImport(db: DB, project: ProjectInfo): TeamImport | undefined {
  if (!teamAutoImportEnabled()) return undefined;
  const file = teamFilePath(project);
  if (!existsSync(file)) return undefined;
  const hash = createHash('sha1').update(readFileSync(file)).digest('hex');
  const key = `team-file:${project.id}`;
  if (getMeta(db, key) === hash) return undefined;
  const r = importTeam(db, project);
  setMeta(db, key, hash);
  return r;
}

/** Shared: active, curated, not git-ingested, not private. */
export function isShareable(o: Observation): boolean {
  return o.status === 'active' && o.admissionState === 'qualified' && o.source !== 'git' && !o.concepts.some((c) => c.toLowerCase() === 'private');
}

/** Machine-specific paths out, secrets out. */
function scrub(text: string, root: string): string {
  const home = os.homedir();
  let t = text.split(root + path.sep).join('').split(root).join('.');
  if (home && home.length > 1) t = t.split(home).join('~');
  return redactSecrets(t);
}

function toEntry(o: Observation, root: string): TeamEntry {
  if (!isShareable(o)) {
    const status = o.status === 'archived' ? 'archived' : o.status === 'resolved' ? 'resolved' : 'private';
    return { uid: o.uid!, status, title: scrub(o.title, root), updatedAt: stamp(o) };
  }
  const entry: TeamMemory = {
    uid: o.uid!, type: o.type, entity: o.entityName, title: scrub(o.title, root), narrative: scrub(o.narrative, root),
    createdAt: o.createdAt, updatedAt: stamp(o),
  };
  if (o.facts.length) entry.facts = o.facts.map((f) => scrub(f, root));
  if (o.filesModified.length) entry.files = o.filesModified;
  if (o.concepts.length) entry.concepts = o.concepts;
  if (o.relatedEntities.length) entry.related = o.relatedEntities;
  if (o.topicKey) entry.topicKey = o.topicKey;
  if (Object.keys(o.fileHashes).length) entry.fileHashes = Object.fromEntries(Object.entries(o.fileHashes).sort(([a], [b]) => a.localeCompare(b)));
  return entry;
}

const newUid = () => `m-${randomBytes(6).toString('hex')}`;

/**
 * Write the project's shared memories to the team file. The file is imported first, so entries teammates added stay;
 * memories shared for the first time get a uid; memories that stopped being shareable become tombstones. The file is
 * only rewritten when its content changes.
 */
export function exportTeam(db: DB, project: ProjectInfo, opts: { dryRun?: boolean; now?: Date } = {}): TeamExport {
  const file = teamFilePath(project);
  const { entries: before } = readTeamFile(file);
  const imported = importTeamEntries(db, project, before, opts);
  const rows = (db.prepare('SELECT * FROM observations WHERE projectId = ? ORDER BY createdAt, id').all(project.id) as Record<string, unknown>[]).map(rowToObservation);
  const newlyShared: number[] = [];
  for (const o of rows) {
    if (o.uid || !isShareable(o)) continue;
    o.uid = newUid();
    newlyShared.push(o.id);
    if (!opts.dryRun) db.prepare('UPDATE observations SET uid = ? WHERE id = ?').run(o.uid, o.id);
  }
  const out = new Map<string, TeamEntry>();
  for (const o of rows) if (o.uid && !out.has(o.uid)) out.set(o.uid, toEntry(o, project.rootPath));
  // Tombstones for memories this machine never had still need to reach the others.
  const cutoff = new Date((opts.now ?? new Date()).getTime() - TOMBSTONE_DAYS * 86_400_000).toISOString();
  for (const e of before) if (isTombstone(e) && !out.has(e.uid)) out.set(e.uid, e);
  const kept = [...out.values()]
    .filter((e) => !(isTombstone(e) && e.updatedAt < cutoff))
    .sort((a, b) => ('createdAt' in a ? a.createdAt : a.updatedAt).localeCompare('createdAt' in b ? b.createdAt : b.updatedAt) || a.uid.localeCompare(b.uid));
  const content = kept.map((e) => JSON.stringify(e) + '\n').join('');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const written = content !== current;
  if (written && !opts.dryRun) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    setMeta(db, `team-file:${project.id}`, createHash('sha1').update(content).digest('hex'));
  }
  const tombstones = kept.filter(isTombstone).length;
  return { file, written, shared: kept.length - tombstones, tombstones, imported, newlyShared };
}
