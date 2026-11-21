/**
 * Reflection: recurring patterns in auto-captured records, handed to the agent to summarise. Hooks record each failed
 * command and each draft fix per session, so the same failure across sessions stays a pile of separate candidates
 * that consolidation eventually archives. Grouped here, by command (`npm test` failing in three sessions) and by error
 * (one error message behind different commands), each pattern becomes evidence the agent turns into a fix or
 * procedure with its own model (synapse_store / synapse_lt_propose); Synapse makes no LLM calls.
 *
 * Filing a pattern under the memory that explains it archives its records, pointing at that memory. Filed and dismissed
 * patterns stay quiet until they recur in new sessions.
 */
import { createHash } from 'node:crypto';
import type { DB } from './db.js';
import { FAILURE_LINE, commandKey, isReadOnlyCommand } from './hooks.js';
import { getLongTerm } from './longterm.js';
import { getObservation, rowToObservation } from './store.js';
import type { Observation } from './types.js';

export type PatternKind = 'failure' | 'error';

export interface Pattern {
  /** Stable id, e.g. "p-3f9c2a7b". */
  key: string;
  kind: PatternKind;
  /** The command (failure) or the normalised error message (error). */
  label: string;
  /** For failure patterns, the normalised error the records share ('' when they printed nothing specific). */
  signature: string;
  sessions: number;
  occurrences: number;
  firstAt: string;
  lastAt: string;
  /** Distinct error lines seen, most frequent first. */
  errors: string[];
  /** Commands involved (for error patterns, more than one). */
  commands: string[];
  /** Files changed by the draft fixes, with how many fixes touched each. */
  fixFiles: { file: string; fixes: number }[];
  fixes: number;
  /** Every record in the pattern (failures and fix drafts). */
  recordIds: number[];
  /** Filed or dismissed before, and recurring since. */
  recurred?: boolean;
}

export interface PatternOptions {
  /** Distinct sessions a pattern must span (default 2). */
  minSessions?: number;
  /** How far back to look, in days (default 90). */
  days?: number;
  now?: Date;
}

interface Mark {
  state: 'filed' | 'dismissed';
  at: string;
  memoryId?: number;
  longTermId?: number;
}

const metaKey = (projectId: string, key: string) => `reflect:${projectId}:${key}`;
const patternKey = (kind: PatternKind, label: string) => `p-${createHash('sha1').update(`${kind}\n${label}`).digest('hex').slice(0, 8)}`;

/**
 * Summary lines say that something failed, not what: "Test Files 1 failed (1)", "exit code 1", npm's log pointers.
 * They never define an error pattern, though they're shown when nothing more specific was printed.
 */
const GENERIC = /^(?:test files|tests?|test suites?)\b.*\bfailed\b|^\s*\d+ (?:tests? )?(?:failed|failing)\b|\bexit(?:ed)? (?:with )?(?:code|status):? \d+|^npm (?:err!|error) (?:code|errno|path|syscall|command|a complete log|lifecycle)|^\s*error:? (?:command failed|process completed with exit code)/i;

/** The most telling failure line of a command's output: the first specific one, else (with `generic`) any. */
export function errorLine(narrative: string, opts: { generic?: boolean } = {}): string | undefined {
  const re = new RegExp(FAILURE_LINE.source, FAILURE_LINE.flags.replace('m', ''));
  const lines = narrative.split('\n').slice(1).map((l) => l.trim()).filter((l) => l && re.test(l));
  return (lines.find((l) => !GENERIC.test(l)) ?? (opts.generic ? lines[0] : undefined))?.slice(0, 200);
}

