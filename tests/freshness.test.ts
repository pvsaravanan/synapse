import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildProjectContext } from '../src/context.js';
import { openDatabase, type DB } from '../src/db.js';
import { formatDetail, indexLine } from '../src/disclosure.js';
import { changeNote, changesFor, fileKey, hashFiles, staleMemories } from '../src/freshness.js';
import { handleHook } from '../src/hooks.js';
import { detectProject } from '../src/project.js';
import { createServer } from '../src/server.js';
import { getObservation, recordFeedback, storeObservation } from '../src/store.js';
import type { ProjectInfo } from '../src/types.js';

let db: DB;
let dir: string;
let project: ProjectInfo;
beforeEach(() => {
  db = openDatabase(':memory:');
  dir = mkdtempSync(path.join(os.tmpdir(), 'syn-fresh-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src/limit.ts'), 'export const LIMIT = 10;\n');
  writeFileSync(path.join(dir, 'src/auth.ts'), 'export const auth = 1;\n');
  project = detectProject(dir);
});

const store = (over: Partial<Parameters<typeof storeObservation>[1]> = {}) =>
  storeObservation(db, {
    projectId: project.id, entityName: 'api', type: 'gotcha', title: 'Rate limit is per key',
    narrative: 'Limits apply per API key, not per IP', filesModified: ['src/limit.ts'], rootPath: project.rootPath, ...over,
  }).observation;
const changes = (id: number) => changesFor(project.rootPath, project.id, [getObservation(db, id)!]).get(id) ?? [];

