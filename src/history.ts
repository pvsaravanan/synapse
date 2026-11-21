/**
 * Memory history: earlier versions of a curated memory, kept whenever its content changes (topic update, duplicate
 * merge, edit, merge, team import, restore; store.ts snapshotRevision). Answers "how did this decision change?" and
 * "what did we believe on <date>?", shows what each change did, and restores an earlier version (which is itself a
 * change, so nothing is lost).
 */
import type { DB } from './db.js';
import { editObservation, getObservation, type RevisionChange } from './store.js';
import type { Observation, ObservationType } from './types.js';

export interface MemoryVersion {
  revision: number;
  current: boolean;
  type: ObservationType;
  entityName: string;
  title: string;
  narrative: string;
  facts: string[];
  filesModified: string[];
  concepts: string[];
  /** When this version was written. */
  validFrom: string;
  /** When it was replaced (undefined for the current version). */
  replacedAt?: string;
  /** What replaced it. */
  change?: RevisionChange;
  sessionId?: string;
  note?: string;
}

const arr = (v: unknown): string[] => {
  try {
    const x = JSON.parse(String(v ?? '[]'));
    return Array.isArray(x) ? x.map(String) : [];
  } catch {
    return [];
  }
};

function fromRow(r: Record<string, unknown>): MemoryVersion {
  return {
    revision: Number(r.revision), current: false, type: r.type as ObservationType, entityName: String(r.entityName), title: String(r.title),
    narrative: String(r.narrative), facts: arr(r.facts), filesModified: arr(r.filesModified), concepts: arr(r.concepts),
    validFrom: String(r.validFrom), replacedAt: String(r.replacedAt), change: r.change as RevisionChange,
    ...(r.sessionId ? { sessionId: String(r.sessionId) } : {}), ...(r.note ? { note: String(r.note) } : {}),
  };
}

const currentVersion = (o: Observation): MemoryVersion => ({
  revision: o.revisionCount, current: true, type: o.type, entityName: o.entityName, title: o.title, narrative: o.narrative,
  facts: o.facts, filesModified: o.filesModified, concepts: o.concepts, validFrom: o.updatedAt ?? o.createdAt,
});

/** Every kept version of a memory, newest (current) first. Undefined when the memory doesn't exist. */
export function memoryHistory(db: DB, id: number): MemoryVersion[] | undefined {
  const o = getObservation(db, id);
  if (!o) return undefined;
  const rows = db.prepare('SELECT * FROM observation_revisions WHERE observationId = ? ORDER BY id DESC').all(id) as Record<string, unknown>[];
  return [currentVersion(o), ...rows.map(fromRow)];
}

/** How many earlier versions each memory has, for lists. */
export function revisionCounts(db: DB, ids: number[]): Map<number, number> {
  if (ids.length === 0) return new Map();
  const rows = db
    .prepare(`SELECT observationId AS id, COUNT(*) AS n FROM observation_revisions WHERE observationId IN (${ids.map(() => '?').join(',')}) GROUP BY observationId`)
    .all(...ids) as { id: number; n: number }[];
  return new Map(rows.map((r) => [Number(r.id), Number(r.n)]));
}

/**
 * The version that held at a moment (ISO date or date-time): the newest version written at or before it. Undefined
 * when the memory didn't exist yet. Versions dropped by the 50-version cap can't be recovered, so a moment before
 * the oldest kept version returns that oldest version, marked by the caller if it matters.
 */
export function versionAt(db: DB, id: number, at: string): MemoryVersion | undefined {
  const o = getObservation(db, id);
  const t = Date.parse(at);
  if (!o || !Number.isFinite(t) || t < Date.parse(o.createdAt)) return undefined;
  const versions = memoryHistory(db, id)!;
  return versions.find((v) => Date.parse(v.validFrom) <= t) ?? versions[versions.length - 1];
}

/** Restore an earlier version's content. The version being replaced is kept, so a restore can be undone. */
export function restoreVersion(db: DB, id: number, revision: number, rootPath?: string): Observation {
  const v = memoryHistory(db, id)?.find((x) => !x.current && x.revision === revision);
  if (!v) throw new Error(`Memory #${id} has no kept revision ${revision}`);
  return editObservation(db, id, {
    type: v.type, entityName: v.entityName, title: v.title, narrative: v.narrative, facts: v.facts, filesModified: v.filesModified, concepts: v.concepts,
  }, rootPath, { change: 'restore', note: `restored revision ${revision}` });
}

export type DiffLine = { op: ' ' | '+' | '-'; text: string };

