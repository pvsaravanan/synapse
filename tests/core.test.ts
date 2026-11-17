import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildProjectContext, detectLens } from '../src/context.js';
import { openDatabase, type DB } from '../src/db.js';
import { ingestCommits, inferType, isNoiseCommit } from '../src/git.js';
import { handleHook, isTrivialCommand } from '../src/hooks.js';
import { exportProject, importBundle } from '../src/maintenance.js';
import { detectProject, normalizeGitRemote } from '../src/project.js';
import { relevance, retentionZone } from '../src/retention.js';
import { buildFtsQuery, search } from '../src/search.js';
import { redactSecrets } from '../src/secrets.js';
import { addCheckpoint, checkpointText, endSession, listCheckpoints, recentSessions, startSession } from '../src/sessions.js';
import { listObservations, recordFeedback, setStatus, storeObservation, timeline } from '../src/store.js';
import type { Observation, ProjectInfo } from '../src/types.js';

const P = 'acme/app';
let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
});

const base = { projectId: P, entityName: 'auth', type: 'gotcha' as const };

describe('project detection', () => {
  it('normalizes remotes across protocols', () => {
    expect(normalizeGitRemote('git@github.com:Acme/App.git')).toBe('acme/app');
    expect(normalizeGitRemote('https://github.com/acme/app')).toBe('acme/app');
    expect(normalizeGitRemote('ssh://git@gitlab.com:22/group/sub/repo.git')).toBe('group/sub/repo');
    expect(normalizeGitRemote('https://user:pw@host.com/a/b.git/')).toBe('a/b');
  });
  it('falls back to a hashed dir id outside git', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'syn-nogit-'));
    expect(detectProject(dir).id).toMatch(/^dir\/syn-nogit-.+-[0-9a-f]{8}$/);
  });
});

describe('secrets', () => {
  it('redacts credential values but keeps prose', () => {
    expect(redactSecrets('api_key=abcdef123456')).toBe('api_key=[REDACTED]');
    expect(redactSecrets('use ghp_' + 'a'.repeat(36))).toBe('use [REDACTED]');
    expect(redactSecrets('password must be 8 chars')).toBe('password must be 8 chars');
  });
  it('is applied on store', () => {
    const r = storeObservation(db, { ...base, title: 'Token', narrative: 'set token: supersecretvalue in env' });
    expect(r.observation.narrative).toContain('[REDACTED]');
    expect(r.observation.narrative).not.toContain('supersecretvalue');
  });
});

describe('store', () => {
  it('upserts by topicKey', () => {
    const a = storeObservation(db, { ...base, type: 'decision', title: 'Session model v1', narrative: 'JWT', topicKey: 'decisions/auth' });
    const b = storeObservation(db, { ...base, type: 'decision', title: 'Session model v2', narrative: 'opaque cookies', topicKey: 'decisions/auth' });
    expect(b.action).toBe('updated-topic');
    expect(b.observation.id).toBe(a.observation.id);
    expect(b.observation.revisionCount).toBe(2);
    expect(b.observation.title).toBe('Session model v2');
  });
  it('merges near-duplicates', () => {
    storeObservation(db, { ...base, title: 'Refresh token race', narrative: 'Two tabs refresh the token at the same time causing logout' });
    const r = storeObservation(db, { ...base, title: 'Refresh token race', narrative: 'Two tabs refresh the token at the same time causing a logout', facts: ['use a lock'] });
    expect(r.action).toBe('merged-duplicate');
    expect(listObservations(db, { projectId: P })).toHaveLength(1);
    expect(r.observation.facts).toContain('use a lock');
  });
  it('detects causal language and builds a timeline', () => {
    const ids = ['one', 'two', 'three'].map((t, i) =>
      storeObservation(db, { ...base, entityName: `e${i}`, title: `Step ${t}`, narrative: `because reason ${t} ${i}` }).observation.id);
    const t = timeline(db, ids[1]);
    expect(t.anchor?.hasCausalLanguage).toBe(true);
    expect(t.before.map((o) => o.id)).toEqual([ids[0]]);
    expect(t.after.map((o) => o.id)).toEqual([ids[2]]);
  });
});

