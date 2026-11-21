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
import { archiveBranch, branchScope, currentBranch, defaultBranch, listBranches, makeProjectWide, promoteBranch, refreshBranches } from '../src/branch.js';
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

const remember = (title: string, extra: Record<string, unknown> = {}) =>
  storeObservation(db, { projectId: project.id, entityName: 'auth', type: 'gotcha', title, narrative: `${title}, details`, rootPath: project.rootPath, ...extra }).observation;
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
    const scoped = remember('Session store moves to Redis', { filesModified: ['src/auth.ts'] });
    const onBranch = buildProjectContext(db, project, 'session store');
    expect(onBranch.text).toContain('Branch: feature/redis');
    expect(onBranch.text).toContain(`#${scoped.id}`);
    expect(fileNotes(db, project, undefined, ['src/auth.ts'])).toContain('Session store moves to Redis');

    git('checkout', '-q', 'main');
    const onMain = buildProjectContext(db, project, 'session store');
    expect(onMain.text).not.toContain('Branch:');
    expect(onMain.text).not.toContain(`#${scoped.id}`);
    expect(fileNotes(db, project, undefined, ['src/auth.ts'])).toBeUndefined();
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

describe('MCP tools', () => {
  it('say where a stored memory lives, and search shows the current branch\'s memories', async () => {
    git('checkout', '-q', '-b', 'feature/redis');
    const server = createServer({ db, mode: 'lite', project, hooks: true });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(x), client.connect(y)]);
    const call = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text;
    const stored = await call('synapse_store', { entityName: 'auth', type: 'gotcha', title: 'Session store moves to Redis', narrative: 'Redis replaces cookies.' });
    expect(stored).toContain('On branch feature/redis');
    const wide = await call('synapse_store', { entityName: 'ci', type: 'gotcha', title: 'Session tests need Docker', narrative: 'Docker must run.', scope: 'project' });
    expect(wide).not.toContain('On branch');
    expect(await call('synapse_search', { query: 'session' })).toContain('Session store moves to Redis');
    git('checkout', '-q', 'main');
    expect(await call('synapse_search', { query: 'session' })).not.toContain('Session store moves to Redis');
  });
});
