/**
 * Consolidation of auto-captured memories. Hooks keep one rolling record per edited file and per command, which piles
 * up: a session touching ten files in one area leaves ten records, and every session's `npm test` leaves another
 * "Ran: npm test". When a session ends, its edit records in one area merge into one, its command runs merge into one,
 * and older duplicate command records are archived. Originals are archived with `supersededBy` pointing at what
 * replaced them, never deleted. Records that were qualified or retrieved are left alone.
 *
 * Candidates nobody kept, read or rated within SYNAPSE_CANDIDATE_DAYS are archived too (`archiveStaleCandidates`), and
 * `synapse consolidate` re-applies the current capture rule to older command records (`refilterCommands`).
 */
import { candidateDays } from './config.js';
import type { DB } from './db.js';
import { commandCapture, commandKey } from './hooks.js';
import { listObservations, rowToObservation, storeObservation } from './store.js';
import type { Observation, ProjectInfo } from './types.js';

export interface Consolidation {
  sessionId: string;
  /** Edit records merged per area: the merged record (undefined in a dry run), its files, and the records it replaced. */
  merged: { entity: string; into?: number; files: string[]; from: number[] }[];
  /** Older duplicate command records archived, with the newer record that replaced each. */
  archived: { id: number; by: number }[];
  /** The session's command runs merged into one record (undefined in a dry run), and the records it replaced. */
  commands?: { into?: number; from: number[] };
}

const FILE_TOPIC = 'hook/file/';
const sessionTopic = (sessionId: string, entity: string) => `hook/session/${sessionId}/${entity}`;

