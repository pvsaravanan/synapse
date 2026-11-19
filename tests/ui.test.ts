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
import { getObservation, storeObservation } from '../src/store.js';
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
});
