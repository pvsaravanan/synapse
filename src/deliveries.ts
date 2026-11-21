/**
 * What each session was shown: every memory (or approved long-term item) that reached an agent, through which channel,
 * for which query, at what rank and score, and whether it was flagged as changed since stored. Reads (observation_access)
 * say how often a memory is used; this says which session saw what, so "why did the agent do that?" has an answer
 * when a stale or wrong memory misled it, and an outdated memory can be traced to the sessions it reached.
 *
 * Recording is best effort: it never fails the brief, search or hook it belongs to. Queries are redacted, and rows
 * older than SYNAPSE_AUDIT_DAYS (default 90; 0 turns recording off) are pruned when a session ends.
 */
import { randomBytes } from 'node:crypto';
import type { DB } from './db.js';
import { redactSecrets } from './secrets.js';

/** A memory's content version: its revision count, which edits raise and status changes (resolve, archive) don't. */
export const revisionOf = (o: { revisionCount?: number }) => String(o.revisionCount ?? 1);

export const DELIVERY_CHANNELS = ['brief', 'search', 'detail', 'file-note'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

/** One item shown: a memory (observationId) or an approved long-term item (longTermId). */
export interface DeliveryItem {
  observationId?: number;
  longTermId?: number;
  title: string;
  /** The memory's content version when shown (revisionOf), to tell whether it was edited afterwards. */
  revision?: string;
  /** 1-based position in what was shown. */
  rank?: number;
  score?: number;
  /** Brief section (relevant, caution, long-term) or the file a note was about. */
  section?: string;
  /** Flagged "changed since stored" when shown. */
  stale?: boolean;
}

export interface Delivery extends Required<Pick<DeliveryItem, 'title'>> {
  id: number;
  event: string;
  sessionId: string | null;
  projectId: string;
  channel: DeliveryChannel;
  query: string | null;
  observationId: number | null;
  longTermId: number | null;
  revision: string | null;
  rank: number | null;
  score: number | null;
  section: string | null;
  stale: boolean;
  createdAt: string;
}

/** A delivery joined with the memory as it is now. */
export interface DeliveryNow extends Delivery {
  /** The memory's status now (active, resolved, archived), or null when it was deleted or is a long-term item. */
  statusNow: string | null;
  /** The memory was edited after this session saw it. */
  editedSince: boolean;
  /** The memory was rated outdated or wrong (feedback) after it was shown. */
  ratedWrongSince: boolean;
}

/** One recording call: the items one brief, search, detail call or file note showed. */
export interface DeliveryEvent {
  event: string;
  sessionId: string | null;
  channel: DeliveryChannel;
  query: string | null;
  createdAt: string;
  items: DeliveryNow[];
}

const DEFAULT_DAYS = 90;

/** Days deliveries are kept; 0 means don't record. */
export function auditDays(): number {
  const raw = process.env.SYNAPSE_AUDIT_DAYS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAYS;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Record what one channel showed a session. Never throws. Returns the event id, or undefined when nothing was recorded. */
export function recordDeliveries(
  db: DB,
  d: { projectId: string; sessionId?: string; channel: DeliveryChannel; query?: string; items: DeliveryItem[] },
): string | undefined {
  if (d.items.length === 0 || auditDays() === 0) return undefined;
  try {
    const event = randomBytes(6).toString('hex');
    const createdAt = new Date().toISOString();
    const query = d.query?.trim() ? clip(redactSecrets(d.query.trim()), 300) : null;
    const stmt = db.prepare(
      `INSERT INTO deliveries (event, sessionId, projectId, channel, query, observationId, longTermId, title, revision, rank, score, section, stale, createdAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const it of d.items) {
      stmt.run(
        event, d.sessionId ?? null, d.projectId, d.channel, query, it.observationId ?? null, it.longTermId ?? null, clip(it.title, 200),
        it.revision ?? null, it.rank ?? null, it.score === undefined ? null : Math.round(it.score * 1000) / 1000, it.section ?? null,
        it.stale ? 1 : 0, createdAt,
      );
    }
    return event;
  } catch (e) {
    if (process.env.SYNAPSE_DEBUG) process.stderr.write(`[synapse audit] ${(e as Error).message}\n`);
    return undefined;
  }
}

const SELECT_NOW = `
  SELECT d.*, o.status AS statusNow, o.revisionCount AS revisionNow,
    EXISTS (SELECT 1 FROM feedback f WHERE f.observationId = d.observationId AND f.signal IN ('outdated', 'conflicted', 'corrected') AND f.createdAt > d.createdAt) AS ratedWrongSince
  FROM deliveries d LEFT JOIN observations o ON o.id = d.observationId`;

function toDelivery(r: Record<string, unknown>): DeliveryNow {
  const revisionNow = r.revisionNow == null ? null : String(r.revisionNow);
  return {
    id: Number(r.id), event: String(r.event), sessionId: (r.sessionId as string | null) ?? null, projectId: String(r.projectId),
    channel: r.channel as DeliveryChannel, query: (r.query as string | null) ?? null,
    observationId: r.observationId == null ? null : Number(r.observationId), longTermId: r.longTermId == null ? null : Number(r.longTermId),
    title: String(r.title), revision: (r.revision as string | null) ?? null, rank: r.rank == null ? null : Number(r.rank),
    score: r.score == null ? null : Number(r.score), section: (r.section as string | null) ?? null, stale: Boolean(r.stale), createdAt: String(r.createdAt),
    statusNow: (r.statusNow as string | null) ?? null,
    editedSince: Boolean(r.revision && revisionNow && revisionNow !== r.revision),
    ratedWrongSince: Boolean(r.ratedWrongSince),
  };
}

function group(rows: DeliveryNow[]): DeliveryEvent[] {
  const events = new Map<string, DeliveryEvent>();
  for (const d of rows) {
    const e = events.get(d.event) ?? { event: d.event, sessionId: d.sessionId, channel: d.channel, query: d.query, createdAt: d.createdAt, items: [] };
    e.items.push(d);
    events.set(d.event, e);
  }
  return [...events.values()];
}

/** Everything a session was shown, oldest first, grouped by the call that showed it. */
export function sessionDeliveries(db: DB, sessionId: string): DeliveryEvent[] {
  const rows = db.prepare(`${SELECT_NOW} WHERE d.sessionId = ? ORDER BY d.id`).all(sessionId) as Record<string, unknown>[];
  return group(rows.map(toDelivery));
}

/** The sessions a memory was shown to, newest first. */
export function memoryDeliveries(db: DB, observationId: number, limit = 30): (DeliveryNow & { agent: string | null })[] {
  const rows = db
    .prepare(`SELECT x.*, s.agent FROM (${SELECT_NOW} WHERE d.observationId = ?) x LEFT JOIN sessions s ON s.id = x.sessionId ORDER BY x.id DESC LIMIT ?`)
    .all(observationId, limit) as Record<string, unknown>[];
  return rows.map((r) => ({ ...toDelivery(r), agent: (r.agent as string | null) ?? null }));
}

/** How many memories each session was shown (distinct), for the session list. */
export function deliveryCounts(db: DB, sessionIds: string[]): Map<string, number> {
  if (sessionIds.length === 0) return new Map();
  const rows = db
    .prepare(`SELECT sessionId, COUNT(DISTINCT COALESCE(observationId, -longTermId)) AS n FROM deliveries WHERE sessionId IN (${sessionIds.map(() => '?').join(',')}) GROUP BY sessionId`)
    .all(...sessionIds) as { sessionId: string; n: number }[];
  return new Map(rows.map((r) => [r.sessionId, Number(r.n)]));
}

/** Drop deliveries older than the retention window. Returns how many were removed. */
export function pruneDeliveries(db: DB, days = auditDays(), now = new Date()): number {
  const keep = days > 0 ? days : DEFAULT_DAYS;
  const cutoff = new Date(now.getTime() - keep * 86_400_000).toISOString();
  return Number(db.prepare('DELETE FROM deliveries WHERE createdAt < ?').run(cutoff).changes);
}

const CHANNEL_LABEL: Record<DeliveryChannel, string> = { brief: 'Brief', search: 'Search', detail: 'Detail', 'file-note': 'File note' };
const hhmm = (iso: string) => iso.slice(11, 16);

/** Flags for a delivered item: what was true when shown, and what changed since. */
export function deliveryFlags(d: DeliveryNow): string[] {
  return [
    d.stale ? 'flagged changed when shown' : '',
    d.editedSince ? 'edited since' : '',
    d.ratedWrongSince ? 'rated wrong since' : '',
    d.statusNow && d.statusNow !== 'active' ? `now ${d.statusNow}` : '',
    d.observationId != null && d.statusNow === null ? 'deleted' : '',
  ].filter(Boolean);
}

/** A session's deliveries as text for the terminal. */
export function formatSessionDeliveries(events: DeliveryEvent[]): string {
  if (events.length === 0) return 'Nothing recorded as shown to this session.';
  const out: string[] = [];
  for (const e of events) {
    const what = e.channel === 'brief' ? (e.query ? `for "${e.query}"` : '') : e.channel === 'file-note' ? `on ${e.query}` : e.query ? `"${e.query}"` : '';
    out.push(`${hhmm(e.createdAt)} ${CHANNEL_LABEL[e.channel]} ${what}`.trimEnd());
    for (const d of e.items) {
      const id = d.observationId != null ? `#${d.observationId}` : `LT${d.longTermId}`;
      const where = e.channel === 'brief' && d.section ? ` [${d.section}]` : '';
      const score = d.score != null ? ` score ${d.score.toFixed(2)}` : '';
      const flags = deliveryFlags(d);
      out.push(`  ${String(d.rank ?? '').padStart(2)}. ${id} ${d.title}${where}${score}${flags.length ? `  (${flags.join('; ')})` : ''}`);
    }
  }
  return out.join('\n');
}
