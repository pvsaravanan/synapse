/**
 * `synapse doctor agents` checks what `synapse setup` installed for each agent (hooks, MCP entry, instructions, git
 * hook) and repairs it with --fix; `synapse uninstall` removes it. Both read the same locations setup writes.
 */
import { execFileSync } from 'node:child_process';
import { gitText } from './gitexec.js';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { AGENTS, type AgentId } from './agents.js';
import {
  AGENTS_IMPORT,
  BLOCK_END,
  BLOCK_START,
  DEVIN_RULE_PREFIX,
  GIT_END,
  GIT_START,
  claudeFilesDevinImports,
  devinHookFiles,
  expectedHookEvents,
  fileHasSynapseHooks,
  instructionsBlock,
  instructionsFileName,
  isSynapseHookCommand,
  projectRoot,
  readJson,
  runSetup,
  setupGit,
  writeFile,
  type SetupOptions,
  type SetupReport,
} from './setup.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  what: 'hooks' | 'mcp' | 'instructions' | 'git hook';
  status: CheckStatus;
  detail: string;
}

export interface AgentHealth {
  agent: AgentId | 'git';
  /** Anything of Synapse's was found for this agent in the checked scope. */
  installed: boolean;
  checks: Check[];
}

type Json = Record<string, any>;

/** Where an agent's hooks live: the file, and how to reach the event map inside it. */
interface HookSite {
  file: string;
  pick: (data: Json) => Json | undefined;
  /** Antigravity: Synapse owns a whole named entry, removed as one. */
  ownedKey?: string;
  /** Copilot --global: the whole file is Synapse's. */
  ownedFile?: boolean;
}

const hooksKey = (d: Json) => d.hooks;

function hookSites(agent: AgentId, o: SetupOptions): HookSite[] {
  const root = o.global ? undefined : projectRoot(o);
  const at = (...p: string[]) => (o.global ? path.join(o.home, ...p) : path.join(root!, ...p));
  switch (agent) {
    case 'claude':
      return o.global
        ? [{ file: path.join(o.home, '.claude', 'settings.json'), pick: hooksKey }]
        : [{ file: at('.claude', 'settings.local.json'), pick: hooksKey }, { file: at('.claude', 'settings.json'), pick: hooksKey }];
    case 'cursor':
      return [{ file: at('.cursor', 'hooks.json'), pick: hooksKey }];
    case 'codex':
      return [{ file: at('.codex', 'hooks.json'), pick: hooksKey }];
    case 'devin':
      return devinHookFiles(o, o.global ? 'user' : 'project').map(([file, key]) => ({ file, pick: key ? hooksKey : (d: Json) => d }));
    case 'copilot':
      return o.global
        ? [{ file: path.join(o.home, '.copilot', 'hooks', 'synapse.json'), pick: hooksKey, ownedFile: true }]
        : [{ file: at('.github', 'copilot', 'settings.local.json'), pick: hooksKey }];
    case 'gemini':
      return [{ file: at('.gemini', 'settings.json'), pick: hooksKey }];
    case 'antigravity':
      return [{ file: o.global ? path.join(o.home, '.gemini', 'config', 'hooks.json') : at('.agents', 'hooks.json'), pick: (d) => d.synapse, ownedKey: 'synapse' }];
  }
}

/** Where an agent's MCP entry lives (Claude Code and Codex are handled separately). */
function mcpFile(agent: AgentId, o: SetupOptions): string | undefined {
  const root = o.global ? undefined : projectRoot(o);
  switch (agent) {
    case 'cursor': return o.global ? path.join(o.home, '.cursor', 'mcp.json') : path.join(root!, '.cursor', 'mcp.json');
    case 'devin': return o.global ? path.join(o.home, '.config', 'devin', 'mcp_config.json') : path.join(root!, '.devin', 'mcp_config.local.json');
    case 'copilot': return path.join(o.home, '.copilot', 'mcp-config.json'); // user config in both scopes
    case 'gemini': return o.global ? path.join(o.home, '.gemini', 'settings.json') : path.join(root!, '.gemini', 'settings.json');
    case 'antigravity': return o.global ? path.join(o.home, '.gemini', 'config', 'mcp_config.json') : path.join(root!, '.agents', 'mcp_config.json');
    default: return undefined;
  }
}

