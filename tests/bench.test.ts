/**
 * Retrieval benchmark: reading case files, resolving memory references, generated cases, metrics, and the keyword vs
 * keyword-plus-meaning comparison (with a deterministic fake embedder).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { autoCases, formatBench, readBenchFile, resolveRef, runBench } from '../src/bench.js';
import { openDatabase, type DB } from '../src/db.js';
import type { Embedder } from '../src/embed.js';
import { listObservations, storeObservation } from '../src/store.js';

const P = 'acme/app';
let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
});

const IDEAS = [['crash', 'crashes', 'panic', 'panics'], ['login', 'auth', 'signin', 'session'], ['slow', 'latency', 'lag']];
const fake: Embedder = async (texts) => texts.map((t) => {
  const words = t.toLowerCase().match(/[a-z]+/g) ?? [];
  const v = new Float32Array(IDEAS.length + 1).map((_, i) => (i < IDEAS.length ? words.filter((w) => IDEAS[i].includes(w)).length : 0.3));
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
});
const mem = (title: string, narrative: string, extra: Record<string, unknown> = {}) =>
  storeObservation(db, { projectId: P, entityName: title.split(' ')[0].toLowerCase(), type: 'gotcha', title, narrative, ...extra }).observation;

describe('benchmark cases', () => {
  it('reads one case per line, skipping comments, and names the bad line', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'syn-bench-'));
    const file = path.join(dir, 'bench.jsonl');
    writeFileSync(file, '// comment\n\n{"query":"why slow","expect":"Slow start"}\n{"query":"q","expect":["#3","m-abcdef123456"],"kind":"symptom"}\n');
    expect(readBenchFile(file)).toEqual([{ query: 'why slow', expect: ['Slow start'] }, { query: 'q', expect: ['#3', 'm-abcdef123456'], kind: 'symptom' }]);
    writeFileSync(file, '{"query":"q"}\n');
    expect(() => readBenchFile(file)).toThrow(/bench\.jsonl:1: needs "query"/);
    writeFileSync(file, 'nope\n');
    expect(() => readBenchFile(file)).toThrow(/:1: not valid JSON/);
  });

  it('resolves #id, uid, exact title and a unique title prefix', () => {
    const a = mem('Worker panics on empty queue', 'n');
    const b = mem('Worker pool size', 'n');
    db.prepare('UPDATE observations SET uid = ? WHERE id = ?').run('m-abcdef123456', b.id);
    const all = listObservations(db, { projectId: P });
    expect(resolveRef(all, `#${a.id}`)?.id).toBe(a.id);
    expect(resolveRef(all, 'm-abcdef123456')?.id).toBe(b.id);
    expect(resolveRef(all, 'worker pool size')?.id).toBe(b.id);
    expect(resolveRef(all, 'Worker panics')?.id).toBe(a.id);
    expect(resolveRef(all, 'Worker')).toBeUndefined(); // ambiguous prefix
    expect(resolveRef(all, '#999')).toBeUndefined();
  });

  it('generates title and detail cases from curated memories only', () => {
    const kept = mem('Worker panics on empty queue', 'The worker panics when the queue is empty at startup. Guard the first poll.');
    mem('Ran: npm test', 'auto', { source: 'hook', admissionState: 'candidate' });
    const cases = autoCases(db, P);
    expect(cases).toEqual([
      { query: 'Worker panics on empty queue', expect: [`#${kept.id}`], kind: 'title' },
      { query: 'The worker panics when the queue is empty at startup.', expect: [`#${kept.id}`], kind: 'detail' },
    ]);
  });
});

describe('runBench', () => {
  it('scores keyword search alone, and reports cases whose memories are missing', async () => {
    const slow = mem('Slow startup from eager imports', 'Startup is slow because every module is imported eagerly.');
    mem('Login cookie domain', 'The session cookie needs the parent domain.');
    const r = await runBench(db, P, [
      { query: 'slow startup', expect: [`#${slow.id}`], kind: 'keyword' },
      { query: 'app is laggy at launch', expect: ['Slow startup'], kind: 'paraphrase' },
      { query: 'gone', expect: ['No such memory'] },
    ], { k: 5, source: 'test' });
    expect(r.cases).toBe(2);
    expect(r.unresolved).toEqual([{ query: 'gone', refs: ['No such memory'] }]);
    expect(r.modes.map((m) => m.mode)).toEqual(['keyword']);
    const [kw] = r.modes;
    expect(kw.results.map((x) => x.first)).toEqual([1, null]);
    expect(kw.metrics).toMatchObject({ cases: 2, hit1: 0.5, hit3: 0.5, hitK: 0.5, recallK: 0.5, mrr: 0.5 });
    expect(kw.byKind.paraphrase.hitK).toBe(0);
    const text = formatBench(r);
    expect(text).toContain('2 queries from test, top 5');
    expect(text).toMatch(/keyword\s+50%\s+50%\s+50%\s+50%\s+0\.50/);
    expect(text).toContain('"app is laggy at launch"');
    expect(text).toContain('1 case named memories that were not found');
  });

  it('compares keyword with keyword plus meaning when an embedder is available', async () => {
    const panic = mem('Worker panics on empty queue', 'The worker panics when the queue is empty at startup.');
    mem('Login cookie domain', 'The session cookie needs the parent domain.');
    const r = await runBench(db, P, [{ query: 'app crashes', expect: [`#${panic.id}`], kind: 'symptom' }], { embedder: fake });
    expect(r.modes.map((m) => [m.mode, m.results[0].first])).toEqual([['keyword', null], ['hybrid', 1]]);
    expect(formatBench(r)).toMatch(/- \/ 1\s+"app crashes"/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM observation_access').get()).toEqual({ n: 0 }); // nothing recorded as a read
  });
});
