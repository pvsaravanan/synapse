/**
 * Retrieval benchmark: how often search puts the right memory near the top, measured on a project's own memories.
 *
 * A case is a query an agent might ask plus the memories that answer it. Cases come from a file (one JSON object per
 * line, `.synapse/bench.jsonl` by default, so a team can keep and grow one in the repo) or are generated from the
 * curated memories (`--auto`: each memory's title, and a detail from its text). Generated cases mostly share words
 * with their target, so they measure keyword search's floor; hand-written paraphrases are what tell keyword and
 * meaning-based search apart.
 *
 * Every case runs through the same search the agent uses (active memories of the project, auto-captured candidates
 * included and penalised), keyword-only and, when an embedder is available, keyword plus meaning. Nothing is
 * recorded as a read.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { DB } from './db.js';
import { ensureEmbeddings, semanticScores, type Embedder } from './embed.js';
import { search } from './search.js';
import { listObservations } from './store.js';
import type { Observation } from './types.js';

export interface BenchCase {
  query: string;
  /** Memories that answer the query: `#<id>`, a team uid (`m-…`), or a title (exact, or a unique prefix). */
  expect: string[];
  /** Free label for grouping results, e.g. "paraphrase", "symptom", "title". */
  kind?: string;
}

export interface CaseResult {
  query: string;
  kind: string;
  expected: { id: number; title: string }[];
  /** 1-based rank of each expected memory in the results, or null when it is not in the top k. */
  ranks: (number | null)[];
  /** Rank of the best-placed expected memory. */
  first: number | null;
  top: { id: number; title: string }[];
}

export interface Metrics {
  cases: number;
  /** Share of cases with an expected memory at rank 1, in the top 3, in the top k. */
  hit1: number;
  hit3: number;
  hitK: number;
  /** Mean share of each case's expected memories found in the top k. */
  recallK: number;
  /** Mean reciprocal rank of the first expected memory (0 when none is in the top k). */
  mrr: number;
}

export type BenchMode = 'keyword' | 'hybrid';

export interface ModeReport {
  mode: BenchMode;
  metrics: Metrics;
  byKind: Record<string, Metrics>;
  results: CaseResult[];
}

export interface BenchReport {
  projectId: string;
  source: string;
  k: number;
  cases: number;
  /** Cases skipped because none of their expected memories could be found, with the references that failed. */
  unresolved: { query: string; refs: string[] }[];
  modes: ModeReport[];
}

/** Parse a bench file: one JSON object per line; blank lines and lines starting with `//` or `#` are skipped. */
export function readBenchFile(file: string): BenchCase[] {
  if (!existsSync(file)) throw new Error(`No benchmark file at ${file}`);
  const cases: BenchCase[] = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('#')) return;
    let c: Partial<BenchCase>;
    try {
      c = JSON.parse(t);
    } catch {
      throw new Error(`${file}:${i + 1}: not valid JSON`);
    }
    const expect = typeof c.expect === 'string' ? [c.expect] : c.expect;
    if (typeof c.query !== 'string' || !c.query.trim() || !Array.isArray(expect) || !expect.length || !expect.every((e) => typeof e === 'string')) {
      throw new Error(`${file}:${i + 1}: needs "query" (text) and "expect" (a memory reference or a list of them)`);
    }
    cases.push({ query: c.query, expect, ...(typeof c.kind === 'string' ? { kind: c.kind } : {}) });
  });
  return cases;
}

