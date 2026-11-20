/**
 * Diffs of a flagged memory's files since it was stored: finding the version it was checked against in git history,
 * falling back to the last commit before it was stored, and the cases with nothing to compare.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../src/db.js';
import { checkedAt, memoryDiffs } from '../src/diff.js';
import { getObservation, storeObservation } from '../src/store.js';

let db: DB;
let dir: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } }).toString().trim();
const write = (file: string, text: string) => writeFileSync(path.join(dir, file), text);
const commit = (msg: string) => { git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
const remember = (files: string[]) =>
  storeObservation(db, { projectId: 'acme/app', entityName: 'api', type: 'gotcha', title: 'Limits are per key', narrative: 'n', filesModified: files, rootPath: dir }).observation;

beforeEach(() => {
  db = openDatabase(':memory:');
  dir = mkdtempSync(path.join(os.tmpdir(), 'syn-diff-'));
  mkdirSync(path.join(dir, 'src'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
});

describe('memory diffs', () => {
  it('diffs from the exact committed version the memory was stored against, through later commits and uncommitted edits', () => {
    write('src/limit.ts', 'export const LIMIT = 10;\nexport const WINDOW = 60;\n');
    const first = commit('Add limits');
    const o = remember(['src/limit.ts']);
    write('src/limit.ts', 'export const LIMIT = 20;\nexport const WINDOW = 60;\n');
    commit('Raise the limit');
    write('src/limit.ts', 'export const LIMIT = 20;\nexport const WINDOW = 30;\n'); // uncommitted
    const [d] = memoryDiffs(dir, o);
    expect(d).toMatchObject({ file: 'src/limit.ts', change: 'modified', added: 2, removed: 2, truncated: false, baseline: { commit: first, exact: true, subject: 'Add limits' } });
    expect(d.diff.split('\n')).toEqual(['@@ -1,2 +1,2 @@', '-export const LIMIT = 10;', '-export const WINDOW = 60;', '+export const LIMIT = 20;', '+export const WINDOW = 30;']);
    expect(d.baseline!.date).toMatch(/^2026-01-01/);
  });

  it('falls back to the last commit before the memory was stored when it was stored mid-edit, marked approximate', () => {
    write('src/limit.ts', 'a\n');
    const base = commit('Base');
    write('src/limit.ts', 'a\nb\n'); // uncommitted when the memory is stored
    const o = remember(['src/limit.ts']);
    write('src/limit.ts', 'a\nb\nc\n');
    const [d] = memoryDiffs(dir, { ...o, createdAt: '2030-01-01T00:00:00Z' });
    expect(d.baseline).toMatchObject({ commit: base, exact: false });
    expect(d.diff).toContain('+b\n+c');
  });

  it('shows a file created since as all new, a deleted one as all removed, and skips ignored files', () => {
    write('src/limit.ts', 'x\n');
    write('src/gone.ts', 'old line\n');
    commit('Base');
    const o = remember(['src/new.ts', 'src/gone.ts', '.env']);
    write('src/new.ts', 'fresh\n');
    rmSync(path.join(dir, 'src/gone.ts'));
    write('.env', 'TOKEN=abc\n');
    const diffs = memoryDiffs(dir, o);
    expect(diffs.map((d) => [d.file, d.change])).toEqual([['src/new.ts', 'created'], ['src/gone.ts', 'deleted']]); // .env is never hashed
    expect(diffs[0]).toMatchObject({ added: 1, note: 'The file did not exist when this was stored.' });
    expect(diffs[0].diff).toContain('+fresh');
    expect(diffs[1]).toMatchObject({ removed: 1, baseline: { exact: true } });
  });

  it('redacts secrets in the diff and explains when there is nothing to compare', () => {
    write('src/limit.ts', 'const a = 1;\n');
    commit('Base');
    const o = remember(['src/limit.ts']);
    write('src/limit.ts', 'const a = 1;\nconst key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n');
    expect(memoryDiffs(dir, o)[0].diff).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');

    const plain = mkdtempSync(path.join(os.tmpdir(), 'syn-nogit-'));
    writeFileSync(path.join(plain, 'a.ts'), 'one\n');
    const p = storeObservation(db, { projectId: 'x/y', entityName: 'e', type: 'gotcha', title: 't', narrative: 'n', filesModified: ['a.ts'], rootPath: plain }).observation;
    writeFileSync(path.join(plain, 'a.ts'), 'two\n');
    expect(memoryDiffs(plain, p)[0].note).toMatch(/not a git repository/);
    const unflagged = storeObservation(db, { projectId: 'acme/app', entityName: 'docs', type: 'decision', title: 'Docs are hand-written', narrative: 'n', rootPath: dir }).observation;
    expect(memoryDiffs(dir, getObservation(db, unflagged.id)!)).toEqual([]); // nothing flagged, nothing to diff
  });

  it('counts a verification as the time the memory last matched its files', () => {
    const o = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' } as Parameters<typeof checkedAt>[0];
    expect(checkedAt(o)).toBe('2026-02-01T00:00:00Z');
    expect(checkedAt(o, '2026-03-01T00:00:00Z')).toBe('2026-03-01T00:00:00Z');
  });
});
