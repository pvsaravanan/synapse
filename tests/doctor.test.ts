/**
 * `synapse doctor agents` (check and repair what setup installed) and `synapse uninstall`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { doctorAgents, removeSynapseHandlers, repairAgents, synapseHandlers, uninstall, type AgentHealth } from '../src/doctor.js';
import { runSetup, setupGit, type SetupOptions } from '../src/setup.js';

let dir: string;
let home: string;
let script: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'syn-doc-'));
  home = mkdtempSync(path.join(os.tmpdir(), 'syn-doc-home-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  // A real file stands in for dist/cli.js, so path checks pass.
  script = path.join(mkdtempSync(path.join(os.tmpdir(), 'syn-doc-bin-')), 'cli.js');
  writeFileSync(script, '');
});

const opts = (over: Partial<SetupOptions> = {}): SetupOptions => ({
  global: false, dryRun: false, cwd: dir, home, node: process.execPath, script, useAgentCli: false, ...over,
});
const json = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const put = (f: string, data: unknown) => {
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};
const statusOf = (health: AgentHealth[], agent: string) =>
  Object.fromEntries((health.find((h) => h.agent === agent)?.checks ?? []).map((c) => [c.what, c.status]));
const installed = (health: AgentHealth[]) => health.filter((h) => h.installed).map((h) => h.agent);

describe('event-map helpers', () => {
  it('find and remove Synapse handlers in nested and flat hook lists, keeping the user\'s', () => {
    const events: Record<string, any> = {
      PostToolUse: [{ matcher: 'x', hooks: [{ type: 'command', command: '"/n" "/s/cli.js" hook' }, { type: 'command', command: './mine.sh' }] }],
      sessionStart: [{ command: 'synapse hook --agent cursor' }, { command: './other.sh' }],
      sessionEnd: [{ bash: '"/n" "/s/cli.js" hook --agent copilot --event sessionEnd' }],
    };
    expect([...synapseHandlers(events).keys()]).toEqual(['PostToolUse', 'sessionStart', 'sessionEnd']);
    expect(removeSynapseHandlers(events)).toBe(3);
    expect(events).toEqual({
      PostToolUse: [{ matcher: 'x', hooks: [{ type: 'command', command: './mine.sh' }] }],
      sessionStart: [{ command: './other.sh' }],
    });
  });
});

describe('doctor agents', () => {
  it('reports a fresh setup as healthy, and lists agents that are not set up', () => {
    for (const a of ['cursor', 'codex', 'gemini', 'antigravity', 'copilot'] as const) runSetup(a, opts());
    setupGit(opts());
    const health = doctorAgents(opts());
    expect(installed(health)).toEqual(['cursor', 'codex', 'copilot', 'gemini', 'antigravity', 'git']);
    for (const h of health.filter((x) => x.installed)) {
      for (const c of h.checks) expect(c.status, `${h.agent} ${c.what}: ${c.detail}`).toBe('ok');
    }
    expect(health.find((h) => h.agent === 'claude')!.installed).toBe(false);
  });

  it('flags paths that no longer exist, missing events and a missing SYNAPSE_HOOKS, and --fix repairs them', () => {
    runSetup('codex', opts());
    runSetup('cursor', opts());
    // Codex hooks from an old install, without the newer Stop event.
    const codexHooks = path.join(dir, '.codex', 'hooks.json');
    const h = json(codexHooks);
    delete h.hooks.Stop;
    for (const groups of Object.values<any[]>(h.hooks)) for (const g of groups) for (const x of g.hooks) x.command = '"/gone/node" "/gone/cli.js" hook --agent codex';
    put(codexHooks, h);
    // Cursor MCP registered before SYNAPSE_HOOKS existed.
    const cursorMcp = path.join(dir, '.cursor', 'mcp.json');
    const m = json(cursorMcp);
    delete m.mcpServers.synapse.env.SYNAPSE_HOOKS;
    put(cursorMcp, m);

    const before = doctorAgents(opts());
    expect(statusOf(before, 'codex').hooks).toBe('fail');
    expect(before.find((x) => x.agent === 'codex')!.checks[0].detail).toContain('/gone/node, which no longer exists');
    expect(statusOf(before, 'cursor').mcp).toBe('fail');
    expect(before.find((x) => x.agent === 'cursor')!.checks.find((c) => c.what === 'mcp')!.detail).toContain('SYNAPSE_HOOKS=1 is missing');

    repairAgents(opts(), before);
    const after = doctorAgents(opts());
    expect(statusOf(after, 'codex')).toEqual({ hooks: 'ok', mcp: 'ok', instructions: 'ok' });
    expect(statusOf(after, 'cursor')).toEqual({ hooks: 'ok', mcp: 'ok', instructions: 'ok' });
    expect(Object.keys(json(codexHooks).hooks)).toContain('Stop');
    expect(json(codexHooks).hooks.SessionStart).toHaveLength(1); // refreshed in place, not duplicated
  });

  it('warns about a missing event alone, and an out-of-date instructions block', () => {
    runSetup('gemini', opts());
    const file = path.join(dir, '.gemini', 'settings.json');
    const s = json(file);
    delete s.hooks.PreCompress;
    put(file, s);
    put(path.join(dir, 'GEMINI.md'), '<!-- synapse:start -->\nold text\n<!-- synapse:end -->\n');
    expect(statusOf(doctorAgents(opts()), 'gemini')).toEqual({ hooks: 'warn', mcp: 'ok', instructions: 'warn' });
  });

  it('flags SYNAPSE_HOOKS=1 on an MCP entry with no hooks behind it', () => {
    put(path.join(dir, '.cursor', 'mcp.json'), { mcpServers: { synapse: { command: process.execPath, args: [script, 'serve'], env: { SYNAPSE_HOOKS: '1' } } } });
    const health = doctorAgents(opts());
    expect(health.find((h) => h.agent === 'cursor')!.checks.find((c) => c.what === 'mcp')!.detail).toContain('no hooks are installed');
  });

  it('accepts a hookless MCP entry (no SYNAPSE_HOOKS) as healthy', () => {
    put(path.join(dir, '.cursor', 'mcp.json'), { mcpServers: { synapse: { command: process.execPath, args: [script, 'serve'], env: {} } } });
    expect(statusOf(doctorAgents(opts()), 'cursor').mcp).toBe('ok');
  });

  it('asks the claude CLI about Claude Code\'s MCP entry, and does not count Devin set up through Claude\'s hooks alone', () => {
    runSetup('claude', opts());
    const get = (env: string) => () => `synapse:\n  Scope: Local config (private to you in this project)\n  Status: ✔ Connected\n  Type: stdio\n  Command: ${process.execPath}\n  Args: ${script} serve\n  Environment:\n${env}`;
    expect(statusOf(doctorAgents(opts({ agentCli: get('    SYNAPSE_HOOKS=1\n') })), 'claude')).toEqual({ hooks: 'ok', mcp: 'ok', instructions: 'ok' });
    const stale = doctorAgents(opts({ agentCli: get('') }));
    expect(statusOf(stale, 'claude').mcp).toBe('fail');
    expect(stale.find((h) => h.agent === 'devin')!.installed).toBe(false);
    expect(statusOf(doctorAgents(opts()), 'claude').mcp).toBe('skip'); // no CLI available
  });
});

describe('uninstall', () => {
  it('removes everything setup added, keeps the user\'s own config and content, and deletes files left empty', () => {
    put(path.join(dir, '.cursor', 'hooks.json'), { version: 1, hooks: { afterFileEdit: [{ command: './fmt.sh' }] } });
    put(path.join(dir, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n');
    put(path.join(dir, 'AGENTS.md'), '# Project\n\nBuild with make.\n');
    put(path.join(dir, '.git', 'hooks', 'post-commit'), '#!/bin/sh\necho committed\n');
    for (const a of ['cursor', 'codex', 'gemini', 'antigravity', 'copilot'] as const) runSetup(a, opts());
    setupGit(opts());

    const dry = uninstall(opts({ dryRun: true }));
    expect(dry.length).toBeGreaterThan(0);
    expect(installed(doctorAgents(opts()))).toContain('cursor'); // dry run changed nothing

    uninstall(opts());
    // Copilot's user-level MCP entry remains (project uninstall leaves it), and is now flagged for this project.
    const left = doctorAgents(opts());
    expect(installed(left)).toEqual(['copilot']);
    expect(left.find((h) => h.agent === 'copilot')!.checks.find((c) => c.what === 'mcp')!.detail).toContain('this project has no Copilot hooks');
    expect(json(path.join(dir, '.cursor', 'hooks.json')).hooks).toEqual({ afterFileEdit: [{ command: './fmt.sh' }] });
    expect(json(path.join(dir, '.cursor', 'mcp.json')).mcpServers).toEqual({});
    expect(readFileSync(path.join(dir, '.codex', 'config.toml'), 'utf8')).toBe('model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n');
    expect(json(path.join(dir, '.agents', 'hooks.json'))).toEqual({});
    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toBe('# Project\n\nBuild with make.\n');
    expect(readFileSync(path.join(dir, 'GEMINI.md'), 'utf8')).toBe('@./AGENTS.md\n'); // still imports the project's AGENTS.md
    expect(readFileSync(path.join(dir, '.git', 'hooks', 'post-commit'), 'utf8')).toBe('#!/bin/sh\necho committed\n');
    // Copilot's MCP entry is user-level: left for --global.
    expect(json(path.join(home, '.copilot', 'mcp-config.json')).mcpServers.synapse).toBeDefined();
    uninstall(opts({ global: true }), 'copilot');
    expect(json(path.join(home, '.copilot', 'mcp-config.json')).mcpServers.synapse).toBeUndefined();
  });

  it('with --agent, removes only that agent\'s hooks and MCP entry, leaving shared instructions', () => {
    runSetup('cursor', opts());
    runSetup('codex', opts());
    uninstall(opts(), 'cursor');
    expect(installed(doctorAgents(opts()))).toEqual(['codex']);
    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('<!-- synapse:start -->');
  });

  it('removes Claude Code\'s MCP entry through its CLI, and Copilot\'s own global hooks file', () => {
    const calls: string[] = [];
    runSetup('claude', opts());
    uninstall(opts({ agentCli: (args) => (calls.push(args.join(' ')), '') }), 'claude');
    expect(calls).toEqual(['mcp remove synapse -s local']);
    expect(json(path.join(dir, '.claude', 'settings.local.json')).hooks).toBeUndefined();
    runSetup('copilot', opts({ global: true }));
    uninstall(opts({ global: true }), 'copilot');
    expect(existsSync(path.join(home, '.copilot', 'hooks', 'synapse.json'))).toBe(false);
  });

  it('removes Devin\'s allow rules from the user config with --global', () => {
    runSetup('devin', opts({ global: true, allowTools: true }));
    const cfg = path.join(home, '.config', 'devin', 'config.json');
    const c = json(cfg);
    c.permissions.allow.push('Bash(npm test)');
    put(cfg, c);
    uninstall(opts({ global: true }), 'devin');
    expect(json(cfg).permissions.allow).toEqual(['Bash(npm test)']);
    expect(json(cfg).hooks).toBeUndefined();
  });
});

describe('doctor: Copilot\'s user-level MCP entry', () => {
  it('is fine where the project has Copilot hooks or user-level hooks exist, and flagged in other projects', () => {
    runSetup('copilot', opts());
    expect(statusOf(doctorAgents(opts()), 'copilot').mcp).toBe('ok');
    const other = mkdtempSync(path.join(os.tmpdir(), 'syn-doc-other-'));
    execFileSync('git', ['init', '-q'], { cwd: other });
    expect(statusOf(doctorAgents(opts({ cwd: other })), 'copilot').mcp).toBe('fail');
    runSetup('copilot', opts({ global: true }));
    expect(statusOf(doctorAgents(opts({ cwd: other })), 'copilot').mcp).toBe('ok');
  });
});

describe('uninstall: instruction files', () => {
  it('deletes files that held only Synapse\'s instructions, including an import of a deleted AGENTS.md', () => {
    runSetup('cursor', opts());
    runSetup('gemini', opts());
    put(path.join(dir, 'CLAUDE.md'), '# Notes\n\n@AGENTS.md\n');
    uninstall(opts());
    expect(existsSync(path.join(dir, 'AGENTS.md'))).toBe(false);
    expect(existsSync(path.join(dir, 'GEMINI.md'))).toBe(false);
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('# Notes\n');
  });
});
