/**
 * File notes (memories about a file, put in front of the agent when it reads or edits it) and the capture rule that
 * decides which shell commands become candidate memories.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatHookResult, normalizeHookPayload, type AgentId } from '../src/agents.js';
import { openDatabase, type DB } from '../src/db.js';
import { filesInCommand, memoriesForFile, notedFiles, stripHeredocs } from '../src/file-notes.js';
import { commandCapture, commandHead, handleHook, isReadOnlyCommand, isSignificantCommand, segments } from '../src/hooks.js';
import { detectProject } from '../src/project.js';
import { listObservations, storeObservation } from '../src/store.js';

let db: DB;
let dir: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  dir = mkdtempSync(path.join(os.tmpdir(), 'syn-notes-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src/page.ts'), 'export const PAGE = String.raw`...`;\n');
  writeFileSync(path.join(dir, 'src/other.ts'), 'export {};\n');
});
afterEach(() => {
  delete process.env.SYNAPSE_FILE_NOTES;
});

const project = () => detectProject(dir);
const remember = (type: 'gotcha' | 'decision' | 'how-it-works' | 'what-changed', title: string, files: string[], extra: Record<string, unknown> = {}) =>
  storeObservation(db, { projectId: project().id, entityName: 'ui', type, title, narrative: title + ' (details)', filesModified: files, rootPath: dir, ...extra }).observation;

/** Run a hook as an agent would, returning what the agent would receive on stdout. */
function run(agent: AgentId, raw: Record<string, unknown>): string | undefined {
  const contexts: string[] = [];
  for (const input of normalizeHookPayload(agent, raw)) {
    const r = handleHook(db, input);
    if (r.context && !contexts.includes(r.context)) contexts.push(r.context);
  }
  return formatHookResult(agent, String(raw.hook_event_name ?? ''), { context: contexts.join('\n\n') || undefined });
}
const read = (sid: string, file: string) => run('claude', { session_id: sid, cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(dir, file) } });
const contextOf = (out: string | undefined) => (out ? JSON.parse(out).hookSpecificOutput.additionalContext as string : undefined);

