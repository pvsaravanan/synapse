import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { detectAgent, formatHookResult, normalizeHookPayload, parseApplyPatch } from '../src/agents.js';
import { openDatabase, type DB } from '../src/db.js';
import { handleHook } from '../src/hooks.js';
import { detectProject } from '../src/project.js';
import { recentSessions } from '../src/sessions.js';
import { codexMcpBlock, isSynapseHookCommand, setupClaude, setupCodex, setupCursor, type SetupOptions } from '../src/setup.js';
import { listObservations } from '../src/store.js';

let db: DB;
let dir: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  dir = mkdtempSync(path.join(os.tmpdir(), 'syn-agent-'));
});

const run = (agent: 'claude' | 'cursor' | 'codex', raw: Record<string, unknown>) => {
  let context: string | undefined;
  for (const input of normalizeHookPayload(agent, raw)) context = handleHook(db, input).context ?? context;
  return formatHookResult(agent, String(raw.hook_event_name), { context });
};

describe('agent detection', () => {
  it('recognises Cursor payloads and defaults to Claude/Codex format', () => {
    expect(detectAgent({ hook_event_name: 'sessionStart', conversation_id: 'c', workspace_roots: ['/x'] })).toBe('cursor');
    expect(detectAgent({ hook_event_name: 'SessionStart', session_id: 's' })).toBe('claude');
  });
});

describe('Cursor adapter', () => {
  const common = () => ({ conversation_id: 'conv-1', generation_id: 'g', cursor_version: '2.1', workspace_roots: [dir] });

  it('injects additional_context on sessionStart and records a session', () => {
    const out = JSON.parse(run('cursor', { ...common(), hook_event_name: 'sessionStart', session_id: 'conv-1', composer_mode: 'agent' })!);
    expect(out.additional_context).toContain('# Synapse brief');
    expect(recentSessions(db, detectProject(dir).id, 5, false)[0].agent).toBe('cursor');
  });

  it('continues prompts, captures edits and shell failures, closes on sessionEnd', () => {
    expect(JSON.parse(run('cursor', { ...common(), hook_event_name: 'beforeSubmitPrompt', prompt: 'Add pagination to the users endpoint' })!)).toEqual({ continue: true });
    for (const t of ['a', 'b']) {
      run('cursor', { ...common(), hook_event_name: 'afterFileEdit', file_path: path.join(dir, 'src/users/list.ts'), edits: [{ old_string: 'x', new_string: `page ${t}` }] });
    }
    run('cursor', { ...common(), hook_event_name: 'afterShellExecution', command: 'npm test', output: 'Error: 2 tests failed', duration: 1200 });
    run('cursor', { ...common(), hook_event_name: 'afterShellExecution', command: 'ls -la', output: 'x' });
    expect(run('cursor', { ...common(), hook_event_name: 'sessionEnd', session_id: 'conv-1', reason: 'user_close' })).toBeUndefined();

    const pid = detectProject(dir).id;
    const obs = listObservations(db, { projectId: pid });
    expect(obs.map((o) => o.type).sort()).toEqual(['gotcha', 'session-request', 'what-changed']);
    const edit = obs.find((o) => o.type === 'what-changed')!;
    expect(edit.filesModified).toEqual(['src/users/list.ts']);
    expect(edit.revisionCount).toBe(2);
    expect(edit.narrative).toContain('page b');
    const session = recentSessions(db, pid, 1)[0];
    expect(session.status).toBe('completed');
    expect(session.summary).toMatch(/Goal: Add pagination.*src\/users\/list\.ts/);
  });

  it('ignores unsupported events', () => {
    expect(normalizeHookPayload('cursor', { ...common(), hook_event_name: 'beforeReadFile', file_path: 'x' })).toEqual([]);
  });
});