/** A case reference to a memory id: `#12`, a team uid, an exact title, or a title prefix only one memory has. */
export function resolveRef(memories: Observation[], ref: string): Observation | undefined {
  const r = ref.trim();
  const id = r.match(/^#(\d+)$/);
  if (id) return memories.find((o) => o.id === Number(id[1]));
  const byUid = memories.find((o) => o.uid === r);
  if (byUid) return byUid;
  const lower = r.toLowerCase();
  const exact = memories.filter((o) => o.title.toLowerCase() === lower);
  if (exact.length) return exact[0];
  const prefix = memories.filter((o) => o.title.toLowerCase().startsWith(lower));
  return prefix.length === 1 ? prefix[0] : undefined;
}

const curated = (o: Observation) => o.admissionState !== 'candidate' && o.source !== 'git' && o.type !== 'session-request';

/** The first sentence of the text that is not just the title again, clipped to about 20 words. */
function detailQuery(o: Observation): string | undefined {
  const title = o.title.toLowerCase();
  const sentences = [...o.facts, ...o.narrative.replace(/^Decision:\s*/i, '').split(/(?<=[.!?])\s+(?=[A-Z(])/)]
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.split(' ').length >= 5 && !title.includes(s.toLowerCase().slice(0, 40)));
  const s = sentences[0];
  if (!s) return undefined;
  const words = s.split(' ');
  return words.length > 20 ? words.slice(0, 20).join(' ') : s;
}

/** Known-item cases from a project's curated memories: its title, and a detail from its text. */
export function autoCases(db: DB, projectId: string, max = 50): BenchCase[] {
  const memories = listObservations(db, { projectId, status: 'active', limit: 2000 }).filter(curated).slice(0, max);
  return memories.flatMap((o) => {
    const ref = `#${o.id}`;
    const detail = detailQuery(o);
    return [{ query: o.title, expect: [ref], kind: 'title' }, ...(detail ? [{ query: detail, expect: [ref], kind: 'detail' }] : [])];
  });
}

function metrics(results: CaseResult[], k: number): Metrics {
  const n = results.length || 1;
  const share = (f: (r: CaseResult) => boolean) => results.filter(f).length / n;
  return {
    cases: results.length,
    hit1: share((r) => r.first === 1),
    hit3: share((r) => r.first !== null && r.first <= 3),
    hitK: share((r) => r.first !== null && r.first <= k),
    recallK: results.reduce((s, r) => s + r.ranks.filter((x) => x !== null).length / r.ranks.length, 0) / n,
    mrr: results.reduce((s, r) => s + (r.first ? 1 / r.first : 0), 0) / n,
  };
}

/**
 * Run the cases against a project's memories. Keyword search always runs; keyword plus meaning runs when an
 * embedder is passed (it embeds any memories that lack a vector first).
 */
export async function runBench(db: DB, projectId: string, cases: BenchCase[], opts: { k?: number; embedder?: Embedder; source?: string } = {}): Promise<BenchReport> {
  const k = opts.k ?? 10;
  const memories = listObservations(db, { projectId, status: 'active', limit: 100_000 });
  const unresolved: BenchReport['unresolved'] = [];
  const resolved = cases.flatMap((c) => {
    const found = c.expect.map((ref) => ({ ref, o: resolveRef(memories, ref) }));
    const missing = found.filter((f) => !f.o).map((f) => f.ref);
    if (missing.length) unresolved.push({ query: c.query, refs: missing });
    const expected = [...new Map(found.filter((f) => f.o).map((f) => [f.o!.id, { id: f.o!.id, title: f.o!.title }])).values()];
    return expected.length ? [{ query: c.query, kind: c.kind ?? 'unlabelled', expected }] : [];
  });

  const modes: BenchMode[] = opts.embedder ? ['keyword', 'hybrid'] : ['keyword'];
  if (opts.embedder) await ensureEmbeddings(db, projectId, { embedder: opts.embedder, limit: 100_000 });
  const reports: ModeReport[] = [];
  for (const mode of modes) {
    const results: CaseResult[] = [];
    for (const c of resolved) {
      const semantic = mode === 'hybrid' ? await semanticScores(db, c.query, { projectId, embedder: opts.embedder }) : undefined;
      const hits = search(db, { query: c.query, projectId, limit: k, semantic });
      const ids = hits.map((h) => h.observation.id);
      const ranks = c.expected.map((e) => (ids.includes(e.id) ? ids.indexOf(e.id) + 1 : null));
      const placed = ranks.filter((r): r is number => r !== null);
      results.push({ ...c, ranks, first: placed.length ? Math.min(...placed) : null, top: hits.slice(0, 3).map((h) => ({ id: h.observation.id, title: h.observation.title })) });
    }
    const kinds = [...new Set(results.map((r) => r.kind))];
    reports.push({ mode, metrics: metrics(results, k), byKind: Object.fromEntries(kinds.map((kind) => [kind, metrics(results.filter((r) => r.kind === kind), k)])), results });
  }
  return { projectId, source: opts.source ?? 'cases', k, cases: resolved.length, unresolved, modes: reports };
}

const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(5);
const MODE_LABEL: Record<BenchMode, string> = { keyword: 'keyword', hybrid: 'keyword + meaning' };
const clip = (s: string, n = 70) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** The report as text for the terminal. */
export function formatBench(r: BenchReport, opts: { misses?: number } = {}): string {
  const out: string[] = [];
  out.push(`Retrieval benchmark: ${r.projectId}, ${r.cases} quer${r.cases === 1 ? 'y' : 'ies'} from ${r.source}, top ${r.k}`);
  if (!r.cases) {
    out.push('No case could be matched to a memory, so there is nothing to measure.');
  } else {
    out.push('');
    out.push(`${''.padEnd(20)}hit@1  hit@3 hit@${r.k}`.padEnd(41) + 'recall   MRR');
    for (const m of r.modes) {
      const x = m.metrics;
      out.push(`${MODE_LABEL[m.mode].padEnd(20)}${pct(x.hit1)}  ${pct(x.hit3)}  ${pct(x.hitK)}  ${pct(x.recallK)}   ${x.mrr.toFixed(2)}`);
    }
    const kinds = Object.keys(r.modes[0].byKind);
    if (kinds.length > 1) {
      out.push('');
      out.push(`By kind (hit@3${r.modes.length > 1 ? ', keyword → keyword + meaning' : ''}):`);
      for (const kind of kinds) {
        const vals = r.modes.map((m) => pct(m.byKind[kind].hit3).trim()).join(' → ');
        out.push(`  ${kind.padEnd(16)}${vals.padEnd(14)}(${r.modes[0].byKind[kind].cases})`);
      }
    }
    const last = r.modes[r.modes.length - 1];
    const misses = last.results
      .map((res, i) => ({ res, ranks: r.modes.map((m) => m.results[i].first) }))
      .filter((x) => x.ranks.some((rank) => rank === null || rank > 3));
    if (misses.length) {
      out.push('');
      out.push(`Not in the top 3 (rank of the first expected memory${r.modes.length > 1 ? ', keyword / keyword + meaning' : ''}; - = not in the top ${r.k}):`);
      for (const { res, ranks } of misses.slice(0, opts.misses ?? 15)) {
        // The top result of the mode that placed it worst: what crowded the expected memory out.
        const worst = ranks.reduce<number>((w, x, i) => ((x ?? Infinity) > (ranks[w] ?? Infinity) ? i : w), 0);
        const top = r.modes[worst].results[last.results.indexOf(res)].top[0];
        out.push(`  ${ranks.map((x) => (x === null ? '-' : String(x))).join(' / ').padEnd(8)}"${clip(res.query, 60)}"`);
        out.push(`  ${''.padEnd(8)}wants #${res.expected[0].id} ${clip(res.expected[0].title, 50)}${top ? `; ${r.modes.length > 1 ? `${MODE_LABEL[r.modes[worst].mode]} ` : ''}ranked first #${top.id} ${clip(top.title, 40)}` : '; no results'}`);
      }
      if (misses.length > (opts.misses ?? 15)) out.push(`  … and ${misses.length - (opts.misses ?? 15)} more (--json lists every case)`);
    }
  }
  if (r.unresolved.length) {
    out.push('');
    out.push(`${r.unresolved.length} case${r.unresolved.length === 1 ? '' : 's'} named memories that were not found (edited, resolved or another project?):`);
    for (const u of r.unresolved.slice(0, 10)) out.push(`  "${clip(u.query, 50)}": ${u.refs.map((x) => clip(x, 50)).join(', ')}`);
  }
  return out.join('\n');
}
