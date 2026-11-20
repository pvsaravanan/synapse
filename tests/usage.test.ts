/**
 * Usage: which curated memories get read and rated helpful, which haven't been read in N days, and which are too new
 * to judge.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../src/db.js';
import { promoteToLongTerm } from '../src/longterm.js';
import { recordFeedback, storeObservation } from '../src/store.js';
import { suggestedKind, usageReport } from '../src/usage.js';

const P = 'acme/app';
const NOW = new Date('2026-06-30T12:00:00Z');
let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
});

/** A curated memory stored `ageDays` ago, read `reads` times, last `lastReadDays` ago. */
function memory(title: string, ageDays: number, reads = 0, lastReadDays?: number, extra: Record<string, unknown> = {}) {
  const o = storeObservation(db, { projectId: P, entityName: title.split(' ')[0], type: 'gotcha', title, narrative: title, ...extra }).observation;
  const at = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
  db.prepare('UPDATE observations SET createdAt = ? WHERE id = ?').run(at(ageDays), o.id);
  if (reads) db.prepare('INSERT INTO observation_access(observationId, accessCount, lastAccessed) VALUES(?, ?, ?)').run(o.id, reads, at(lastReadDays ?? 0));
  return o;
}

describe('usage report', () => {
  it('sorts memories into read often, not read in N days, too new to judge and rated wrong', () => {
    const hot = memory('auth tokens expire hourly', 60, 9, 1);
    const rated = memory('billing retries are idempotent', 60, 1, 2);
    recordFeedback(db, rated.id, 'helpful');
    const stale = memory('cache uses redis', 90, 2, 45);
    const never = memory('deploy needs a tag', 40);
    const fresh = memory('search ranks by bm25', 3);
    const wrong = memory('queue is fifo', 50, 1, 5);
    recordFeedback(db, wrong.id, 'conflicted');
    memory('candidate noise', 60, 0, undefined, { source: 'hook', admissionState: 'candidate' });

    const r = usageReport(db, P, { days: 30, now: NOW });
    expect(r.totals).toEqual({ curated: 6, readInWindow: 3, notRead: 2, notReadYet: 1, helpful: 1, neverRead: 2 });
    expect(r.often.map((u) => u.observation.id)).toEqual([hot.id, rated.id, stale.id, wrong.id]); // reads + 2 per helpful rating
    expect(r.often[0]).toMatchObject({ reads: 9, promote: true });
    expect(r.often.find((u) => u.observation.id === rated.id)!.promote).toBe(true); // rated helpful
    expect(r.often.find((u) => u.observation.id === wrong.id)!.promote).toBe(false); // rated wrong
    expect(r.often.find((u) => u.observation.id === stale.id)!.promote).toBe(false); // 2 reads, under half of the top 9
    expect(r.notRead.map((u) => u.observation.id)).toEqual([never.id, stale.id]); // never read first, then fewest reads
    expect(r.notReadYet.map((u) => u.observation.id)).toEqual([fresh.id]);
    expect(r.ratedWrong.map((u) => u.observation.id)).toEqual([wrong.id]);
    expect(usageReport(db, P, { days: 90, now: NOW }).totals.notRead).toBe(0); // nothing was stored before a 90-day window but unread in it
  });

  it('marks memories that are already long-term memory, and suggests a kind per type', () => {
    const hot = memory('auth tokens expire hourly', 60, 9, 1);
    const { item } = promoteToLongTerm(db, P, hot.id, { kind: 'semantic' });
    const [u] = usageReport(db, P, { now: NOW }).often;
    expect(u).toMatchObject({ longTerm: { id: item.id, state: 'proposed' }, promote: false });
    expect([suggestedKind('gotcha'), suggestedKind('problem-solution'), suggestedKind('what-changed')]).toEqual(['semantic', 'procedural', 'episodic']);
  });
});
