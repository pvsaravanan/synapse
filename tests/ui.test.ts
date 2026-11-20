/**
 * `synapse ui`: the local server's API, its access checks, and the page it serves.
 */
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../src/db.js';
import { proposeLongTerm } from '../src/longterm.js';
import { detectProject } from '../src/project.js';
import { getObservation, listObservations, recordAccess, storeObservation } from '../src/store.js';
import { startUi } from '../src/ui.js';

let db: DB;
let dir: string;
let server: Server;
let base: string;
let token: string;
beforeEach(async () => {
  db = openDatabase(':memory:');
  dir = mkdtempSync(path.join(os.tmpdir(), 'syn-ui-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src/limit.ts'), 'export const LIMIT = 10;\n');
  const project = detectProject(dir);
  storeObservation(db, { projectId: project.id, entityName: 'api', type: 'gotcha', title: 'Rate limit is per API key', narrative: 'Not per IP', filesModified: ['src/limit.ts'], rootPath: project.rootPath });
  storeObservation(db, { projectId: project.id, entityName: 'api', type: 'what-changed', title: 'Edited src/limit.ts', narrative: 'x', source: 'hook', admissionState: 'candidate', topicKey: 'hook/file/src/limit.ts/s1' });
  storeObservation(db, { projectId: 'other/repo', entityName: 'x', type: 'decision', title: 'Other project decision', narrative: 'n' });
  const started = await startUi({ db, project });
  server = started.server;
  token = new URL(started.url).hash.replace('#t=', '');
  base = started.url.replace(/\/#t=.*$/, '');
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const api = async (p: string, post?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + p, post === undefined
    ? { headers: { 'x-synapse-token': token, ...headers } }
    : { method: 'POST', headers: { 'x-synapse-token': token, 'content-type': 'application/json', ...headers }, body: JSON.stringify(post) });
  return { status: res.status, body: await res.json() as any };
};
const project = () => detectProject(dir);
const listAll = () => listObservations(db, { projectId: project().id, limit: 50, status: 'all' });

describe('synapse ui server', () => {
  it('serves the page on 127.0.0.1 with a strict content security policy', async () => {
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(base + '/');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const page = await res.text();
    expect(page).toContain('<title>Synapse</title>');
    expect(page).toContain('src="data:image/png;base64,'); // the logo is inlined
    expect(page).toContain('url("data:font/woff2;base64,'); // and so is the Plus Jakarta Sans font
    expect(res.headers.get('content-security-policy')).toContain('font-src data:');
    expect(page).not.toMatch(/(src|href)="https?:/); // and nothing loads from outside
  });

  it('counts memories per type ignoring the type filter, and filters curated vs candidate', async () => {
    const all = (await api('/api/memories')).body;
    expect(all.byType).toEqual({ gotcha: 1, 'what-changed': 1 });
    const gotchas = (await api('/api/memories?type=gotcha')).body;
    expect(gotchas.items.map((m: any) => m.title)).toEqual(['Rate limit is per API key']);
    expect(gotchas.total).toBe(1);
    expect(gotchas.byType).toEqual({ gotcha: 1, 'what-changed': 1 });
    const curated = (await api('/api/memories?admission=qualified')).body;
    expect(curated.items.map((m: any) => m.title)).toEqual(['Rate limit is per API key']);
    expect(curated.byType).toEqual({ gotcha: 1 });
  });

  it('rejects API calls without the token, and requests addressed to a non-local host', async () => {
    expect((await api('/api/state', undefined, { 'x-synapse-token': 'wrong' })).status).toBe(401);
    const status = await new Promise<number>((resolve) => {
      const u = new URL(base);
      request({ host: u.hostname, port: u.port, path: '/api/state', headers: { host: 'evil.example', 'x-synapse-token': token } }, (res) => resolve(res.statusCode!)).end();
    });
    expect(status).toBe(403);
    expect((await api('/api/memory/qualify', { id: 1 }, { 'content-type': 'text/plain' })).status).toBe(415);
  });

  it('lists projects and memories, searches, filters, and flags changed files for the current project', async () => {
    const state = (await api('/api/state')).body;
    expect(state.current).toBe(project().id);
    expect(state.projects.map((p: any) => p.projectId).sort()).toEqual([project().id, 'other/repo'].sort());
    expect((await api('/api/memories')).body.total).toBe(2);
    expect((await api('/api/memories?q=rate+limit')).body.items.map((m: any) => m.title)).toContain('Rate limit is per API key');
    expect((await api('/api/memories?admission=candidate')).body.items.map((m: any) => m.title)).toEqual(['Edited src/limit.ts']);
    expect((await api('/api/memories?project=other%2Frepo')).body.items.map((m: any) => m.title)).toEqual(['Other project decision']);
    writeFileSync(path.join(dir, 'src/limit.ts'), 'export const LIMIT = 20;\n');
    const changed = (await api('/api/memories?changed=1')).body.items;
    expect(changed.map((m: any) => [m.title, m.changes])).toEqual([['Rate limit is per API key', [{ file: 'src/limit.ts', change: 'modified' }]]]);
    expect((await api('/api/stats')).body).toMatchObject({ candidates: 1, stale: 1 });
  });

  it('shows a memory in full and applies actions: verified, qualify, resolve, reopen', async () => {
    const id = (await api('/api/memories?q=rate')).body.items[0].id;
    writeFileSync(path.join(dir, 'src/limit.ts'), 'changed');
    const detail = (await api(`/api/memory?id=${id}`)).body;
    expect(detail).toMatchObject({ title: 'Rate limit is per API key', narrative: 'Not per IP', changes: [{ file: 'src/limit.ts', change: 'modified' }] });
    await api('/api/memory/feedback', { id, signal: 'verified' });
    expect((await api(`/api/memory?id=${id}`)).body.changes).toEqual([]);
    const cand = (await api('/api/memories?admission=candidate')).body.items[0].id;
    await api('/api/memory/qualify', { id: cand });
    expect(getObservation(db, cand)!.admissionState).toBe('qualified');
    await api('/api/memory/status', { id, status: 'resolved' });
    expect(getObservation(db, id)!.status).toBe('resolved');
    await api('/api/memory/status', { id, status: 'active' });
    expect(getObservation(db, id)!.status).toBe('active');
    expect((await api('/api/memory/status', { id, status: 'deleted' })).status).toBe(400);
    expect((await api('/api/memory?id=99999')).status).toBe(404);
  });

  it('reviews long-term proposals, requiring a reason', async () => {
    const lt = proposeLongTerm(db, { projectId: project().id, kind: 'procedural', title: 'Run the release checklist', body: 'Tag, build, publish', proposedBy: 'agent' }).item;
    expect((await api('/api/longterm')).body.map((i: any) => i.title)).toEqual(['Run the release checklist']);
    expect((await api('/api/longterm/review', { id: lt.id, action: 'approve', reason: ' ' })).status).toBe(400);
    const approved = (await api('/api/longterm/review', { id: lt.id, action: 'approve', reason: 'Confirmed with the team' })).body;
    expect(approved.state).toBe('approved');
    expect(approved.reason).toContain('via synapse ui');
    expect((await api('/api/longterm?state=approved')).body).toHaveLength(1);
  });

  it('lists sessions with their records', async () => {
    db.prepare("INSERT INTO sessions(id, projectId, startedAt, status, agent, summary) VALUES('s1', ?, ?, 'completed', 'claude-code', 'Goal: tune limits')").run(project().id, new Date().toISOString());
    db.prepare("UPDATE observations SET sessionId = 's1' WHERE title = 'Edited src/limit.ts'").run();
    const sessions = (await api('/api/sessions')).body;
    expect(sessions[0]).toMatchObject({ id: 's1', agent: 'claude-code', summary: 'Goal: tune limits', memories: 1 });
    expect((await api('/api/session?id=s1')).body.items.map((m: any) => m.title)).toEqual(['Edited src/limit.ts']);
    expect((await api('/api/stats')).body.sessions).toBe(1);
  });

  it('maps curated memories to their components and files, with candidates, concepts and limits on request', async () => {
    storeObservation(db, { projectId: project().id, entityName: 'billing', type: 'decision', title: 'Bill per key', narrative: 'n', filesModified: ['./src/limit.ts'], relatedEntities: ['api'], concepts: ['quota', 'pinned'] });
    const ids = (g: any) => g.nodes.map((n: any) => n.id).sort();
    const g = (await api('/api/graph')).body;
    expect(ids(g)).toEqual(['e:api', 'e:billing', 'f:src/limit.ts', expect.stringMatching(/^m:/), expect.stringMatching(/^m:/)]);
    expect(g.nodes.find((n: any) => n.id === 'f:src/limit.ts').degree).toBe(2); // shared by both memories, './' dropped
    expect(g.links).toContainEqual(expect.objectContaining({ target: 'e:api', kind: 'related' }));
    expect(g.memories.map((m: any) => m.title).sort()).toEqual(['Bill per key', 'Rate limit is per API key']);
    expect(g.memories.find((m: any) => m.title === 'Rate limit is per API key').changes).toEqual([]);
    expect(g.truncated).toBe(false);

    const withCandidates = (await api('/api/graph?candidates=1')).body;
    expect(withCandidates.memories).toHaveLength(3);
    const concepts = (await api('/api/graph?concepts=1&files=0')).body;
    expect(ids(concepts).filter((id: string) => !id.startsWith('m:'))).toEqual(['c:quota', 'e:api', 'e:billing']); // no files, no "pinned"
    const limited = (await api('/api/graph?limit=1')).body;
    expect(limited).toMatchObject({ truncated: true });
    expect(limited.memories).toHaveLength(1);
    expect(ids((await api('/api/graph?project=other/repo')).body)).toEqual(['e:x', expect.stringMatching(/^m:/)]);
  });

  it('edits a memory: redacts secrets, validates the type, re-hashes new files, and can keep a candidate', async () => {
    const cand = listAll().find((o) => o.admissionState === 'candidate')!;
    const res = await api('/api/memory/edit', { id: cand.id, title: 'Limits are per key', narrative: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 in env', type: 'gotcha', entity: 'api', facts: ['Per key'], files: ['./src/limit.ts'], concepts: ['Rate'], qualify: true });
    expect(res).toMatchObject({ status: 200, body: { ok: true } });
    const o = getObservation(db, cand.id)!;
    expect(o).toMatchObject({ title: 'Limits are per key', type: 'gotcha', admissionState: 'qualified', facts: ['Per key'], filesModified: ['src/limit.ts'], concepts: ['rate'], revisionCount: 2 });
    expect(o.narrative).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(Object.keys(o.fileHashes)).toEqual(['src/limit.ts']);
    expect((await api('/api/memory/edit', { id: cand.id, type: 'nonsense' })).status).toBe(400);
    expect((await api('/api/memory/edit', { id: cand.id, title: '  ' })).status).toBe(400);
    expect((await api('/api/memory/edit', { id: cand.id, facts: 'not a list' })).status).toBe(400);
    expect((await api('/api/memory/edit', { id: 99999, title: 'x' })).status).toBe(404);
  });

  it('suggests similar memories and merges duplicates into one, archiving the others', async () => {
    const p = project();
    const keep = listAll().find((o) => o.title === 'Rate limit is per API key')!;
    const dup = storeObservation(db, { projectId: p.id, entityName: 'billing', type: 'decision', title: 'Rate limit applies per API key', narrative: 'Limits count requests per key, not per IP address', facts: ['Window: 60s'], filesModified: ['src/billing.ts'] }).observation;
    recordAccess(db, [dup.id, dup.id]);
    const similar = (await api(`/api/memory/similar?id=${keep.id}`)).body;
    expect(similar[0]).toMatchObject({ id: dup.id, score: expect.any(Number) });
    expect(similar.map((x: any) => x.id)).not.toContain(keep.id);

    expect((await api('/api/memory/merge', { into: keep.id, from: [dup.id] })).body).toEqual({ ok: true, id: keep.id });
    const merged = getObservation(db, keep.id)!;
    expect(merged.narrative).toContain(`#### Merged from #${dup.id}: Rate limit applies per API key`);
    expect(merged.filesModified.sort()).toEqual(['src/billing.ts', 'src/limit.ts']);
    expect(merged.facts).toEqual(['Window: 60s']);
    expect(merged.relatedEntities).toEqual(['billing']);
    expect(getObservation(db, dup.id)).toMatchObject({ status: 'archived', supersededBy: keep.id });
    expect(db.prepare('SELECT accessCount FROM observation_access WHERE observationId = ?').get(keep.id)).toEqual({ accessCount: 2 });
    expect((await api('/api/memory/merge', { into: keep.id, from: [] })).status).toBe(400);
    const other = listObservations(db, { projectId: 'other/repo', limit: 5 })[0];
    expect((await api('/api/memory/merge', { into: keep.id, from: [other.id] })).body.error).toMatch(/another project/);
  });

  it('serves the diff of a flagged memory\'s files, only for the project it was started in', async () => {
    const flagged = listAll().find((o) => o.title === 'Rate limit is per API key')!;
    writeFileSync(path.join(dir, 'src/limit.ts'), 'export const LIMIT = 20;\n');
    const res = (await api(`/api/memory/diff?id=${flagged.id}`)).body;
    expect(res.files).toEqual([expect.objectContaining({ file: 'src/limit.ts', change: 'modified', note: expect.stringMatching(/not a git repository/) })]);
    const other = listObservations(db, { projectId: 'other/repo', limit: 5 })[0];
    expect((await api(`/api/memory/diff?id=${other.id}`)).body).toEqual({ files: [], note: expect.stringMatching(/only available for/) });
    expect((await api('/api/memory/diff?id=99999')).status).toBe(404);
  });

  it('reports usage and proposes a read-often memory for long-term memory', async () => {
    const keep = listAll().find((o) => o.title === 'Rate limit is per API key')!;
    recordAccess(db, [keep.id, keep.id, keep.id]);
    const u = (await api('/api/usage?days=7')).body;
    expect(u).toMatchObject({ days: 7, totals: { curated: 1, readInWindow: 1, notRead: 0 } });
    expect(u.often[0]).toMatchObject({ id: keep.id, reads: 3, promote: true, kind: 'semantic', longTerm: null });
    expect((await api('/api/usage?days=12345')).body.days).toBe(30); // unknown windows fall back to 30

    const p = (await api('/api/memory/promote', { id: keep.id })).body;
    expect(p).toMatchObject({ ok: true, state: 'proposed', action: 'proposed' });
    expect((await api('/api/memory/promote', { id: keep.id })).body.action).toBe('exists');
    expect((await api('/api/usage')).body.often[0]).toMatchObject({ longTerm: { id: p.id, state: 'proposed' }, promote: false });
    expect((await api('/api/memory/promote', { id: keep.id, kind: 'nope' })).status).toBe(400);
  });
});
