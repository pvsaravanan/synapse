/**
 * What changed in a flagged memory's files since it was stored: the git diff from the version the memory was checked
 * against to the working tree, so deciding "still true" or "outdated" means reading a diff, not hunting for one.
 *
 * The memory keeps a short content hash of each file (freshness.ts). Walking the file's git history, the newest
 * committed version with that hash is the exact baseline. When none matches (the memory was stored while the file had
 * uncommitted edits), the last commit before the memory was stored or verified stands in, marked approximate.
 */
import { gitSpawn } from './gitexec.js';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { changedFiles, fileKey, type FileChangeKind } from './freshness.js';
import { isIgnored } from './ignore.js';
import { redactSecrets } from './secrets.js';
import type { Observation } from './types.js';

export interface FileDiff {
  file: string;
  change: FileChangeKind;
  /** The version the diff starts from; undefined when there is none (not in git, or no history). */
  baseline?: { commit: string; date: string; subject: string; exact: boolean };
  /** Unified diff (3 lines of context) from the baseline to the working tree, secrets redacted. */
  diff: string;
  truncated: boolean;
  added: number;
  removed: number;
  /** Why there is no diff, when there isn't one. */
  note?: string;
}

/** Commits of a file's history searched for the stored version. */
const MAX_HISTORY = 40;
const MAX_FILES = 5;
const MAX_LINES = 400;

function git(root: string, args: string[], binary = false): { ok: boolean; out: string; buf: Buffer } {
  const r = gitSpawn(root, args);
  const buf = (r.stdout as Buffer | null) ?? Buffer.alloc(0);
  // `git diff` exits 1 when there are differences (with --exit-code or --no-index); stdout is still the diff.
  return { ok: r.status === 0 || (r.status === 1 && buf.length > 0), out: binary ? '' : buf.toString('utf8'), buf };
}

const shortHash = (content: Buffer) => createHash('sha1').update(content).digest('hex').slice(0, 12);

/** The commit whose version of `file` has content hash `hash` (newest first), or undefined. */
function exactBaseline(root: string, file: string, hash: string): string | undefined {
  const log = git(root, ['log', `-n${MAX_HISTORY}`, '--format=%H', '--', file]);
  if (!log.ok) return undefined;
  for (const commit of log.out.split('\n').filter(Boolean)) {
    const blob = git(root, ['show', `${commit}:${file}`], true);
    if (blob.ok && shortHash(blob.buf) === hash) return commit;
  }
  return undefined;
}

function commitInfo(root: string, commit: string): { date: string; subject: string } {
  const [date = '', ...subject] = git(root, ['show', '-s', '--format=%cI%n%s', commit]).out.split('\n');
  return { date: date.trim(), subject: subject.join(' ').trim() };
}

/** Keep the hunks, drop git's header lines, cap the length. */
function trimDiff(raw: string): { diff: string; truncated: boolean; added: number; removed: number } {
  const lines = raw.split('\n');
  const start = lines.findIndex((l) => l.startsWith('@@'));
  const body = start < 0 ? [] : lines.slice(start).filter((l, i, a) => !(i === a.length - 1 && l === ''));
  const added = body.filter((l) => l.startsWith('+')).length;
  const removed = body.filter((l) => l.startsWith('-')).length;
  const truncated = body.length > MAX_LINES;
  return { diff: redactSecrets(body.slice(0, MAX_LINES).join('\n')), truncated, added, removed };
}

/** When the memory last matched its files: stored, updated or verified (verification re-records the hashes). */
export function checkedAt(o: Observation, verifiedAt?: string): string {
  return [o.createdAt, o.updatedAt, verifiedAt].filter((x): x is string => Boolean(x)).sort().pop()!;
}

/** Diffs for a memory's changed files (at most 5), from the version it was checked against to the working tree. */
export function memoryDiffs(root: string, o: Observation, verifiedAt?: string): FileDiff[] {
  const changes = changedFiles(root, o.fileHashes).slice(0, MAX_FILES);
  if (changes.length === 0) return [];
  const inRepo = git(root, ['rev-parse', '--is-inside-work-tree']).out.trim() === 'true';
  const since = checkedAt(o, verifiedAt);
  return changes.map(({ file, change }): FileDiff => {
    const empty = { file, change, diff: '', truncated: false, added: 0, removed: 0 };
    if (fileKey(root, file) !== file) return { ...empty, note: 'This path is outside the project, so it is not diffed.' };
    if (isIgnored(root, file)) return { ...empty, note: 'This file is ignored (.synapseignore or a secret-file default), so its diff is not shown.' };
    if (!inRepo) return { ...empty, note: 'The project is not a git repository, so there is no earlier version to compare with.' };
    const stored = o.fileHashes[file];
    if (!stored) {
      // The file didn't exist when the memory was stored: everything in it is new.
      const abs = path.join(root, file);
      const raw = existsSync(abs) ? git(root, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--', '/dev/null', file]).out : '';
      return { ...empty, ...trimDiff(raw), note: 'The file did not exist when this was stored.' };
    }
    if (stored.startsWith('size:')) return { ...empty, note: 'The file is too large to track by content, so its diff is not shown.' };
    let commit = exactBaseline(root, file, stored);
    const exact = Boolean(commit);
    if (!commit) commit = git(root, ['log', '-1', '--format=%H', `--before=${since}`, '--', file]).out.trim() || undefined;
    if (!commit) return { ...empty, note: 'No committed version of this file from before the memory was stored, so there is nothing to compare with.' };
    const raw = git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', commit, '--', file]).out;
    return { ...empty, ...trimDiff(raw), baseline: { commit, ...commitInfo(root, commit), exact } };
  });
}
