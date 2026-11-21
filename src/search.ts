import type { DB } from './db.js';
import { relevance } from './retention.js';
import { branchClause, getObservations, listObservations, rowToObservation, scoringContexts, visibleOn } from './store.js';
import type { Observation, SearchHit, SearchOptions } from './types.js';

/** Small domain synonym table so "bug" also finds "fix"/"error" memories. */
const SYNONYMS: Record<string, string[]> = {
  bug: ['fix', 'error', 'issue'],
  error: ['bug', 'exception', 'failure'],
  fix: ['bug', 'workaround', 'patch'],
  auth: ['authentication', 'login', 'oauth', 'token'],
  login: ['auth', 'authentication', 'signin'],
  db: ['database', 'sql', 'sqlite', 'postgres'],
  database: ['db', 'sql', 'schema'],
  config: ['configuration', 'settings', 'env'],
  test: ['tests', 'spec', 'vitest', 'jest'],
  deploy: ['release', 'ci', 'pipeline'],
  perf: ['performance', 'latency', 'slow', 'cache'],
  slow: ['performance', 'latency', 'perf'],
  why: ['decision', 'rationale', 'reason'],
  problem: ['issue', 'error', 'bug', 'fail'],
  issue: ['problem', 'bug', 'error'],
};

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'with', 'how', 'what', 'did', 'we', 'i', 'it', 'this', 'that']);

export function queryTokens(query: string): string[] {
  const raw = query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(raw.filter((t) => !STOP.has(t)))].slice(0, 32);
}

/** Build a safe FTS5 MATCH expression: every token quoted; long tokens prefix-matched; synonyms OR-ed in. */
export function buildFtsQuery(query: string): string | null {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return null;
  const terms = new Set<string>();
  for (const t of tokens) {
    const q = `"${t.replace(/"/g, '""')}"`;
    terms.add(t.length >= 4 ? `${q}*` : q);
    for (const syn of SYNONYMS[t] ?? []) terms.add(`"${syn}"`);
  }
  return [...terms].join(' OR ');
}

/**
 * Share of query tokens a memory actually contains (exact, prefix for 4+ chars, or synonym).
 * BM25's IDF collapses toward zero in small stores, where common terms appear in most
 * documents; coverage keeps ranking meaningful until the corpus is large enough.
 */
