/**
 * Team memory through the repo: two teammates (two databases) sharing one checkout's .synapse/memory.jsonl.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../src/db.js';
import { handleHook } from '../src/hooks.js';
import { detectProject } from '../src/project.js';
import { editObservation, getObservation, listObservations, setStatus, storeObservation } from '../src/store.js';
import { exportTeam, importTeam, readTeamFile, teamAutoImport, TEAM_FILE } from '../src/team.js';
import type { ProjectInfo } from '../src/types.js';

let dir: string;
let project: ProjectInfo;
let alice: DB;
let bob: DB;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'syn-team-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src/limit.ts'), 'export const LIMIT = 10;\n');
  project = detectProject(dir);
  alice = openDatabase(':memory:');
  bob = openDatabase(':memory:');
});
afterEach(() => {
  delete process.env.SYNAPSE_TEAM;
});

const store = (db: DB, title: string, extra: Record<string, unknown> = {}) =>
  storeObservation(db, { projectId: project.id, entityName: 'api', type: 'gotcha', title, narrative: `${title}, details`, filesModified: ['src/limit.ts'], rootPath: dir, ...extra }).observation;
const lines = () => readFileSync(path.join(dir, TEAM_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const active = (db: DB) => listObservations(db, { projectId: project.id, limit: 50 });
/** Make later writes strictly newer than earlier ones (timestamps have millisecond resolution). */
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('team memory file', () => {
  it('shares only curated memories, scrubbed of machine paths and secrets, and rewrites only on change', () => {
    const shared = store(alice, 'Rate limit is per API key', { narrative: `See ${dir}/src/limit.ts and ${os.homedir()}/notes; token=ghp_abcdefghijklmnopqrstuvwxyz0123456789` });
    store(alice, 'Edited src/limit.ts', { type: 'what-changed', source: 'hook', admissionState: 'candidate' });
    store(alice, 'Commit: bump version', { type: 'what-changed', source: 'git' });
    store(alice, 'My local setup quirk', { entityName: 'me', concepts: ['private'] });
    const resolved = store(alice, 'Old decision', { entityName: 'old', type: 'decision' });
    setStatus(alice, [resolved.id], 'resolved');

    const r = exportTeam(alice, project);
    expect(r).toMatchObject({ written: true, shared: 1, tombstones: 0, newlyShared: [shared.id] });
    const [entry] = lines();
    expect(entry).toMatchObject({ uid: expect.stringMatching(/^m-[0-9a-f]{12}$/), type: 'gotcha', entity: 'api', title: 'Rate limit is per API key', files: ['src/limit.ts'], fileHashes: { 'src/limit.ts': expect.any(String) } });
    expect(entry.narrative).toContain('See src/limit.ts and ~/notes');
    expect(entry.narrative).not.toContain(dir);
    expect(entry.narrative).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(getObservation(alice, shared.id)!.uid).toBe(entry.uid);
    expect(exportTeam(alice, project).written).toBe(false); // nothing changed, file untouched
  });

  it('gives a teammate the same memories, keeps edits in sync both ways, newest wins', async () => {
    const a = store(alice, 'Rate limit is per API key');
    exportTeam(alice, project);
    const imported = importTeam(bob, project);
    expect(imported).toMatchObject({ added: [expect.any(Number)], updated: [], removed: [], invalid: 0 });
    const b = getObservation(bob, imported.added[0])!;
    expect(b).toMatchObject({ uid: getObservation(alice, a.id)!.uid, source: 'team', admissionState: 'qualified', title: 'Rate limit is per API key', fileHashes: getObservation(alice, a.id)!.fileHashes });
    expect(importTeam(bob, project)).toMatchObject({ added: [], updated: [], unchanged: 1 });

    await tick();
    editObservation(bob, b.id, { title: 'Rate limit is per API key, not per IP' });
    exportTeam(bob, project);
    expect(lines()).toHaveLength(1);
    expect(importTeam(alice, project).updated).toEqual([a.id]);
    expect(getObservation(alice, a.id)!.title).toBe('Rate limit is per API key, not per IP');

    // An older copy of the file (another branch) doesn't undo the newer edit.
    const newer = readFileSync(path.join(dir, TEAM_FILE), 'utf8');
    const older = newer.replace('Rate limit is per API key, not per IP', 'Stale title').replace(/"updatedAt":"[^"]+"/, '"updatedAt":"2000-01-01T00:00:00.000Z"');
    writeFileSync(path.join(dir, TEAM_FILE), older);
    expect(importTeam(alice, project)).toMatchObject({ updated: [], unchanged: 1 });
    expect(getObservation(alice, a.id)!.title).toBe('Rate limit is per API key, not per IP');
  });

  it('carries removals as tombstones that branch-hopping cannot undo', async () => {
    const a = store(alice, 'Rate limit is per API key');
    exportTeam(alice, project);
    const before = readFileSync(path.join(dir, TEAM_FILE), 'utf8');
    const b = importTeam(bob, project).added[0];
    await tick();
    setStatus(alice, [a.id], 'resolved');
    exportTeam(alice, project);
    expect(lines()).toEqual([{ uid: getObservation(alice, a.id)!.uid, status: 'resolved', title: 'Rate limit is per API key', updatedAt: expect.any(String) }]);
    expect(importTeam(bob, project).removed).toEqual([b]);
    expect(getObservation(bob, b)!.status).toBe('resolved');
    writeFileSync(path.join(dir, TEAM_FILE), before); // back to a branch from before the removal
    importTeam(bob, project);
    expect(getObservation(bob, b)!.status).toBe('resolved');
  });

  it('never drops a teammate\'s lines on export, and adopts the uid of a memory both stored independently', () => {
    store(alice, 'Rate limit is per API key');
    exportTeam(alice, project);
    store(bob, 'Webhooks need the raw body', { entityName: 'billing' });
    const twin = store(bob, 'Rate limit is per API key');
    const r = exportTeam(bob, project); // imports Alice's line first
    expect(r.imported.updated).toEqual([twin.id]); // same memory: Bob's copy takes the shared uid, no duplicate
    expect(active(bob)).toHaveLength(2);
    expect(lines().map((l) => l.title).sort()).toEqual(['Rate limit is per API key', 'Webhooks need the raw body']);
    expect(importTeam(alice, project).added).toHaveLength(1);
  });

  it('loads the file automatically when it changes: at session start, before the brief', () => {
    store(alice, 'Rate limit is per API key');
    exportTeam(alice, project);
    const out = handleHook(bob, { hook_event_name: 'SessionStart', session_id: 's1', cwd: dir });
    expect(active(bob).map((o) => o.title)).toEqual(['Rate limit is per API key']);
    expect(out.context).toContain('Rate limit is per API key');
    expect(teamAutoImport(bob, project)).toBeUndefined(); // unchanged file: nothing to do

    store(alice, 'Webhooks need the raw body', { entityName: 'billing' });
    exportTeam(alice, project);
    process.env.SYNAPSE_TEAM = '0';
    expect(teamAutoImport(bob, project)).toBeUndefined();
    delete process.env.SYNAPSE_TEAM;
    expect(teamAutoImport(bob, project)!.added).toHaveLength(1);
  });

  it('skips unreadable lines instead of failing', () => {
    mkdirSync(path.join(dir, '.synapse'), { recursive: true });
    const good = { uid: 'm-abcdef123456', type: 'gotcha', entity: 'api', title: 'Good', narrative: 'n', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    writeFileSync(path.join(dir, TEAM_FILE), ['{not json', JSON.stringify({ ...good, type: 'nonsense' }), JSON.stringify({ ...good, uid: '../x' }), JSON.stringify(good), ''].join('\n'));
    expect(readTeamFile(path.join(dir, TEAM_FILE)).invalid).toBe(3);
    expect(importTeam(bob, project)).toMatchObject({ added: [expect.any(Number)], invalid: 3 });
  });
});
