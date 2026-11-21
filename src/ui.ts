/**
 * `synapse ui`: a local web page for browsing and curating memory. A small node:http server on 127.0.0.1 serves one
 * page and a JSON API over the same database. Every API call needs the per-run token from the printed URL, and the
 * Host header must be local, so other websites (including DNS-rebinding tricks) can't read or change memory.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { VERSION } from './config.js';
import type { DB } from './db.js';
import { memoryDiffs } from './diff.js';
import { changesFor, staleMemories } from './freshness.js';
import { makeProjectWide } from './branch.js';
import { changeLabel, memoryHistory, restoreVersion, revisionCounts, versionChanges } from './history.js';
import { deliveryCounts, deliveryFlags, memoryDeliveries, sessionDeliveries } from './deliveries.js';
import { listLongTerm, promoteToLongTerm, reviewLongTerm, LT_KINDS, LT_SCOPES, LT_STATES } from './longterm.js';
import { hybridSearch } from './embed.js';
import { listCheckpoints, recentSessions, checkpointText } from './sessions.js';
import {
  editObservation,
  getObservation,
  listObservations,
  mergeObservations,
  listProjects,
  projectStats,
  promoteObservation,
  recordFeedback,
  setStatus,
  similarObservations,
} from './store.js';
import { OBSERVATION_TYPES, type Observation, type ObservationStatus, type ProjectInfo } from './types.js';
import { buildMemoryGraph } from './ui-graph.js';
import { UI_PAGE } from './ui-page.js';
import { suggestedKind, usageReport, type MemoryUsage } from './usage.js';

export interface UiOptions {
  db: DB;
  /** The project the UI was started in: the default view, and the only one whose files can be checked for freshness. */
  project: ProjectInfo;
  port?: number;
  token?: string;
}

const STATUSES = ['active', 'resolved', 'archived', 'all'] as const;
const SOURCES = ['agent', 'hook', 'git', 'team'] as const;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function summary(o: Observation, changes?: { file: string; change: string }[]) {
  return {
    id: o.id, type: o.type, entity: o.entityName, title: o.title, status: o.status, source: o.source, admission: o.admissionState,
    createdAt: o.createdAt, updatedAt: o.updatedAt, files: o.filesModified, sessionId: o.sessionId, tokens: o.tokens, changes: changes ?? [],
    branch: o.branch ?? null,
  };
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new HttpError(413, 'Request too large');
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

const strList = (v: unknown, name: string): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new HttpError(400, `${name} must be a list of strings`);
  return v as string[];
};
const optStr = (v: unknown, name: string): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new HttpError(400, `${name} must be a string`);
  return v;
};

