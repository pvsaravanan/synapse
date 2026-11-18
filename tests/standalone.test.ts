/**
 * Agents without hooks: the MCP server delivers the brief and runs one session per server process.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../src/db.js';
import { createServer } from '../src/server.js';
import { detectProject } from '../src/project.js';
import { getSession, listCheckpoints, recentSessions, registerServerSession, startSession } from '../src/sessions.js';
import type { ProjectInfo } from '../src/types.js';
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

describe('without hooks: edits from the working tree, rolling checkpoints', () => {
  let repo: string;
  let repoProject: ProjectInfo;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  beforeEach(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'syn-wt-'));
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'src/a.ts'), 'a\n');
    writeFileSync(path.join(repo, 'src/b.ts'), 'b\n');
    writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    repoProject = detectProject(repo);
  });

  async function connectRepo(pollMs?: number) {
    const server = createServer({ db, mode: 'lite', project: repoProject, hooks: false, pollMs });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'zed', version: '1' });
    await Promise.all([server.connect(x), client.connect(y)]);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content.map((c) => c.text).join('\n');
    return { client, call };
  }
  const edited = () =>
    listObservations(db, { projectId: repoProject.id, type: ['what-changed'], limit: 50, status: 'all' }).map((o) => o.filesModified[0]).sort();

  it('records files changed between tool calls, but not ones already dirty, ignored or only committed', async () => {
    writeFileSync(path.join(repo, 'src/b.ts'), 'dirty before the session\n');
    const { client, call } = await connectRepo();
    await call('synapse_search', { query: 'x' });
    writeFileSync(path.join(repo, 'src/a.ts'), 'edited\n');
    writeFileSync(path.join(repo, 'src/new.ts'), 'new\n');
    mkdirSync(path.join(repo, 'dist'));
    writeFileSync(path.join(repo, 'dist/out.js'), 'built');
    await call('synapse_search', { query: 'x' });
    expect(edited()).toEqual(['src/a.ts', 'src/new.ts']);
    // Committing b.ts unchanged is not an edit; editing a.ts again updates its one record.
    git('add', 'src/b.ts');
    git('commit', '-qm', 'b');
    writeFileSync(path.join(repo, 'src/a.ts'), 'edited again\n');
    rmSync(path.join(repo, 'src/new.ts'));
    await client.close();
    expect(edited()).toEqual(['src/a.ts', 'src/new.ts']);
    const [s] = recentSessions(db, repoProject.id, 1, false);
    expect(s.summary).toContain('Touched 2 file(s)');
    expect(s.agent).toBe('zed');
  });

  it("doesn't flag the session's own memories for its edits", async () => {
    const { call } = await connectRepo();
    await call('synapse_store', { entityName: 'a', type: 'decision', title: 'A stays tiny', narrative: 'n', filesModified: ['src/a.ts'] });
    writeFileSync(path.join(repo, 'src/a.ts'), 'edited by the agent\n');
    expect(await call('synapse_search', { query: 'tiny' })).not.toContain('changed since');
  });

  it('works outside git without tracking edits', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'syn-nogit-'));
    const server = createServer({ db, mode: 'lite', project: detectProject(dir), hooks: false });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'zed', version: '1' });
    await Promise.all([server.connect(x), client.connect(y)]);
    writeFileSync(path.join(dir, 'f.ts'), 'x');
    await client.callTool({ name: 'synapse_search', arguments: { query: 'x' } });
    expect(listObservations(db, { type: ['what-changed'], limit: 5, status: 'all' })).toHaveLength(0);
  });

  it("leads a later synapse_project_context with the session's progress (recovery after compaction)", async () => {
    const { client, call } = await connectRepo();
    expect(client.getInstructions()).toContain('call synapse_project_context again');
    const first = await call('synapse_project_context', { task: 'Make module A handle empty input' });
    expect(first).not.toContain('## Checkpoint');
    writeFileSync(path.join(repo, 'src/a.ts'), 'handles empty input\n');
    await call('synapse_store', { entityName: 'a', type: 'gotcha', title: 'Empty input crashed module A', narrative: 'n' });
    const later = await call('synapse_project_context', { task: 'continue' });
    expect(later).toMatch(/## Checkpoint\n- .*Goal: Make module A handle empty input\. Touched 1 file\(s\): src\/a\.ts\. Stored: #\d+ Empty input crashed module A/);
    expect(listCheckpoints(db, repoProject.id)).toHaveLength(1);
  });

  it('writes a rolling checkpoint every 10 calls when something changed', async () => {
    const { call } = await connectRepo();
    for (let i = 0; i < 9; i++) await call('synapse_search', { query: 'x' });
    expect(listCheckpoints(db, repoProject.id)).toHaveLength(0);
    writeFileSync(path.join(repo, 'src/a.ts'), 'edited\n');
    await call('synapse_search', { query: 'x' });
    const [cp] = listCheckpoints(db, repoProject.id);
    expect(cp.summary).toContain('src/a.ts');
    // Nothing new: the next ten calls add no checkpoint.
    for (let i = 0; i < 10; i++) await call('synapse_search', { query: 'x' });
    expect(listCheckpoints(db, repoProject.id)).toHaveLength(1);
  });

  it('does not track edits with hooks installed', async () => {
    const server = createServer({ db, mode: 'lite', project: repoProject, hooks: true });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'claude-code', version: '1' });
    await Promise.all([server.connect(x), client.connect(y)]);
    writeFileSync(path.join(repo, 'src/a.ts'), 'edited\n');
    await client.callTool({ name: 'synapse_search', arguments: { query: 'x' } });
    expect(edited()).toEqual([]);
  });
});

describe('without hooks: servers killed without shutting down (Copilot CLI sends SIGKILL)', () => {
  let repo: string;
  let repoProject: ProjectInfo;
  beforeEach(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'syn-kill-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(path.join(repo, 'a.ts'), 'a');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });
    repoProject = detectProject(repo);
  });
  const connectRepo = async (pollMs?: number) => {
    const server = createServer({ db, mode: 'lite', project: repoProject, hooks: false, pollMs });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'copilot-cli', version: '1' });
    await Promise.all([server.connect(x), client.connect(y)]);
    return { client, call: (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) };
  };
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;

  it('keeps the session summary current after every call, without waiting for the close', async () => {
    const { call } = await connectRepo();
    await call('synapse_project_context', { task: 'Round payment amounts to cents' });
    await call('synapse_store', { entityName: 'pay', type: 'gotcha', title: 'Amounts are integer cents', narrative: 'n' });
    const [s] = recentSessions(db, repoProject.id, 1, false);
    expect(s.status).toBe('active');
    expect(s.summary).toMatch(/Goal: Round payment amounts to cents\. Stored: #\d+ Amounts are integer cents/);
  });

  it('the next server closes sessions whose server process is gone, keeping their summary', async () => {
    const orphan = startSession(db, repoProject.id, { agent: 'copilot-cli' });
    db.prepare('UPDATE sessions SET summary = ? WHERE id = ?').run('Goal: earlier work', orphan.id);
    registerServerSession(db, orphan.id, deadPid());
    const live = startSession(db, repoProject.id, { agent: 'copilot-cli' });
    registerServerSession(db, live.id); // this test process: still running
    const elsewhere = startSession(db, 'other/project', { agent: 'copilot-cli' });
    registerServerSession(db, elsewhere.id, deadPid());
    const { call } = await connectRepo();
    await call('synapse_search', { query: 'x' });
    expect(getSession(db, orphan.id)).toMatchObject({ status: 'completed', summary: 'Goal: earlier work' });
    expect(getSession(db, live.id)!.status).toBe('active');
    expect(getSession(db, elsewhere.id)!.status).toBe('active'); // closed by a server of that project
    expect(db.prepare("SELECT count(*) AS n FROM meta WHERE key = ?").get(`server-session:${orphan.id}`)).toEqual({ n: 0 });
  });

  it('polls the working tree, catching an edit made after the last tool call', async () => {
    const { call } = await connectRepo(50);
    await call('synapse_search', { query: 'x' });
    writeFileSync(path.join(repo, 'a.ts'), 'edited after the last call');
    await new Promise((r) => setTimeout(r, 400));
    const [s] = recentSessions(db, repoProject.id, 1, false);
    expect(s.status).toBe('active');
    expect(s.summary).toContain('Touched 1 file(s): a.ts');
  });

  it('a normal close releases the pid record', async () => {
    const { client, call } = await connectRepo();
    await call('synapse_search', { query: 'x' });
    await client.close();
    expect(db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'server-session:%'").get()).toEqual({ n: 0 });
  });
});
