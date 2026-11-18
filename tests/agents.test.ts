import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
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
    expect(mcp.mcpServers.synapse).toEqual({ command: '/opt/node22/bin/node', args: ['/opt/synapse/dist/cli.js', 'serve'], env: { SYNAPSE_PROJECT_ROOT: detectProject(dir).rootPath, SYNAPSE_HOOKS: '1' } });
    expect(existsSync(path.join(dir, '.cursor', 'hooks.json.synapse-backup'))).toBe(true);
  });

  it('cursor --global writes to ~/.cursor without a project root', () => {
    const o = opts({ global: true });
    setupCursor(o);
    expect(json(path.join(o.home, '.cursor', 'mcp.json')).mcpServers.synapse.env).toEqual({ SYNAPSE_HOOKS: '1' });
    expect(existsSync(path.join(o.home, '.cursor', 'hooks.json'))).toBe(true);
  });

  it('codex: nested hooks with a 3s SessionEnd, appends mcp table once without touching user TOML', () => {
    const o = opts({ global: true });
    mkdirSync(path.join(o.home, '.codex'));
    writeFileSync(path.join(o.home, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n');
    setupCodex(o);
    setupCodex(o);
    const hooks = json(path.join(o.home, '.codex', 'hooks.json')).hooks;
    expect(Object.keys(hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact', 'Stop', 'SessionEnd']);
    expect(hooks.SessionEnd[0].hooks[0]).toEqual({ type: 'command', command: '"/opt/node22/bin/node" "/opt/synapse/dist/cli.js" hook --agent codex', timeout: 3 });
    expect(hooks.PostToolUse).toHaveLength(1);
    const toml = readFileSync(path.join(o.home, '.codex', 'config.toml'), 'utf8');
    expect(toml.startsWith('model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n\n[mcp_servers.synapse]')).toBe(true);
    expect(toml.match(/\[mcp_servers\.synapse\]/g)).toHaveLength(1);
    expect(codexMcpBlock(o, '/p')).toContain('env = { SYNAPSE_PROJECT_ROOT = "/p", SYNAPSE_HOOKS = "1" }');
    expect(codexMcpBlock(o)).toContain('env = { SYNAPSE_HOOKS = "1" }');
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
    expect(commandFailed('main.c:3:5: error: unknown type name')).toBe(true);
    expect(commandFailed('src/a.ts(3,5): error TS2322: Type string is not assignable')).toBe(true);
    expect(commandFailed('src/a.ts:12: // handle error cases')).toBe(false);
    // Devin CLI: success means "the tool ran"; the exit code is in the output text
    expect(commandFailed({ success: true, output: 'Output from command in shell 1a2b:\nok\n\nExit code: 1', error: null })).toBe(true);
    expect(commandFailed({ success: true, output: 'Output from command in shell 1a2b:\nok\n\nExit code: 0', error: null })).toBe(false);
    expect(commandFailed('Tests: 2 failed, 10 passed')).toBe(true);
    expect(commandFailed('zsh: command not found: foo')).toBe(true);
    expect(commandFailed({ stdout: '', stderr: 'Traceback (most recent call last):\n  File "x"' })).toBe(true);
    // grep/cat of source that merely mentions errors is not a failure
    expect(commandFailed('src/hooks.ts:50:const ERROR_TEXT = /error|failed/\nsrc/x.ts:  throw new Error("failed")')).toBe(false);
    expect(commandFailed('3 tests passed, 0 errors')).toBe(false);
  });
});

describe('Devin CLI adapter', () => {
  const env = () => ({ DEVIN_PROJECT_DIR: dir }) as NodeJS.ProcessEnv;
  const runDevin = (raw: Record<string, unknown>) => {
    let context: string | undefined;
    for (const input of normalizeHookPayload('devin', raw, env())) context = handleHook(db, input).context ?? context;
    return formatHookResult('devin', String(raw.hook_event_name), { context });
  };

  it('identifies Devin from DEVIN_PROJECT_DIR, even for imported Claude hooks', async () => {
    const { resolveAgent } = await import('../src/agents.js');
    const raw = { hook_event_name: 'SessionStart', session_id: 's', source: 'startup' };
    expect(resolveAgent(undefined, raw, env())).toBe('devin');
    expect(resolveAgent('claude', raw, env())).toBe('devin'); // Claude hook command run by Devin
    expect(resolveAgent(undefined, raw, {})).toBe('claude');
    expect(resolveAgent('cursor', raw, env())).toBe('cursor');
  });

  it('labels sessions devin, detects the project from DEVIN_PROJECT_DIR, injects the brief', () => {
    const out = JSON.parse(runDevin({ hook_event_name: 'SessionStart', session_id: 'dv-1', source: 'startup' })!);
    expect(out.hookSpecificOutput.additionalContext).toContain('# Synapse brief');
    const s = recentSessions(db, detectProject(dir).id, 5, false)[0];
    expect(s).toMatchObject({ id: 'dv-1', agent: 'devin' });
  });

  it('captures edit/write/notebook_edit with varied field names, and apply_patch', () => {
    const post = (tool_name: string, tool_input: unknown) =>
      runDevin({ hook_event_name: 'PostToolUse', session_id: 'dv-1', prompt_id: 'p', tool_name, tool_input, tool_response: { success: true, output: 'ok', error: null } });
    post('edit', { file_path: path.join(dir, 'src/a.ts'), old_string: 'x', new_string: 'alpha' });
    post('write', { path: 'src/b.ts', content: 'beta' });
    post('edit', { filePath: 'src/c.ts', edits: [{ old_str: 'x', new_str: 'gamma' }] });
    post('notebook_edit', { notebook_path: 'nb/analysis.ipynb', new_source: 'print(1)' });
    post('apply_patch', { patch: '*** Begin Patch\n*** Add File: src/d.ts\n+delta\n*** End Patch' });
    post('edit', { old_string: 'no path' });
    post('read', { file_path: 'src/a.ts' });
    post('mcp_call_tool', { server: 'synapse', tool: 'synapse_search' });
    const obs = listObservations(db, { projectId: detectProject(dir).id });
    expect(obs.flatMap((o) => o.filesModified).sort()).toEqual(['nb/analysis.ipynb', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
    expect(obs.find((o) => o.filesModified[0] === 'src/c.ts')!.narrative).toContain('gamma');
    expect(obs.every((o) => o.type === 'what-changed')).toBe(true);
  });

  it('captures exec commands and reads {success, output, error}', () => {
    const exec = (command: string, tool_response: unknown) =>
      runDevin({ hook_event_name: 'PostToolUse', session_id: 'dv-1', tool_name: 'exec', tool_input: { command, shell_id: 'main' }, tool_response });
    exec('npm test', { success: false, output: '', error: 'exit 1' });
    exec('pnpm build', { success: true, output: 'built in 2s', error: null });
    exec('cd app && make', { success: true, output: '', error: 'main.c:3:5: error: unknown type name \'sizet\'' });
    exec('ls', { success: true, output: 'a b', error: null });
    const obs = listObservations(db, { projectId: detectProject(dir).id });
    expect(obs.map((o) => [o.type, o.title.replace(/: .*/, '')]).sort()).toEqual([
      ['discovery', 'Ran'], ['gotcha', 'Command failed'], ['gotcha', 'Command failed'],
    ]);
  });

  it('PostCompaction checkpoints a summary, falling back to Devin\'s own', () => {
    runDevin({ hook_event_name: 'SessionStart', session_id: 'dv-2', source: 'startup' });
    runDevin({ hook_event_name: 'PostCompaction', session_id: 'dv-2', summary: 'Refactored auth; token=abcdef123456 next: tests' });
    const s = recentSessions(db, detectProject(dir).id, 5, false).find((x) => x.id === 'dv-2')!;
    expect(s.summary).toBe('Refactored auth; token=[REDACTED] next: tests');
    runDevin({ hook_event_name: 'PostToolUse', session_id: 'dv-2', tool_name: 'write', tool_input: { file_path: 'src/auth.ts', content: 'x' } });
    runDevin({ hook_event_name: 'PostCompaction', session_id: 'dv-2', summary: null });
    expect(recentSessions(db, detectProject(dir).id, 5, false).find((x) => x.id === 'dv-2')!.summary).toContain('src/auth.ts');
    runDevin({ hook_event_name: 'SessionEnd', session_id: 'dv-2', reason: 'exit' });
    expect(recentSessions(db, detectProject(dir).id, 5, false).find((x) => x.id === 'dv-2')!.status).toBe('completed');
  });

  it('ignores Stop and unknown events', () => {
    expect(normalizeHookPayload('devin', { hook_event_name: 'Stop', session_id: 's' }, env())).toEqual([]);
  });

  it('routes an imported Claude hook command to Devin through the real CLI', () => {
    const cli = path.resolve('dist/cli.js');
    execFileSync(process.execPath, [cli, 'hook'], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'dv-cli', source: 'startup' }),
      env: { ...process.env, SYNAPSE_DB: path.join(dir, 't.db'), DEVIN_PROJECT_DIR: dir }, cwd: os.tmpdir(), encoding: 'utf8',
    });
    const db2 = openDatabase(path.join(dir, 't.db'));
    expect(recentSessions(db2, detectProject(dir).id, 5, false)[0]).toMatchObject({ id: 'dv-cli', agent: 'devin' });
  });
});

describe('setup devin', () => {
  const opts = (over: Partial<SetupOptions> = {}): SetupOptions => ({
    global: false, dryRun: false, cwd: dir, home: mkdtempSync(path.join(os.tmpdir(), 'syn-home-')),
    node: '/opt/node22/bin/node', script: '/opt/synapse/dist/cli.js', useAgentCli: false, ...over,
  });
  const json = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
  const root = () => detectProject(dir).rootPath;

  it('installs .devin/hooks.v1.json + mcp_config.local.json when no Claude hooks exist', async () => {
    const { setupDevin } = await import('../src/setup.js');
    const o = opts();
    setupDevin(o);
    setupDevin(o);
    const hooks = json(path.join(root(), '.devin', 'hooks.v1.json'));
    expect(Object.keys(hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostCompaction', 'SessionEnd']);
    expect(hooks.PostToolUse).toHaveLength(1);
    expect(hooks.PostToolUse[0].hooks[0].command).toBe('"/opt/node22/bin/node" "/opt/synapse/dist/cli.js" hook --agent devin');
    expect(json(path.join(root(), '.devin', 'mcp_config.local.json')).mcpServers.synapse).toEqual({
      command: '/opt/node22/bin/node', args: ['/opt/synapse/dist/cli.js', 'serve'], env: { SYNAPSE_PROJECT_ROOT: root(), SYNAPSE_HOOKS: '1' },
    });
  });

  it('skips hooks when Devin already imports Synapse Claude hooks (project or user level)', async () => {
    const { setupDevin } = await import('../src/setup.js');
    const project = opts();
    setupClaude(project);
    const r = setupDevin(project);
    expect(existsSync(path.join(root(), '.devin', 'hooks.v1.json'))).toBe(false);
    expect(r.changes[0]).toMatch(/hooks: not added — Devin CLI already imports/);
    expect(existsSync(path.join(root(), '.devin', 'mcp_config.local.json'))).toBe(true);

    const dir2 = mkdtempSync(path.join(os.tmpdir(), 'syn-agent2-'));
    const user = opts({ cwd: dir2 });
    setupClaude({ ...user, global: true });
    setupDevin(user);
    expect(existsSync(path.join(detectProject(dir2).rootPath, '.devin', 'hooks.v1.json'))).toBe(false);
  });

  it('global writes ~/.config/devin/config.json hooks + mcp_config.json and keeps other keys', async () => {
    const { setupDevin } = await import('../src/setup.js');
    const o = opts({ global: true });
    mkdirSync(path.join(o.home, '.config', 'devin'), { recursive: true });
    writeFileSync(path.join(o.home, '.config', 'devin', 'config.json'), JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: './notify.sh' }] }] } }));
    setupDevin(o);
    const cfg = json(path.join(o.home, '.config', 'devin', 'config.json'));
    expect(cfg.model).toBe('x');
    expect(Object.keys(cfg.hooks)).toEqual(['Stop', 'SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostCompaction', 'SessionEnd']);
    expect(json(path.join(o.home, '.config', 'devin', 'mcp_config.json')).mcpServers.synapse.env).toEqual({ SYNAPSE_HOOKS: '1' });
  });

  it('setup claude warns when Devin has its own Synapse hooks (double firing)', async () => {
    const { setupDevin } = await import('../src/setup.js');
    const o = opts();
    setupDevin(o);
    expect(setupClaude(o).notes.join('\n')).toMatch(/runs every event twice/);
  });
});