export function queryCoverage(tokens: string[], o: Observation): number {
  if (tokens.length === 0) return 0;
  const text = `${o.entityName} ${o.title} ${o.narrative} ${o.facts.join(' ')} ${o.filesModified.join(' ')} ${o.concepts.join(' ')}`;
  const words = new Set(text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  const has = (t: string) => words.has(t) || (t.length >= 4 && [...words].some((w) => w.startsWith(t)));
  // Synonyms prefix-match like query tokens do, so "problem" -> "fail" also finds "fails"/"failing".
  const matched = tokens.filter((t) => has(t) || (SYNONYMS[t] ?? []).some(has)).length;
  return matched / tokens.length;
}

const WEIGHT_BM25 = 0.5;
const WEIGHT_LEXICAL = 0.7;
const WEIGHT_RELEVANCE = 0.3;
/** Auto-captured candidates are unreviewed logs; curated memories should win comparable matches. */
const CANDIDATE_PENALTY = 0.45;
/** Cosine similarity mapped onto 0..1 (all-MiniLM-L6-v2 scored related pairs 0.19-0.48 in testing; see embed.ts). */
const SEMANTIC_FLOOR = 0.12;
const SEMANTIC_SPAN = 0.3;
/**
 * Meaning adds up to this much to the keyword score (then rescaled to 0..1), so a meaning match alone scores at most a
 * third of a full keyword match and keyword differences are never squeezed. Measured with `synapse bench`: higher
 * weights demoted exact matches, lower ones gave up paraphrase gains.
 */
const WEIGHT_SEMANTIC = 0.5;

/**
 * A keyword match the model calls unrelated ("out" in "index out of range" for "signed out") keeps this share. Not
 * less: a long memory can score under the cut for a query taken from its own text.
 */
const UNRELATED_KEYWORD = 0.75;

/**
 * Blend a keyword match with meaning. Related (cosine at or above the cut): meaning is added to the keyword score and
 * the sum rescaled, so a closer meaning breaks ties without lifting a weak keyword match level with a full one (adding
 * into the missing part, as before, did exactly that). Embedded but unrelated: the keyword score is reduced. Not
 * embedded: unchanged.
 */
export function blendSemantic(lex: number, cosine: number | undefined, cut = 0): number {
  if (cosine === undefined) return lex;
  if (cosine < cut) return lex * UNRELATED_KEYWORD;
  const s = Math.min(1, Math.max(0, (cosine - SEMANTIC_FLOOR) / SEMANTIC_SPAN));
  return (lex + WEIGHT_SEMANTIC * s) / (1 + WEIGHT_SEMANTIC);
}

export function search(db: DB, opts: SearchOptions): SearchHit[] {
  const limit = opts.limit ?? 10;
  const types = opts.type ? (Array.isArray(opts.type) ? opts.type : [opts.type]) : undefined;
  const status = opts.status ?? 'active';
  const fts = buildFtsQuery(opts.query);

  let rows: { obs: Observation; lex: number }[] = [];
  if (fts) {
    const where: string[] = ['observations_fts MATCH ?'];
    const params: (string | number)[] = [fts];
    if (opts.projectId) {
      where.push('o.projectId = ?');
      params.push(opts.projectId);
    }
    if (status !== 'all') {
      where.push('o.status = ?');
      params.push(status);
    }
    if (types?.length) {
      where.push(`o.type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
    if (opts.since) {
      where.push('COALESCE(o.updatedAt, o.createdAt) >= ?');
      params.push(opts.since);
    }
    if (opts.entityName) {
      where.push('o.entityName = ?');
      params.push(opts.entityName);
    }
    const scope = branchClause(opts.branch, 'o');
    if (scope) {
      where.push(scope.sql);
      params.push(...scope.params);
    }
    params.push(Math.max(limit * 8, 100));
    const sql = `SELECT o.*, bm25(observations_fts, 2.0, 5.0, 1.0, 2.0, 1.5, 3.0) AS rank
      FROM observations_fts JOIN observations o ON o.id = observations_fts.rowid
      WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`;
    try {
      const raw = db.prepare(sql).all(...params) as (Record<string, unknown> & { rank: number })[];
      const best = Math.max(1e-9, ...raw.map((r) => -Number(r.rank)));
      const tokens = queryTokens(opts.query);
      rows = raw.map((r) => {
        const obs = rowToObservation(r);
        const bm25 = Math.max(0, -Number(r.rank)) / best;
        return { obs, lex: WEIGHT_BM25 * bm25 + (1 - WEIGHT_BM25) * queryCoverage(tokens, obs) };
      });
    } catch {
      rows = likeFallback(db, opts, types);
    }
  } else {
    // Empty query: browse by recency and relevance.
    rows = listObservations(db, {
      projectId: opts.projectId,
      status,
      type: types,
      since: opts.since,
      entityName: opts.entityName,
      branch: opts.branch,
      limit: Math.max(limit * 8, 100),
    }).map((obs) => ({ obs, lex: 0 }));
  }

  // Memories related by meaning that keyword search missed join the pool (same filters), with no keyword score.
  const sem = opts.semantic;
  if (fts && sem) {
    const have = new Set(rows.map((r) => r.obs.id));
    const related = [...sem.sims].filter(([id, v]) => v >= sem.cut && !have.has(id)).map(([id]) => id);
    const extra = getObservations(db, related).filter((o) =>
      (!opts.projectId || o.projectId === opts.projectId) && (status === 'all' || o.status === status) && (!types?.length || types.includes(o.type))
      && (!opts.since || (o.updatedAt ?? o.createdAt) >= opts.since) && (!opts.entityName || o.entityName === opts.entityName)
      && visibleOn(db, o, opts.branch));
    rows = [...rows, ...extra.map((obs) => ({ obs, lex: 0 }))];
  }
  if (fts && sem) rows = rows.map((r) => ({ ...r, lex: blendSemantic(r.lex, sem.sims.get(r.obs.id), sem.cut) })).filter((r) => r.lex > 0);

  const ctx = scoringContexts(db, rows.map((r) => r.obs.id));
  const nowDate = new Date();
  const hits: SearchHit[] = rows.map(({ obs, lex }) => {
    // Relevance (importance x recency x reads x feedback) can reach 2 or more; bounded to 0..1 so a much-read memory
    // can't outweigh a far better keyword match. The order among memories is unchanged.
    const rel = 1 - Math.exp(-relevance(obs, ctx.get(obs.id), nowDate));
    let score = fts ? WEIGHT_LEXICAL * lex + WEIGHT_RELEVANCE * rel : rel;
    if (obs.admissionState === 'candidate') score *= CANDIDATE_PENALTY;
    return { observation: obs, score, lexical: lex, relevance: rel, ...(sem?.sims.has(obs.id) ? { semantic: sem.sims.get(obs.id) } : {}) };
  });
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

function likeFallback(db: DB, opts: SearchOptions, types?: string[]): { obs: Observation; lex: number }[] {
  const tokens = queryTokens(opts.query);
  const pool = listObservations(db, {
    projectId: opts.projectId,
    status: opts.status ?? 'active',
    type: types,
    since: opts.since,
    entityName: opts.entityName,
    branch: opts.branch,
    limit: 2000,
  });
  return pool
    .map((obs) => {
      const hay = `${obs.entityName} ${obs.title} ${obs.narrative} ${obs.facts.join(' ')} ${obs.concepts.join(' ')}`.toLowerCase();
      const matched = tokens.filter((t) => hay.includes(t)).length;
      return { obs, lex: tokens.length ? matched / tokens.length : 0 };
    })
    .filter((r) => r.lex > 0);
}
