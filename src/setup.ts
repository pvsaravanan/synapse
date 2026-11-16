/**
 * `synapse setup <agent>` — register the MCP server and lifecycle hooks with
 * Claude Code, Cursor or Codex. Every write merges into existing config,
 * backs the file up first, and is idempotent. Commands use absolute paths to
 * the running Node binary and CLI so they work even when the shell's default
 * `node` is too old for node:sqlite.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentId } from './agents.js';
import { detectProject } from './project.js';

export interface SetupOptions {
  global: boolean;
  dryRun: boolean;
  cwd: string;
  home: string;
  node: string;
  script: string;
  /** Run the agent's own CLI (claude mcp add). Disabled in tests. */
  useAgentCli?: boolean;
}

export interface SetupReport {
  agent: AgentId;
  changes: string[];
  notes: string[];
}

const q = (s: string) => `"${s}"`;

export function hookCommand(o: SetupOptions, agent?: AgentId): string {
  return `${q(o.node)} ${q(o.script)} hook${agent && agent !== 'claude' ? ` --agent ${agent}` : ''}`;
}

/** True for any command that runs `synapse hook` (linked binary or node + cli.js). */
export function isSynapseHookCommand(cmd: unknown): boolean {
  return typeof cmd === 'string' && /(\bsynapse|cli\.js"?)\s+hook(\s|$)/.test(cmd);
}

function readJson(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON; fix or move it, then re-run setup (nothing was changed).`);
  }
}

function writeFile(file: string, content: string, o: SetupOptions, report: SetupReport, what: string): void {
  if (existsSync(file) && readFileSync(file, 'utf8') === content) {
    report.changes.push(`${what}: already up to date (${file})`);
    return;
  }
  if (o.dryRun) {
    report.changes.push(`${what}: would write ${file}\n${content}`);
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const backedUp = existsSync(file);
  if (backedUp) copyFileSync(file, `${file}.synapse-backup`);
  writeFileSync(file, content);
  report.changes.push(`${what}: wrote ${file}${backedUp ? ' (backup: .synapse-backup)' : ''}`);
}

function projectRoot(o: SetupOptions): string {
  return detectProject(o.cwd).rootPath;
}

// ── Claude Code ──────────────────────────────────────────────────────────

const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact', 'SessionEnd'];

/** Claude/Codex nested format: { hooks: { Event: [{ matcher?, hooks: [{ type, command, timeout }] }] } } */
function mergeNestedHooks(settings: Record<string, any>, events: Record<string, number>, command: string): void {
  settings.hooks ??= {};
  for (const [event, timeout] of Object.entries(events)) {
    const groups: any[] = (settings.hooks[event] ??= []);
    const present = groups.some((g) => (g?.hooks ?? []).some((h: any) => isSynapseHookCommand(h?.command)));
    if (!present) groups.push({ hooks: [{ type: 'command', command, timeout }] });
  }
}

export function setupClaude(o: SetupOptions): SetupReport {
  const report: SetupReport = { agent: 'claude', changes: [], notes: [] };
  const file = o.global ? path.join(o.home, '.claude', 'settings.json') : path.join(projectRoot(o), '.claude', 'settings.local.json');
  const settings = readJson(file);
  mergeNestedHooks(settings, Object.fromEntries(CLAUDE_EVENTS.map((e) => [e, 10])), hookCommand(o, 'claude'));
  writeFile(file, JSON.stringify(settings, null, 2) + '\n', o, report, 'hooks');

  const mcpArgs = ['mcp', 'add', 'synapse', '-s', o.global ? 'user' : 'local', '--', o.node, o.script, 'serve'];
  const manual = `claude ${mcpArgs.map((a) => (a.includes(' ') ? q(a) : a)).join(' ')}`;
  if (o.dryRun || !o.useAgentCli) {
    report.changes.push(`mcp: ${o.dryRun ? 'would run' : 'run'}: ${manual}`);
  } else {
    try {
      execFileSync('claude', mcpArgs, { stdio: 'pipe', cwd: o.cwd });
      report.changes.push(`mcp: registered with "claude mcp add" (${o.global ? 'user' : 'local'} scope)`);
    } catch (e) {
      const msg = String((e as { stderr?: Buffer }).stderr ?? '');
      if (/already exists/i.test(msg)) report.changes.push('mcp: synapse already registered');
      else report.notes.push(`Could not run the claude CLI. Register the MCP server manually:\n  ${manual}`);
    }
  }
  report.notes.push('Restart Claude Code to load the tools and hooks.');
  return report;
}

// ── Cursor ───────────────────────────────────────────────────────────────

const CURSOR_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'afterFileEdit', 'afterShellExecution', 'preCompact', 'sessionEnd'];

export function setupCursor(o: SetupOptions): SetupReport {
  const report: SetupReport = { agent: 'cursor', changes: [], notes: [] };
  const base = o.global ? path.join(o.home, '.cursor') : path.join(projectRoot(o), '.cursor');

  // Hooks: { version: 1, hooks: { event: [{ command, timeout }] } }
  const hooksFile = path.join(base, 'hooks.json');
  const hooks = readJson(hooksFile);
  hooks.version ??= 1;
  hooks.hooks ??= {};
  const command = hookCommand(o, 'cursor');
  for (const event of CURSOR_EVENTS) {
    const list: any[] = (hooks.hooks[event] ??= []);
    if (!list.some((h) => isSynapseHookCommand(h?.command))) list.push({ command, timeout: 10 });
  }
  writeFile(hooksFile, JSON.stringify(hooks, null, 2) + '\n', o, report, 'hooks');

  // MCP: { mcpServers: { synapse: { command, args, env } } }
  const mcpFile = path.join(base, 'mcp.json');
  const mcp = readJson(mcpFile);
  mcp.mcpServers ??= {};
  mcp.mcpServers.synapse = {
    command: o.node,
    args: [o.script, 'serve'],
    ...(o.global ? {} : { env: { SYNAPSE_PROJECT_ROOT: projectRoot(o) } }),
  };
  writeFile(mcpFile, JSON.stringify(mcp, null, 2) + '\n', o, report, 'mcp');

  report.notes.push('Restart Cursor (or reload the window); check Settings → Hooks and Settings → MCP show synapse.');
  if (o.global) report.notes.push('Global MCP has no fixed project: the agent can call synapse_session_start with projectRoot, or use per-project setup.');
  else report.notes.push('Project files contain absolute paths for this machine; keep .cursor/ out of version control.');
  return report;
}

// ── Codex ────────────────────────────────────────────────────────────────

/** Codex hooks use Claude's nested format; SessionEnd handlers are capped at 3 seconds. */
const CODEX_EVENTS: Record<string, number> = { SessionStart: 10, UserPromptSubmit: 10, PostToolUse: 10, PreCompact: 10, SessionEnd: 3 };

const tomlString = (s: string) => JSON.stringify(s);

export function codexMcpBlock(o: SetupOptions, root?: string): string {
  return [
    '[mcp_servers.synapse]',
    `command = ${tomlString(o.node)}`,
    `args = [${tomlString(o.script)}, "serve"]`,
    ...(root ? [`env = { SYNAPSE_PROJECT_ROOT = ${tomlString(root)} }`] : []),
  ].join('\n');
}

export function setupCodex(o: SetupOptions): SetupReport {
  const report: SetupReport = { agent: 'codex', changes: [], notes: [] };
  const root = o.global ? undefined : projectRoot(o);
  const base = o.global ? path.join(o.home, '.codex') : path.join(root!, '.codex');

  const hooksFile = path.join(base, 'hooks.json');
  const hooks = readJson(hooksFile);
  mergeNestedHooks(hooks, CODEX_EVENTS, hookCommand(o, 'codex'));
  writeFile(hooksFile, JSON.stringify(hooks, null, 2) + '\n', o, report, 'hooks');

  // MCP lives in config.toml. Append our table only if absent; never rewrite the user's TOML.
  const configFile = path.join(base, 'config.toml');
  const existing = existsSync(configFile) ? readFileSync(configFile, 'utf8') : '';
  if (/^\s*\[mcp_servers\.synapse\]/m.test(existing)) {
    report.changes.push(`mcp: [mcp_servers.synapse] already present in ${configFile} (left unchanged)`);
  } else {
    const content = (existing ? existing.replace(/\s*$/, '\n\n') : '') + codexMcpBlock(o, root) + '\n';
    writeFile(configFile, content, o, report, 'mcp');
  }

  report.notes.push('Start Codex and approve the synapse hooks once in /hooks (Codex reviews non-managed hooks before running them).');
  if (!o.global) report.notes.push('Codex loads a project .codex/ folder only when the project is trusted. Keep .codex/ out of version control (absolute paths).');
  report.notes.push('Start a new Codex thread so the MCP server and hooks load.');
  return report;
}

export function runSetup(agent: AgentId, o: SetupOptions): SetupReport {
  if (agent === 'cursor') return setupCursor(o);
  if (agent === 'codex') return setupCodex(o);
  return setupClaude(o);
}