describe('search', () => {
  it('quotes tokens and expands synonyms', () => {
    const q = buildFtsQuery('auth bug NEAR "x"')!;
    expect(q).toContain('"auth"');
    expect(q).toContain('"fix"');
    // user-typed FTS operators stay quoted data, never syntax
    expect(q).toContain('"near"');
    expect(buildFtsQuery('the and of')).toBeNull();
  });
  it('ranks lexical matches, excludes resolved, scopes by project', () => {
    const hit = storeObservation(db, { ...base, title: 'Webhook signature mismatch', narrative: 'Stripe webhook needs raw body' }).observation;
    const other = storeObservation(db, { ...base, entityName: 'ui', type: 'discovery', title: 'Button colors', narrative: 'Use tokens' }).observation;
    storeObservation(db, { ...base, projectId: 'other/proj', title: 'Webhook elsewhere', narrative: 'webhook' });
    expect(search(db, { query: 'webhook', projectId: P }).map((h) => h.observation.id)).toEqual([hit.id]);
    expect(search(db, { query: 'webhook' })).toHaveLength(2);
    setStatus(db, [hit.id], 'resolved');
    expect(search(db, { query: 'webhook', projectId: P })).toHaveLength(0);
    expect(search(db, { query: '', projectId: P }).map((h) => h.observation.id)).toEqual([other.id]);
  });
  it('prefix-matches and down-ranks candidates', () => {
    storeObservation(db, { ...base, entityName: 'a', title: 'Migration ordering', narrative: 'migrations run alphabetically', admissionState: 'candidate' });
    storeObservation(db, { ...base, entityName: 'b', title: 'Migration locks', narrative: 'migrations take a table lock' });
    const hits = search(db, { query: 'migrat', projectId: P });
    expect(hits).toHaveLength(2);
    expect(hits[0].observation.admissionState).toBe('qualified');
  });
});

describe('retention', () => {
  const mk = (over: Partial<Observation>): Observation => ({
    id: 1, projectId: P, entityName: 'x', type: 'what-changed', title: 't', narrative: '', facts: [], filesModified: [], concepts: [],
    tokens: 1, createdAt: new Date().toISOString(), revisionCount: 1, status: 'active', source: 'agent', relatedCommits: [],
    relatedEntities: [], admissionState: 'qualified', hasCausalLanguage: false, ...over,
  });
  it('decays with age and respects immunity', () => {
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    expect(relevance(mk({ createdAt: old }))).toBeLessThan(relevance(mk({})));
    expect(retentionZone(mk({ createdAt: old }))).toBe('archive-candidate');
    expect(retentionZone(mk({ createdAt: old, concepts: ['pinned'] }))).toBe('active');
  });
  it('feedback shifts ranking and outdated resolves', () => {
    const o = storeObservation(db, { ...base, title: 'Cache key', narrative: 'cache key includes locale' }).observation;
    recordFeedback(db, o.id, 'outdated');
    expect(listObservations(db, { projectId: P })).toHaveLength(0);
  });
});

describe('context brief', () => {
  it('detects lenses', () => {
    expect(detectLens('fix the login crash').id).toBe('bugfix');
    expect(detectLens('prepare the 2.0 release').id).toBe('release');
    expect(detectLens('hello').id).toBe('general');
  });
  it('reports a fresh project and then includes relevant memories and files', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'syn-ctx-'));
    writeFileSync(path.join(dir, 'auth.ts'), '');
    const proj: ProjectInfo = { id: P, name: 'app', rootPath: dir };
    expect(buildProjectContext(db, proj, 'fix login').text).toContain('fresh project');
    storeObservation(db, { ...base, type: 'problem-solution', title: 'Login loop on expired cookie', narrative: 'login redirect loop', filesModified: ['auth.ts', 'gone.ts'] });
    storeObservation(db, { ...base, entityName: 'db', title: 'Never run migrations in parallel', narrative: 'locks' });
    const brief = buildProjectContext(db, proj, 'fix login loop');
    expect(brief.lens).toBe('bugfix');
    expect(brief.text).toContain('Login loop on expired cookie');
    expect(brief.text).toContain('Never run migrations in parallel');
    expect(brief.startFiles).toEqual(['auth.ts']);
  });
});

