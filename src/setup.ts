/**
 * `synapse setup <agent>` — register the MCP server and lifecycle hooks with
 * Claude Code, Cursor, Codex, Devin CLI, GitHub Copilot CLI, Gemini CLI or Antigravity. Every write merges into existing config,
 * backs the file up first, and is idempotent. Commands use absolute paths to
 * the running Node binary and CLI so they work even when the shell's default
 * `node` is too old for node:sqlite.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentId } from './agents.js';
import { detectProject } from './project.js';
import { GATED_TOOLS, toolNames } from './server.js';

export interface SetupOptions {
  global: boolean;
  dryRun: boolean;
  cwd: string;
  home: string;
  node: string;
  script: string;
  /** Run the agent's own CLI (claude mcp add). Disabled in tests. */
  useAgentCli?: boolean;
  /** Devin: pre-approve Synapse's MCP tools except the approval gate (permissions.allow). Opt-in. */
  allowTools?: boolean;
  /** Add Synapse's memory instructions to the project's CLAUDE.md / AGENTS.md (default true; project scope only). */
  instructions?: boolean;
}

export interface SetupReport {
  agent: AgentId | 'git';
  changes: string[];
  notes: string[];
}

const q = (s: string) => `"${s}"`;

/** Set on every MCP registration that comes with hooks, so the server leaves the brief and session to them. */
const HOOKS_ENV = { SYNAPSE_HOOKS: '1' };

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

// ── Agent instructions (CLAUDE.md / AGENTS.md) ───────────────────────────

const BLOCK_START = '<!-- synapse:start -->';
const BLOCK_END = '<!-- synapse:end -->';

/**
 * Hooks deliver context automatically, but storing what was learned is the agent's choice, and agents rarely
 * make it unprompted. These instructions tell them when to.
 */
export const SYNAPSE_INSTRUCTIONS = `## Memory (Synapse)

This project uses Synapse for memory shared across sessions and agents. A brief is injected at session start; current code and the user's request always win over memory.

- **Before non-trivial work:** call \`synapse_project_context\` with the task, and read its "Start here" files.
- **Before re-investigating** a bug, error or past decision: \`synapse_search\` first, then \`synapse_detail\` on relevant ids.
- **Store as you go**, without being asked, with \`synapse_store\`: non-obvious bug causes and fixes (\`problem-solution\`), traps and environment quirks (\`gotcha\`), design choices (\`decision\`; use \`synapse_store_reasoning\` for the why and the rejected alternatives), and how a subsystem works (\`how-it-works\`). Name the files involved in \`filesModified\`. Use \`topicKey\` for topics that evolve.
- **Don't store** what the code or git history already says, routine edits, or secrets.
- **A memory flagged "changed since: …"** names files edited after it was stored: check current code, then \`synapse_feedback\` with \`verified\` or \`outdated\`. Use \`synapse_resolve\` for memories that no longer hold.
- **Lasting facts, procedures and user preferences:** propose with \`synapse_lt_propose\`. The user approves them; don't approve on their behalf.
- **When a session's work is done:** \`synapse_session_end\` with a handoff summary (done, left, where to resume).`;

export function instructionsBlock(): string {
  return `${BLOCK_START}\n${SYNAPSE_INSTRUCTIONS}\n${BLOCK_END}`;
}

/** Insert or refresh Synapse's block in a Markdown file, leaving everything else as it is. */
export function mergeInstructions(existing: string): string {
  const block = instructionsBlock();
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  if (start !== -1 && end > start) return existing.slice(0, start) + block + existing.slice(end + BLOCK_END.length);
  const body = existing.trimEnd();
  return body ? `${body}\n\n${block}\n` : `${block}\n`;
}

/** Claude Code reads CLAUDE.md, Gemini CLI reads GEMINI.md; Cursor, Codex, Devin CLI, Copilot CLI and Antigravity read AGENTS.md. */
export function instructionsFileName(agent: AgentId): string {
  return agent === 'claude' ? 'CLAUDE.md' : agent === 'gemini' ? 'GEMINI.md' : 'AGENTS.md';
}

/** Import line for AGENTS.md in the agents whose instruction files expand imports. */
const AGENTS_IMPORT: Partial<Record<AgentId, string>> = { claude: '@AGENTS.md', gemini: '@./AGENTS.md' };

