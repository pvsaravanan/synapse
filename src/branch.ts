/**
 * Branch-scoped memories. A memory stored while a feature branch is checked out belongs to that branch: agents see it
 * on that branch, while briefs, search and file notes on other branches don't, until the branch merges into the
 * default branch, when its memories become project-wide. A branch that is deleted without merging leaves its
 * memories hidden and listed for review (make them project-wide, or archive them).
 *
 * Whether an agent's memory belongs to the branch is decided from evidence (scopeFor): the files it names or
 * mentions and whether the branch changed them, names the branch introduced, the session's edits, then its type.
 * scope "project" or "branch" decides it outright; auto-captured records always belong to the branch.
 *
 * The current branch is read from .git/HEAD on every call (no subprocess: hooks store often), including during a
 * rebase or bisect. The default branch is SYNAPSE_DEFAULT_BRANCH, else `git config synapse.defaultBranch`, else a
 * remote's HEAD (origin first), else a local or remote main / master / trunk; without one, nothing is scoped.
 *
 * A branch counts as merged once it had commits of its own and the default branch (local, or any remote's copy, so a
 * stale local checkout doesn't delay it) has them: as ancestors (merge commit, fast-forward), as patch-equivalents
 * (rebase), or as content (squash merge: merging the branch would change nothing, and the branch did change
 * something; needs git 2.38+).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';
import { gitSpawn, gitText } from './gitexec.js';
import { editObservation, getObservation, rowToObservation, setStatus } from './store.js';
import type { Observation, ProjectInfo } from './types.js';

export type BranchState = 'open' | 'merged' | 'ended';

export interface BranchScope {
  branch: string;
  state: BranchState;
  lastHead: string | null;
  updatedAt: string;
  /** Active memories still scoped to the branch. */
  memories: number;
}

const NAMES = ['main', 'master', 'trunk'];

/** The repository's git directory for a working tree (follows a `.git` file in worktrees and submodules). */
function gitDir(root: string): string | undefined {
  const dotgit = path.join(root, '.git');
  try {
    if (statSync(dotgit).isDirectory()) return dotgit;
    const m = readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
    return m ? path.resolve(root, m[1]) : undefined;
  } catch {
    return undefined;
  }
}

const read = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * The checked-out branch, or undefined (not a git repo, or a plain detached HEAD). During a rebase or bisect HEAD is
 * detached, but the branch being worked on is recorded alongside it, so memories still land on that branch.
 */
export function currentBranch(root: string): string | undefined {
  const dir = gitDir(root);
  if (!dir) return undefined;
  const head = read(path.join(dir, 'HEAD'))?.match(/^ref:\s*refs\/heads\/(.+?)\s*$/);
  if (head) return head[1];
  for (const f of ['rebase-merge/head-name', 'rebase-apply/head-name']) {
    const m = read(path.join(dir, f))?.match(/^refs\/heads\/(.+?)\s*$/);
    if (m) return m[1];
  }
  const bisect = read(path.join(dir, 'BISECT_START'))?.trim();
  return bisect && !/^[0-9a-f]{40}$/.test(bisect) ? bisect : undefined;
}

const defaults = new Map<string, string | null>();

/** The shared git directory (a worktree's gitdir names it in `commondir`). */
function commonDir(dir: string): string {
  const c = read(path.join(dir, 'commondir'));
  return c ? path.resolve(dir, c.trim()) : dir;
}