describe('sessions', () => {
  it('tracks handoffs', () => {
    const s = startSession(db, P, { agent: 'test' });
    endSession(db, s.id, 'Finished auth; next: tests');
    expect(recentSessions(db, P)[0].summary).toBe('Finished auth; next: tests');
  });
});

describe('git memory', () => {
  it('infers types and filters noise', () => {
    expect(inferType('fix(auth): loop', '')).toBe('problem-solution');
    expect(inferType('perf: cache lookups', '')).toBe('trade-off');
    expect(inferType('Update README', '')).toBe('how-it-works');
    const c = { hash: 'h', shortHash: 'h', author: 'a', date: '', subject: 'chore: bump deps', body: '', filesChanged: ['package-lock.json'], insertions: 1, deletions: 1 };
    expect(isNoiseCommit(c).noise).toBe(true);
    expect(isNoiseCommit({ ...c, subject: 'Merge branch main' }).reason).toBe('merge');
  });
  it('ingests a real repo idempotently', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'syn-git-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('init', '-q');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    writeFileSync(path.join(dir, 'a.ts'), 'x');
    g('add', '.');
    g('commit', '-qm', 'feat(core): add a');
    writeFileSync(path.join(dir, 'a.ts'), 'y');
    g('commit', '-qam', 'fix(core): handle y');
    const first = ingestCommits(db, P, dir);
    expect(first.ingested).toBe(2);
    expect(ingestCommits(db, P, dir).skippedExisting).toBe(2);
    expect(search(db, { query: 'handle', projectId: P })[0].observation.type).toBe('problem-solution');
  });
});

