import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import { redactSecrets } from './secrets.js';
import type { Session } from './types.js';

function toSession(r: Record<string, unknown>): Session {
  return {
    id: String(r.id),
    projectId: String(r.projectId),
    startedAt: String(r.startedAt),
    endedAt: (r.endedAt as string) ?? undefined,
    status: r.status as Session['status'],
    summary: (r.summary as string) ?? undefined,
    agent: (r.agent as string) ?? undefined,
  };
}

/** Start a session (idempotent when an explicit id is reused). */
export function startSession(db: DB, projectId: string, opts: { id?: string; agent?: string } = {}): Session {
  const id = opts.id ?? randomUUID();
  const existing = getSession(db, id);
  if (existing) return existing;
  db.prepare('INSERT INTO sessions(id, projectId, startedAt, status, agent) VALUES(?,?,?,?,?)').run(
    id, projectId, new Date().toISOString(), 'active', opts.agent ?? null,
  );
  return getSession(db, id)!;
}

export function getSession(db: DB, id: string): Session | undefined {
  const r = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toSession(r) : undefined;
}

export function activeSession(db: DB, projectId: string): Session | undefined {
  const r = db
    .prepare("SELECT * FROM sessions WHERE projectId = ? AND status = 'active' ORDER BY startedAt DESC LIMIT 1")
    .get(projectId) as Record<string, unknown> | undefined;
  return r ? toSession(r) : undefined;
}

export function endSession(db: DB, id: string, summary?: string): Session | undefined {
  db.prepare("UPDATE sessions SET status = 'completed', endedAt = ?, summary = COALESCE(?, summary) WHERE id = ?").run(
    new Date().toISOString(), summary ? redactSecrets(summary) : null, id,
  );
  return getSession(db, id);
}

export function recentSessions(db: DB, projectId: string, limit = 3, onlyWithSummary = true): Session[] {
  return (db
    .prepare(
      `SELECT * FROM sessions WHERE projectId = ? ${onlyWithSummary ? "AND summary IS NOT NULL AND summary != ''" : ''}
       ORDER BY COALESCE(endedAt, startedAt) DESC LIMIT ?`,
    )
    .all(projectId, limit) as Record<string, unknown>[]).map(toSession);
}