describe('file freshness', () => {
  it('flags a memory once a named file is modified, deleted or created', () => {
    const o = store({ filesModified: ['src/limit.ts', 'src/auth.ts', 'src/new.ts'] });
    expect(Object.keys(o.fileHashes).sort()).toEqual(['src/auth.ts', 'src/limit.ts', 'src/new.ts']);
    expect(o.fileHashes['src/new.ts']).toBe('');
    expect(changes(o.id)).toEqual([]);
    writeFileSync(path.join(dir, 'src/limit.ts'), 'export const LIMIT = 20;\n');
    rmSync(path.join(dir, 'src/auth.ts'));
    writeFileSync(path.join(dir, 'src/new.ts'), 'x');
    expect(changes(o.id)).toEqual([
      { file: 'src/limit.ts', change: 'modified' },
      { file: 'src/auth.ts', change: 'deleted' },
      { file: 'src/new.ts', change: 'created' },
    ]);
    expect(changeNote(changes(o.id))).toBe('changed since: src/limit.ts, src/auth.ts deleted +1');
  });

  it('only tracks files inside the project, normalizing absolute paths', () => {
    expect(fileKey(dir, path.join(dir, 'src/limit.ts'))).toBe('src/limit.ts');
    expect(fileKey(dir, '../elsewhere.ts')).toBeUndefined();
    expect(fileKey(dir, '/etc/hosts')).toBeUndefined();
    expect(Object.keys(hashFiles(dir, [path.join(dir, 'src/limit.ts'), '/etc/hosts', 'src/limit.ts']))).toEqual(['src/limit.ts']);
  });

  it('records no hashes without a project root (git ingest, imports)', () => {
    expect(store({ rootPath: undefined }).fileHashes).toEqual({});
  });

  it('shows the flag in index lines, detail, the brief and stale listings', () => {
    const o = store();
    writeFileSync(path.join(dir, 'src/limit.ts'), 'changed');
    expect(indexLine(o, changes(o.id))).toContain('(changed since: src/limit.ts)');
    expect(formatDetail(o, changes(o.id))).toContain('Changed since stored: src/limit.ts (modified)');
    const brief = buildProjectContext(db, project, 'fix the rate limit').text;
    expect(brief).toMatch(/Rate limit is per key \(changed since: src\/limit\.ts\)/);
    expect(brief).toContain('check current code before relying on it');
    expect(staleMemories(db, project).map((x) => x.observation.id)).toEqual([o.id]);
  });

  it('leaves the brief unflagged when nothing changed', () => {
    store();
    const brief = buildProjectContext(db, project, 'fix the rate limit').text;
    expect(brief).toContain('Rate limit is per key');
    expect(brief).not.toContain('changed since');
  });

  it('clears the flag when verified, and starts tracking memories stored without hashes', () => {
    const o = store();
    writeFileSync(path.join(dir, 'src/limit.ts'), 'changed');
    recordFeedback(db, o.id, 'verified', undefined, project.rootPath);
    expect(changes(o.id)).toEqual([]);
    const legacy = store({ title: 'Auth tokens are JWT', narrative: 'stateless', filesModified: ['src/auth.ts'], rootPath: undefined });
    recordFeedback(db, legacy.id, 'verified', undefined, project.rootPath);
    expect(Object.keys(getObservation(db, legacy.id)!.fileHashes)).toEqual(['src/auth.ts']);
  });

  it('re-storing under the same topic refreshes the hashes', () => {
    const o = store({ topicKey: 'gotchas/api/limit' });
    writeFileSync(path.join(dir, 'src/limit.ts'), 'changed');
    store({ topicKey: 'gotchas/api/limit', narrative: 'Still per key after the rewrite' });
    expect(changes(o.id)).toEqual([]);
  });

  it("does not flag a session's memories for that session's own edits, but does for later sessions", () => {
    handleHook(db, { hook_event_name: 'SessionStart', session_id: 's1', cwd: dir, source: 'startup' });
    const o = store({ sessionId: 's1', filesModified: ['src/limit.ts', 'src/auth.ts'] });
    writeFileSync(path.join(dir, 'src/limit.ts'), 'export const LIMIT = 20;\n');
    handleHook(db, { hook_event_name: 'PostToolUse', session_id: 's1', cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/limit.ts'), new_string: '20' } });
    expect(changes(o.id)).toEqual([]);
    // A later shell edit (no hook) to a file the session edited is absorbed when the session ends...
    writeFileSync(path.join(dir, 'src/limit.ts'), 'export const LIMIT = 30;\n');
    // ...but a change to a file the session never edited (you, in your editor, or another agent) still flags.
    writeFileSync(path.join(dir, 'src/auth.ts'), 'edited elsewhere');
    handleHook(db, { hook_event_name: 'SessionEnd', session_id: 's1', cwd: dir });
    expect(changes(o.id)).toEqual([{ file: 'src/auth.ts', change: 'modified' }]);
    recordFeedback(db, o.id, 'verified', undefined, project.rootPath);
    handleHook(db, { hook_event_name: 'SessionStart', session_id: 's2', cwd: dir, source: 'startup' });
    writeFileSync(path.join(dir, 'src/limit.ts'), 'export const LIMIT = 40;\n');
    handleHook(db, { hook_event_name: 'PostToolUse', session_id: 's2', cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/limit.ts'), new_string: '40' } });
    expect(changes(o.id)).toEqual([{ file: 'src/limit.ts', change: 'modified' }]);
  });

  it('adds the column to databases created before it existed', () => {
    const file = path.join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE observations (id INTEGER PRIMARY KEY, projectId TEXT NOT NULL, entityName TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, narrative TEXT NOT NULL DEFAULT '', facts TEXT NOT NULL DEFAULT '[]', filesModified TEXT NOT NULL DEFAULT '[]', concepts TEXT NOT NULL DEFAULT '[]', tokens INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT, topicKey TEXT, revisionCount INTEGER NOT NULL DEFAULT 1, sessionId TEXT, status TEXT NOT NULL DEFAULT 'active', supersededBy INTEGER, progress TEXT, source TEXT NOT NULL DEFAULT 'agent', commitHash TEXT, relatedCommits TEXT NOT NULL DEFAULT '[]', relatedEntities TEXT NOT NULL DEFAULT '[]', admissionState TEXT NOT NULL DEFAULT 'qualified', valueCategory TEXT, hasCausalLanguage INTEGER NOT NULL DEFAULT 0)");
    old.exec("INSERT INTO observations (projectId, entityName, type, title, createdAt) VALUES ('p', 'e', 'gotcha', 'old one', '2026-01-01')");
    old.close();
    // Two processes opening the old database together: both see the column missing, one ALTER loses.
    const first = openDatabase(file);
    const second = new DatabaseSync(file);
    expect(() => second.exec("ALTER TABLE observations ADD COLUMN fileHashes TEXT NOT NULL DEFAULT '{}'")).toThrow(/duplicate column/);
    second.close();
    expect(getObservation(first, 1)!.fileHashes).toEqual({});
    expect(getObservation(openDatabase(file), 1)!.fileHashes).toEqual({});
    first.close();
  });
});

describe('file freshness and synapse_session_end', () => {
  it('re-hashes only files the session edited; without hook records nothing is absorbed', async () => {
    const server = createServer({ db, mode: 'lite', project });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(x), client.connect(y)]);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    await call('synapse_session_start', {});
    await call('synapse_store', { entityName: 'api', type: 'decision', title: 'Limits stay per key', narrative: 'per key', filesModified: ['src/limit.ts'] });
    const id = getObservationIdByTitle('Limits stay per key');
    writeFileSync(path.join(dir, 'src/limit.ts'), 'changed outside any hook');
    await call('synapse_session_end', { summary: 'done' });
    expect(changes(id)).toEqual([{ file: 'src/limit.ts', change: 'modified' }]);
  });
});

const getObservationIdByTitle = (title: string) =>
  Number((db.prepare('SELECT id FROM observations WHERE title = ?').get(title) as { id: number }).id);

describe('file freshness over MCP', () => {
  it('flags search and detail results, and "verified" feedback clears them', async () => {
    const o = store();
    writeFileSync(path.join(dir, 'src/limit.ts'), 'changed');
    const server = createServer({ db, mode: 'lite', project });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(x), client.connect(y)]);
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content.map((c) => c.text).join('\n');
    expect(await call('synapse_search', { query: 'rate limit' })).toContain('changed since: src/limit.ts');
    expect(await call('synapse_detail', { ids: [o.id] })).toContain('Changed since stored');
    expect(await call('synapse_feedback', { id: o.id, signal: 'verified' })).toContain('match current code');
    expect(await call('synapse_search', { query: 'rate limit' })).not.toContain('changed since');
    // A memory stored through MCP records hashes.
    await call('synapse_store', { entityName: 'auth', type: 'decision', title: 'Auth stays stateless', narrative: 'JWT only', filesModified: ['src/auth.ts'] });
    writeFileSync(path.join(dir, 'src/auth.ts'), 'changed');
    expect(await call('synapse_search', { query: 'stateless' })).toContain('changed since: src/auth.ts');
  });
});
