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
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getMeta, setMeta, type DB } from './db.js';
import { fileKey, hashFiles } from './freshness.js';
import { isIgnored } from './ignore.js';
import { redactSecrets } from './secrets.js';
import { estimateTokens, getObservation, rowToObservation, setStatus, similarity, snapshotRevision } from './store.js';
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

/**
 * The team file and its directory must be a real directory and a regular file: a repo can commit them as symlinks, and
 * following one would read, or on export overwrite, whatever it points at (a git hook, .git/config, a home file).
 */
function assertNotLinked(file: string): void {
  for (const p of [path.dirname(file), file]) {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue; // absent: fine, export creates it
    }
    if (st.isSymbolicLink()) throw new Error(`${p} is a symbolic link; Synapse refuses to read or write the team file through it.`);
    if (p === file ? !st.isFile() : !st.isDirectory()) throw new Error(`${p} is not a regular ${p === file ? 'file' : 'directory'}.`);
  }
}

/** Future timestamps are refused beyond this much clock skew: a far-future updatedAt would win every merge forever. */
const MAX_CLOCK_SKEW_MS = 86_400_000;

/** A parseable timestamp not in the future, normalized to ISO (so string comparison with local stamps is exact). */
function normalizeStamp(v: unknown, now: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t > now + MAX_CLOCK_SKEW_MS) return undefined;
  return new Date(t).toISOString();
}

/** Parse the team file; malformed lines are skipped (counted), so one bad merge doesn't block the rest. */
export function readTeamFile(file: string, now: Date = new Date()): { entries: TeamEntry[]; invalid: number } {
  assertNotLinked(file);
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
      const updatedAt = ok ? normalizeStamp(e.updatedAt, now.getTime()) : undefined;
      const createdAt = ok && !isTombstone(e) ? normalizeStamp(e.createdAt, now.getTime()) : undefined;
      if (ok && updatedAt && (isTombstone(e) || createdAt)) entries.push({ ...e, updatedAt, ...(createdAt ? { createdAt } : {}) } as TeamEntry);
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

/** Content hashes as freshness.ts writes them: 12 hex chars, 'size:N' for large files, '' for an absent file. */
const HASH_VALUE = /^([0-9a-f]{12}|size:\d+|)$/;
const MAX_FILES = 25;

/**
 * File names from the team file are held to the project like locally stored ones (freshness.ts fileKey): no '..',
 * no absolute paths, nothing ignored. Otherwise a committed entry could make Synapse hash, or diff in the UI, files
 * outside the repository.
 */
function confineFiles(root: string, e: TeamMemory): { files: string[]; hashes: Record<string, string> } {
  const files = [...new Set(strs(e.files).map((f) => fileKey(root, f)).filter((f): f is string => Boolean(f) && !isIgnored(root, f!)))].slice(0, MAX_FILES);
  if (!e.fileHashes || typeof e.fileHashes !== 'object' || Array.isArray(e.fileHashes)) return { files, hashes: hashFiles(root, files) };
  const hashes = Object.fromEntries(Object.entries(e.fileHashes)
    .filter(([k, v]) => fileKey(root, k) === k && !isIgnored(root, k) && typeof v === 'string' && HASH_VALUE.test(v))
    .slice(0, MAX_FILES));
  return { files, hashes };
}

function writeEntry(db: DB, project: ProjectInfo, e: TeamMemory, id?: number): number {
  const facts = strs(e.facts).map(redactSecrets);
  const { files, hashes } = confineFiles(project.rootPath, e);
  const topicKey = typeof e.topicKey === 'string' && e.topicKey ? redactSecrets(e.topicKey) : null;
  const fields = [
    e.type, redactSecrets(e.entity), redactSecrets(e.title), redactSecrets(e.narrative), JSON.stringify(facts), JSON.stringify(files),
    JSON.stringify(strs(e.concepts).map((c) => redactSecrets(c).toLowerCase())), JSON.stringify(strs(e.related).map(redactSecrets)), topicKey, JSON.stringify(hashes),
    estimateTokens([e.title, e.narrative, ...facts].join('\n')), e.updatedAt,
  ];
  if (id !== undefined) {
    const prev = getObservation(db, id);
    db.prepare(
      `UPDATE observations SET type=?, entityName=?, title=?, narrative=?, facts=?, filesModified=?, concepts=?, relatedEntities=?, topicKey=?,
       fileHashes=?, tokens=?, updatedAt=?, status='active', admissionState='qualified', uid=?, revisionCount=revisionCount+1 WHERE id=?`,
    ).run(...fields, e.uid, id);
    if (prev) snapshotRevision(db, prev, { change: 'team', note: 'from .synapse/memory.jsonl' });
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

/** Shared: active, curated, not git-ingested, not private, and not still scoped to a feature branch. */
export function isShareable(o: Observation): boolean {
  return o.status === 'active' && o.admissionState === 'qualified' && o.source !== 'git' && !o.branch && !o.concepts.some((c) => c.toLowerCase() === 'private');
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
  // Every text field is scrubbed (redaction plus machine-path rewrite); files become project-relative.
  const entry: TeamMemory = {
    uid: o.uid!, type: o.type, entity: scrub(o.entityName, root), title: scrub(o.title, root), narrative: scrub(o.narrative, root),
    createdAt: o.createdAt, updatedAt: stamp(o),
  };
  if (o.facts.length) entry.facts = o.facts.map((f) => scrub(f, root));
  if (o.filesModified.length) entry.files = [...new Set(o.filesModified.map((f) => fileKey(root, f) ?? scrub(f, root)))];
  if (o.concepts.length) entry.concepts = o.concepts.map((c) => scrub(c, root));
  if (o.relatedEntities.length) entry.related = o.relatedEntities.map((r) => scrub(r, root));
  if (o.topicKey) entry.topicKey = scrub(o.topicKey, root);
  const hashes = Object.entries(o.fileHashes).filter(([k]) => fileKey(root, k) === k);
  if (hashes.length) entry.fileHashes = Object.fromEntries(hashes.sort(([a], [b]) => a.localeCompare(b)));
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
  const { entries: before } = readTeamFile(file, opts.now); // refuses a symlinked .synapse/ or memory.jsonl
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
    assertNotLinked(file); // again: the directory may have just been created, or swapped since the read
    // Write a new file and rename it into place: rename replaces a path, it never writes through a link.
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, content, { flag: 'wx' });
      renameSync(tmp, file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    setMeta(db, `team-file:${project.id}`, createHash('sha1').update(content).digest('hex'));
  }
  const tombstones = kept.filter(isTombstone).length;
  return { file, written, shared: kept.length - tombstones, tombstones, imported, newlyShared };
}