describe('Codex adapter', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/server.ts',
    '@@ function start()',
    '-  listen(3000)',
    '+  listen(Number(process.env.PORT ?? 3000))',
    '*** Add File: src/health.ts',
    '+export const health = () => "ok";',
    '*** Delete File: src/old.ts',
    '*** Update File: src/a.ts',
    '*** Move to: src/b.ts',
    '+moved',
    '*** End Patch',
  ].join('\n');

  it('parses apply_patch envelopes', () => {
    expect(parseApplyPatch(patch)).toEqual([
      { path: 'src/server.ts', op: 'update', added: '  listen(Number(process.env.PORT ?? 3000))\n' },
      { path: 'src/health.ts', op: 'add', added: 'export const health = () => "ok";\n' },
      { path: 'src/old.ts', op: 'delete', added: '' },
      { path: 'src/b.ts', op: 'update', added: 'moved\n' },
    ]);
  });

  it('turns one apply_patch into per-file edit captures (any input shape)', () => {
    for (const tool_input of [{ input: patch }, { command: ['apply_patch', patch] }, patch]) {
      const inputs = normalizeHookPayload('codex', { hook_event_name: 'PostToolUse', session_id: 's', cwd: dir, tool_name: 'apply_patch', tool_input, tool_response: 'Success' });
      expect(inputs.map((i) => [i.tool_name, (i.tool_input as { file_path: string }).file_path])).toEqual([
        ['Edit', 'src/server.ts'], ['Write', 'src/health.ts'], ['Edit', 'src/b.ts'],
      ]);
    }
  });

  it('uses Claude-style output and captures Bash + patches end to end', () => {
    const out = JSON.parse(run('codex', { hook_event_name: 'SessionStart', session_id: 'cx-1', cwd: dir, source: 'startup', model: 'gpt' })!);
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'SessionStart' });
    expect(out.hookSpecificOutput.additionalContext).toContain('# Synapse brief');
    run('codex', { hook_event_name: 'PostToolUse', session_id: 'cx-1', cwd: dir, turn_id: 't', tool_name: 'apply_patch', tool_input: { input: patch } });
    run('codex', { hook_event_name: 'PostToolUse', session_id: 'cx-1', cwd: dir, turn_id: 't', tool_name: 'Bash', tool_input: { command: 'cd app && cargo test' }, tool_response: { output: 'test result: FAILED. 1 failed', exit_code: 101 } });
    run('codex', { hook_event_name: 'PostToolUse', session_id: 'cx-1', cwd: dir, tool_name: 'mcp__synapse__synapse_search', tool_input: {} });
    run('codex', { hook_event_name: 'SessionEnd', session_id: 'cx-1', cwd: dir, reason: 'other' });
    const pid = detectProject(dir).id;
    const files = listObservations(db, { projectId: pid }).flatMap((o) => o.filesModified).sort();
    expect(files).toEqual(['src/b.ts', 'src/health.ts', 'src/server.ts']);
    expect(listObservations(db, { projectId: pid, type: ['gotcha'] })).toHaveLength(1);
    expect(recentSessions(db, pid, 1)[0]).toMatchObject({ agent: 'codex', status: 'completed' });
  });
});