describe('hooks', () => {
  it('filters trivial commands', () => {
    expect(isTrivialCommand('ls -la')).toBe(true);
    expect(isTrivialCommand('git status')).toBe(true);
    expect(isTrivialCommand('npm test')).toBe(false);
  });
  it('injects context, captures edits as rolling candidates, summarizes on end', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'syn-hook-'));
    const sid = 'sess-1';
    const start = handleHook(db, { hook_event_name: 'SessionStart', session_id: sid, cwd: dir, source: 'startup' });
    expect(start.context).toContain('Synapse');
    handleHook(db, { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: dir, prompt: 'Add rate limiting to the public API' });
    for (const s of ['a', 'b']) {
      handleHook(db, { hook_event_name: 'PostToolUse', session_id: sid, cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/api/limit.ts'), new_string: s } });
    }
    handleHook(db, { hook_event_name: 'PostToolUse', session_id: sid, cwd: dir, tool_name: 'Read', tool_input: { file_path: 'x' } });
    handleHook(db, { hook_event_name: 'PostToolUse', session_id: sid, cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'x' });
    handleHook(db, { hook_event_name: 'PostToolUse', session_id: sid, cwd: dir, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'Error: 1 failed' });
    const pid = detectProject(dir).id;
    const obs = listObservations(db, { projectId: pid });
    expect(obs.map((o) => o.type).sort()).toEqual(['gotcha', 'session-request', 'what-changed']);
    const edit = obs.find((o) => o.type === 'what-changed')!;
    expect(edit.revisionCount).toBe(2);
    expect(edit.admissionState).toBe('candidate');
    expect(edit.entityName).toBe('api');
    handleHook(db, { hook_event_name: 'SessionEnd', session_id: sid, cwd: dir });
    expect(recentSessions(db, pid)[0].summary).toMatch(/Goal: Add rate limiting.*src\/api\/limit\.ts/);
  });

  it('reopens a resumed session so its end summary covers the work after resume', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'syn-resume-'));
    const sid = 'sess-resume';
    const write = (f: string) => handleHook(db, { hook_event_name: 'PostToolUse', session_id: sid, cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, f), content: 'x' } });
    handleHook(db, { hook_event_name: 'SessionStart', session_id: sid, cwd: dir, source: 'startup' });
    write('src/a.ts');
    handleHook(db, { hook_event_name: 'SessionEnd', session_id: sid, cwd: dir });
    handleHook(db, { hook_event_name: 'SessionStart', session_id: sid, cwd: dir, source: 'resume' });
    write('src/b.ts');
    handleHook(db, { hook_event_name: 'SessionEnd', session_id: sid, cwd: dir });
    const s = recentSessions(db, detectProject(dir).id, 5, false).find((x) => x.id === sid)!;
    expect(s.status).toBe('completed');
    expect(s.summary).toContain('src/b.ts');

    // An agent that resumes without firing SessionStart: the first edit reopens the session.
    write('src/c.ts');
    expect(recentSessions(db, detectProject(dir).id, 5, false).find((x) => x.id === sid)!.status).toBe('active');
    handleHook(db, { hook_event_name: 'SessionEnd', session_id: sid, cwd: dir });
    const again = recentSessions(db, detectProject(dir).id, 5, false).find((x) => x.id === sid)!;
    expect(again.status).toBe('completed');
    expect(again.summary).toContain('src/c.ts');
  });

  it('keeps one checkpoint per compaction and surfaces the latest after compaction', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'syn-cp-'));
    const sid = 'sess-cp';
    const pid = detectProject(dir).id;
    const edit = (f: string) => handleHook(db, { hook_event_name: 'PostToolUse', session_id: sid, cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(dir, f), content: 'x' } });
    handleHook(db, { hook_event_name: 'UserPromptSubmit', session_id: sid, cwd: dir, prompt: 'Migrate the billing module to the new API' });
    edit('src/billing/a.ts');
    handleHook(db, { hook_event_name: 'PreCompact', session_id: sid, cwd: dir });
    // Nothing changed: a second compaction adds no duplicate row.
    handleHook(db, { hook_event_name: 'PreCompact', session_id: sid, cwd: dir });
    edit('src/billing/b.ts');
    handleHook(db, { hook_event_name: 'PreCompact', session_id: sid, cwd: dir });

    const cps = listCheckpoints(db, pid, { sessionId: sid });
    expect(cps).toHaveLength(2);
    expect(cps[1].summary).toContain('src/billing/a.ts');
    expect(cps[1].summary).not.toContain('b.ts');
    expect(cps[0].summary).toContain('src/billing/b.ts');

    const after = handleHook(db, { hook_event_name: 'SessionStart', session_id: sid, cwd: dir, source: 'compact' });
    expect(after.context).toMatch(/## Checkpoint\n- .*Goal: Migrate the billing module.*src\/billing\/b\.ts/);
    // A brand-new session does not inherit another session's checkpoint.
    const fresh = handleHook(db, { hook_event_name: 'SessionStart', session_id: 'other', cwd: dir, source: 'startup' });
    expect(fresh.context).not.toContain('## Checkpoint');
  });

  it('stores the agent summary alongside ours, redacted, and shows it in minimal mode', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'syn-cp2-'));
    const pid = detectProject(dir).id;
    handleHook(db, { hook_event_name: 'PreCompact', session_id: 's2', cwd: dir, summary: 'Wired webhooks; api_key=sk-abcdef1234567890 next: retries' });
    const [cp] = listCheckpoints(db, pid);
    expect(cp.summary).toBeUndefined();
    expect(cp.agentSummary).toContain('[REDACTED]');
    expect(checkpointText(cp)).toContain('Wired webhooks');
    const prev = process.env.SYNAPSE_HOOK_INJECT;
    process.env.SYNAPSE_HOOK_INJECT = 'minimal';
    try {
      const out = handleHook(db, { hook_event_name: 'SessionStart', session_id: 's2', cwd: dir, source: 'compact' });
      expect(out.context).toMatch(/Last checkpoint \(.*\): Wired webhooks/);
    } finally {
      if (prev === undefined) delete process.env.SYNAPSE_HOOK_INJECT;
      else process.env.SYNAPSE_HOOK_INJECT = prev;
    }
    expect(addCheckpoint(db, pid, 's2', { summary: '  ', agentSummary: '' })).toBeUndefined();
    expect(exportProject(db, pid).checkpoints).toHaveLength(1);
  });
});

