/**
 * Project context brief: given the current
 * task, pick a lens, then assemble a small bounded brief — relevant memories,
 * cautions, start-here files, verification hints, and the last handoff —
 * instead of dumping every stored memory.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';
import { indexLine } from './disclosure.js';
import { relevance } from './retention.js';
import { search } from './search.js';
import { recentSessions } from './sessions.js';
import { estimateTokens, listObservations, recordAccess, scoringContexts } from './store.js';
import type { Observation, ProjectInfo } from './types.js';

export type LensId = 'bugfix' | 'feature' | 'refactor' | 'release' | 'docs' | 'test' | 'onboarding' | 'general';

interface Lens {
  id: LensId;
  pattern: RegExp;
  advice: string;
  verify: string[];
  cautionTypes: Observation['type'][];
}

const LENSES: Lens[] = [
  { id: 'bugfix', pattern: /\b(bug|fix|error|crash|fail(s|ing|ure)?|broken|regression|exception|debug|issue)\b/i,
    advice: 'Reproduce with current code first; check past fixes and gotchas before changing anything.',
    verify: ['Reproduce the failure', 'Add/extend a regression test', 'Run the relevant test suite'],
    cautionTypes: ['gotcha', 'problem-solution'] },
  { id: 'release', pattern: /\b(release|publish|version|changelog|tag|ship|deploy)\b/i,
    advice: 'Use current package metadata and changelog; prior release gotchas matter most.',
    verify: ['Build from clean', 'Run full tests', 'Check version + changelog'],
    cautionTypes: ['gotcha', 'decision'] },
  { id: 'refactor', pattern: /\b(refactor|restructure|rename|clean ?up|extract|simplify|reorganize)\b/i,
    advice: 'Read shared code, call sites and tests; respect recorded decisions and trade-offs.',
    verify: ['Type-check', 'Run tests touching moved code'],
    cautionTypes: ['decision', 'trade-off', 'gotcha'] },
  { id: 'test', pattern: /\b(test|tests|spec|coverage|flaky|e2e)\b/i,
    advice: 'Follow existing test conventions; check known flaky or environment gotchas.',
    verify: ['Run the new tests', 'Run the suite once more for flakiness'],
    cautionTypes: ['gotcha'] },
  { id: 'docs', pattern: /\b(docs?|readme|documentation|guide|explain)\b/i,
    advice: 'Document against current code and public entry points, not old memory text.',
    verify: ['Check examples actually run'],
    cautionTypes: ['decision'] },
  { id: 'onboarding', pattern: /\b(onboard|overview|understand|architecture|how does|walk ?through|explore|new to)\b/i,
    advice: 'Understand the project shape first; treat old implementation details as hints.',
    verify: [],
    cautionTypes: ['decision', 'why-it-exists'] },
  { id: 'feature', pattern: /\b(add|implement|build|create|feature|support|new|introduce)\b/i,
    advice: 'Start from nearby source, types and user flow; reuse recorded decisions.',
    verify: ['Type-check', 'Add tests for the new behaviour'],
    cautionTypes: ['decision', 'gotcha', 'trade-off'] },
];

export function detectLens(task: string): Lens | { id: 'general'; advice: string; verify: string[]; cautionTypes: Observation['type'][] } {
  for (const l of LENSES) if (l.pattern.test(task)) return l;
  return { id: 'general', advice: 'Use memory as background; current code and the user request win.', verify: [], cautionTypes: ['gotcha', 'decision'] };
}

export interface ContextBrief {
  lens: LensId;
  text: string;
  tokens: number;
  memoryIds: number[];
  startFiles: string[];
}

export function buildProjectContext(db: DB, project: ProjectInfo, task: string, opts: { maxTokens?: number } = {}): ContextBrief {
  const maxTokens = opts.maxTokens ?? 1200;
  const lens = detectLens(task);
  const total = (db.prepare("SELECT COUNT(*) AS n FROM observations WHERE projectId = ? AND status = 'active'").get(project.id) as { n: number }).n;

  const lines: string[] = [`# Synapse brief — ${project.name}`, `Task lens: ${lens.id} — ${lens.advice}`];
  if (Number(total) === 0) {
    lines.push('', 'No memories stored for this project yet (fresh project). Store decisions, gotchas and fixes as you go.');
    const text = lines.join('\n');
    return { lens: lens.id, text, tokens: estimateTokens(text), memoryIds: [], startFiles: [] };
  }

  const relevant = task.trim()
    ? search(db, { query: task, projectId: project.id, limit: 8 }).filter((h) => h.lexical > 0.05).map((h) => h.observation)
    : [];

  // Cautions: highest-relevance qualified memories of the lens' caution types.
  const pool = listObservations(db, { projectId: project.id, type: lens.cautionTypes, includeCandidates: false, limit: 200 });
  const ctx = scoringContexts(db, pool.map((o) => o.id));
  const relevantIds = new Set(relevant.map((o) => o.id));
  const cautions = pool
    .filter((o) => !relevantIds.has(o.id))
    .map((o) => ({ o, s: relevance(o, ctx.get(o.id)) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 4)
    .map((x) => x.o);

  // Start-here files: frequency-weighted from relevant memories, only if they still exist.
  const fileScore = new Map<string, number>();
  // A memory's weight is split across its files, so one wide change can't flood the list.
  relevant.forEach((o, rank) => {
    const share = (relevant.length - rank) / Math.max(1, o.filesModified.length);
    for (const f of o.filesModified) fileScore.set(f, (fileScore.get(f) ?? 0) + share);
  });
  const startFiles = [...fileScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f)
    .filter((f) => existsSync(path.isAbsolute(f) ? f : path.join(project.rootPath, f)))
    .slice(0, 6);

  const sessions = recentSessions(db, project.id, 1);
  const inProgress = listObservations(db, { projectId: project.id, limit: 50, includeCandidates: false })
    .filter((o) => o.progress && o.progress.status !== 'completed')
    .slice(0, 3);

  const sections: [string, string[]][] = [
    ['Start here', startFiles.map((f) => `- ${f}`)],
    ['Relevant memories', relevant.map((o) => `- ${indexLine(o)}`)],
    ['Cautions', cautions.map((o) => `- ${indexLine(o)}`)],
    ['In progress', inProgress.map((o) => `- ${o.progress!.feature}: ${o.progress!.status}${o.progress!.completion != null ? ` ${o.progress!.completion}%` : ''} (#${o.id})`)],
    ['Last session', sessions.map((s) => `- ${(s.endedAt ?? s.startedAt).slice(0, 10)}: ${s.summary}`)],
    ['Verify', lens.verify.map((v) => `- ${v}`)],
  ];

  let used = estimateTokens(lines.join('\n'));
  for (const [title, body] of sections) {
    if (body.length === 0) continue;
    const block = ['', `## ${title}`];
    for (const line of body) {
      const t = estimateTokens(line);
      if (used + t > maxTokens) break;
      block.push(line);
      used += t;
    }
    if (block.length > 2) lines.push(...block);
  }
  lines.push('', `${total} active memories. Use synapse_detail for full records; current code wins over memory.`);

  const memoryIds = [...relevant, ...cautions].map((o) => o.id);
  recordAccess(db, relevant.map((o) => o.id));
  const text = lines.join('\n');
  return { lens: lens.id, text, tokens: estimateTokens(text), memoryIds, startFiles };
}