const safeRead = (file: string): Json => {
  try {
    return readJson(file);
  } catch {
    return {};
  }
};

const handlerCommand = (h: any): string | undefined => (typeof h?.command === 'string' ? h.command : typeof h?.bash === 'string' ? h.bash : undefined);

/** Synapse hook commands per event in an event map (nested `{matcher, hooks: [...]}` or flat handler lists). */
export function synapseHandlers(events: Json | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!events || typeof events !== 'object') return out;
  for (const [event, list] of Object.entries(events)) {
    if (!Array.isArray(list)) continue;
    const cmds = list.flatMap((entry: any) => (Array.isArray(entry?.hooks) ? entry.hooks : [entry])).map(handlerCommand).filter(isSynapseHookCommand) as string[];
    if (cmds.length) out.set(event, cmds);
  }
  return out;
}

/** Remove Synapse's handlers from an event map in place; returns how many were removed. */
export function removeSynapseHandlers(events: Json | undefined): number {
  if (!events || typeof events !== 'object') return 0;
  let removed = 0;
  for (const [event, list] of Object.entries(events)) {
    if (!Array.isArray(list)) continue;
    const kept = list.flatMap((entry: any) => {
      if (Array.isArray(entry?.hooks)) {
        const before = entry.hooks.length;
        entry.hooks = entry.hooks.filter((h: any) => !isSynapseHookCommand(handlerCommand(h)));
        removed += before - entry.hooks.length;
        return entry.hooks.length ? [entry] : [];
      }
      if (isSynapseHookCommand(handlerCommand(entry))) {
        removed++;
        return [];
      }
      return [entry];
    });
    if (kept.length) events[event] = kept;
    else delete events[event];
  }
  return removed;
}

/** Problems with the Node binary and cli.js a command or MCP entry points to. */
function pathProblems(node: string | undefined, script: string | undefined, o: SetupOptions): { status: CheckStatus; detail: string } | undefined {
  for (const p of [node, script]) {
    if (p && path.isAbsolute(p) && !existsSync(p)) return { status: 'fail', detail: `points to ${p}, which no longer exists` };
  }
  if (script && path.isAbsolute(script) && path.resolve(script) !== path.resolve(o.script)) return { status: 'warn', detail: `uses another Synapse install (${script})` };
  return undefined;
}

const quoted = (cmd: string) => [...cmd.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

interface McpEntry {
  where: string;
  command?: string;
  script?: string;
  hooksFlag: boolean;
}

/** Claude Code keeps MCP entries in its own files; ask its CLI, as setup does. */
function claudeMcp(o: SetupOptions): McpEntry | undefined | 'unchecked' {
  const run = o.agentCli ?? (o.useAgentCli ? (args: string[], cwd: string) => execFileSync('claude', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }) : undefined);
  if (!run) return 'unchecked';
  let out: string;
  try {
    out = run(['mcp', 'get', 'synapse'], o.cwd);
  } catch {
    return undefined; // not registered (or the claude CLI is missing)
  }
  const scope = out.match(/Scope:\s*(.+)/)?.[1]?.trim() ?? '';
  if (o.global ? !/user/i.test(scope) : /user/i.test(scope)) return undefined; // registered at the other scope
  const args = out.match(/Args:\s*(.+)/)?.[1]?.trim().split(/\s+/) ?? [];
  return { where: `claude mcp (${scope || 'unknown scope'})`, command: out.match(/Command:\s*(.+)/)?.[1]?.trim(), script: args[0], hooksFlag: /SYNAPSE_HOOKS=(1|true|yes|on)\b/i.test(out) };
}

