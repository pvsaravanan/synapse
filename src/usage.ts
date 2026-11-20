/**
 * Which memories actually help. A read is a memory reaching an agent (a brief, synapse_detail, a file note); browsing
 * in synapse ui doesn't count. Per memory Synapse keeps the total reads and the time of the last one, plus feedback, so:
 *
 *   read often     most reads overall, with ratings; the most-read and the helpful are suggested for long-term memory
 *   not read       no read in the last N days, though stored before them: candidates to archive or resolve
 *   not read yet   stored within the last N days and never read: too new to judge
 *   rated wrong    still active but rated conflicted, corrected or outdated: fix or resolve
 *
 * Only curated (qualified, active) memories count; auto-captured candidates have their own lifecycle.
 */
import type { DB } from './db.js';
import { listLongTerm, type LtKind } from './longterm.js';
import { listObservations } from './store.js';
import type { Observation, ObservationType } from './types.js';

export interface MemoryUsage {
  observation: Observation;
  reads: number;
  lastRead?: string;
  /** helpful + verified ratings. */
  helpful: number;
  /** conflicted + corrected + outdated ratings. */
  negative: number;
  ageDays: number;
  /** The long-term item made from it, if any (proposed or approved). */
  longTerm?: { id: number; state: string };
  /** Read often or rated helpful, and not yet long-term memory. */
  promote: boolean;
}

export interface UsageReport {
  days: number;
  totals: { curated: number; readInWindow: number; notRead: number; notReadYet: number; helpful: number; neverRead: number };
  often: MemoryUsage[];
  notRead: MemoryUsage[];
  notReadYet: MemoryUsage[];
  ratedWrong: MemoryUsage[];
}

/**
 * Reads that make a memory worth proposing for long-term memory: at least 3, and at least half the most-read memory's
 * count. Memories in the brief are read every session, so a fixed bar would mark nearly all of them.
 */
const PROMOTE_READS = 3;

/** The long-term kind a memory type suggests: fixes are procedures, changes and session goals are events. */
export function suggestedKind(type: ObservationType): LtKind {
  if (type === 'problem-solution') return 'procedural';
  if (type === 'what-changed' || type === 'session-request') return 'episodic';
  return 'semantic';
}

export function usageReport(db: DB, projectId: string, opts: { days?: number; now?: Date; limit?: number } = {}): UsageReport {
  const days = opts.days ?? 30;
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 25;
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const obs = listObservations(db, { projectId, status: 'active', includeCandidates: false, limit: 5000 });
  const ids = obs.map((o) => o.id);
  const ph = ids.map(() => '?').join(',');
  const access = new Map<number, { reads: number; lastRead?: string }>();
  const ratings = new Map<number, { helpful: number; negative: number }>();
  if (ids.length) {
    for (const r of db.prepare(`SELECT observationId, accessCount, lastAccessed FROM observation_access WHERE observationId IN (${ph})`).all(...ids) as {
      observationId: number; accessCount: number; lastAccessed: string | null;
    }[]) {
      access.set(Number(r.observationId), { reads: Number(r.accessCount), lastRead: r.lastAccessed ?? undefined });
    }
    for (const r of db
      .prepare(
        `SELECT observationId, SUM(signal IN ('helpful', 'verified')) AS h, SUM(signal IN ('conflicted', 'corrected', 'outdated')) AS n
         FROM feedback WHERE observationId IN (${ph}) GROUP BY observationId`,
      )
      .all(...ids) as { observationId: number; h: number; n: number }[]) {
      ratings.set(Number(r.observationId), { helpful: Number(r.h), negative: Number(r.n) });
    }
  }
  const lt = new Map<number, { id: number; state: string }>();
  for (const i of listLongTerm(db, projectId, { state: 'all', limit: 1000 })) {
    if (i.sourceObservationId && (i.state === 'proposed' || i.state === 'approved') && !lt.has(i.sourceObservationId)) lt.set(i.sourceObservationId, { id: i.id, state: i.state });
  }

  const maxReads = Math.max(0, ...[...access.values()].map((a) => a.reads));
  const promoteAt = Math.max(PROMOTE_READS, Math.ceil(maxReads / 2));
  const rows: MemoryUsage[] = obs.map((o) => {
    const a = access.get(o.id) ?? { reads: 0 };
    const f = ratings.get(o.id) ?? { helpful: 0, negative: 0 };
    const longTerm = lt.get(o.id);
    return {
      observation: o, reads: a.reads, lastRead: a.lastRead, helpful: f.helpful, negative: f.negative,
      ageDays: Math.max(0, Math.floor((now.getTime() - new Date(o.createdAt).getTime()) / 86_400_000)),
      longTerm, promote: !longTerm && f.negative === 0 && (a.reads >= promoteAt || f.helpful > 0),
    };
  });
  const readInWindow = (u: MemoryUsage) => Boolean(u.lastRead && u.lastRead >= cutoff);
  const storedBefore = (u: MemoryUsage) => u.observation.createdAt < cutoff;
  const oldestFirst = (a: MemoryUsage, b: MemoryUsage) => a.observation.createdAt.localeCompare(b.observation.createdAt);

  const notRead = rows.filter((u) => !readInWindow(u) && storedBefore(u)).sort((a, b) => a.reads - b.reads || oldestFirst(a, b));
  const notReadYet = rows.filter((u) => u.reads === 0 && !storedBefore(u)).sort(oldestFirst);
  return {
    days,
    totals: {
      curated: rows.length,
      readInWindow: rows.filter(readInWindow).length,
      notRead: notRead.length,
      notReadYet: notReadYet.length,
      helpful: rows.filter((u) => u.helpful > 0).length,
      neverRead: rows.filter((u) => u.reads === 0).length,
    },
    often: rows.filter((u) => u.reads > 0 || u.helpful > 0)
      .sort((a, b) => b.reads + 2 * b.helpful - (a.reads + 2 * a.helpful) || (b.lastRead ?? '').localeCompare(a.lastRead ?? ''))
      .slice(0, limit),
    notRead: notRead.slice(0, limit),
    notReadYet: notReadYet.slice(0, limit),
    ratedWrong: rows.filter((u) => u.negative > 0).sort((a, b) => b.negative - a.negative).slice(0, limit),
  };
}
