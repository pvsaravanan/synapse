/**
 * File freshness: when a memory is stored, Synapse records a short content hash of each file it names.
 * Later, a memory whose files have changed since (edited, deleted or newly created) is flagged as
 * possibly outdated, so the agent checks current code before relying on it.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';
import { isIgnored } from './ignore.js';
import { rowToObservation } from './store.js';
import type { Observation } from './types.js';

/** Project-relative path -> content hash ('' = the file did not exist when hashed). */
export type FileHashes = Record<string, string>;

export type FileChangeKind = 'modified' | 'deleted' | 'created';

export interface FileChange {
  file: string;
  change: FileChangeKind;
}

/** Large files are compared by size instead of read in full. */
const MAX_HASH_BYTES = 2_000_000;
/** Memories naming more files than this are wide changes; only the first ones are tracked. */
const MAX_FILES = 25;

/** A file's project-relative key (posix separators), or undefined when it lies outside the project. */
export function fileKey(root: string, file: string): string | undefined {
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

/** Short content hash of a file; '' when it is missing or not a regular file. */
export function hashFile(abs: string): string {
  try {
    const st = statSync(abs);
    if (!st.isFile()) return '';
    if (st.size > MAX_HASH_BYTES) return `size:${st.size}`;
    return createHash('sha1').update(readFileSync(abs)).digest('hex').slice(0, 12);
  } catch {
    return '';
  }
}

export function hashFiles(root: string, files: string[]): FileHashes {
  const out: FileHashes = {};
  for (const f of files) {
    if (Object.keys(out).length >= MAX_FILES) break;
    const key = fileKey(root, f);
    if (key && !(key in out) && !isIgnored(root, key)) out[key] = hashFile(path.join(root, key));
  }
  return out;
}

/**
 * Files whose content differs from when the memory was stored. Pass one `cache` across many memories
 * so each file is read once.
 */
export function changedFiles(root: string, hashes: FileHashes, cache: Map<string, string> = new Map()): FileChange[] {
  const out: FileChange[] = [];
  for (const [file, then] of Object.entries(hashes)) {
    let current = cache.get(file);
    if (current === undefined) {
      current = hashFile(path.join(root, file));
      cache.set(file, current);
    }
    if (current === then) continue;
    out.push({ file, change: !current ? 'deleted' : !then ? 'created' : 'modified' });
  }
  return out;
}

/** Compact note for index lines: "changed since: a.ts, b.ts +2". */
export function changeNote(changes: FileChange[], max = 2): string {
  if (changes.length === 0) return '';
  const names = changes.slice(0, max).map((c) => (c.change === 'modified' ? c.file : `${c.file} ${c.change}`));
  return `changed since: ${names.join(', ')}${changes.length > max ? ` +${changes.length - max}` : ''}`;
}

/** Changes for each observation that belongs to the project, keyed by id; unflagged ones are left out. */
export function changesFor(
  root: string, projectId: string, obs: { id: number; projectId: string; fileHashes: FileHashes }[],
): Map<number, FileChange[]> {
  const cache = new Map<string, string>();
  const out = new Map<number, FileChange[]>();
  for (const o of obs) {
    if (o.projectId !== projectId) continue;
    const c = changedFiles(root, o.fileHashes, cache);
    if (c.length) out.set(o.id, c);
  }
  return out;
}

/** Active memories of a project with files changed since they were stored, newest first. */
export function staleMemories(
  db: DB, project: { id: string; rootPath: string }, limit = 50,
): { observation: Observation; changes: FileChange[] }[] {
  const rows = db
    .prepare("SELECT * FROM observations WHERE projectId = ? AND status = 'active' AND fileHashes != '{}' ORDER BY COALESCE(updatedAt, createdAt) DESC, id DESC")
    .all(project.id) as Record<string, unknown>[];
  const obs = rows.map(rowToObservation);
  const changes = changesFor(project.rootPath, project.id, obs);
  return obs.filter((o) => changes.has(o.id)).slice(0, limit).map((o) => ({ observation: o, changes: changes.get(o.id)! }));
}
