/**
 * Agent-neutral hook handler (`synapse hook`). Agent payloads (Claude Code,
 * Codex, Cursor) are normalized to this Claude-style shape by agents.ts.
 *
 *   SessionStart     -> inject a task brief as additionalContext
 *   UserPromptSubmit -> record the session's first substantial prompt as its goal (candidate)
 *   PostToolUse      -> capture file edits / significant commands as candidate memories
 *   PreCompact       -> add a checkpoint row (auto-summary + agent summary) and refresh the session summary
 *   Stop             -> once per session, after real work with nothing stored, ask the agent to store what it learned
 *   SessionEnd       -> close the session with an auto-summary
 *
 * A command that passes after the same command failed earlier in the session, with edits in between, becomes a
 * draft fix (problem-solution candidate) naming the error, the files changed and the passing command.
 *
 * Auto-captured records are 'candidate' + 'ephemeral': searchable but
 * down-ranked, never surfaced as cautions, and decay twice as fast.
 * A hook must never break the host, so every failure exits 0 silently.
 */
import path from 'node:path';
import { hookInjectMode, nudgeEnabled } from './config.js';
import { buildProjectContext } from './context.js';
import { getMeta, setMeta, type DB } from './db.js';
import { consolidateSession } from './consolidate.js';
import { isIgnored } from './ignore.js';
import { detectProject } from './project.js';
import { addCheckpoint, checkpointText, endSession, getSession, latestCheckpoint, reopenSession, startSession } from './sessions.js';
import { redactSecrets } from './secrets.js';
import { listObservations, refreshSessionHashes, rowToObservation, setStatus, storeObservation } from './store.js';
import type { ObservationType, ProjectInfo } from './types.js';

export interface HookInput {
  /** Which agent sent the event (set by agents.ts). */
  agent?: 'claude' | 'cursor' | 'codex' | 'devin' | 'copilot' | 'gemini' | 'antigravity';
  /** Agent-provided compaction summary (Devin's PostCompaction), used when no auto-summary exists. */
  summary?: string;
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  source?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  /** Claude Code's Stop: true when the agent is already continuing because of a stop hook. */
  stop_hook_active?: boolean;
}

export interface HookOutput {
  /** Context to inject into the agent (SessionStart); agents.ts formats it per agent. */
  context?: string;
  /** Stop: ask the agent to keep going with this instruction instead of stopping. */
  continueWith?: string;
}

const SESSION_AGENT = { claude: 'claude-code', cursor: 'cursor', codex: 'codex', devin: 'devin', copilot: 'copilot', gemini: 'gemini', antigravity: 'antigravity' } as const;

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'Agent', 'ToolSearch', 'Skill', 'update_plan', 'view_image']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const TRIVIAL_CMD = /^(ls|ll|la|cd|pwd|echo|cat|head|tail|less|more|which|whoami|clear|date|env|printenv|history|true|false|tree|wc|file|stat|open|source|nvm|set|unset|alias)\b|^\.\s/;
const TRIVIAL_GIT = /^git\s+(status|log|diff|show|branch|remote|fetch|stash list|rev-parse|config --get)\b/;
const SIGNIFICANT_CMD = /\b(test|vitest|jest|pytest|cargo|go (test|build)|make|tsc|build|lint|eslint|migrate|deploy|docker|kubectl|terraform|npm (run|install|i|ci)|pnpm|yarn|pip install|brew install)\b/;
/**
 * Failure-shaped output lines. Deliberately anchored: a grep or cat whose output merely
 * contains the words "error" or "failed" (e.g. source code) is not a failed command.
 */
const FAILURE_LINE = new RegExp(
  [
    String.raw`^\s*(error|fatal|panic)(\[[^\]]*\])?[:!]`, // "Error: ...", "error[E0308]: ...", "fatal: ..."
    String.raw`^\S+:\d+(:\d+)?: (fatal )?error\b`, // gcc/clang/go-vet style "main.c:3:5: error: ..."
    String.raw`^\S+\(\d+,\d+\): error\b`, // TypeScript "src/a.ts(3,5): error TS2322: ..."
    String.raw`^\s*npm (ERR!|error)`,
    String.raw`^\s*(FAIL|FAILED)\b`,
    String.raw`\b\d+ (tests? )?(failed|failing)\b`,
    String.raw`^Traceback \(most recent call last\)`,
    String.raw`command not found`,
    String.raw`^\s*\S+: (No such file or directory|Permission denied)`,
    String.raw`Segmentation fault`,
    String.raw`\bexit(ed)? (with )?(code|status):? [1-9]`, // "exit code 1", Devin's "Exit code: 1"
  ].join('|'),
  'im',
);

