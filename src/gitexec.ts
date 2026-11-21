/**
 * Every git subprocess Synapse runs goes through here. Synapse runs git in directories it did not choose (an agent's
 * cwd, a projectRoot an agent passed, a hook payload's cwd), and a repository's own config can name commands git runs
 * on its behalf: core.fsmonitor runs on `git status`, and an embedded bare repository (a plain directory holding HEAD,
 * objects/ and a config, checked in to another repo) is discovered and its config honoured unless
 * safe.bareRepository is "explicit". Command-line `-c` settings are protected configuration, so a repo cannot undo
 * them. Callers add `--no-textconv` / `--no-ext-diff` to diff-producing commands themselves.
 */
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';

export const SAFE_GIT_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=explicit'];

export const safeGitArgs = (args: string[]): string[] => [...SAFE_GIT_CONFIG, ...args];

/** execFileSync('git', …) with the safety settings; output as utf8 text. Throws like execFileSync. */
export function gitText(cwd: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}): string {
  return execFileSync('git', safeGitArgs(args), {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: opts.timeout, maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
  });
}

/** spawnSync('git', …) with the safety settings; never throws. */
export function gitSpawn(cwd: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}): SpawnSyncReturns<Buffer> {
  return spawnSync('git', safeGitArgs(args), { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: opts.timeout ?? 10_000, maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024 });
}
