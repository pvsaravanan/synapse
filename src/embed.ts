/**
 * Meaning-based search with a small sentence-embedding model run in-process (transformers.js, ONNX), so "crash" finds a
 * memory that says "panic". Keyword search (FTS5) stays the default and the fallback; embeddings only add to it.
 *
 *   - Opt-in: `synapse embed` turns it on (a meta flag) and downloads the model once (about 23 MB, all-MiniLM-L6-v2)
 *     into $SYNAPSE_HOME/models. Searches never download anything: with the model missing they fall back to keywords.
 *     SYNAPSE_EMBED=0 forces it off, SYNAPSE_EMBED=1 on.
 *   - Optional dependency: @huggingface/transformers is an optionalDependency, loaded lazily. If it isn't installed
 *     (or its native runtime fails to load), search is keyword-only and nothing else changes.
 *   - Vectors are stored per memory (embeddings table) with a hash of the embedded text and the model name, and are
 *     refreshed lazily before a search when a memory is new or its text changed.
 *   - Hooks never load the model (session-start briefs stay keyword-only, so starting a session stays fast); the MCP
 *     server, the CLI and synapse ui use it for searches.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { synapseHome } from './config.js';
import { getMeta, setMeta, type DB } from './db.js';
import { search } from './search.js';
import type { Observation, SearchHit, SearchOptions, SemanticScores } from './types.js';

export const DEFAULT_EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
const META_ENABLED = 'embed:enabled';
/**
 * A memory counts as related when its cosine similarity is at least MIN_SIMILARITY and at least RELATIVE_TO_BEST of the
 * best match for that query. Measured with all-MiniLM-L6-v2: related pairs scored 0.19-0.48 (short queries like "crash"
 * score low in absolute terms), unrelated ones up to 0.17, and queries with nothing related stay below 0.1.
 */
export const MIN_SIMILARITY = 0.15;
export const RELATIVE_TO_BEST = 0.6;
const BATCH = 32;

export type Embedder = (texts: string[]) => Promise<Float32Array[]>;

export const embedModel = () => process.env.SYNAPSE_EMBED_MODEL || DEFAULT_EMBED_MODEL;
export const modelsDir = () => path.join(synapseHome(), 'models');

/** On when SYNAPSE_EMBED=1, off when SYNAPSE_EMBED=0, otherwise whatever `synapse embed` / `--off` last set. */
export function embedEnabled(db: DB): boolean {
  const env = (process.env.SYNAPSE_EMBED ?? '').toLowerCase();
  if (/^(1|true|yes|on)$/.test(env)) return true;
  if (/^(0|false|no|off)$/.test(env)) return false;
  return getMeta(db, META_ENABLED) === '1';
}

export function setEmbedEnabled(db: DB, on: boolean): void {
  setMeta(db, META_ENABLED, on ? '1' : '0');
}

/** Whether the model's files are already in the local cache (no download needed). */
export function modelCached(model = embedModel()): boolean {
  return existsSync(path.join(modelsDir(), ...model.split('/')));
}

let injected: Embedder | undefined;
const pipelines = new Map<string, Promise<Embedder>>();

/** Tests replace the model with a deterministic function. */
export function setEmbedder(fn: Embedder | undefined): void {
  injected = fn;
}

/**
 * The embedder for the current model. `allowDownload` is only set by `synapse embed`; everywhere else a model that
 * isn't cached yet is an error (and search falls back to keywords) rather than a network request.
 */
export function getEmbedder(allowDownload = false): Promise<Embedder> {
  if (injected) return Promise.resolve(injected);
  const model = embedModel();
  const key = `${model}:${allowDownload}`;
  let p = pipelines.get(key);
  if (!p) {
    p = (async () => {
      // A variable specifier keeps the optional dependency out of the type-check and the startup path.
      const spec = '@huggingface/transformers';
      let t: any;
      try {
        t = await import(spec);
      } catch (e) {
        throw new Error(`The embedding runtime (${spec}) isn't available: ${(e as Error).message.split('\n')[0]}. Reinstall Synapse with optional dependencies.`);
      }
      t.env.cacheDir = modelsDir();
      t.env.localModelPath = modelsDir();
      t.env.allowRemoteModels = allowDownload;
      t.env.allowLocalModels = true;
      const extract = await t.pipeline('feature-extraction', model, { dtype: 'q8' });
      return async (texts: string[]) => {
        const out = await extract(texts, { pooling: 'mean', normalize: true });
        const [n, dim] = out.dims as number[];
        const data = out.data as Float32Array;
        return Array.from({ length: n }, (_, i) => data.slice(i * dim, (i + 1) * dim));
      };
    })();
    p.catch(() => pipelines.delete(key)); // a failed load (no model yet) can be retried after `synapse embed`
    pipelines.set(key, p);
  }
  return p;
}

/** The text a memory is embedded from: what it is about, in a few hundred words at most. */
export function embedText(o: Pick<Observation, 'title' | 'narrative' | 'facts' | 'entityName' | 'concepts'>): string {
  return [o.title, o.narrative, o.facts.join('. '), o.entityName, o.concepts.join(' ')].filter(Boolean).join('\n').slice(0, 2000);
}