describe('Devin CLI real payloads (captured from devin 3000.12.57)', () => {
  it('captures write -> edit as one record and an exec failure with readable output', () => {
    const env = { DEVIN_PROJECT_DIR: dir } as NodeJS.ProcessEnv;
    const send = (raw: Record<string, unknown>) => normalizeHookPayload('devin', raw, env).forEach((i) => handleHook(db, i));
    const f = path.join(dir, 'src/greet.ts');
    send({ hook_event_name: 'SessionStart', session_id: 'real', source: 'startup' });
    send({ hook_event_name: 'UserPromptSubmit', prompt: 'Create src/greet.ts and add a JSDoc comment please', prompt_id: 'p1', session_id: 'real', source: 'user' });
    send({ hook_event_name: 'PostToolUse', prompt_id: 'p1', session_id: 'real', tool_use_id: 't1', tool_name: 'write', tool_input: { file_path: f, content: "export function greet(name: string): string {\n  return 'Hello, ' + name;\n}\n" }, tool_response: { success: true, output: `File created successfully at: ${f}`, error: null } });
    send({ hook_event_name: 'PostToolUse', prompt_id: 'p1', session_id: 'real', tool_use_id: 't2', tool_name: 'read', tool_input: { file_path: f }, tool_response: { success: true, output: '<file-view>', error: null } });
    send({ hook_event_name: 'PostToolUse', prompt_id: 'p1', session_id: 'real', tool_use_id: 't3', tool_name: 'edit', tool_input: { file_path: f, old_string: 'export function', new_string: '/** Returns a greeting for the given name. */\nexport function' }, tool_response: { success: true, output: 'updated', error: null } });
    send({ hook_event_name: 'PostToolUse', prompt_id: 'p1', session_id: 'real', tool_use_id: 't4', tool_name: 'exec', tool_input: { command: 'node -e "process.exit(1)"' }, tool_response: { success: true, output: 'Output from command in shell 76f4b3:\n\n\nExit code: 1', error: null } });
    send({ hook_event_name: 'PostToolUse', prompt_id: 'p1', session_id: 'real', tool_use_id: 't5', tool_name: 'mcp_list_tools', tool_input: { server_name: 'synapse' }, tool_response: { success: true, output: '[]', error: null } });
    send({ hook_event_name: 'SessionEnd', prompt_id: 'p1', reason: 'other', session_id: 'real' });

    const pid = detectProject(dir).id;
    const obs = listObservations(db, { projectId: pid });
    expect(obs.map((o) => o.type).sort()).toEqual(['gotcha', 'session-request', 'what-changed']);
    const edit = obs.find((o) => o.type === 'what-changed')!;
    expect(edit).toMatchObject({ filesModified: ['src/greet.ts'], revisionCount: 2 });
    const fail = obs.find((o) => o.type === 'gotcha')!;
    expect(fail.narrative).toContain('Exit code: 1');
    expect(fail.narrative).not.toContain('"success"');
    expect(recentSessions(db, pid, 1)[0]).toMatchObject({ id: 'real', agent: 'devin', status: 'completed' });
  });
});

