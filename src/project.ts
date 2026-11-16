import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ProjectInfo } from './types.js';

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null;
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