/** An error line with the details that vary between runs (paths, numbers, quoted values, hashes) taken out. */
export function errorSignature(line: string): string {
  return line
    .toLowerCase()
    .replace(/(["'`]).*?\1/g, '<s>')
    .replace(/(?:[a-z]:)?(?:[\w.@~-]*[\\/])+[\w.@-]*/g, '<path>')
    .replace(/\b[0-9a-f]{7,}\b/g, '<hash>')
    .replace(/\d+(\.\d+)*/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Failures and draft fixes captured by hooks in the window (any status: fixed failures are resolved, old ones archived). */
function capturedRecords(db: DB, projectId: string, since: string): Observation[] {
  const rows = db
    .prepare(
      `SELECT * FROM observations WHERE projectId = ? AND source = 'hook' AND admissionState = 'candidate'
       AND ((type = 'gotcha' AND topicKey LIKE 'hook/cmd/%') OR (type = 'problem-solution' AND topicKey LIKE 'hook/fix/%'))
       AND COALESCE(updatedAt, createdAt) >= ? ORDER BY id`,
    )
    .all(projectId, since) as Record<string, unknown>[];
  // Records already filed under a curated memory are done; read-only commands (a grep, a sed -n) don't really fail.
  return rows.map(rowToObservation).filter((o) => !(o.supersededBy && getObservation(db, o.supersededBy)?.admissionState === 'qualified')
    && !(o.type === 'gotcha' && isReadOnlyCommand(o.narrative.split('\n')[0].replace(/^\$ /, ''))));
}

const keyOf = (o: Observation) => (o.type === 'problem-solution' ? o.title.replace(/^Fixed: /, '') : commandKey(o.narrative.split('\n')[0].replace(/^\$ /, '')));
const stamp = (o: Observation) => o.updatedAt ?? o.createdAt;

/** The failure text a record carries: a failure's output, or the failure a draft fix quotes. */
const failureText = (o: Observation) => (o.type === 'gotcha' ? o.narrative : `$\n${o.narrative.split('Failure:\n')[1] ?? ''}`);
/** The specific error a record shows, normalised; '' when it printed nothing more specific than a summary. */
const signatureOf = (o: Observation) => {
  const line = errorLine(failureText(o));
  return line ? errorSignature(line) : '';
};

function build(kind: PatternKind, label: string, records: Observation[], signature = ''): Pattern {
  const failures = records.filter((o) => o.type === 'gotcha');
  const fixes = records.filter((o) => o.type === 'problem-solution');
  const errorCounts = new Map<string, number>();
  for (const o of [...failures, ...fixes]) {
    const line = errorLine(failureText(o), { generic: true });
    if (line) errorCounts.set(line, (errorCounts.get(line) ?? 0) + 1);
  }
  const fileCounts = new Map<string, number>();
  for (const f of fixes) for (const file of f.filesModified) fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
  const times = records.map(stamp).sort();
  return {
    key: patternKey(kind, signature ? `${label}\n${signature}` : label),
    kind,
    label,
    signature,
    sessions: new Set(records.map((o) => o.sessionId ?? `#${o.id}`)).size,
    occurrences: records.length,
    firstAt: times[0],
    lastAt: times[times.length - 1],
    errors: [...errorCounts].sort((a, b) => b[1] - a[1]).map(([l]) => l).slice(0, 4),
    commands: [...new Set(records.map(keyOf))].slice(0, 6),
    fixFiles: [...fileCounts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([file, n]) => ({ file, fixes: n })),
    fixes: fixes.length,
    recordIds: records.map((o) => o.id),
  };
}

function getMark(db: DB, projectId: string, key: string): Mark | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(metaKey(projectId, key)) as { value: string } | undefined;
  try {
    return row ? (JSON.parse(row.value) as Mark) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Recurring patterns in a project's auto-captured failures and fixes, most sessions first. Patterns filed or
 * dismissed before are left out unless they recurred since in at least `minSessions` new sessions.
 */
export function findPatterns(db: DB, projectId: string, opts: PatternOptions = {}): Pattern[] {
  const minSessions = opts.minSessions ?? 2;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.days ?? 90) * 86_400_000).toISOString();
  const records = capturedRecords(db, projectId, since);

  // The same failure = the same command with the same error (or, printing nothing specific, the same command): a
  // test suite failing on different tests in different sessions is not one pattern.
  const byCommand = new Map<string, { command: string; signature: string; records: Observation[] }>();
  for (const o of records) {
    const command = keyOf(o);
    if (!command) continue;
    const signature = signatureOf(o);
    const k = `${command}\n${signature}`;
    const g = byCommand.get(k) ?? { command, signature, records: [] };
    g.records.push(o);
    byCommand.set(k, g);
  }
  const byError = new Map<string, Observation[]>();
  for (const o of records.filter((x) => x.type === 'gotcha')) {
    const sig = signatureOf(o);
    if (sig) byError.set(sig, [...(byError.get(sig) ?? []), o]);
  }

  const candidates = [
    ...[...byCommand.values()].map((g) => build('failure', g.command, g.records, g.signature)),
    // An error behind more than one command (the command pattern already covers a single one).
    ...[...byError].filter(([, rs]) => new Set(rs.map(keyOf)).size > 1).map(([label, rs]) => build('error', label, rs)),
  ];

  const out: Pattern[] = [];
  for (const p of candidates) {
    // A pattern needs at least one failure: fix drafts alone are already summaries.
    if (p.sessions < minSessions || p.occurrences === p.fixes) continue;
    const mark = getMark(db, projectId, p.key);
    if (mark) {
      const after = records.filter((o) => p.recordIds.includes(o.id) && stamp(o) > mark.at);
      if (new Set(after.map((o) => o.sessionId ?? `#${o.id}`)).size < minSessions || !after.some((o) => o.type === 'gotcha')) continue;
      out.push({ ...build(p.kind, p.label, after, p.signature), recurred: true });
      continue;
    }
    out.push(p);
  }
  return out.sort((a, b) => b.sessions - a.sessions || b.occurrences - a.occurrences || b.lastAt.localeCompare(a.lastAt));
}

/**
 * File a pattern under the memory (or long-term proposal) that explains it: its records are archived, pointing at
 * the memory; or dismiss it as noise. Either way it stays quiet until it recurs in new sessions.
 */
export function resolvePattern(
  db: DB, projectId: string, key: string, how: { memoryId?: number; longTermId?: number; dismiss?: boolean }, opts: PatternOptions = {},
): { archived: number; pattern: Pattern } {
  const pattern = findPatterns(db, projectId, { ...opts, minSessions: 1 }).find((p) => p.key === key);
  if (!pattern) throw new Error(`No pattern ${key} (it may have been filed or dismissed already); list them with synapse_reflect`);
  if (!how.dismiss && how.memoryId == null && how.longTermId == null) throw new Error('Pass memoryId (or longTermId) to file the pattern, or dismiss: true');
  if (how.memoryId != null) {
    const m = getObservation(db, how.memoryId);
    if (!m || m.projectId !== projectId) throw new Error(`No memory #${how.memoryId} in this project`);
    if (m.admissionState === 'candidate') throw new Error(`#${how.memoryId} is itself an auto-captured record; file the pattern under the memory you stored`);
  }
  if (how.longTermId != null && !getLongTerm(db, projectId, how.longTermId)) throw new Error(`No long-term item LT${how.longTermId}`);
  let archived = 0;
  if (!how.dismiss) {
    const stmt = db.prepare("UPDATE observations SET status = 'archived', supersededBy = COALESCE(?, supersededBy), updatedAt = ? WHERE id = ?");
    const at = new Date().toISOString();
    for (const id of pattern.recordIds) archived += Number(stmt.run(how.memoryId ?? null, at, id).changes);
  }
  const mark: Mark = { state: how.dismiss ? 'dismissed' : 'filed', at: new Date().toISOString(), ...(how.memoryId != null ? { memoryId: how.memoryId } : {}), ...(how.longTermId != null ? { longTermId: how.longTermId } : {}) };
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(metaKey(projectId, key), JSON.stringify(mark));
  return { archived, pattern };
}

const day = (iso: string) => iso.slice(0, 10);

/** Patterns as evidence for the agent (synapse_reflect) or a person (synapse reflect). */
export function formatPatterns(patterns: Pattern[], opts: { forAgent?: boolean } = {}): string {
  if (!patterns.length) return 'No recurring patterns in auto-captured failures and fixes: nothing to summarise.';
  const out = [`${patterns.length} recurring pattern${patterns.length === 1 ? '' : 's'} in auto-captured records, most sessions first:`];
  for (const p of patterns) {
    out.push('', `${p.key} · ${p.kind === 'failure' ? `\`${p.label}\` failed` : `error "${p.label}"`} in ${p.sessions} session${p.sessions === 1 ? '' : 's'} (${p.occurrences} record${p.occurrences === 1 ? '' : 's'}, ${day(p.firstAt)} → ${day(p.lastAt)})${p.recurred ? ' · recurring after it was filed or dismissed' : ''}`);
    if (p.kind === 'error') out.push(`  Commands: ${p.commands.map((c) => `\`${c}\``).join(', ')}`);
    if (p.errors.length) out.push('  Errors seen:', ...p.errors.map((e) => `    ${e}`));
    if (p.fixes) out.push(`  Fixed ${p.fixes} time${p.fixes === 1 ? '' : 's'} by changing: ${p.fixFiles.map((f) => `${f.file}${f.fixes > 1 ? ` (${f.fixes}×)` : ''}`).join(', ') || 'files not recorded'}`);
    else out.push('  Never followed by a recorded fix in the same session.');
    out.push(`  Records: ${p.recordIds.slice(0, 12).map((id) => `#${id}`).join(' ')}${p.recordIds.length > 12 ? ' …' : ''}`);
  }
  out.push('');
  out.push(opts.forAgent
    ? 'For each pattern worth keeping: read a record or two with synapse_detail if needed, then store the real cause and fix with synapse_store ' +
      '(type problem-solution or gotcha, naming the files), or a routine with synapse_lt_propose (kind procedural). Then call ' +
      'synapse_reflect { pattern, memoryId } (or longTermId) to file the records under it. For noise, synapse_reflect { pattern, dismiss: true }.'
    : 'Ask your agent to summarise them (synapse_reflect), or dismiss noise with `synapse reflect --dismiss <pattern>`.');
  return out.join('\n');
}