const CODEX_TABLE = /^\[mcp_servers\.synapse(?:\.[^\]]*)?\][^\n]*\n(?:(?!\[)[^\n]*\n?)*/gm;

function codexConfigFile(o: SetupOptions): string {
  return o.global ? path.join(o.home, '.codex', 'config.toml') : path.join(projectRoot(o), '.codex', 'config.toml');
}

function readMcp(agent: AgentId, o: SetupOptions): McpEntry | undefined | 'unchecked' {
  if (agent === 'claude') return claudeMcp(o);
  if (agent === 'codex') {
    const file = codexConfigFile(o);
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const block = text.match(CODEX_TABLE)?.join('\n');
    if (!block) return undefined;
    return {
      where: file,
      command: block.match(/^command\s*=\s*"([^"]*)"/m)?.[1],
      script: block.match(/^args\s*=\s*\[\s*"([^"]*)"/m)?.[1],
      hooksFlag: /SYNAPSE_HOOKS\s*=\s*"(1|true|yes|on)"/i.test(block),
    };
  }
  const file = mcpFile(agent, o)!;
  const entry = safeRead(file).mcpServers?.synapse;
  if (!entry) return undefined;
  return {
    where: file,
    command: entry.command,
    script: Array.isArray(entry.args) ? entry.args[0] : undefined,
    hooksFlag: /^(1|true|yes|on)$/i.test(String(entry.env?.SYNAPSE_HOOKS ?? '')),
  };
}

/** Synapse hooks for an agent in a scope: event -> commands, and whether Devin gets them through Claude Code's. */
function findHooks(agent: AgentId, o: SetupOptions): { events: Map<string, string[]>; files: string[]; viaClaude: string[] } {
  const events = new Map<string, string[]>();
  const files: string[] = [];
  for (const site of hookSites(agent, o)) {
    const found = synapseHandlers(site.pick(safeRead(site.file)));
    if (found.size) files.push(site.file);
    for (const [e, cmds] of found) events.set(e, [...(events.get(e) ?? []), ...cmds]);
  }
  const viaClaude = agent === 'devin'
    ? [...claudeFilesDevinImports(o, 'user'), ...(o.global ? [] : claudeFilesDevinImports(o, 'project'))].filter((f) => fileHasSynapseHooks(f, 'hooks'))
    : [];
  return { events, files, viaClaude };
}

function checkHooks(agent: AgentId, o: SetupOptions, found: ReturnType<typeof findHooks>): Check | undefined {
  if (found.viaClaude.length && found.events.size === 0) return { what: 'hooks', status: 'ok', detail: `through Claude Code's hooks (${found.viaClaude.join(', ')})` };
  if (found.events.size === 0) return undefined;
  const missing = expectedHookEvents(agent).filter((e) => !found.events.has(e));
  const problems = [...found.events.values()].flat().map((cmd) => {
    const [node, script] = quoted(cmd);
    return pathProblems(node, script, o);
  }).filter(Boolean) as { status: CheckStatus; detail: string }[];
  const fail = problems.find((p) => p.status === 'fail');
  if (fail) return { what: 'hooks', status: 'fail', detail: `a hook command ${fail.detail}` };
  if (missing.length) return { what: 'hooks', status: 'warn', detail: `missing ${missing.join(', ')} (added by newer Synapse versions)` };
  if (problems.length) return { what: 'hooks', status: 'warn', detail: `hook commands ${problems[0].detail}` };
  return { what: 'hooks', status: 'ok', detail: `${found.events.size} events in ${found.files.join(', ')}` };
}