function setupInstructions(agent: AgentId, o: SetupOptions, report: SetupReport): void {
  if (o.instructions === false) return;
  const name = instructionsFileName(agent);
  if (o.global) {
    report.notes.push(`Agent instructions are added per project. Run "synapse setup ${agent}" in a project, or paste "synapse instructions" into your global ${name}.`);
    return;
  }
  const root = projectRoot(o);
  const file = path.join(root, name);
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  const current = read(file);
  const claudeMd = path.join(root, 'CLAUDE.md');
  const agentsHasBlock = read(path.join(root, 'AGENTS.md')).includes(BLOCK_START);
  const importsAgents = (text: string) => /^@(\.\/)?AGENTS\.md\s*$/m.test(text);
  const importLine = AGENTS_IMPORT[agent];
  if (importLine && !current.includes(BLOCK_START) && agentsHasBlock) {
    // Keep one copy: CLAUDE.md / GEMINI.md import AGENTS.md (both agents expand @imports; Devin reads CLAUDE.md and AGENTS.md).
    if (importsAgents(current)) report.changes.push(`instructions: already present (${name} imports AGENTS.md)`);
    else writeFile(file, `${current.trimEnd() ? current.trimEnd() + '\n\n' : ''}${importLine}\n`, o, report, 'instructions (import of AGENTS.md)');
    return;
  }
  if (agent === 'devin' && read(claudeMd).includes(BLOCK_START)) {
    // Devin CLI loads CLAUDE.md as an always-on rule too; a second copy in AGENTS.md would be read twice.
    report.changes.push(`instructions: already present (${claudeMd}, which Devin CLI also reads)`);
    return;
  }
  writeFile(file, mergeInstructions(current), o, report, 'instructions');
}

// ── Claude Code ──────────────────────────────────────────────────────────

const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PreCompact', 'Stop', 'SessionEnd'];

/** Claude/Codex/Gemini nested format: { hooks: { Event: [{ matcher?, hooks: [{ type, command, timeout }] }] } } */
function mergeNestedHooks(settings: Record<string, any>, events: Record<string, number>, command: string, matchers: Record<string, string> = {}): void {
  settings.hooks ??= {};
  for (const [event, timeout] of Object.entries(events)) {
    const groups: any[] = (settings.hooks[event] ??= []);
    const present = groups.some((g) => (g?.hooks ?? []).some((h: any) => isSynapseHookCommand(h?.command)));
    if (!present) groups.push({ ...(matchers[event] ? { matcher: matchers[event] } : {}), hooks: [{ type: 'command', command, timeout }] });
  }
}

export function setupClaude(o: SetupOptions): SetupReport {
  const report: SetupReport = { agent: 'claude', changes: [], notes: [] };
  const file = o.global ? path.join(o.home, '.claude', 'settings.json') : path.join(projectRoot(o), '.claude', 'settings.local.json');
  const settings = readJson(file);
  mergeNestedHooks(settings, Object.fromEntries(CLAUDE_EVENTS.map((e) => [e, 10])), hookCommand(o, 'claude'));
  writeFile(file, JSON.stringify(settings, null, 2) + '\n', o, report, 'hooks');

  const scope = o.global ? 'user' : 'local';
  const mcpArgs = ['mcp', 'add', 'synapse', '-s', scope, '-e', 'SYNAPSE_HOOKS=1', '--', o.node, o.script, 'serve'];
  const manual = `claude ${mcpArgs.map((a) => (a.includes(' ') ? q(a) : a)).join(' ')}`;
  if (o.dryRun || !o.useAgentCli) {
    report.changes.push(`mcp: ${o.dryRun ? 'would run' : 'run'}: ${manual}`);
  } else {
    try {
      // Replace any previous registration so paths and env stay current.
      try { execFileSync('claude', ['mcp', 'remove', 'synapse', '-s', scope], { stdio: 'pipe', cwd: o.cwd }); } catch { /* not registered */ }
      execFileSync('claude', mcpArgs, { stdio: 'pipe', cwd: o.cwd });
      report.changes.push(`mcp: registered with "claude mcp add" (${scope} scope)`);
    } catch {
      report.notes.push(`Could not run the claude CLI. Register the MCP server manually:\n  ${manual}`);
    }
  }
  const devinDupes = [...devinHookFiles(o, 'user'), ...(o.global ? [] : devinHookFiles(o, 'project'))].filter(([f, k]) => fileHasSynapseHooks(f, k)).map(([f]) => f);
  if (devinDupes.length) report.notes.push(`Devin CLI imports these Claude hooks and also has Synapse hooks in ${devinDupes.join(', ')}; remove those or Devin runs every event twice.`);
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
    env: { ...(o.global ? {} : { SYNAPSE_PROJECT_ROOT: projectRoot(o) }), ...HOOKS_ENV },
  };
  writeFile(mcpFile, JSON.stringify(mcp, null, 2) + '\n', o, report, 'mcp');

  report.notes.push('Restart Cursor (or reload the window); check Settings → Hooks and Settings → MCP show synapse.');
  if (o.global) report.notes.push('Global MCP has no fixed project: the agent can call synapse_session_start with projectRoot, or use per-project setup.');
  else report.notes.push('Project files contain absolute paths for this machine; keep .cursor/ out of version control.');
  return report;
}

