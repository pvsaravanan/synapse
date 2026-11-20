/**
 * File notes: when an agent reads or is about to edit a project file, the memories that name that file are put in
 * front of it ("⚠ #126 gotcha: UI page is a String.raw template ..."). The brief at session start can't know which
 * files the task will touch, and an agent rarely searches before an edit, so a known gotcha about a file otherwise
 * stays in the database while the agent repeats the mistake.
 *
 * Only reviewed memories are used (stored by an agent or a person, or candidates someone kept), never raw hook
 * captures, and each file is noted once per session. Hooks deliver the note as added context; it never blocks a tool.
 */
import path from 'node:path';
import { getMeta, setMeta, type DB } from './db.js';
import { changesFor } from './freshness.js';
import { recordAccess, rowToObservation } from './store.js';
import type { Observation, ObservationType, ProjectInfo } from './types.js';

/** SYNAPSE_FILE_NOTES=0 turns file notes off; SYNAPSE_HOOK_INJECT=silent does too. */
export function fileNotesEnabled(): boolean {
  if (/^(0|false|no|off)$/i.test(process.env.SYNAPSE_FILE_NOTES ?? '')) return false;
  return (process.env.SYNAPSE_HOOK_INJECT ?? '').toLowerCase() !== 'silent';
}

const PRIORITY: Partial<Record<ObservationType, number>> = {
  gotcha: 0, decision: 1, 'trade-off': 1, reasoning: 1, 'problem-solution': 2, 'how-it-works': 3, 'why-it-exists': 3,
};
const MAX_PER_FILE = 3;
const MAX_FILES = 3;

/** Reviewed, active memories of a project that name `rel`, most important first. */
export function memoriesForFile(db: DB, projectId: string, rel: string, limit = MAX_PER_FILE): Observation[] {
  const rows = db
    .prepare(
      `SELECT * FROM observations WHERE projectId = ? AND status = 'active' AND filesModified LIKE ?
       AND NOT (source = 'hook' AND admissionState = 'candidate') AND type != 'session-request'
       ORDER BY COALESCE(updatedAt, createdAt) DESC, id DESC LIMIT 50`,
    )
    .all(projectId, `%${JSON.stringify(rel)}%`) as Record<string, unknown>[];
  return rows
    .map(rowToObservation)
    .filter((o) => o.filesModified.includes(rel) && !(o.source === 'hook' && o.type === 'what-changed'))
    .sort((a, b) => (PRIORITY[a.type] ?? 4) - (PRIORITY[b.type] ?? 4))
    .slice(0, limit);
}

/** Every file a project's reviewed memories name: what a shell command's arguments are matched against. */
export function notedFiles(db: DB, projectId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT filesModified FROM observations WHERE projectId = ? AND status = 'active' AND filesModified != '[]'
       AND NOT (source = 'hook' AND admissionState = 'candidate')`,
    )
    .all(projectId) as { filesModified: string }[];
  const out = new Set<string>();
  for (const r of rows) for (const f of JSON.parse(r.filesModified) as string[]) out.add(f);
  return out;
}

/** Path relative to the project root, or null when it is outside the project. */
export function projectRelative(project: ProjectInfo, file: string): string | null {
  if (!file) return null;
  const rel = path.relative(project.rootPath, path.resolve(project.rootPath, file));
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel.split(path.sep).join('/');
}

/** Heredoc bodies are file content or scripts, not arguments: drop them before looking for file names. */
export function stripHeredocs(cmd: string): string {
  const out: string[] = [];
  let end: string | undefined;
  for (const line of cmd.split('\n')) {
    if (end !== undefined) {
      if (line.trim() === end) end = undefined;
      continue;
    }
    out.push(line);
    const m = line.match(/<<-?\s*(['"]?)([\w.-]+)\1/);
    if (m) end = m[2];
  }
  return out.join('\n');
}

/** Project files a shell command names that some reviewed memory is about (`sed -n 1,80p src/ui.ts` -> src/ui.ts). */
export function filesInCommand(cmd: string, project: ProjectInfo, known: Set<string>): string[] {
  if (known.size === 0) return [];
  const found = new Set<string>();
  for (const token of stripHeredocs(cmd).split(/[\s;&|<>()'"`=,]+/)) {
    if (!token || token.startsWith('-') || !/[\w]/.test(token)) continue;
    const rel = projectRelative(project, token.replace(/:\d+(:\d+)?$/, ''));
    if (rel && known.has(rel)) found.add(rel);
  }
  return [...found];
}

const noteKey = (sessionId: string, rel: string) => `filenote:${sessionId}:${rel}`;

/**
 * The note for the files a tool call touches, or undefined. Without a session every call is noted; with one, each
 * file once per session. Memories shown count as read.
 */
export function fileNotes(db: DB, project: ProjectInfo, sessionId: string | undefined, files: string[]): string | undefined {
  if (!fileNotesEnabled()) return undefined;
  const sections: string[] = [];
  const shown: number[] = [];
  for (const rel of [...new Set(files)].slice(0, MAX_FILES)) {
    if (sessionId && getMeta(db, noteKey(sessionId, rel))) continue;
    const mems = memoriesForFile(db, project.id, rel);
    if (sessionId) setMeta(db, noteKey(sessionId, rel), new Date().toISOString());
    if (mems.length === 0) continue;
    const changes = changesFor(project.rootPath, project.id, mems);
    const lines = mems.map((o) => {
      const changed = changes.get(o.id)?.length ? ' [changed since stored]' : '';
      return `${o.type === 'gotcha' ? '⚠' : '•'} #${o.id} ${o.type}: ${o.title}${changed}`;
    });
    sections.push(`Synapse memory about ${rel}:\n${lines.join('\n')}`);
    shown.push(...mems.map((o) => o.id));
  }
  if (sections.length === 0) return undefined;
  recordAccess(db, shown);
  const stale = sections.some((x) => x.includes('[changed since stored]'));
  return `${sections.join('\n\n')}\nRead one in full with synapse_detail before relying on it${stale ? '; check [changed since stored] ones against the current code' : ''}.`;
}

/** Forget which files a session was told about (on session end), so the meta table doesn't grow without bound. */
export function clearFileNotes(db: DB, sessionId: string): void {
  db.prepare('DELETE FROM meta WHERE key LIKE ?').run(`filenote:${sessionId}:%`);
}
