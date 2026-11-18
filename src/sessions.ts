import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import { redactSecrets } from './secrets.js';
import type { Checkpoint, Session } from './types.js';

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

/** Mark a completed session active again (the agent resumed it under the same id). */
export function reopenSession(db: DB, id: string): void {
  db.prepare("UPDATE sessions SET status = 'active', endedAt = NULL WHERE id = ? AND status = 'completed'").run(id);
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
       ORDER BY COALESCE(endedAt, startedAt) DESC, rowid DESC LIMIT ?`,
    )
    .all(projectId, limit) as Record<string, unknown>[]).map(toSession);
}

function toCheckpoint(r: Record<string, unknown>): Checkpoint {
  return {
    id: Number(r.id),
    sessionId: String(r.sessionId),
    projectId: String(r.projectId),
    createdAt: String(r.createdAt),
    summary: (r.summary as string) ?? undefined,
    agentSummary: (r.agentSummary as string) ?? undefined,
  };
}

/**
 * Record a compaction checkpoint. Each compaction adds a row, so earlier
 * checkpoints survive. Skipped when both summaries are empty or identical to
 * the session's previous checkpoint (nothing changed between compactions).
 */
export function addCheckpoint(
  db: DB, projectId: string, sessionId: string, summaries: { summary?: string; agentSummary?: string },
): Checkpoint | undefined {
  const summary = summaries.summary?.trim() ? redactSecrets(summaries.summary.trim()).slice(0, 2000) : null;
  const agentSummary = summaries.agentSummary?.trim() ? redactSecrets(summaries.agentSummary.trim()).slice(0, 2000) : null;
  if (!summary && !agentSummary) return undefined;
  const last = latestCheckpoint(db, sessionId);
  if (last && (last.summary ?? null) === summary && (last.agentSummary ?? null) === agentSummary) return undefined;
  const r = db
    .prepare('INSERT INTO checkpoints(sessionId, projectId, createdAt, summary, agentSummary) VALUES(?,?,?,?,?)')
    .run(sessionId, projectId, new Date().toISOString(), summary, agentSummary);
  return getCheckpoint(db, Number(r.lastInsertRowid));
}

export function getCheckpoint(db: DB, id: number): Checkpoint | undefined {
  const r = db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toCheckpoint(r) : undefined;
}

export function latestCheckpoint(db: DB, sessionId: string): Checkpoint | undefined {
  const r = db.prepare('SELECT * FROM checkpoints WHERE sessionId = ? ORDER BY id DESC LIMIT 1').get(sessionId) as Record<string, unknown> | undefined;
  return r ? toCheckpoint(r) : undefined;
}

/** Newest first; optionally limited to one session. */
export function listCheckpoints(db: DB, projectId: string, opts: { sessionId?: string; limit?: number } = {}): Checkpoint[] {
  const rows = opts.sessionId
    ? db.prepare('SELECT * FROM checkpoints WHERE projectId = ? AND sessionId = ? ORDER BY id DESC LIMIT ?').all(projectId, opts.sessionId, opts.limit ?? 20)
    : db.prepare('SELECT * FROM checkpoints WHERE projectId = ? ORDER BY id DESC LIMIT ?').all(projectId, opts.limit ?? 20);
  return (rows as Record<string, unknown>[]).map(toCheckpoint);
}

/** One-line text for a checkpoint: Synapse's summary, plus the agent's when both exist. */
export function checkpointText(c: Checkpoint): string {
  if (c.summary && c.agentSummary) return `${c.summary} | Agent summary: ${c.agentSummary}`;
  return c.summary ?? c.agentSummary ?? '';
}
