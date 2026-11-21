/**
 * Memory history: versions kept on every content change of a curated memory, the version at a date, diffs between
 * versions, restore, the 50-version cap, and the synapse_history tool.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../src/db.js';
import { formatHistory, lineDiff, memoryHistory, restoreVersion, revisionCounts, versionAt, versionChanges } from '../src/history.js';
import { createServer } from '../src/server.js';
import { deleteObservation, editObservation, getObservation, MAX_REVISIONS, mergeObservations, setStatus, storeObservation } from '../src/store.js';

const P = 'acme/app';
let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
});

const store = (extra: Record<string, unknown> = {}) =>
  storeObservation(db, { projectId: P, entityName: 'auth', type: 'decision', title: 'Sessions live in cookies', narrative: 'Signed cookies, 7 day expiry.', topicKey: 'decisions/auth/session', ...extra }).observation;
const changes = (id: number) => memoryHistory(db, id)!.filter((v) => !v.current).map((v) => v.change);

describe('versions are kept', () => {
  it('on topic updates, edits, merges and duplicate merges, but not for unchanged content or status changes', () => {
    const o = store();
    store({ narrative: 'Signed cookies, 30 day expiry.', sessionId: 's-1' });
    expect(changes(o.id)).toEqual(['topic-update']);
    expect(memoryHistory(db, o.id)![1]).toMatchObject({ revision: 1, narrative: 'Signed cookies, 7 day expiry.', sessionId: 's-1' });

    store({ narrative: 'Signed cookies, 30 day expiry.' }); // same content again: nothing to keep
    setStatus(db, [o.id], 'resolved');
    setStatus(db, [o.id], 'active');
    expect(changes(o.id)).toEqual(['topic-update']);

    editObservation(db, o.id, { title: 'Sessions live in signed cookies' });
    const dup = storeObservation(db, { projectId: P, entityName: 'auth', type: 'decision', title: 'Refresh tokens rotate', narrative: 'Each refresh issues a new token.' }).observation;
    const other = storeObservation(db, { projectId: P, entityName: 'auth', type: 'gotcha', title: 'Cookie domain', narrative: 'Use the parent domain.' }).observation;
    mergeObservations(db, o.id, [other.id]);
    expect(changes(o.id)).toEqual(['merge', 'edit', 'topic-update']);
    expect(memoryHistory(db, o.id)![1]).toMatchObject({ change: 'merge', note: `merged #${other.id}` });

    storeObservation(db, { projectId: P, entityName: 'auth', type: 'decision', title: 'Refresh tokens rotate', narrative: 'Each refresh issues a new token today.' });
    expect(changes(dup.id)).toEqual(['duplicate-merge']);
    expect(revisionCounts(db, [o.id, dup.id, other.id])).toEqual(new Map([[o.id, 3], [dup.id, 1]]));
  });

  it('skips auto-captured candidates, caps versions per memory, and drops history with the memory', () => {
    const c = store({ topicKey: 'hook/cmd/npm-test', source: 'hook', admissionState: 'candidate' });
    store({ topicKey: 'hook/cmd/npm-test', source: 'hook', admissionState: 'candidate', narrative: 'failed again' });
    expect(changes(c.id)).toEqual([]);

    const o = store();
    for (let i = 0; i < MAX_REVISIONS + 5; i++) editObservation(db, o.id, { narrative: `version ${i}` });
    const kept = memoryHistory(db, o.id)!;
    expect(kept).toHaveLength(MAX_REVISIONS + 1);
    expect(kept[kept.length - 1].narrative).toBe('version 4'); // the oldest ones were dropped
    deleteObservation(db, o.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM observation_revisions WHERE observationId = ?').get(o.id)).toEqual({ n: 0 });
  });
});

describe('reading history', () => {
  it('finds the version that held at a date', () => {
    const o = store();
    store({ narrative: 'Signed cookies, 30 day expiry.' });
    // Pin the timeline: created Jan 1, revised Mar 1.
    db.prepare("UPDATE observations SET createdAt = '2026-01-01T00:00:00.000Z', updatedAt = '2026-03-01T00:00:00.000Z' WHERE id = ?").run(o.id);
    db.prepare("UPDATE observation_revisions SET validFrom = '2026-01-01T00:00:00.000Z', replacedAt = '2026-03-01T00:00:00.000Z' WHERE observationId = ?").run(o.id);
    expect(versionAt(db, o.id, '2025-12-31')).toBeUndefined();
    expect(versionAt(db, o.id, '2026-02-01')).toMatchObject({ current: false, narrative: 'Signed cookies, 7 day expiry.' });
    expect(versionAt(db, o.id, '2026-03-02')).toMatchObject({ current: true, narrative: 'Signed cookies, 30 day expiry.' });
    expect(versionAt(db, o.id, 'not a date')).toBeUndefined();
  });

  it('diffs versions line by line and field by field', () => {
    expect(lineDiff('a\nb\nc', 'a\nc\nd')).toEqual([{ op: ' ', text: 'a' }, { op: '-', text: 'b' }, { op: ' ', text: 'c' }, { op: '+', text: 'd' }]);
    const o = store({ facts: ['expiry 7d'], filesModified: ['src/auth.ts'] });
    editObservation(db, o.id, { title: 'Sessions in cookies', narrative: 'Signed cookies, 7 day expiry.\nRotated on login.', facts: ['expiry 7d', 'rotate on login'], filesModified: ['src/session.ts'] });
    const [now, before] = memoryHistory(db, o.id)!;
    const c = versionChanges(before, now);
    expect(c.fields).toEqual([{ field: 'title', from: 'Sessions live in cookies', to: 'Sessions in cookies' }]);
    expect(c.narrative.filter((l) => l.op === '+')).toEqual([{ op: '+', text: 'Rotated on login.' }]);
    expect(c.facts).toEqual({ added: ['rotate on login'], removed: [] });
    expect(c.files).toEqual({ added: ['src/session.ts'], removed: ['src/auth.ts'] });
    const text = formatHistory(o.id, memoryHistory(db, o.id)!, { diff: true });
    expect(text).toContain('2 versions, newest first');
    expect(text).toMatch(/rev 1 .* then edited/);
    expect(text).toContain('title "Sessions live in cookies" → "Sessions in cookies"');
    expect(text).toContain('+ Rotated on login.');
    expect(formatHistory(99, [memoryHistory(db, o.id)![0]])).toContain('no earlier versions');
  });

  it('restores an earlier version and keeps the one it replaced', () => {
    const o = store();
    editObservation(db, o.id, { narrative: 'Tokens in localStorage.' });
    const restored = restoreVersion(db, o.id, 1);
    expect(restored.narrative).toBe('Signed cookies, 7 day expiry.');
    expect(restored.revisionCount).toBe(3);
    expect(changes(o.id)).toEqual(['restore', 'edit']);
    expect(memoryHistory(db, o.id)![1]).toMatchObject({ narrative: 'Tokens in localStorage.', note: 'restored revision 1' });
    expect(() => restoreVersion(db, o.id, 42)).toThrow(/no kept revision 42/);
    expect(getObservation(db, o.id)!.status).toBe('active');
  });
});

describe('synapse_history', () => {
  it('lists versions, shows one in full, and the version at a date', async () => {
    const o = store();
    store({ narrative: 'Signed cookies, 30 day expiry.' });
    const server = createServer({ db, mode: 'lite', project: { id: P, name: 'app', rootPath: process.cwd() }, hooks: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (args: Record<string, unknown>) => {
      const r = (await client.callTool({ name: 'synapse_history', arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content[0].text, isError: Boolean(r.isError) };
    };
    expect((await call({ id: o.id })).text).toMatch(/2 versions[\s\S]*- Signed cookies, 7 day expiry\.[\s\S]*\+ Signed cookies, 30 day expiry\./);
    expect((await call({ id: o.id, revision: 1 })).text).toContain('Signed cookies, 7 day expiry.');
    expect((await call({ id: o.id, at: new Date().toISOString() })).text).toContain('(current)');
    expect((await call({ id: o.id, at: '2000-01-01' })).isError).toBe(true);
    expect((await call({ id: 999 })).isError).toBe(true);
  });
});