function checkMcp(entry: McpEntry | undefined | 'unchecked', o: SetupOptions, hooksPresent: boolean, agent?: AgentId): Check | undefined {
  if (entry === 'unchecked') return { what: 'mcp', status: 'skip', detail: 'not checked (needs the claude CLI)' };
  if (!entry) return hooksPresent ? { what: 'mcp', status: 'fail', detail: 'hooks are installed but the MCP server is not registered, so the agent has no synapse_* tools' } : undefined;
  const p = pathProblems(entry.command, entry.script, o);
  if (p?.status === 'fail') return { what: 'mcp', status: 'fail', detail: `the server entry ${p.detail} (${entry.where})` };
  if (hooksPresent && !entry.hooksFlag) return { what: 'mcp', status: 'fail', detail: `SYNAPSE_HOOKS=1 is missing (${entry.where}): the server also delivers the brief and runs a second session` };
  if (!hooksPresent && entry.hooksFlag && agent === 'copilot' && !o.global) {
    return { what: 'mcp', status: 'fail', detail: `Copilot's MCP entry is user-level and has SYNAPSE_HOOKS=1, but this project has no Copilot hooks, so nothing delivers the brief here: run "synapse setup copilot" in this project, or "synapse setup copilot --global"` };
  }
  if (!hooksPresent && entry.hooksFlag) return { what: 'mcp', status: 'fail', detail: `SYNAPSE_HOOKS=1 is set but no hooks are installed (${entry.where}): nothing delivers the brief or runs the session` };
  if (p) return { what: 'mcp', status: 'warn', detail: `the server entry ${p.detail}` };
  return { what: 'mcp', status: 'ok', detail: entry.where };
}

function checkInstructions(agent: AgentId, o: SetupOptions): Check {
  const root = projectRoot(o);
  const read = (name: string) => (existsSync(path.join(root, name)) ? readFileSync(path.join(root, name), 'utf8') : '');
  const name = instructionsFileName(agent);
  const block = (text: string) => {
    const s = text.indexOf(BLOCK_START);
    const e = text.indexOf(BLOCK_END);
    return s !== -1 && e > s ? text.slice(s, e + BLOCK_END.length) : undefined;
  };
  const current = instructionsBlock();
  const candidates = [name];
  if (AGENTS_IMPORT[agent] && /^@(\.\/)?AGENTS\.md\s*$/m.test(read(name))) candidates.push('AGENTS.md');
  if (agent === 'devin') candidates.push('CLAUDE.md');
  for (const file of candidates) {
    const b = block(read(file));
    if (!b) continue;
    return b === current
      ? { what: 'instructions', status: 'ok', detail: file === name ? name : `${file} (via ${name === file ? file : name})` }
      : { what: 'instructions', status: 'warn', detail: `the block in ${file} is out of date` };
  }
  return { what: 'instructions', status: 'warn', detail: `no Synapse block in ${name}: agents rarely store memories unprompted without it` };
}

function gitHookFile(o: SetupOptions): string | undefined {
  const root = projectRoot(o);
  try {
    return path.join(path.resolve(root, gitText(root, ['rev-parse', '--git-path', 'hooks']).trim()), 'post-commit');
  } catch {
    return undefined;
  }
}

function checkGit(o: SetupOptions): AgentHealth {
  const file = gitHookFile(o);
  const text = file && existsSync(file) ? readFileSync(file, 'utf8') : '';
  const s = text.indexOf(GIT_START);
  const e = text.indexOf(GIT_END);
  if (s === -1 || e < s) return { agent: 'git', installed: false, checks: [] };
  const [node, script] = quoted(text.slice(s, e));
  const p = pathProblems(node, script, o);
  return { agent: 'git', installed: true, checks: [p ? { what: 'git hook', ...p, detail: `the post-commit hook ${p.detail}` } : { what: 'git hook', status: 'ok', detail: file! }] };
}

export function checkAgent(agent: AgentId, o: SetupOptions): AgentHealth {
  const found = findHooks(agent, o);
  const hooksPresent = found.events.size > 0 || found.viaClaude.length > 0;
  const entry = readMcp(agent, o);
  // Copilot's MCP entry is user-level in both scopes, so user-level hooks count for it too.
  const userHooks = agent === 'copilot' && !o.global && findHooks(agent, { ...o, global: true }).events.size > 0;
  const mcp = checkMcp(entry, o, hooksPresent || userHooks, agent);
  // Devin imports Claude Code's hooks, so those alone don't mean Devin is set up: it needs its own hooks or MCP entry.
  const ownFootprint = found.events.size > 0 || (entry !== undefined && entry !== 'unchecked');
  if (!ownFootprint) return { agent, installed: false, checks: [] };
  const checks = [checkHooks(agent, o, found), mcp].filter(Boolean) as Check[];
  if (!o.global) checks.push(checkInstructions(agent, o));
  return { agent, installed: true, checks };
}

