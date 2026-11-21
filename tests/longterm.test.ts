import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildProjectContext } from '../src/context.js';
import { openDatabase, type DB } from '../src/db.js';
import {
  approvedForBrief,
  getLongTerm,
  listLongTerm,
  pendingLongTermCount,
  promoteToLongTerm,
  proposeLongTerm,
  reviewLongTerm,
  supersedeLongTerm,
} from '../src/longterm.js';
import { exportProject } from '../src/maintenance.js';
import { createServer } from '../src/server.js';
import { storeObservation } from '../src/store.js';
import type { ProjectInfo } from '../src/types.js';

const A = 'acme/app';
const B = 'acme/other';
let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
});

const propose = (over: Partial<Parameters<typeof proposeLongTerm>[1]> = {}) =>
  proposeLongTerm(db, { projectId: A, kind: 'procedural', title: 'Release steps', body: 'Build, run tests, tag, push.', ...over }).item;

describe('long-term memory', () => {
  it('proposes, dedupes by title, and requires a reason for every review action', () => {
    const p = propose();
    expect(p.state).toBe('proposed');
    expect(proposeLongTerm(db, { projectId: A, kind: 'procedural', title: 'release STEPS', body: 'other' }).action).toBe('exists');
    expect(() => reviewLongTerm(db, A, p.id, 'approve', '  ')).toThrow(/reason/);
    const ok = reviewLongTerm(db, A, p.id, 'approve', 'User confirmed the release checklist');
    expect(ok.state).toBe('approved');
    expect(ok.reason).toBe('User confirmed the release checklist');
    expect(ok.reviewedAt).toBeTruthy();
    expect(() => reviewLongTerm(db, A, p.id, 'approve', 'again')).toThrow(/is approved/);
    expect(reviewLongTerm(db, A, p.id, 'archive', 'Process changed').state).toBe('archived');
    // An archived title no longer blocks a new proposal.
    expect(proposeLongTerm(db, { projectId: A, kind: 'procedural', title: 'Release steps', body: 'New process' }).action).toBe('proposed');
  });

  it('validates input and redacts secrets', () => {
    expect(() => proposeLongTerm(db, { projectId: A, kind: 'semantic', title: '', body: 'x' })).toThrow(/required/);
    expect(() => proposeLongTerm(db, { projectId: A, kind: 'nope' as never, title: 't', body: 'x' })).toThrow(/kind/);
    const p = propose({ title: 'Deploy key', body: 'Use token=abcdef1234567890 for deploys', evidence: ['password=hunter2hunter2'] });
    expect(p.body).toContain('[REDACTED]');
    expect(p.evidence[0]).toContain('[REDACTED]');
  });

  it('supersedes an approved item with a live replacement', () => {
    const old = propose();
    reviewLongTerm(db, A, old.id, 'approve', 'confirmed');
    const next = propose({ title: 'Release steps v2', body: 'Build, test, changelog, tag, push.' });
    expect(() => supersedeLongTerm(db, A, next.id, old.id, 'x')).toThrow(/only approved/);
    expect(() => supersedeLongTerm(db, A, old.id, old.id, 'x')).toThrow(/itself/);
    const s = supersedeLongTerm(db, A, old.id, next.id, 'Changelog step added');
    expect(s.state).toBe('superseded');
    expect(s.supersededBy).toBe(next.id);
    expect(listLongTerm(db, A, { state: 'approved' })).toHaveLength(0);
  });

  it('keeps project items to their project and shares user-scope items everywhere', () => {
    const proj = propose({ title: 'Billing uses Stripe', kind: 'semantic', body: 'Stripe for billing' });
    const user = propose({ title: 'Prefer small commits', kind: 'semantic', body: 'User prefers small focused commits', scope: 'user' });
    reviewLongTerm(db, A, proj.id, 'approve', 'confirmed');
    reviewLongTerm(db, A, user.id, 'approve', 'User stated this preference');
    expect(listLongTerm(db, B, { state: 'approved' }).map((i) => i.id)).toEqual([user.id]);
    expect(getLongTerm(db, B, proj.id)).toBeUndefined();
    expect(() => reviewLongTerm(db, B, proj.id, 'archive', 'x')).toThrow(/not found/);
    expect(listLongTerm(db, A, { state: 'approved' })).toHaveLength(2);
  });

  it('promotes an observation with the observation as evidence', () => {
    const r = storeObservation(db, { projectId: A, entityName: 'db', type: 'gotcha', title: 'Never run migrations in parallel', narrative: 'They deadlock on the schema lock', facts: ['Use the migrate queue'] });
    const item = promoteToLongTerm(db, A, r.observation.id, { kind: 'procedural' }).item;
    expect(item.title).toBe('Never run migrations in parallel');
    expect(item.body).toContain('deadlock');
    expect(item.body).toContain('- Use the migrate queue');
    expect(item.evidence).toEqual([`#${r.observation.id}`]);
    expect(item.sourceObservationId).toBe(r.observation.id);
    expect(() => promoteToLongTerm(db, B, r.observation.id, { kind: 'semantic' })).toThrow(/not found/);
    // Once approved, the brief shows it once, under Long-term, not again as a memory or caution.
    reviewLongTerm(db, A, item.id, 'approve', 'confirmed');
    const brief = buildProjectContext(db, { id: A, name: 'app', rootPath: os.tmpdir() }, 'run the migrations').text;
    expect(brief.match(/Never run migrations in parallel/g)).toHaveLength(1);
    expect(brief).toMatch(/## Long-term\n- \[PROCEDURE\] Never run migrations/);
  });

  it('ranks task matches first for the brief and counts pending proposals', () => {
    const a = propose({ title: 'Auth is JWT', kind: 'semantic', body: 'The API is stateless; tokens are JWT' });
    const b = propose({ title: 'Release steps', body: 'Build, test, tag' });
    reviewLongTerm(db, A, a.id, 'approve', 'ok');
    reviewLongTerm(db, A, b.id, 'approve', 'ok');
    propose({ title: 'Unreviewed idea', kind: 'semantic', body: 'maybe' });
    expect(approvedForBrief(db, A, 'fix the jwt token refresh').map((i) => i.id)[0]).toBe(a.id);
    expect(approvedForBrief(db, A, 'prepare the release').map((i) => i.id)[0]).toBe(b.id);
    expect(pendingLongTermCount(db, A)).toBe(1);
    expect(listLongTerm(db, A, { query: 'stateless' }).map((i) => i.id)).toEqual([a.id]);
  });

  it('is included in export', () => {
    propose();
    expect(exportProject(db, A).longTerm).toHaveLength(1);
  });
});

describe('brief with long-term memory', () => {
  it('shows approved items only, notes pending proposals, and lists no hook candidates', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'syn-lt-'));
    writeFileSync(path.join(dir, 'limit.ts'), '');
    const proj: ProjectInfo = { id: A, name: 'app', rootPath: dir };
    const ok = propose({ title: 'Rate limits are per API key', kind: 'semantic', body: 'Limits apply per key, not per IP' });
    reviewLongTerm(db, A, ok.id, 'approve', 'confirmed');
    propose({ title: 'Rate limit idea', kind: 'semantic', body: 'unreviewed rate limit note' });
    storeObservation(db, {
      projectId: A, entityName: 'api', type: 'what-changed', title: 'Edited limit.ts', narrative: 'rate limit edit',
      filesModified: ['limit.ts'], source: 'hook', admissionState: 'candidate', valueCategory: 'ephemeral',
    });
    const brief = buildProjectContext(db, proj, 'change the rate limit').text;
    expect(brief).toMatch(/## Long-term\n- \[FACT\] Rate limits are per API key/);
    expect(brief).not.toContain('Rate limit idea');
    expect(brief).toContain('1 long-term proposal(s) await review');
    // The candidate is not listed as a memory, but still points at the file to start from.
    expect(brief).not.toContain('Edited limit.ts');
    expect(brief).toMatch(/## Start here\n- limit\.ts/);
  });

  it('shows user-scope items even in a project with no memories yet', () => {
    const u = propose({ title: 'Prefer pnpm', kind: 'semantic', body: 'Use pnpm, not npm', scope: 'user' });
    reviewLongTerm(db, A, u.id, 'approve', 'User stated this');
    const brief = buildProjectContext(db, { id: B, name: 'other', rootPath: os.tmpdir() }, 'set up the project').text;
    expect(brief).toContain('Prefer pnpm');
    expect(brief).toContain('fresh project');
  });
});

