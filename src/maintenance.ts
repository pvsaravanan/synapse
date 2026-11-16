import type { DB } from './db.js';
import { retentionZone, type RetentionZone } from './retention.js';
import { listObservations, rowToObservation, scoringContexts, setStatus, storeObservation } from './store.js';
import type { Observation, StoreInput } from './types.js';

export interface RetentionReport {
  zones: Record<RetentionZone, number>;
  archiveCandidates: Observation[];
}

export function retentionReport(db: DB, projectId: string): RetentionReport {
  const obs = listObservations(db, { projectId, limit: 100_000 });
  const ctx = scoringContexts(db, obs.map((o) => o.id));
  const zones: Record<RetentionZone, number> = { active: 0, stale: 0, 'archive-candidate': 0 };
  const archiveCandidates: Observation[] = [];
  for (const o of obs) {
    const z = retentionZone(o, ctx.get(o.id));
    zones[z]++;
    if (z === 'archive-candidate') archiveCandidates.push(o);
  }
  return { zones, archiveCandidates };
}

export function archiveExpired(db: DB, projectId: string, dryRun = false): number[] {
  const ids = retentionReport(db, projectId).archiveCandidates.map((o) => o.id);
  if (!dryRun) setStatus(db, ids, 'archived', projectId);
  return ids;
}

export interface ExportBundle {
  format: 'synapse-export';
  version: 1;
  exportedAt: string;
  projectId: string;
  observations: Observation[];
  sessions: Record<string, unknown>[];
}

export function exportProject(db: DB, projectId: string): ExportBundle {
  const observations = (db.prepare('SELECT * FROM observations WHERE projectId = ? ORDER BY id').all(projectId) as Record<string, unknown>[]).map(rowToObservation);
  const sessions = db.prepare('SELECT * FROM sessions WHERE projectId = ? ORDER BY startedAt').all(projectId) as Record<string, unknown>[];
  return { format: 'synapse-export', version: 1, exportedAt: new Date().toISOString(), projectId, observations, sessions };
}

/** Import a bundle into a (possibly different) project. Dedup/topic rules apply. */
export function importBundle(db: DB, bundle: ExportBundle, targetProjectId?: string): { imported: number; merged: number } {
  if (bundle?.format !== 'synapse-export') throw new Error('Not a synapse export bundle');
  const projectId = targetProjectId ?? bundle.projectId;
  let imported = 0;
  let merged = 0;
  db.exec('BEGIN');
  try {
    for (const o of bundle.observations) {
      const input: StoreInput = {
        projectId,
        entityName: o.entityName,
        type: o.type,
        title: o.title,
        narrative: o.narrative,
        facts: o.facts,
        filesModified: o.filesModified,
        concepts: o.concepts,
        topicKey: o.topicKey,
        progress: o.progress,
        source: o.source,
        commitHash: o.commitHash,
        relatedCommits: o.relatedCommits,
        relatedEntities: o.relatedEntities,
        admissionState: o.admissionState,
        valueCategory: o.valueCategory,
      };
      const r = storeObservation(db, input);
      if (o.status !== 'active') setStatus(db, [r.observation.id], o.status);
      if (r.action === 'created') imported++;
      else merged++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { imported, merged };
}
