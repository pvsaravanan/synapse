/**
 * Branch-scoped memories. A memory stored while a feature branch is checked out belongs to that branch: agents see it
 * on that branch, while briefs, search and file notes on other branches don't, until the branch merges into the
 * default branch, when its memories become project-wide. A branch that is deleted without merging leaves its
 * memories hidden and listed for review (make them project-wide, or archive them).
 *
 * The current branch is read from .git/HEAD on every call (no subprocess: hooks store often). The default branch is
 * SYNAPSE_DEFAULT_BRANCH, else origin's HEAD, else main / master / trunk if one exists; without one, nothing is
 * scoped. Merges are detected when the branch's last known commit is in the default branch (merge commit,
 * fast-forward) or every commit has a patch-equivalent there (rebase). Squash merges aren't detectable from git
 * alone: such a branch becomes "ended" once deleted, and its memories wait for review.
 */
import { readFileSync, statSync } from 'node:fs';
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

/** The checked-out branch, or undefined (not a git repo, or a detached HEAD). */
export function currentBranch(root: string): string | undefined {
  const dir = gitDir(root);
  if (!dir) return undefined;
  try {
    const m = readFileSync(path.join(dir, 'HEAD'), 'utf8').match(/^ref:\s*refs\/heads\/(.+?)\s*$/);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

const defaults = new Map<string, string | null>();

/** The shared git directory (a worktree's gitdir names it in `commondir`). */
function commonDir(dir: string): string {
  try {
    return path.resolve(dir, readFileSync(path.join(dir, 'commondir'), 'utf8').trim());
  } catch {
    return dir;
  }
}

/** origin's HEAD, or main / master / trunk, read from the ref files: hooks ask on every call, so no subprocess. */
function defaultFromFiles(root: string): string | undefined {
  const dir = gitDir(root);
  if (!dir) return undefined;
  const common = commonDir(dir);
  try {
    const m = readFileSync(path.join(common, 'refs', 'remotes', 'origin', 'HEAD'), 'utf8').match(/^ref:\s*refs\/remotes\/origin\/(.+?)\s*$/);
    if (m) return m[1];
  } catch {
    /* no origin HEAD file */
  }
  let packed = '';
  try {
    packed = readFileSync(path.join(common, 'packed-refs'), 'utf8');
  } catch {
    /* no packed refs */
  }
  return ['main', 'master', 'trunk'].find((b) => {
    try {
      statSync(path.join(common, 'refs', 'heads', b));
      return true;
    } catch {
      return packed.split('\n').some((l) => l.endsWith(` refs/heads/${b}`));
    }
  });
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

/** The ref the default branch is compared at: the local branch, else origin's. */
function defaultTarget(root: string, def: string): string | undefined {
  return [`refs/heads/${def}`, `refs/remotes/origin/${def}`].find((r) => refExists(root, r));
}

const revParse = (root: string, ref: string): string | undefined => {
  try {
    return gitText(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { timeout: 3000 }).trim() || undefined;
  } catch {
    return undefined;
  }
};

/** Commits on `tip` that the default branch doesn't have. */
function ownCommits(root: string, target: string, tip: string): number {
  const r = gitSpawn(root, ['rev-list', '--count', `${target}..${tip}`], { timeout: 5000 });
  return r.status === 0 ? Number(r.stdout.toString().trim()) || 0 : 0;
}

/** Every commit on `tip` missing from the default branch has a patch-equivalent there (the branch was rebased in). */
function allPatchEquivalent(root: string, target: string, tip: string): boolean {
  const r = gitSpawn(root, ['cherry', target, tip], { timeout: 5000 });
  const lines = r.status === 0 ? r.stdout.toString().split('\n').filter(Boolean) : [];
  return lines.length > 0 && lines.every((l) => l.startsWith('-'));
}

/**
 * Note that a branch has memories. Its tip is remembered once it has commits of its own, so a merge can still be
 * detected after the branch is deleted, and a branch fresh off the default branch doesn't read as already merged.
 */
export function trackBranch(db: DB, projectId: string, root: string, branch: string): void {
  const def = defaultBranch(root);
  const target = def ? defaultTarget(root, def) : undefined;
  const tip = revParse(root, `refs/heads/${branch}`);
  const head = tip && target && ownCommits(root, target, tip) > 0 ? tip : null;
  db.prepare(
    `INSERT INTO branch_scopes (projectId, branch, lastHead, state, updatedAt) VALUES (?, ?, ?, 'open', ?)
     ON CONFLICT(projectId, branch) DO UPDATE SET lastHead = COALESCE(excluded.lastHead, lastHead), state = 'open', updatedAt = excluded.updatedAt`,
  ).run(projectId, branch, head, new Date().toISOString());
}

/**
 * Check a project's open branches. Merged: the branch's own commits are in the default branch (merge commit,
 * fast-forward, or rebased patch-equivalents); its memories become project-wide. Deleted without merging (locally and
 * on origin): "ended", memories kept hidden for review. A few git calls per open branch; never throws.
 */
export function refreshBranches(db: DB, project: ProjectInfo): { merged: string[]; ended: string[] } {
  const out = { merged: [] as string[], ended: [] as string[] };
  try {
    const root = project.rootPath;
    const def = defaultBranch(root);
    const target = def ? defaultTarget(root, def) : undefined;
    if (!target) return out;
    const open = db.prepare("SELECT branch, lastHead FROM branch_scopes WHERE projectId = ? AND state = 'open'").all(project.id) as { branch: string; lastHead: string | null }[];
    const setHead = db.prepare('UPDATE branch_scopes SET lastHead = ? WHERE projectId = ? AND branch = ?');
    for (const { branch, lastHead } of open) {
      const tip = revParse(root, `refs/heads/${branch}`);
      let merged = false;
      if (tip) {
        const own = ownCommits(root, target, tip);
        if (own > 0) {
          merged = allPatchEquivalent(root, target, tip);
          if (!merged) setHead.run(tip, project.id, branch);
        } else merged = Boolean(lastHead); // it had commits of its own, and now the default branch has them all
      } else if (lastHead && revParse(root, lastHead)) {
        merged = ownCommits(root, target, lastHead) === 0 || allPatchEquivalent(root, target, lastHead);
      }
      if (merged) {
        promoteBranch(db, project, branch, 'merged');
        out.merged.push(branch);
      } else if (!tip && !refExists(root, `refs/remotes/origin/${branch}`)) {
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
}