describe('capture rule', () => {
  it('judges significance on program words, not paths or heredoc bodies', () => {
    expect(commandHead('npx vitest run tests/ui.test.ts')).toBe('npx vitest run');
    expect(commandHead('grep -n "^  it(" tests/ui.test.ts')).toBe('grep');
    expect(commandHead('FOO=1 sudo npm run build')).toBe('npm run build');
    expect(isSignificantCommand('source ~/.nvm/nvm.sh >/dev/null && nvm use 22; npx vitest run tests/u')).toBe(true);
    expect(isSignificantCommand('cd /repo; npm run lint 2>&1 | tail -3')).toBe(true);
    expect(isSignificantCommand('grep -n "describe" tests/ui.test.ts | tail -8; tail -5 tests/ui.test.ts')).toBe(false);
    expect(isSignificantCommand("python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['npm', 'test'])\nEOF")).toBe(false);
    expect(isSignificantCommand("cat >> tests/core.test.ts <<'EOF'\nit('builds', () => {})\nEOF")).toBe(false);
    expect(isSignificantCommand('git commit -q -F - <<\'EOF\'\nAdd tests\nEOF')).toBe(false);
  });

  it('treats searches and file prints as read-only, but not in-place sed or anything that runs code', () => {
    expect(isReadOnlyCommand('sed -n 96,111p docs/cli.md; cat tests/ui.test.ts')).toBe(true);
    expect(isReadOnlyCommand('cd /repo; grep -n "\\${" src/ui-page.ts | grep -v LOGO')).toBe(true);
    expect(isReadOnlyCommand("sed -i '' 's/a/b/' src/x.ts")).toBe(false);
    expect(isReadOnlyCommand('grep -c x a.ts && npm test')).toBe(false);
    expect(isReadOnlyCommand('python3 script.py')).toBe(false);
    // Separators inside quotes don't split the chain.
    expect(segments('grep -n -i "devin" README.md | grep -iv "devin\'s\\|DEVIN_PROJECT\\|allow-tools" | head -60')).toEqual(['grep -n -i "devin" README.md', 'grep -iv "devin\'s\\|DEVIN_PROJECT\\|allow-tools"', 'head -60']);
    expect(isReadOnlyCommand('grep -n -i "devin" README.md | grep -iv "devin\'s\\|DEVIN_PROJECT" | head -60')).toBe(true);
    expect(segments("a && b || c; d\ne 'x;y'")).toEqual(['a', 'b', 'c', 'd', "e 'x;y'"]);
  });

  it('keeps failures and significant runs, and read-only commands only when the command itself broke', () => {
    expect(commandCapture('npm test', '3 passed', false)).toBe('discovery');
    expect(commandCapture('npm test', '1 failed', true)).toBe('gotcha');
    expect(commandCapture('python3 render.py', 'Traceback (most recent call last)', true)).toBe('gotcha');
    expect(commandCapture('python3 render.py', 'done', false)).toBe('skip');
    // grep exits 1 on no match, and printed code can contain "error:" lines: neither is a failure.
    expect(commandCapture('grep -n proposeLongTerm src/longterm.ts', '', true)).toBe('skip');
    expect(commandCapture('sed -n 90,112p src/cli.ts', '  error: something in the printed source', true)).toBe('skip');
    expect(commandCapture('sed -n 1,9p src/nope.ts', 'sed: src/nope.ts: No such file or directory', true)).toBe('gotcha');
    expect(commandCapture('rgx foo', 'zsh: command not found: rgx', true)).toBe('gotcha');
    expect(commandCapture('ls -la', '', false)).toBe('skip');
  });

  it('stops capturing the noisy commands that filled the candidate list', () => {
    const bash = (command: string, output: string, exit_code = 0) =>
      handleHook(db, { hook_event_name: 'PostToolUse', session_id: 's1', cwd: dir, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: output, exit_code } });
    bash('grep -n "^  it(" tests/ui.test.ts | tail -8', '46:  it(...)');
    bash('sed -n 90,112p src/cli.ts', 'error: printed code', 1);
    bash("python3 - <<'EOF'\nprint('test build')\nEOF", 'test build');
    bash('npx vitest run tests/ui.test.ts', '8 passed');
    expect(listObservations(db, { projectId: project().id, limit: 10 }).map((o) => o.title)).toEqual(['Ran: npx vitest run tests/ui.test.ts']);
  });
});

