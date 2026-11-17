/**
 * `synapse setup <agent>` — register the MCP server and lifecycle hooks with
 * Claude Code, Cursor, Codex or Devin CLI. Every write merges into existing config,
 * backs the file up first, and is idempotent. Commands use absolute paths to
 * the running Node binary and CLI so they work even when the shell's default
 * `node` is too old for node:sqlite.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Claude Code reads CLAUDE.md; Cursor, Codex and Devin CLI read AGENTS.md. */
export function instructionsFileName(agent: AgentId): string {
  return agent === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
}

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
  const importsAgents = (text: string) => /^@AGENTS\.md\s*$/m.test(text);
  if (agent === 'claude' && !current.includes(BLOCK_START) && agentsHasBlock) {
    // Devin reads both files, so keep one copy: CLAUDE.md imports AGENTS.md (Claude Code expands @imports).
    if (importsAgents(current)) report.changes.push('instructions: already present (CLAUDE.md imports AGENTS.md)');
    else writeFile(file, `${current.trimEnd() ? current.trimEnd() + '\n\n' : ''}@AGENTS.md\n`, o, report, 'instructions (import of AGENTS.md)');
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
  const envArgs = o.global ? [] : ['-e', `SYNAPSE_PROJECT_ROOT=${projectRoot(o)}`];
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
    mcp.mcpServers.synapse = { command: o.node, args: [o.script, 'serve'], ...(o.global ? {} : { env: { SYNAPSE_PROJECT_ROOT: projectRoot(o) } }) };
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

export function runSetup(agent: AgentId, o: SetupOptions): SetupReport {
  const run = { cursor: setupCursor, codex: setupCodex, devin: setupDevin, claude: setupClaude }[agent];
  const report = run(o);
  setupInstructions(agent, o, report);
  return report;
}
