import { randomUUID } from 'node:crypto';
import { setMeta, type DB } from './db.js';
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

// ── Sessions run by an MCP server (agents without hooks) ─────────────────
// Some clients stop their MCP servers with SIGKILL (Copilot CLI does), so the server's own shutdown never runs.
// Each server records its process id per session; the next server for the project closes sessions whose process is gone.

const SERVER_SESSION = 'server-session:';

export function registerServerSession(db: DB, sessionId: string, pid = process.pid): void {
  setMeta(db, SERVER_SESSION + sessionId, String(pid));
}

export function releaseServerSession(db: DB, sessionId: string): void {
  db.prepare('DELETE FROM meta WHERE key = ?').run(SERVER_SESSION + sessionId);
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // alive, owned by another user
  }
}

/**
 * Close the project's server-run sessions whose server process no longer exists, with `summarize(id)` as the
 * summary (falling back to the summary the server kept current). Returns the ids closed.
 */
export function closeOrphanedSessions(
  db: DB, projectId: string, summarize: (id: string) => string | undefined, alive: (pid: number) => boolean = processAlive,
): string[] {
  const rows = db.prepare('SELECT key, value FROM meta WHERE key LIKE ?').all(`${SERVER_SESSION}%`) as { key: string; value: string }[];
  const closed: string[] = [];
  for (const { key, value } of rows) {
    const id = key.slice(SERVER_SESSION.length);
    const s = getSession(db, id);
    if (s && s.projectId !== projectId) continue; // left for a server of that project
    if (s?.status === 'active' && alive(Number(value))) continue;
    if (s?.status === 'active') {
      endSession(db, id, summarize(id));
      closed.push(id);
    }
    releaseServerSession(db, id);
  }
  return closed;
}