describe('setup devin --allow-tools', () => {
  it('adds per-tool synapse rules (not the approval gate) to the USER config (never a project permissions block), opt-in, idempotent', async () => {
    const { setupDevin } = await import('../src/setup.js');
    const home = mkdtempSync(path.join(os.tmpdir(), 'syn-home-'));
    const base = { global: false, dryRun: false, cwd: dir, home, node: '/n', script: '/s/cli.js', useAgentCli: false };
    const userCfg = path.join(home, '.config', 'devin', 'config.json');
    const r = setupDevin(base);
    expect(existsSync(userCfg)).toBe(false);
    expect(r.notes.join('\n')).toContain('--allow-tools');
    mkdirSync(path.dirname(userCfg), { recursive: true });
    writeFileSync(userCfg, JSON.stringify({ theme_mode: 'dark', permissions: { allow: ['Exec(node)', 'Write(/private/tmp)'], deny: ['Exec(rm -rf)'] } }));
    setupDevin({ ...base, allowTools: true });
    setupDevin({ ...base, allowTools: true });
    const cfg = JSON.parse(readFileSync(userCfg, 'utf8'));
    expect(cfg.theme_mode).toBe('dark');
    expect(cfg.permissions.deny).toEqual(['Exec(rm -rf)']);
    const allow: string[] = cfg.permissions.allow;
    expect(allow.slice(0, 2)).toEqual(['Exec(node)', 'Write(/private/tmp)']);
    expect(allow).toContain('mcp__synapse__synapse_store');
    expect(allow).toContain('mcp__synapse__synapse_lt_propose');
    expect(allow).toContain('mcp__synapse__read_graph');
    // The approval gate keeps asking: never pre-approved, and no wildcard that would cover it.
    expect(allow).not.toContain('mcp__synapse__synapse_lt_approve');
    expect(allow).not.toContain('mcp__synapse__*');
    expect(new Set(allow).size).toBe(allow.length);
    const root = detectProject(dir).rootPath;
    expect(existsSync(path.join(root, '.devin', 'config.local.json'))).toBe(false);
    expect(existsSync(path.join(root, '.devin', 'config.json'))).toBe(false);
  });

  it('replaces the old wildcard rule and stale tool rules, keeping the user\'s own', async () => {
    const { setupDevin } = await import('../src/setup.js');
    const home = mkdtempSync(path.join(os.tmpdir(), 'syn-home-'));
    const userCfg = path.join(home, '.config', 'devin', 'config.json');
    mkdirSync(path.dirname(userCfg), { recursive: true });
    writeFileSync(userCfg, JSON.stringify({ permissions: { allow: ['Exec(git)', 'mcp__synapse__*', 'mcp__synapse__gone_tool', 'mcp__other__x'] } }));
    const r = setupDevin({ global: false, dryRun: false, cwd: dir, home, node: '/n', script: '/s/cli.js', useAgentCli: false, allowTools: true });
    const allow: string[] = JSON.parse(readFileSync(userCfg, 'utf8')).permissions.allow;
    expect(allow.slice(0, 2)).toEqual(['Exec(git)', 'mcp__other__x']);
    expect(allow).not.toContain('mcp__synapse__*');
    expect(allow).not.toContain('mcp__synapse__gone_tool');
    expect(allow).not.toContain('mcp__synapse__synapse_lt_approve');
    expect(r.notes.join('\n')).toContain('asks you again');
  });
});

