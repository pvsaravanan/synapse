/**
 * What each session was shown: briefs, searches, details and file notes recorded per session, joined with what
 * happened to each memory since, plus the server's start brief, the token budget, redaction, opt-out and pruning.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatHookResult, normalizeHookPayload } from '../src/agents.js';
import { buildProjectContext } from '../src/context.js';
import { openDatabase, type DB } from '../src/db.js';
import { formatSessionDeliveries, memoryDeliveries, pruneDeliveries, recordDeliveries, sessionDeliveries } from '../src/deliveries.js';
import { handleHook } from '../src/hooks.js';
import { proposeLongTerm, reviewLongTerm } from '../src/longterm.js';
import { detectProject } from '../src/project.js';
import { createServer } from '../src/server.js';
import { recentSessions } from '../src/sessions.js';
import { editObservation, recordFeedback, setStatus, storeObservation } from '../src/store.js';
import type { ProjectInfo } from '../src/types.js';

let db: DB;
let dir: string;
let project: ProjectInfo;
beforeEach(() => {
  db = openDatabase(':memory:');
  dir = mkdtempSync(path.join(os.tmpdir(), 'syn-shown-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src/page.ts'), 'export const PAGE = 1;\n');
  project = detectProject(dir);
});
afterEach(() => {
  delete process.env.SYNAPSE_AUDIT_DAYS;
});

const remember = (title: string, extra: Record<string, unknown> = {}) =>
  storeObservation(db, { projectId: project.id, entityName: 'ui', type: 'gotcha', title, narrative: `${title} (details)`, rootPath: dir, ...extra }).observation;
const hook = (raw: Record<string, unknown>) => {
  for (const input of normalizeHookPayload('claude', { cwd: dir, session_id: 'cc-1', ...raw })) formatHookResult('claude', String(raw.hook_event_name), handleHook(db, input));
};
const session = () => recentSessions(db, project.id, 1, false)[0];

describe('recorded through hooks', () => {
  it('records the session-start brief and file notes, and shows what happened to each memory since', () => {
    const page = remember('Page is a String.raw template', { filesModified: ['src/page.ts'] });
    const other = remember('Rebuild before testing hooks');
    hook({ hook_event_name: 'SessionStart', source: 'startup' });
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(dir, 'src/page.ts') } });
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(dir, 'src/page.ts') } }); // noted once per session

    const events = sessionDeliveries(db, session().id);
    expect(events.map((e) => e.channel)).toEqual(['brief', 'file-note']);
    expect(events[0].query).toBe('continue work on this project');
    expect(events[0].items.map((d) => [d.observationId, d.section])).toEqual(expect.arrayContaining([[page.id, 'caution'], [other.id, 'caution']]));
    expect(events[1]).toMatchObject({ query: 'src/page.ts', items: [{ observationId: page.id, section: 'src/page.ts', rank: 1, stale: false, editedSince: false }] });

    editObservation(db, page.id, { title: 'Page is a String.raw template: no backticks' });
    recordFeedback(db, other.id, 'outdated');
    setStatus(db, [other.id], 'resolved');
    const later = sessionDeliveries(db, session().id);
    expect(later[1].items[0]).toMatchObject({ editedSince: true, title: 'Page is a String.raw template' }); // the title as shown
    expect(later[0].items.find((d) => d.observationId === other.id)).toMatchObject({ ratedWrongSince: true, statusNow: 'resolved', editedSince: false }); // resolving is not an edit

    const text = formatSessionDeliveries(later);
    expect(text).toMatch(/Brief for "continue work on this project"/);
    expect(text).toMatch(/File note on src\/page\.ts/);
    expect(text).toContain('rated wrong since; now resolved');
    expect(memoryDeliveries(db, page.id).map((d) => [d.channel, d.agent])).toEqual([['file-note', 'claude-code'], ['brief', 'claude-code']]);
  });

  it('records only what fits the brief\'s token budget, and long-term items as such', () => {
    const topics = ['canvas resize', 'frame pacing', 'hover cards', 'zoom limits', 'label overlap', 'edge colors', 'node drag', 'camera easing'];
    topics.forEach((t, i) => remember(`Render loop: ${t}`, { entityName: `graph-${i}`, narrative: `The render loop handles ${t} with care; see notes on ${t}.` }));
    const lt = proposeLongTerm(db, { projectId: project.id, kind: 'semantic', title: 'Always run the build', body: 'npm run build before testing hooks' }).item;
    reviewLongTerm(db, project.id, lt.id, 'approve', 'ok');
    const brief = buildProjectContext(db, project, 'render loop', { maxTokens: 170, audit: { sessionId: 's-1' } });
    const [event] = sessionDeliveries(db, 's-1');
    expect(event.items.length).toBe(brief.delivered.length);
    expect(event.items[0]).toMatchObject({ longTermId: lt.id, section: 'long-term', rank: 1 });
    const shownIds = event.items.filter((d) => d.observationId).map((d) => d.observationId!);
    expect(shownIds.length).toBeGreaterThan(0);
    for (const id of shownIds) expect(brief.text).toContain(`#${id}`);
    expect(brief.memoryIds.length).toBeGreaterThan(shownIds.length); // the rest were cut by the budget, so not recorded
  });
});

describe('recorded by the MCP server', () => {
  const connect = async (client: string, hooks = false) => {
    const server = createServer({ db, mode: 'lite', project, hooks });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: client, version: '1' });
    await Promise.all([server.connect(a), c.connect(b)]);
    return async (name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args });
  };

  it('records searches (only the hits that fit), details and the start brief against the server\'s session', async () => {
    const a = remember('Webhook handler needs the raw request body because express.json breaks the signature check');
    const b = remember('Webhook retries back off exponentially, so a failing endpoint is retried for up to three days');
    const call = await connect('windsurf');
    await call('synapse_search', { query: 'webhook token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
    await call('synapse_search', { query: 'webhook', maxTokens: 50 });
    await call('synapse_detail', { ids: [b.id] });
    const events = sessionDeliveries(db, session().id);
    expect(events.map((e) => e.channel)).toEqual(['search', 'brief', 'search', 'detail']); // the brief rode on the first result
    expect(events[0].query).not.toContain('ghp_');
    expect(events[0].items.map((d) => d.rank)).toEqual([1, 2]);
    expect(events[0].items[0].score).toBeGreaterThan(0);
    expect(events[2].items).toHaveLength(1); // the token budget left room for one line
    expect(events[3]).toMatchObject({ query: `#${b.id}`, items: [{ observationId: b.id }] });
    expect(new Set(events[1].items.map((d) => d.observationId))).toEqual(new Set([a.id, b.id]));
  });

  it('records the start brief for clients that show it in instructions, and project_context briefs with their task', async () => {
    remember('Webhook needs the raw body');
    const call = await connect('claude-code');
    await call('synapse_project_context', { task: 'fix the webhook' });
    const events = sessionDeliveries(db, session().id);
    expect(events.map((e) => [e.channel, e.query])).toEqual([['brief', 'fix the webhook'], ['brief', null]]);
  });
});

describe('storage', () => {
  it('can be turned off, and prunes rows past the retention window', () => {
    const o = remember('Webhook needs the raw body');
    const item = { observationId: o.id, title: o.title };
    process.env.SYNAPSE_AUDIT_DAYS = '0';
    expect(recordDeliveries(db, { projectId: project.id, sessionId: 's', channel: 'search', query: 'x', items: [item] })).toBeUndefined();
    delete process.env.SYNAPSE_AUDIT_DAYS;
    recordDeliveries(db, { projectId: project.id, sessionId: 's', channel: 'search', query: 'x', items: [item] });
    db.prepare("UPDATE deliveries SET createdAt = '2020-01-01T00:00:00.000Z'").run();
    recordDeliveries(db, { projectId: project.id, sessionId: 's', channel: 'detail', items: [item] });
    expect(pruneDeliveries(db)).toBe(1);
    expect(sessionDeliveries(db, 's').map((e) => e.channel)).toEqual(['detail']);
  });
});