/** Did a shell command fail? Uses a reported exit code when the agent gives one (Codex), else output shape. */
export function commandFailed(response: unknown): boolean {
  if (response && typeof response === 'object') {
    const r = response as Record<string, unknown>;
    const code = r.exit_code ?? r.exitCode ?? r.status;
    if (typeof code === 'number') return code !== 0;
    if (r.interrupted === true) return false;
    if (r.success === false) return true; // Devin CLI: { success, output, error }
    return FAILURE_LINE.test([r.stdout, r.stderr, r.output, r.error].filter((x) => typeof x === 'string').join('\n'));
  }
  return typeof response === 'string' && FAILURE_LINE.test(response);
}

/** Commands that run Synapse itself, e.g. `synapse search x` or `cd repo && synapse stats`. */
const SYNAPSE_CMD = /(^|[;&|(]\s*|\s)synapse(\s|$)/;
/** Output that is Synapse's own retrieval text — re-storing it would echo memories into new memories. */
const SYNAPSE_OUTPUT = /Synapse results for |Synapse memories \(|# Synapse brief|Expand with synapse_detail/;

export function isSynapseCommand(cmd: string, output = ''): boolean {
  return SYNAPSE_CMD.test(cmd) || SYNAPSE_OUTPUT.test(output);
}

/** Trivial only if every segment of a chain (`&&`, `||`, `;`, `|`) is trivial: `cd repo && npm test` is not. */
export function isTrivialCommand(cmd: string): boolean {
  const segments = cmd.split(/&&|\|\||;|\|/).map((s) => s.trim().replace(/^(sudo|time|env \S+=\S+)\s+/, '')).filter(Boolean);
  if (segments.length === 0) return true;
  return segments.every((c) => c.length < 4 || TRIVIAL_CMD.test(c) || TRIVIAL_GIT.test(c) || /^export\s/.test(c));
}

/**
 * The command a shell line is really about, for matching a pass to an earlier failure: the first non-trivial command
 * of a chain, without redirects or env prefixes. `npm test 2>&1 | tail -30; cat x` and `cd app && npm test` -> `npm test`.
 */
export function commandKey(cmd: string): string {
  const segments = cmd.split('\n')[0].split(/&&|\|\||;|\|/).map((s) =>
    s.trim().replace(/\s*(?:\d*>>?|&>)\s*(?:&\d+|\S+)/g, '').replace(/^(?:sudo|time|env)\s+/, '').replace(/^(?:\w+=\S*\s+)+/, '').replace(/\s+/g, ' ').trim(),
  ).filter(Boolean);
  return (segments.find((s) => !isTrivialCommand(s)) ?? segments[0] ?? '').slice(0, 80);
}

/** Human-readable text of a tool result: output/stdout/stderr/error fields when present, JSON otherwise. */
function responseText(v: unknown, max = 800): string {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const r = v as Record<string, unknown>;
    const parts = [r.output, r.stdout, r.stderr, r.error].filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    if (parts.length) return stringify(parts.join('\n').trim(), max);
  }
  return stringify(v, max);
}

function stringify(v: unknown, max = 600): string {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** Path relative to the project root, or null when the file lives outside the project. */
function relPath(project: ProjectInfo, file: string): string | null {
  const rel = path.relative(project.rootPath, path.resolve(project.rootPath, file));
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
}

function entityForFile(rel: string): string {
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.length <= 1) return 'project';
  return parts[0] === 'src' && parts.length > 2 ? parts[1] : parts[0];
}

/** Record a session's goal (its first substantial request) once. Returns false when it already has one or it's too short. */
export function recordGoal(db: DB, projectId: string, sessionId: string, text: string): boolean {
  const prompt = text.trim();
  if (prompt.length < 20 || prompt.startsWith('/')) return false;
  const hasGoal = listObservations(db, { projectId, type: ['session-request'], limit: 20, status: 'all' }).some((o) => o.sessionId === sessionId);
  if (hasGoal) return false;
  storeObservation(db, {
    projectId,
    entityName: 'session',
    type: 'session-request',
    title: prompt.split('\n')[0].slice(0, 100),
    narrative: prompt.slice(0, 1500),
    sessionId,
    source: 'hook',
    admissionState: 'candidate',
    valueCategory: 'ephemeral',
    topicKey: `hook/goal/${sessionId}`,
  });
  return true;
}

/**
 * Record that a session edited a project file: one rolling candidate per file per session (not one per edit).
 * Its own memories naming the file are re-hashed, so the session's edits don't flag them.
 */
export function recordFileEdit(db: DB, project: ProjectInfo, sessionId: string | undefined, rel: string, title: string, narrative: string): void {
  if (isIgnored(project.rootPath, rel)) return; // .synapseignore, or a secret-shaped file
  storeObservation(db, {
    projectId: project.id,
    entityName: entityForFile(rel),
    type: 'what-changed',
    title,
    narrative,
    filesModified: [rel],
    rootPath: project.rootPath,
    sessionId,
    source: 'hook',
    admissionState: 'candidate',
    valueCategory: 'ephemeral',
    topicKey: `hook/file/${rel}/${sessionId ?? 'nosession'}`,
  });
  if (sessionId) refreshSessionHashes(db, sessionId, project.rootPath, rel);
}

export function autoSummary(db: DB, project: ProjectInfo, sessionId: string): string | undefined {
  const obs = listObservations(db, { projectId: project.id, limit: 500, status: 'all' }).filter((o) => o.sessionId === sessionId);
  if (obs.length === 0) return undefined;
  const goal = obs.find((o) => o.type === 'session-request');
  const files = [...new Set(obs.flatMap((o) => o.filesModified))];
  const explicit = obs.filter((o) => o.source !== 'hook');
  const parts: string[] = [];
  if (goal) parts.push(`Goal: ${goal.title}`);
  if (files.length) parts.push(`Touched ${files.length} file(s): ${files.slice(0, 8).join(', ')}${files.length > 8 ? ', …' : ''}`);
  if (explicit.length) parts.push(`Stored: ${explicit.slice(0, 5).map((o) => `#${o.id} ${o.title}`).join('; ')}`);
  return parts.join('. ') || undefined;
}

/** Session records, newest first. */
function sessionObservations(db: DB, projectId: string, sessionId: string) {
  return listObservations(db, { projectId, limit: 500, status: 'all' }).filter((o) => o.sessionId === sessionId);
}

/**
 * A command passed: if the same command failed earlier in this session and files were edited since, record a draft
 * fix and resolve the failure. Returns true when a fix was recorded.
 */
function recordFix(db: DB, project: ProjectInfo, sessionId: string, cmd: string): boolean {
  // Agents rarely repeat a command verbatim (`npm test | tail -30`, then `npm test`), so match on its key.
  const key = commandKey(cmd);
  if (!key) return false;
  const rows = db
    .prepare("SELECT * FROM observations WHERE projectId = ? AND sessionId = ? AND source = 'hook' AND type = 'gotcha' AND status = 'active' AND topicKey LIKE 'hook/cmd/%' ORDER BY COALESCE(updatedAt, createdAt) DESC, id DESC")
    .all(project.id, sessionId) as Record<string, unknown>[];
  const failure = rows.map(rowToObservation).find((o) => commandKey(o.narrative.replace(/^\$ /, '')) === key);
  if (!failure) return false;
  const failedAt = failure.updatedAt ?? failure.createdAt;
  const files = [...new Set(
    sessionObservations(db, project.id, sessionId)
      .filter((o) => o.type === 'what-changed' && o.source === 'hook' && o.topicKey?.startsWith('hook/file/') && (o.updatedAt ?? o.createdAt) >= failedAt)
      .flatMap((o) => o.filesModified),
  )];
  if (files.length === 0) return false; // passed with no edits in between: flaky or environmental, not a fix
  const shown = files.slice(0, 8).join(', ') + (files.length > 8 ? ', …' : '');
  storeObservation(db, {
    projectId: project.id,
    entityName: entityForFile(files[0]),
    type: 'problem-solution',
    title: `Fixed: ${key}`,
    narrative: `\`${key}\` failed, then passed after changes to ${shown}.\n\nFailure:\n${failure.narrative.slice(0, 900)}`,
    facts: [`Failing command: ${failure.narrative.split('\n')[0].replace(/^\$ /, '').slice(0, 200)}`, `Passing command: ${cmd.split('\n')[0].slice(0, 200)}`, `Changed: ${shown}`],
    filesModified: files.slice(0, 25),
    concepts: [cmd.split(/\s+/)[0]],
    rootPath: project.rootPath,
    sessionId,
    source: 'hook',
    admissionState: 'candidate',
    valueCategory: 'contextual',
    topicKey: `hook/fix/${key}/${sessionId}`,
  });
  setStatus(db, [failure.id], 'resolved', project.id);
  return true;
}

/** Edits this many distinct files without storing anything, and the session gets one reminder. */
const NUDGE_MIN_FILES = 3;

/**
 * The once-per-session reminder: hooks capture what happened, but only the agent knows what it learned. Sent when
 * the session fixed something or edited several files and stored no memory of its own.
 */
export function storeNudge(db: DB, project: ProjectInfo, sessionId: string): string | undefined {
  if (!nudgeEnabled() || getMeta(db, `nudge:${sessionId}`)) return undefined;
  const obs = sessionObservations(db, project.id, sessionId);
  if (obs.some((o) => o.source !== 'hook')) return undefined; // the agent already stores memories
  const files = new Set(obs.filter((o) => o.type === 'what-changed' && o.source === 'hook').flatMap((o) => o.filesModified));
  const fixes = obs.filter((o) => o.type === 'problem-solution' && o.source === 'hook' && o.status === 'active');
  if (fixes.length === 0 && files.size < NUDGE_MIN_FILES) return undefined;
  setMeta(db, `nudge:${sessionId}`, new Date().toISOString());
  const work = [
    fixes.length ? `fixed ${fixes.slice(0, 2).map((f) => `\`${f.title.replace(/^Fixed: /, '')}\``).join(' and ')} after it failed` : '',
    files.size ? `edited ${files.size} file${files.size === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' and ');
  const drafts = fixes.length
    ? ` Synapse drafted ${fixes.slice(0, 3).map((f) => `#${f.id} "${f.title}"`).join(', ')} from the failure and the passing run. Store the real cause and fix with synapse_store (type problem-solution, naming the files), which replaces the draft, or keep the draft as it is with synapse_qualify.`
    : '';
  return (
    `Before you finish: this session ${work} but stored no Synapse memories. If you learned something a future session would need ` +
    `(a non-obvious cause and fix, a gotcha, a decision and why), store it now with synapse_store and name the files.${drafts} ` +
    'If nothing is worth keeping, just finish. (Synapse asks this once per session.)'
  );
}

function closeSession(db: DB, project: ProjectInfo, sessionId: string | undefined): void {
  if (sessionId && getSession(db, sessionId)?.status === 'active') {
    refreshSessionHashes(db, sessionId, project.rootPath);
    endSession(db, sessionId, autoSummary(db, project, sessionId));
    consolidateSession(db, project, sessionId);
  }
}

export function handleHook(db: DB, input: HookInput): HookOutput {
  const event = input.hook_event_name ?? '';
  const project = detectProject(input.cwd || process.cwd());
  const sessionId = input.session_id;
  if (sessionId) {
    startSession(db, project.id, { id: sessionId, agent: SESSION_AGENT[input.agent ?? 'claude'] });
    // Activity on an ended session means the agent resumed it under the same id (Claude Code and Devin do this).
    // Reopen it on any event, not only SessionStart, so the next SessionEnd summarizes the work after resuming.
    if (event !== 'SessionEnd') reopenSession(db, sessionId);
  }

  switch (event) {
    case 'SessionStart': {
      const mode = hookInjectMode();
      if (mode === 'silent') return {};
      const hint = 'Synapse memory is available: use synapse_search / synapse_project_context for prior decisions, gotchas and fixes; synapse_store to save durable learnings.';
      // After compaction or on resume, the same session continues: surface its latest checkpoint.
      const resumed = input.source === 'compact' || input.source === 'resume';
      let context = hint;
      if (mode === 'full') {
        const brief = buildProjectContext(db, project, input.source === 'compact' ? 'continue the current task after compaction' : 'continue work on this project', {
          maxTokens: 700,
          sessionId: resumed ? sessionId : undefined,
        });
        context = `${hint}\n\n${brief.text}`;
      } else if (resumed && sessionId) {
        // Minimal mode skips the memory brief, but one checkpoint line is what compaction loses.
        const cp = latestCheckpoint(db, sessionId);
        if (cp) context = `${hint}\nLast checkpoint (${cp.createdAt.slice(0, 16).replace('T', ' ')}): ${checkpointText(cp).slice(0, 600)}`;
      }
      return { context };
    }

    case 'UserPromptSubmit': {
      if (sessionId) recordGoal(db, project.id, sessionId, input.prompt ?? '');
      return {};
    }

    case 'PostToolUse': {
      const tool = input.tool_name ?? '';
      if (!tool || READ_ONLY_TOOLS.has(tool) || /^mcp__.*synapse/i.test(tool)) return {};
      const ti = input.tool_input ?? {};

      if (EDIT_TOOLS.has(tool)) {
        const file = String(ti.file_path ?? ti.notebook_path ?? '');
        if (!file) return {};
        const rel = relPath(project, file);
        if (!rel) return {}; // scratch files, other repos, home config: not this project's history
        const snippet = stringify(ti.new_string ?? ti.content ?? ti.new_source ?? (Array.isArray(ti.edits) ? ti.edits.map((e: { new_string?: string }) => e.new_string).join('\n') : ''), 400);
        recordFileEdit(db, project, sessionId, rel, `${tool === 'Write' ? 'Wrote' : 'Edited'} ${rel}`, snippet ? `Latest change excerpt:\n${snippet}` : `${tool} on ${rel}`);
        return {};
      }

      if (tool === 'Bash') {
        const cmd = String(ti.command ?? '').trim();
        if (!cmd || isTrivialCommand(cmd)) return {};
        const out = responseText(input.tool_response, 800);
        if (isSynapseCommand(cmd, out)) return {};
        const failed = commandFailed(input.tool_response);
        const short = cmd.split('\n')[0].slice(0, 80);
        // A pass after a failure of the same command, with edits in between, is a fix; it replaces the failure record.
        if (!failed && sessionId && recordFix(db, project, sessionId, cmd)) return {};
        if (!SIGNIFICANT_CMD.test(cmd) && !failed) return {};
        const type: ObservationType = failed ? 'gotcha' : 'discovery';
        storeObservation(db, {
          projectId: project.id,
          entityName: 'commands',
          type,
          title: `${failed ? 'Command failed' : 'Ran'}: ${short}`,
          narrative: `$ ${cmd.slice(0, 500)}\n\n${out}`,
          concepts: [cmd.split(/\s+/)[0]],
          sessionId,
          source: 'hook',
          admissionState: 'candidate',
          valueCategory: 'ephemeral',
          topicKey: `hook/cmd/${short}/${sessionId ?? 'nosession'}`,
        });
      }
      return {};
    }

    case 'PreCompact': {
      if (sessionId) {
        const auto = autoSummary(db, project, sessionId);
        const agentSummary = typeof input.summary === 'string' ? input.summary : undefined;
        // Keep every compaction as its own checkpoint row.
        addCheckpoint(db, project.id, sessionId, { summary: auto, agentSummary });
        // The session's handoff summary prefers our structured one, falling back to the agent's (Devin PostCompaction).
        const s = auto ?? (agentSummary?.trim() ? redactSecrets(agentSummary.trim()).slice(0, 1500) : undefined);
        if (s) db.prepare('UPDATE sessions SET summary = ? WHERE id = ?').run(s, sessionId);
      }
      return {};
    }

    case 'Stop': {
      const nudge = sessionId && !input.stop_hook_active ? storeNudge(db, project, sessionId) : undefined;
      if (nudge) return { continueWith: nudge };
      // Antigravity has no session-end event: its Stop ends the session until the next prompt reopens it.
      if (input.agent === 'antigravity') closeSession(db, project, sessionId);
      return {};
    }

    case 'SessionEnd': {
      closeSession(db, project, sessionId);
      return {};
    }

    default:
      return {};
  }
}

export async function readStdin(timeoutMs = 3000): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}
