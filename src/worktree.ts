/**
 * Working-tree tracking for agents without hooks. The MCP server lives as long as the agent's session, so it
 * can compare the git working tree between tool calls and attribute files that changed to the session.
 * It can't tell the agent's edits from the user's; both count as the session's.
 */
import { gitText } from './gitexec.js';
import path from 'node:path';
import { hashFile } from './freshness.js';

/** Repos with more dirty files than this are only partly tracked. */
const MAX_DIRTY = 2000;

/** Dirty files (modified, added, deleted, untracked and not ignored) -> content hash ('' = deleted). Undefined outside git. */
export function dirtyFiles(root: string): Map<string, string> | undefined {
  let out: string;
  try {
    out = gitText(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { timeout: 5000 });
  } catch {
    return undefined;
  }
  const files = new Map<string, string>();
  for (const entry of out.split('\0')) {
    if (entry.length < 4 || files.size >= MAX_DIRTY) continue;
    const rel = entry.slice(3);
    if (rel.endsWith('/')) continue; // a submodule or nested repo
    files.set(rel, hashFile(path.join(root, rel)));
  }
  return files;
}

export class WorktreeTracker {
  private last: Map<string, string> | undefined;

  constructor(readonly root: string) {
    this.last = dirtyFiles(root);
  }

  /** False outside a git repository. */
  get enabled(): boolean {
    return this.last !== undefined;
  }

  /**
   * Files whose content changed since the previous call (or since the tracker started), project-relative.
   * A file that turned clean with the same content was committed, not edited, and is left out.
   */
  poll(): string[] {
    if (!this.last) return [];
    const now = dirtyFiles(this.root);
    if (!now) return [];
    const changed: string[] = [];
    for (const [file, hash] of now) if (this.last.get(file) !== hash) changed.push(file);
    for (const [file, before] of this.last) {
      if (now.has(file)) continue;
      if (hashFile(path.join(this.root, file)) !== before) changed.push(file); // reverted, or edited then committed
    }
    this.last = now;
    return changed.map((f) => f.split(path.sep).join('/'));
  }
}
