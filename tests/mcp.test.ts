import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createServer, suggestTopicKey } from '../src/server.js';

async function connect(mode: 'lite' | 'full' = 'lite') {
  const db = openDatabase(':memory:');
  const server = createServer({ db, mode, project: { id: 'acme/app', name: 'app', rootPath: process.cwd() } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError };
  };
  return { client, call };
}

describe('MCP server', () => {
  it('exposes the lite tool surface and gates graph tools behind full mode', async () => {
    const lite = (await (await connect()).client.listTools()).tools.map((t) => t.name);
    expect(lite).toContain('synapse_store');
    expect(lite).toContain('synapse_project_context');
    expect(lite).not.toContain('read_graph');
    const full = (await (await connect('full')).client.listTools()).tools.map((t) => t.name);
    expect(full).toContain('read_graph');
  });

  it('store -> search -> detail -> resolve flow', async () => {
    const { call } = await connect();
    expect((await call('synapse_search', { query: 'anything' })).text).toContain('fresh project');
    const stored = await call('synapse_store', {
      entityName: 'billing', type: 'gotcha', title: 'Stripe webhooks need raw body',
      narrative: 'express.json() breaks signature verification', facts: ['Use express.raw for /webhook'],
    });
    expect(stored.text).toMatch(/Stored #(\d+)/);
    const id = Number(stored.text.match(/#(\d+)/)![1]);
    const found = await call('synapse_search', { query: 'stripe signature' });
    expect(found.text).toContain(`#${id}`);
    const detail = await call('synapse_detail', { ids: [id] });
    expect(detail.text).toContain('Use express.raw for /webhook');
    await call('synapse_resolve', { ids: [id] });
    expect((await call('synapse_search', { query: 'stripe' })).text).toContain('No memories matched');
  });

  it('reasoning, sessions and brief', async () => {
    const { call } = await connect();
    await call('synapse_store_reasoning', { entityName: 'storage', decision: 'Use SQLite over Postgres', rationale: 'local-first, zero ops', alternatives: ['Postgres'] });
    await call('synapse_session_start', { agent: 'test' });
    await call('synapse_session_end', { summary: 'Picked storage; next build search' });
    const brief = await call('synapse_project_context', { task: 'refactor the storage layer' });
    expect(brief.text).toContain('refactor');
    expect(brief.text).toContain('Use SQLite over Postgres');
    expect(brief.text).toContain('Picked storage; next build search');
    const next = await call('synapse_session_start', {});
    expect(next.text).toContain('Picked storage');
  });

  it('feedback and topic keys', async () => {
    const { call } = await connect();
    expect(suggestTopicKey('decision', 'Auth Session Model!', 'Auth')).toBe('decisions/auth/auth-session-model');
    expect((await call('synapse_feedback', { id: 999, signal: 'helpful' })).isError).toBe(true);
  });
});