describe('long-term MCP tools', () => {
  it('propose -> list -> review flow', async () => {
    const server = createServer({ db, mode: 'lite', project: { id: A, name: 'app', rootPath: process.cwd() } });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'claude-code', version: '0' });
    await Promise.all([server.connect(x), client.connect(y)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError };
    };
    const p = await call('synapse_lt_propose', { kind: 'semantic', title: 'Webhooks need raw body', body: 'express.json breaks signatures' });
    expect(p.text).toMatch(/Proposed: \[FACT\] Webhooks need raw body .*\(LT1, proposed\)/);
    expect((await call('synapse_lt_list', {})).text).toBe('No long-term memories match.');
    expect((await call('synapse_lt_list', { state: 'proposed' })).text).toContain('LT1');
    expect((await call('synapse_lt_approve', { id: 99, title: 'x', scope: 'project', body: 'x', reason: 'x' })).isError).toBe(true);
    expect((await call('synapse_lt_approve', { id: 1, title: 'Webhooks need raw body', scope: 'project', body: 'express.json breaks signatures', reason: 'User confirmed' })).text).toContain('Approved');
    expect((await call('synapse_lt_list', {})).text).toContain('Webhooks need raw body');
    expect((await call('synapse_lt_propose', { kind: 'semantic', fromMemoryId: 999 })).isError).toBe(true);
    // Approving a replacement retires the old item in the same call.
    await call('synapse_lt_propose', { kind: 'semantic', title: 'Webhooks need the raw body buffer', body: 'use express.raw' });
    expect((await call('synapse_lt_approve', { id: 2, title: 'Webhooks need the raw body buffer', scope: 'project', body: 'use express.raw', reason: 'User confirmed', supersedes: 1, supersedesTitle: 'Webhooks need raw body' })).text).toContain('LT1 superseded by LT2');
    expect((await call('synapse_lt_archive', { id: 2, reason: 'obsolete' })).text).toContain('Archived');
  });

  it('marks only the approve tool as requiring user interaction', async () => {
    const server = createServer({ db, mode: 'lite', project: { id: A, name: 'app', rootPath: process.cwd() } });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(x), client.connect(y)]);
    const tools = (await client.listTools()).tools;
    const gated = tools.filter((t) => (t._meta as Record<string, unknown> | undefined)?.['anthropic/requiresUserInteraction'] === true).map((t) => t.name);
    expect(gated).toEqual(['synapse_lt_approve']);
    expect(tools.map((t) => t.name)).not.toContain('synapse_lt_review');
  });
});
