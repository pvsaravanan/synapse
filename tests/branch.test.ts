/**
 * Branch-scoped memories, in real temporary git repositories: scoping on a feature branch, visibility in search,
 * briefs and file notes, topic forks that stand in for the project-wide memory, and merge detection (merge commit,
 * fast-forward, rebase, deleted after merge), ended branches, promotion and archiving.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { archiveBranch, branchScope, currentBranch, defaultBranch, listBranches, makeProjectWide, promoteBranch, refreshBranches, resetBranchCache } from '../src/branch.js';
import { buildProjectContext } from '../src/context.js';
import { openDatabase, type DB } from '../src/db.js';
import { fileNotes } from '../src/file-notes.js';
import { memoryHistory } from '../src/history.js';
import { detectProject } from '../src/project.js';
import { search } from '../src/search.js';
import { createServer } from '../src/server.js';
import { getObservation, listObservations, storeObservation } from '../src/store.js';
import { exportTeam, readTeamFile, TEAM_FILE } from '../src/team.js';
import type { ProjectInfo } from '../src/types.js';

let db: DB;
let dir: string;
let project: ProjectInfo;
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
const commit = (file: string, text: string, msg: string) => {
  writeFileSync(path.join(dir, file), text);
  git('add', file);
  git('commit', '-q', '-m', msg);
};

beforeEach(() => {
  db = openDatabase(':memory:');
  dir = mkdtempSync(path.join(os.tmpdir(), 'syn-branch-'));
  git('init', '-q');
  git('checkout', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(path.join(dir, 'src'));
  commit('src/auth.ts', 'export const AUTH = 1;\n', 'init');
  project = detectProject(dir);
});

/** Store as an agent would; scope "branch" unless the test is about how the scope is decided (pass scope: undefined). */
const remember = (title: string, extra: Record<string, unknown> = {}) =>
  storeObservation(db, { projectId: project.id, entityName: 'auth', type: 'gotcha', title, narrative: `${title}, details`, rootPath: project.rootPath, scope: 'branch', ...extra }).observation;
const decide = (title: string, extra: Record<string, unknown> = {}) =>
  storeObservation(db, { projectId: project.id, entityName: 'auth', type: 'gotcha', title, narrative: `${title}, details`, rootPath: project.rootPath, ...extra });
const titles = (branch: string | null) => search(db, { query: 'session', projectId: project.id, branch }).map((h) => h.observation.title).sort();

