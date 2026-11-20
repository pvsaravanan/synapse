/**
 * Meaning-based search: blending embedding similarity into keyword search, keeping vectors current, and falling back
 * to keywords. A deterministic fake embedder stands in for the model (the real one is exercised by `synapse embed`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../src/db.js';
import { embedEnabled, ensureEmbeddings, hybridSearch, relatedIds, semanticScores, setEmbedEnabled, type Embedder } from '../src/embed.js';
import { blendSemantic, search } from '../src/search.js';
import { deleteObservation, editObservation, setStatus, storeObservation } from '../src/store.js';

const P = 'acme/app';
let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
});
afterEach(() => {
  delete process.env.SYNAPSE_EMBED;
});

/** One dimension per idea; words that mean the same thing land on the same dimension. */
const IDEAS = [['crash', 'crashes', 'panic', 'panics', 'segfault', 'abort'], ['login', 'auth', 'signin', 'session'], ['slow', 'latency', 'lag'], ['deploy', 'release']];
let calls = 0;
const fake: Embedder = async (texts) => {
  calls += texts.length;
  return texts.map((t) => {
    const words = t.toLowerCase().match(/[a-z]+/g) ?? [];
    const v = new Float32Array(IDEAS.length + 1).map((_, i) => (i < IDEAS.length ? words.filter((w) => IDEAS[i].includes(w)).length : 0.3));
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  });
};
const mem = (title: string, narrative: string, extra: Record<string, unknown> = {}) =>
  storeObservation(db, { projectId: P, entityName: title.split(' ')[0].toLowerCase(), type: 'gotcha', title, narrative, ...extra }).observation;

describe('meaning-based search', () => {
  it('finds a memory by meaning that keyword search misses, and keeps exact wording first', async () => {
    const panic = mem('Worker panics on empty queue', 'The worker panics when the queue is empty at startup.');
    const crash = mem('Crash report upload', 'Crash reports upload on exit.');
    mem('Login cookie domain', 'The session cookie needs the parent domain.');
    expect(search(db, { query: 'app crashes', projectId: P })).toEqual([]); // keywords: "crashes*" matches neither
    expect(search(db, { query: 'crash', projectId: P }).map((h) => h.observation.id)).toEqual([crash.id]); // only the literal match
    expect((await hybridSearch(db, { query: 'app crashes', projectId: P }, { embedder: fake })).map((h) => h.observation.id).sort()).toEqual([panic.id, crash.id].sort());
    const hits = await hybridSearch(db, { query: 'crash', projectId: P }, { embedder: fake });
    expect(hits.map((h) => h.observation.id)).toEqual([crash.id, panic.id]);
    expect(hits[1].semantic).toBeGreaterThan(0.3);
    expect(hits[0].lexical).toBeGreaterThan(hits[1].lexical); // the literal match ranks first
    expect(hits.map((h) => h.observation.title)).not.toContain('Login cookie domain'); // unrelated stays out
  });

  it('embeds only new or changed memories, and respects status and project filters', async () => {
    const a = mem('Worker panics on empty queue', 'Panics at startup.');
    const b = mem('Deploy needs a tag', 'Release builds need a git tag.');
    storeObservation(db, { projectId: 'other/repo', entityName: 'x', type: 'gotcha', title: 'Other project segfault', narrative: 'Segfault.' });
    calls = 0;
    expect(await ensureEmbeddings(db, P, { embedder: fake })).toBe(2);
    expect(await ensureEmbeddings(db, P, { embedder: fake })).toBe(0);
    editObservation(db, a.id, { narrative: 'Panics at startup when the queue is empty.' });
    expect(await ensureEmbeddings(db, P, { embedder: fake })).toBe(1);
    expect(calls).toBe(3);

    setStatus(db, [a.id], 'resolved');
    expect((await hybridSearch(db, { query: 'crash', projectId: P }, { embedder: fake })).map((h) => h.observation.id)).toEqual([]);
    expect((await hybridSearch(db, { query: 'crash', projectId: P, status: 'all' }, { embedder: fake })).map((h) => h.observation.id)).toEqual([a.id]);
    const scores = await semanticScores(db, 'release', { projectId: P, embedder: fake });
    expect(relatedIds(scores)).toEqual([b.id]);
    expect(scores.sims.size).toBe(2); // every embedded memory gets a similarity; only related ones pass the cut
    deleteObservation(db, b.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM embeddings WHERE observationId = ?').get(b.id)).toEqual({ n: 0 });
  });

  it('falls back to keywords when the model is unavailable, and is off unless turned on', async () => {
    mem('Crash report upload', 'Crash reports upload on exit.');
    const broken: Embedder = async () => { throw new Error('model not downloaded'); };
    expect((await hybridSearch(db, { query: 'crash', projectId: P }, { embedder: broken })).map((h) => h.observation.title)).toEqual(['Crash report upload']);

    expect(embedEnabled(db)).toBe(false);
    await hybridSearch(db, { query: 'crash', projectId: P }); // off: plain keyword search, nothing embedded
    expect(db.prepare('SELECT COUNT(*) AS n FROM embeddings').get()).toEqual({ n: 0 });
    setEmbedEnabled(db, true);
    expect(embedEnabled(db)).toBe(true);
    process.env.SYNAPSE_EMBED = '0';
    expect(embedEnabled(db)).toBe(false);
  });

  it('ranks a related memory above a keyword match the model calls unrelated', async () => {
    mem('Worker crashes', 'The worker hits index out of range on an empty queue.');
    const login = mem('Login session cookie', 'Login breaks on subdomains unless the session cookie uses the parent domain.');
    const hits = await hybridSearch(db, { query: 'signed out of login', projectId: P }, { embedder: fake });
    expect(hits[0].observation.id).toBe(login.id);
  });

  it('blends: a keyword match keeps its score, meaning fills part of the gap, weak similarity adds nothing', () => {
    expect(blendSemantic(0.6, undefined)).toBe(0.6);
    expect(blendSemantic(0, 0.1)).toBe(0);
    expect(blendSemantic(0, 0.19)).toBeGreaterThan(0); // a short query's real match still counts
    expect(blendSemantic(0, 0.9)).toBeCloseTo(0.85);
    expect(blendSemantic(1, 0.9)).toBe(1);
    expect(blendSemantic(0.5, 0.5)).toBeGreaterThan(0.5);
    expect(blendSemantic(0.6, 0.05, 0.2)).toBeCloseTo(0.3); // a keyword hit the model calls unrelated loses some score
  });
});
