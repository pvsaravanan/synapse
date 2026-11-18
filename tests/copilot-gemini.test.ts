/**
 * GitHub Copilot CLI and Gemini CLI hook adapters and setup. Payload shapes follow each agent's hook reference
 * (docs.github.com copilot-cli hooks reference; geminicli.com hooks reference); neither was run live.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatHookResult, normalizeHookPayload, type AgentId } from '../src/agents.js';
import { openDatabase, type DB } from '../src/db.js';
import { handleHook } from '../src/hooks.js';
import { detectProject } from '../src/project.js';
import { listCheckpoints, recentSessions } from '../src/sessions.js';
import { runSetup, type SetupOptions } from '../src/setup.js';
import { listObservations } from '../src/store.js';

let db: DB;
let dir: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  dir = mkdtempSync(path.join(os.tmpdir(), 'syn-cg-'));
});

const run = (agent: AgentId, raw: Record<string, unknown>) => {
  let context: string | undefined;
  for (const input of normalizeHookPayload(agent, raw)) context = handleHook(db, input).context ?? context;
  return formatHookResult(agent, String(raw.hook_event_name), { context });
};
const obs = () => listObservations(db, { projectId: detectProject(dir).id, limit: 50, status: 'all' });
const session = () => recentSessions(db, detectProject(dir).id, 1, false)[0];

describe('Copilot CLI adapter (camelCase payloads, event from --event)', () => {
  const base = () => ({ sessionId: 'cp-1', timestamp: 1763459000000, cwd: dir });

  it('injects additionalContext at sessionStart and labels the session copilot', () => {
    const out = JSON.parse(run('copilot', { ...base(), hook_event_name: 'sessionStart', source: 'new' })!);
    expect(out.additionalContext).toContain('# Synapse brief');
    expect(session()).toMatchObject({ id: 'cp-1', agent: 'copilot', status: 'active' });
  });

  it('records the goal, edits from edit/create with a JSON-string toolArgs, and failed commands', () => {
    run('copilot', { ...base(), hook_event_name: 'userPromptSubmitted', prompt: 'Add retry logic to the payment client' });
    expect(run('copilot', { ...base(), hook_event_name: 'userPromptSubmitted', prompt: 'x' })).toBeUndefined();
    run('copilot', { ...base(), hook_event_name: 'postToolUse', toolName: 'edit', toolArgs: JSON.stringify({ path: path.join(dir, 'src/pay.ts'), old_str: 'a', new_str: 'retry(3)' }), toolResult: { resultType: 'success', textResultForLlm: 'ok' } });
    run('copilot', { ...base(), hook_event_name: 'postToolUse', toolName: 'create', toolArgs: { path: 'src/retry.ts', file_text: 'export const retry = 3' }, toolResult: { resultType: 'success', textResultForLlm: 'ok' } });
    run('copilot', { ...base(), hook_event_name: 'postToolUse', toolName: 'bash', toolArgs: '{"command":"npm test"}', toolResult: { resultType: 'success', textResultForLlm: '2 tests failed\n<exited with exit code 1>' } });
    run('copilot', { ...base(), hook_event_name: 'postToolUseFailure', toolName: 'bash', toolArgs: '{"command":"npm run build"}', error: 'tsc not found' });
    run('copilot', { ...base(), hook_event_name: 'postToolUse', toolName: 'view', toolArgs: '{"path":"src/pay.ts"}', toolResult: { resultType: 'success', textResultForLlm: '' } });
    const titles = obs().map((o) => o.title).sort();
    expect(titles).toEqual([
      'Add retry logic to the payment client', 'Command failed: npm run build', 'Command failed: npm test', 'Edited src/pay.ts', 'Wrote src/retry.ts',
    ]);
    expect(obs().find((o) => o.title === 'Wrote src/retry.ts')!.narrative).toContain('export const retry = 3');
  });

  it('checkpoints on preCompact and closes on sessionEnd', () => {
    run('copilot', { ...base(), hook_event_name: 'userPromptSubmitted', prompt: 'Add retry logic to the payment client' });
    run('copilot', { ...base(), hook_event_name: 'preCompact', trigger: 'auto', transcriptPath: '/t' });
    expect(listCheckpoints(db, detectProject(dir).id)[0].summary).toContain('Goal: Add retry logic');
    run('copilot', { ...base(), hook_event_name: 'sessionEnd', reason: 'user_exit' });
    expect(session().status).toBe('completed');
  });

  it('also accepts the PascalCase (snake_case, Claude tool names) payloads', () => {
    const out = JSON.parse(run('copilot', { hook_event_name: 'SessionStart', session_id: 'cp-2', cwd: dir, source: 'startup' })!);
    expect(out.hookSpecificOutput.additionalContext).toContain('# Synapse brief');
    run('copilot', { hook_event_name: 'PostToolUse', session_id: 'cp-2', cwd: dir, tool_name: 'Edit', tool_input: { file_path: 'src/a.ts', new_string: 'x' } });
    expect(obs().map((o) => o.title)).toContain('Edited src/a.ts');
  });

  it('ignores events it has no use for', () => {
    expect(normalizeHookPayload('copilot', { ...base(), hook_event_name: 'agentStop' })).toEqual([]);
    expect(normalizeHookPayload('copilot', { ...base() })).toEqual([]);
  });
});

describe('Gemini CLI adapter', () => {
  const base = () => ({ session_id: 'gm-1', cwd: dir, transcript_path: '/t.json', timestamp: '2026-11-18T10:00:00Z' });

  it('injects the brief with hookSpecificOutput and labels the session gemini', () => {
    const out = JSON.parse(run('gemini', { ...base(), hook_event_name: 'SessionStart', source: 'startup' })!);
    expect(out.hookSpecificOutput.additionalContext).toContain('# Synapse brief');
    expect(session()).toMatchObject({ id: 'gm-1', agent: 'gemini' });
  });

  it('records the goal from BeforeAgent, edits from replace/write_file, and shell failures by exit code', () => {
    expect(run('gemini', { ...base(), hook_event_name: 'BeforeAgent', prompt: 'Make the importer skip empty rows' })).toBeUndefined();
    run('gemini', { ...base(), hook_event_name: 'AfterTool', tool_name: 'replace', tool_input: { file_path: path.join(dir, 'src/importer.ts'), old_string: 'a', new_string: 'if (!row) continue;' }, tool_response: { llmContent: 'ok', returnDisplay: 'ok' } });
    run('gemini', { ...base(), hook_event_name: 'AfterTool', tool_name: 'write_file', tool_input: { file_path: 'src/rows.ts', content: 'export {}' }, tool_response: { llmContent: 'ok' } });
    run('gemini', { ...base(), hook_event_name: 'AfterTool', tool_name: 'run_shell_command', tool_input: { command: 'npm test' }, tool_response: { llmContent: 'Command: npm test\nOutput: 1 failing\nExit Code: 1' } });
    run('gemini', { ...base(), hook_event_name: 'AfterTool', tool_name: 'run_shell_command', tool_input: { command: 'npm run build' }, tool_response: { llmContent: 'Command: npm run build\nOutput: done\nExit Code: 0' } });
    run('gemini', { ...base(), hook_event_name: 'AfterTool', tool_name: 'read_file', tool_input: { file_path: 'src/x.ts' }, tool_response: { llmContent: 'x' } });
    expect(obs().map((o) => o.title).sort()).toEqual([
      'Command failed: npm test', 'Edited src/importer.ts', 'Make the importer skip empty rows', 'Ran: npm run build', 'Wrote src/rows.ts',
    ]);
  });

  it('checkpoints on PreCompress and closes on SessionEnd', () => {
    run('gemini', { ...base(), hook_event_name: 'BeforeAgent', prompt: 'Make the importer skip empty rows' });
    run('gemini', { ...base(), hook_event_name: 'PreCompress', trigger: 'auto' });
    expect(listCheckpoints(db, detectProject(dir).id)).toHaveLength(1);
    run('gemini', { ...base(), hook_event_name: 'SessionEnd', reason: 'exit' });
    expect(session().status).toBe('completed');
  });
});

describe('CLI: --event for Copilot payloads', () => {
  it('routes a camelCase sessionStart through the real binary', () => {
    const out = execFileSync(process.execPath, [path.resolve('dist/cli.js'), 'hook', '--agent', 'copilot', '--event', 'sessionStart'], {
      input: JSON.stringify({ sessionId: 's', timestamp: 1, cwd: dir, source: 'new' }), env: { ...process.env, SYNAPSE_DB: path.join(dir, 't.db') }, encoding: 'utf8',
    });
    expect(JSON.parse(out).additionalContext).toContain('# Synapse brief');
  });
});

describe('setup copilot and gemini', () => {
  const opts = (over: Partial<SetupOptions> = {}): SetupOptions => ({
    global: false, dryRun: false, cwd: dir, home: mkdtempSync(path.join(os.tmpdir(), 'syn-home-')), node: '/opt/node', script: '/opt/synapse/cli.js', useAgentCli: false, ...over,
  });
  const json = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
  const root = () => detectProject(dir).rootPath;

  it('copilot: project hooks in .github/copilot/settings.local.json, MCP in the user config, idempotent', () => {
    const o = opts();
    const settings = path.join(root(), '.github', 'copilot', 'settings.local.json');
    writeFileSync(path.join(root(), 'keep.txt'), '');
    runSetup('copilot', o);
    const hooks = json(settings).hooks;
    expect(Object.keys(hooks)).toEqual(['sessionStart', 'userPromptSubmitted', 'postToolUse', 'postToolUseFailure', 'preCompact', 'sessionEnd']);
    expect(hooks.sessionStart[0]).toEqual({
      type: 'command', bash: '"/opt/node" "/opt/synapse/cli.js" hook --agent copilot --event sessionStart',
      powershell: '& "/opt/node" "/opt/synapse/cli.js" hook --agent copilot --event sessionStart', timeoutSec: 10,
    });
    expect(json(path.join(o.home, '.copilot', 'mcp-config.json')).mcpServers.synapse).toEqual({
      type: 'local', command: '/opt/node', args: ['/opt/synapse/cli.js', 'serve'], env: { SYNAPSE_HOOKS: '1' }, tools: ['*'],
    });
    runSetup('copilot', o);
    expect(json(settings).hooks.postToolUse).toHaveLength(1);
    expect(readFileSync(path.join(root(), 'AGENTS.md'), 'utf8')).toContain('<!-- synapse:start -->');
  });

  it('copilot --global writes ~/.copilot/hooks/synapse.json with version 1', () => {
    const o = opts({ global: true });
    runSetup('copilot', o);
    const file = json(path.join(o.home, '.copilot', 'hooks', 'synapse.json'));
    expect(file.version).toBe(1);
    expect(file.hooks.sessionEnd).toHaveLength(1);
    expect(existsSync(path.join(root(), '.github'))).toBe(false);
  });

  it('gemini: hooks (ms timeouts, AfterTool matcher) and MCP in .gemini/settings.json, keeping other settings', () => {
    const o = opts();
    const file = path.join(root(), '.gemini', 'settings.json');
    runSetup('gemini', { ...o, dryRun: true });
    expect(existsSync(file)).toBe(false);
    execFileSync('mkdir', ['-p', path.dirname(file)]);
    writeFileSync(file, JSON.stringify({ theme: 'dark', hooks: { AfterTool: [{ matcher: 'x', hooks: [{ type: 'command', command: './mine.sh' }] }] } }));
    runSetup('gemini', o);
    runSetup('gemini', o);
    const s = json(file);
    expect(s.theme).toBe('dark');
    expect(Object.keys(s.hooks)).toEqual(['AfterTool', 'SessionStart', 'BeforeAgent', 'PreCompress', 'SessionEnd']);
    expect(s.hooks.AfterTool).toHaveLength(2);
    expect(s.hooks.AfterTool[1]).toEqual({ matcher: 'write_file|replace|edit|smart_edit|run_shell_command', hooks: [{ type: 'command', command: '"/opt/node" "/opt/synapse/cli.js" hook --agent gemini', timeout: 10000 }] });
    expect(s.mcpServers.synapse.env).toEqual({ SYNAPSE_PROJECT_ROOT: root(), SYNAPSE_HOOKS: '1' });
  });

  it('gemini: GEMINI.md gets the block, or imports AGENTS.md when that already has it', () => {
    runSetup('gemini', opts());
    expect(readFileSync(path.join(root(), 'GEMINI.md'), 'utf8')).toContain('<!-- synapse:start -->');
    const other = mkdtempSync(path.join(os.tmpdir(), 'syn-cg2-'));
    runSetup('cursor', opts({ cwd: other }));
    runSetup('gemini', opts({ cwd: other }));
    runSetup('gemini', opts({ cwd: other }));
    expect(readFileSync(path.join(other, 'GEMINI.md'), 'utf8')).toBe('@./AGENTS.md\n');
  });
});
