/**
 * .synapseignore and the consolidation of auto-captured memories.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { normalizeHookPayload } from '../src/agents.js';
import { consolidateProject, consolidateSession } from '../src/consolidate.js';
import { openDatabase, type DB } from '../src/db.js';
import { hashFiles } from '../src/freshness.js';
import { handleHook } from '../src/hooks.js';
import { isIgnored, matches, parseIgnore } from '../src/ignore.js';
import { detectProject } from '../src/project.js';
import { getObservation, listObservations, promoteObservation, recordAccess } from '../src/store.js';

let db: DB;
let dir: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  dir = mkdtempSync(path.join(os.tmpdir(), 'syn-cons-'));
});

const hook = (sid: string, raw: Record<string, unknown>) => {
  for (const input of normalizeHookPayload('claude', { session_id: sid, cwd: dir, ...raw })) handleHook(db, input);
};
const edit = (sid: string, file: string, text = 'x') => hook(sid, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, file), new_string: text } });
const bash = (sid: string, command: string) => hook(sid, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: 'ok', exit_code: 0 } });
const end = (sid: string) => hook(sid, { hook_event_name: 'SessionEnd' });
const project = () => detectProject(dir);
const active = () => listObservations(db, { projectId: project().id, limit: 100, status: 'active' });
const titles = () => active().map((o) => o.title).sort();

describe('.synapseignore', () => {
  it('matches gitignore-style patterns; the last match wins', () => {
    const rules = parseIgnore(['# generated', 'dist/', '/build', '*.log', 'docs/**/*.png', 'secrets', '!keep.log'].join('\n'));
    const m = (p: string) => matches(rules, p);
    expect(m('dist/app.js')).toBe(true);
    expect(m('pkg/dist/app.js')).toBe(true);
    expect(m('src/dist')).toBe(false); // a file named dist, not the directory
    expect(m('build/out.js')).toBe(true);
    expect(m('src/build/out.js')).toBe(false); // anchored to the root
    expect(m('logs/server.log')).toBe(true);
    expect(m('keep.log')).toBe(false);
    expect(m('docs/img/a/b.png')).toBe(true);
    expect(m('docs/b.png')).toBe(true);
    expect(m('secrets/prod.json')).toBe(true);
    expect(m('src/app.ts')).toBe(false);
  });

  it('ignores secret-shaped files by default, re-included with "!"', () => {
    expect(isIgnored(dir, '.env')).toBe(true);
    expect(isIgnored(dir, 'config/.env.production')).toBe(true);
    expect(isIgnored(dir, 'certs/server.pem')).toBe(true);
    writeFileSync(path.join(dir, '.synapseignore'), '!.env.example\n');
    expect(isIgnored(dir, '.env.example')).toBe(false);
    expect(isIgnored(dir, '.env')).toBe(true);
  });

  it('keeps ignored files out of edit capture and file freshness', () => {
    writeFileSync(path.join(dir, '.synapseignore'), 'generated/\n');
    edit('s1', 'generated/api.ts');
    edit('s1', '.env', 'SECRET=1');
    edit('s1', 'src/api.ts');
    expect(titles()).toEqual(['Edited src/api.ts']);
    expect(Object.keys(hashFiles(dir, ['generated/api.ts', '.env', 'src/api.ts']))).toEqual(['src/api.ts']);
  });
});

