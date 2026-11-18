/**
 * Agents without hooks: the MCP server delivers the brief and runs one session per server process.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../src/db.js';
import { createServer } from '../src/server.js';
import { recentSessions } from '../src/sessions.js';
import { listObservations, storeObservation } from '../src/store.js';

const project = { id: 'acme/app', name: 'app', rootPath: process.cwd() };
let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
  storeObservation(db, { projectId: project.id, entityName: 'billing', type: 'gotcha', title: 'Stripe webhooks need raw body', narrative: 'express.json breaks signatures' });
});

async function connect(opts: { hooks?: boolean; client?: string } = {}) {
  const server = createServer({ db, mode: 'lite', project, hooks: opts.hooks ?? false });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: opts.client ?? 'windsurf', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content.map((c) => c.text).join('\n');
  return { client, call };
}
const sessions = () => recentSessions(db, project.id, 10, false);

describe('without hooks', () => {
  it('puts the brief in the server instructions', async () => {
    const { client } = await connect();
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('synapse_project_context');
    expect(instructions).toContain('# Synapse brief — app');
    expect(instructions).toContain('Stripe webhooks need raw body');
  });

  it('prepends the brief to the first tool result only', async () => {
    const { call } = await connect();
    const first = await call('synapse_search', { query: 'nothing matches this' });
    expect(first.startsWith('Synapse brief (first call this session')).toBe(true);
    expect(first).toContain('Stripe webhooks need raw body');
    expect(await call('synapse_search', { query: 'nothing matches this' })).not.toContain('Synapse brief');
  });

  it('skips the first-call brief when the first call is the brief itself, or the client shows instructions', async () => {
    const a = await connect();
    expect((await a.call('synapse_project_context', { task: 'fix the stripe webhook' })).match(/# Synapse brief/g)).toHaveLength(1);
    expect(await a.call('synapse_search', { query: 'x' })).not.toContain('Synapse brief');
    const b = await connect({ client: 'claude-code' });
    expect(await b.call('synapse_search', { query: 'x' })).not.toContain('Synapse brief');
  });

  it('runs one session per server: started on the first call, goal from the brief task, summarized on close', async () => {
    const { client, call } = await connect();
    expect(sessions()).toHaveLength(0);
    await call('synapse_project_context', { task: 'Fix the Stripe webhook signature check' });
    await call('synapse_store', { entityName: 'billing', type: 'problem-solution', title: 'Use express.raw on the webhook route', narrative: 'raw body keeps signatures valid' });
    const [s] = sessions();
    expect(s).toMatchObject({ agent: 'windsurf', status: 'active' });
    expect(listObservations(db, { projectId: project.id, limit: 10 }).find((o) => o.title.startsWith('Use express.raw'))?.sessionId).toBe(s.id);
    await client.close();
    const [ended] = sessions();
    expect(ended.status).toBe('completed');
    expect(ended.summary).toContain('Goal: Fix the Stripe webhook signature check');
    expect(ended.summary).toContain('Use express.raw on the webhook route');
  });

  it('starts a fresh session after synapse_session_end, and adopts synapse_session_start', async () => {
    const { call } = await connect();
    await call('synapse_search', { query: 'x' });
    await call('synapse_session_end', { summary: 'first part done' });
    await call('synapse_session_start', {});
    await call('synapse_store', { entityName: 'e', type: 'decision', title: 'Second part decision', narrative: 'n' });
    const all = sessions();
    expect(all.map((s) => s.status).sort()).toEqual(['active', 'completed']);
    const active = all.find((s) => s.status === 'active')!;
    expect(active.agent).toBe('windsurf');
    expect(listObservations(db, { projectId: project.id, limit: 10 }).find((o) => o.title === 'Second part decision')?.sessionId).toBe(active.id);
  });

  it('creates no session for a server that is never used', async () => {
    const { client } = await connect();
    await client.close();
    expect(sessions()).toHaveLength(0);
  });
});

describe('with hooks (SYNAPSE_HOOKS=1)', () => {
  it('leaves the brief and the session to the hooks', async () => {
    const { client, call } = await connect({ hooks: true });
    expect(client.getInstructions()).not.toContain('# Synapse brief');
    expect(client.getInstructions()).toContain('synapse_project_context');
    expect(await call('synapse_search', { query: 'x' })).not.toContain('Synapse brief');
    await call('synapse_store', { entityName: 'e', type: 'decision', title: 'A decision', narrative: 'n' });
    await client.close();
    expect(sessions()).toHaveLength(0);
  });
});