describe('scoping', () => {
  it('scopes memories stored on a feature branch, unless they hold project-wide', () => {
    expect(defaultBranch(project.rootPath)).toBe('main');
    expect(branchScope(project.rootPath)).toBeUndefined();
    const onMain = remember('Session cookie domain');
    git('checkout', '-q', '-b', 'feature/redis');
    expect(currentBranch(project.rootPath)).toBe('feature/redis');
    const onBranch = remember('Session store moves to Redis');
    const everywhere = remember('Session tests need Docker', { scope: 'project' });
    expect([onMain.branch, onBranch.branch, everywhere.branch]).toEqual([undefined, 'feature/redis', undefined]);

    expect(titles(null)).toEqual(['Session cookie domain', 'Session tests need Docker']);
    expect(titles('feature/redis')).toEqual(['Session cookie domain', 'Session store moves to Redis', 'Session tests need Docker']);
    expect(listObservations(db, { projectId: project.id, branch: null }).map((o) => o.id)).not.toContain(onBranch.id);
    expect(listBranches(db, project.id)).toEqual([expect.objectContaining({ branch: 'feature/redis', state: 'open', memories: 1 })]);
  });

  it('keeps other branches\' memories out of briefs and file notes', () => {
    git('checkout', '-q', '-b', 'feature/redis');
    writeFileSync(path.join(dir, 'src/auth.ts'), 'export const AUTH = "redis";\n'); // the branch changes the file
    const scoped = remember('Session store moves to Redis', { filesModified: ['src/auth.ts'] });
    expect(scoped.branch).toBe('feature/redis');
    const onBranch = buildProjectContext(db, project, 'session store');
    expect(onBranch.text).toContain('Branch: feature/redis');
    expect(onBranch.text).toContain(`#${scoped.id}`);
    expect(fileNotes(db, project, undefined, ['src/auth.ts'])).toContain('Session store moves to Redis');

    git('stash', '-q');
    git('checkout', '-q', 'main');
    const onMain = buildProjectContext(db, project, 'session store');
    expect(onMain.text).not.toContain('Branch:');
    expect(onMain.text).not.toContain(`#${scoped.id}`);
    expect(fileNotes(db, project, undefined, ['src/auth.ts'])).toBeUndefined();
  });

  it('decides from evidence whether an agent\'s memory belongs to the branch or holds project-wide', () => {
    commit('src/db.ts', 'export const DB = 1;\n', 'db');
    git('checkout', '-q', '-b', 'feature/redis');
    commit('src/auth.ts', 'export const AUTH = 2;\nexport function connectRedisStore() {}\n', 'redis auth');
    writeFileSync(path.join(dir, 'src/cache.ts'), 'export const CACHE_TTL_SECONDS = 60;\n'); // new, untracked
    const where = (r: ReturnType<typeof decide>) => [r.observation.branch ?? 'project', r.scopeReason];

    // Named files: changed or new on the branch -> branch; unchanged -> project-wide.
    expect(where(decide('Pool lives in db.ts', { filesModified: ['src/db.ts'] }))).toEqual(['project', expect.stringContaining("src/db.ts, which this branch hasn't changed")]);
    expect(where(decide('Auth uses Redis', { filesModified: ['src/auth.ts'] }))[0]).toBe('feature/redis');
    expect(where(decide('Cache is new', { filesModified: ['src/cache.ts'] }))[0]).toBe('feature/redis');
    // No files named: paths in the text count the same way.
    expect(where(decide('Pool size note', { narrative: 'The pool in `src/db.ts` caps at 10.' }))[0]).toBe('project');
    expect(where(decide('Auth note', { narrative: 'See src/auth.ts for the store.' }))[0]).toBe('feature/redis');
    // Names the branch introduced.
    expect(where(decide('Store connects lazily', { narrative: 'connectRedisStore waits for the first request.' }))).toEqual(['feature/redis', expect.stringContaining('connectRedisStore')]);
    expect(where(decide('TTL is a minute', { narrative: 'CACHE_TTL_SECONDS is 60.' }))[0]).toBe('feature/redis');
    // Nothing to go on: plans and decisions are the branch's, gotchas hold everywhere.
    expect(where(decide('Use Redis for sessions', { type: 'decision', narrative: 'Chosen over memcached.' }))[0]).toBe('feature/redis');
    expect(where(decide('Docker must run for tests', { narrative: 'Integration tests need the daemon.' }))).toEqual(['project', expect.stringContaining('gotcha')]);
    // The session's edits, when there are any.
    storeObservation(db, { projectId: project.id, entityName: 'src', type: 'what-changed', title: 'Edited src/db.ts', narrative: 'x', source: 'hook', admissionState: 'candidate', sessionId: 's-1', filesModified: ['src/db.ts'] });
    expect(where(decide('Pool tuning idea', { type: 'decision', narrative: 'Raise it later.', sessionId: 's-1' }))[0]).toBe('project');
    storeObservation(db, { projectId: project.id, entityName: 'src', type: 'what-changed', title: 'Edited src/auth.ts', narrative: 'x', source: 'hook', admissionState: 'candidate', sessionId: 's-2', filesModified: ['src/auth.ts'] });
    expect(where(decide('Login flow gotcha', { narrative: 'Retry once.', sessionId: 's-2' }))[0]).toBe('feature/redis');
    // A choice always wins.
    expect(where(decide('Pool, scoped on purpose', { filesModified: ['src/db.ts'], scope: 'branch' }))[0]).toBe('feature/redis');
    expect(where(decide('Auth, everywhere on purpose', { filesModified: ['src/auth.ts'], scope: 'project' }))[0]).toBe('project');
  });

  it('keeps scoping during a rebase, when HEAD is detached', () => {
    git('checkout', '-q', '-b', 'feature/rebasing');
    commit('src/auth.ts', 'export const AUTH = 2;\n', 'one');
    const head = git('rev-parse', 'HEAD');
    git('checkout', '-q', '--detach', head);
    expect(currentBranch(project.rootPath)).toBeUndefined(); // plain detached HEAD: no branch
    mkdirSync(path.join(dir, '.git', 'rebase-merge'), { recursive: true });
    writeFileSync(path.join(dir, '.git', 'rebase-merge', 'head-name'), 'refs/heads/feature/rebasing\n');
    expect(currentBranch(project.rootPath)).toBe('feature/rebasing');
  });

  it('forks a project-wide topic on a branch: the branch copy stands in for it there, main keeps its version', () => {
    const main = remember('Sessions live in cookies', { type: 'decision', topicKey: 'decisions/auth/session' });
    git('checkout', '-q', '-b', 'feature/redis');
    const fork = remember('Sessions live in Redis', { type: 'decision', topicKey: 'decisions/auth/session' });
    expect(fork.id).not.toBe(main.id);
    expect(getObservation(db, main.id)!.title).toBe('Sessions live in cookies');
    expect(remember('Sessions live in Redis with a TTL', { type: 'decision', topicKey: 'decisions/auth/session' }).id).toBe(fork.id); // updates the fork
    expect(titles('feature/redis')).toEqual(['Sessions live in Redis with a TTL']);
    expect(titles(null)).toEqual(['Sessions live in cookies']);
  });

  it('keeps branch memories out of the team file', () => {
    remember('Session cookie domain');
    git('checkout', '-q', '-b', 'feature/redis');
    remember('Session store moves to Redis');
    exportTeam(db, project);
    expect(readTeamFile(path.join(project.rootPath, TEAM_FILE)).entries.map((e) => e.title)).toEqual(['Session cookie domain']);
  });
});