const textHash = (t: string) => createHash('sha1').update(t).digest('hex').slice(0, 16);
const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/**
 * Embed a project's memories that have no vector for the current model, or whose text changed. Returns how many were
 * embedded. `limit` caps one call, so a search after a large import stays responsive (the rest catch up next time).
 */
export async function ensureEmbeddings(db: DB, projectId: string, opts: { limit?: number; embedder?: Embedder; status?: 'active' | 'all' } = {}): Promise<number> {
  const model = embedModel();
  const rows = db
    .prepare(
      `SELECT o.id, o.title, o.narrative, o.facts, o.entityName, o.concepts, e.hash, e.model FROM observations o
       LEFT JOIN embeddings e ON e.observationId = o.id
       WHERE o.projectId = ? ${opts.status === 'all' ? '' : "AND o.status = 'active'"}`,
    )
    .all(projectId) as { id: number; title: string; narrative: string; facts: string; entityName: string; concepts: string; hash: string | null; model: string | null }[];
  const todo = rows
    .map((r) => ({ id: Number(r.id), text: embedText({ title: r.title, narrative: r.narrative, facts: JSON.parse(r.facts), entityName: r.entityName, concepts: JSON.parse(r.concepts) }), r }))
    .filter((x) => x.r.model !== model || x.r.hash !== textHash(x.text))
    .slice(0, opts.limit ?? 2000);
  if (todo.length === 0) return 0;
  const embed = opts.embedder ?? (await getEmbedder());
  const save = db.prepare(
    `INSERT INTO embeddings(observationId, model, hash, vector) VALUES(?,?,?,?)
     ON CONFLICT(observationId) DO UPDATE SET model = excluded.model, hash = excluded.hash, vector = excluded.vector`,
  );
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const vectors = await embed(batch.map((x) => x.text));
    batch.forEach((x, j) => save.run(x.id, model, textHash(x.text), toBlob(vectors[j])));
  }
  return todo.length;
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i];
  return s;
};

/**
 * The query's cosine similarity to each embedded memory (vectors are normalized), and the cut for "related": at least
 * MIN_SIMILARITY and RELATIVE_TO_BEST of the best match.
 */
export async function semanticScores(db: DB, query: string, opts: { projectId?: string; embedder?: Embedder } = {}): Promise<SemanticScores> {
  const embed = opts.embedder ?? (await getEmbedder());
  const [q] = await embed([query]);
  const rows = db
    .prepare(`SELECT e.observationId AS id, e.vector FROM embeddings e JOIN observations o ON o.id = e.observationId WHERE e.model = ? ${opts.projectId ? 'AND o.projectId = ?' : ''}`)
    .all(...(opts.projectId ? [embedModel(), opts.projectId] : [embedModel()])) as { id: number; vector: Uint8Array }[];
  const sims = new Map(rows.map((r) => [Number(r.id), dot(q, fromBlob(r.vector))] as const));
  const best = Math.max(0, ...sims.values());
  return { sims, cut: Math.max(MIN_SIMILARITY, best * RELATIVE_TO_BEST) };
}

/** Ids of the memories that count as related to the query. */
export function relatedIds(s: SemanticScores): number[] {
  return [...s.sims].filter(([, v]) => v >= s.cut).map(([id]) => id);
}

/**
 * Search with keywords and, when embeddings are on, meaning. Falls back to keyword search on any embedding problem
 * (runtime missing, model not downloaded), so search never breaks because of it.
 */
export async function hybridSearch(db: DB, opts: SearchOptions, deps: { embedder?: Embedder } = {}): Promise<SearchHit[]> {
  if (!opts.query.trim() || !(deps.embedder || embedEnabled(db))) return search(db, opts);
  try {
    if (opts.projectId) await ensureEmbeddings(db, opts.projectId, { embedder: deps.embedder, limit: 500 });
    const semantic = await semanticScores(db, opts.query, { projectId: opts.projectId, embedder: deps.embedder });
    return search(db, { ...opts, semantic });
  } catch (e) {
    if (process.env.SYNAPSE_DEBUG) process.stderr.write(`[synapse embed] ${(e as Error).message}\n`);
    return search(db, opts);
  }
}

/** For `synapse embed --status`: how many of a project's active memories have a current vector. */
export function embeddingCoverage(db: DB, projectId: string): { memories: number; embedded: number } {
  const memories = Number((db.prepare("SELECT COUNT(*) AS n FROM observations WHERE projectId = ? AND status = 'active'").get(projectId) as { n: number }).n);
  const embedded = Number((db
    .prepare("SELECT COUNT(*) AS n FROM embeddings e JOIN observations o ON o.id = e.observationId WHERE o.projectId = ? AND o.status = 'active' AND e.model = ?")
    .get(projectId, embedModel()) as { n: number }).n);
  return { memories, embedded };
}