/** `synapse.defaultBranch` from the repository's config file. */
function configuredDefault(common: string): string | undefined {
  const config = read(path.join(common, 'config'));
  if (!config) return undefined;
  let inSection = false;
  for (const line of config.split('\n')) {
    const section = line.match(/^\s*\[\s*([^\]\s"]+)/);
    if (section) inSection = section[1].toLowerCase() === 'synapse';
    else if (inSection) {
      const m = line.match(/^\s*defaultbranch\s*=\s*"?([^"#;]+?)"?\s*(?:[#;].*)?$/i);
      if (m) return m[1].trim();
    }
  }
  return undefined;
}

/** Whether a ref exists, from the loose ref files and packed-refs (no subprocess). */
function refInFiles(common: string, packed: string, ref: string): boolean {
  try {
    statSync(path.join(common, ref));
    return true;
  } catch {
    return packed.split('\n').some((l) => l.endsWith(` ${ref}`));
  }
}

/** Remote names, origin first. */
function remotes(common: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(path.join(common, 'refs', 'remotes'));
  } catch {
    /* no remote refs yet */
  }
  const config = read(path.join(common, 'config')) ?? '';
  for (const m of config.matchAll(/^\s*\[remote\s+"([^"]+)"\]/gm)) if (!names.includes(m[1])) names.push(m[1]);
  return names.sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : a === 'upstream' ? -1 : b === 'upstream' ? 1 : a.localeCompare(b)));
}

/** The default branch from the repository's files: hooks ask on every call, so no subprocess. */
function defaultFromFiles(root: string): string | undefined {
  const dir = gitDir(root);
  if (!dir) return undefined;
  const common = commonDir(dir);
  const configured = configuredDefault(common);
  if (configured) return configured;
  const names = remotes(common);
  for (const r of names) {
    const m = read(path.join(common, 'refs', 'remotes', r, 'HEAD'))?.match(new RegExp(`^ref:\\s*refs/remotes/${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(.+?)\\s*$`));
    if (m) return m[1];
  }
  const packed = read(path.join(common, 'packed-refs')) ?? '';
  return NAMES.find((b) => refInFiles(common, packed, `refs/heads/${b}`))
    ?? NAMES.find((b) => names.some((r) => refInFiles(common, packed, `refs/remotes/${r}/${b}`)));
}

/** The default branch name, or undefined when it can't be determined (then nothing is branch-scoped). */
export function defaultBranch(root: string): string | undefined {
  const env = process.env.SYNAPSE_DEFAULT_BRANCH?.trim();
  if (env) return env;
  if (defaults.has(root)) return defaults.get(root) ?? undefined;
  let name = defaultFromFiles(root);
  if (!name && gitDir(root)) {
    try {
      name = gitText(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { timeout: 3000 }).trim().replace(/^origin\//, '') || undefined;
    } catch {
      /* no origin HEAD */
    }
  }
  defaults.set(root, name ?? null);
  return name;
}

function refExists(root: string, ref: string): boolean {
  return gitSpawn(root, ['show-ref', '--verify', '--quiet', ref], { timeout: 3000 }).status === 0;
}

/** Refs matching patterns (for-each-ref globs). */
function refsMatching(root: string, patterns: string[]): string[] {
  const r = gitSpawn(root, ['for-each-ref', '--format=%(refname)', ...patterns], { timeout: 3000 });
  return r.status === 0 ? r.stdout.toString().split('\n').filter(Boolean) : [];
}

/** The branch new memories in this checkout are scoped to: the current branch unless it is the default (or unknown). */
export function branchScope(root: string | undefined): string | undefined {
  if (!root) return undefined;
  const current = currentBranch(root);
  if (!current) return undefined;
  const def = defaultBranch(root);
  return def && current !== def ? current : undefined;
}

/** For reads: the branch whose memories are visible besides project-wide ones (undefined: project-wide only). */
export const visibleBranch = (project: ProjectInfo): string | null => branchScope(project.rootPath) ?? null;

/**
 * Every copy of the default branch to compare with: the local branch and each remote's. Any of them having the
 * branch's work counts, so a local default branch that hasn't been pulled doesn't hold up merge detection.
 */
function defaultTargets(root: string, def: string): string[] {
  return refsMatching(root, [`refs/heads/${def}`, `refs/remotes/*/${def}`]);
}

const revParse = (root: string, ref: string, kind = 'commit'): string | undefined => {
  try {
    return gitText(root, ['rev-parse', '--verify', '--quiet', `${ref}^{${kind}}`], { timeout: 3000 }).trim() || undefined;
  } catch {
    return undefined;
  }
};

/** Commits on `tip` that `target` doesn't have. */
function ownCommits(root: string, target: string, tip: string): number {
  const r = gitSpawn(root, ['rev-list', '--count', `${target}..${tip}`], { timeout: 5000 });
  return r.status === 0 ? Number(r.stdout.toString().trim()) || 0 : 0;
}

/** Every commit on `tip` missing from `target` has a patch-equivalent there (the branch was rebased in). */
function allPatchEquivalent(root: string, target: string, tip: string): boolean {
  const r = gitSpawn(root, ['cherry', target, tip], { timeout: 5000 });
  const lines = r.status === 0 ? r.stdout.toString().split('\n').filter(Boolean) : [];
  return lines.length > 0 && lines.every((l) => l.startsWith('-'));
}

/**
 * `target` already has the branch's content: merging `tip` into it would change nothing (a squash merge, or the
 * work landed some other way). Uses `git merge-tree --write-tree` (git 2.38+); a conflict or older git says no.
 */
function contentMerged(root: string, target: string, tip: string): boolean {
  // A branch whose commits net out to no change would trivially "merge" into anything: it has no content to land.
  const base = gitSpawn(root, ['merge-base', target, tip], { timeout: 3000 });
  if (base.status !== 0) return false;
  if (gitSpawn(root, ['diff', '--quiet', '--no-ext-diff', base.stdout.toString().trim(), tip], { timeout: 5000 }).status !== 1) return false;
  const r = gitSpawn(root, ['merge-tree', '--write-tree', target, tip], { timeout: 10_000 });
  if (r.status !== 0) return false;
  const tree = r.stdout.toString().split('\n')[0].trim();
  return Boolean(tree) && tree === revParse(root, target, 'tree');
}

/** Whether the branch's work (tip) is in `target`, given whether it is known to have had commits of its own. */
function workMerged(root: string, target: string, tip: string, hadOwnCommits: boolean): boolean {
  if (ownCommits(root, target, tip) === 0) return hadOwnCommits; // a fresh branch's tip is on the default branch already
  return allPatchEquivalent(root, target, tip) || contentMerged(root, target, tip);
}

/** Commits on `tip` that no copy of the default branch has (the fewest, so commits only a stale copy lacks don't count). */
function ownCommitsAll(root: string, targets: string[], tip: string): number {
  return targets.length ? Math.min(...targets.map((t) => ownCommits(root, t, tip))) : 0;
}

/**
 * Note that a branch has memories. Its tip is remembered once it has commits of its own, so a merge can still be
 * detected after the branch is deleted, and a branch fresh off the default branch doesn't read as already merged.
 */
export function trackBranch(db: DB, projectId: string, root: string, branch: string): void {
  const def = defaultBranch(root);
  const tip = revParse(root, `refs/heads/${branch}`);
  const head = tip && def && ownCommitsAll(root, defaultTargets(root, def), tip) > 0 ? tip : null;
  db.prepare(
    `INSERT INTO branch_scopes (projectId, branch, lastHead, state, updatedAt) VALUES (?, ?, ?, 'open', ?)
     ON CONFLICT(projectId, branch) DO UPDATE SET lastHead = COALESCE(excluded.lastHead, lastHead), state = 'open', updatedAt = excluded.updatedAt`,
  ).run(projectId, branch, head, new Date().toISOString());
}

interface BranchDiff {
  /** Files the branch changed since it left the default branch: committed, uncommitted or new. */
  files: Set<string>;
  /** Identifiers the branch introduced: in its added lines and not its removed ones (new functions, types, flags). */
  names: Set<string>;
}

const diffCache = new Map<string, { at: number; diff: BranchDiff | undefined }>();
/** Identifier-like tokens: camelCase, PascalCase, snake_case, SCREAMING_CASE or with digits, four characters or more. */
const IDENT = /\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g;
const identifierLike = (t: string) => /[a-z][A-Z]|_|[A-Z]{2,}|\d/.test(t) || /^[A-Z][a-z]+[A-Z]/.test(t);
const MAX_DIFF = 2 * 1024 * 1024;

/**
 * What the current branch changed since it left the default branch, against the newest fork point (commits only a
 * stale default copy lacks aren't the branch's changes). Cached briefly per checkout; undefined when unknown.
 */
export function branchDiff(root: string): BranchDiff | undefined {
  const cached = diffCache.get(root);
  if (cached && Date.now() - cached.at < 5000) return cached.diff;
  const diff = computeBranchDiff(root);
  diffCache.set(root, { at: Date.now(), diff });
  return diff;
}

function computeBranchDiff(root: string): BranchDiff | undefined {
  const def = defaultBranch(root);
  const targets = def ? defaultTargets(root, def) : [];
  if (!targets.length) return undefined;
  const bases = targets.map((t) => gitSpawn(root, ['merge-base', 'HEAD', t], { timeout: 3000 })).filter((r) => r.status === 0).map((r) => r.stdout.toString().trim());
  const lists = bases.map((base) => {
    const r = gitSpawn(root, ['diff', '--name-only', '--no-renames', base], { timeout: 5000 });
    return r.status === 0 ? { base, files: r.stdout.toString().split('\n').filter(Boolean) } : undefined;
  }).filter((x): x is { base: string; files: string[] } => Boolean(x));
  if (!lists.length) return undefined;
  const newest = lists.reduce((a, b) => (b.files.length < a.files.length ? b : a));
  const files = new Set(newest.files);
  const untracked = gitSpawn(root, ['ls-files', '--others', '--exclude-standard'], { timeout: 5000 });
  const newFiles = untracked.status === 0 ? untracked.stdout.toString().split('\n').filter(Boolean) : [];
  for (const f of newFiles) files.add(f);
  const added = new Set<string>();
  const removed = new Set<string>();
  const patch = gitSpawn(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', newest.base], { timeout: 10_000, maxBuffer: MAX_DIFF });
  const collect = (line: string, into: Set<string>) => {
    for (const t of line.match(IDENT) ?? []) if (identifierLike(t)) into.add(t);
  };
  if (patch.status === 0) {
    for (const line of patch.stdout.toString().split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) collect(line, added);
      else if (line.startsWith('-') && !line.startsWith('---')) collect(line, removed);
    }
  }
  for (const f of newFiles.slice(0, 50)) {
    try {
      if (statSync(path.join(root, f)).size < 256 * 1024) collect(readFileSync(path.join(root, f), 'utf8'), added);
    } catch {
      /* unreadable */
    }
  }
  return { files, names: new Set([...added].filter((t) => !removed.has(t))) };
}

/** Files the current branch changed since it left the default branch (committed, uncommitted or new), or undefined. */
export function branchChangedFiles(root: string): Set<string> | undefined {
  return branchDiff(root)?.files;
}

/** Path-like references in text: `src/a.ts`, `docs/x.md`, `package.json`. */
const PATH_REF = /(?:^|[\s`'"(\[])((?:[\w.@-]+\/)*[\w@-][\w.@-]*\.[A-Za-z0-9]{1,8})(?=$|[\s`'"),:;\]]|\.(?:\s|$))/g;

/** Types that, with nothing else to go on, describe the branch's own work rather than code every branch shares. */
const BRANCH_WORK_TYPES = new Set(['decision', 'reasoning', 'trade-off', 'what-changed', 'session-request']);

export interface ScopeEvidence {
  type: string;
  files: string[];
  text: string;
  /** Files the storing session edited so far. */
  sessionFiles: string[];
}

/**
 * Whether a memory stored on a feature branch belongs to the branch or holds project-wide, from the evidence at
 * hand, strongest first: the files it names (or, naming none, the paths its text mentions) and whether the branch
 * changed them; names the branch introduced that its text mentions; the files the session edited; and only then its
 * type (plans and decisions are the branch's own; gotchas and explanations of existing code are not).
 */
export function scopeFor(root: string, e: ScopeEvidence): { scope: 'branch' | 'project'; why: string } {
  const diff = branchDiff(root);
  if (!diff) return { scope: 'branch', why: "the branch's changes could not be read" };
  const changed = (f: string) => diff.files.has(f) || (!f.includes('/') && [...diff.files].some((c) => path.basename(c) === f));
  const exists = (f: string) => {
    try {
      return statSync(path.join(root, f)).isFile();
    } catch {
      return false;
    }
  };
  const named = e.files.length ? e.files : [...new Set([...e.text.matchAll(PATH_REF)].map((m) => m[1]).filter((f) => changed(f) || exists(f)))];
  if (named.length) {
    return named.some(changed)
      ? { scope: 'branch', why: `it is about ${named.find(changed)}, which this branch changed` }
      : { scope: 'project', why: `it is about ${named.slice(0, 2).join(', ')}, which this branch hasn't changed` };
  }
  const mentioned = [...new Set(e.text.match(IDENT) ?? [])].find((t) => diff.names.has(t));
  if (mentioned) return { scope: 'branch', why: `it mentions ${mentioned}, which this branch introduced` };
  if (e.sessionFiles.length) {
    return e.sessionFiles.some(changed)
      ? { scope: 'branch', why: "it came out of this session's work on the branch's changes" }
      : { scope: 'project', why: "this session hasn't touched the branch's changes" };
  }
  return BRANCH_WORK_TYPES.has(e.type)
    ? { scope: 'branch', why: `a ${e.type} with nothing else to go on is taken as the branch's own` }
    : { scope: 'project', why: `a ${e.type} that names nothing the branch changed is taken to hold everywhere` };
}

/**
 * Check a project's open branches. Merged: the branch's own commits, or their content, are in a copy of the default
 * branch; its memories become project-wide. Deleted without merging (locally and on every remote): "ended", memories
 * kept hidden for review. A few git calls per open branch; never throws.
 */
export function refreshBranches(db: DB, project: ProjectInfo): { merged: string[]; ended: string[] } {
  const out = { merged: [] as string[], ended: [] as string[] };
  try {
    const root = project.rootPath;
    const def = defaultBranch(root);
    const targets = def ? defaultTargets(root, def) : [];
    if (!targets.length) return out;
    const open = db.prepare("SELECT branch, lastHead FROM branch_scopes WHERE projectId = ? AND state = 'open'").all(project.id) as { branch: string; lastHead: string | null }[];
    const setHead = db.prepare('UPDATE branch_scopes SET lastHead = ? WHERE projectId = ? AND branch = ?');
    for (const { branch, lastHead } of open) {
      const tip = revParse(root, `refs/heads/${branch}`) ?? (lastHead ? revParse(root, lastHead) : undefined);
      const exists = Boolean(revParse(root, `refs/heads/${branch}`));
      let merged = false;
      if (tip) {
        const hadOwn = Boolean(lastHead) || ownCommitsAll(root, targets, tip) > 0;
        merged = targets.some((t) => workMerged(root, t, tip, hadOwn));
        if (!merged && exists && ownCommitsAll(root, targets, tip) > 0) setHead.run(tip, project.id, branch);
      }
      if (merged) {
        promoteBranch(db, project, branch, 'merged');
        out.merged.push(branch);
      } else if (!exists && refsMatching(root, [`refs/remotes/*/${branch}`]).length === 0) {
        db.prepare("UPDATE branch_scopes SET state = 'ended', updatedAt = ? WHERE projectId = ? AND branch = ?").run(new Date().toISOString(), project.id, branch);
        out.ended.push(branch);
      }
    }
  } catch (e) {
    if (process.env.SYNAPSE_DEBUG) process.stderr.write(`[synapse branch] ${(e as Error).message}\n`);
  }
  return out;
}

/**
 * Make a branch's memories project-wide. A memory revising a project-wide topic (same topicKey) updates that memory,
 * keeping the replaced version in its history, and is archived pointing at it; the rest simply lose their branch.
 */
export function promoteBranch(db: DB, project: ProjectInfo, branch: string, state: BranchState = 'merged'): number {
  const rows = (db.prepare('SELECT * FROM observations WHERE projectId = ? AND branch = ? ORDER BY id').all(project.id, branch) as Record<string, unknown>[]).map(rowToObservation);
  let promoted = 0;
  for (const o of rows) {
    const target = o.status === 'active' && o.topicKey
      ? (db.prepare("SELECT * FROM observations WHERE projectId = ? AND topicKey = ? AND branch IS NULL AND status = 'active' ORDER BY id DESC LIMIT 1").get(project.id, o.topicKey) as Record<string, unknown> | undefined)
      : undefined;
    if (target) {
      const t = rowToObservation(target);
      editObservation(db, t.id, {
        type: o.type, entityName: o.entityName, title: o.title, narrative: o.narrative, facts: o.facts,
        filesModified: [...new Set([...t.filesModified, ...o.filesModified])], concepts: [...new Set([...t.concepts, ...o.concepts])],
      }, project.rootPath, { change: 'topic-update', note: `merged from branch ${branch}` });
      db.prepare("UPDATE observations SET status = 'archived', supersededBy = ?, branch = NULL, updatedAt = ? WHERE id = ?").run(t.id, new Date().toISOString(), o.id);
    } else {
      db.prepare('UPDATE observations SET branch = NULL WHERE id = ?').run(o.id);
    }
    if (o.status === 'active') promoted++;
  }
  db.prepare('UPDATE branch_scopes SET state = ?, updatedAt = ? WHERE projectId = ? AND branch = ?').run(state, new Date().toISOString(), project.id, branch);
  return promoted;
}

/** Archive a branch's active memories (an abandoned branch). Returns how many. */
export function archiveBranch(db: DB, projectId: string, branch: string): number {
  const ids = (db.prepare("SELECT id FROM observations WHERE projectId = ? AND branch = ? AND status = 'active'").all(projectId, branch) as { id: number }[]).map((r) => Number(r.id));
  setStatus(db, ids, 'archived', projectId);
  db.prepare("UPDATE branch_scopes SET state = 'ended', updatedAt = ? WHERE projectId = ? AND branch = ?").run(new Date().toISOString(), projectId, branch);
  return ids.length;
}

/** Make one memory project-wide (it holds on every branch). */
export function makeProjectWide(db: DB, id: number): Observation {
  const o = getObservation(db, id);
  if (!o) throw new Error(`No memory #${id}`);
  db.prepare('UPDATE observations SET branch = NULL WHERE id = ?').run(id);
  return getObservation(db, id)!;
}

/** Branches with memories, newest first, with how many active memories each still scopes. */
export function listBranches(db: DB, projectId: string): BranchScope[] {
  const rows = db
    .prepare(
      `SELECT b.branch, b.state, b.lastHead, b.updatedAt,
         (SELECT COUNT(*) FROM observations o WHERE o.projectId = b.projectId AND o.branch = b.branch AND o.status = 'active') AS memories
       FROM branch_scopes b WHERE b.projectId = ? ORDER BY b.updatedAt DESC`,
    )
    .all(projectId) as Record<string, unknown>[];
  return rows.map((r) => ({ branch: String(r.branch), state: r.state as BranchState, lastHead: (r.lastHead as string | null) ?? null, updatedAt: String(r.updatedAt), memories: Number(r.memories) }));
}

/** Forget the cached default branch (tests, or after the remote HEAD changes). */
export function resetBranchCache(): void {
  defaults.clear();
  diffCache.clear();
}