describe('setup', () => {
  const opts = (over: Partial<SetupOptions> = {}): SetupOptions => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'syn-home-'));
    return { global: false, dryRun: false, cwd: dir, home, node: '/opt/node22/bin/node', script: '/opt/synapse/dist/cli.js', useAgentCli: false, ...over };
  };
  const json = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

  it('recognises synapse hook commands', () => {
    expect(isSynapseHookCommand('"/n/node" "/s/dist/cli.js" hook --agent cursor')).toBe(true);
    expect(isSynapseHookCommand('synapse hook')).toBe(true);
    expect(isSynapseHookCommand('./my-hook.sh')).toBe(false);
  });

  it('cursor: merges hooks + mcp, keeps user hooks, is idempotent, backs up', () => {
    const o = opts();
    mkdirSync(path.join(dir, '.cursor'));
    writeFileSync(path.join(dir, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: './format.sh' }] } }));
    writeFileSync(path.join(dir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    setupCursor(o);
    setupCursor(o);
    const hooks = json(path.join(dir, '.cursor', 'hooks.json'));
    expect(hooks.version).toBe(1);
    expect(Object.keys(hooks.hooks).sort()).toEqual(['afterFileEdit', 'afterShellExecution', 'beforeSubmitPrompt', 'preCompact', 'sessionEnd', 'sessionStart']);
    expect(hooks.hooks.afterFileEdit.map((h: { command: string }) => h.command)).toEqual(['./format.sh', '"/opt/node22/bin/node" "/opt/synapse/dist/cli.js" hook --agent cursor']);
    const mcp = json(path.join(dir, '.cursor', 'mcp.json'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['other', 'synapse']);
    expect(mcp.mcpServers.synapse).toEqual({ command: '/opt/node22/bin/node', args: ['/opt/synapse/dist/cli.js', 'serve'], env: { SYNAPSE_PROJECT_ROOT: detectProject(dir).rootPath } });
    expect(existsSync(path.join(dir, '.cursor', 'hooks.json.synapse-backup'))).toBe(true);
  });

  it('cursor --global writes to ~/.cursor without a project root', () => {
    const o = opts({ global: true });
    setupCursor(o);
    expect(json(path.join(o.home, '.cursor', 'mcp.json')).mcpServers.synapse.env).toBeUndefined();
    expect(existsSync(path.join(o.home, '.cursor', 'hooks.json'))).toBe(true);
  });

  it('codex: nested hooks with a 3s SessionEnd, appends mcp table once without touching user TOML', () => {
    const o = opts({ global: true });
    mkdirSync(path.join(o.home, '.codex'));
    writeFileSync(path.join(o.home, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n');
    setupCodex(o);
    setupCodex(o);
    const hooks = json(path.join(o.home, '.codex', 'hooks.json')).hooks;
    expect(Object.keys(hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact', 'SessionEnd']);
    expect(hooks.SessionEnd[0].hooks[0]).toEqual({ type: 'command', command: '"/opt/node22/bin/node" "/opt/synapse/dist/cli.js" hook --agent codex', timeout: 3 });
    expect(hooks.PostToolUse).toHaveLength(1);
    const toml = readFileSync(path.join(o.home, '.codex', 'config.toml'), 'utf8');
    expect(toml.startsWith('model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n\n[mcp_servers.synapse]')).toBe(true);
    expect(toml.match(/\[mcp_servers\.synapse\]/g)).toHaveLength(1);
    expect(codexMcpBlock(o, '/p')).toContain('env = { SYNAPSE_PROJECT_ROOT = "/p" }');
  });

  it('claude: unchanged command keeps existing installs idempotent', () => {
    const o = opts();
    setupClaude(o);
    setupClaude(o);
    const s = json(path.join(detectProject(dir).rootPath, '.claude', 'settings.local.json'));
    expect(s.hooks.SessionStart).toHaveLength(1);
    expect(s.hooks.SessionStart[0].hooks[0].command).toBe('"/opt/node22/bin/node" "/opt/synapse/dist/cli.js" hook');
  });

  it('refuses to overwrite invalid JSON', () => {
    const o = opts();
    mkdirSync(path.join(dir, '.cursor'));
    writeFileSync(path.join(dir, '.cursor', 'hooks.json'), '{ broken');
    expect(() => setupCursor(o)).toThrow(/not valid JSON/);
    expect(readFileSync(path.join(dir, '.cursor', 'hooks.json'), 'utf8')).toBe('{ broken');
  });

  it('dry run writes nothing', () => {
    const o = opts({ dryRun: true });
    const r = setupCodex(o);
    expect(existsSync(path.join(dir, '.codex'))).toBe(false);
    expect(r.changes.join('\n')).toContain('would write');
  });
});

describe('CLI hook entry point', () => {
  it('routes --agent cursor through the real binary', () => {
    const cli = path.resolve('dist/cli.js');
    const env = { ...process.env, SYNAPSE_DB: path.join(dir, 't.db') };
    const out = execFileSync(process.execPath, [cli, 'hook', '--agent', 'cursor'], {
      input: JSON.stringify({ hook_event_name: 'sessionStart', conversation_id: 'c', workspace_roots: [dir] }), env, encoding: 'utf8',
    });
    expect(JSON.parse(out).additional_context).toContain('# Synapse brief');
    const auto = execFileSync(process.execPath, [cli, 'hook'], {
      input: JSON.stringify({ hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c', workspace_roots: [dir], prompt: 'hi' }), env, encoding: 'utf8',
    });
    expect(JSON.parse(auto)).toEqual({ continue: true });
  });
});

describe('command failure detection', () => {
  it('uses exit codes when reported and failure-shaped lines otherwise', async () => {
    const { commandFailed } = await import('../src/hooks.js');
    expect(commandFailed({ output: 'all good', exit_code: 1 })).toBe(true);
    expect(commandFailed({ output: 'Error: boom', exit_code: 0 })).toBe(false);
    expect(commandFailed('Error: Cannot find module x')).toBe(true);
    expect(commandFailed('error[E0308]: mismatched types')).toBe(true);
    expect(commandFailed('npm ERR! code ELIFECYCLE')).toBe(true);
    expect(commandFailed('Tests: 2 failed, 10 passed')).toBe(true);
    expect(commandFailed('zsh: command not found: foo')).toBe(true);
    expect(commandFailed({ stdout: '', stderr: 'Traceback (most recent call last):\n  File "x"' })).toBe(true);
    // grep/cat of source that merely mentions errors is not a failure
    expect(commandFailed('src/hooks.ts:50:const ERROR_TEXT = /error|failed/\nsrc/x.ts:  throw new Error("failed")')).toBe(false);
    expect(commandFailed('3 tests passed, 0 errors')).toBe(false);
  });
});