const int = (v: unknown, name: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} must be a positive integer`);
  return n;
};

export function createUiServer(opts: UiOptions): { server: Server; token: string } {
  const { db, project } = opts;
  const token = opts.token ?? randomBytes(18).toString('base64url');
  const tokenBuf = Buffer.from(token);
  const authorized = (given: string | null | undefined) => {
    const b = Buffer.from(given ?? '');
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };
  const changesOf = (projectId: string, obs: Observation[]) =>
    projectId === project.id ? changesFor(project.rootPath, project.id, obs) : new Map<number, { file: string; change: string }[]>();
  const projectParam = (u: URL) => u.searchParams.get('project') || project.id;

  const get: Record<string, (u: URL) => unknown> = {
    '/api/state': () => ({
      version: VERSION,
      current: project.id,
      root: project.rootPath,
      projects: listProjects(db),
      types: OBSERVATION_TYPES,
      ltStates: LT_STATES,
    }),
    '/api/stats': (u) => {
      const p = projectParam(u);
      const stats = projectStats(db, p);
      const candidates = Number((db.prepare("SELECT COUNT(*) AS n FROM observations WHERE projectId = ? AND status = 'active' AND admissionState = 'candidate'").get(p) as { n: number }).n);
      const sessions = Number((db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE projectId = ?').get(p) as { n: number }).n);
      return { ...stats, candidates, sessions, stale: p === project.id ? staleMemories(db, project, 500).length : null };
    },
    '/api/memories': async (u) => {
      const p = projectParam(u);
      const q = (u.searchParams.get('q') ?? '').trim();
      const status = (STATUSES as readonly string[]).includes(u.searchParams.get('status') ?? '') ? (u.searchParams.get('status') as ObservationStatus | 'all') : 'active';
      const type = u.searchParams.get('type');
      const types = type && (OBSERVATION_TYPES as readonly string[]).includes(type) ? [type] : undefined;
      const source = u.searchParams.get('source');
      const admission = u.searchParams.get('admission');
      const limit = Math.min(Number(u.searchParams.get('limit')) || 100, 300);
      // Fetch without the type filter so the page can show a count per type, then apply it.
      let obs = q
        ? (await hybridSearch(db, { query: q, projectId: p, status, limit: 300 })).map((h) => h.observation)
        : listObservations(db, { projectId: p, status, limit: 1000 });
      if (source && (SOURCES as readonly string[]).includes(source)) obs = obs.filter((o) => o.source === source);
      if (admission === 'candidate' || admission === 'qualified') obs = obs.filter((o) => o.admissionState === admission);
      if (u.searchParams.get('changed') === '1') {
        const stale = new Set(p === project.id ? staleMemories(db, project, 1000).map((s) => s.observation.id) : []);
        obs = obs.filter((o) => stale.has(o.id));
      }
      const byType: Record<string, number> = {};
      for (const o of obs) byType[o.type] = (byType[o.type] ?? 0) + 1;
      if (types) obs = obs.filter((o) => types.includes(o.type));
      const total = obs.length;
      obs = obs.slice(0, limit);
      const changes = changesOf(p, obs);
      return { total, byType, items: obs.map((o) => summary(o, changes.get(o.id))) };
    },
    '/api/memory': (u) => {
      const o = getObservation(db, int(u.searchParams.get('id'), 'id'));
      if (!o) throw new HttpError(404, 'Memory not found');
      const access = db.prepare('SELECT accessCount, lastAccessed FROM observation_access WHERE observationId = ?').get(o.id) as { accessCount: number; lastAccessed: string } | undefined;
      const feedback = db.prepare('SELECT signal, note, createdAt FROM feedback WHERE observationId = ? ORDER BY id DESC LIMIT 20').all(o.id);
      const replacedBy = o.supersededBy ? getObservation(db, o.supersededBy) : undefined;
      const replaces = (db.prepare('SELECT id, title FROM observations WHERE supersededBy = ? ORDER BY id').all(o.id) as { id: number; title: string }[]);
      return {
        ...summary(o, changesOf(o.projectId, [o]).get(o.id)),
        projectId: o.projectId, narrative: o.narrative, facts: o.facts, concepts: o.concepts, topicKey: o.topicKey,
        revisionCount: o.revisionCount, commitHash: o.commitHash, relatedCommits: o.relatedCommits, relatedEntities: o.relatedEntities,
        progress: o.progress, valueCategory: o.valueCategory, access: access ?? null, feedback, uid: o.uid ?? null,
        replacedBy: replacedBy ? { id: replacedBy.id, title: replacedBy.title } : null, replaces,
        versions: revisionCounts(db, [o.id]).get(o.id) ?? 0,
        shownTo: memoryDeliveries(db, o.id, 20).map((d) => ({
          sessionId: d.sessionId, agent: d.agent, channel: d.channel, query: d.query, rank: d.rank, createdAt: d.createdAt, flags: deliveryFlags(d),
        })),
      };
    },
    '/api/sessions': (u) => {
      const p = projectParam(u);
      const sessions = recentSessions(db, p, 60, false);
      const shown = deliveryCounts(db, sessions.map((s) => s.id));
      return sessions.map((s) => {
        const cps = listCheckpoints(db, p, { sessionId: s.id, limit: 20 });
        const count = Number((db.prepare('SELECT COUNT(*) AS n FROM observations WHERE sessionId = ?').get(s.id) as { n: number }).n);
        return { ...s, memories: count, shown: shown.get(s.id) ?? 0, checkpoints: cps.map((c) => ({ id: c.id, createdAt: c.createdAt, text: checkpointText(c) })) };
      });
    },
    '/api/session': (u) => {
      const id = u.searchParams.get('id') ?? '';
      const items = (db.prepare('SELECT id FROM observations WHERE sessionId = ? ORDER BY id').all(id) as { id: number }[])
        .map((r) => getObservation(db, Number(r.id))!)
        .map((o) => summary(o));
      return { items, shown: sessionDeliveries(db, id).map((e) => ({ ...e, items: e.items.map((d) => ({ ...d, flags: deliveryFlags(d) })) })) };
    },
    '/api/graph': (u) => {
      const p = projectParam(u);
      const status = (STATUSES as readonly string[]).includes(u.searchParams.get('status') ?? '') ? (u.searchParams.get('status') as ObservationStatus | 'all') : 'active';
      const limit = Math.min(Number(u.searchParams.get('limit')) || 400, 1000);
      // One extra row tells the page the map was cut to the most recent memories.
      const obs = listObservations(db, { projectId: p, status, includeCandidates: u.searchParams.get('candidates') === '1', limit: limit + 1 });
      const shown = obs.slice(0, limit);
      const graph = buildMemoryGraph(shown, { files: u.searchParams.get('files') !== '0', concepts: u.searchParams.get('concepts') === '1' });
      const changes = changesOf(p, shown);
      return { ...graph, truncated: obs.length > limit, memories: shown.map((o) => summary(o, changes.get(o.id))) };
    },
    '/api/memory/history': (u) => {
      const versions = memoryHistory(db, int(u.searchParams.get('id'), 'id'));
      if (!versions) throw new HttpError(404, 'Memory not found');
      // Each earlier version with what the change that replaced it did (compared with the next newer version).
      return { versions: versions.map((v, i) => ({ ...v, changeLabel: v.change ? changeLabel(v.change) : null, next: i > 0 ? versionChanges(v, versions[i - 1]) : null })) };
    },
    '/api/memory/diff': (u) => {
      const o = getObservation(db, int(u.searchParams.get('id'), 'id'));
      if (!o) throw new HttpError(404, 'Memory not found');
      // Only the project synapse ui was started in has a known folder to diff.
      if (o.projectId !== project.id) return { files: [], note: `Diffs are only available for ${project.id}, the project synapse ui was started in.` };
      const verified = db.prepare("SELECT MAX(createdAt) AS at FROM feedback WHERE observationId = ? AND signal = 'verified'").get(o.id) as { at: string | null };
      return { files: memoryDiffs(project.rootPath, o, verified.at ?? undefined) };
    },
    '/api/usage': (u) => {
      const days = [7, 30, 90].includes(Number(u.searchParams.get('days'))) ? Number(u.searchParams.get('days')) : 30;
      const r = usageReport(db, projectParam(u), { days });
      const row = (x: MemoryUsage) => ({ ...summary(x.observation), reads: x.reads, lastRead: x.lastRead ?? null, helpful: x.helpful, negative: x.negative,
        ageDays: x.ageDays, longTerm: x.longTerm ?? null, promote: x.promote, kind: suggestedKind(x.observation.type) });
      return { days: r.days, totals: r.totals, often: r.often.map(row), notRead: r.notRead.map(row), notReadYet: r.notReadYet.map(row), ratedWrong: r.ratedWrong.map(row) };
    },
    '/api/memory/similar': (u) => similarObservations(db, int(u.searchParams.get('id'), 'id')).map((x) => ({ ...summary(x.observation), score: Math.round(x.score * 100) / 100 })),
    '/api/longterm': (u) => {
      const state = u.searchParams.get('state') ?? 'proposed';
      return listLongTerm(db, projectParam(u), { state: (state === 'all' || (LT_STATES as readonly string[]).includes(state) ? state : 'proposed') as never, limit: 200 });
    },
  };

  const post: Record<string, (b: Record<string, unknown>) => unknown> = {
    '/api/memory/status': (b) => {
      const status = String(b.status);
      if (!['active', 'resolved', 'archived'].includes(status)) throw new HttpError(400, 'status must be active, resolved or archived');
      const o = getObservation(db, int(b.id, 'id'));
      if (!o) throw new HttpError(404, 'Memory not found');
      setStatus(db, [o.id], status as ObservationStatus, o.projectId);
      return { ok: true };
    },
    '/api/memory/qualify': (b) => ({ ok: promoteObservation(db, int(b.id, 'id')) }),
    '/api/memory/scope': (b) => {
      const o = getObservation(db, int(b.id, 'id'));
      if (!o) throw new HttpError(404, 'Memory not found');
      if (b.scope !== 'project') throw new HttpError(400, 'scope must be "project"');
      return { ok: true, id: makeProjectWide(db, o.id).id };
    },
    '/api/memory/restore': (b) => {
      const o = getObservation(db, int(b.id, 'id'));
      if (!o) throw new HttpError(404, 'Memory not found');
      try {
        const restored = restoreVersion(db, o.id, int(b.revision, 'revision'), o.projectId === project.id ? project.rootPath : undefined);
        return { ok: true, id: restored.id, revision: restored.revisionCount };
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    },
    '/api/memory/edit': (b) => {
      const o = getObservation(db, int(b.id, 'id'));
      if (!o) throw new HttpError(404, 'Memory not found');
      try {
        const edited = editObservation(db, o.id, {
          title: optStr(b.title, 'title'), narrative: optStr(b.narrative, 'narrative'), type: optStr(b.type, 'type'), entityName: optStr(b.entity, 'entity'),
          facts: strList(b.facts, 'facts'), filesModified: strList(b.files, 'files'), concepts: strList(b.concepts, 'concepts'), qualify: b.qualify === true,
        }, o.projectId === project.id ? project.rootPath : undefined);
        return { ok: true, id: edited.id };
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    },
    '/api/memory/promote': (b) => {
      const o = getObservation(db, int(b.id, 'id'));
      if (!o) throw new HttpError(404, 'Memory not found');
      const kind = String(b.kind ?? suggestedKind(o.type));
      const scope = String(b.scope ?? 'project');
      if (!(LT_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind must be one of ${LT_KINDS.join(', ')}`);
      if (!(LT_SCOPES as readonly string[]).includes(scope)) throw new HttpError(400, `scope must be one of ${LT_SCOPES.join(', ')}`);
      const r = promoteToLongTerm(db, o.projectId, o.id, { kind: kind as never, scope: scope as never, proposedBy: 'synapse ui' });
      return { ok: true, id: r.item.id, state: r.item.state, action: r.action };
    },
    '/api/memory/merge': (b) => {
      const from = Array.isArray(b.from) ? b.from.map((x) => int(x, 'from')) : [];
      try {
        return { ok: true, id: mergeObservations(db, int(b.into, 'into'), from).id };
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    },
    '/api/memory/feedback': (b) => {
      const signal = String(b.signal);
      if (!['helpful', 'verified', 'outdated'].includes(signal)) throw new HttpError(400, 'signal must be helpful, verified or outdated');
      const o = getObservation(db, int(b.id, 'id'));
      if (!o) throw new HttpError(404, 'Memory not found');
      recordFeedback(db, o.id, signal as 'helpful', undefined, o.projectId === project.id ? project.rootPath : undefined);
      return { ok: true };
    },
    '/api/longterm/review': (b) => {
      const action = String(b.action);
      if (action !== 'approve' && action !== 'archive') throw new HttpError(400, 'action must be approve or archive');
      const reason = String(b.reason ?? '').trim();
      if (!reason) throw new HttpError(400, 'A reason is required');
      try {
        return reviewLongTerm(db, String(b.project || project.id), int(b.id, 'id'), action, `${reason} (via synapse ui)`);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    },
  };

  const send = (res: ServerResponse, status: number, data: unknown, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...(type.startsWith('text/html')
        ? { 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }
        : {}),
    });
    res.end(typeof data === 'string' ? data : JSON.stringify(data));
  };

  const server = createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new HttpError(403, 'Synapse UI only answers on localhost');
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && u.pathname === '/') return send(res, 200, UI_PAGE, 'text/html; charset=utf-8');
      if (!u.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
      if (!authorized(req.headers['x-synapse-token'] as string | undefined)) throw new HttpError(401, 'Missing or wrong token: open the URL synapse ui printed');
      if (req.method === 'GET' && get[u.pathname]) return send(res, 200, await get[u.pathname](u));
      if (req.method === 'POST' && post[u.pathname]) {
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Send JSON');
        return send(res, 200, post[u.pathname](await body(req)));
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      send(res, status, { error: e instanceof HttpError ? e.message : 'Internal error' });
      if (!(e instanceof HttpError) && process.env.SYNAPSE_DEBUG) process.stderr.write(`[synapse ui] ${(e as Error).stack}\n`);
    }
  });
  return { server, token };
}

/** Start the UI and resolve with its URL once listening. */
export function startUi(opts: UiOptions): Promise<{ url: string; server: Server }> {
  const { server, token } = createUiServer(opts);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({ url: `http://127.0.0.1:${port}/#t=${token}`, server });
    });
  });
}
