/**
 * Fix detection (a command that passes after failing, with edits in between) and the once-per-session reminder to
 * store what was learned.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatHookResult, normalizeHookPayload, type AgentId } from '../src/agents.js';
import { openDatabase, type DB } from '../src/db.js';
import { handleHook } from '../src/hooks.js';
import { detectProject } from '../src/project.js';
import { recentSessions } from '../src/sessions.js';
import { listObservations, storeObservation } from '../src/store.js';

let db: DB;
let dir: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  dir = mkdtempSync(path.join(os.tmpdir(), 'syn-nudge-'));
});
afterEach(() => {
  delete process.env.SYNAPSE_NUDGE;
});

const sid = 's1';
const hook = (raw: Record<string, unknown>, agent: AgentId = 'claude') => {
  let out: ReturnType<typeof handleHook> = {};
  for (const input of normalizeHookPayload(agent, { session_id: sid, cwd: dir, ...raw })) out = { ...out, ...handleHook(db, input) };
  return { out, text: formatHookResult(agent, String(raw.hook_event_name), out) };
};
const edit = (file: string) => hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, file), new_string: 'x' } });
const bash = (command: string, exitCode: number, stdout = '') =>
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: exitCode ? 'Error: boom' : '', exit_code: exitCode } });
const stop = (extra: Record<string, unknown> = {}) => hook({ hook_event_name: 'Stop', stop_hook_active: false, ...extra });
const all = () => listObservations(db, { projectId: detectProject(dir).id, limit: 50, status: 'all' });

describe('fix detection', () => {
  it('turns fail -> edit -> pass of the same command into a draft fix and resolves the failure', () => {
    bash('npm test', 1, '2 tests failed');
    edit('src/limit.ts');
    edit('src/limit.test.ts');
    bash('npm test', 0, 'all passed');
    const fix = all().find((o) => o.type === 'problem-solution')!;
    expect(fix).toMatchObject({ title: 'Fixed: npm test', source: 'hook', admissionState: 'candidate', status: 'active' });
    expect(fix.filesModified.sort()).toEqual(['src/limit.test.ts', 'src/limit.ts']);
    expect(fix.narrative).toContain('`npm test` failed, then passed after changes to');
    expect(fix.narrative).toContain('2 tests failed');
    expect(all().find((o) => o.title === 'Command failed: npm test')!.status).toBe('resolved');
    expect(all().some((o) => o.title === 'Ran: npm test')).toBe(false);
  });

  it('is not a fix when nothing was edited in between, or for a different command', () => {
    bash('npm test', 1);
    bash('npm test', 0);
    expect(all().some((o) => o.type === 'problem-solution')).toBe(false);
    bash('npm run build', 1);
    edit('src/a.ts');
    bash('npm run lint', 0);
    expect(all().some((o) => o.type === 'problem-solution')).toBe(false);
    expect(all().find((o) => o.title === 'Command failed: npm run build')!.status).toBe('active');
  });

  it('counts only edits made after the last failure', () => {
    edit('src/early.ts');
    bash('node check.js', 1);
    edit('src/late.ts');
    bash('node check.js', 0);
    expect(all().find((o) => o.type === 'problem-solution')!.filesModified).toEqual(['src/late.ts']);
  });
});

describe('draft fixes give way to the agent\'s own', () => {
  it('resolves the session\'s drafts for the same files when the agent stores a problem-solution', () => {
    bash('npm test', 1);
    edit('src/price.js');
    bash('npm test', 0);
    bash('npm run lint', 1);
    edit('src/other.js');
    bash('npm run lint', 0);
    const projectId = detectProject(dir).id;
    storeObservation(db, { projectId, sessionId: sid, entityName: 'price', type: 'problem-solution', title: 'total() returns cents', narrative: 'Removed the /100', filesModified: ['src/price.js'] });
    const drafts = all().filter((o) => o.source === 'hook' && o.type === 'problem-solution');
    expect(drafts.find((o) => o.title === 'Fixed: npm test')!.status).toBe('resolved');
    expect(drafts.find((o) => o.title === 'Fixed: npm run lint')!.status).toBe('active');
    // Another session's memory, or a non-fix, leaves drafts alone.
    storeObservation(db, { projectId, sessionId: sid, entityName: 'x', type: 'gotcha', title: 'Lint config quirk', narrative: 'n', filesModified: ['src/other.js'] });
    expect(all().find((o) => o.title === 'Fixed: npm run lint')!.status).toBe('active');
  });
});

describe('store reminder on Stop', () => {
  it('asks once after a fix, mentioning the draft, as a Claude Code block decision', () => {
    bash('npm test', 1);
    edit('src/a.ts');
    bash('npm test', 0);
    const { text } = stop();
    const out = JSON.parse(text!);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(/this session fixed `npm test` after it failed and edited 1 file but stored no Synapse memories/);
    expect(out.reason).toMatch(/Synapse drafted #\d+ "Fixed: npm test"/);
    expect(stop().text).toBeUndefined(); // once per session
  });

  it('asks after edits to 3+ files, but not for fewer', () => {
    edit('a.ts');
    edit('b.ts');
    expect(stop().text).toBeUndefined();
    edit('c.ts');
    expect(JSON.parse(stop().text!).reason).toContain('edited 3 files');
  });

  it('stays quiet when the agent stored a memory itself, when already continuing, or with SYNAPSE_NUDGE=0', () => {
    ['a.ts', 'b.ts', 'c.ts'].forEach(edit);
    expect(stop({ stop_hook_active: true }).text).toBeUndefined();
    storeObservation(db, { projectId: detectProject(dir).id, sessionId: sid, entityName: 'x', type: 'gotcha', title: 'A real gotcha', narrative: 'n' });
    expect(stop().text).toBeUndefined();
    process.env.SYNAPSE_NUDGE = '0';
    hook({ hook_event_name: 'PostToolUse', session_id: 's2', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'd.ts'), new_string: 'x' } });
    expect(hook({ hook_event_name: 'Stop', session_id: 's2' }).text).toBeUndefined();
  });

  it('Codex uses the same block decision', () => {
    ['a.ts', 'b.ts', 'c.ts'].forEach((f) => hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, f), new_string: 'x' } }, 'codex'));
    expect(JSON.parse(hook({ hook_event_name: 'Stop', stop_hook_active: false }, 'codex').text!).decision).toBe('block');
  });

  it('Antigravity continues with decision "continue", then closes the session on the next Stop', () => {
    const ag = (raw: Record<string, unknown>) => {
      let out: ReturnType<typeof handleHook> = {};
      for (const input of normalizeHookPayload('antigravity', { conversationId: 'ag', workspacePaths: [dir], ...raw })) out = { ...out, ...handleHook(db, input) };
      return formatHookResult('antigravity', String(raw.hook_event_name), out);
    };
    for (const f of ['a.ts', 'b.ts', 'c.ts']) ag({ hook_event_name: 'PostToolUse', toolCall: { name: 'write_to_file', args: { TargetFile: f, CodeContent: 'x' } } });
    expect(JSON.parse(ag({ hook_event_name: 'Stop', fullyIdle: true })!)).toMatchObject({ decision: 'continue' });
    expect(recentSessions(db, detectProject(dir).id, 1, false)[0].status).toBe('active');
    expect(ag({ hook_event_name: 'Stop', fullyIdle: true })).toBeUndefined();
    expect(recentSessions(db, detectProject(dir).id, 1, false)[0].status).toBe('completed');
  });
});

describe('commandKey', () => {
  it('reduces a shell line to the command it is about', async () => {
    const { commandKey } = await import('../src/hooks.js');
    expect(commandKey('npm test 2>&1 | tail -30; cat src/price.js')).toBe('npm test');
    expect(commandKey('npm test 2>&1 | tail -10')).toBe('npm test');
    expect(commandKey('cd app && CI=1 npm test >/dev/null')).toBe('npm test');
    expect(commandKey('pytest -x tests/test_api.py')).toBe('pytest -x tests/test_api.py');
    expect(commandKey('ls')).toBe('ls');
    // Environment setup steps aren't the command (seen live: "Fixed: source ~/.nvm/nvm.sh").
    expect(commandKey('source ~/.nvm/nvm.sh >/dev/null; nvm use 22 >/dev/null; npm test')).toBe('npm test');
    expect(commandKey('. .venv/bin/activate && pytest -q')).toBe('pytest -q');
  });

  it('matches a pass to a failure written differently (as seen live in Claude Code)', () => {
    // Claude Code's Bash result has no exit code here; the failure comes from the output.
    const run = (command: string, stdout: string) => hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '' } });
    run('npm test 2>&1 | tail -30; cat src/price.js', 'Error: expected total 599 cents, got 5.99');
    edit('src/price.js');
    run('npm test 2>&1 | tail -10', 'ok');
    expect(all().find((o) => o.type === 'problem-solution')!.title).toBe('Fixed: npm test');
  });
});
