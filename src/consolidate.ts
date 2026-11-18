/**
 * Consolidation of auto-captured memories. Hooks keep one rolling record per edited file and per command, which piles
 * up: a session touching ten files in one area leaves ten records, and every session's `npm test` leaves another
 * "Ran: npm test". When a session ends, its edit records in one area merge into one, and older duplicate command
 * records are archived. Originals are archived with `supersededBy` pointing at what replaced them, never deleted.
 * Records that were qualified or retrieved are left alone.
 */
import type { DB } from './db.js';
import { commandKey } from './hooks.js';
import { listObservations, rowToObservation, storeObservation } from './store.js';
import type { Observation, ProjectInfo } from './types.js';

export interface Consolidation {
  sessionId: string;
  /** Edit records merged per area: the merged record (undefined in a dry run), its files, and the records it replaced. */
  merged: { entity: string; into?: number; files: string[]; from: number[] }[];
  /** Older duplicate command records archived, with the newer record that replaced each. */
  archived: { id: number; by: number }[];
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
  return result;
}

/** Consolidate every ended session of a project, oldest first (for history captured before consolidation existed). */
export function consolidateProject(db: DB, project: ProjectInfo, opts: { dryRun?: boolean } = {}): Consolidation[] {
  const sessions = db
    .prepare("SELECT id FROM sessions WHERE projectId = ? AND status = 'completed' ORDER BY COALESCE(endedAt, startedAt), rowid")
    .all(project.id) as { id: string }[];
  return sessions.map((s) => consolidateSession(db, project, String(s.id), opts)).filter((c) => c.merged.length || c.archived.length);
}