describe('export/import', () => {
  it('round-trips', () => {
    storeObservation(db, { ...base, title: 'One', narrative: 'first thing' });
    storeObservation(db, { ...base, entityName: 'z', title: 'Two', narrative: 'second', topicKey: 'k' });
    const bundle = exportProject(db, P);
    const db2 = openDatabase(':memory:');
    expect(importBundle(db2, bundle)).toEqual({ imported: 2, merged: 0 });
    expect(importBundle(db2, bundle)).toEqual({ imported: 0, merged: 2 });
  });
});

describe('live-test regressions', () => {
  it('ranks a focused memory above a noisy candidate in a small store (BM25 IDF collapse)', () => {
    // "node" appears in every memory, so its IDF is ~0; coverage must still separate them.
    storeObservation(db, { ...base, entityName: 'commands', title: 'Command failed: export PATH=.nvm/versions/node/v22/bin', narrative: 'node node versions node v22 node bin node', admissionState: 'candidate' });
    storeObservation(db, { ...base, entityName: 'docs', type: 'what-changed', title: 'Edited docs/cli.md', narrative: 'Print the installed version', admissionState: 'candidate' });
    const gotcha = storeObservation(db, { ...base, entityName: 'install', title: 'Synapse needs Node 22 for node:sqlite', narrative: 'The default node is v20, so the command fails with a version problem.' }).observation;
    expect(search(db, { query: 'node version problem', projectId: P })[0].observation.id).toBe(gotcha.id);
  });

  it('prefix-matches synonyms in coverage (problem -> fail -> "fails")', async () => {
    const { queryCoverage } = await import('../src/search.js');
    const o = storeObservation(db, { ...base, title: 'Build', narrative: 'the build fails on node 20' }).observation;
    expect(queryCoverage(['node', 'problem'], o)).toBe(1);
  });

  it('does not capture Synapse invoking itself or echoing its own output', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'syn-self-'));
    const ev = (command: string, tool_response: string) =>
      handleHook(db, { hook_event_name: 'PostToolUse', session_id: 's', cwd: dir, tool_name: 'Bash', tool_input: { command }, tool_response });
    ev('cd /x/proj && synapse stats', 'Error: nothing');
    ev('npm run build && node dist/cli.js search x', 'Synapse results for "x" (1)\n#1 [GOTCHA] Command failed: y');
    expect(listObservations(db, { projectId: detectProject(dir).id })).toHaveLength(0);
    // A real failure in a repo whose path contains "synapse" is still captured.
    ev('cd /Users/me/proj/synapse && npm test', 'Error: 1 test failed');
    expect(listObservations(db, { projectId: detectProject(dir).id })).toHaveLength(1);
  });

  it('ignores edits to files outside the project root', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'syn-out-'));
    handleHook(db, { hook_event_name: 'PostToolUse', session_id: 's', cwd: dir, tool_name: 'Write', tool_input: { file_path: path.join(os.tmpdir(), 'elsewhere', 'scratch.mjs'), content: 'x' } });
    handleHook(db, { hook_event_name: 'PostToolUse', session_id: 's', cwd: dir, tool_name: 'Write', tool_input: { file_path: 'src/inside.ts', content: 'y' } });
    const obs = listObservations(db, { projectId: detectProject(dir).id });
    expect(obs.map((o) => o.filesModified[0])).toEqual(['src/inside.ts']);
  });
});

describe('command chains', () => {
  it('treats a chain as trivial only when every segment is', () => {
    expect(isTrivialCommand('cd src && ls')).toBe(true);
    expect(isTrivialCommand('cd repo && npm test')).toBe(false);
    expect(isTrivialCommand('export X=1; git status | head')).toBe(true);
  });
});
