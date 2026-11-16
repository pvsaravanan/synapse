/**
 * Three-layer progressive disclosure:
 *   L1 index    – one compact line per hit (~20-40 tokens)       -> synapse_search
 *   L2 timeline – chronological neighbours around one memory      -> synapse_timeline
 *   L3 detail   – full narrative, facts, files, provenance        -> synapse_detail
 * Agents read cheap indexes first and expand only what they need.
 */
import { estimateTokens } from './store.js';
import { TYPE_LABEL, type Observation, type SearchHit } from './types.js';

function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

export function indexLine(o: Observation): string {
  const flags = [
    o.status !== 'active' ? o.status : '',
    o.admissionState === 'candidate' ? 'candidate' : '',
    o.revisionCount > 1 ? `rev${o.revisionCount}` : '',
  ].filter(Boolean);
  return `#${o.id} ${shortDate(o.updatedAt ?? o.createdAt)} [${TYPE_LABEL[o.type] ?? o.type}] ${o.entityName}: ${o.title}` +
    (flags.length ? ` (${flags.join(', ')})` : '') + ` ~${o.tokens}t`;
}

export function formatIndex(hits: SearchHit[], opts: { query?: string; global?: boolean; maxTokens?: number } = {}): string {
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const h of hits) {
    const line = (opts.global ? `[${h.observation.projectId}] ` : '') + indexLine(h.observation);
    const t = estimateTokens(line);
    if (opts.maxTokens && used + t > opts.maxTokens) {
      omitted++;
      continue;
    }
    used += t;
    lines.push(line);
  }
  const header = opts.query ? `Synapse results for "${opts.query}" (${lines.length})` : `Synapse memories (${lines.length})`;
  const footer = [
    omitted ? `${omitted} more omitted by token budget.` : '',
    'Expand with synapse_detail { ids: [...] } or synapse_timeline { anchorId }.',
  ].filter(Boolean);
  return [header, ...lines, '', ...footer].join('\n');
}

export function formatDetail(o: Observation): string {
  const out: string[] = [];
  out.push(`#${o.id} [${TYPE_LABEL[o.type] ?? o.type}] ${o.title}`);
  out.push(`entity: ${o.entityName} · project: ${o.projectId} · status: ${o.status} · source: ${o.source}` +
    (o.admissionState === 'candidate' ? ' · candidate (auto-captured, unreviewed)' : ''));
  out.push(`created: ${o.createdAt}` + (o.updatedAt ? ` · updated: ${o.updatedAt}` : '') + (o.revisionCount > 1 ? ` · revisions: ${o.revisionCount}` : ''));
  if (o.topicKey) out.push(`topicKey: ${o.topicKey}`);
  if (o.progress) out.push(`progress: ${o.progress.feature} — ${o.progress.status}${o.progress.completion != null ? ` (${o.progress.completion}%)` : ''}`);
  out.push('', o.narrative || '(no narrative)');
  if (o.facts.length) out.push('', 'Facts:', ...o.facts.map((f) => `- ${f}`));
  if (o.filesModified.length) out.push('', `Files: ${o.filesModified.join(', ')}`);
  if (o.concepts.length) out.push(`Concepts: ${o.concepts.join(', ')}`);
  if (o.commitHash) out.push(`Commit: ${o.commitHash}`);
  if (o.relatedCommits.length) out.push(`Related commits: ${o.relatedCommits.join(', ')}`);
  if (o.relatedEntities.length) out.push(`Related entities: ${o.relatedEntities.join(', ')}`);
  if (o.supersededBy) out.push(`Superseded by: #${o.supersededBy}`);
  return out.join('\n');
}

export function formatTimeline(t: { anchor?: Observation; before: Observation[]; after: Observation[] }): string {
  if (!t.anchor) return 'Anchor memory not found.';
  return [
    ...t.before.map((o) => `  ${indexLine(o)}`),
    `> ${indexLine(t.anchor)}`,
    ...t.after.map((o) => `  ${indexLine(o)}`),
  ].join('\n');
}
