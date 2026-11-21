/**
 * Hardening from the security review: project identity, git subprocesses, redaction, the team file as untrusted
 * input, symlinks in a cloned repo, the long-term approval gate, and file permissions.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../src/db.js';
import { SAFE_GIT_CONFIG, safeGitArgs } from '../src/gitexec.js';
import { proposeLongTerm, getLongTerm } from '../src/longterm.js';
import { bindProjectIdentity, detectProject, remoteHost } from '../src/project.js';
import { approvalRefusal, createServer } from '../src/server.js';
import { runSetup, type SetupOptions } from '../src/setup.js';
import { getObservation, listObservations, storeObservation } from '../src/store.js';
import { exportTeam, importTeam, readTeamFile, TEAM_FILE } from '../src/team.js';
import type { ProjectInfo } from '../src/types.js';
import { dirtyFiles } from '../src/worktree.js';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const tmp = (p: string) => mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('project identity', () => {
  it('reads the host from every remote form', () => {
    expect(remoteHost('git@GitHub.com:acme/app.git')).toBe('github.com');
    expect(remoteHost('ssh://git@github.com:22/acme/app.git')).toBe('github.com');
    expect(remoteHost('https://user@git.example.org:8443/acme/app')).toBe('git.example.org');
    expect(remoteHost('/srv/git/app.git')).toBeUndefined();
    expect(remoteHost('file:///srv/git/app.git')).toBeUndefined();
  });

  it('keeps one id per host and per local checkout, so unrelated repos never share memory', () => {
    const bind = (gitRemote: string | undefined, id: string, rootPath: string) => bindProjectIdentity(db, { id, name: 'app', rootPath, gitRemote }).id;
    expect(bind('git@github.com:acme/app.git', 'acme/app', '/a')).toBe('acme/app');
    expect(bind('https://github.com/acme/app', 'acme/app', '/b')).toBe('acme/app'); // same repo, other protocol and clone
    expect(bind('git@gitlab.com:acme/app.git', 'acme/app', '/c')).toBe('gitlab.com/acme/app');
    expect(bind('git@gitlab.com:acme/app.git', 'acme/app', '/d')).toBe('gitlab.com/acme/app');

    expect(bind(undefined, 'local/app', '/x/app')).toBe('local/app');
    const other = bind(undefined, 'local/app', '/y/app');
    expect(other).toMatch(/^local\/app-[0-9a-f]{8}$/);
    expect(bind(undefined, 'local/app', '/y/app')).toBe(other);
    expect(bind(undefined, 'local/app', '/x/app')).toBe('local/app');
    expect(bind(undefined, 'dir/app-1234', '/z')).toBe('dir/app-1234');
  });
});

describe('git subprocesses', () => {
  it('pass protected config that turns off repo-named helpers', () => {
    expect(safeGitArgs(['status'])).toEqual([...SAFE_GIT_CONFIG, 'status']);
    expect(SAFE_GIT_CONFIG).toEqual(['-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=explicit']);
  });

  it('do not run a core.fsmonitor command from the repository config', () => {
    const dir = tmp('syn-fsmon-');
    git(dir, 'init', '-q');
    const marker = path.join(dir, 'ran');
    const hook = path.join(dir, 'monitor.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(hook, 0o755);
    git(dir, 'config', 'core.fsmonitor', hook);
    writeFileSync(path.join(dir, 'a.txt'), 'x');
    expect(dirtyFiles(dir)?.has('a.txt')).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('redaction', () => {
  it('covers topicKey and concepts, not just the text fields', () => {
    const { observation } = storeObservation(db, {
      projectId: 'p', entityName: 'cli', type: 'gotcha', title: 'curl needs the header', narrative: 'details',
      topicKey: `commands/curl -H token=${TOKEN}`, concepts: [`token=${TOKEN}`],
    });
    const o = getObservation(db, observation.id)!;
    expect(o.topicKey).not.toContain(TOKEN);
    expect(JSON.stringify(o.concepts)).not.toContain(TOKEN.toLowerCase());
  });
});

describe('team file as untrusted input', () => {
  let dir: string;
  let project: ProjectInfo;
  const file = () => path.join(dir, TEAM_FILE);
  const entry = (over: Record<string, unknown> = {}) => ({
    uid: 'm-abcdef123456', type: 'gotcha', entity: 'api', title: 'Shared', narrative: 'n', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
  });
  const writeTeam = (...entries: object[]) => {
    mkdirSync(path.dirname(file()), { recursive: true });
    writeFileSync(file(), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  };
  beforeEach(() => {
    dir = tmp('syn-teamsec-');
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src/limit.ts'), 'export const LIMIT = 10;\n');
    project = detectProject(dir);
  });

  it('keeps file paths and hashes inside the project and off ignored files', () => {
    writeTeam(entry({
      files: ['../../etc/passwd', '/etc/hosts', 'src/limit.ts', '.env'],
      fileHashes: { '../outside.txt': 'abcdefabcdef', '/etc/hosts': 'abcdefabcdef', '.env': 'abcdefabcdef', 'src/limit.ts': 'not-a-hash', 'src/x.ts': 'abcdefabcdef' },
    }));
    const id = importTeam(db, project).added[0];
    const o = getObservation(db, id)!;
    expect(o.filesModified).toEqual(['src/limit.ts']);
    expect(o.fileHashes).toEqual({ 'src/x.ts': 'abcdefabcdef' });
  });

  it('refuses timestamps far in the future, so an entry cannot win every merge forever', () => {
    writeTeam(entry({ updatedAt: '2999-01-01T00:00:00Z' }), entry({ uid: 'm-bbbbbb123456', createdAt: '9999-01-01T00:00:00Z' }), entry({ uid: 'm-cccccc123456', updatedAt: 'soon' }));
    expect(readTeamFile(file()).invalid).toBe(3);
    // A small clock skew is fine; stamps come back normalised to ISO.
    const skew = new Date(Date.now() + 3_600_000).toISOString();
    writeTeam(entry({ updatedAt: skew.replace('.000Z', 'Z') }));
    expect(readTeamFile(file()).entries[0].updatedAt).toBe(new Date(Date.parse(skew)).toISOString());
  });

  it('scrubs every field it shares of secrets and machine paths', () => {
    storeObservation(db, {
      projectId: project.id, entityName: 'api', type: 'gotcha', title: 'Rate limit', narrative: 'per key', rootPath: dir,
      facts: [`see ${dir}/src/limit.ts`], concepts: [`token=${TOKEN}`], relatedEntities: [`${os.homedir()}/notes`],
      topicKey: `gotchas/${dir}/token=${TOKEN}`, filesModified: [path.join(dir, 'src/limit.ts')],
    });
    expect(exportTeam(db, project).shared).toBe(1);
    const text = readFileSync(file(), 'utf8');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(TOKEN.toLowerCase());
    expect(text).not.toContain(dir);
    expect(text).not.toContain(os.homedir());
    expect(JSON.parse(text).files).toEqual(['src/limit.ts']);
  });

  it('refuses to read or write through a symlinked team file or folder', () => {
    storeObservation(db, { projectId: project.id, entityName: 'api', type: 'gotcha', title: 'Rate limit', narrative: 'per key' });
    const outside = tmp('syn-outside-');
    const victim = path.join(outside, 'victim');
    writeFileSync(victim, 'keep me\n');
    mkdirSync(path.join(dir, '.synapse'));
    symlinkSync(victim, file());
    expect(() => readTeamFile(file())).toThrow(/symbolic link/);
    expect(() => exportTeam(db, project)).toThrow(/symbolic link/);
    expect(readFileSync(victim, 'utf8')).toBe('keep me\n');

    const dir2 = tmp('syn-teamsec-');
    symlinkSync(outside, path.join(dir2, '.synapse'));
    expect(() => exportTeam(db, detectProject(dir2))).toThrow(/symbolic link/);
    expect(existsSync(path.join(outside, 'memory.jsonl'))).toBe(false);
  });
});

describe('project-scope setup in a cloned repo', () => {
  const opts = (cwd: string): SetupOptions => ({ global: false, dryRun: false, cwd, home: tmp('syn-home-'), node: '/n', script: '/s/cli.js', useAgentCli: false });

  it('skips files the repo committed as symlinks, and a symlinked config folder', () => {
    const outside = tmp('syn-outside-');
    const rc = path.join(outside, 'zshrc');
    writeFileSync(rc, 'export PATH=/usr/bin\n');
    const dir = tmp('syn-clone-');
    symlinkSync(rc, path.join(dir, 'CLAUDE.md'));
    symlinkSync(outside, path.join(dir, '.claude'));

    const r = runSetup('claude', opts(dir));
    expect(readFileSync(rc, 'utf8')).toBe('export PATH=/usr/bin\n');
    expect(existsSync(path.join(outside, 'settings.local.json'))).toBe(false);
    expect(r.notes.join('\n')).toMatch(/Skipped hooks: .*resolves outside the project/);
    expect(r.notes.join('\n')).toMatch(/Skipped instructions.*CLAUDE\.md is a symbolic link/);
  });

  it('skips a file whose backup path is a symlink', () => {
    const outside = tmp('syn-outside-');
    const dir = tmp('syn-clone-');
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# Project\n');
    symlinkSync(path.join(outside, 'target'), path.join(dir, 'CLAUDE.md.synapse-backup'));
    const r = runSetup('claude', opts(dir));
    expect(r.notes.join('\n')).toMatch(/synapse-backup is a symbolic link/);
    expect(existsSync(path.join(outside, 'target'))).toBe(false);
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('# Project\n');
  });
});

describe('long-term approval gate', () => {
  const P = 'acme/app';
  const connect = async (clientName: string) => {
    const server = createServer({ db, mode: 'lite', project: { id: P, name: 'app', rootPath: process.cwd() } });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: clientName, version: '0' });
    await Promise.all([server.connect(x), client.connect(y)]);
    return async (args: Record<string, unknown>) => {
      const r = (await client.callTool({ name: 'synapse_lt_approve', arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((c) => c.text).join('\n'), isError: Boolean(r.isError) };
    };
  };
  const propose = () => proposeLongTerm(db, { projectId: P, kind: 'semantic', title: 'Webhooks need raw body', body: 'express.json breaks signatures' }).item;
  afterEach(() => {
    delete process.env.SYNAPSE_AGENT_APPROVAL;
  });

  it('refuses clients that do not force the approval prompt, unless the user opts in', async () => {
    expect(approvalRefusal('claude-code', {})).toBeUndefined();
    expect(approvalRefusal('cursor', {})).toMatch(/cannot guarantee/);
    expect(approvalRefusal('cursor', { SYNAPSE_AGENT_APPROVAL: '1' })).toBeUndefined();

    const item = propose();
    const approve = await connect('some-agent');
    const args = { id: item.id, title: item.title, scope: 'project', body: item.body, reason: 'ok' };
    const r = await approve(args);
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`synapse lt approve ${item.id}`);
    expect(getLongTerm(db, P, item.id)!.state).toBe('proposed');
    process.env.SYNAPSE_AGENT_APPROVAL = '1';
    expect((await approve(args)).isError).toBe(false);
    expect(getLongTerm(db, P, item.id)!.state).toBe('approved');
  });

  it('approves only when the call repeats the stored title, scope and body', async () => {
    const item = propose();
    const approve = await connect('claude-code');
    const base = { id: item.id, title: item.title, scope: 'project', body: item.body, reason: 'User confirmed' };
    const wrongBody = await approve({ ...base, body: 'something harmless' });
    expect(wrongBody.isError).toBe(true);
    expect(wrongBody.text).toContain('express.json breaks signatures'); // shows the real text to retry with
    expect((await approve({ ...base, scope: 'user' })).text).toMatch(/scope given do not match/);
    expect(getLongTerm(db, P, item.id)!.state).toBe('proposed');
    const ok = await approve({ ...base, body: '  express.json   breaks\nsignatures ' }); // whitespace differences are fine
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain('scope: project');

    const next = proposeLongTerm(db, { projectId: P, kind: 'semantic', title: 'Webhooks need the raw buffer', body: 'use express.raw' }).item;
    const nextArgs = { id: next.id, title: next.title, scope: 'project', body: next.body, reason: 'User confirmed', supersedes: item.id };
    expect((await approve(nextArgs)).text).toMatch(/supersedesTitle must repeat/);
    expect((await approve({ ...nextArgs, supersedesTitle: item.title })).text).toContain(`LT${item.id} superseded by LT${next.id}`);
  });
});

describe('file permissions', () => {
  it('makes a new database folder and the database files owner-only', () => {
    const base = tmp('syn-perm-');
    const file = path.join(base, 'new', 'synapse.db');
    const d = openDatabase(file);
    storeObservation(d, { projectId: 'p', entityName: 'e', type: 'gotcha', title: 't', narrative: 'n' });
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    d.close();
  });

  it('leaves the mode of a folder the user already had, but still restricts the files', () => {
    const base = tmp('syn-perm-');
    chmodSync(base, 0o755);
    const file = path.join(base, 'synapse.db');
    openDatabase(file).close();
    expect(statSync(base).mode & 0o777).toBe(0o755);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

it('lists proposed long-term items in full, so the agent can repeat their exact text', async () => {
  const P = 'acme/app';
  const long = 'x'.repeat(300);
  proposeLongTerm(db, { projectId: P, kind: 'semantic', title: 'Long one', body: long });
  const server = createServer({ db, mode: 'lite', project: { id: P, name: 'app', rootPath: process.cwd() } });
  const [x, y] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'claude-code', version: '0' });
  await Promise.all([server.connect(x), client.connect(y)]);
  const r = (await client.callTool({ name: 'synapse_lt_list', arguments: { state: 'proposed' } })) as { content: { text: string }[] };
  expect(r.content[0].text).toContain(long);
  expect(listObservations(db, {})).toEqual([]);
});