describe('file notes', () => {
  it('notes the reviewed memories about a file when the agent reads it, gotchas first, once per session', () => {
    const how = remember('how-it-works', 'How the page is built', ['src/page.ts']);
    const gotcha = remember('gotcha', 'Page is a String.raw template: no backticks', ['src/page.ts']);
    remember('gotcha', 'Unrelated', ['src/other.ts']);
    remember('what-changed', 'Edited src/page.ts', ['src/page.ts'], { source: 'hook', admissionState: 'candidate', topicKey: 'hook/file/src/page.ts/s0' });
    remember('gotcha', 'Unreviewed hook capture', ['src/page.ts'], { source: 'hook', admissionState: 'candidate' });

    const note = contextOf(read('s1', 'src/page.ts'))!;
    expect(note).toContain('Synapse memory about src/page.ts:');
    expect(note.split('\n').slice(1, 3)).toEqual([`⚠ #${gotcha.id} gotcha: Page is a String.raw template: no backticks`, `• #${how.id} how-it-works: How the page is built`]);
    expect(note).not.toContain('Unrelated');
    expect(note).not.toContain('Unreviewed');
    expect(note).not.toContain('Edited src/page.ts');
    expect(read('s1', 'src/page.ts')).toBeUndefined(); // once per session
    expect(read('s2', 'src/page.ts')).toBeDefined(); // another session is told again
    const access = db.prepare('SELECT accessCount FROM observation_access WHERE observationId = ?').get(gotcha.id) as { accessCount: number };
    expect(access.accessCount).toBe(2); // shown memories count as read
  });

  it('says when the file changed since the memory was stored, and forgets what it noted when the session ends', () => {
    remember('gotcha', 'Page is a String.raw template', ['src/page.ts']);
    writeFileSync(path.join(dir, 'src/page.ts'), 'changed\n');
    expect(contextOf(read('s1', 'src/page.ts'))).toMatch(/Page is a String.raw template \[changed since stored\][\s\S]*check \[changed since stored\] ones against the current code/);
    handleHook(db, { hook_event_name: 'SessionEnd', session_id: 's1', cwd: dir });
    expect(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'filenote:s1:%'").get()).toEqual({ n: 0 });
  });

  it('notes files a shell command names, and edits, but nothing for files without memories', () => {
    remember('decision', 'Keep the page self-contained', ['src/page.ts']);
    expect(filesInCommand("sed -n 1,80p src/page.ts && cat <<'EOF' > src/other.ts\nsrc/page.ts\nEOF", project(), notedFiles(db, project().id))).toEqual(['src/page.ts']);
    expect(stripHeredocs("cat <<'EOF'\nbody\nEOF\nnext")).toBe("cat <<'EOF'\nnext");
    const bash = run('claude', { session_id: 's1', cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `grep -n PAGE ${path.join(dir, 'src/page.ts')}` }, tool_response: { stdout: '1:', exit_code: 0 } });
    expect(contextOf(bash)).toContain('Keep the page self-contained');
    expect(read('s2', 'src/other.ts')).toBeUndefined();
    const edit = run('claude', { session_id: 's3', cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/page.ts'), new_string: 'x' } });
    expect(contextOf(edit)).toContain('Keep the page self-contained');
  });

  it('is delivered before the edit on Codex (PreToolUse, per patched file) and on Gemini reads, and not to agents without a channel', () => {
    remember('gotcha', 'Page is a String.raw template', ['src/page.ts']);
    const patch = '*** Begin Patch\n*** Update File: src/page.ts\n@@\n+x\n*** Update File: src/other.ts\n@@\n+y\n*** End Patch';
    const codex = run('codex', { session_id: 'c1', cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { input: patch } });
    expect(JSON.parse(codex!)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: expect.stringContaining('Page is a String.raw template') } });
    expect(JSON.parse(codex!).hookSpecificOutput).not.toHaveProperty('permissionDecision'); // never approves or blocks
    expect(listObservations(db, { projectId: project().id, limit: 10 }).some((o) => o.source === 'hook')).toBe(false); // PreToolUse captures nothing

    const gemini = run('gemini', { session_id: 'g1', cwd: dir, hook_event_name: 'AfterTool', tool_name: 'read_file', tool_input: { file_path: path.join(dir, 'src/page.ts') }, tool_response: {} });
    expect(JSON.parse(gemini!).hookSpecificOutput).toEqual({ hookEventName: 'AfterTool', additionalContext: expect.stringContaining('#') });

    expect(formatHookResult('cursor', 'afterFileEdit', { context: 'note' })).toBeUndefined();
    expect(formatHookResult('copilot', 'postToolUse', { context: 'note' })).toBeUndefined();
    expect(formatHookResult('devin', 'PostToolUse', { context: 'note' })).toBeUndefined();
  });

  it('can be turned off', () => {
    remember('gotcha', 'Page is a String.raw template', ['src/page.ts']);
    process.env.SYNAPSE_FILE_NOTES = '0';
    expect(read('s1', 'src/page.ts')).toBeUndefined();
    expect(memoriesForFile(db, project().id, 'src/page.ts')).toHaveLength(1);
  });
});