describe('merges', () => {
  it('makes a merged branch\'s memories project-wide, folding topic forks into the project-wide memory', () => {
    const main = remember('Sessions live in cookies', { type: 'decision', topicKey: 'decisions/auth/session' });
    git('checkout', '-q', '-b', 'feature/redis');
    const fork = remember('Sessions live in Redis', { type: 'decision', topicKey: 'decisions/auth/session' });
    const plain = remember('Redis needs a password in CI');
    expect(refreshBranches(db, project)).toEqual({ merged: [], ended: [] }); // no commits of its own yet: not merged
    commit('src/auth.ts', 'export const AUTH = 2;\n', 'redis sessions');
    expect(refreshBranches(db, project)).toEqual({ merged: [], ended: [] });

    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'merge redis', 'feature/redis');
    expect(refreshBranches(db, project).merged).toEqual(['feature/redis']);
    expect(getObservation(db, plain.id)!.branch).toBeUndefined();
    expect(getObservation(db, main.id)!.title).toBe('Sessions live in Redis');
    expect(getObservation(db, fork.id)).toMatchObject({ status: 'archived', supersededBy: main.id });
    expect(memoryHistory(db, main.id)![1]).toMatchObject({ title: 'Sessions live in cookies', change: 'topic-update', note: 'merged from branch feature/redis' });
    expect(listBranches(db, project.id)[0]).toMatchObject({ state: 'merged', memories: 0 });
  });

  it('detects squash merges, with the branch kept or deleted', () => {
    git('checkout', '-q', '-b', 'feature/squash');
    const a = remember('Session squash change');
    commit('src/auth.ts', 'export const AUTH = 5;\n', 'one');
    commit('src/squash.ts', 'export const S = 1;\n', 'two');
    refreshBranches(db, project);
    git('checkout', '-q', 'main');
    commit('src/other.ts', 'export const O = 1;\n', 'main moves on');
    expect(refreshBranches(db, project).merged).toEqual([]);
    git('merge', '-q', '--squash', 'feature/squash');
    git('commit', '-q', '-m', 'squashed feature');
    expect(refreshBranches(db, project).merged).toEqual(['feature/squash']);
    expect(getObservation(db, a.id)!.branch).toBeUndefined();

    git('checkout', '-q', '-b', 'feature/squash2');
    const b = remember('Session second squash');
    commit('src/s2.ts', 'export const S2 = 1;\n', 's2');
    refreshBranches(db, project);
    git('checkout', '-q', 'main');
    git('merge', '-q', '--squash', 'feature/squash2');
    git('commit', '-q', '-m', 'squashed 2');
    git('branch', '-q', '-D', 'feature/squash2');
    expect(refreshBranches(db, project).merged).toEqual(['feature/squash2']);
    expect(getObservation(db, b.id)!.branch).toBeUndefined();
  });

  it('counts a merge that only origin\'s copy of the default branch has (local main not pulled)', () => {
    git('checkout', '-q', '-b', 'feature/remote');
    const a = remember('Session remote merge');
    commit('src/remote.ts', 'export const R = 1;\n', 'remote work');
    refreshBranches(db, project);
    // Simulate the merge happening on origin: origin/main has the branch's commit, local main doesn't.
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'feature/remote'));
    git('checkout', '-q', 'main');
    expect(git('rev-parse', 'main')).not.toBe(git('rev-parse', 'origin/main'));
    expect(refreshBranches(db, project).merged).toEqual(['feature/remote']);
    expect(getObservation(db, a.id)!.branch).toBeUndefined();
  });

  it('detects fast-forward merges after the branch is deleted, and rebased (patch-equivalent) branches', () => {
    git('checkout', '-q', '-b', 'feature/ff');
    const a = remember('Fast-forward session change');
    commit('src/auth.ts', 'export const AUTH = 3;\n', 'ff change');
    refreshBranches(db, project); // remembers the tip
    git('checkout', '-q', 'main');
    git('merge', '-q', '--ff-only', 'feature/ff');
    git('branch', '-q', '-d', 'feature/ff');
    expect(refreshBranches(db, project).merged).toEqual(['feature/ff']);
    expect(getObservation(db, a.id)!.branch).toBeUndefined();

    git('checkout', '-q', '-b', 'feature/rebase');
    const b = remember('Rebased session change');
    commit('src/rebase.ts', 'export const R = 1;\n', 'rebase change');
    git('checkout', '-q', 'main');
    commit('src/other.ts', 'export const O = 1;\n', 'other work on main');
    git('cherry-pick', 'feature/rebase');
    expect(refreshBranches(db, project).merged).toEqual(['feature/rebase']);
    expect(getObservation(db, b.id)!.branch).toBeUndefined();
  });

  it('does not count a branch whose commits net out to no change as merged', () => {
    git('checkout', '-q', '-b', 'feature/noop');
    remember('Session no-op change');
    commit('src/auth.ts', 'export const AUTH = 9;\n', 'change');
    commit('src/auth.ts', 'export const AUTH = 1;\n', 'revert it');
    git('checkout', '-q', 'main');
    commit('src/other.ts', 'export const O = 1;\n', 'main moves on');
    expect(refreshBranches(db, project)).toEqual({ merged: [], ended: [] });
    git('branch', '-q', '-D', 'feature/noop');
    expect(refreshBranches(db, project)).toEqual({ merged: [], ended: ['feature/noop'] });
  });

  it('marks a deleted unmerged branch ended, keeps its memories hidden, and lets them be promoted or archived', () => {
    git('checkout', '-q', '-b', 'spike/a');
    const a = remember('Session spike A');
    commit('src/a.ts', 'export const A = 1;\n', 'spike a');
    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', 'spike/b');
    const b = remember('Session spike B');
    commit('src/b.ts', 'export const B = 1;\n', 'spike b');
    git('checkout', '-q', 'main');
    git('branch', '-q', '-D', 'spike/a');
    git('branch', '-q', '-D', 'spike/b');
    expect(refreshBranches(db, project).ended.sort()).toEqual(['spike/a', 'spike/b']);
    expect(titles(null)).toEqual([]);
    expect(listBranches(db, project.id).map((x) => [x.branch, x.state, x.memories]).sort()).toEqual([['spike/a', 'ended', 1], ['spike/b', 'ended', 1]]);

    expect(promoteBranch(db, project, 'spike/a')).toBe(1);
    expect(archiveBranch(db, project.id, 'spike/b')).toBe(1);
    expect(getObservation(db, a.id)!.branch).toBeUndefined();
    expect(getObservation(db, b.id)!.status).toBe('archived');
    expect(titles(null)).toEqual(['Session spike A']);
  });

  it('makes one memory project-wide', () => {
    git('checkout', '-q', '-b', 'feature/x');
    const o = remember('Session tooling note');
    expect(makeProjectWide(db, o.id).branch).toBeUndefined();
  });
});