export function doctorAgents(o: SetupOptions, only?: AgentId | 'git'): AgentHealth[] {
  const agents = only ? (only === 'git' ? [] : [only]) : [...AGENTS];
  const out = agents.map((a) => checkAgent(a, o));
  if (!o.global && (!only || only === 'git')) out.push(checkGit(o));
  return out;
}

/** Re-run setup for every installed agent with a problem (setup refreshes paths, events and the env flag). */
export function repairAgents(o: SetupOptions, health: AgentHealth[]): SetupReport[] {
  return health
    .filter((h) => h.installed && h.checks.some((c) => c.status === 'fail' || c.status === 'warn'))
    .map((h) => (h.agent === 'git' ? setupGit(o) : runSetup(h.agent, o)));
}

// ── Uninstall ────────────────────────────────────────────────────────────

function writeJson(file: string, data: Json, o: SetupOptions, report: SetupReport, what: string): void {
  writeFile(file, JSON.stringify(data, null, 2) + '\n', o, report, what);
}

function uninstallHooks(agent: AgentId, o: SetupOptions, report: SetupReport): void {
  for (const site of hookSites(agent, o)) {
    if (!existsSync(site.file)) continue;
    const data = safeRead(site.file);
    if (site.ownedKey) {
      if (!(site.ownedKey in data)) continue;
      delete data[site.ownedKey];
      writeJson(site.file, data, o, report, 'hooks removed');
      continue;
    }
    const events = site.pick(data);
    if (!removeSynapseHandlers(events)) continue;
    if (site.ownedFile && events && Object.keys(events).length === 0) {
      if (o.dryRun) report.changes.push(`hooks removed: would delete ${site.file}`);
      else {
        rmSync(site.file);
        report.changes.push(`hooks removed: deleted ${site.file}`);
      }
      continue;
    }
    if (events && Object.keys(events).length === 0 && data.hooks === events) delete data.hooks;
    writeJson(site.file, data, o, report, 'hooks removed');
  }
}

function uninstallMcp(agent: AgentId, o: SetupOptions, report: SetupReport): void {
  if (agent === 'claude' || agent === 'devin') {
    const cli = agent;
    const scope = o.global ? 'user' : 'local';
    const manual = `${cli} mcp remove synapse -s ${scope}`;
    const run = o.agentCli ?? (o.useAgentCli ? (args: string[], cwd: string) => execFileSync(cli, args, { cwd, encoding: 'utf8', stdio: 'pipe' }) : undefined);
    if (o.dryRun) report.changes.push(`mcp: would run: ${manual}`);
    else if (run) {
      try {
        run(['mcp', 'remove', 'synapse', '-s', scope], projectRoot(o));
        report.changes.push(`mcp: removed with "${manual}"`);
      } catch {
        if (agent === 'claude') report.changes.push(`mcp: no ${scope}-scope registration found ("${manual}")`);
      }
    } else if (agent === 'claude') report.notes.push(`Remove the MCP server with: ${manual}`);
    if (agent === 'claude') return;
  }
  if (agent === 'codex') {
    const file = codexConfigFile(o);
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (!CODEX_TABLE.test(text)) return;
    CODEX_TABLE.lastIndex = 0;
    const rest = text.replace(CODEX_TABLE, '').replace(/\n{3,}/g, '\n\n').trim();
    writeFile(file, rest ? `${rest}\n` : '', o, report, 'mcp removed');
    return;
  }
  if (agent === 'copilot' && !o.global) {
    if (safeRead(mcpFile(agent, o)!).mcpServers?.synapse) report.notes.push('Copilot CLI\'s MCP entry is in your user config (~/.copilot/mcp-config.json); remove it with "synapse uninstall --agent copilot --global".');
    return;
  }
  const file = mcpFile(agent, o)!;
  const data = safeRead(file);
  if (!data.mcpServers?.synapse) return;
  delete data.mcpServers.synapse;
  writeJson(file, data, o, report, 'mcp removed');
}