describe('setup: agent instructions (CLAUDE.md / AGENTS.md)', () => {
  const opts = (over: Partial<SetupOptions> = {}): SetupOptions => ({
    global: false, dryRun: false, cwd: dir, home: mkdtempSync(path.join(os.tmpdir(), 'syn-home-')), node: '/n', script: '/s/cli.js', useAgentCli: false, ...over,
  });
  const root = () => detectProject(dir).rootPath;
  const read = (name: string) => (existsSync(path.join(root(), name)) ? readFileSync(path.join(root(), name), 'utf8') : '');
  const count = (text: string) => text.split('<!-- synapse:start -->').length - 1;

  it('adds the block to CLAUDE.md for Claude Code, keeps existing content, and is idempotent', async () => {
    const { runSetup, SYNAPSE_INSTRUCTIONS } = await import('../src/setup.js');
    writeFileSync(path.join(root(), 'CLAUDE.md'), '# My project\n\nUse pnpm.\n');
    runSetup('claude', opts());
    runSetup('claude', opts());
    const md = read('CLAUDE.md');
    expect(md.startsWith('# My project\n\nUse pnpm.\n\n<!-- synapse:start -->')).toBe(true);
    expect(md).toContain(SYNAPSE_INSTRUCTIONS);
    expect(count(md)).toBe(1);
    expect(read('AGENTS.md')).toBe('');
  });

  it('refreshes an outdated block in place', async () => {
    const { runSetup, SYNAPSE_INSTRUCTIONS } = await import('../src/setup.js');
    writeFileSync(path.join(root(), 'AGENTS.md'), 'before\n\n<!-- synapse:start -->\nold text\n<!-- synapse:end -->\n\nafter\n');
    runSetup('codex', opts());
    expect(read('AGENTS.md')).toBe(`before\n\n<!-- synapse:start -->\n${SYNAPSE_INSTRUCTIONS}\n<!-- synapse:end -->\n\nafter\n`);
  });

  it('writes AGENTS.md for Cursor, Codex and Devin', async () => {
    const { runSetup } = await import('../src/setup.js');
    runSetup('cursor', opts());
    expect(count(read('AGENTS.md'))).toBe(1);
  });

  it('keeps one copy when both Claude Code and Devin are set up, in either order', async () => {
    const { runSetup } = await import('../src/setup.js');
    runSetup('claude', opts());
    const r = runSetup('devin', opts());
    expect(read('AGENTS.md')).toBe('');
    expect(r.changes.join('\n')).toContain('Devin CLI also reads');
  });

  it('imports AGENTS.md from CLAUDE.md when AGENTS.md already has the block', async () => {
    const { runSetup } = await import('../src/setup.js');
    writeFileSync(path.join(root(), 'CLAUDE.md'), '# Notes\n');
    runSetup('devin', opts());
    runSetup('claude', opts());
    runSetup('claude', opts());
    expect(read('CLAUDE.md')).toBe('# Notes\n\n@AGENTS.md\n');
    expect(count(read('AGENTS.md'))).toBe(1);
  });

  it('writes nothing with --global, --no-instructions or --dry-run', async () => {
    const { runSetup } = await import('../src/setup.js');
    expect(runSetup('claude', opts({ global: true })).notes.join('\n')).toContain('synapse instructions');
    runSetup('codex', opts({ instructions: false }));
    const dry = runSetup('claude', opts({ dryRun: true }));
    expect(dry.changes.join('\n')).toContain('would write');
    expect(read('CLAUDE.md')).toBe('');
    expect(read('AGENTS.md')).toBe('');
  });
});

