import { gitText } from './gitexec.js';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';
import type { ProjectInfo } from './types.js';

function git(cwd: string, args: string[]): string | null {
  try {
    return gitText(cwd, args, { timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Normalize a git remote to a stable "owner/repo" id so the same project is
 * recognised regardless of clone protocol or checkout location.
 *   git@github.com:owner/repo.git  -> owner/repo
 *   https://github.com/owner/repo  -> owner/repo
 *   ssh://git@host:22/group/sub/repo.git -> group/sub/repo
 */
export function normalizeGitRemote(remote: string): string {
  let r = remote.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  r = r.replace(/^[a-z+]+:\/\//i, ''); // strip scheme
  r = r.replace(/^[^@/]+@/, ''); // strip user@
  // scp-like host:path
  const scp = r.match(/^([^/:]+):(?!\d+\/)(.+)$/);
  if (scp) return scp[2].toLowerCase();
  // host[:port]/path
  const parts = r.split('/');
  parts.shift();
  return parts.join('/').toLowerCase() || r.toLowerCase();
}

/**
 * Detect the project identity for a directory.
 * Outside git, falls back to a path-hashed directory id so memory also
 * works in scratch folders.
 */
export function detectProject(cwd: string = process.cwd()): ProjectInfo {
  const base = path.resolve(cwd);
  if (!existsSync(base) || !statSync(base).isDirectory()) {
    throw new Error(`Not a directory: ${base}`);
  }
  const root = git(base, ['rev-parse', '--show-toplevel']);
  if (root) {
    const remote = git(root, ['remote', 'get-url', 'origin']) ?? firstRemote(root);
    if (remote) {
      const id = normalizeGitRemote(remote);
      return { id, name: id.split('/').pop() || path.basename(root), rootPath: root, gitRemote: remote };
    }
    const name = path.basename(root);
    return { id: `local/${name}`, name, rootPath: root };
  }
  const name = path.basename(base);
  const hash = createHash('sha256').update(base).digest('hex').slice(0, 8);
  return { id: `dir/${name}-${hash}`, name, rootPath: base };
}

function firstRemote(root: string): string | null {
  const names = git(root, ['remote']);
  const first = names?.split('\n')[0];
  return first ? git(root, ['remote', 'get-url', first]) : null;
}

/** The host of a git remote URL (lowercased, no user or port), or undefined for local paths. */
export function remoteHost(remote: string): string | undefined {
  let r = remote.trim();
  if (/^(file:|\/|\.)/i.test(r) || /^[a-z]:\\/i.test(r)) return undefined;
  r = r.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
  const scp = r.match(/^([^/:]+):(?!\d+\/)/);
  const host = (scp ? scp[1] : r.split('/')[0]).replace(/:\d+$/, '').toLowerCase();
  return host || undefined;
}

const shortHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);

/**
 * Bind a detected project id to the checkout that first claimed it, so two unrelated repos never share memory.
 * Remote ids are host-less (`acme/app`, so clones over any protocol share memory); the first host seen for an id owns
 * it, and a checkout of the same path on a different host gets `<host>/acme/app`. `local/<name>` ids are owned by the
 * first root path; another repo with the same folder name gets `local/<name>-<hash>`. `dir/` ids are already unique.
 * Existing projects keep their ids: the first checkout to run after this upgrade claims each one.
 */
export function bindProjectIdentity(db: DB, info: ProjectInfo): ProjectInfo {
  if (info.id.startsWith('dir/')) return info;
  const local = info.id.startsWith('local/');
  const host = local ? undefined : info.gitRemote ? remoteHost(info.gitRemote) : undefined;
  if (!local && !host) return info;
  const claim = (id: string) => db.prepare('INSERT OR IGNORE INTO project_identity(projectId, host, rootPath, createdAt) VALUES(?,?,?,?)')
    .run(id, host ?? null, local ? info.rootPath : null, new Date().toISOString());
  const row = db.prepare('SELECT host, rootPath FROM project_identity WHERE projectId = ?').get(info.id) as { host: string | null; rootPath: string | null } | undefined;
  if (!row) {
    claim(info.id);
    return info;
  }
  if (local ? row.rootPath === info.rootPath : row.host === host) return info;
  const id = local ? `${info.id}-${shortHash(info.rootPath)}` : `${host}/${info.id}`;
  claim(id);
  return { ...info, id };
}

/** detectProject plus identity binding: use this wherever a database is at hand. */
export function resolveProject(db: DB, cwd: string = process.cwd()): ProjectInfo {
  return bindProjectIdentity(db, detectProject(cwd));
}