/** Devin's pre-approval rules (`setup devin --allow-tools`) live in the user config. */
function uninstallDevinRules(o: SetupOptions, report: SetupReport): void {
  const file = path.join(o.home, '.config', 'devin', 'config.json');
  const cfg = safeRead(file);
  const allow: unknown[] = Array.isArray(cfg.permissions?.allow) ? cfg.permissions.allow : [];
  const kept = allow.filter((r) => typeof r !== 'string' || !r.startsWith(DEVIN_RULE_PREFIX));
  if (kept.length === allow.length) return;
  cfg.permissions.allow = kept;
  writeJson(file, cfg, o, report, 'permissions removed');
}

/**
 * Remove the marked block from the project's instruction files; a file left empty is deleted. An `@AGENTS.md` import
 * line (CLAUDE.md, GEMINI.md) is removed only when AGENTS.md itself was deleted, since it would point at nothing.
 */
function uninstallInstructions(o: SetupOptions, report: SetupReport): void {
  const root = projectRoot(o);
  const names = [...new Set(AGENTS.map(instructionsFileName))].sort((a, b) => (a === 'AGENTS.md' ? -1 : b === 'AGENTS.md' ? 1 : 0));
  let agentsDeleted = false;
  for (const name of names) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const s = text.indexOf(BLOCK_START);
    const e = text.indexOf(BLOCK_END);
    let rest = s !== -1 && e > s ? (text.slice(0, s).trimEnd() + '\n\n' + text.slice(e + BLOCK_END.length).trimStart()).trim() : text.trim();
    if (name !== 'AGENTS.md' && agentsDeleted) rest = rest.replace(/^@(\.\/)?AGENTS\.md\s*$/m, '').trim();
    if (rest === text.trim()) continue;
    if (rest) writeFile(file, rest + '\n', o, report, 'instructions removed');
    else if (o.dryRun) report.changes.push(`instructions removed: would delete ${file}`);
    else {
      rmSync(file);
      report.changes.push(`instructions removed: deleted ${file} (it held only Synapse's instructions)`);
    }
    if (name === 'AGENTS.md' && !rest) agentsDeleted = true;
  }
}

function uninstallGit(o: SetupOptions, report: SetupReport): void {
  const file = gitHookFile(o);
  if (!file || !existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  const s = text.indexOf(GIT_START);
  const e = text.indexOf(GIT_END);
  if (s === -1 || e < s) return;
  const rest = (text.slice(0, s).trimEnd() + '\n' + text.slice(e + GIT_END.length).trimStart()).trim();
  if (!rest || /^#![^\n]*$/.test(rest)) {
    if (o.dryRun) report.changes.push(`git hook removed: would delete ${file}`);
    else {
      rmSync(file);
      report.changes.push(`git hook removed: deleted ${file}`);
    }
  } else writeFile(file, rest + '\n', o, report, 'git hook removed');
}

/**
 * Remove what setup installed. Without an agent, everything in the scope, including the instructions blocks and the
 * git hook (project scope); with one, only that agent's hooks and MCP entry, since instruction files are shared.
 */
export function uninstall(o: SetupOptions, only?: AgentId | 'git'): SetupReport[] {
  const reports: SetupReport[] = [];
  for (const agent of only ? (only === 'git' ? [] : [only]) : [...AGENTS]) {
    const report: SetupReport = { agent, changes: [], notes: [] };
    uninstallHooks(agent, o, report);
    uninstallMcp(agent, o, report);
    if (agent === 'devin' && o.global) uninstallDevinRules(o, report);
    if (report.changes.length || report.notes.length) reports.push(report);
  }
  if (!o.global && (!only || only === 'git')) {
    const git: SetupReport = { agent: 'git', changes: [], notes: [] };
    uninstallGit(o, git);
    if (git.changes.length) reports.push(git);
  }
  if (!o.global && !only) {
    const instructions: SetupReport = { agent: 'instructions', changes: [], notes: [] };
    uninstallInstructions(o, instructions);
    if (instructions.changes.length) reports.push(instructions);
  }
  return reports;
}