describe('setup git (post-commit hook)', () => {
  const repo = () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'syn-git-'));
    execFileSync('git', ['init', '-q'], { cwd: d });
    return d;
  };
  const opts = (cwd: string): SetupOptions => ({ global: false, dryRun: false, cwd, home: os.tmpdir(), node: '/n', script: '/s/cli.js', useAgentCli: false });
  const hookFile = (d: string) => path.join(d, '.git', 'hooks', 'post-commit');

  it('installs an executable hook once, appending to an existing shell hook', async () => {
    const { setupGit } = await import('../src/setup.js');
    const d = repo();
    mkdirSync(path.dirname(hookFile(d)), { recursive: true });
    writeFileSync(hookFile(d), '#!/bin/bash\necho committed\n');
    setupGit(opts(d));
    setupGit(opts(d));
    const text = readFileSync(hookFile(d), 'utf8');
    expect(text.startsWith('#!/bin/bash\necho committed\n\n# synapse:start')).toBe(true);
    expect(text.match(/# synapse:start/g)).toHaveLength(1);
    expect(text).toContain('("/n" "/s/cli.js" ingest-git --count 5 >/dev/null 2>&1 &)');
    expect(statSync(hookFile(d)).mode & 0o111).toBeTruthy();
  });

  it('creates a shell hook when none exists, and honors core.hooksPath', async () => {
    const { setupGit } = await import('../src/setup.js');
    const d = repo();
    setupGit(opts(d));
    expect(readFileSync(hookFile(d), 'utf8').startsWith('#!/bin/sh\n# synapse:start')).toBe(true);
    const e = repo();
    execFileSync('git', ['config', 'core.hooksPath', 'tools/hooks'], { cwd: e });
    setupGit(opts(e));
    expect(existsSync(path.join(e, 'tools', 'hooks', 'post-commit'))).toBe(true);
  });

  it('leaves non-shell hooks, husky and non-repositories alone', async () => {
    const { setupGit } = await import('../src/setup.js');
    const d = repo();
    mkdirSync(path.dirname(hookFile(d)), { recursive: true });
    writeFileSync(hookFile(d), '#!/usr/bin/env node\nconsole.log(1)\n');
    expect(setupGit(opts(d)).notes.join('\n')).toContain('not a shell script');
    expect(readFileSync(hookFile(d), 'utf8')).toBe('#!/usr/bin/env node\nconsole.log(1)\n');
    const h = repo();
    execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: h });
    expect(setupGit(opts(h)).notes.join('\n')).toContain('.husky/post-commit');
    expect(existsSync(path.join(h, '.husky', '_', 'post-commit'))).toBe(false);
    const plain = mkdtempSync(path.join(os.tmpdir(), 'syn-nogit-'));
    expect(setupGit(opts(plain)).notes.join('\n')).toContain('not a git repository');
  });
});
