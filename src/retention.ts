/**
 * Relevance decay model:
 *   score = baseImportance * e^(-ageDays / retentionDays) * accessBoost * feedbackMultiplier
 */
import type { Observation } from './types.js';

export type Importance = 'critical' | 'high' | 'medium' | 'low';

const RETENTION_DAYS: Record<Importance, number> = { critical: 365, high: 180, medium: 90, low: 30 };
const BASE: Record<Importance, number> = { critical: 1.0, high: 0.8, medium: 0.5, low: 0.3 };

const TYPE_IMPORTANCE: Record<string, Importance> = {
  gotcha: 'high',
  decision: 'high',
  'trade-off': 'high',
  reasoning: 'high',
  'problem-solution': 'medium',
  'how-it-works': 'medium',
  'why-it-exists': 'medium',
  'what-changed': 'low',
  discovery: 'low',
  'session-request': 'low',
};

const PROTECTED_CONCEPTS = new Set(['keep', 'important', 'pinned', 'critical']);
const MIN_RETENTION_DAYS = 7;
const IMMUNITY_ACCESS = 3;

export interface ScoringContext {
  accessCount?: number;
  /** Net feedback: +1 per helpful/verified, -1 per conflicted/outdated/corrected. */
  feedbackWeight?: number;
}

export function importanceOf(obs: Pick<Observation, 'type' | 'concepts' | 'valueCategory'>): Importance {
  if (obs.concepts.some((c) => PROTECTED_CONCEPTS.has(c.toLowerCase()))) return 'critical';
  return TYPE_IMPORTANCE[obs.type] ?? 'medium';
}

export function effectiveRetentionDays(obs: Observation): number {
  let days = RETENTION_DAYS[importanceOf(obs)];
  if (obs.source === 'hook') days *= 0.5;
  if (obs.source === 'git') days *= 1.5;
  if (obs.valueCategory === 'ephemeral') days *= 0.5;
  if (obs.valueCategory === 'core') days *= 2;
  return Math.max(MIN_RETENTION_DAYS, days);
}

export function isImmune(obs: Observation, ctx: ScoringContext = {}): boolean {
  if (importanceOf(obs) === 'critical') return true;
  if (obs.valueCategory === 'core') return true;
  return (ctx.accessCount ?? 0) >= IMMUNITY_ACCESS;
}

export function feedbackMultiplier(weight = 0): number {
  return Math.min(1.6, Math.max(0.4, 1 + 0.15 * weight));
}

export function relevance(obs: Observation, ctx: ScoringContext = {}, now: Date = new Date()): number {
  const ref = obs.updatedAt ?? obs.createdAt;
  const ageDays = Math.max(0, (now.getTime() - new Date(ref).getTime()) / 86_400_000);
  const decay = Math.exp(-ageDays / effectiveRetentionDays(obs));
  const accessBoost = Math.min(2, 1 + 0.1 * (ctx.accessCount ?? 0));
  let score = BASE[importanceOf(obs)] * decay * accessBoost * feedbackMultiplier(ctx.feedbackWeight);
  if (isImmune(obs, ctx)) score = Math.max(score, 0.5);
  return score;
}

export type RetentionZone = 'active' | 'stale' | 'archive-candidate';

export function retentionZone(obs: Observation, ctx: ScoringContext = {}, now: Date = new Date()): RetentionZone {
  if (isImmune(obs, ctx)) return 'active';
  const ageDays = (now.getTime() - new Date(obs.updatedAt ?? obs.createdAt).getTime()) / 86_400_000;
  const days = effectiveRetentionDays(obs);
  if (ageDays > days) return 'archive-candidate';
  if (ageDays > days * 0.5) return 'stale';
  return 'active';
}