// ── Codex ────────────────────────────────────────────────────────────────

/** Codex hooks use Claude's nested format; SessionEnd handlers are capped at 3 seconds. */
const CODEX_EVENTS: Record<string, number> = { SessionStart: 10, UserPromptSubmit: 10, PostToolUse: 10, PreCompact: 10, Stop: 10, SessionEnd: 3 };

const tomlString = (s: string) => JSON.stringify(s);

export function codexMcpBlock(o: SetupOptions, root?: string): string {
  return [
    '[mcp_servers.synapse]',
    `command = ${tomlString(o.node)}`,
    `args = [${tomlString(o.script)}, "serve"]`,
    `env = { ${root ? `SYNAPSE_PROJECT_ROOT = ${tomlString(root)}, ` : ''}SYNAPSE_HOOKS = "1" }`,
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
    if (!/SYNAPSE_HOOKS/.test(existing)) report.notes.push(`Add SYNAPSE_HOOKS = "1" to the env of [mcp_servers.synapse] in ${configFile}, so the server leaves the brief and session to the hooks.`);
  } else {
    const content = (existing ? existing.replace(/\s*$/, '\n\n') : '') + codexMcpBlock(o, root) + '\n';
    writeFile(configFile, content, o, report, 'mcp');
  }

  report.notes.push('Start Codex and approve the synapse hooks once in /hooks (Codex reviews non-managed hooks before running them).');
  if (!o.global) report.notes.push('Codex loads a project .codex/ folder only when the project is trusted. Keep .codex/ out of version control (absolute paths).');
  report.notes.push('Start a new Codex thread so the MCP server and hooks load.');
  return report;
}

// ── Devin CLI ────────────────────────────────────────────────────────────

const DEVIN_RULE_PREFIX = 'mcp__synapse__';
/** Older setups allowed every Synapse tool with one wildcard, which also pre-approved the approval gate. */
const DEVIN_LEGACY_WILDCARD = `${DEVIN_RULE_PREFIX}*`;

/** One allow rule per Synapse tool, leaving out the tools that must always ask the user. */
export function devinAllowRules(): string[] {
  return toolNames('full').filter((n) => !GATED_TOOLS.includes(n)).map((n) => DEVIN_RULE_PREFIX + n);
}

const DEVIN_EVENTS: Record<string, number> = { SessionStart: 10, UserPromptSubmit: 10, PostToolUse: 10, PostCompaction: 10, SessionEnd: 10 };

/** Does a hooks object (event -> matcher groups) contain a synapse hook? */
function hasSynapseHooks(hooks: unknown): boolean {
  if (!hooks || typeof hooks !== 'object') return false;
  return Object.values(hooks as Record<string, unknown>).some(
    (groups) => Array.isArray(groups) && groups.some((g: any) => (g?.hooks ?? []).some((h: any) => isSynapseHookCommand(h?.command))),
  );
}

function fileHasSynapseHooks(file: string, key: 'hooks' | null): boolean {
  try {
    const data = readJson(file);
    return hasSynapseHooks(key ? data[key] : data);
  } catch {
    return false;
  }
}

