/**
 * Reflection: recurring failures in hook-captured records grouped into patterns for the agent to summarise, filing
 * and dismissing them, and the capture fixes that keep the input clean (command keys, read-only false failures).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildProjectContext } from '../src/context.js';
import { openDatabase, type DB } from '../src/db.js';
import { commandCapture, commandKey, handleHook } from '../src/hooks.js';
import { detectProject } from '../src/project.js';
import { errorLine, errorSignature, findPatterns, formatPatterns, resolvePattern } from '../src/reflect.js';
import { createServer } from '../src/server.js';
import { getObservation, storeObservation } from '../src/store.js';
import type { ProjectInfo } from '../src/types.js';

let db: DB;
let dir: string;
let project: ProjectInfo;
beforeEach(() => {
  db = openDatabase(':memory:');
  dir = mkdtempSync(path.join(os.tmpdir(), 'syn-reflect-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src/config.ts'), 'export const C = 1;\n');
  project = detectProject(dir);
});

const hook = (session: string, raw: Record<string, unknown>) => handleHook(db, { session_id: session, cwd: dir, ...raw } as never);
const run = (session: string, command: string, output: string, exitCode: number) =>
  hook(session, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: output, exit_code: exitCode } });
const edit = (session: string, file: string) =>
  hook(session, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, file), new_string: 'x' } });
const MODULE = "Error: Cannot find module './config' from 'src/app.ts'";

describe('finding patterns', () => {
  it('groups the same failure across sessions, with the errors seen and the files that fixed it', () => {
    run('s1', 'npm test 2>&1 | tail -30', `> test\n${MODULE}\nTest Files  1 failed (1)`, 1);
    run('s2', 'cd app && npm test', `${MODULE.replace('src/app.ts', 'src/main.ts')}\nTest Files  2 failed (2)`, 1);
    edit('s2', 'src/config.ts');
    run('s2', 'npm test', 'Test Files  3 passed (3)', 0); // drafts a fix and resolves the s2 failure
    run('s3', 'npm test', 'FAIL  tests/other.test.ts > something else\nTest Files  1 failed (1)', 1); // a different failure...
    run('s3', 'npm test', `${MODULE}\n`, 1); // ...replaced by the session's latest npm test failure (one record per command per session)

    const patterns = findPatterns(db, project.id);
    expect(patterns).toHaveLength(1);
    const [p] = patterns;
    expect(p).toMatchObject({ kind: 'failure', label: 'npm test', sessions: 3, fixes: 1, fixFiles: [{ file: 'src/config.ts', fixes: 1 }] });
    expect(p.errors[0]).toMatch(/^Error: Cannot find module '.\/config'/);
    expect(p.recordIds).toHaveLength(4); // three failures and the fix draft
    expect(p.key).toMatch(/^p-[0-9a-f]{8}$/);
    expect(findPatterns(db, project.id, { minSessions: 4 })).toEqual([]);

    const text = formatPatterns(patterns, { forAgent: true });
    expect(text).toContain(`${p.key} · \`npm test\` failed in 3 sessions (4 records`);
    expect(text).toContain('Fixed 1 time by changing: src/config.ts');
    expect(text).toContain('synapse_reflect { pattern, memoryId }');
  });

  it('finds one error behind different commands, but not different errors behind one command', () => {
    run('s1', 'npm run build', MODULE, 1);
    run('s2', 'npx tsc --noEmit', MODULE.replace("'src/app.ts'", "'src/b.ts'"), 1);
    run('s3', 'npm test', 'Error: listen EADDRINUSE: address already in use :::3000', 1);
    run('s4', 'npm test', 'Error: connect ECONNREFUSED 127.0.0.1:5432', 1);
    const patterns = findPatterns(db, project.id);
    expect(patterns.map((p) => [p.kind, p.commands])).toEqual([['error', ['npm run build', 'npx tsc --noEmit']]]);
  });

  it('never builds an error pattern from summary lines alone, and ignores read-only commands', () => {
    run('s1', 'npm test', 'Test Files  1 failed (1)', 1);
    run('s2', 'npm run e2e', 'Test Files  4 failed (4)', 1);
    expect(findPatterns(db, project.id)).toEqual([]);
    // A captured read-only "failure" from before the capture fix is not evidence either.
    for (const s of ['s3', 's4']) {
      storeObservation(db, { projectId: project.id, entityName: 'commands', type: 'gotcha', title: 'Command failed: grep x', narrative: '$ grep -n x src/a.ts\n\nError: x', source: 'hook', admissionState: 'candidate', sessionId: s, topicKey: `hook/cmd/grep/${s}` });
    }
    expect(findPatterns(db, project.id)).toEqual([]);
  });

  it('normalises error lines so runs that differ only in paths and numbers match', () => {
    expect(errorSignature("Error: Cannot find module './config' from 'src/app.ts'")).toBe(errorSignature("Error: Cannot find module './cfg' from 'lib/x.ts'"));
    expect(errorSignature('src/a.ts(3,5): error TS2322: Type string')).toBe(errorSignature('lib/b.ts(10,1): error TS2322: Type string'));
    expect(errorLine('$ npm test\nTest Files  1 failed (1)\nAssertionError: expected 1 to be 2')).toBeUndefined(); // AssertionError isn't a FAILURE_LINE
    expect(errorLine('$ npm test\nTest Files  1 failed (1)\nFAIL  tests/a.test.ts > x')).toBe('FAIL  tests/a.test.ts > x');
    expect(errorLine('$ npm test\nTest Files  1 failed (1)', { generic: true })).toBe('Test Files  1 failed (1)');
  });
});

describe('filing and dismissing', () => {
  const recurring = (sessions: string[]) => sessions.forEach((s) => run(s, 'npm test', MODULE, 1));

  it('files a pattern under the memory that explains it, and shows it again only if it recurs in new sessions', () => {
    recurring(['s1', 's2', 's3']);
    const [p] = findPatterns(db, project.id);
    const memory = storeObservation(db, { projectId: project.id, entityName: 'build', type: 'problem-solution', title: 'Tests need the config module built', narrative: 'Run npm run build first.' }).observation;
    expect(() => resolvePattern(db, project.id, p.key, { memoryId: p.recordIds[0] })).toThrow(/itself an auto-captured record/);
    expect(() => resolvePattern(db, project.id, p.key, {})).toThrow(/Pass memoryId/);
    expect(resolvePattern(db, project.id, p.key, { memoryId: memory.id }).archived).toBe(3);
    for (const id of p.recordIds) expect(getObservation(db, id)).toMatchObject({ status: 'archived', supersededBy: memory.id });
    expect(findPatterns(db, project.id)).toEqual([]);
    expect(() => resolvePattern(db, project.id, p.key, { memoryId: memory.id })).toThrow(/No pattern/);

    recurring(['s4']);
    expect(findPatterns(db, project.id)).toEqual([]); // one new session isn't a recurrence yet
    recurring(['s5']);
    expect(findPatterns(db, project.id)).toEqual([expect.objectContaining({ key: p.key, sessions: 2, recurred: true })]);
  });

  it('dismisses noise without touching its records', () => {
    recurring(['s1', 's2']);
    const [p] = findPatterns(db, project.id);
    expect(resolvePattern(db, project.id, p.key, { dismiss: true }).archived).toBe(0);
    expect(getObservation(db, p.recordIds[0])!.status).toBe('active');
    expect(findPatterns(db, project.id)).toEqual([]);
  });
});

describe('surfacing', () => {
  it('notes waiting patterns in the brief, and the MCP tool lists and files them', async () => {
    ['s1', 's2'].forEach((s) => run(s, 'npm test', MODULE, 1));
    expect(buildProjectContext(db, project, 'fix tests').text).toContain('1 recurring pattern in auto-captured failures');

    const server = createServer({ db, mode: 'lite', project, hooks: true });
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(x), client.connect(y)]);
    const call = async (args: Record<string, unknown>) => {
      const r = (await client.callTool({ name: 'synapse_reflect', arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content[0].text, isError: Boolean(r.isError) };
    };
    const listed = await call({});
    const key = listed.text.match(/p-[0-9a-f]{8}/)![0];
    const memory = storeObservation(db, { projectId: project.id, entityName: 'build', type: 'gotcha', title: 'Build before testing', narrative: 'The config module is generated.' }).observation;
    expect((await call({ pattern: key, memoryId: memory.id })).text).toBe(`Filed ${key} under #${memory.id}: 2 records archived, pointing at it.`);
    expect((await call({})).text).toContain('No recurring patterns');
    expect((await call({ pattern: 'p-00000000', dismiss: true })).isError).toBe(true);
    expect(buildProjectContext(db, project, 'fix tests').text).not.toContain('recurring pattern');
  });
});

describe('capture fixes behind the patterns', () => {
  it('keys commands past setup assignments and subshell parentheses', () => {
    expect(commandKey('S=/tmp/x; R=$S/y; npm test 2>&1 | tail')).toBe('npm test');
    expect(commandKey('(npm run lint 2>&1 | tail -5; npm test)')).toBe('npm run lint');
    expect(commandKey('{ npm run build; }')).toBe('npm run build');
  });

  it('does not take printed source for a failed read-only command', () => {
    expect(commandCapture('sed -n 80,140p src/hooks.ts', 'const FAILURE = [\n  String.raw`command not found`,\n];', false)).toBe('skip');
    expect(commandCapture('jq . package.json', 'zsh: command not found: jq', false)).toBe('gotcha');
    expect(commandCapture('sed -n 1p missing.txt', 'sed: missing.txt: No such file or directory', false)).toBe('gotcha');
  });
});