function accessedIds(db: DB, ids: number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const rows = db
    .prepare(`SELECT observationId FROM observation_access WHERE accessCount > 0 AND observationId IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as { observationId: number }[];
  return new Set(rows.map((r) => Number(r.observationId)));
}

/** First meaningful line of a captured edit's excerpt, for the merged record's file list. */
function excerptLine(o: Observation): string {
  const line = o.narrative.replace(/^Latest change excerpt:\n/, '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

function archive(db: DB, ids: number[], by: number): void {
  const stmt = db.prepare("UPDATE observations SET status = 'archived', supersededBy = ?, updatedAt = ? WHERE id = ?");
  const now = new Date().toISOString();
  for (const id of ids) stmt.run(by, now, id);
}

/** Candidates a hook captured for this session that nobody qualified or retrieved. */
function untouchedCandidates(db: DB, projectId: string, sessionId: string): Observation[] {
  const obs = listObservations(db, { projectId, limit: 1000, status: 'active' })
    .filter((o) => o.sessionId === sessionId && o.source === 'hook' && o.admissionState === 'candidate');
  const accessed = accessedIds(db, obs.map((o) => o.id));
  return obs.filter((o) => !accessed.has(o.id));
}

export function consolidateSession(db: DB, project: ProjectInfo, sessionId: string, opts: { dryRun?: boolean } = {}): Consolidation {
  const result: Consolidation = { sessionId, merged: [], archived: [] };
  const candidates = untouchedCandidates(db, project.id, sessionId);

  // 1. Edit records: two or more in one area (with any earlier merge of that area) become one record.
  const edits = candidates.filter((o) => o.type === 'what-changed' && o.topicKey?.startsWith(FILE_TOPIC));
  const byEntity = new Map<string, Observation[]>();
  for (const o of edits) byEntity.set(o.entityName, [...(byEntity.get(o.entityName) ?? []), o]);
  const goal = listObservations(db, { projectId: project.id, type: ['session-request'], limit: 50, status: 'all' }).find((o) => o.sessionId === sessionId)?.title;
  for (const [entity, group] of byEntity) {
    const previousRow = db
      .prepare("SELECT * FROM observations WHERE projectId = ? AND topicKey = ? AND status = 'active' LIMIT 1")
      .get(project.id, sessionTopic(sessionId, entity)) as Record<string, unknown> | undefined;
    const previous = previousRow ? rowToObservation(previousRow) : undefined;
    if (group.length < 2 && !previous) continue;
    // File -> line, earlier merge first so newer excerpts win.
    const lines = new Map<string, string>();
    for (const l of previous?.narrative.split('\n') ?? []) {
      const m = l.match(/^- (\S+?)(?:: (.*))?$/);
      if (m) lines.set(m[1], m[2] ?? '');
    }
    for (const o of [...group].sort((a, b) => (a.updatedAt ?? a.createdAt).localeCompare(b.updatedAt ?? b.createdAt))) {
      for (const f of o.filesModified) lines.set(f, excerptLine(o));
    }
    const files = [...lines.keys()];
    const entry = { entity, files, from: group.map((o) => o.id) };
    if (opts.dryRun) {
      result.merged.push(entry);
      continue;
    }
    const { observation } = storeObservation(db, {
      projectId: project.id,
      entityName: entity,
      type: 'what-changed',
      title: `Changed ${entity}: ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}`,
      narrative: `${goal ? `Session goal: ${goal}\n` : ''}Files changed in this session:\n${files.map((f) => `- ${f}${lines.get(f) ? `: ${lines.get(f)}` : ''}`).join('\n')}`,
      filesModified: files,
      rootPath: project.rootPath,
      sessionId,
      source: 'hook',
      admissionState: 'candidate',
      valueCategory: 'ephemeral',
      topicKey: sessionTopic(sessionId, entity),
    });
    archive(db, entry.from, observation.id);
    result.merged.push({ ...entry, into: observation.id });
  }

  // 2. Command records: keep the newest "Ran: <command>" per command across sessions.
  for (const run of candidates.filter((o) => o.type === 'discovery' && o.title.startsWith('Ran: '))) {
    const key = commandKey(run.narrative.split('\n')[0].replace(/^\$ /, ''));
    const older = listObservations(db, { projectId: project.id, type: ['discovery'], limit: 1000, status: 'active' })
      .filter((o) => o.id !== run.id && o.source === 'hook' && o.admissionState === 'candidate' && o.title.startsWith('Ran: ') && o.sessionId !== sessionId)
      .filter((o) => (o.updatedAt ?? o.createdAt) <= (run.updatedAt ?? run.createdAt))
      .filter((o) => commandKey(o.narrative.split('\n')[0].replace(/^\$ /, '')) === key);
    const accessed = accessedIds(db, older.map((o) => o.id));
    for (const o of older.filter((x) => !accessed.has(x.id))) {
      if (!opts.dryRun) archive(db, [o.id], run.id);
      result.archived.push({ id: o.id, by: run.id });
    }
  }
  // 3. The session's remaining command runs (each distinct command left one "Ran:" record) become one record.
  const runs = untouchedCandidates(db, project.id, sessionId).filter((o) => o.type === 'discovery' && o.title.startsWith('Ran: ') && o.topicKey?.startsWith('hook/cmd/'));
  const commandsTopic = `hook/session/${sessionId}/commands`;
  const previousRuns = db.prepare("SELECT * FROM observations WHERE projectId = ? AND topicKey = ? AND status = 'active' LIMIT 1").get(project.id, commandsTopic) as Record<string, unknown> | undefined;
  if (runs.length >= 2 || (runs.length && previousRuns)) {
    // Command -> how many records ran it, earlier merge first.
    const counts = new Map<string, number>();
    for (const l of previousRuns ? String(previousRuns.narrative).split('\n') : []) {
      const m = l.match(/^- \x60(.+)\x60(?: ×(\d+))?$/);
      if (m) counts.set(m[1], Number(m[2] ?? 1));
    }
    for (const r of [...runs].reverse()) {
      const key = commandKey(r.narrative.split('\n')[0].replace(/^\$ /, '')) || r.title.slice(5);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const keys = [...counts.keys()];
    if (opts.dryRun) result.commands = { from: runs.map((o) => o.id) };
    else {
      const { observation } = storeObservation(db, {
        projectId: project.id,
        entityName: 'commands',
        type: 'discovery',
        title: `Ran ${keys.length} command${keys.length === 1 ? '' : 's'}: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ` +${keys.length - 3}` : ''}`,
        narrative: `${goal ? `Session goal: ${goal}\n` : ''}Commands run in this session:\n${keys.map((k) => `- \x60${k}\x60${counts.get(k)! > 1 ? ` ×${counts.get(k)}` : ''}`).join('\n')}`,
        concepts: [...new Set(keys.map((k) => k.split(/\s+/)[0]))].slice(0, 10),
        sessionId,
        source: 'hook',
        admissionState: 'candidate',
        valueCategory: 'ephemeral',
        topicKey: commandsTopic,
      });
      archive(db, runs.map((o) => o.id), observation.id);
      result.commands = { into: observation.id, from: runs.map((o) => o.id) };
    }
  }
  return result;
}

/** Hook candidates of a project that nobody kept, read or rated, last touched before `cutoff`. */
function unreviewedCandidatesBefore(db: DB, projectId: string, cutoff: string): Observation[] {
  const rows = db
    .prepare(
      `SELECT o.* FROM observations o WHERE o.projectId = ? AND o.status = 'active' AND o.source = 'hook' AND o.admissionState = 'candidate'
       AND COALESCE(o.updatedAt, o.createdAt) < ?
       AND NOT EXISTS (SELECT 1 FROM observation_access a WHERE a.observationId = o.id AND a.accessCount > 0)
       AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.observationId = o.id)`,
    )
    .all(projectId, cutoff) as Record<string, unknown>[];
  return rows.map(rowToObservation);
}

/**
 * Archive auto-captured candidates nobody kept, read or rated in `days` days (SYNAPSE_CANDIDATE_DAYS, default 14).
 * They stay in the database as archived and can be reopened. Returns the archived ids.
 */
export function archiveStaleCandidates(db: DB, projectId: string, opts: { days?: number; dryRun?: boolean; now?: Date } = {}): number[] {
  const days = opts.days ?? candidateDays();
  if (!(days > 0)) return [];
  const cutoff = new Date((opts.now ?? new Date()).getTime() - days * 86_400_000).toISOString();
  const ids = unreviewedCandidatesBefore(db, projectId, cutoff).map((o) => o.id);
  if (!opts.dryRun && ids.length) {
    const stmt = db.prepare("UPDATE observations SET status = 'archived', updatedAt = ? WHERE id = ?");
    const ts = new Date().toISOString();
    for (const id of ids) stmt.run(ts, id);
  }
  return ids;
}

/**
 * Re-apply the current capture rule to command records captured before it (searches and file prints that were kept
 * because a path or heredoc contained "test", or whose printed code looked like an error). Unreviewed ones the rule
 * would now skip are archived. Returns the archived ids.
 */
export function refilterCommands(db: DB, projectId: string, opts: { dryRun?: boolean } = {}): number[] {
  const ids = unreviewedCandidatesBefore(db, projectId, '9999')
    .filter((o) => o.topicKey?.startsWith('hook/cmd/') && (o.type === 'gotcha' || o.type === 'discovery') && o.narrative.startsWith('$ '))
    .filter((o) => {
      const [cmd, ...rest] = o.narrative.slice(2).split('\n\n');
      return commandCapture(cmd, rest.join('\n\n'), o.type === 'gotcha') === 'skip';
    })
    .map((o) => o.id);
  if (!opts.dryRun && ids.length) {
    const stmt = db.prepare("UPDATE observations SET status = 'archived', updatedAt = ? WHERE id = ?");
    const ts = new Date().toISOString();
    for (const id of ids) stmt.run(ts, id);
  }
  return ids;
}

/** Consolidate every ended session of a project, oldest first (for history captured before consolidation existed). */
export function consolidateProject(db: DB, project: ProjectInfo, opts: { dryRun?: boolean } = {}): Consolidation[] {
  const sessions = db
    .prepare("SELECT id FROM sessions WHERE projectId = ? AND status = 'completed' ORDER BY COALESCE(endedAt, startedAt), rowid")
    .all(project.id) as { id: string }[];
  return sessions.map((s) => consolidateSession(db, project, String(s.id), opts)).filter((c) => c.merged.length || c.archived.length || c.commands);
}