describe('default branch', () => {
  it('reads git config synapse.defaultBranch, remote HEADs, and remote-only default branches', () => {
    git('branch', '-q', '-m', 'main', 'develop'); // no main / master / trunk locally
    resetBranchCache();
    expect(defaultBranch(project.rootPath)).toBeUndefined();
    git('update-ref', 'refs/remotes/upstream/trunk', 'HEAD');
    resetBranchCache();
    expect(defaultBranch(project.rootPath)).toBe('trunk');
    git('symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/develop');
    resetBranchCache();
    expect(defaultBranch(project.rootPath)).toBe('develop');
    git('config', 'synapse.defaultBranch', 'release');
    resetBranchCache();
    expect(defaultBranch(project.rootPath)).toBe('release');
  });
});

describe('MCP tools', () => {
  it('say where a stored memory lives, and search shows the current branch\'s memories', async () => {
    git('checkout', '-q', '-b', 'feature/redis');
    const server = createServer({ db, mode: 'lite', project, hooks: true });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(x), client.connect(y)]);
    const call = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text;
    const stored = await call('synapse_store', { entityName: 'auth', type: 'decision', title: 'Session store moves to Redis', narrative: 'Redis replaces cookies.' });
    expect(stored).toMatch(/On branch feature\/redis because a decision with nothing else to go on/);
    const wide = await call('synapse_store', { entityName: 'ci', type: 'gotcha', title: 'Session tests need Docker', narrative: 'Docker must run.' });
    expect(wide).toMatch(/Project-wide because a gotcha that names nothing the branch changed/);
    expect(await call('synapse_search', { query: 'session' })).toContain('Session store moves to Redis');
    git('checkout', '-q', 'main');
    const onMain = await call('synapse_search', { query: 'session' });
    expect(onMain).not.toContain('Session store moves to Redis');
    expect(onMain).toContain('1 more match on other branches (feature/redis), not shown: pass branches "all"');
    expect(await call('synapse_search', { query: 'session', branches: 'all' })).toContain('Session store moves to Redis');
    expect(await call('synapse_search', { query: 'redis replaces' })).toMatch(/No memories matched "redis replaces" on this branch\.\n1 more match on other branches/);
  });
});