/** Line diff (longest common subsequence) from `a` to `b`. Memories are short, so the quadratic table is fine. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > 400_000) return [...x.map((text) => ({ op: '-' as const, text })), ...y.map((text) => ({ op: '+' as const, text }))];
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) out.push({ op: ' ', text: x[i++] }), j++;
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: '-', text: x[i++] });
    else out.push({ op: '+', text: y[j++] });
  }
  while (i < x.length) out.push({ op: '-', text: x[i++] });
  while (j < y.length) out.push({ op: '+', text: y[j++] });
  return out;
}

export interface VersionChanges {
  fields: { field: string; from: string; to: string }[];
  narrative: DiffLine[];
  facts: { added: string[]; removed: string[] };
  files: { added: string[]; removed: string[] };
  concepts: { added: string[]; removed: string[] };
}

const setDiff = (from: string[], to: string[]) => ({ added: to.filter((x) => !from.includes(x)), removed: from.filter((x) => !to.includes(x)) });

/** What changed from one version to the next. */
export function versionChanges(from: MemoryVersion, to: MemoryVersion): VersionChanges {
  const fields = (['title', 'type', 'entityName'] as const)
    .filter((k) => from[k] !== to[k])
    .map((k) => ({ field: k === 'entityName' ? 'area' : k, from: from[k], to: to[k] }));
  return {
    fields,
    narrative: from.narrative === to.narrative ? [] : lineDiff(from.narrative, to.narrative),
    facts: setDiff(from.facts, to.facts),
    files: setDiff(from.filesModified, to.filesModified),
    concepts: setDiff(from.concepts, to.concepts),
  };
}

const CHANGE_LABEL: Record<RevisionChange, string> = {
  'topic-update': 'revised by a topic update', 'duplicate-merge': 'merged with a near-duplicate', edit: 'edited', merge: 'merged',
  team: 'updated from teammates', restore: 'restored to an earlier revision',
};
export const changeLabel = (c: RevisionChange) => CHANGE_LABEL[c] ?? c;

const day = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/** A memory's history as text for the terminal (and the MCP tool): each version, newest first, with what changed. */
export function formatHistory(id: number, versions: MemoryVersion[], opts: { diff?: boolean } = {}): string {
  if (versions.length === 1) return `#${id} has no earlier versions: it hasn't changed since it was stored (or since history was kept).`;
  const out = [`#${id}: ${versions.length} versions, newest first`];
  versions.forEach((v, i) => {
    const newer = versions[i - 1];
    const head = v.current
      ? `rev ${v.revision} (current) since ${day(v.validFrom)}`
      : `rev ${v.revision} ${day(v.validFrom)} → ${day(v.replacedAt!)}, then ${changeLabel(v.change!)}${v.note ? ` (${v.note})` : ''}`;
    out.push('', head, `  [${v.type}] ${v.entityName}: ${v.title}`);
    if (!newer) return;
    const c = versionChanges(v, newer);
    const summary = [
      ...c.fields.map((f) => `${f.field} "${f.from}" → "${f.to}"`),
      c.narrative.length ? `narrative: ${c.narrative.filter((l) => l.op === '+').length} line(s) added, ${c.narrative.filter((l) => l.op === '-').length} removed` : '',
      c.facts.added.length || c.facts.removed.length ? `facts: +${c.facts.added.length} -${c.facts.removed.length}` : '',
      c.files.added.length || c.files.removed.length ? `files: ${[...c.files.added.map((f) => '+' + f), ...c.files.removed.map((f) => '-' + f)].join(' ')}` : '',
    ].filter(Boolean);
    if (summary.length) out.push(`  changed next: ${summary.join('; ')}`);
    if (opts.diff && c.narrative.length) out.push(...c.narrative.filter((l) => l.op !== ' ').map((l) => `    ${l.op} ${l.text}`));
  });
  return out.join('\n');
}

/** One version in full. */
export function formatVersion(id: number, v: MemoryVersion): string {
  return [
    `#${id} rev ${v.revision}${v.current ? ' (current)' : ''}: [${v.type}] ${v.title}`,
    `area: ${v.entityName} · valid ${day(v.validFrom)}${v.replacedAt ? ` → ${day(v.replacedAt)} (then ${changeLabel(v.change!)})` : ' → now'}`,
    '',
    v.narrative,
    ...(v.facts.length ? ['', 'Facts:', ...v.facts.map((f) => `- ${f}`)] : []),
    ...(v.filesModified.length ? ['', `Files: ${v.filesModified.join(', ')}`] : []),
  ].join('\n');
}