describe('consolidation', () => {
  it('merges a session\'s edit records per area when it ends, archiving the originals', () => {
    hook('s1', { hook_event_name: 'UserPromptSubmit', prompt: 'Add rate limiting to the public API' });
    edit('s1', 'src/api/limit.ts', 'export const LIMIT = 10;');
    edit('s1', 'src/api/routes.ts', 'app.use(limit)');
    edit('s1', 'src/api/limit.test.ts');
    edit('s1', 'README.md');
    end('s1');
    const merged = active().find((o) => o.title.startsWith('Changed api'))!;
    expect(merged.title).toBe('Changed api: src/api/limit.ts, src/api/routes.ts, src/api/limit.test.ts');
    expect(merged.narrative).toContain('Session goal: Add rate limiting to the public API');
    expect(merged.narrative).toContain('- src/api/limit.ts: export const LIMIT = 10;');
    expect(merged.filesModified.sort()).toEqual(['src/api/limit.test.ts', 'src/api/limit.ts', 'src/api/routes.ts']);
    expect(titles()).toContain('Edited README.md'); // a single record in its area stays as it is
    const originals = listObservations(db, { projectId: project().id, limit: 100, status: 'archived' });
    expect(originals.map((o) => o.title).sort()).toEqual(['Edited src/api/limit.test.ts', 'Edited src/api/limit.ts', 'Edited src/api/routes.ts']);
    expect(originals.every((o) => o.supersededBy === merged.id)).toBe(true);
  });

  it('folds later edits into the same merged record when a session closes again (Antigravity)', () => {
    edit('s1', 'src/api/a.ts');
    edit('s1', 'src/api/b.ts');
    end('s1');
    hook('s1', { hook_event_name: 'UserPromptSubmit', prompt: 'continue' }); // reopens the session
    edit('s1', 'src/api/c.ts');
    end('s1');
    const merged = active().filter((o) => o.title.startsWith('Changed api'));
    expect(merged).toHaveLength(1);
    expect(merged[0].filesModified.sort()).toEqual(['src/api/a.ts', 'src/api/b.ts', 'src/api/c.ts']);
  });

  it('keeps only the newest "Ran:" record per command across sessions', () => {
    bash('s1', 'npm test 2>&1 | tail -5');
    end('s1');
    bash('s2', 'npm test');
    bash('s2', 'npm run build');
    end('s2');
    const runs = active().filter((o) => o.title.startsWith('Ran: '));
    expect(runs.map((o) => `${o.title} ${o.sessionId}`).sort()).toEqual(['Ran: npm run build s2', 'Ran: npm test s2']);
    const old = listObservations(db, { projectId: project().id, limit: 100, status: 'archived' }).find((o) => o.title.startsWith('Ran: npm test 2>&1'))!;
    expect(getObservation(db, old.supersededBy!)!.sessionId).toBe('s2');
  });

  it('leaves records that were qualified or retrieved alone', () => {
    edit('s1', 'src/api/a.ts');
    edit('s1', 'src/api/b.ts');
    edit('s1', 'src/api/c.ts');
    const [a, b] = active().filter((o) => o.title.startsWith('Edited'));
    promoteObservation(db, a.id);
    recordAccess(db, [b.id]);
    end('s1');
    expect(titles()).toEqual(expect.arrayContaining([a.title, b.title]));
    expect(titles().some((t) => t.startsWith('Changed api'))).toBe(false); // only one untouched record was left in the area
  });

  it('consolidates past sessions on demand, with a dry run that changes nothing', () => {
    // Simulate history captured before consolidation existed: records from a session ended without consolidating.
    edit('s1', 'src/api/a.ts');
    edit('s1', 'src/api/b.ts');
    db.prepare("UPDATE sessions SET status = 'completed', endedAt = ? WHERE id = 's1'").run(new Date().toISOString());
    const dry = consolidateProject(db, project(), { dryRun: true });
    expect(dry).toHaveLength(1);
    expect(dry[0].merged[0]).toMatchObject({ entity: 'api', files: ['src/api/a.ts', 'src/api/b.ts'] });
    expect(dry[0].merged[0].into).toBeUndefined();
    expect(titles()).toEqual(['Edited src/api/a.ts', 'Edited src/api/b.ts']);
    consolidateProject(db, project());
    expect(titles()).toEqual(['Changed api: src/api/a.ts, src/api/b.ts']);
    expect(consolidateSession(db, project(), 's1').merged).toEqual([]); // nothing left to do
  });

  it('keeps fix detection and freshness working on consolidated sessions', () => {
    edit('s1', 'src/api/a.ts');
    edit('s1', 'src/api/b.ts');
    end('s1');
    hook('s1', { hook_event_name: 'UserPromptSubmit', prompt: 'continue' });
    hook('s1', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: '1 failed', exit_code: 1 } });
    bash('s1', 'npm test'); // passes with no edits since the failure: the merged record must not count as one
    expect(active().some((o) => o.type === 'problem-solution')).toBe(false);
  });
});