/** Claude Code hook files that Devin CLI imports (read_config_from.claude, on by default). */
function claudeFilesDevinImports(o: SetupOptions, scope: 'project' | 'user'): string[] {
  if (scope === 'user') return [path.join(o.home, '.claude.json'), path.join(o.home, '.claude', 'settings.json'), path.join(o.home, '.claude', 'settings.local.json')];
  const root = projectRoot(o);
  return [path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')];
}

/** Devin CLI's own hook files: project hooks.v1.json is the bare hooks object; config files use a "hooks" key. */
function devinHookFiles(o: SetupOptions, scope: 'project' | 'user'): [string, 'hooks' | null][] {
  if (scope === 'user') return [[path.join(o.home, '.config', 'devin', 'config.json'), 'hooks']];
  const d = path.join(projectRoot(o), '.devin');
  return [[path.join(d, 'hooks.v1.json'), null], [path.join(d, 'config.json'), 'hooks'], [path.join(d, 'config.local.json'), 'hooks']];
}

export function setupDevin(o: SetupOptions): SetupReport {
  const report: SetupReport = { agent: 'devin', changes: [], notes: [] };
  const scope = o.global ? 'user' : 'project';

  // Hooks — avoid double firing: Devin already runs Claude Code's synapse hooks (user-level ones in every project).
  const importedFrom = [...claudeFilesDevinImports(o, 'user'), ...(o.global ? [] : claudeFilesDevinImports(o, 'project'))]
    .filter((f) => fileHasSynapseHooks(f, 'hooks'));
  const ownFiles = [...devinHookFiles(o, 'user'), ...(o.global ? [] : devinHookFiles(o, 'project'))];
  const existingDevin = ownFiles.filter(([f, k]) => fileHasSynapseHooks(f, k)).map(([f]) => f);
  if (importedFrom.length) {
    report.changes.push(`hooks: not added — Devin CLI already imports Synapse's Claude Code hooks from ${importedFrom.join(', ')}`);
    if (existingDevin.length) report.notes.push(`Synapse hooks also exist in ${existingDevin.join(', ')}; remove them there, or every event runs twice.`);
  } else if (existingDevin.length) {
    report.changes.push(`hooks: already present (${existingDevin.join(', ')})`);
  } else if (o.global) {
    const file = path.join(o.home, '.config', 'devin', 'config.json');
    const config = readJson(file);
    mergeNestedHooks(config, DEVIN_EVENTS, hookCommand(o, 'devin'));
    writeFile(file, JSON.stringify(config, null, 2) + '\n', o, report, 'hooks');
  } else {
    const file = path.join(projectRoot(o), '.devin', 'hooks.v1.json');
    const wrapper = { hooks: readJson(file) };
    mergeNestedHooks(wrapper, DEVIN_EVENTS, hookCommand(o, 'devin'));
    writeFile(file, JSON.stringify(wrapper.hooks, null, 2) + '\n', o, report, 'hooks');
  }

  // MCP — local scope: .devin/mcp_config.local.json (not committed); user scope: ~/.config/devin/mcp_config.json.
  // Prefer `devin mcp add` (Devin owns its schema); fall back to writing the file.
  const scopeFlag = o.global ? 'user' : 'local';
  const envArgs = [...(o.global ? [] : ['-e', `SYNAPSE_PROJECT_ROOT=${projectRoot(o)}`]), '-e', 'SYNAPSE_HOOKS=1'];
  const mcpArgs = ['mcp', 'add', 'synapse', '-s', scopeFlag, ...envArgs, '--', o.node, o.script, 'serve'];
  let registered = false;
  if (!o.dryRun && o.useAgentCli) {
    try {
      // Replace any previous registration so paths stay current.
      try { execFileSync('devin', ['mcp', 'remove', 'synapse', '-s', scopeFlag], { stdio: 'pipe', cwd: projectRoot(o) }); } catch { /* not registered */ }
      execFileSync('devin', mcpArgs, { stdio: 'pipe', cwd: projectRoot(o) });
      report.changes.push(`mcp: registered with "devin mcp add" (${scopeFlag} scope)`);
      registered = true;
    } catch {
      /* devin CLI missing or rejected the call: write the file instead */
    }
  }
  if (!registered) {
    const mcpFile = o.global ? path.join(o.home, '.config', 'devin', 'mcp_config.json') : path.join(projectRoot(o), '.devin', 'mcp_config.local.json');
    const mcp = readJson(mcpFile);
    mcp.mcpServers ??= {};
    mcp.mcpServers.synapse = { command: o.node, args: [o.script, 'serve'], env: { ...(o.global ? {} : { SYNAPSE_PROJECT_ROOT: projectRoot(o) }), ...HOOKS_ENV } };
    writeFile(mcpFile, JSON.stringify(mcp, null, 2) + '\n', o, report, 'mcp');
  }

  // Optional: pre-approve only Synapse's own tools, so non-interactive (-p) runs can use memory.
  // Always the USER config: a project-level "permissions" block replaces (not extends) the user's rules,
  // which would silently drop the user's own allow list in that project. The rule only matches Synapse.
  const permFile = path.join(o.home, '.config', 'devin', 'config.json');
  if (o.allowTools) {
    const cfg = readJson(permFile);
    cfg.permissions ??= {};
    const rules = devinAllowRules();
    const current = new Set([...rules, ...GATED_TOOLS.map((n) => DEVIN_RULE_PREFIX + n)]);
    const existing: unknown[] = Array.isArray(cfg.permissions.allow) ? cfg.permissions.allow : [];
    // Keep the user's own rules; drop the old wildcard and rules for Synapse tools that no longer exist.
    const allow = existing.filter((r) => typeof r !== 'string' || !r.startsWith(DEVIN_RULE_PREFIX) || current.has(r));
    for (const r of rules) if (!allow.includes(r)) allow.push(r);
    cfg.permissions.allow = allow;
    writeFile(permFile, JSON.stringify(cfg, null, 2) + '\n', o, report, 'permissions');
    if (existing.includes(DEVIN_LEGACY_WILDCARD)) report.notes.push(`Replaced "${DEVIN_LEGACY_WILDCARD}" with one rule per tool, so approving long-term memory asks you again.`);
    const gatedAllowed = GATED_TOOLS.map((n) => DEVIN_RULE_PREFIX + n).filter((r) => allow.includes(r));
    if (gatedAllowed.length) report.notes.push(`${gatedAllowed.join(', ')} is pre-approved in ${permFile}; remove it if Devin should ask you before approving long-term memory.`);
  } else {
    report.notes.push(`Devin asks before each Synapse tool call; non-interactive "devin -p" runs reject them. Re-run with --allow-tools to pre-approve Synapse's tools in ${permFile} (all except synapse_lt_approve, which keeps asking).`);
  }

  report.notes.push('Start a new Devin CLI session; check the synapse server is listed in its MCP servers.');
  if (importedFrom.length) report.notes.push('Hooks rely on Devin importing Claude Code config (read_config_from.claude, on by default). If you turned that off, re-run after removing the Claude hooks, or enable it.');
  if (o.global) report.notes.push('Projects that also have project-level Synapse hooks (.claude/ or .devin/) would run them twice in Devin; keep one level.');
  return report;
}

// ── GitHub Copilot CLI ───────────────────────────────────────────────────

/** camelCase events: Copilot's native payloads. They carry no event name, so each command passes --event. */
const COPILOT_EVENTS = ['sessionStart', 'userPromptSubmitted', 'postToolUse', 'postToolUseFailure', 'preCompact', 'sessionEnd'];

export function copilotHookEntry(o: SetupOptions, event: string): Record<string, unknown> {
  const command = `${hookCommand(o, 'copilot')} --event ${event}`;
  return { type: 'command', bash: command, powershell: `& ${command}`, timeoutSec: 10 };
}

export function setupCopilot(o: SetupOptions): SetupReport {
  const report: SetupReport = { agent: 'copilot', changes: [], notes: [] };

  // Hooks: user ~/.copilot/hooks/synapse.json, or the project's uncommitted .github/copilot/settings.local.json ("hooks" field).
  const hooksFile = o.global ? path.join(o.home, '.copilot', 'hooks', 'synapse.json') : path.join(projectRoot(o), '.github', 'copilot', 'settings.local.json');
  const config = readJson(hooksFile);
  if (o.global) config.version ??= 1;
  config.hooks ??= {};
  for (const event of COPILOT_EVENTS) {
    const list: any[] = (config.hooks[event] ??= []);
    if (!list.some((h) => isSynapseHookCommand(h?.bash ?? h?.command))) list.push(copilotHookEntry(o, event));
  }
  writeFile(hooksFile, JSON.stringify(config, null, 2) + '\n', o, report, 'hooks');

  // MCP: user config. Project files (.mcp.json, .github/mcp.json) are meant to be committed, and Claude Code reads .mcp.json too.
  // Copilot passes only PATH to MCP servers, so the env lists everything the server needs.
  const mcpFile = path.join(o.home, '.copilot', 'mcp-config.json');
  const mcp = readJson(mcpFile);
  mcp.mcpServers ??= {};
  mcp.mcpServers.synapse = { type: 'local', command: o.node, args: [o.script, 'serve'], env: { ...HOOKS_ENV }, tools: ['*'] };
  writeFile(mcpFile, JSON.stringify(mcp, null, 2) + '\n', o, report, 'mcp');

  report.notes.push('Start a new Copilot CLI session in the project; /mcp should list synapse.');
  report.notes.push('The MCP server is registered for your user and binds to the directory Copilot starts in. Set SYNAPSE_DB in its env in ~/.copilot/mcp-config.json if you use a custom database path (Copilot passes servers only PATH).');
  if (!o.global) report.notes.push('Copilot loads project hooks only for trusted folders (approve the folder when asked, or add it to "trustedFolders" in ~/.copilot/config.json); untrusted, they are skipped silently. Keep .github/copilot/settings.local.json out of version control (absolute paths).');
  return report;
}

// ── Gemini CLI ───────────────────────────────────────────────────────────

/** Gemini CLI timeouts are in milliseconds. */
const GEMINI_EVENTS: Record<string, number> = { SessionStart: 10_000, BeforeAgent: 10_000, AfterTool: 10_000, PreCompress: 10_000, SessionEnd: 10_000 };
const GEMINI_MATCHERS = { AfterTool: 'write_file|replace|edit|smart_edit|run_shell_command' };

export function setupGemini(o: SetupOptions): SetupReport {
  const report: SetupReport = { agent: 'gemini', changes: [], notes: [] };
  const file = o.global ? path.join(o.home, '.gemini', 'settings.json') : path.join(projectRoot(o), '.gemini', 'settings.json');
  const settings = readJson(file);
  mergeNestedHooks(settings, GEMINI_EVENTS, hookCommand(o, 'gemini'), GEMINI_MATCHERS);
  settings.mcpServers ??= {};
  settings.mcpServers.synapse = { command: o.node, args: [o.script, 'serve'], env: { ...(o.global ? {} : { SYNAPSE_PROJECT_ROOT: projectRoot(o) }), ...HOOKS_ENV } };
  writeFile(file, JSON.stringify(settings, null, 2) + '\n', o, report, 'hooks and mcp');

  report.notes.push('Start a new Gemini CLI session; /mcp should list synapse and /hooks the Synapse hooks (hooks need Gemini CLI 0.26 or later).');
  report.notes.push('Google moved consumer accounts from Gemini CLI to Antigravity CLI, which uses a different hook format; this setup is for Gemini CLI (API key and enterprise users).');
  if (!o.global) report.notes.push('Keep .gemini/settings.json out of version control, or move the synapse entries to ~/.gemini/settings.json with --global (absolute paths).');
  return report;
}

// ── Antigravity ──────────────────────────────────────────────────────────

/** Antigravity's payloads carry no event name, so each command passes --event. It has no session-end or compaction event. */
const ANTIGRAVITY_LIFECYCLE = ['SessionStart', 'PreInvocation', 'Stop'];

export function antigravityHooks(o: SetupOptions): Record<string, unknown> {
  const handler = (event: string) => ({ type: 'command', command: `${hookCommand(o, 'antigravity')} --event ${event}`, timeout: 10 });
  return {
    ...Object.fromEntries(ANTIGRAVITY_LIFECYCLE.map((e) => [e, [handler(e)]])),
    // Every tool: the adapter keeps only file edits and run_command.
    PostToolUse: [{ matcher: '*', hooks: [handler('PostToolUse')] }],
  };
}

export function setupAntigravity(o: SetupOptions): SetupReport {
  const report: SetupReport = { agent: 'antigravity', changes: [], notes: [] };
  const base = o.global ? path.join(o.home, '.gemini', 'config') : path.join(projectRoot(o), '.agents');

  // hooks.json maps hook names to their events; Synapse owns the "synapse" entry.
  const hooksFile = path.join(base, 'hooks.json');
  const hooks = readJson(hooksFile);
  hooks.synapse = antigravityHooks(o);
  writeFile(hooksFile, JSON.stringify(hooks, null, 2) + '\n', o, report, 'hooks');

  const mcpFile = path.join(base, 'mcp_config.json');
  const mcp = readJson(mcpFile);
  mcp.mcpServers ??= {};
  mcp.mcpServers.synapse = { command: o.node, args: [o.script, 'serve'], env: { ...(o.global ? {} : { SYNAPSE_PROJECT_ROOT: projectRoot(o) }), ...HOOKS_ENV } };
  writeFile(mcpFile, JSON.stringify(mcp, null, 2) + '\n', o, report, 'mcp');

  report.notes.push('Restart Antigravity (or start a new Antigravity CLI session) so the hooks and MCP server load.');
  report.notes.push('Antigravity has no session-end or compaction event: a session is summarized each time the agent loop stops, and reopens on the next prompt. There are no compaction checkpoints.');
  if (!o.global) report.notes.push('Keep .agents/hooks.json and .agents/mcp_config.json out of version control (absolute paths).');
  return report;
}

// ── Git post-commit hook (any agent, and people) ─────────────────────────

const GIT_START = '# synapse:start';
const GIT_END = '# synapse:end';

/** The lines setup puts in post-commit: ingest recent commits in the background, never failing or slowing the commit. */
export function gitHookBlock(o: SetupOptions): string {
  return [
    GIT_START,
    '# Record new commits as Synapse memories (runs in the background; errors are ignored).',
    `(${q(o.node)} ${q(o.script)} ingest-git --count 5 >/dev/null 2>&1 &)`,
    GIT_END,
  ].join('\n');
}

/**
 * Install a post-commit hook that turns each commit into a memory, whoever made it: works for agents without
 * hooks, and for commits made outside any agent. Respects core.hooksPath; appends to an existing shell hook.
 */
export function setupGit(o: SetupOptions): SetupReport {
  const report: SetupReport = { agent: 'git', changes: [], notes: [] };
  const root = projectRoot(o);
  let hooksDir: string;
  try {
    hooksDir = path.resolve(root, execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    report.notes.push(`${root} is not a git repository; nothing to install.`);
    return report;
  }
  if (/[\\/]\.husky([\\/]|$)/.test(hooksDir)) {
    report.notes.push(`Git hooks are managed by husky (${hooksDir}). Add this to .husky/post-commit instead:\n${gitHookBlock(o)}`);
    return report;
  }
  const file = path.join(hooksDir, 'post-commit');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const shebang = current.split('\n', 1)[0];
  if (current && shebang.startsWith('#!') && !/\b(sh|bash|zsh|dash|ksh)\b/.test(shebang)) {
    report.notes.push(`${file} is not a shell script (${shebang}); left unchanged. Run "${o.node} ${o.script} ingest-git --count 5" from it to record commits.`);
    return report;
  }
  const block = gitHookBlock(o);
  const start = current.indexOf(GIT_START);
  const end = current.indexOf(GIT_END);
  const content = start !== -1 && end > start
    ? current.slice(0, start) + block + current.slice(end + GIT_END.length)
    : current.trim() ? `${current.trimEnd()}\n\n${block}\n` : `#!/bin/sh\n${block}\n`;
  writeFile(file, content, o, report, 'git hook');
  if (!o.dryRun) chmodSync(file, 0o755);
  report.notes.push('Each commit now becomes a memory (commit messages are the content: descriptive messages make better memories). Existing history: synapse ingest-git --count 50.');
  return report;
}

export function runSetup(agent: AgentId, o: SetupOptions): SetupReport {
  const run = { cursor: setupCursor, codex: setupCodex, devin: setupDevin, claude: setupClaude, copilot: setupCopilot, gemini: setupGemini, antigravity: setupAntigravity }[agent];
  const report = run(o);
  setupInstructions(agent, o, report);
  return report;
}
